// Tests for escalate.ts — one case per blueprint trigger, plus persistence.
// Run: node --experimental-strip-types .pi/orchestrator/tests/workflow/escalate.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/evidence/store.ts";
import {
	ESCALATION_REASONS, collectEscalations, detectForbiddenPath, detectL0ConsecutiveRed,
	detectL0L2Conflict, detectL1SelfContradiction, detectPanelUnaggregatable,
	detectRequirementConflict, detectRetryLimit, detectTimeout, monitorAndEscalate,
	raiseEscalations, requiresHuman, type EscalationFacts,
} from "../../src/workflow/escalate.ts";
import type { ParsedVerdict } from "../../src/review/verdict.ts";
import type { PanelAggregate } from "../../src/review/aggregate.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

const NOW = new Date("2026-01-01T00:00:00Z");
const facts = (over: Partial<EscalationFacts> = {}): EscalationFacts => ({
	runId: "run-1", stage: "code", checkpointId: "cp1", now: NOW, ...over,
});
const v = (layer: "L0" | "L1" | "L2", verdict: "pass" | "fail", findings: any[] = [], checks?: any[]): ParsedVerdict =>
	({ layer, verdict, findings, summary: "s", checks, raw: {} }) as ParsedVerdict;

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-esc-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	return { store, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

check("all eight blueprint reasons are implemented", () => {
	assert.equal(ESCALATION_REASONS.length, 8);
	assert.deepEqual([...ESCALATION_REASONS].sort(), [
		"forbidden-path", "l0-consecutive-red", "l0-l2-conflict", "l1-self-contradiction",
		"panel-unaggregatable", "requirement-conflict", "retry-limit", "timeout",
	]);
});

check("a clean run raises nothing", () => {
	const e = collectEscalations(facts({
		l0ConsecutiveFailures: 0, attempt: 0,
		l0: v("L0", "pass", [], [{ name: "ctest", exit_code: 0 }]),
		l1: v("L1", "pass"),
		changedFiles: ["src/capture/a.cpp"], forbiddenPaths: ["third_party/"],
	}));
	assert.deepEqual(e, []);
	assert.equal(requiresHuman(e), false);
});

// ---------------------------------------------------------------- trigger 1
check("#9 L0 consecutive red fires at the limit and not below it", () => {
	assert.equal(detectL0ConsecutiveRed(facts({ l0ConsecutiveFailures: 1, maxL0ConsecutiveFailures: 2 })), undefined);
	const e = detectL0ConsecutiveRed(facts({ l0ConsecutiveFailures: 2, maxL0ConsecutiveFailures: 2 }))!;
	assert.equal(e.reason, "l0-consecutive-red");
	assert.ok(e.detail.includes("连续 2 次"));
	assert.ok(e.suggestedActions.length > 0);
});

// ---------------------------------------------------------------- trigger 2
check("#9 L1 pass verdict carrying blockers is a self-contradiction", () => {
	const e = detectL1SelfContradiction(facts({
		l1: v("L1", "pass", [{ severity: "warning", file: "a.cpp", line: 1, evidence: "bug" }]),
	}))!;
	assert.equal(e.reason, "l1-self-contradiction");
	assert.ok(e.detail.includes("verdict=pass"));
});

check("#9 L1 critical+uncertain is a self-contradiction", () => {
	const e = detectL1SelfContradiction(facts({
		l1: v("L1", "fail", [{ severity: "critical", uncertain: true, file: "a.cpp", line: 1, evidence: "maybe" }]),
	}))!;
	assert.equal(e.reason, "l1-self-contradiction");
	assert.ok(e.detail.includes("uncertain"));
});

check("#9 L1 conflicting severities at one location is a self-contradiction", () => {
	const e = detectL1SelfContradiction(facts({
		l1: v("L1", "fail", [
			{ severity: "warning", file: "a.cpp", line: 5, evidence: "blocker" },
			{ severity: "suggestion", file: "a.cpp", line: 5, evidence: "actually fine" },
		]),
	}))!;
	assert.equal(e.reason, "l1-self-contradiction");
	assert.ok(e.detail.includes("a.cpp:5"));
});

check("a consistent L1 verdict is not flagged", () => {
	assert.equal(detectL1SelfContradiction(facts({
		l1: v("L1", "fail", [{ severity: "warning", file: "a.cpp", line: 1, evidence: "bug" }]),
	})), undefined);
	assert.equal(detectL1SelfContradiction(facts({
		l1: v("L1", "pass", [{ severity: "suggestion", file: "a.cpp", line: 1, evidence: "nit" }]),
	})), undefined);
});

// ---------------------------------------------------------------- trigger 3
check("#9 L0 green but L2 cites an L0-covered constraint is a conflict", () => {
	const e = detectL0L2Conflict(facts({
		l0: v("L0", "pass", [], [{ name: "ctest", exit_code: 0 }]),
		l2: v("L2", "fail", [{ file: "src/a.cpp", line: 3, evidence: "violates DEP-03 同层互引" }]),
	}))!;
	assert.equal(e.reason, "l0-l2-conflict");
	assert.ok(e.detail.includes("冲突"));
});

check("THREAD-01 and spec.structure also count as L0-covered", () => {
	for (const id of ["THREAD-01", "THREAD-02", "spec.structure"]) {
		const e = detectL0L2Conflict(facts({
			l0: v("L0", "pass", [], [{ name: "ctest", exit_code: 0 }]),
			l2: v("L2", "fail", [{ file: "a.cpp", line: 1, evidence: `violates ${id}` }]),
		}));
		assert.ok(e, `${id} should be detected as L0-covered`);
	}
});

check("an L2-only constraint is not a conflict", () => {
	assert.equal(detectL0L2Conflict(facts({
		l0: v("L0", "pass", [], [{ name: "ctest", exit_code: 0 }]),
		l2: v("L2", "fail", [{ file: "a.cpp", line: 1, evidence: "violates HANDOFF-1 帧槽容量" }]),
	})), undefined);
});

check("L0 red is not an L0-L2 conflict", () => {
	assert.equal(detectL0L2Conflict(facts({
		l0: v("L0", "fail", [], [{ name: "ctest", exit_code: 8 }]),
		l2: v("L2", "fail", [{ file: "a.cpp", line: 1, evidence: "violates DEP-01" }]),
	})), undefined);
});

// ---------------------------------------------------------------- trigger 4
check("#9 forbidden path hits escalate and list the files", () => {
	const e = detectForbiddenPath(facts({
		changedFiles: ["src/a.cpp", "third_party/gtest/x.h"],
		forbiddenPaths: ["third_party/", ".git/"],
	}))!;
	assert.equal(e.reason, "forbidden-path");
	assert.deepEqual(e.evidence.hits, ["third_party/gtest/x.h"]);
	assert.ok(e.detail.includes("不得自动放行"));
});

check("clean paths do not escalate", () => {
	assert.equal(detectForbiddenPath(facts({
		changedFiles: ["src/capture/a.cpp"], forbiddenPaths: ["third_party/"],
	})), undefined);
	assert.equal(detectForbiddenPath(facts({ changedFiles: [], forbiddenPaths: ["third_party/"] })), undefined);
});

// ---------------------------------------------------------------- trigger 5
check("#9 panel member timeout escalates", () => {
	const e = detectTimeout(facts({
		panelRecords: [{
			model: "qoder/Qwen4-Max-Preview", family: "qwen", ok: false,
			assistantText: "", error: "timed out after 480000ms", durationMs: 480000,
		}],
	}))!;
	assert.equal(e.reason, "timeout");
	assert.ok(e.detail.includes("超时"));
});

check("#9 reviewer child timeout escalates without panel records", () => {
	const e = detectTimeout(facts({ evidenceTimeout: "timed out after 600000ms" }))!;
	assert.equal(e.reason, "timeout");
});

check("a non-timeout member failure is not a timeout escalation", () => {
	assert.equal(detectTimeout(facts({
		panelRecords: [{ model: "m", family: "qwen", ok: false, assistantText: "", error: "403 disabled", durationMs: 10 }],
	})), undefined);
});

// ---------------------------------------------------------------- trigger 6
check("#9 retry limit fires only past the budget", () => {
	assert.equal(detectRetryLimit(facts({ attempt: 2, maxRetries: 2 })), undefined);
	const e = detectRetryLimit(facts({ attempt: 3, maxRetries: 2 }))!;
	assert.equal(e.reason, "retry-limit");
	assert.ok(e.detail.includes("第 3 轮"));
});

// ---------------------------------------------------------------- trigger 7
check("#9 BLOCKED panel escalates with absence reasons", () => {
	const panel: PanelAggregate = {
		outcome: "BLOCKED", quorum: 2, validVotes: 1,
		absent: [{ model: "qoder/Qwen4-Max-Preview", family: "qwen", valid: false, failureReason: "403 disabled" }],
		reasons: ["quorum not reached"], blockingFindings: [], votingFamilies: ["deepseek"],
	};
	const e = detectPanelUnaggregatable(facts({ panel }))!;
	assert.equal(e.reason, "panel-unaggregatable");
	assert.ok(e.detail.includes("不得静默放行"));
	assert.ok(JSON.stringify(e.evidence).includes("403 disabled"));
	assert.ok(e.suggestedActions.some((a) => a.includes("403") || a.includes("模型访问")));
});

check("PASS and FAIL panels do not raise an aggregation escalation", () => {
	for (const outcome of ["PASS", "FAIL"] as const) {
		assert.equal(detectPanelUnaggregatable(facts({
			panel: { outcome, quorum: 2, validVotes: 2, absent: [], reasons: [], blockingFindings: [], votingFamilies: ["a", "b"] },
		})), undefined);
	}
});

// ---------------------------------------------------------------- trigger 8
check("#9 requirement conflict escalates with both sides", () => {
	const e = detectRequirementConflict(facts({
		requirementConflict: { detail: "帧槽必须为 1 与必须缓冲 3 帧互斥", sides: ["低延迟", "抗抖动"] },
	}))!;
	assert.equal(e.reason, "requirement-conflict");
	assert.ok(e.detail.includes("互斥"));
	assert.ok(e.suggestedActions.some((a) => a.includes("DECISIONS.md")));
});

check("an empty requirement conflict does not escalate", () => {
	assert.equal(detectRequirementConflict(facts({ requirementConflict: { detail: "  " } })), undefined);
	assert.equal(detectRequirementConflict(facts()), undefined);
});

// ---------------------------------------------------------------- collection & sink
check("multiple triggers are all collected in a stable order", () => {
	const e = collectEscalations(facts({
		l0ConsecutiveFailures: 3, maxL0ConsecutiveFailures: 2,
		attempt: 5, maxRetries: 2,
		changedFiles: ["third_party/x.h"], forbiddenPaths: ["third_party/"],
		requirementConflict: { detail: "互斥需求" },
	}));
	const reasons = e.map((x) => x.reason);
	assert.ok(reasons.includes("l0-consecutive-red"));
	assert.ok(reasons.includes("retry-limit"));
	assert.ok(reasons.includes("forbidden-path"));
	assert.ok(reasons.includes("requirement-conflict"));
	assert.deepEqual(reasons, collectEscalations(facts({
		l0ConsecutiveFailures: 3, maxL0ConsecutiveFailures: 2,
		attempt: 5, maxRetries: 2,
		changedFiles: ["third_party/x.h"], forbiddenPaths: ["third_party/"],
		requirementConflict: { detail: "互斥需求" },
	})).map((x) => x.reason), "order must be deterministic");
	assert.ok(requiresHuman(e));
});

check("#9 escalations are persisted to escalations/ and the human is notified", () => {
	const { store, cleanup } = sandbox();
	try {
		const notes: string[] = [];
		const r = monitorAndEscalate(
			{ store, notify: (m) => notes.push(m) },
			facts({ attempt: 4, maxRetries: 2, changedFiles: ["third_party/x.h"], forbiddenPaths: ["third_party/"] }),
		);
		assert.equal(r.escalations.length, 2);
		assert.equal(r.paths.length, 2);
		for (const p of r.paths) {
			assert.ok(p.startsWith("escalations/"), p);
			assert.ok(store.exists(p), `${p} not written`);
			const saved = store.readJson<any>(p)!;
			assert.ok(saved.reason);
			assert.ok(saved.suggestedActions.length > 0);
			assert.equal(saved.runId, "run-1");
		}
		assert.equal(notes.length, 2, "human must be told about each escalation");
		assert.ok(notes.every((n) => n.includes("[升级:")));
		assert.equal(store.listEscalations().length, 2);
	} finally { cleanup(); }
});

check("raising nothing writes nothing and notifies nobody", () => {
	const { store, cleanup } = sandbox();
	try {
		const notes: string[] = [];
		const paths = raiseEscalations({ store, notify: (m) => notes.push(m) }, []);
		assert.deepEqual(paths, []);
		assert.deepEqual(notes, []);
		assert.deepEqual(store.listEscalations(), []);
	} finally { cleanup(); }
});

check("escalation filenames are timestamped and reason-tagged", () => {
	const { store, cleanup } = sandbox();
	try {
		const e = detectRetryLimit(facts({ attempt: 9, maxRetries: 2 }))!;
		const [p] = raiseEscalations({ store }, [e]);
		assert.ok(p.includes("retry-limit"), p);
		assert.ok(/escalations\/\d{8}T\d{6}Z-/.test(p), p);
	} finally { cleanup(); }
});

check("escalations never carry secrets", () => {
	const { store, cleanup } = sandbox();
	try {
		const e = detectTimeout(facts({ evidenceTimeout: "timed out; token=sk-abcdefghijklmnopqrstuvwx" }));
		// The detector does not copy the raw text into evidence, so this must pass.
		assert.ok(e);
		assert.ok(!JSON.stringify(e).includes("sk-abcdefghijklmnopqrstuvwx"));
	} finally { cleanup(); }
});

console.log("== escalate.ts tests ==");
for (const [name, fn] of tests) {
	try {
		fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
