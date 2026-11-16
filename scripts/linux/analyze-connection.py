#!/usr/bin/env python3
"""Summarize observed Linux termination triggers, without inferring root cause."""
import argparse
import json
from pathlib import Path
import re

PREFIX = "connection_event="
LABEL = re.compile(r"[a-z_]{1,48}\Z")


def summarize(text):
    rows = []
    for line in text.splitlines():
        if PREFIX not in line:
            continue
        # Older worker output can precede a complete diagnostic JSON insertion.
        raw = line.split(PREFIX, 1)[1]
        row, _ = json.JSONDecoder().raw_decode(raw)
        if type(row.get("schema")) is not int or row["schema"] != 1:
            raise ValueError("unsupported diagnostic schema")
        if not all(LABEL.fullmatch(row.get(key, "")) for key in ("event", "value")):
            raise ValueError("invalid diagnostic label")
        if any(type(row.get(key)) is not int for key in ("seq", "elapsed_ms", "utc_ms")):
            raise ValueError("invalid diagnostic clock or sequence")
        if "number" in row and type(row["number"]) is not int:
            raise ValueError("invalid diagnostic number")
        if row["seq"] != len(rows) + 1 or row["elapsed_ms"] < 0:
            raise ValueError("missing or reordered diagnostic event")
        if rows and row["elapsed_ms"] < rows[-1]["elapsed_ms"]:
            raise ValueError("non-monotonic diagnostic clock")
        rows.append(row)
    stops = [row for row in rows if row["event"] == "stop_requested"]
    finishes = [row for row in rows if row["event"] == "session_finished"]
    if len(stops) > 1 or len(finishes) > 1:
        raise ValueError("multiple termination summaries")
    if finishes and (not stops or finishes[0]["value"] != stops[0]["value"]):
        raise ValueError("cleanup overwrote first observed trigger")
    loss_count = finishes[0].get("dropped_events") if finishes else None
    if loss_count is not None and (type(loss_count) is not int or loss_count < 0):
        raise ValueError("invalid dropped event count")
    requested = {row["number"] for row in rows if row["event"] == "snapshot_requested"}
    delivered = {row["number"] for row in rows if row["event"] == "snapshot_delivered"}
    states = {}
    for row in rows:
        if row["event"] in {"tls_state", "peer_state", "ice_state", "dtls_state", "data_channel_state"}:
            states.setdefault(row["event"], []).append({key: row[key] for key in ("elapsed_ms", "value")})
    return {
        "schema": 1,
        "diagnostics_present": bool(rows),
        "log_complete": bool(finishes) and loss_count == 0 and not any(row["event"] == "events_dropped" for row in rows),
        "dropped_events": loss_count,
        "loss_accounting_available": loss_count is not None,
        "event_count": len(rows),
        "transport_snapshots": {
            "requested": len(requested), "delivered": len(delivered),
            "all_requested_delivered": bool(requested) and requested <= delivered,
            "unfinished_request_ids": sorted(requested - delivered),
            "pending_at_cleanup": [row["number"] for row in rows if row["event"] == "snapshot_unfinished"],
            "skipped_while_pending": sum(row["event"] == "snapshot_skipped" for row in rows),
        },
        "first_observed_stop": stops[0]["value"] if stops else None,
        "stop_elapsed_ms": stops[0]["elapsed_ms"] if stops else None,
        "session_finished": bool(finishes),
        "exit_code": finishes[0].get("number") if finishes else None,
        "states": states,
        "root_cause": "undetermined",
        "interpretation": "first observed termination trigger; subsequent states may be cleanup effects",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--expect-stop")
    args = parser.parse_args()
    try:
        result = summarize(args.log.read_text())
    except (OSError, ValueError, KeyError, TypeError):
        # Never echo a malformed raw line: it may contain unrelated private data.
        print(json.dumps({"schema": 1, "log_complete": False,
                          "root_cause": "undetermined", "error": "invalid_or_incomplete_diagnostic_log"}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["log_complete"] and (not args.expect_stop or result["first_observed_stop"] == args.expect_stop) else 2


if __name__ == "__main__":
    raise SystemExit(main())
