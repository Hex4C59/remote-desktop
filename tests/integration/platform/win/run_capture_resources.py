"""Run the native lifecycle case under CDB and retain its unmodified SDK output."""
# Thread: none
import argparse
from datetime import datetime
from hashlib import file_digest
import json
from pathlib import Path
import subprocess
import sys

from capture_resource_report import analyze_resource_report


def run(executable, cdb, output_dir):
    directory = output_dir / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    directory.mkdir(parents=True, exist_ok=False)
    with executable.open("rb") as binary:
        digest = file_digest(binary, "sha256").hexdigest()
    command = [str(cdb), "-g", "-G", str(executable),
               "--gtest_filter=DesktopAcceptance.Pwh08NativeResourcesReleased"]
    verdict = {"passed": False, "errors": [], "cycles": [],
               "command": command, "binary_sha256": digest}
    try:
        existing = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             "if (Get-Process -Name platform_win_desktop_acceptance -ErrorAction SilentlyContinue) { exit 1 }"],
            capture_output=True, timeout=10, check=False)
        if existing.returncode:
            raise RuntimeError("Another desktop acceptance process is already running")
        # The executable also holds the test-only session mutex. No HWND is
        # retained or operated on by this launcher after the child can exit.
        print("SDK report:", directory / "sdk-report.log", flush=True)
        timed_out = False
        with (directory / "sdk-report.log").open("xb") as output:
            child = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
            try:
                status = child.wait(timeout=210)
            except subprocess.TimeoutExpired:
                timed_out = True
                with (directory / "launcher-cleanup.log").open("xb") as cleanup:
                    subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                                   stdout=cleanup, stderr=subprocess.STDOUT,
                                   timeout=15, check=False)
                status = child.wait(timeout=10)
        raw = (directory / "sdk-report.log").read_text(encoding="utf-8", errors="replace")
        analysis = analyze_resource_report(raw)
        verdict.update(analysis, debugger_exit=status)
        if timed_out or status:
            verdict["passed"] = False
            verdict["errors"].append("CDB timed out" if timed_out else "CDB or its child returned a failure")
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        verdict["passed"] = False
        verdict["errors"].append(str(error))
    finally:
        (directory / "result.json").write_text(
            json.dumps(verdict, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(verdict, ensure_ascii=False, indent=2), flush=True)
    return 0 if verdict["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--cdb", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    sys.exit(run(args.executable.resolve(strict=True), args.cdb.resolve(strict=True),
                 args.output_dir.resolve()))
