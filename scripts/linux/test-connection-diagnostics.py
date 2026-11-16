#!/usr/bin/env python3
"""Compile and exercise concurrent connection diagnostics without a desktop."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("connection_analysis", Path(__file__).with_name("analyze-connection.py"))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class ConnectionDiagnosticsTest(unittest.TestCase):
    def test_first_trigger_concurrent_events_and_private_labels(self):
        with tempfile.TemporaryDirectory(prefix="linux-diagnostics-") as temporary:
            base = Path(temporary)
            (base / "remote_desktop_probe").symlink_to(ROOT / "apps/linux/src", target_is_directory=True)
            executable = base / "connection_fixture"
            subprocess.run([shutil.which("clang++") or "c++", "-std=c++20", "-pthread",
                            "-I", str(base), str(ROOT / "apps/linux/tests/connection_fixture.cpp"),
                            "-o", str(executable)], check=True, capture_output=True)
            text = subprocess.check_output([str(executable)], text=True, timeout=5)
        rows = [json.loads(line.removeprefix("connection_event=")) for line in text.splitlines()]
        self.assertEqual([row["seq"] for row in rows], list(range(1, len(rows) + 1)))
        self.assertEqual([row["elapsed_ms"] for row in rows], sorted(row["elapsed_ms"] for row in rows))
        self.assertEqual(len(rows), 87)
        self.assertEqual([row["value"] for row in rows if row["event"] == "stop_requested"], ["tls_peer_closed"])
        self.assertEqual(rows[-1]["value"], "tls_peer_closed")
        self.assertEqual(rows[-1]["number"], 0)
        self.assertNotIn("credential", text)
        self.assertNotIn("127.0.0.1", text)
        self.assertNotIn("192.168", text)
        self.assertEqual(rows[-2]["event"], "unknown")
        self.assertEqual(rows[-3]["value"], "unknown")
        result = analysis.summarize(text)
        self.assertEqual(result["first_observed_stop"], "tls_peer_closed")
        self.assertTrue(result["session_finished"])
        self.assertEqual(result["root_cause"], "undetermined")

    @unittest.skipUnless(sys.platform == "linux", "Linux nonblocking pipe descriptor test")
    def test_stalled_consumer_does_not_block_stop_or_change_inherited_flags(self):
        with tempfile.TemporaryDirectory(prefix="linux-diagnostics-blocked-") as temporary:
            base = Path(temporary)
            (base / "remote_desktop_probe").symlink_to(ROOT / "apps/linux/src", target_is_directory=True)
            executable = base / "connection_fixture"
            subprocess.run([shutil.which("clang++") or "c++", "-std=c++20", "-pthread",
                            "-DCONNECTION_DIAGNOSTICS_BACKPRESSURE_TEST", "-I", str(base),
                            str(ROOT / "apps/linux/tests/connection_fixture.cpp"), "-o", str(executable)],
                           check=True, capture_output=True)
            text = subprocess.check_output([str(executable)], text=True, timeout=5)
        rows = [json.loads(line.removeprefix("connection_event=")) for line in text.splitlines()]
        self.assertLessEqual(len(rows), 257)
        self.assertEqual([r["value"] for r in rows if r["event"] == "stop_requested"], ["peer_disconnected"])
        self.assertTrue(any(r["event"] == "events_dropped" and r["number"] > 0 for r in rows))
        result = analysis.summarize(text)
        self.assertFalse(result["log_complete"])
        # Reproduce an output capacity boundary where finish was written but the
        # trailing overflow marker was not. The finish loss count is sufficient.
        truncated = "\n".join(line for line in text.splitlines() if '"event":"events_dropped"' not in line)
        self.assertFalse(analysis.summarize(truncated)["log_complete"])

    def test_legacy_trace_has_no_invented_cause(self):
        result = analysis.summarize("peer_state=2\npeer_state=3\npeer_state=5\npairing_session_ended=true\n")
        self.assertFalse(result["diagnostics_present"])
        self.assertIsNone(result["first_observed_stop"])
        self.assertEqual(result["root_cause"], "undetermined")

    def test_finish_reports_loss_even_if_trailing_marker_is_missing(self):
        rows = [dict(schema=1, seq=1, elapsed_ms=0, utc_ms=1,
                     event="stop_requested", value="peer_disconnected"),
                dict(schema=1, seq=2, elapsed_ms=1, utc_ms=2,
                     event="session_finished", value="peer_disconnected", number=0, dropped_events=5)]
        text = "\n".join("connection_event=" + json.dumps(row) for row in rows)
        self.assertFalse(analysis.summarize(text)["log_complete"])

    def test_truncated_cli_log_is_incomplete_without_echoing_private_data(self):
        with tempfile.TemporaryDirectory(prefix="linux-diagnostic-partial-") as temporary:
            log = Path(temporary) / "partial.log"
            log.write_text('connection_event={"schema":1,"private_credential":"hidden')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("analyze-connection.py")), str(log)],
                                    capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(json.loads(result.stdout)["log_complete"])
        self.assertNotIn("private_credential", result.stdout + result.stderr)

    def test_unfinished_transport_snapshot_remains_visible(self):
        rows = [dict(schema=1, seq=1, elapsed_ms=0, utc_ms=1,
                     event="snapshot_requested", value="peer_change", number=1),
                dict(schema=1, seq=2, elapsed_ms=1, utc_ms=2,
                     event="stop_requested", value="peer_disconnected"),
                dict(schema=1, seq=3, elapsed_ms=2, utc_ms=3,
                     event="session_finished", value="peer_disconnected", number=0, dropped_events=0)]
        text = "\n".join("connection_event=" + json.dumps(row) for row in rows)
        result = analysis.summarize(text)
        self.assertEqual(result["transport_snapshots"]["unfinished_request_ids"], [1])
        self.assertFalse(result["transport_snapshots"]["all_requested_delivered"])
        self.assertTrue(result["log_complete"])

    def test_missing_events_and_overwritten_trigger_rejected(self):
        first = dict(schema=1, seq=1, elapsed_ms=0, utc_ms=1, event="stop_requested", value="peer_disconnected")
        second = dict(schema=1, seq=2, elapsed_ms=1, utc_ms=2, event="session_finished", value="local_stop", number=0)
        def lines(*rows):
            return "\n".join("connection_event=" + json.dumps(row) for row in rows)
        with self.assertRaisesRegex(ValueError, "overwrote"):
            analysis.summarize(lines(first, second))
        second["value"] = first["value"]
        second["seq"] = 3
        with self.assertRaisesRegex(ValueError, "missing or reordered"):
            analysis.summarize(lines(first, second))
        second["seq"] = 2
        second["elapsed_ms"] = -1
        with self.assertRaises(ValueError):
            analysis.summarize(lines(first, second))


if __name__ == "__main__":
    unittest.main()
