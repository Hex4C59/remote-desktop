"""Require execution evidence when a CTest wrapper reports a successful batch."""
# Thread: none
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "integration/platform/win"))
import run_capture_acceptance as runner


def completed_run():
    text = (
        "[       OK ] DesktopAcceptance.Pwh01And06ContinuousCaptureAndAcquireTime (61800 ms)\n"
        "[  PASSED  ] 1 test.\n"
        "PWH-01 seconds=60.001 frames=2 fps=0.033 calls=4 timeouts=2 pattern_matches=2 "
        "occluded_calls=0 pool_in_use=0 private_initial=90000000 private_final=90000000 "
        "private_change=0 final_growth_bytes=0 sampled_growth_bytes=0 memory_verdict=0\n"
        "PWH-06 calls=4 delivered=2 min_ms=0.01 p95_ms=1 max_ms=1 above_6_ms=0\n"
    )
    for number in range(61):
        text += f"PWH-01 memory_sample={number} elapsed_ns={number * 1_000_000_000} private_bytes=90000000\n"
    for number in range(4):
        text += f"PWH-01 call={number} started_ns={number * 1_000_000_000} finished_ns={number * 1_000_000_000 + 1000}\n"
    for number in range(2):
        text += f"PWH-01 frame={number} age_ms=1 rgb=2248876\n"
    return text + "100% tests passed, 0 tests failed out of 1\n"


class CaptureAcceptanceBatch(unittest.TestCase):
    def execute(self, text):
        class FakeChild:
            pid = 12345

            def __init__(self, command, cwd, stdout, stderr):
                stdout.write(text.encode("utf-8"))

            def wait(self, timeout):
                return 0

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "build/windows-desktop/tests/integration/platform/win/platform_win_desktop_acceptance.exe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"test binary identity")
            with patch.object(runner.subprocess, "Popen", FakeChild), patch("sys.stdout", io.StringIO()):
                status = runner.run(root, "windows-desktop", "Pwh01And06", 1, 100, root / "results")
            report = json.loads(next((root / "results").glob("*/result.json")).read_text())
            return status, report

    def test_rejects_ctest_success_without_native_execution(self):
        text = "[==========] Running 0 tests.\n100% tests passed, 0 tests failed out of 1\n"
        status, report = self.execute(text)
        self.assertEqual(status, 1)
        self.assertFalse(report["passed"])

    def test_accepts_completed_case_with_all_measurement_records(self):
        status, report = self.execute(completed_run())
        self.assertEqual(status, 0)
        self.assertTrue(report["passed"])

    def test_rejects_missing_sample_even_with_native_success(self):
        text = completed_run().replace("PWH-01 memory_sample=30 elapsed_ns=30000000000 private_bytes=90000000\n", "")
        self.assertEqual(self.execute(text)[0], 1)

    def test_rejects_missing_call_even_with_native_success(self):
        text = completed_run().replace("PWH-01 call=2 started_ns=2000000000 finished_ns=2000001000\n", "")
        self.assertEqual(self.execute(text)[0], 1)

    def test_rejects_failed_native_case_with_ctest_success(self):
        text = completed_run() + "[  FAILED  ] DesktopAcceptance.Pwh01And06ContinuousCaptureAndAcquireTime\n"
        self.assertEqual(self.execute(text)[0], 1)

    def test_rejects_incomplete_measurement_duration(self):
        self.assertEqual(self.execute(completed_run().replace("seconds=60.001", "seconds=0.001"))[0], 1)


if __name__ == "__main__":
    unittest.main()
