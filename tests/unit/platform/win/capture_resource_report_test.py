"""Exercise report verdicts using the captured SDK syntax and altered records."""
# Thread: none
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "integration/platform/win"))
from capture_resource_report import analyze_resource_report

# Four lines are from pwh08-runs/20261127-210538-632000/sdk-report.log.
# The duplication line is a synthetic addition: the real report omits it and
# must fail. These unit records test parsing, never prove native resource release.
ACTIVE = """D3D11 WARNING: Live ID3D11Device at 0x00000132AB65B620, Name: rd.capture.device, Refcount: 8 [ STATE_CREATION WARNING #441: LIVE_DEVICE]
D3D11 WARNING: \tLive ID3D11Context at 0x00000132AB686B90, Name: rd.capture.context, Refcount: 1, IntRef: 1 [ STATE_CREATION WARNING #2097226: LIVE_CONTEXT]
D3D11 WARNING: \tLive ID3D11Texture2D at 0x00000132AB6F62C0, Name: rd.capture.staging, Refcount: 1, IntRef: 0 [ STATE_CREATION WARNING #425: LIVE_TEXTURE2D]
D3D11 WARNING: \tLive ID3D11Query at 0x00000132AB2F5F60, Name: rd.capture.completion, Refcount: 1, IntRef: 0 [ STATE_CREATION WARNING #438: LIVE_QUERY]
DXGI WARNING: Live IDXGIOutputDuplication at 0x00000132AB123450, Name: rd.capture.duplication, Refcount: 1 [ STATE_CREATION WARNING #0: ]
"""


def snapshot(cycle, phase, objects="", attempt=0, elapsed=0, hresult=0):
    mode = "none" if cycle == 0 else ("pending" if cycle % 2 == 0 else "delivered")
    ready = 0 if cycle == 0 else 140
    submitted = ready + (mode == "pending")
    return (
        f"RD_CAPTURE_REPORT begin cycle={cycle} phase={phase} mode={mode} "
        f"attempt={attempt} elapsed_ns={elapsed} frames_in_use=0 "
        f"submitted={submitted} ready={ready}\n{objects}"
        f"RD_CAPTURE_REPORT end cycle={cycle} phase={phase} hresult={hresult} "
        f"elapsed_ns={elapsed + 1000}\n"
    )


def record(active=ACTIVE, released="", cycles=10):
    text = snapshot(0, "baseline")
    for cycle in range(1, cycles + 1):
        text += snapshot(cycle, "active", active)
        text += snapshot(cycle, "released", released)
    return text + (
        "[       OK ] DesktopAcceptance.Pwh08NativeResourcesReleased (80000 ms)\n"
        "[  PASSED  ] 1 test.\n"
    )


class CaptureResourceReport(unittest.TestCase):
    def test_accepts_all_ten_complete_cycles(self):
        result = analyze_resource_report(record())
        self.assertTrue(result["passed"], result["errors"])
        self.assertEqual(len(result["cycles"]), 10)
        self.assertEqual(result["cycles"][0]["active_project_objects"], 5)

    def test_deduplicates_repeated_sdk_addresses(self):
        result = analyze_resource_report(record(ACTIVE + ACTIVE))
        self.assertTrue(result["passed"], result["errors"])
        self.assertEqual(result["cycles"][0]["active_project_objects"], 5)

    def test_rejects_real_report_missing_duplication(self):
        real_active = "\n".join(line for line in ACTIVE.splitlines()
                                if "rd.capture.duplication" not in line) + "\n"
        result = analyze_resource_report(record(real_active))
        self.assertFalse(result["passed"])
        self.assertIn("rd.capture.duplication", " ".join(result["errors"]))

    def test_rejects_residual_after_scope(self):
        self.assertFalse(analyze_resource_report(record(released=ACTIVE))["passed"])

    def test_accepts_asynchronous_release_within_two_seconds(self):
        text = record().replace(snapshot(1, "released"),
                               snapshot(1, "released", ACTIVE) +
                               snapshot(1, "released", attempt=1, elapsed=1_900_000_000))
        self.assertTrue(analyze_resource_report(text)["passed"])

    def test_rejects_release_observed_only_after_deadline(self):
        text = record().replace(snapshot(1, "released"),
                               snapshot(1, "released", ACTIVE) +
                               snapshot(1, "released", attempt=1, elapsed=2_000_000_001))
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_object_reappearing_after_release(self):
        text = record().replace(snapshot(1, "released"),
                               snapshot(1, "released") +
                               snapshot(1, "released", ACTIVE, attempt=1, elapsed=100_000_000))
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_accumulation_at_next_active_scope(self):
        extra = ACTIVE.splitlines()[0].replace("AB65B620", "AB65B630") + "\n"
        self.assertFalse(analyze_resource_report(record(ACTIVE + extra))["passed"])

    def test_rejects_wrong_type_with_right_name(self):
        self.assertFalse(analyze_resource_report(record(
            ACTIVE.replace("ID3D11Query", "ID3D11Buffer")))["passed"])

    def test_rejects_unrecognized_named_resource(self):
        self.assertFalse(analyze_resource_report(record(
            ACTIVE + ACTIVE.splitlines()[0].replace("rd.capture.device", "rd.capture.extra") + "\n"))["passed"])

    def test_rejects_missing_cycle(self):
        self.assertFalse(analyze_resource_report(record(cycles=9))["passed"])

    def test_rejects_wrong_cycle_order(self):
        text = record().replace(snapshot(2, "active", ACTIVE), "")
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_incomplete_snapshot(self):
        text = record().replace("RD_CAPTURE_REPORT end cycle=1 phase=active hresult=0 elapsed_ns=1000\n", "")
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_sdk_report_failure(self):
        text = record().replace("hresult=0", "hresult=2147500037", 1)
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_nonzero_frame_pool(self):
        self.assertFalse(analyze_resource_report(record().replace("frames_in_use=0", "frames_in_use=1"))["passed"])

    def test_rejects_missing_in_flight_alternation(self):
        text = record().replace("submitted=141 ready=140", "submitted=140 ready=140")
        self.assertFalse(analyze_resource_report(text)["passed"])

    def test_rejects_native_test_failure_or_missing_summary(self):
        self.assertFalse(analyze_resource_report(record() + "[  FAILED  ] 1 test.\n")["passed"])
        self.assertFalse(analyze_resource_report(record().replace("[  PASSED  ] 1 test.", ""))["passed"])


if __name__ == "__main__":
    unittest.main()
