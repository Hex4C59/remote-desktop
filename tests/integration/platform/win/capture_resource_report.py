"""Judge complete SDK reports without treating missing objects as successful release."""
# Thread: none
import re

EXPECTED = {
    "rd.capture.device": "ID3D11Device",
    "rd.capture.context": "ID3D11Context",
    "rd.capture.duplication": "IDXGIOutputDuplication",
    "rd.capture.staging": "ID3D11Texture2D",
    "rd.capture.completion": "ID3D11Query",
}
LIVE = re.compile(r"Live (\w+) at (0x[0-9a-fA-F]+),.*?Name: (rd\.capture\.[^,\s]+)")
LIMIT_NS = 2_000_000_000


def _fields(line):
    return dict(re.findall(r"(\w+)=([^\s]+)", line))


def analyze_resource_report(text, cycles=10):
    """Require native success, complete in-use evidence and timely post-scope release."""
    errors, reports, results = [], [], []

    def fail(message):
        if message not in errors:
            errors.append(message)

    current = None
    for line in text.splitlines():
        if line.startswith("RD_CAPTURE_REPORT begin "):
            if current is not None:
                fail("Nested or incomplete SDK report")
            values = _fields(line)
            try:
                current = {key: int(values[key]) for key in (
                    "cycle", "attempt", "elapsed_ns", "frames_in_use", "submitted", "ready")}
                current.update(phase=values["phase"], mode=values["mode"], objects=set())
                if any(current[key] < 0 for key in (
                        "cycle", "attempt", "elapsed_ns", "frames_in_use", "submitted", "ready")):
                    fail("Negative report metadata")
            except (KeyError, ValueError):
                fail("Invalid SDK report begin metadata")
                current = None
        elif line.startswith("RD_CAPTURE_REPORT end "):
            values = _fields(line)
            if current is None:
                fail("SDK report end without begin")
                continue
            try:
                if int(values["cycle"]) != current["cycle"] or values["phase"] != current["phase"]:
                    fail("SDK report end does not match begin")
                if int(values["hresult"]) != 0:
                    fail("SDK live-object reporting failed")
                current["end_ns"] = int(values["elapsed_ns"])
                if current["end_ns"] < current["elapsed_ns"]:
                    fail("SDK report time reversed")
            except (KeyError, ValueError):
                fail("Invalid SDK report end metadata")
                current["end_ns"] = LIMIT_NS + 1
            reports.append(current)
            current = None
        elif "rd.capture." in line:
            match = LIVE.search(line)
            if current is None or match is None:
                fail("Project resource name outside a valid SDK object report")
                continue
            kind, address, name = match.groups()
            current["objects"].add((name, kind, int(address, 16)))
            if EXPECTED.get(name) != kind:
                fail(f"Unexpected project resource type or name: {name} ({kind})")
    if current is not None:
        fail("Unterminated SDK report")
    if "[  FAILED  ]" in text or "[  PASSED  ] 1 test." not in text or (
            "[       OK ] DesktopAcceptance.Pwh08NativeResourcesReleased" not in text):
        fail("Native PWH-08 test did not report complete success")
    if cycles != 10:
        fail("PWH-08 requires ten cycles")
    if not reports or reports[0]["cycle"] != 0 or reports[0]["phase"] != "baseline":
        fail("Missing initial SDK baseline")
        position = 0
    else:
        baseline = reports[0]
        if baseline["objects"] or baseline["frames_in_use"] or baseline["mode"] != "none":
            fail("Project resources or frames present at baseline")
        position = 1
    for cycle in range(1, cycles + 1):
        mode = "pending" if cycle % 2 == 0 else "delivered"
        if position >= len(reports) or reports[position]["cycle"] != cycle or (
                reports[position]["phase"] != "active"):
            fail(f"Cycle {cycle}: missing ordered active report")
            break
        active = reports[position]
        position += 1
        names = {item[0] for item in active["objects"]}
        for name in EXPECTED.keys() - names:
            fail(f"Cycle {cycle}: missing active {name}")
        if len(active["objects"]) != len(EXPECTED):
            fail(f"Cycle {cycle}: active project resource count is {len(active['objects'])}, expected 5")
        if len({item[2] for item in active["objects"]}) != len(active["objects"]):
            fail(f"Cycle {cycle}: conflicting SDK object address")
        pending = active["submitted"] - active["ready"]
        if active["ready"] < 140 or pending != (mode == "pending"):
            fail(f"Cycle {cycle}: missing deliveries or required in-flight state")
        if active["mode"] != mode or active["frames_in_use"] or active["attempt"] != 0:
            fail(f"Cycle {cycle}: invalid active state or frame pool")
        released = []
        while position < len(reports) and reports[position]["cycle"] == cycle and (
                reports[position]["phase"] == "released"):
            released.append(reports[position])
            position += 1
        cleared_ns = None
        previous_ns = -1
        for attempt, report in enumerate(released):
            if report["attempt"] != attempt or report["elapsed_ns"] <= previous_ns:
                fail(f"Cycle {cycle}: unordered release observations")
            previous_ns = report["elapsed_ns"]
            if report["mode"] != mode or report["frames_in_use"] or (
                    report["submitted"] != active["submitted"] or report["ready"] != active["ready"]):
                fail(f"Cycle {cycle}: release state or frame pool mismatch")
            if not report["objects"] and report["end_ns"] <= LIMIT_NS and cleared_ns is None:
                cleared_ns = report["end_ns"]
            elif report["objects"] and cleared_ns is not None:
                fail(f"Cycle {cycle}: project resources reappeared after release")
        if cleared_ns is None:
            fail(f"Cycle {cycle}: project resources not observed released within two seconds")
        results.append({
            "cycle": cycle, "mode": mode,
            "active_project_objects": len(active["objects"]),
            "active_objects": [{"name": name, "type": kind, "address": hex(address)}
                               for name, kind, address in sorted(active["objects"])],
            "release_observations": len(released), "cleared_ns": cleared_ns,
        })
    if position != len(reports):
        fail("Unexpected or out-of-order SDK reports remain")
    if len(results) != cycles:
        fail("Incomplete resource lifecycle sequence")
    return {"passed": not errors, "errors": errors, "cycles": results}
