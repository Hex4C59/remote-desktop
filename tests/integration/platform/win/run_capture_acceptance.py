"""Run a predefined serial CTest batch and retain every outcome and binary identity."""
# Thread: none
import argparse
from datetime import datetime
from hashlib import file_digest
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


def sha256(path):
    with path.open("rb") as source:
        return file_digest(source, "sha256").hexdigest()


def native_capture_completed(raw, expression):
    """CTest success alone does not prove that GoogleTest executed a case."""
    if "[  FAILED  ]" in raw or "[  PASSED  ] 1 test." not in raw:
        return False
    if expression == "Pwh01And06":
        case, tag, duration = "Pwh01And06ContinuousCaptureAndAcquireTime", "PWH-01", 60
    elif expression == "Pwh07":
        case, tag, duration = "Pwh07ContinuousCaptureMemoryStability", "PWH-07", 600
    else:
        return False
    lines = re.sub(r"^\d+: ?", "", raw, flags=re.MULTILINE)
    if len(re.findall(r"^\[       OK \] DesktopAcceptance\." + case + r" \(", lines, re.MULTILINE)) != 1:
        return False
    summaries = re.findall(r"^" + tag + r" seconds=([^\n]+)", lines, re.MULTILINE)
    if len(summaries) != 1:
        return False
    fields = dict(re.findall(r"(\w+)=([^\s]+)", "seconds=" + summaries[0]))
    try:
        calls, frames = int(fields["calls"]), int(fields["frames"])
        if float(fields["seconds"]) < duration or calls < 1 or frames < 1:
            return False
        if int(fields["pattern_matches"]) != frames or int(fields["occluded_calls"]) or int(fields["pool_in_use"]):
            return False
        samples = re.findall(r"^" + tag + r" memory_sample=(\d+).*?elapsed_ns=(\d+)", lines, re.MULTILINE)
        if [int(index) for index, _ in samples] != list(range(duration + 1)):
            return False
        times = [int(elapsed) for _, elapsed in samples]
        if times[0] != 0 or times[-1] < duration * 1_000_000_000 or any(a >= b for a, b in zip(times, times[1:])):
            return False
        for kind, count in (("call", calls), ("frame", frames)):
            indices = re.findall(r"^" + tag + " " + kind + r"=(\d+)\b", lines, re.MULTILINE)
            if [int(index) for index in indices] != list(range(count)):
                return False
        if duration == 60 and not re.search(r"^PWH-06 calls=" + str(calls) + r" delivered=" + str(frames) + r"\b", lines, re.MULTILINE):
            return False
    except (KeyError, ValueError):
        return False
    return True


def run(root, preset, expression, runs, timeout, output_dir):
    directory = output_dir / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    directory.mkdir(parents=True, exist_ok=False)
    executable = root / f"build/{preset}/tests/integration/platform/win/platform_win_desktop_acceptance.exe"
    command = [shutil.which("ctest") or "ctest", "--preset", preset, "-R", expression, "-V"]
    metadata = {"command": command, "binary_sha256": sha256(executable),
                "rule": "003-approved-2026-11-27-64KiB-final-256KiB-sampled",
                "planned_order": list(range(1, runs + 1)), "runs": [], "passed": False}
    result_file = directory / "result.json"

    def save():
        result_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save()
    print("Batch:", directory, "SHA-256:", metadata["binary_sha256"], flush=True)
    for number in metadata["planned_order"]:
        if sha256(executable) != metadata["binary_sha256"]:
            metadata["error"] = "Executable changed during the predefined batch"
            save()
            return 1
        log = directory / f"run-{number}.log"
        outcome = {"order": number, "started": datetime.now().isoformat(), "log": log.name}
        print("Starting predefined run", number, flush=True)
        with log.open("xb") as output:
            child = subprocess.Popen(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
            outcome["ctest_pid"] = child.pid
            try:
                outcome["exit"] = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Terminate only this invocation and the descendants it created.
                subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                               stdout=output, stderr=subprocess.STDOUT, timeout=15, check=False)
                child.wait(timeout=10)
                outcome.update(exit=1, error="CTest timeout")
        raw = log.read_text(encoding="utf-8", errors="replace")
        outcome["finished"] = datetime.now().isoformat()
        outcome["native_execution_complete"] = native_capture_completed(raw, expression)
        outcome["passed"] = (outcome["exit"] == 0 and "100% tests passed" in raw
                             and outcome["native_execution_complete"])
        if not outcome["native_execution_complete"]:
            outcome["evidence_error"] = "Requested native case or complete measurement records are missing"
        outcome["binary_sha256_after"] = sha256(executable)
        if outcome["binary_sha256_after"] != metadata["binary_sha256"]:
            outcome["passed"] = False
            outcome["error"] = "Executable identity changed"
        metadata["runs"].append(outcome)
        save()
        print("Finished run", number, "passed=", outcome["passed"], flush=True)
    metadata["passed"] = len(metadata["runs"]) == runs and all(item["passed"] for item in metadata["runs"])
    save()
    print("Batch passed:", metadata["passed"], flush=True)
    return 0 if metadata["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--preset", default="windows-desktop")
    parser.add_argument("--test", default="Pwh01And06")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=100)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.runs < 1 or args.timeout < 1:
        parser.error("runs and timeout must be positive")
    sys.exit(run(args.root.resolve(strict=True), args.preset, args.test,
                 args.runs, args.timeout, args.output_dir.resolve()))
