// Tests for pipeline.ts — the four-layer code pipeline, fully injected.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/pipeline.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCodePipeline, diffStats, gateEnabled, type CodePipelineDeps, type RiskAssessment } from "./pipeline.ts";
import { ArtifactStore, sha256 } from "./store.ts";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { loadDecision, type HumanDecisionRecord } from "./human.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";
import type { HumanGateUi } from "./human.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const OK: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };
const DIFF = "diff --git a/src/capture/a.cpp b/src/capture/a.cpp\n--- a/src/capture/a.cpp\n+++ b/src/capture/a.cpp\n+int f(){return 0;}\n";

const L1_PASS = JSON.stringify({ layer: "L1", verdict: "pass", findings: [], summary: "clean" });
const L1_FAIL = JSON.stringify({
	layer: "L1", verdict: "fail",
	findings: [{ severity: "warning", file: "src/capture/a.cpp", line: 1, evidence: "null deref when x==0", required_fix: "guard x" }],
	summary: "bug",
});
const L2_PASS = JSON.stringify({ layer: "L2", verdict: "pass", findings: [], summary: "no violation" });
const L2_FAIL = JSON.stringify({
	layer: "L2", verdict: "fail",
	findings: [{ severity: "warning", file: "src/capture/a.cpp", line: 1, evidence: "violates HANDOFF-1 帧槽容量", required_fix: "cap 1" }],
	summary: "arch",
});

function runner(o: { diff?: string; build?: CommandResult; ctest?: CommandResult } = {}): CommandRunner {
	return async (cmd, args) => {
		const key = `${cmd} ${args.join(" ")}`;
		if (key.startsWith("git diff")) return { exitCode: 0, stdout: o.diff ?? DIFF, stderr: "" };
		if (key.startsWith("git ls-files")) return { exitCode: 0, stdout: "", stderr: "" };
		if (key.startsWith("cmake")) return o.build ?? OK;
		if (key.startsWith("ctest")) return o.ctest ?? OK;
		throw new Error(`unexpected command: ${key}`);
	};
}

function childOk(text: string): RunChildResult {
	return { ok: true, assistantText: text, model: "m/x", rawStdout: "", stderr: "", exitCode: 0, signal: null, timeout: false };
}
function childFail(error: string): RunChildResult {
	return { ok: false, assistantText: "", rawStdout: "", stderr: "", exitCode: 0, signal: null, timeout: false, error };
}

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-pipe-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	const cfg = loadConfig(process.cwd());
	assert.ok(cfg.ok, cfg.errors.join("; "));
	return { cwd, store, config: structuredClone(cfg.config!), cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function deps(s: ReturnType<typeof sandbox>, over: Partial<CodePipelineDeps> = {}): CodePipelineDeps {
	return {
		cwd: s.cwd,
		config: s.config,
		store: s.store,
		checkpointId: "cp1",
		run: runner(),
		runChild: async (o) => childOk(o.systemPrompt.includes("L2") ? L2_PASS : L1_PASS),
		systemPrompt: (l) => (l === "L1" ? "L1 reviewer prompt" : "L2 reviewer prompt"),
		constraintChecklist: "- HANDOFF-1: frame slot cap 1",
		ui: { hasUI: true, select: async () => "approve", notify: () => {} },
		coderModel: "hellocode/gpt-6-luna",
		...over,
	};
}

/** Force code-stage gates so tests are independent of risk grading. */
function allGates(cfg: OrchestratorConfig) {
	cfg.stages.code.panel = true;
	cfg.stages.code.human = true;
	return cfg;
}

// ------------------------------------------------------------------ diff parsing
check("diffStats extracts changed files and line counts", () => {
	const s = diffStats(DIFF);
	assert.deepEqual(s.files, ["src/capture/a.cpp"]);
	assert.equal(s.lines, 1);
});

check("diffStats includes untracked files listed under the marker", () => {
	const s = diffStats(`${DIFF}\n--- untracked files (contents not inlined) ---\nnew/a.cpp\nnew/b.h`);
	assert.ok(s.files.includes("new/a.cpp"));
	assert.ok(s.files.includes("new/b.h"));
});

check("diffStats ignores diff headers when counting lines", () => {
	const s = diffStats("--- a/x.cpp\n+++ b/x.cpp\n@@ -1 +1 @@\n-old\n+new\n");
	assert.equal(s.lines, 2);
});

/** Full grade shape, so tests exercise the real RiskAssessment contract. */
function grade(level: "low" | "medium" | "high", reasons: string[] = ["test"]): RiskAssessment {
	return { level, reasons, forbiddenHits: [], changedFiles: ["src/capture/a.cpp"], changedLines: 1, decidedBy: `test-${level}` };
}

check("gateEnabled fails closed when risk grading is unavailable", () => {
	assert.equal(gateEnabled(true), true);
	assert.equal(gateEnabled(false), false);
	assert.equal(gateEnabled("risk"), true, "missing grading must NOT skip a gate");
	assert.equal(gateEnabled("risk", grade("low")), false);
	assert.equal(gateEnabled("risk", grade("medium")), true);
	assert.equal(gateEnabled("risk", grade("high")), true);
});

// ------------------------------------------------------------------ L0 hard floor
check("#3 L0 red blocks before any LLM layer", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			run: runner({ build: { exitCode: 1, stdout: "", stderr: "error: boom" } }),
			runChild: async () => { calls++; return childOk(L1_PASS); },
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(calls, 0, "no LLM spend on broken code");
		assert.ok(r.rejectionText.includes("boom"));
		assert.equal(r.l1, undefined);
	} finally { s.cleanup(); }
});

check("#9 L0 consecutive red escalates on the run that reaches the limit", async () => {
	const s = sandbox();
	try {
		const notes: string[] = [];
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			run: runner({ build: { exitCode: 1, stdout: "", stderr: "error" } }),
			l0ConsecutiveFailures: 1, // this failure makes it 2 == limit
			ui: { hasUI: false, notify: (m: string) => notes.push(m) },
		}));
		assert.equal(r.outcome, "escalated");
		assert.equal(r.state, "ESCALATED");
		assert.ok(r.escalations.some((e) => e.reason === "l0-consecutive-red"));
		assert.ok(notes.some((n) => n.includes("l0-consecutive-red")));
		assert.ok(s.store.listEscalations().length > 0);
	} finally { s.cleanup(); }
});

check("no diff → no-diff and nothing runs", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		const r = await runCodePipeline(deps(s, {
			run: runner({ diff: "" }),
			runChild: async () => { calls++; return childOk(L1_PASS); },
		}));
		assert.equal(r.outcome, "no-diff");
		assert.equal(calls, 0);
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ L1
check("L1 blocking findings stop before the panel", async () => {
	const s = sandbox();
	try {
		const seen: string[] = [];
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async (o) => {
				seen.push(o.systemPrompt.includes("L2") ? "L2" : "L1");
				return childOk(L1_FAIL);
			},
		}));
		assert.equal(r.outcome, "blocked");
		assert.deepEqual(seen, ["L1"]);
		assert.ok(r.rejectionText.includes("src/capture/a.cpp:1"));
		assert.ok(r.rejectionText.includes("guard x"));
	} finally { s.cleanup(); }
});

check("malformed L1 verdict retried once then reported invalid", async () => {
	const s = sandbox();
	try {
		let calls = 0;
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async () => { calls++; return childOk("I think it is fine."); },
		}));
		assert.equal(r.outcome, "invalid");
		assert.equal(calls, 2);
		assert.ok(r.rejectionText.includes("裁决不合规"));
	} finally { s.cleanup(); }
});

check("#9 reviewer timeout escalates", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async () => childFail("timed out after 600000ms"),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "escalated");
		assert.ok(r.escalations.some((e) => e.reason === "timeout"));
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ L2 panel
check("#4 panel members get identical tasks with only structured upstream data", async () => {
	const s = sandbox();
	try {
		const tasks: RunChildOptions[] = [];
		await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async (o) => {
				if (o.systemPrompt.includes("L2")) tasks.push(o);
				return childOk(o.systemPrompt.includes("L2") ? L2_PASS : L1_PASS);
			},
		}));
		assert.ok(tasks.length >= 2, "panel should have several members");
		assert.equal(new Set(tasks.map((t) => t.userPrompt)).size, 1, "identical task per member");
		for (const t of tasks) {
			assert.ok(t.userPrompt.includes("HANDOFF-1"), "checklist present");
			assert.ok(t.userPrompt.includes('"layer": "L1"'), "structured L1 verdict present");
			assert.deepEqual(t.tools, ["read", "grep", "find", "ls"]);
		}
		// coder is openai family → the openai member must be excluded
		assert.ok(!tasks.some((t) => t.model === "hellocode/gpt-6-luna"), "coder family excluded");
	} finally { s.cleanup(); }
});

check("#3 a panel FAIL blocks and carries member evidence", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async (o) => {
				if (!o.systemPrompt.includes("L2")) return childOk(L1_PASS);
				return childOk(o.model?.startsWith("deepseek") ? L2_FAIL : L2_PASS);
			},
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.panel?.outcome, "FAIL");
		assert.ok(r.rejectionText.includes("HANDOFF-1"));
		assert.ok(r.reviewPackage === undefined, "no package needed when blocked before L3");
	} finally { s.cleanup(); }
});

check("#3 #9 panel BLOCKED escalates instead of silently passing", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async (o) => {
				if (!o.systemPrompt.includes("L2")) return childOk(L1_PASS);
				return childOk(o.model?.startsWith("deepseek") ? L2_PASS : "not json");
			},
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.panel?.outcome, "BLOCKED");
		assert.equal(r.outcome, "escalated");
		assert.ok(r.escalations.some((e) => e.reason === "panel-unaggregatable"));
		assert.notEqual(r.outcome, "pass");
	} finally { s.cleanup(); }
});

check("#2 panel cannot form when the coder family leaves too few members", async () => {
	const s = sandbox();
	try {
		s.config.panel.members = [
			{ model: "hellocode/gpt-6-luna", family: "openai" },
			{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		];
		s.config.panel.quorum = 2;
		s.config.panel.minDistinctFamilies = 2;
		const r = await runCodePipeline(deps(s, { config: allGates(s.config) }));
		assert.equal(r.outcome, "escalated");
		assert.equal(r.panel?.outcome, "BLOCKED");
		assert.ok(r.rejectionText.includes("面板无法组成"));
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ L3 human gate
check("#6 no human decision → parked at AWAITING_HUMAN_REVIEW, never pass", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "awaiting-human");
		assert.equal(r.state, "AWAITING_HUMAN_REVIEW");
		assert.equal(loadDecision(s.store, "cp1"), undefined);
		const saved = s.store.loadState<any>();
		assert.equal(saved.state, "AWAITING_HUMAN_REVIEW");
		assert.equal(saved.humanDecision, null);
	} finally { s.cleanup(); }
});

check("#7 print mode writes a verifiable package while waiting", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.ok(r.reviewPackage, "package must exist for the human to read");
		assert.ok(s.store.verifyEvidenceManifest(r.reviewPackage!.dir).ok);
		assert.equal(r.reviewPackage!.packageHash, sha256(r.reviewPackage!.manifest));
	} finally { s.cleanup(); }
});

check("#6 approve → pass and the decision binds to the package hash", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, { config: allGates(s.config) }));
		assert.equal(r.outcome, "pass");
		const d = loadDecision(s.store, "cp1")!;
		assert.equal(d.decision, "approve");
		assert.equal(d.packageHash, r.reviewPackage!.packageHash);
		assert.equal(s.store.loadState<any>().humanDecision, "approve");
	} finally { s.cleanup(); }
});

check("#6 request_changes → blocked with evidence back to the producer", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			ui: { hasUI: true, select: async () => "request_changes", input: async () => "请补齐边界处理", notify: () => {} },
		}));
		assert.equal(r.outcome, "blocked");
		assert.equal(r.state, "CODE_LOOP");
		assert.ok(r.rejectionText.includes("请补齐边界处理"));
		assert.equal(loadDecision(s.store, "cp1")!.decision, "request_changes");
	} finally { s.cleanup(); }
});

check("#6 reject → ABORTED terminal", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			ui: { hasUI: true, select: async () => "reject", notify: () => {} },
		}));
		assert.equal(r.outcome, "aborted");
		assert.equal(r.state, "ABORTED");
		assert.equal(s.store.loadState<any>().state, "ABORTED");
	} finally { s.cleanup(); }
});

check("#6 a cancelled dialog does not advance the machine", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			ui: { hasUI: true, select: async () => undefined, notify: () => {} },
		}));
		assert.equal(r.outcome, "awaiting-human");
		assert.equal(loadDecision(s.store, "cp1"), undefined);
	} finally { s.cleanup(); }
});

check("autoCommit=false keeps a passed checkpoint out of COMMITTED", async () => {
	const s = sandbox();
	try {
		s.config.autoCommit = false;
		const r = await runCodePipeline(deps(s, { config: allGates(s.config) }));
		assert.equal(r.outcome, "pass");
		assert.notEqual(r.state, "COMMITTED", "must not auto-commit without authorisation");
	} finally { s.cleanup(); }
});

check("human gate skipped by config → pass without a decision", async () => {
	const s = sandbox();
	try {
		s.config.stages.code.panel = false;
		s.config.stages.code.human = false;
		const r = await runCodePipeline(deps(s));
		assert.equal(r.outcome, "pass");
		assert.equal(loadDecision(s.store, "cp1"), undefined);
		assert.ok(r.reviewPackage, "audit package still written");
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ risk routing
check("#12 risk routing is recorded in state and the package", async () => {
	const s = sandbox();
	try {
		const risk = grade("high", ["命中 src/platform/"]);
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			assessRisk: () => risk,
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(s.store.loadState<any>().risk, "high");
		const ra = s.store.readText(`${r.reviewPackage!.dir}/risk-assessment.md`)!;
		assert.ok(ra.includes("level: high"));
		assert.ok(ra.includes("命中 src/platform/"));
		assert.ok(ra.includes("L3 人类批准: 执行"));
	} finally { s.cleanup(); }
});

check("low risk with risk-gated layers skips panel and human", async () => {
	const s = sandbox();
	try {
		let panelCalls = 0;
		const r = await runCodePipeline(deps(s, {
			assessRisk: () => grade("low", ["仅 docs 小改动"]),
			runChild: async (o) => {
				if (o.systemPrompt.includes("L2")) panelCalls++;
				return childOk(L1_PASS);
			},
		}));
		assert.equal(r.outcome, "pass");
		assert.equal(panelCalls, 0);
		assert.equal(loadDecision(s.store, "cp1"), undefined);
	} finally { s.cleanup(); }
});

check("#9 forbidden path always escalates, even on a low-risk grade", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			run: runner({ diff: "diff --git a/third_party/x.h b/third_party/x.h\n--- a/third_party/x.h\n+++ b/third_party/x.h\n+bad\n" }),
			assessRisk: () => grade("low", ["小改动"]),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "escalated");
		assert.ok(r.escalations.some((e) => e.reason === "forbidden-path"));
		assert.notEqual(r.state, "COMMITTED");
	} finally { s.cleanup(); }
});

check("#9 retry limit escalates", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			attempt: 3,
			runChild: async () => childOk(L1_FAIL),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.equal(r.outcome, "escalated");
		assert.ok(r.escalations.some((e) => e.reason === "retry-limit"));
	} finally { s.cleanup(); }
});

check("#9 L0 green but L2 citing an L0-covered ID escalates as a conflict", async () => {
	const s = sandbox();
	try {
		const depFail = JSON.stringify({
			layer: "L2", verdict: "fail",
			findings: [{ severity: "warning", file: "src/capture/a.cpp", line: 1, evidence: "violates DEP-03 同层互引", required_fix: "x" }],
			summary: "arch",
		});
		const r = await runCodePipeline(deps(s, {
			config: allGates(s.config),
			runChild: async (o) => childOk(o.systemPrompt.includes("L2") ? depFail : L1_PASS),
			ui: { hasUI: false, notify: () => {} },
		}));
		assert.ok(r.escalations.some((e) => e.reason === "l0-l2-conflict"), r.escalations.map((e) => e.reason).join(","));
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ evidence chain
check("#8 a full pass writes the complete blueprint evidence chain", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, { config: allGates(s.config) }));
		for (const f of ["state.json", "checkpoints/cp1/diff.patch", "checkpoints/cp1/l0-results.json",
			"checkpoints/cp1/l1-findings.json", "checkpoints/cp1/l2-verdict.json", "checkpoints/cp1/l2-panel.json",
			"checkpoints/cp1/human-decision.json", "checkpoints/cp1/review-package/summary.md",
			"checkpoints/cp1/review-package/evidence.sha256"]) {
			assert.ok(s.store.exists(f), `missing artifact ${f}`);
		}
		assert.ok(s.store.verifyEvidenceManifest(r.reviewPackage!.dir).ok);
	} finally { s.cleanup(); }
});

check("#8 no secrets reach the evidence chain", async () => {
	const s = sandbox();
	try {
		await assert.rejects(
			() => runCodePipeline(deps(s, {
				config: allGates(s.config),
				run: runner({ diff: "+const k=\"sk-abcdefghijklmnopqrstuvwx\";\n" }),
			})),
			/looks like it contains/,
		);
	} finally { s.cleanup(); }
});

check("state.json records layers, risk and package hash for audit", async () => {
	const s = sandbox();
	try {
		const r = await runCodePipeline(deps(s, { config: allGates(s.config) }));
		const st = s.store.loadState<any>();
		assert.equal(st.stage, "code");
		assert.equal(st.checkpointId, "cp1");
		assert.equal(st.layers.l0, "pass");
		assert.equal(st.layers.l1, "pass");
		assert.equal(st.layers.panel, "PASS");
		assert.equal(st.packageHash, r.reviewPackage!.packageHash);
		assert.ok(Array.isArray(st.changedFiles));
	} finally { s.cleanup(); }
});

console.log("== pipeline.ts tests ==");
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
