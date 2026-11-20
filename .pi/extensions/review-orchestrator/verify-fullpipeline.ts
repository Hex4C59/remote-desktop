// C11 verification: the WHOLE delivery pipeline in a throwaway sandbox.
//
//   discussion → spec → plan → task → code
//
// plus the red paths the blueprint cares about:
//   - L0 red returns to the producer BEFORE any LLM spend
//   - plan coverage red lists the missing acceptance ids
//   - L3 request_changes / reject act on the machine
//   - an escalation parks the run and a human ruling resumes it
//   - the evidence chain is complete and independently verifiable
//
// Child reviewers are faked deterministically: the point is routing and
// evidence, not model quality (the real-model path is verify-four-layer.ts).
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/verify-fullpipeline.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDeliverableStage } from "./stage-pipeline.ts";
import { runCodePipeline } from "./pipeline.ts";
import { loadConfig } from "./config.ts";
import { ArtifactStore } from "./store.ts";
import { applyEvent, snapshotAtStage, type MachineSnapshot } from "./machine.ts";
import { planDecision } from "./commands.ts";
import { loadDecision, type HumanGateUi } from "./human.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orch-full-"));
const specRel = "specs/spec-probe.md";
const specText = [
	"# spec-probe：全流水线探针",
	"",
	"status: draft",
	"",
	"## 事实来源",
	"- docs/architecture.md",
	"",
	"## 接口契约",
	"- `probe()` 返回值必须可断言",
	"",
	"## 不变量",
	"- 不新增同步等待",
	"",
	"## 验收场景",
	"| 编号 | 场景 | 期望 |",
	"|---|---|---|",
	"| PB-01 | 正常路径 | 返回 0 |",
	"| PB-02 | 错误路径 | 返回错误码 |",
	"",
].join("\n");

const planText = [
	"# 计划",
	"",
	"| 用例 | 任务 |",
	"|---|---|",
	"| PB-01 | T1 |",
	"| PB-02 | T2 |",
	"",
].join("\n");

const taskText = [
	"# TASK",
	"",
	"## 目标",
	"实现 probe。",
	"",
	"## 验收依据",
	"PB-01, PB-02",
	"",
	"## 变更范围",
	"- src/foo.cpp",
	"",
	"## 验证方式",
	"ctest",
	"",
].join("\n");

const discussionText = [
	"# 讨论",
	"",
	"方案 A：显式转移表。",
	"方案 B：模型自由决定。",
	"",
	"选定 A：确定性、可审计、可恢复。",
	"",
].join("\n");

const diffText = [
	"diff --git a/src/foo.cpp b/src/foo.cpp",
	"--- a/src/foo.cpp",
	"+++ b/src/foo.cpp",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");

function seed(): void {
	for (const d of ["specs", "tools", ".pi/agents", ".pi/orchestrator", ".pi/review", "src"]) {
		fs.mkdirSync(path.join(sandbox, d), { recursive: true });
	}
	fs.writeFileSync(path.join(sandbox, specRel), specText, "utf-8");
	fs.writeFileSync(path.join(sandbox, "tools", "check_specs.py"), "# sandbox stub\n", "utf-8");
	fs.writeFileSync(path.join(sandbox, "src", "foo.cpp"), "int probe() { return 0; }\n", "utf-8");
	fs.writeFileSync(path.join(sandbox, "CMakePresets.json"), JSON.stringify({
		version: 6,
		buildPresets: [{ name: "debug" }],
		testPresets: [{ name: "debug" }],
	}, null, 2), "utf-8");
	fs.copyFileSync(path.join(REPO, ".pi", "orchestrator", "config.json"), path.join(sandbox, ".pi", "orchestrator", "config.json"));
	fs.copyFileSync(path.join(REPO, ".pi", "review", "constraint-catalog.md"), path.join(sandbox, ".pi", "review", "constraint-catalog.md"));
}

interface RunnerOpts {
	specExit?: number;
	buildExit?: number;
	testExit?: number;
	diff?: string;
}

function makeRunner(o: RunnerOpts = {}): CommandRunner {
	return async (cmd, args): Promise<CommandResult> => {
		if (cmd === "git") {
			if (args[0] === "diff") return { exitCode: 0, stdout: o.diff ?? "", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		}
		if (cmd === "cmake") return { exitCode: o.buildExit ?? 0, stdout: "", stderr: "" };
		if (cmd === "ctest") return { exitCode: o.testExit ?? 0, stdout: "", stderr: "" };
		if (cmd === "python" || cmd === "python3" || cmd === "py") {
			return { exitCode: o.specExit ?? 0, stdout: "", stderr: "" };
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

const childCalls: string[] = [];

function makeChild(): (opts: RunChildOptions) => Promise<RunChildResult> {
	return async (opts) => {
		const layer = opts.systemPrompt.includes("L2") ? "L2" : "L1";
		childCalls.push(layer);
		return {
			ok: true,
			assistantText: JSON.stringify({ layer, verdict: "pass", findings: [], summary: "ok" }),
			model: "fake",
			rawStdout: "", stderr: "", exitCode: 0, signal: null, timeout: false,
		};
	};
}

function ui(choice?: "approve" | "request_changes" | "reject", note?: string): HumanGateUi {
	const notices: string[] = [];
	return {
		hasUI: true,
		select: async () => choice,
		input: async () => note,
		notify: (m) => notices.push(m),
	};
}

const config = (() => {
	seed();
	const loaded = loadConfig(sandbox, ".pi");
	assert.ok(loaded.ok && loaded.config, `config failed: ${loaded.errors.join("; ")}`);
	return loaded.config;
})();

const storeFor = (runId: string) => new ArtifactStore({ cwd: sandbox, root: ".orchestrator", runId });

async function runStage(args: {
	store: ArtifactStore;
	machine: MachineSnapshot;
	stage: "discussion" | "spec" | "plan" | "task";
	document: string;
	runner?: RunnerOpts;
	ui?: HumanGateUi;
	documentPath?: string;
}) {
	return runDeliverableStage({
		cwd: sandbox,
		config,
		store: args.store,
		machine: args.machine,
		stage: args.stage,
		document: args.document,
		documentPath: args.documentPath,
		run: makeRunner(args.runner),
		runChild: makeChild(),
		producerPrompt: "producer",
		reviewerPrompt: (layer) => `You are the ${layer} reviewer for the sandbox.`,
		constraintChecklist: "HANDOFF-1: no synchronous wait on the hot path",
		ui: args.ui ?? ui(),
		coderModel: undefined,
	});
}

async function main(): Promise<void> {
	// ===================================================== happy path
	const store = storeFor("20260201t000000z-main");
	let machine = snapshotAtStage("discussion");
	const discussion = await runStage({ store, machine, stage: "discussion", document: discussionText });
	check("discussion → SPEC_DRAFT and DECISIONS.md records the choice", () => {
		assert.equal(discussion.outcome, "pass");
		assert.equal(discussion.machine.state, "SPEC_DRAFT");
		const text = fs.readFileSync(path.join(store.runDir, "DECISIONS.md"), "utf-8");
		assert.ok(text.includes("选定 A"));
	});

	const spec = await runStage({
		store, machine: discussion.machine, stage: "spec", document: specText,
		documentPath: specRel, ui: ui("approve"),
	});
	check("#18 spec: L0 → L1 → cross-vendor panel → L3 approve → PLAN_DRAFT", () => {
		assert.equal(spec.outcome, "pass", spec.summary);
		assert.equal(spec.machine.state, "PLAN_DRAFT");
		assert.equal(spec.panel?.outcome, "PASS");
		assert.equal(spec.humanDecision?.decision, "approve");
	});
	check("#17 spec status stays draft after L3 approve", () => {
		assert.ok(fs.readFileSync(path.join(sandbox, specRel), "utf-8").includes("\nstatus: draft\n"));
	});
	check("#19 spec evidence chain is complete and verifiable", () => {
		for (const f of ["l0-results.json", "l1-findings.json", "l2-verdict.json", "l2-panel.json"]) {
			assert.ok(fs.existsSync(path.join(store.runDir, "spec", f)), `missing spec/${f}`);
		}
		const pkg = store.reviewPackageDir(spec.machine.checkpointId!);
		assert.ok(fs.existsSync(path.join(store.runDir, pkg, "evidence.sha256")), `missing ${pkg}/evidence.sha256`);
		assert.ok(store.verifyEvidenceManifest(pkg).ok);
	});

	const plan = await runStage({
		store, machine: spec.machine, stage: "plan", document: planText, ui: ui("approve"),
	});
	check("#18 plan: coverage L0 → L1 → L3 approve → TASK_LOOP", () => {
		assert.equal(plan.outcome, "pass", plan.summary);
		assert.equal(plan.machine.state, "TASK_LOOP");
		assert.ok(plan.stageL0?.coverage?.ok);
		assert.equal(plan.humanDecision?.decision, "approve");
	});

	const task = await runStage({ store, machine: plan.machine, stage: "task", document: taskText });
	check("#18 task: structure L0 → L1 → CODE_LOOP (no human gate)", () => {
		assert.equal(task.outcome, "pass", task.summary);
		assert.equal(task.machine.state, "CODE_LOOP");
		assert.ok(fs.existsSync(path.join(store.runDir, "task", "TASK.md")));
	});

	const code = await runCodePipeline({
		cwd: sandbox, config, store, checkpointId: "cp-001",
		run: makeRunner({ diff: diffText }),
		runChild: makeChild(),
		systemPrompt: (layer) => `You are the ${layer} reviewer for the sandbox.`,
		constraintChecklist: "HANDOFF-1",
		ui: ui(),
		assessRisk: (input) => ({
			level: "low", reasons: ["test fixture"], forbiddenHits: [],
			changedFiles: input.changedFiles, changedLines: input.changedLines,
			gates: { l0: true, l1: true, panel: false, human: false },
		}),
	});
	check("#18 code: low risk skips panel/L3 and passes without committing", () => {
		assert.equal(code.outcome, "pass", code.summary);
		assert.equal(code.state, "CODE_LOOP");
		assert.equal(code.panel, undefined, "low risk must not spend on the panel");
		assert.equal(code.humanDecision, undefined, "low risk must not park at L3");
		assert.ok(!fs.existsSync(path.join(store.runDir, "checkpoints", "cp-001", "human-decision.json")));
	});

	// ===================================================== red paths
	const redStore = storeFor("20260202t000000z-l0red");
	const before = childCalls.length;
	const specRed = await runStage({
		store: redStore, machine: snapshotAtStage("spec"), stage: "spec",
		document: specText, documentPath: specRel, runner: { specExit: 1 },
	});
	check("#18 spec L0 red returns to SPEC_DRAFT and spends zero LLM calls", () => {
		assert.equal(specRed.outcome, "blocked");
		assert.equal(specRed.machine.state, "SPEC_DRAFT");
		assert.equal(childCalls.length, before, "L1 must not run after an L0 red");
	});

	const planRedStore = storeFor("20260203t000000z-planred");
	const planRed = await runStage({
		store: planRedStore, machine: snapshotAtStage("plan"), stage: "plan",
		document: "# 计划\n\n| 用例 | 任务 |\n|---|---|\n| PB-01 | T1 |\n",
	});
	check("#18 plan coverage red names the uncovered acceptance id", () => {
		assert.equal(planRed.outcome, "blocked");
		assert.equal(planRed.machine.state, "PLAN_DRAFT");
		assert.ok(planRed.rejectionText.includes("PB-02"), planRed.rejectionText);
	});

	const changesStore = storeFor("20260204t000000z-changes");
	const changes = await runStage({
		store: changesStore, machine: snapshotAtStage("plan"), stage: "plan",
		document: planText, ui: ui("request_changes", "补一条集成用例"),
	});
	check("#18 L3 request_changes returns PLAN_HUMAN → PLAN_DRAFT with the note", () => {
		assert.equal(changes.machine.state, "PLAN_DRAFT");
		assert.equal(loadDecision(changesStore, changes.machine.checkpointId!)?.note, "补一条集成用例");
	});

	const rejectStore = storeFor("20260205t000000z-reject");
	const rejected = await runStage({
		store: rejectStore, machine: snapshotAtStage("spec"), stage: "spec",
		document: specText, documentPath: specRel, ui: ui("reject"),
	});
	check("#18 L3 reject terminates at ABORTED", () => {
		assert.equal(rejected.outcome, "aborted");
		assert.equal(rejected.machine.state, "ABORTED");
	});

	// ===================================================== escalation + resume
	const escStore = storeFor("20260206t000000z-escalate");
	const escalatingMachine = { ...snapshotAtStage("spec"), l0ConsecutiveFailures: config.limits.maxL0ConsecutiveFailures - 1 };
	const escalated = await runStage({
		store: escStore, machine: escalatingMachine, stage: "spec",
		document: specText, documentPath: specRel, runner: { specExit: 1 },
	});
	check("#18 repeated L0 red escalates and writes an escalation record", () => {
		assert.equal(escalated.outcome, "escalated");
		assert.equal(escalated.machine.state, "ESCALATED");
		assert.ok(escStore.listEscalations().some((f) => f.includes("l0-consecutive-red")));
	});
	check("#18 a human ruling resumes the escalated stage", () => {
		const resume = planDecision(escalated.machine, "approve");
		assert.ok(resume.ok);
		assert.equal(resume.plan.next.state, "SPEC_DRAFT");
	});

	// ===================================================== report
	console.log("== C11 full pipeline ==");
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
