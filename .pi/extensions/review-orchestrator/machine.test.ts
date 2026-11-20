// Tests for machine.ts — every blueprint transition, terminals, and recovery.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/machine.test.ts
import assert from "node:assert/strict";
import {
	TRANSITIONS, applyEvent, awaitsHuman, initialSnapshot, isTerminal, legalEvents,
	restoreSnapshot, snapshotAtStage, stageOf, type MachineEvent, type MachineSnapshot, type MachineState,
} from "./machine.ts";
import type { Stage } from "./store.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

const NOW = new Date("2026-01-01T00:00:00Z");

/** Drive a snapshot to a state by replaying a legal event path. */
function at(state: MachineState): MachineSnapshot {
	if (state === "DISCUSSION") return initialSnapshot(NOW);
	const paths: Partial<Record<MachineState, MachineEvent[]>> = {
		SPEC_DRAFT: ["decided"],
		SPEC_L0: ["decided", "draft-ready"],
		SPEC_L1: ["decided", "draft-ready", "l0-pass"],
		SPEC_L2: ["decided", "draft-ready", "l0-pass", "l1-pass"],
		SPEC_HUMAN: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass"],
		PLAN_DRAFT: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve"],
		PLAN_L0: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready"],
		PLAN_L1: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass"],
		PLAN_HUMAN: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass"],
		TASK_LOOP: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve"],
		CODE_LOOP: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve", "task-ready"],
		AWAITING_HUMAN_REVIEW: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve", "task-ready", "code-await-human"],
		COMMITTED: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve", "task-ready", "code-pass"],
		ESCALATED: ["escalate"],
		DONE: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve", "task-ready", "code-pass", "all-checkpoints-done"],
		ABORTED: ["escalate", "human-abort"],
	};
	const path = paths[state];
	assert.ok(path, `no test path to ${state}`);
	let snap = initialSnapshot(NOW);
	for (const e of path!) {
		const r = applyEvent(snap, e, { now: NOW });
		assert.ok(r.ok, `path to ${state} broke at ${e}: ${r.error}`);
		snap = r.snapshot;
	}
	assert.equal(snap.state, state);
	return snap;
}

// ------------------------------------------------------------------ #16 every edge
check("#16 every declared transition is applicable and lands where declared", () => {
	for (const t of TRANSITIONS) {
		const snap = at(t.from);
		const r = applyEvent(snap, t.event, { now: NOW });
		assert.ok(r.ok, `${t.from} + ${t.event} rejected: ${r.error}`);
		assert.equal(r.snapshot.state, t.to, `${t.from} + ${t.event}`);
		assert.equal(r.transition?.note, t.note);
	}
});

check("#16 escalation is reachable from every working state", () => {
	const working: MachineState[] = [
		"DISCUSSION", "SPEC_DRAFT", "SPEC_L0", "SPEC_L1", "SPEC_L2", "SPEC_HUMAN",
		"PLAN_DRAFT", "PLAN_L0", "PLAN_L1", "PLAN_HUMAN", "TASK_LOOP", "CODE_LOOP",
		"AWAITING_HUMAN_REVIEW", "COMMITTED",
	];
	for (const s of working) {
		const r = applyEvent(at(s), "escalate", { now: NOW });
		assert.ok(r.ok, `${s} cannot escalate`);
		assert.equal(r.snapshot.state, "ESCALATED");
	}
});

check("#16 terminals accept no events", () => {
	for (const s of ["DONE", "ABORTED"] as MachineState[]) {
		assert.ok(isTerminal(s));
		assert.deepEqual(legalEvents(s), []);
		for (const e of ["start", "human-approve", "escalate", "code-pass"] as MachineEvent[]) {
			const r = applyEvent(at(s), e, { now: NOW });
			assert.ok(!r.ok, `${s} accepted ${e}`);
			assert.equal(r.snapshot.state, s, "terminal state must not change");
		}
	}
});

check("#16 illegal transitions are rejected and leave state untouched", () => {
	const snap = at("SPEC_DRAFT");
	for (const e of ["human-approve", "code-pass", "committed", "l1-pass"] as MachineEvent[]) {
		const r = applyEvent(snap, e, { now: NOW });
		assert.ok(!r.ok, `SPEC_DRAFT accepted ${e}`);
		assert.ok(r.error?.includes("非法转移"));
		assert.equal(r.snapshot, snap, "rejected event must not mutate the snapshot");
	}
});

check("applyEvent is pure (input snapshot untouched)", () => {
	const snap = at("CODE_LOOP");
	const before = JSON.stringify(snap);
	applyEvent(snap, "code-blocked", { now: NOW });
	assert.equal(JSON.stringify(snap), before);
});

// ------------------------------------------------------------------ human gates
check("#16 a stage cannot pass its human gate without approve", () => {
	for (const [gate, next] of [["SPEC_HUMAN", "PLAN_DRAFT"], ["PLAN_HUMAN", "TASK_LOOP"], ["AWAITING_HUMAN_REVIEW", "COMMITTED"]] as const) {
		const snap = at(gate);
		assert.ok(awaitsHuman(gate));
		// No forward move on unrelated events.
		for (const e of ["l0-pass", "l1-pass", "code-pass", "draft-ready"] as MachineEvent[]) {
			assert.ok(!applyEvent(snap, e, { now: NOW }).ok, `${gate} advanced on ${e}`);
		}
		const ok = applyEvent(snap, "human-approve", { now: NOW });
		assert.ok(ok.ok);
		assert.equal(ok.snapshot.state, next);
	}
});

check("#16 request_changes returns to the producer, reject aborts", () => {
	const cases: Array<[MachineState, MachineState]> = [
		["SPEC_HUMAN", "SPEC_DRAFT"], ["PLAN_HUMAN", "PLAN_DRAFT"], ["AWAITING_HUMAN_REVIEW", "CODE_LOOP"],
	];
	for (const [gate, back] of cases) {
		assert.equal(applyEvent(at(gate), "human-changes", { now: NOW }).snapshot.state, back);
		assert.equal(applyEvent(at(gate), "human-reject", { now: NOW }).snapshot.state, "ABORTED");
	}
});

check("#16 ESCALATED only leaves via a human ruling", () => {
	const snap = at("ESCALATED");
	assert.ok(awaitsHuman("ESCALATED"));
	for (const e of ["l0-pass", "code-pass", "human-approve", "draft-ready"] as MachineEvent[]) {
		assert.ok(!applyEvent(snap, e, { now: NOW }).ok, `ESCALATED accepted ${e}`);
	}
	assert.equal(applyEvent(snap, "human-resume-code", { now: NOW }).snapshot.state, "CODE_LOOP");
	assert.equal(applyEvent(snap, "human-resume-spec", { now: NOW }).snapshot.state, "SPEC_DRAFT");
	assert.equal(applyEvent(snap, "human-resume-plan", { now: NOW }).snapshot.state, "PLAN_DRAFT");
	assert.equal(applyEvent(snap, "human-resume-discussion", { now: NOW }).snapshot.state, "DISCUSSION");
	assert.equal(applyEvent(snap, "human-abort", { now: NOW }).snapshot.state, "ABORTED");
});

// ------------------------------------------------------------------ L0 floor
check("#16 L0 red always returns to the producer, never forward", () => {
	assert.equal(applyEvent(at("SPEC_L0"), "l0-red", { now: NOW }).snapshot.state, "SPEC_DRAFT");
	assert.equal(applyEvent(at("PLAN_L0"), "l0-red", { now: NOW }).snapshot.state, "PLAN_DRAFT");
	assert.equal(applyEvent(at("TASK_LOOP"), "l0-red", { now: NOW }).snapshot.state, "TASK_LOOP");
});

check("L0 consecutive failures accumulate and reset on pass", () => {
	let snap = at("SPEC_L0");
	snap = applyEvent(snap, "l0-red", { now: NOW }).snapshot;
	assert.equal(snap.l0ConsecutiveFailures, 1);
	snap = applyEvent(snap, "draft-ready", { now: NOW }).snapshot;
	snap = applyEvent(snap, "l0-red", { now: NOW }).snapshot;
	assert.equal(snap.l0ConsecutiveFailures, 2);
	snap = applyEvent(snap, "draft-ready", { now: NOW }).snapshot;
	snap = applyEvent(snap, "l0-pass", { now: NOW }).snapshot;
	assert.equal(snap.l0ConsecutiveFailures, 0);
});

check("attempts accumulate on rejection and reset on approval", () => {
	let snap = at("CODE_LOOP");
	snap = applyEvent(snap, "code-blocked", { now: NOW }).snapshot;
	snap = applyEvent(snap, "code-blocked", { now: NOW }).snapshot;
	assert.equal(snap.attempt, 2);
	snap = applyEvent(snap, "code-pass", { now: NOW }).snapshot;
	assert.equal(snap.attempt, 0);
});

// ------------------------------------------------------------------ checkpoints
check("#16 checkpoint loop advances and finishes at DONE", () => {
	let snap = at("TASK_LOOP");
	snap = applyEvent(snap, "task-ready", { now: NOW, checkpointId: "cp-001", pending: ["cp-002"] }).snapshot;
	assert.equal(snap.state, "CODE_LOOP");
	assert.equal(snap.round, 1);
	snap = applyEvent(snap, "code-pass", { now: NOW }).snapshot;
	assert.equal(snap.state, "COMMITTED");
	snap = applyEvent(snap, "next-checkpoint", { now: NOW }).snapshot;
	assert.equal(snap.state, "TASK_LOOP");
	assert.deepEqual(snap.completed, ["cp-001"]);
	assert.equal(snap.checkpointId, "cp-002");
	assert.deepEqual(snap.pending, []);
	snap = applyEvent(snap, "task-ready", { now: NOW }).snapshot;
	assert.equal(snap.round, 2);
	snap = applyEvent(snap, "code-pass", { now: NOW }).snapshot;
	snap = applyEvent(snap, "all-checkpoints-done", { now: NOW }).snapshot;
	assert.equal(snap.state, "DONE");
	assert.deepEqual(snap.completed, ["cp-001", "cp-002"]);
	assert.deepEqual(snap.pending, []);
});

check("task-ready resets per-checkpoint counters", () => {
	let snap = at("CODE_LOOP");
	snap = applyEvent(snap, "code-blocked", { now: NOW }).snapshot;
	snap = applyEvent(snap, "code-await-human", { now: NOW }).snapshot;
	snap = applyEvent(snap, "human-changes", { now: NOW }).snapshot;
	assert.ok(snap.attempt > 0);
	snap = applyEvent(snap, "code-pass", { now: NOW }).snapshot;
	snap = applyEvent(snap, "next-checkpoint", { now: NOW }).snapshot;
	snap = applyEvent(snap, "task-ready", { now: NOW }).snapshot;
	assert.equal(snap.attempt, 0);
	assert.equal(snap.l0ConsecutiveFailures, 0);
});

check("done without a checkpoint id still terminates cleanly", () => {
	const r = applyEvent(at("COMMITTED"), "all-checkpoints-done", { now: NOW });
	assert.equal(r.snapshot.state, "DONE");
	assert.deepEqual(r.snapshot.completed, []);
});

// ------------------------------------------------------------------ stage mapping
check("stageOf maps states to the artifact stage", () => {
	assert.equal(stageOf("DISCUSSION"), "discussion");
	assert.equal(stageOf("SPEC_DRAFT"), "spec");
	assert.equal(stageOf("SPEC_HUMAN"), "spec");
	assert.equal(stageOf("PLAN_L0"), "plan");
	assert.equal(stageOf("TASK_LOOP"), "task");
	assert.equal(stageOf("CODE_LOOP"), "code");
	assert.equal(stageOf("AWAITING_HUMAN_REVIEW"), "code");
	assert.equal(stageOf("COMMITTED"), "code");
});

check("the snapshot stage follows the state automatically", () => {
	assert.equal(at("SPEC_L1").stage, "spec");
	assert.equal(at("PLAN_HUMAN").stage, "plan");
	assert.equal(at("TASK_LOOP").stage, "task");
	assert.equal(at("CODE_LOOP").stage, "code");
});

// ------------------------------------------------------------------ history
check("history records every transition with its note", () => {
	const snap = at("SPEC_HUMAN");
	assert.equal(snap.history.length, 5);
	assert.equal(snap.history[0].from, "DISCUSSION");
	assert.equal(snap.history[0].event, "decided");
	assert.ok(snap.history.every((h) => h.note.length > 0 && h.at.length > 0));
});

// ------------------------------------------------------------------ #16 recovery
check("#16 restore round-trips a persisted snapshot exactly", () => {
	const snap = at("AWAITING_HUMAN_REVIEW");
	const r = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
	assert.ok(r.ok, r.error ?? "restore failed");
	assert.equal(r.snapshot!.state, snap.state);
	assert.equal(r.snapshot!.attempt, snap.attempt);
	assert.equal(r.snapshot!.round, snap.round);
	assert.deepEqual(r.snapshot!.history, snap.history);
});

check("#16 a restored machine continues from the same state", () => {
	const snap = at("AWAITING_HUMAN_REVIEW");
	const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap))).snapshot!;
	const r = applyEvent(restored, "human-approve", { now: NOW });
	assert.ok(r.ok);
	assert.equal(r.snapshot.state, "COMMITTED");
});

check("#16 checkpoint progress survives a restore", () => {
	let snap = at("TASK_LOOP");
	snap = applyEvent(snap, "task-ready", { now: NOW, checkpointId: "cp-001", pending: ["cp-002", "cp-003"] }).snapshot;
	snap = applyEvent(snap, "code-pass", { now: NOW }).snapshot;
	snap = applyEvent(snap, "next-checkpoint", { now: NOW }).snapshot;
	const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap))).snapshot!;
	assert.deepEqual(restored.completed, ["cp-001"]);
	assert.deepEqual(restored.pending, ["cp-003"]);
	assert.equal(restored.checkpointId, "cp-002");
});

check("#16 corrupt or unknown state is reported, never silently reset", () => {
	for (const bad of [null, "x", 42, {}, { state: "NOT_A_STATE" }, { state: 7 }]) {
		const r = restoreSnapshot(bad);
		assert.ok(!r.ok, `${JSON.stringify(bad)} should be rejected`);
		assert.ok(r.error);
		assert.equal(r.snapshot, undefined, "must not invent a fresh DISCUSSION state");
	}
});

check("restore tolerates missing optional fields but keeps the state", () => {
	const r = restoreSnapshot({ state: "CODE_LOOP" });
	assert.ok(r.ok);
	assert.equal(r.snapshot!.state, "CODE_LOOP");
	assert.deepEqual(r.snapshot!.completed, []);
	assert.deepEqual(r.snapshot!.history, []);
	assert.equal(r.snapshot!.attempt, 0);
});

check("restore rejects non-string entries in progress lists", () => {
	const r = restoreSnapshot({ state: "TASK_LOOP", completed: ["cp-001", 5, null], pending: [1, "cp-002"] });
	assert.ok(r.ok);
	assert.deepEqual(r.snapshot!.completed, ["cp-001"]);
	assert.deepEqual(r.snapshot!.pending, ["cp-002"]);
});

// ------------------------------------------------------------------ full happy path
check("#16 the full blueprint happy path reaches DONE", () => {
	const events: MachineEvent[] = [
		"decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve",
		"draft-ready", "l0-pass", "l1-pass", "human-approve",
		"task-ready", "code-await-human", "human-approve", "all-checkpoints-done",
	];
	let snap = initialSnapshot(NOW);
	for (const e of events) {
		const r = applyEvent(snap, e, { now: NOW, checkpointId: "cp-001" });
		assert.ok(r.ok, `happy path broke at ${e}: ${r.error}`);
		snap = r.snapshot;
	}
	assert.equal(snap.state, "DONE");
	assert.ok(isTerminal(snap.state));
});

check("l2-skipped still requires the human gate", () => {
	let snap = at("SPEC_L2");
	snap = applyEvent(snap, "l2-skipped", { now: NOW }).snapshot;
	assert.equal(snap.state, "SPEC_HUMAN");
	assert.ok(awaitsHuman(snap.state));
});

// ------------------------------------------------------------------ /orch wiring
check("#16 /orch abort stops any working state and is terminal afterwards", () => {
	const working: MachineState[] = [
		"DISCUSSION", "SPEC_DRAFT", "SPEC_HUMAN", "PLAN_HUMAN", "TASK_LOOP",
		"CODE_LOOP", "AWAITING_HUMAN_REVIEW", "COMMITTED", "ESCALATED",
	];
	for (const s of working) {
		const r = applyEvent(at(s), "abort", { now: NOW });
		assert.ok(r.ok, `${s} cannot be aborted`);
		assert.equal(r.snapshot.state, "ABORTED");
		assert.ok(!applyEvent(r.snapshot, "abort", { now: NOW }).ok, "ABORTED must stay terminal");
	}
});

check("#16 escalation keeps its stage so a human ruling resumes the right producer", () => {
	const cases: Array<[MachineState, MachineState]> = [
		["SPEC_HUMAN", "SPEC_DRAFT"],
		["PLAN_HUMAN", "PLAN_DRAFT"],
		["TASK_LOOP", "TASK_LOOP"],
		["CODE_LOOP", "CODE_LOOP"],
	];
	for (const [from, back] of cases) {
		const before = at(from);
		const esc = applyEvent(before, "escalate", { now: NOW });
		assert.equal(esc.snapshot.stage, before.stage, `${from} lost its stage on escalate`);
		// A persisted escalation must restore the same stage, not fall back to code.
		const restored = restoreSnapshot(JSON.parse(JSON.stringify(esc.snapshot))).snapshot!;
		assert.equal(restored.stage, before.stage);
		const stage = restored.stage;
		const resume: MachineEvent = stage === "spec" ? "human-resume-spec"
			: stage === "plan" ? "human-resume-plan"
				: stage === "task" ? "human-resume-task" : "human-resume-code";
		const resumed = applyEvent(restored, resume, { now: NOW });
		assert.ok(resumed.ok, `${stage} cannot resume`);
		assert.equal(resumed.snapshot.state, back);
		const aborted = applyEvent(restored, "abort", { now: NOW });
		assert.equal(aborted.snapshot.state, "ABORTED");
	}
});

check("snapshotAtStage starts exactly at the requested stage without fabricating prior gates", () => {
	const map: Array<[Exclude<Stage, "code">, MachineState]> = [
		["discussion", "DISCUSSION"], ["spec", "SPEC_DRAFT"], ["plan", "PLAN_DRAFT"], ["task", "TASK_LOOP"],
	];
	for (const [stage, state] of map) {
		const snap = snapshotAtStage(stage, NOW);
		assert.equal(snap.state, state);
		assert.equal(snap.stage, stage);
		assert.equal(snap.history.length, 1, "only the explicit start is recorded");
		assert.ok(snap.history[0].note.includes("人工指定"));
	}
});

console.log("== machine.ts tests ==");
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
