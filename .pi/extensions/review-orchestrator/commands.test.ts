// Tests for commands.ts — the `/orch` decision/resume layer.
//
// These guard the exact bug C9 had: `/orch approve` used to hard-code the next
// state as CODE_LOOP/COMMITTED, so approving a SPEC_HUMAN package silently
// bypassed PLAN_DRAFT. Every decision now comes from the transition table.
//
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadMachine, nextStepHint, planDecision, selectResumeRun,
} from "./commands.ts";
import { applyEvent, snapshotAtStage, type MachineSnapshot, type MachineState } from "./machine.ts";
import { ArtifactStore } from "./store.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

const NOW = new Date("2026-01-01T00:00:00Z");

/** Drive to a state through legal events (same approach as machine.test.ts). */
function at(state: MachineState): MachineSnapshot {
	const paths: Partial<Record<MachineState, MachineSnapshot>> = {};
	if (state === "DISCUSSION") return snapshotAtStage("discussion", NOW);
	if (state.startsWith("SPEC")) {
		let s = applyEvent(snapshotAtStage("spec", NOW), "draft-ready", { now: NOW }).snapshot;
		if (state === "SPEC_DRAFT") return snapshotAtStage("spec", NOW);
		if (state === "SPEC_L0") return s;
		s = applyEvent(s, "l0-pass", { now: NOW }).snapshot;
		if (state === "SPEC_L1") return s;
		s = applyEvent(s, "l1-pass", { now: NOW }).snapshot;
		if (state === "SPEC_L2") return s;
		return applyEvent(s, "l2-pass", { now: NOW }).snapshot;
	}
	if (state.startsWith("PLAN")) {
		let s = applyEvent(snapshotAtStage("plan", NOW), "draft-ready", { now: NOW }).snapshot;
		if (state === "PLAN_DRAFT") return snapshotAtStage("plan", NOW);
		if (state === "PLAN_L0") return s;
		s = applyEvent(s, "l0-pass", { now: NOW }).snapshot;
		if (state === "PLAN_L1") return s;
		return applyEvent(s, "l1-pass", { now: NOW }).snapshot;
	}
	if (state === "TASK_LOOP") return snapshotAtStage("task", NOW);
	if (state === "CODE_LOOP") {
		return applyEvent(snapshotAtStage("task", NOW), "task-ready", { now: NOW, checkpointId: "cp-001" }).snapshot;
	}
	if (state === "AWAITING_HUMAN_REVIEW") {
		const s = applyEvent(snapshotAtStage("task", NOW), "task-ready", { now: NOW, checkpointId: "cp-001" }).snapshot;
		return applyEvent(s, "code-await-human", { now: NOW }).snapshot;
	}
	if (state === "COMMITTED") {
		const s = applyEvent(snapshotAtStage("task", NOW), "task-ready", { now: NOW, checkpointId: "cp-001" }).snapshot;
		return applyEvent(s, "code-pass", { now: NOW }).snapshot;
	}
	if (state === "ESCALATED") return applyEvent(snapshotAtStage("spec", NOW), "escalate", { now: NOW }).snapshot;
	assert.ok(paths[state], `no path to ${state}`);
	return paths[state]!;
}

// ---------------------------------------------------------------- decisions
check("approve at each human gate advances ONE stage along the table", () => {
	const cases: Array<[MachineState, MachineState]> = [
		["SPEC_HUMAN", "PLAN_DRAFT"],
		["PLAN_HUMAN", "TASK_LOOP"],
		["AWAITING_HUMAN_REVIEW", "COMMITTED"],
	];
	for (const [gate, next] of cases) {
		const r = planDecision(at(gate), "approve", NOW);
		assert.ok(r.ok, `${gate} approve rejected`);
		assert.equal(r.plan.next.state, next, `${gate} approve must land at ${next}`);
		assert.equal(r.plan.outcome, "pass");
	}
});

check("request_changes returns to the producing stage, reject aborts", () => {
	const cases: Array<[MachineState, MachineState]> = [
		["SPEC_HUMAN", "SPEC_DRAFT"],
		["PLAN_HUMAN", "PLAN_DRAFT"],
		["AWAITING_HUMAN_REVIEW", "CODE_LOOP"],
	];
	for (const [gate, back] of cases) {
		const changes = planDecision(at(gate), "request_changes", NOW);
		assert.ok(changes.ok);
		assert.equal(changes.plan.next.state, back);
		assert.equal(changes.plan.outcome, "blocked");

		const reject = planDecision(at(gate), "reject", NOW);
		assert.ok(reject.ok);
		assert.equal(reject.plan.next.state, "ABORTED");
		assert.equal(reject.plan.outcome, "aborted");
	}
});

check("a non-gate state rejects every L3 decision (no backdoor around the machine)", () => {
	for (const state of ["SPEC_DRAFT", "PLAN_DRAFT", "TASK_LOOP", "CODE_LOOP", "COMMITTED"] as MachineState[]) {
		for (const decision of ["approve", "request_changes", "reject"] as const) {
			const r = planDecision(at(state), decision, NOW);
			assert.ok(!r.ok, `${state} accepted ${decision}`);
			assert.ok(r.error.includes("不等待人工决定"));
		}
	}
});

check("an escalated stage resumes the stage that escalated, per artifact stage", () => {
	const cases: Array<["discussion" | "spec" | "plan" | "task" | "code", MachineState]> = [
		["discussion", "DISCUSSION"],
		["spec", "SPEC_DRAFT"],
		["plan", "PLAN_DRAFT"],
		["task", "TASK_LOOP"],
		["code", "CODE_LOOP"],
	];
	for (const [stage, back] of cases) {
		const start = stage === "code" ? at("CODE_LOOP")
			: stage === "task" ? snapshotAtStage("task", NOW)
				: snapshotAtStage(stage as Exclude<typeof stage, "code">, NOW);
		const escalated = applyEvent(start, "escalate", { now: NOW }).snapshot;
		assert.equal(escalated.stage, stage, `${stage} lost its stage on escalation`);

		const approved = planDecision(escalated, "approve", NOW);
		assert.ok(approved.ok, `${stage} approve rejected`);
		assert.equal(approved.plan.next.state, back, `${stage} must resume at ${back}`);

		const rejected = planDecision(escalated, "reject", NOW);
		assert.ok(rejected.ok);
		assert.equal(rejected.plan.next.state, "ABORTED");
	}
});

// ---------------------------------------------------------------- resume
check("resume adopts the newest run unless one is named", () => {
	const runs = ["20260102T000000Z-aaa", "20260101T000000Z-bbb"];
	assert.deepEqual(selectResumeRun(runs), { ok: true, runId: runs[0] });
	assert.deepEqual(selectResumeRun(runs, runs[1]), { ok: true, runId: runs[1] });
});

check("resume refuses an unknown run and reports the alternatives", () => {
	const r = selectResumeRun(["run-a"], "run-z");
	assert.ok(!r.ok);
	assert.ok(r.error.includes("run-z") && r.error.includes("run-a"));
});

check("resume with no runs explains there is nothing to recover", () => {
	const r = selectResumeRun([]);
	assert.ok(!r.ok);
	assert.ok(r.error.includes("没有可恢复"));
});

// ---------------------------------------------------------------- state.json
function tempStore(): { store: ArtifactStore; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cmd-"));
	const store = new ArtifactStore({ cwd: dir, root: ".orchestrator", runId: "20260101T000000Z-test" });
	return { store, dir };
}

check("loadMachine reports absence without inventing a run", () => {
	const { store, dir } = tempStore();
	try {
		const r = loadMachine(store);
		assert.ok(r.ok);
		assert.equal(r.snapshot, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("loadMachine restores a saved snapshot, including an escalated stage", () => {
	const { store, dir } = tempStore();
	try {
		const escalated = applyEvent(snapshotAtStage("plan", NOW), "escalate", { now: NOW }).snapshot;
		store.saveState({ ...escalated, outcome: "escalated", packageHash: "a".repeat(64) });
		const r = loadMachine(store);
		assert.ok(r.ok);
		assert.equal(r.snapshot?.state, "ESCALATED");
		assert.equal(r.snapshot?.stage, "plan", "resume must not fall back to code");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("loadMachine refuses corrupt state instead of resetting to DISCUSSION", () => {
	const { store, dir } = tempStore();
	try {
		store.saveState({ state: "NOT_A_REAL_STATE" });
		const r = loadMachine(store);
		assert.ok(!r.ok);
		assert.ok(r.error.includes("无法恢复"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("loadMachine reports an unparseable state.json (not 'no run')", () => {
	const { store, dir } = tempStore();
	try {
		fs.mkdirSync(store.runDir, { recursive: true });
		fs.writeFileSync(path.join(store.runDir, "state.json"), "{\"state\":\"SPEC_", "utf-8");
		const r = loadMachine(store);
		assert.ok(!r.ok, "truncated state must not be treated as a new run");
		assert.ok(r.error.includes("无法解析"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("nextStepHint never strands the operator in a gate state", () => {
	for (const state of ["SPEC_HUMAN", "PLAN_HUMAN", "AWAITING_HUMAN_REVIEW", "ESCALATED"] as MachineState[]) {
		assert.ok(nextStepHint(state).includes("/orch"), `${state} has no /orch hint`);
	}
	assert.ok(nextStepHint("CODE_LOOP").includes("/review"));
	assert.ok(nextStepHint("DONE").includes("DONE"));
});

console.log("== commands.ts tests ==");
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
