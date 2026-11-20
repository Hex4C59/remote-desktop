// Tests for human.ts — the L3 gate. No decision must never mean approval.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/human.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "./store.ts";
import {
	HUMAN_DECISIONS, decideByCommand, isDecisionCurrent, loadDecision,
	recordDecision, requestHumanDecision, routeDecision,
	type HumanDecisionRecord, type HumanGateUi,
} from "./human.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-human-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	return { store, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function rec(over: Partial<HumanDecisionRecord> = {}): HumanDecisionRecord {
	return {
		decision: "approve", decidedBy: "user", decidedAt: "2026-01-01T00:00:00.000Z",
		runId: "run-1", checkpointId: "cp1", stage: "code", packageHash: HASH_A, via: "ui",
		...over,
	};
}

function ui(over: Partial<HumanGateUi> = {}): HumanGateUi {
	return { hasUI: true, select: async () => "approve", notify: () => {}, ...over };
}

const gateArgs = (store: ArtifactStore, over: any = {}) => ({
	ui: ui(), store, runId: "run-1", checkpointId: "cp1", stage: "code",
	packageHash: HASH_A, packageDir: "checkpoints/cp1/review-package",
	...over,
});

// ------------------------------------------------------------------ no decision
check("#6 no decision → route is wait, never advance", () => {
	assert.equal(routeDecision(undefined, HASH_A).route, "wait");
});

check("#6 an interactive cancel is NOT an approval", async () => {
	const { store, cleanup } = sandbox();
	try {
		const r = await requestHumanDecision(gateArgs(store, { ui: ui({ select: async () => undefined }) }));
		assert.equal(r.status, "awaiting");
		assert.equal(loadDecision(store, "cp1"), undefined);
		assert.equal(routeDecision(loadDecision(store, "cp1"), HASH_A).route, "wait");
	} finally { cleanup(); }
});

check("an unrecognised UI choice does not create a decision", async () => {
	const { store, cleanup } = sandbox();
	try {
		const r = await requestHumanDecision(gateArgs(store, { ui: ui({ select: async () => "maybe" }) }));
		assert.equal(r.status, "awaiting");
		assert.equal(loadDecision(store, "cp1"), undefined);
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ three decisions
check("#6 approve → advance", () => {
	assert.equal(routeDecision(rec({ decision: "approve" }), HASH_A).route, "advance");
});

check("#6 request_changes → back to producer", () => {
	assert.equal(routeDecision(rec({ decision: "request_changes" }), HASH_A).route, "back-to-producer");
});

check("#6 reject → abort", () => {
	assert.equal(routeDecision(rec({ decision: "reject" }), HASH_A).route, "abort");
});

check("all three decisions round-trip through the artifact store", () => {
	const { store, cleanup } = sandbox();
	try {
		for (const [i, d] of HUMAN_DECISIONS.entries()) {
			const cp = `cp${i}`;
			const r = recordDecision(store, rec({ decision: d, checkpointId: cp }));
			assert.ok(r.ok, r.error ?? "record failed");
			const loaded = loadDecision(store, cp)!;
			assert.equal(loaded.decision, d);
			assert.equal(loaded.packageHash, HASH_A);
			assert.equal(loaded.decidedBy, "user");
			assert.ok(loaded.decidedAt);
		}
	} finally { cleanup(); }
});

check("request_changes captures the human's note for the producer", async () => {
	const { store, cleanup } = sandbox();
	try {
		const r = await requestHumanDecision(gateArgs(store, {
			ui: ui({ select: async () => "request_changes", input: async () => "补齐上界判断" }),
		}));
		assert.equal(r.status, "decided");
		assert.equal(r.record!.decision, "request_changes");
		assert.equal(r.record!.note, "补齐上界判断");
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ hash binding
check("#6 a changed package invalidates an old approval", () => {
	const fresh = isDecisionCurrent(rec({ packageHash: HASH_A }), HASH_B);
	assert.ok(!fresh.ok);
	assert.ok(fresh.reason!.includes("审查包已变化"));
	assert.equal(routeDecision(rec({ packageHash: HASH_A }), HASH_B).route, "wait");
});

check("an approval for the current hash is honoured", () => {
	assert.ok(isDecisionCurrent(rec(), HASH_A).ok);
	assert.equal(routeDecision(rec(), HASH_A).route, "advance");
});

check("a stale recorded decision is not silently applied or discarded", async () => {
	const { store, cleanup } = sandbox();
	try {
		recordDecision(store, rec({ packageHash: HASH_A }));
		const r = await requestHumanDecision(gateArgs(store, { packageHash: HASH_B }));
		assert.equal(r.status, "awaiting", "must re-ask instead of applying the stale approval");
		assert.ok(r.reason!.includes("审查包已变化"));
		assert.equal(loadDecision(store, "cp1")!.packageHash, HASH_A, "record preserved for audit");
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ print fallback
check("#7 print mode (hasUI=false) waits instead of crashing or guessing", async () => {
	const { store, cleanup } = sandbox();
	try {
		const notes: string[] = [];
		const r = await requestHumanDecision(gateArgs(store, {
			ui: { hasUI: false, notify: (m: string) => notes.push(m) },
		}));
		assert.equal(r.status, "awaiting");
		assert.ok(r.reason!.includes("/orch"));
		assert.equal(loadDecision(store, "cp1"), undefined, "no decision invented");
		assert.ok(notes.some((n) => n.includes("L3")), "human must be told");
	} finally { cleanup(); }
});

check("hasUI=true but no select still degrades to waiting", async () => {
	const { store, cleanup } = sandbox();
	try {
		const r = await requestHumanDecision(gateArgs(store, { ui: { hasUI: true } }));
		assert.equal(r.status, "awaiting");
	} finally { cleanup(); }
});

check("#7 /orch approve resumes after a print-mode wait", () => {
	const { store, cleanup } = sandbox();
	try {
		const r = decideByCommand({
			store, runId: "run-1", checkpointId: "cp1", stage: "code",
			packageHash: HASH_A, packageDir: "p", decision: "approve",
		});
		assert.ok(r.ok, r.error ?? "command decision failed");
		assert.equal(r.record!.via, "command");
		assert.equal(routeDecision(loadDecision(store, "cp1"), HASH_A).route, "advance");
	} finally { cleanup(); }
});

check("command decisions support all three verbs and notes", () => {
	const { store, cleanup } = sandbox();
	try {
		for (const [i, d] of HUMAN_DECISIONS.entries()) {
			const cp = `cmd${i}`;
			const r = decideByCommand({
				store, runId: "run-1", checkpointId: cp, stage: "spec",
				packageHash: HASH_A, packageDir: "p", decision: d, note: "because",
			});
			assert.ok(r.ok, r.error ?? "command decision failed");
			assert.equal(r.record!.decision, d);
			assert.equal(r.record!.note, "because");
		}
	} finally { cleanup(); }
});

check("command path re-verifies the current package hash", () => {
	const { store, cleanup } = sandbox();
	try {
		recordDecision(store, rec({ packageHash: HASH_A }));
		const r = decideByCommand({
			store, runId: "run-1", checkpointId: "cp1", stage: "code",
			packageHash: HASH_A, packageDir: "p", decision: "approve", currentPackageHash: HASH_B,
		});
		assert.ok(!r.ok);
		assert.ok(r.error!.includes("审查包已变化"));
	} finally { cleanup(); }
});

check("an existing current decision is returned idempotently", () => {
	const { store, cleanup } = sandbox();
	try {
		recordDecision(store, rec());
		const r = decideByCommand({
			store, runId: "run-1", checkpointId: "cp1", stage: "code",
			packageHash: HASH_A, packageDir: "p", decision: "reject",
		});
		assert.ok(r.ok);
		assert.equal(r.record!.decision, "approve", "must not silently flip an existing decision");
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ record integrity
check("a decision must bind to a real 64-hex hash", () => {
	const { store, cleanup } = sandbox();
	try {
		for (const bad of ["", "abc", "z".repeat(64)]) {
			const r = recordDecision(store, rec({ packageHash: bad, checkpointId: `bad-${bad.length}` }));
			assert.ok(!r.ok, `hash ${bad} must be rejected`);
		}
	} finally { cleanup(); }
});

check("a decision must record who decided", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.ok(!recordDecision(store, rec({ decidedBy: "  " })).ok);
	} finally { cleanup(); }
});

check("an unknown decision verb is rejected", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.ok(!recordDecision(store, rec({ decision: "lgtm" as any })).ok);
	} finally { cleanup(); }
});

check("overwriting an existing decision is refused", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.ok(recordDecision(store, rec()).ok);
		const second = recordDecision(store, rec({ decision: "reject" }));
		assert.ok(!second.ok);
		assert.ok(second.error!.includes("already exists"));
		assert.equal(loadDecision(store, "cp1")!.decision, "approve");
	} finally { cleanup(); }
});

check("decision file lands at the blueprint path", () => {
	const { store, cleanup } = sandbox();
	try {
		recordDecision(store, rec());
		assert.ok(store.exists("checkpoints/cp1/human-decision.json"));
	} finally { cleanup(); }
});

console.log("== human.ts tests ==");
for (const [name, fn] of tests) {
	try {
		await fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
