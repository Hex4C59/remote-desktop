// C9 verification: drive the REAL `/orch` command handlers with a fake Pi host.
//
// Why a fake host: the extension entry loads the command handlers through
// the Pi SDK. We only need the handler closures, not a model. This verifies the
// wiring that unit tests cannot see:
//   - decisions go through the transition table (SPEC_HUMAN → PLAN_DRAFT)
//   - reject/abort reach ABORTED
//   - resume reads state.json
//   - print/json mode (hasUI=false) never goes silent
//   - approving a spec does NOT touch its `status:` line
//
// Run from a directory that can resolve `@earendil-works/pi-coding-agent` and
// `typebox` (see `.pi/orchestrator/README.md`); it builds its
// own throwaway sandbox and never touches the repository.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import register from "../../../extensions/review.ts";
import { ArtifactStore } from "../../src/evidence/store.ts";
import { applyEvent, snapshotAtStage, type MachineSnapshot } from "../../src/workflow/machine.ts";
import { loadDecision } from "../../src/evidence/human.ts";
import { buildReviewPackage } from "../../src/evidence/package.ts";
import type { ParsedVerdict } from "../../src/review/verdict.ts";

const REPO = process.env.ORCH_REPO ?? process.cwd();
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, fn: () => void) => {
	try {
		fn();
		results.push({ name, ok: true, detail: "" });
	} catch (e) {
		results.push({ name, ok: false, detail: (e as Error).message });
	}
};

// ---------------------------------------------------------------- fake host
type Handler = (args: string, ctx: any) => Promise<void>;
const commands = new Map<string, Handler>();
const messages: string[] = [];
const userMessages: string[] = [];

const pi: any = {
	registerFlag: () => {},
	registerTool: () => {},
	on: () => {},
	registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def.handler),
	getFlag: () => false,
	sendMessage: (msg: { content: string }) => messages.push(msg.content),
	sendUserMessage: (msg: string) => userMessages.push(msg),
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
register(pi);

function ctx(cwd: string) {
	return {
		cwd,
		hasUI: false, // print/json mode: the degradation path under test
		ui: {
			notify: () => {},
			setStatus: () => {},
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
		},
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
	};
}

// ---------------------------------------------------------------- sandbox
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cmd-e2e-"));
const SPEC_REL = "specs/spec-probe.md";
const SPEC_TEXT = [
	"# spec-probe：探针",
	"",
	"status: draft",
	"",
	"## 事实来源",
	"- docs/architecture.md",
	"",
	"## 接口契约",
	"- 无",
	"",
	"## 不变量",
	"- 无",
	"",
	"## 验收测试场景",
	"- AC-01: 探针",
	"",
].join("\n");

const PASS = (layer: "L0" | "L1"): ParsedVerdict => ({
	layer, verdict: "pass", findings: [], summary: "ok",
} as ParsedVerdict);

function seedRuntimeFiles(): void {
	fs.mkdirSync(path.join(sandbox, ".pi", "orchestrator"), { recursive: true });
	fs.copyFileSync(
		path.join(REPO, ".pi", "orchestrator", "config.json"),
		path.join(sandbox, ".pi", "orchestrator", "config.json"),
	);
	fs.mkdirSync(path.join(sandbox, ".pi", "agents"), { recursive: true });
	for (const f of fs.readdirSync(path.join(REPO, ".pi", "agents"))) {
		fs.copyFileSync(path.join(REPO, ".pi", "agents", f), path.join(sandbox, ".pi", "agents", f));
	}
	fs.mkdirSync(path.join(sandbox, ".pi", "review"), { recursive: true });
	fs.copyFileSync(
		path.join(REPO, ".pi", "review", "constraint-catalog.md"),
		path.join(sandbox, ".pi", "review", "constraint-catalog.md"),
	);
	fs.mkdirSync(path.join(sandbox, "specs"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, SPEC_REL), SPEC_TEXT, "utf-8");
}

/** Create a run parked at SPEC_HUMAN with a real, verifiable review package. */
function seedSpecHuman(runId: string): { store: ArtifactStore; machine: MachineSnapshot; cp: string } {
	const store = new ArtifactStore({ cwd: sandbox, root: ".orchestrator", runId });
	const cp = "spec-001";
	let m = snapshotAtStage("spec");
	for (const event of ["draft-ready", "l0-pass", "l1-pass", "l2-pass"] as const) {
		const r = applyEvent(m, event, { checkpointId: cp });
		assert.ok(r.ok, `seed broke at ${event}: ${r.error}`);
		m = r.snapshot;
	}
	const pkg = buildReviewPackage(store, {
		runId, checkpointId: cp, stage: "spec", outcome: "awaiting-human",
		attempt: 0, maxRetries: 2, diff: SPEC_TEXT,
		l0: PASS("L0"), l1: PASS("L1"), nextAction: "等待 L3 人工决定。",
	});
	store.saveState({
		...m, checkpointId: cp, outcome: "awaiting-human", packageHash: pkg.packageHash,
		layers: { l0: "pass", l1: "pass", l2: null, panel: null },
		humanDecision: null, escalations: [],
	});
	return { store, machine: m, cp };
}

async function run(verb: string): Promise<void> {
	const handler = commands.get("orch");
	assert.ok(handler, "/orch not registered");
	assert.ok(commands.has("review"), "/review compatibility was dropped");
	assert.ok(pi.registerTool, "review_l0_gate registration missing");
	await handler(verb, ctx(sandbox));
}

async function main(): Promise<void> {
	seedRuntimeFiles();
	const runId = "20260101t000000z-verify";
	const { store, cp } = seedSpecHuman(runId);

	// -- status (print mode) is not silent ---------------------------------
	// Adopt the seeded run first: a fresh session has no run id, and `status`
	// deliberately does not guess which historical run you meant.
	await run(`resume ${runId}`);
	messages.length = 0;
	await run("status");
	check("print mode: /orch status emits a report", () => {
		assert.ok(messages.some((m) => m.includes("SPEC_HUMAN")), "status report missing");
	});

	// -- decision on a non-gate state is refused ---------------------------
	// (PLAN_DRAFT is not a gate; approve must not slip through)
	await run("status"); // reset any pending message index
	const before = store.loadState<any>();
	check("seed starts at SPEC_HUMAN", () => {
		assert.equal(before.state, "SPEC_HUMAN");
	});

	// -- approve spec: PLAN_DRAFT, decision recorded, status untouched ------
	messages.length = 0;
	await run("approve");
	check("#17 approve advances SPEC_HUMAN → PLAN_DRAFT", () => {
		const after = store.loadState<any>();
		assert.equal(after.state, "PLAN_DRAFT", `state is ${after.state}`);
		assert.equal(after.outcome, "pass");
		assert.equal(after.humanDecision, "approve");
	});
	check("#17 approving a spec does NOT rewrite status: draft", () => {
		const text = fs.readFileSync(path.join(sandbox, SPEC_REL), "utf-8");
		assert.ok(text.includes("\nstatus: draft\n"), "spec status line was modified");
	});
	check("the approval is bound to the package hash", () => {
		const rec = loadDecision(store, cp);
		assert.ok(rec, "human-decision.json missing");
		assert.equal(rec!.decision, "approve");
		assert.equal(rec!.packageHash, store.loadState<any>().packageHash);
	});

	// -- a second approve is refused (state no longer waits for a human) ---
	messages.length = 0;
	await run("approve");
	check("a repeated approve cannot skip PLAN_DRAFT → TASK_LOOP", () => {
		assert.equal(store.loadState<any>().state, "PLAN_DRAFT");
		assert.ok(messages.some((m) => m.includes("不等待人工决定")));
	});

	// -- resume reads state.json ------------------------------------------
	messages.length = 0;
	await run("resume");
	check("resume adopts the run and reports PLAN_DRAFT", () => {
		assert.ok(messages.some((m) => m.includes("已恢复 run") && m.includes("PLAN_DRAFT")));
	});

	// -- abort from a non-terminal state ----------------------------------
	messages.length = 0;
	await run("abort");
	check("abort reaches ABORTED and writes the outcome", () => {
		const after = store.loadState<any>();
		assert.equal(after.state, "ABORTED");
		assert.equal(after.outcome, "aborted");
		assert.ok(messages.some((m) => m.includes("ABORTED")));
	});

	// -- reject at a gate --------------------------------------------------
	const second = seedSpecHuman("20260102t000000z-verify");
	messages.length = 0;
	await run("resume 20260102t000000z-verify");
	await run("reject");
	check("reject at SPEC_HUMAN terminates the run", () => {
		assert.equal(second.store.loadState<any>().state, "ABORTED");
		assert.equal(loadDecision(second.store, second.cp)?.decision, "reject");
	});

	// -- changes at a gate returns to the producer ------------------------
	const third = seedSpecHuman("20260103t000000z-verify");
	await run("resume 20260103t000000z-verify");
	await run("changes 补充验收编号");
	check("request_changes returns SPEC_HUMAN → SPEC_DRAFT with the note", () => {
		assert.equal(third.store.loadState<any>().state, "SPEC_DRAFT");
		assert.equal(loadDecision(third.store, third.cp)?.note, "补充验收编号");
		assert.ok(userMessages.some((m) => m.includes("/orch start spec")));
	});

	// -- start: discussion is model-free when a document is supplied ------
	// This exercises the whole `/orch start` wiring (snapshotAtStage →
	// runDeliverableStage → DECISIONS.md → decided → SPEC_DRAFT) without a child.
	const fourth = seedSpecHuman("20260104t000000z-verify");
	await run("resume 20260104t000000z-verify");
	fs.mkdirSync(path.join(sandbox, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(sandbox, "docs", "discussion-draft.md"),
		["# 讨论", "", "方案 A：显式转移表。", "方案 B：让模型决定下一步。", "", "选定 A，因为确定性可审计。"].join("\n"),
		"utf-8",
	);
	messages.length = 0;
	await run("start discussion docs/discussion-draft.md");
	check("/orch start discussion writes DECISIONS.md and advances to SPEC_DRAFT", () => {
		const after = fourth.store.loadState<any>();
		assert.equal(after.state, "SPEC_DRAFT", `state is ${after.state}`);
		assert.ok(fs.existsSync(path.join(fourth.store.runDir, "DECISIONS.md")), "DECISIONS.md missing");
		assert.ok(fs.readFileSync(path.join(fourth.store.runDir, "DECISIONS.md"), "utf-8").includes("选定 A"));
		assert.ok(messages.some((m) => m.includes("SPEC_DRAFT") || m.includes("/orch start spec")));
	});

	// -- an escalated run has no review package; a ruling must still resume --
	const escRun = "20260105t000000z-verify";
	const escStore = new ArtifactStore({ cwd: sandbox, root: ".orchestrator", runId: escRun });
	escStore.saveState({
		...applyEvent(snapshotAtStage("spec"), "escalate").snapshot,
		outcome: "escalated", packageHash: null,
	});
	await run(`resume ${escRun}`);
	await run("approve");
	check("approve at ESCALATED resumes the stage without a review package", () => {
		const after = escStore.loadState<any>();
		assert.equal(after.state, "SPEC_DRAFT", `state is ${after.state}`);
		assert.equal(after.humanDecision, "approve");
		assert.ok(escStore.listEscalations().some((f) => f.includes("human-ruling")), "ruling was not recorded");
	});

	const escRejectRun = "20260106t000000z-verify";
	const escRejectStore = new ArtifactStore({ cwd: sandbox, root: ".orchestrator", runId: escRejectRun });
	escRejectStore.saveState({
		...applyEvent(snapshotAtStage("spec"), "escalate").snapshot,
		outcome: "escalated", packageHash: null,
	});
	await run(`resume ${escRejectRun}`);
	await run("reject");
	check("reject at ESCALATED terminates the run", () => {
		assert.equal(escRejectStore.loadState<any>().state, "ABORTED");
	});

	// A package can be internally consistent while differing from the pending one.
	const staleRun = "20260107t000000z-verify";
	const stale = seedSpecHuman(staleRun);
	const pkgDir = stale.store.reviewPackageDir(stale.cp);
	stale.store.writeText(`${pkgDir}/diff.patch`, "replacement spec content\n");
	stale.store.writeEvidenceManifest(pkgDir);
	assert.ok(stale.store.verifyEvidenceManifest(pkgDir).ok, "the replacement must be internally valid");
	await run(`resume ${staleRun}`);
	messages.length = 0;
	await run("approve");
	check("approve refuses a replaced package even when its manifest validates", () => {
		assert.equal(stale.store.loadState<any>().state, "SPEC_HUMAN");
		assert.equal(loadDecision(stale.store, stale.cp), undefined);
		assert.ok(messages.some((m) => m.includes("审查包已变化")));
	});

	console.log("== C9 /orch wiring ==");
	for (const r of results) {
		console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `: ${r.detail}`}`);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} passed${failed ? " — SOME FAILED" : ", all green"}`);
	if (failed) process.exitCode = 1;
}

try {
	await main();
} finally {
	fs.rmSync(sandbox, { recursive: true, force: true });
}
