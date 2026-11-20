// Tests for stage-pipeline.ts — discussion / spec / plan / task wiring.
//
// Key guarantee under test (#17): approving a spec must NOT rewrite its status
// line by default. specs/README.md forbids the implementer from flipping
// draft → approved; only the human may do that.
//
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/stage-pipeline.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	readSpecStatus, runDeliverableStage, specApprovalAdvice,
	type DeliverableStageDeps,
} from "./stage-pipeline.ts";
import { ArtifactStore } from "./store.ts";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { applyEvent, initialSnapshot, type MachineEvent, type MachineSnapshot, type MachineState } from "./machine.ts";
import { loadDecision, type HumanDecisionRecord } from "./human.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const OK = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const L1_PASS = JSON.stringify({ layer: "L1", verdict: "pass", findings: [], summary: "ok" });
const L1_FAIL = JSON.stringify({
	layer: "L1", verdict: "fail",
	findings: [{ severity: "warning", file: "spec.md", line: 3, evidence: "不变量不可断言", required_fix: "改成可测断言" }],
	summary: "bad",
});
const L2_PASS = JSON.stringify({ layer: "L2", verdict: "pass", findings: [], summary: "no violation" });

const SPEC_DOC = [
	"# spec-probe：探针", "", "status: draft", "approved-by: （批准后填）", "",
	"## 1. 范围", "x", "## 2. 接口契约", "x", "## 3. 不变量", "x",
	"## 4. 线程与资源", "x", "## 5. 验收场景", "",
	"| PB-01 | 场景一 | 预期一 |", "| PB-02 | 场景二 | 预期二 |", "",
	"## 6. 依赖与待决项", "x", "## 7. 并发自检", "不适用", "",
].join("\n");

const PLAN_FULL = ["# plan: spec-probe", "spec: spec-probe", "", "| PB-01 | T1 |", "| PB-02 | T2 |", ""].join("\n");
const PLAN_PARTIAL = ["# plan: spec-probe", "spec: spec-probe", "", "| PB-01 | T1 |", ""].join("\n");
const TASK_DOC = [
	"# TASK: cp-001", "", "## 目标", "实现上界", "",
	"## 验收依据", "PB-01, PB-02", "",
	"## 变更范围", "- src/a.cpp", "",
	"## 验证方式", "ctest --preset debug", "",
].join("\n");
const DISCUSSION_DOC = ["## 候选方案", "### A: x", "### B: y", "", "## 选择与理由", "选 A，因为 B 增加延迟。", "", "## 需求矛盾", "（无）"].join("\n");

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-stage-"));
	fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "tools"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "specs", "spec-probe.md"), SPEC_DOC);
	fs.writeFileSync(path.join(cwd, "tools", "check_specs.py"), "# stub\n");
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	const cfg = loadConfig(process.cwd());
	assert.ok(cfg.ok, cfg.errors.join("; "));
	const config = structuredClone(cfg.config!);
	// Small real-shaped panel; children are faked in these tests.
	config.panel.members = [
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
	];
	config.panel.quorum = 2;
	config.panel.minDistinctFamilies = 2;
	config.specStatusWrite = false;
	return { cwd, store, config, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

/** Drive the machine to a state so stage events are legal. */
function machineAt(state: MachineState): MachineSnapshot {
	const paths: Partial<Record<MachineState, MachineEvent[]>> = {
		DISCUSSION: [],
		SPEC_DRAFT: ["decided"],
		PLAN_DRAFT: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve"],
		TASK_LOOP: ["decided", "draft-ready", "l0-pass", "l1-pass", "l2-pass", "human-approve", "draft-ready", "l0-pass", "l1-pass", "human-approve"],
	};
	let snap = initialSnapshot();
	for (const e of paths[state] ?? []) {
		const r = applyEvent(snap, e);
		assert.ok(r.ok, `path to ${state} broke at ${e}: ${r.error}`);
		snap = r.snapshot;
	}
	return snap;
}

function runner(over: { specCheck?: CommandResult } = {}): CommandRunner {
	return async (cmd, args) => {
		const key = `${cmd} ${args.join(" ")}`;
		if (key.includes("check_specs.py")) return over.specCheck ?? OK("ok");
		if (key.startsWith("cmake") || key.startsWith("ctest")) return OK("100% passed");
		throw new Error(`unexpected: ${key}`);
	};
}

function childOk(text: string): RunChildResult {
	return { ok: true, assistantText: text, model: "m/x", rawStdout: "", stderr: "", exitCode: 0, signal: null, timeout: false };
}

function deps(s: ReturnType<typeof sandbox>, over: Partial<DeliverableStageDeps> = {}): DeliverableStageDeps {
	return {
		cwd: s.cwd, config: s.config, store: s.store,
		machine: machineAt("SPEC_DRAFT"),
		stage: "spec",
		document: SPEC_DOC,
		documentPath: "specs/spec-probe.md",
		run: runner(),
		runChild: async (o) => childOk(o.systemPrompt.includes("L2") ? L2_PASS : L1_PASS),
		producerPrompt: "producer prompt",
		reviewerPrompt: (l) => (l === "L1" ? "L1 reviewer" : "L2 reviewer"),
		constraintChecklist: "- HANDOFF-1: frame slot cap 1",
		ui: { hasUI: true, select: async () => "approve", notify: () => {} },
		coderModel: "hellocode/gpt-6-luna",
		...over,
	};
}

// ------------------------------------------------------------------ spec status
check("readSpecStatus finds the status line and its number", () => {
	const s = sandbox();
	try {
		const r = readSpecStatus(s.cwd, "specs/spec-probe.md");
		assert.equal(r.status, "draft");
		assert.equal(r.lineNumber, 3);
	} finally { s.cleanup(); }
});

check("readSpecStatus on a missing file returns empty, not an error", () => {
	const s = sandbox();
	try {
		assert.deepEqual(readSpecStatus(s.cwd, "specs/nope.md"), {});
	} finally { s.cleanup(); }
});

const decision = (over: Partial<HumanDecisionRecord> = {}): HumanDecisionRecord => ({
	decision: "approve", decidedBy: "user", decidedAt: "2026-01-02T03:04:05.000Z",
	runId: "run-1", checkpointId: "spec-001", stage: "spec",
	packageHash: "a".repeat(64), via: "ui", ...over,
});

check("#17 approval advice does NOT touch the spec file by default", () => {
	const s = sandbox();
	try {
		const before = fs.readFileSync(path.join(s.cwd, "specs/spec-probe.md"), "utf-8");
		const r = specApprovalAdvice(s.cwd, "specs/spec-probe.md", decision(), false);
		assert.equal(r.wrote, false);
		assert.ok(r.advice.includes("不由实施者改状态"));
		assert.ok(r.advice.includes("status: approved"));
		assert.ok(r.advice.includes("approved-by: user, 2026-01-02"));
		assert.equal(fs.readFileSync(path.join(s.cwd, "specs/spec-probe.md"), "utf-8"), before);
		assert.equal(readSpecStatus(s.cwd, "specs/spec-probe.md").status, "draft");
	} finally { s.cleanup(); }
});

check("#17 explicit opt-in writes status AND approver together", () => {
	const s = sandbox();
	try {
		const r = specApprovalAdvice(s.cwd, "specs/spec-probe.md", decision(), true);
		assert.equal(r.wrote, true);
		const text = fs.readFileSync(path.join(s.cwd, "specs/spec-probe.md"), "utf-8");
		assert.equal(readSpecStatus(s.cwd, "specs/spec-probe.md").status, "approved");
		assert.ok(text.includes("approved-by: user, 2026-01-02"));
		// Line 3 must still be the status line (check_specs.py depends on it).
		assert.equal(text.split("\n")[2], "status: approved");
	} finally { s.cleanup(); }
});

check("opt-in on a spec without a status line changes nothing", () => {
	const s = sandbox();
	try {
		fs.writeFileSync(path.join(s.cwd, "specs", "nostatus.md"), "# x\n\nno status here\n");
		const r = specApprovalAdvice(s.cwd, "specs/nostatus.md", decision(), true);
		assert.equal(r.wrote, false);
		assert.ok(r.advice.includes("没有 status 行"));
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ #17 spec stage
check("#17 spec approve leaves status: draft untouched and records the decision", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s));
		assert.equal(r.outcome, "pass", r.summary);
		assert.equal(readSpecStatus(s.cwd, "specs/spec-probe.md").status, "draft", "must not auto-approve");
		assert.ok(r.specStatusAdvice?.includes("status: approved"));
		assert.equal(loadDecision(s.store, r.machine.checkpointId!)?.decision, "approve");
		assert.equal(r.machine.state, "PLAN_DRAFT", "approve advances to planning");
		assert.ok(s.store.exists("spec/status-advice.md"));
	} finally { s.cleanup(); }
});

check("#17 with specStatusWrite=true the status is written with an approver", async () => {
	const s = sandbox();
	try {
		s.config.specStatusWrite = true;
		const r = await runDeliverableStage(deps(s));
		assert.equal(r.outcome, "pass");
		assert.equal(readSpecStatus(s.cwd, "specs/spec-probe.md").status, "approved");
		const text = fs.readFileSync(path.join(s.cwd, "specs/spec-probe.md"), "utf-8");
		assert.ok(/approved-by: user, \d{4}-\d{2}-\d{2}/.test(text));
	} finally { s.cleanup(); }
});

check("spec L0 red returns to SPEC_DRAFT and never runs L1", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		const r = await runDeliverableStage(deps(s, {
			run: runner({ specCheck: { exitCode: 1, stdout: "spec-probe.md: 第 3 行必须是 status", stderr: "" } }),
			runChild: async () => { calls++; return childOk(L1_PASS); },
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(calls, 0);
		assert.equal(r.machine.state, "SPEC_DRAFT");
		assert.ok(r.rejectionText.includes("第 3 行"));
		assert.ok(s.store.exists("spec/l0-results.json"));
	} finally { s.cleanup(); }
});

check("spec L1 blocker returns to SPEC_DRAFT with evidence", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			runChild: async (o) => childOk(o.systemPrompt.includes("L2") ? L2_PASS : L1_FAIL),
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.machine.state, "SPEC_DRAFT");
		assert.ok(r.rejectionText.includes("改成可测断言"));
		assert.ok(s.store.exists("spec/l1-findings.json"));
	} finally { s.cleanup(); }
});

check("spec runs the cross-vendor panel and records it", async () => {
	const s = sandbox();
	try {
		const panelCalls: RunChildOptions[] = [];
		const r = await runDeliverableStage(deps(s, {
			runChild: async (o) => {
				if (o.systemPrompt.includes("L2")) panelCalls.push(o);
				return childOk(o.systemPrompt.includes("L2") ? L2_PASS : L1_PASS);
			},
		}));
		assert.equal(r.outcome, "pass");
		assert.equal(panelCalls.length, 2);
		assert.equal(new Set(panelCalls.map((c) => c.model)).size, 2, "two distinct models");
		assert.ok(!panelCalls.some((c) => c.model === "hellocode/gpt-6-luna"), "coder family excluded");
		assert.equal(r.panel?.outcome, "PASS");
		assert.ok(s.store.exists("spec/l2-panel.json"));
		assert.ok(s.store.exists("spec/l2-verdict.json"));
	} finally { s.cleanup(); }
});

check("spec panel BLOCKED escalates instead of passing", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			runChild: async (o) => {
				if (!o.systemPrompt.includes("L2")) return childOk(L1_PASS);
				return childOk(o.model?.startsWith("deepseek") ? L2_PASS : "not json");
			},
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.panel?.outcome, "BLOCKED");
		assert.equal(r.outcome, "escalated");
		assert.equal(r.machine.state, "ESCALATED");
		assert.ok(r.escalations.some((e) => e.reason === "panel-unaggregatable"));
	} finally { s.cleanup(); }
});

check("#6 spec without a human decision parks at SPEC_HUMAN", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, { ui: { hasUI: false, notify: () => {} } }));
		assert.equal(r.outcome, "awaiting-human");
		assert.equal(r.machine.state, "SPEC_HUMAN");
		assert.equal(readSpecStatus(s.cwd, "specs/spec-probe.md").status, "draft");
		assert.ok(r.reviewPackage);
		assert.ok(s.store.verifyEvidenceManifest(r.reviewPackage!.dir).ok);
	} finally { s.cleanup(); }
});

check("spec reject aborts the run", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			ui: { hasUI: true, select: async () => "reject", notify: () => {} },
		}));
		assert.equal(r.outcome, "aborted");
		assert.equal(r.machine.state, "ABORTED");
	} finally { s.cleanup(); }
});

check("spec request_changes returns to draft with the human note", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			ui: { hasUI: true, select: async () => "request_changes", input: async () => "补充不变量", notify: () => {} },
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.machine.state, "SPEC_DRAFT");
		assert.ok(r.rejectionText.includes("补充不变量"));
	} finally { s.cleanup(); }
});

check("a retry after request_changes gets a fresh checkpoint and is not deadlocked", async () => {
	const s = sandbox();
	try {
		const first = await runDeliverableStage(deps(s, {
			ui: { hasUI: true, select: async () => "request_changes", input: async () => "改一版", notify: () => {} },
		}));
		assert.equal(first.machine.state, "SPEC_DRAFT");
		const cp1 = first.machine.checkpointId!;

		const second = await runDeliverableStage(deps(s, {
			machine: first.machine, ui: { hasUI: true, select: async () => "approve", notify: () => {} },
		}));
		assert.equal(second.outcome, "pass", second.summary);
		assert.equal(second.machine.state, "PLAN_DRAFT");
		assert.notEqual(second.machine.checkpointId, cp1, "retry reused the old checkpoint and would hit the old decision");
		assert.ok(s.store.exists(`${s.store.checkpointDir(cp1)}/human-decision.json`), "old evidence must stay");
	} finally { s.cleanup(); }
});

check("l1=false still runs the configured spec panel and reaches PLAN_DRAFT", async () => {
	const s = sandbox();
	try {
		s.config.stages.spec.l1 = false;
		const r = await runDeliverableStage(deps(s, {
			ui: { hasUI: true, select: async () => "approve", notify: () => {} },
		}));
		assert.equal(r.outcome, "pass", r.summary);
		assert.equal(r.machine.state, "PLAN_DRAFT", `state is ${r.machine.state}`);
		assert.equal(r.panel?.outcome, "PASS");
		assert.ok(s.store.exists("spec/l2-verdict.json"), "panel verdict missing");
	} finally { s.cleanup(); }
});

check("l1=false with no panel still advances SPEC_L2 → SPEC_HUMAN → PLAN_DRAFT", async () => {
	const s = sandbox();
	try {
		s.config.stages.spec.l1 = false;
		s.config.stages.spec.panel = false;
		const r = await runDeliverableStage(deps(s, {
			ui: { hasUI: true, select: async () => "approve", notify: () => {} },
		}));
		assert.equal(r.outcome, "pass", r.summary);
		assert.equal(r.machine.state, "PLAN_DRAFT", `state is ${r.machine.state}`);
		assert.equal(r.panel, undefined);
		assert.ok(r.machine.history.some((h) => h.event === "l2-skipped"), "l2-skipped transition was skipped");
	} finally { s.cleanup(); }
});

check("#8 every spec verdict reaches the review package", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s));
		const dir = r.reviewPackage!.dir;
		for (const f of ["l0-results.json", "l1-findings.json", "l2-verdict.json", "l2-panel.json", "summary.md", "evidence.sha256"]) {
			assert.ok(s.store.exists(`${dir}/${f}`), `package missing ${f}`);
		}
		const summary = s.store.readText(`${dir}/summary.md`)!;
		assert.ok(summary.includes("| L1 | pass"), "L1 verdict must appear in the summary");
		assert.ok(summary.includes("| L2 | pass"), "L2 verdict must appear in the summary");
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ plan stage
check("plan L0 coverage red returns to PLAN_DRAFT and lists missing ids", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		const r = await runDeliverableStage(deps(s, {
			stage: "plan", machine: machineAt("PLAN_DRAFT"), document: PLAN_PARTIAL, documentPath: undefined,
			runChild: async () => { calls++; return childOk(L1_PASS); },
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(calls, 0, "L1 must not run on a coverage red");
		assert.equal(r.machine.state, "PLAN_DRAFT");
		assert.ok(r.rejectionText.includes("PB-02"));
		assert.ok(s.store.exists("plan/coverage-matrix.json"));
		assert.ok(s.store.readText("plan/coverage-matrix.md")!.includes("**缺失**"));
	} finally { s.cleanup(); }
});

check("plan with full coverage passes L0 and reaches the human gate", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "plan", machine: machineAt("PLAN_DRAFT"), document: PLAN_FULL, documentPath: undefined,
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "awaiting-human");
		assert.equal(r.machine.state, "PLAN_HUMAN");
		assert.deepEqual(r.stageL0?.coverage?.missing, []);
	} finally { s.cleanup(); }
});

check("plan approve advances to TASK_LOOP", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "plan", machine: machineAt("PLAN_DRAFT"), document: PLAN_FULL, documentPath: undefined,
		}));
		assert.equal(r.outcome, "pass");
		assert.equal(r.machine.state, "TASK_LOOP");
	} finally { s.cleanup(); }
});

check("plan does not run the panel (config says false)", async () => {
	const s = sandbox();
	try {
		let panelCalls = 0;
		await runDeliverableStage(deps(s, {
			stage: "plan", machine: machineAt("PLAN_DRAFT"), document: PLAN_FULL, documentPath: undefined,
			runChild: async (o) => {
				if (o.systemPrompt.includes("L2")) panelCalls++;
				return childOk(L1_PASS);
			},
		}));
		assert.equal(panelCalls, 0);
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ task stage
check("task L0 red on an incomplete TASK.md stays in TASK_LOOP", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "task", machine: machineAt("TASK_LOOP"), document: "# TASK\n\n## 目标\nx\n", documentPath: undefined,
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.machine.state, "TASK_LOOP");
		assert.ok(r.rejectionText.includes("缺少必需小节") || r.rejectionText.includes("验收编号"));
	} finally { s.cleanup(); }
});

check("a complete TASK.md passes and advances to CODE_LOOP", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "task", machine: machineAt("TASK_LOOP"), document: TASK_DOC, documentPath: undefined,
		}));
		assert.equal(r.outcome, "pass", r.summary);
		assert.equal(r.machine.state, "CODE_LOOP");
		assert.ok(r.machine.checkpointId);
		assert.equal(r.machine.round, 1);
		assert.ok(s.store.exists("task/TASK.md"));
	} finally { s.cleanup(); }
});

check("task semantic rejection is a legal self-loop, not a dropped event", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "task", machine: machineAt("TASK_LOOP"), document: TASK_DOC, documentPath: undefined,
			runChild: async () => childOk(L1_FAIL),
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.machine.state, "TASK_LOOP");
		assert.ok(r.machine.attempt >= 1, "rejection must count toward the retry budget");
		assert.ok(r.machine.history.some((h) => h.event === "l1-blocker"));
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ discussion
check("discussion writes DECISIONS.md and advances to SPEC_DRAFT", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "discussion", machine: machineAt("DISCUSSION"), document: DISCUSSION_DOC, documentPath: undefined,
		}));
		assert.equal(r.outcome, "pass");
		assert.equal(r.machine.state, "SPEC_DRAFT");
		assert.equal(r.decisionsPath, "DECISIONS.md");
		const text = s.store.readText("DECISIONS.md")!;
		assert.ok(text.includes("选 A"), "rejection reasoning must be recorded");
		assert.ok(text.includes("不选") || text.includes("因为"));
	} finally { s.cleanup(); }
});

check("a fundamental requirement conflict escalates from discussion", async () => {
	const s = sandbox();
	try {
		const doc = DISCUSSION_DOC.replace("## 需求矛盾\n（无）", "## 需求矛盾\n帧槽必须为 1 与必须缓冲 3 帧互斥，无法同时满足。");
		const r = await runDeliverableStage(deps(s, {
			stage: "discussion", machine: machineAt("DISCUSSION"), document: doc, documentPath: undefined,
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "escalated");
		assert.equal(r.machine.state, "ESCALATED");
		assert.equal(r.machine.stage, "discussion", "a requirement conflict must resume discussion, not spec");
		assert.ok(r.escalations.some((e) => e.reason === "requirement-conflict"));
		assert.ok(s.store.exists("DECISIONS.md"), "the conflict evidence is still recorded");
	} finally { s.cleanup(); }
});

check("discussion runs no L0/L1 child (no mechanical floor)", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		await runDeliverableStage(deps(s, {
			stage: "discussion", machine: machineAt("DISCUSSION"), document: DISCUSSION_DOC, documentPath: undefined,
			runChild: async () => { calls++; return childOk(L1_PASS); },
		}));
		assert.equal(calls, 0);
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ producer
check("an empty document invokes the read-only producer", async () => {
	const s = sandbox();
	try {
		const seen: RunChildOptions[] = [];
		const r = await runDeliverableStage(deps(s, {
			stage: "discussion", machine: machineAt("DISCUSSION"), document: "", documentPath: undefined,
			runChild: async (o) => { seen.push(o); return childOk(DISCUSSION_DOC); },
		}));
		assert.equal(r.outcome, "pass");
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0].tools, ["read", "grep", "find", "ls"], "producer must be read-only");
		assert.equal(seen[0].systemPrompt, "producer prompt");
	} finally { s.cleanup(); }
});

check("a producer failure is reported, not silently skipped", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s, {
			stage: "discussion", machine: machineAt("DISCUSSION"), document: "", documentPath: undefined,
			runChild: async () => ({ ok: false, assistantText: "", rawStdout: "", stderr: "", exitCode: 1, signal: null, timeout: false, error: "model error" }),
		}));
		assert.equal(r.outcome, "invalid");
		assert.ok(r.rejectionText.includes("model error"));
	} finally { s.cleanup(); }
});

check("state.json is persisted after every stage run", async () => {
	const s = sandbox();
	try {
		const r = await runDeliverableStage(deps(s));
		const st = s.store.loadState<any>();
		assert.equal(st.state, r.machine.state);
		assert.ok(Array.isArray(st.history) && st.history.length > 0);
	} finally { s.cleanup(); }
});

console.log("== stage-pipeline.ts tests ==");
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
