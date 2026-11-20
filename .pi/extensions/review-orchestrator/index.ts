// Pi extension entry: three-layer review orchestrator.
//
// Registers:
//   - tool  review_l0_gate  : deterministic L0 gate (build + ctest), zero LLM
//   - cmd   /review         : full L0 → L1 → L2 pipeline with bounded retries
//   - hook  agent_settled   : re-runs the pipeline after a coder fix (bounded)
//
// Deviation from the plan text (documented in README.md): L1/L2 children are
// spawned as synchronous `pi -p --mode json --no-session` subprocesses instead
// of calling the `subagent` tool. Reasons: ExtensionCommandContext has no
// executeTool(), and the subagent tool is asynchronous in TUI (returns a run id;
// the report arrives later), so a command could not validate the verdict and
// drive the retry loop. Spawning directly is also stronger for isolation:
// --no-session gives a fresh context (cannot see the coder conversation) and
// --tools read,grep,find,ls removes write tools by construction.

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runL0Gate, detectPreset, type CommandRunner, type CommandResult } from "./l0.ts";
import { runReviewChild, parseAgentMd } from "./child.ts";
import { buildConstraintChecklist } from "./catalog.ts";
import { runReviewPipeline, hashText, collectDiff, decideRetry, nextAttempt, type PipelineResult } from "./orchestrator.ts";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { ArtifactStore, ensureGitignored, exportReviewPackage, listRuns, newRunId } from "./store.ts";
import { runCodePipeline, type CodeOutcome, type CodePipelineResult } from "./pipeline.ts";
import { assessRisk } from "./risk.ts";
import { autoCommitCheckpoint } from "./commit.ts";
import { decideByCommand, loadDecision, type HumanDecision, type HumanGateUi } from "./human.ts";
import {
	applyEvent, awaitsHuman, isTerminal, legalEvents, snapshotAtStage,
	type MachineSnapshot,
} from "./machine.ts";
import { loadMachine, nextStepHint, planDecision, selectResumeRun } from "./commands.ts";
import { runDeliverableStage, type DeliverableStageResult } from "./stage-pipeline.ts";

const AGENT_FILES = { L1: "reviewer-l1.md", L2: "architect-l2.md" } as const;
/** Producer profiles for the deliverable stages (all read-only). */
const PRODUCER_FILES = {
	discussion: "discussion.md",
	spec: "spec-writer.md",
	plan: "planner.md",
	task: "task-writer.md",
} as const;
type DeliverableStage = keyof typeof PRODUCER_FILES;
const MAX_RETRIES = 2;
const DIFF_CAP = 14_000;

interface OrchState {
	active: boolean;
	/** Run id reused across invocations in this session. */
	runId?: string;
	/**
	 * Checkpoint counter. Each retry round gets its OWN checkpoint directory: a
	 * fixed id would deadlock, because request_changes → fix produces a new
	 * package hash while recordDecision refuses to overwrite the old decision.
	 */
	round: number;
	attempt: number;
	continuation: boolean;
	pendingRecheck: boolean;
	lastDiffHash: string;
	l0ConsecutiveFailures: number;
	/** Latest checkpoint, the target of /orch approve|changes|reject. */
	checkpointId?: string;
	/** Delivery state machine; restored from state.json on resume. */
	machine?: MachineSnapshot;
}

interface ReviewState {
	/** Auto-recheck is armed while a pipeline run is being repaired. */
	pendingRecheck: boolean;
	attempt: number;
	lastDiffHash: string;
	lastLayer?: string;
	active: boolean;
	/**
	 * True when the next /review was dispatched by the settle hook rather than
	 * typed by a human. A continuation keeps the retry budget; a fresh command
	 * starts over. Without this the counter resets every round and max_retries
	 * never fires.
	 */
	continuation: boolean;
}

interface TextResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
}

const text = (t: string, details?: unknown, isError = false): TextResult => ({
	content: [{ type: "text", text: t }],
	details,
	...(isError ? { isError: true } : {}),
});

/** Wrap pi.exec into the CommandRunner shape l0.ts/orchestrator.ts expect. */
function makeRunner(pi: ExtensionAPI): CommandRunner {
	return async (command, args, options) => {
		const r = await pi.exec(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
			maxBuffer: 8 * 1024 * 1024,
		});
		const out: CommandResult = {
			exitCode: r.code,
			stdout: r.stdout,
			stderr: r.stderr,
			killed: r.killed,
			truncated: r.truncated,
		};
		return out;
	};
}

function projectFile(cwd: string, ...parts: string[]): string {
	return path.join(cwd, CONFIG_DIR_NAME, ...parts);
}

/** Load an agent's system prompt body; fall back to a minimal inline prompt. */
function loadAgentPrompt(cwd: string, layer: "L1" | "L2"): string {
	const file = projectFile(cwd, "agents", AGENT_FILES[layer]);
	try {
		const md = fs.readFileSync(file, "utf-8");
		const { body } = parseAgentMd(md);
		if (body.trim()) return body;
	} catch {
		/* fall through */
	}
	return layer === "L1"
		? "You are the L1 semantic reviewer. Output one verdict JSON (layer L1) per .pi/review/verdict-schema.md. Cite file:line and give required_fix or failing_test."
		: "You are the L2 architecture reviewer. Output one verdict JSON (layer L2) per .pi/review/verdict-schema.md. Cite constraint IDs from .pi/review/constraint-catalog.md.";
}

function loadConstraintChecklist(cwd: string): string {
	const file = projectFile(cwd, "review", "constraint-catalog.md");
	try {
		return buildConstraintChecklist(fs.readFileSync(file, "utf-8"));
	} catch {
		return "Read .pi/review/constraint-catalog.md and cite its constraint IDs.";
	}
}

/** Load a producer profile (discussion/spec/plan/task); fall back to a minimal prompt. */
function loadProducerPrompt(cwd: string, stage: DeliverableStage): string {
	const file = projectFile(cwd, "agents", PRODUCER_FILES[stage]);
	try {
		const md = fs.readFileSync(file, "utf-8");
		const { body } = parseAgentMd(md);
		if (body.trim()) return body;
	} catch {
		/* fall through */
	}
	return [
		`You are the ${stage} producer in a deterministic delivery pipeline.`,
		"Emit the deliverable as markdown on stdout. You are READ-ONLY: do not modify files.",
		"Obey AGENTS.md. Do not weaken specs, tests, or the latency/threading hard rules.",
	].join("\n");
}

/**
 * Read an operator-supplied deliverable path, refusing anything outside the repo.
 * Planning/reading user files must never become a write primitive.
 */
function readDocument(cwd: string, relPath: string): string {
	const abs = path.resolve(cwd, relPath);
	const rel = path.relative(cwd, abs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`路径必须在项目内：${relPath}`);
	}
	return fs.readFileSync(abs, "utf-8");
}

/** Human-readable one-screen summary of a deliverable-stage result. */
function summarizeStage(r: DeliverableStageResult): string {
	const lines = [r.summary];
	for (const [name, v] of [["L0", r.l0], ["L1", r.l1], ["L2", r.l2]] as const) {
		if (v) lines.push(`  ${name}: ${v.verdict}${v.findings.length ? ` (${v.findings.length} findings)` : ""}`);
	}
	if (r.panel) lines.push(`  面板: ${r.panel.outcome} 有效票 ${r.panel.validVotes}/${r.panel.quorum}`);
	if (r.reviewPackage) lines.push(`  审查包: ${r.reviewPackage.dir} (hash ${r.reviewPackage.packageHash.slice(0, 12)})`);
	if (r.humanDecision) lines.push(`  L3: ${r.humanDecision.decision} by ${r.humanDecision.decidedBy}`);
	for (const e of r.escalations) lines.push(`  升级: ${e.reason} — ${e.detail}`);
	if (r.specStatusAdvice) lines.push("", r.specStatusAdvice);
	return lines.join("\n");
}

async function runPipeline(
	pi: ExtensionAPI,
	cwd: string,
	onLog?: (line: string) => void,
): Promise<PipelineResult> {
	const runner = makeRunner(pi);
	return runReviewPipeline({
		cwd,
		run: runner,
		runChild: runReviewChild,
		systemPrompt: (layer) => loadAgentPrompt(cwd, layer),
		constraintChecklist: loadConstraintChecklist(cwd),
		diffCap: DIFF_CAP,
		onLog,
	});
}

/** UI helpers that are safe in print/json mode (no UI). */
function note(ctx: { hasUI: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }, msg: string, type: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(msg, type);
	} catch {
		/* best-effort */
	}
}

function status(ctx: { hasUI: boolean; ui: { setStatus: (k: string, v?: string) => void } }, msg?: string) {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus("review", msg);
	} catch {
		/* best-effort */
	}
}

function summarize(p: PipelineResult): string {
	const lines: string[] = [p.summary];
	for (const layer of ["L0", "L1", "L2"] as const) {
		const v = p.verdicts[layer];
		if (v) lines.push(`  ${layer}: ${v.verdict}${v.findings.length ? ` (${v.findings.length} findings)` : ""}`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	const state: ReviewState = {
		pendingRecheck: false,
		attempt: 0,
		lastDiffHash: "",
		active: false,
		continuation: false,
	};

	// Four-layer orchestration state (L0 → L1 → L2 panel → L3 human).
	const orch: OrchState = {
		active: false,
		round: 0,
		attempt: 0,
		continuation: false,
		pendingRecheck: false,
		lastDiffHash: "",
		l0ConsecutiveFailures: 0,
	};

	pi.registerFlag("review-auto", {
		description: "After each settled run with未提交改动, ask whether to run the review pipeline",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("review-legacy", {
		description: "Use the original three-layer /review flow instead of the four-layer pipeline",
		type: "boolean",
		default: false,
	});

	// ---------------------------------------------------------------- L0 tool
	pi.registerTool({
		name: "review_l0_gate",
		label: "Review L0 Gate",
		description:
			"Deterministic review gate (zero LLM): runs cmake build and ctest (including arch.layers and spec.structure) and returns a verdict JSON with exit codes and log excerpts. Use before an LLM review to avoid reviewing code that does not build.",
		promptSnippet: "Run the deterministic L0 gate (build + ctest) and get a verdict JSON",
		promptGuidelines: [
			"Use review_l0_gate when you need a deterministic build/test verdict, not an opinion.",
			"Use review_l0_gate before asking for a semantic review so reviewers do not see broken code.",
		],
		parameters: Type.Object({
			preset: Type.Optional(Type.String({ description: "CMake preset to use. Default: auto-detected from CMakePresets.json (prefers debug)." })),
			testFilter: Type.Optional(Type.String({ description: "Optional ctest -R filter." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const preset = params.preset?.trim() || detectPreset(ctx.cwd);
			onUpdate?.({ content: [{ type: "text", text: `Running L0 gate (preset ${preset})…` }], details: {} });
			const verdict = await runL0Gate({
				cwd: ctx.cwd,
				run: makeRunner(pi),
				preset,
				testFilter: params.testFilter?.trim() || undefined,
			});
			const body = JSON.stringify(verdict, null, 2);
			return text(body, { verdict, preset }, verdict.verdict === "fail");
		},
	});

	// ----------------------------------------------------------- /review command
	// Default: four-layer pipeline (L0 → L1 → risk-gated L2 panel → L3 human).
	// --review-legacy keeps the previously verified three-layer behaviour.
	 pi.registerCommand("review", {
		description:
			"Run the review pipeline: L0 build/ctest → L1 semantic → L2 cross-vendor panel → L3 human approval. Evidence is written to .orchestrator/. Use --review-legacy for the old three-layer flow.",
		handler: async (_args, ctx) => {
			if (state.active || orch.active) {
				note(ctx, "Review pipeline already running.", "warning");
				return;
			}
			if (pi.getFlag("review-legacy")) {
				state.active = true;
				state.attempt = nextAttempt({ attempt: state.attempt, continuation: state.continuation });
				state.continuation = false;
				state.pendingRecheck = false;
				try {
					await executePipeline(pi, ctx, state);
				} finally {
					state.active = false;
				}
				return;
			}
			orch.active = true;
			try {
				await executeFourLayer(pi, ctx);
			} finally {
				orch.active = false;
			}
		},
	});

	// ------------------------------------------------- settle hook (bounded loop)
	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.pendingRecheck || state.active) return;
		// Decide with the pure helper so both brakes (no change / retries exhausted)
		// live in one testable place.
		let diffHash = "";
		try {
			const diff = await collectDiff(makeRunner(pi), ctx.cwd);
			diffHash = hashText(diff);
		} catch {
			state.pendingRecheck = false;
			return;
		}
		const decision = decideRetry({
			attempt: state.attempt,
			maxRetries: MAX_RETRIES,
			diffHash,
			lastDiffHash: state.lastDiffHash,
		});
		state.pendingRecheck = false;
		if (decision.action === "stop") {
			note(ctx, `Review 已停止：${decision.reason}，需要人工介入。`, "warning");
			return;
		}
		if (decision.action === "manual") {
			note(ctx, `Review 已停止：${decision.reason}，转人工介入。`, "error");
			return;
		}
		// Mark this as a continuation so the next /review keeps counting.
		state.continuation = true;
		pi.sendUserMessage("/review", { expandPromptTemplates: true });
	});

	// ------------------------------------------------- optional auto suggestion
	pi.on("agent_settled", async (_event, ctx) => {
		if (!pi.getFlag("review-auto") || state.active) return;
		if (!ctx.hasUI) return;
		let diff = "";
		try {
			diff = await collectDiff(makeRunner(pi), ctx.cwd);
		} catch {
			return;
		}
		if (!diff.trim()) return;
		const ok = await ctx.ui.confirm("运行三层 review？", "检测到未提交改动。现在运行 L0→L1→L2？");
		if (ok) pi.sendUserMessage("/review", { expandPromptTemplates: true });
	});

	async function executePipeline(pi: ExtensionAPI, ctx: ExtensionCommandContext, st: ReviewState): Promise<void> {
		status(ctx, "L0 → L1 → L2 running…");
		let result: PipelineResult;
		try {
			result = await runPipeline(pi, ctx.cwd, (line) => {
				const layer = /^\[(L[012])\]/.exec(line)?.[1];
				if (layer) status(ctx, `${layer} running…`);
			});
		} catch (error) {
			status(ctx, undefined);
			note(ctx, `Review 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			status(ctx, undefined);
		}

		st.lastDiffHash = result.diffHash;

		if (result.outcome === "no-diff") {
			note(ctx, "工作区没有改动，跳过 review。", "info");
			return;
		}

		if (result.outcome === "pass") {
			st.attempt = 0;
			st.pendingRecheck = false;
			pi.sendMessage(
				{ customType: "review-result", content: summarize(result), display: true, details: { verdicts: result.verdicts } },
				{ deliverAs: "nextTurn" },
			);
			note(ctx, "Review 通过（L0+L1+L2）。", "info");
			return;
		}

		if (result.outcome === "invalid") {
			st.pendingRecheck = false;
			note(ctx, result.summary, "error");
			pi.sendMessage(
				{ customType: "review-result", content: summarize(result), display: true, details: { outcome: result.outcome } },
				{ deliverAs: "nextTurn" },
			);
			return;
		}

		// blocked
		st.attempt += 1;
		st.lastLayer = result.blockingLayer;
		const header = `[Review ${result.blockingLayer} 未通过 · 第 ${st.attempt}/${MAX_RETRIES} 轮]`;
		if (st.attempt > MAX_RETRIES) {
			st.pendingRecheck = false;
			note(ctx, `Review 连续 ${MAX_RETRIES} 轮未通过，转人工介入。`, "error");
			pi.sendMessage(
				{
					customType: "review-result",
					content: `${header}\n已达到重试上限，请人工介入。\n\n${result.rejectionText}`,
					display: true,
					details: { verdicts: result.verdicts },
				},
				{ deliverAs: "nextTurn" },
			);
			return;
		}

		// Drive the fix: arm the recheck, then send evidence-backed findings.
		st.pendingRecheck = true;
		note(ctx, `Review ${result.blockingLayer} 未通过，已附带证据打回（第 ${st.attempt}/${MAX_RETRIES} 轮）。`, "warning");
		pi.sendUserMessage(
			[
				header,
				"请按下列证据修复；修好后会自动重跑 review。",
				"",
				result.rejectionText,
			].join("\n"),
		);
	}

	// ============================================================ four-layer flow

	/** Load config + artifact store for the current run. Fail-closed on bad config. */
	function orchContext(cwd: string): { config: OrchestratorConfig; store: ArtifactStore } | { error: string } {
		const loaded = loadConfig(cwd, CONFIG_DIR_NAME);
		if (!loaded.ok || !loaded.config) {
			return { error: `编排器配置不可用：${loaded.errors.join("; ")}` };
		}
		const config = loaded.config;
		if (!orch.runId) orch.runId = newRunId();
		const store = new ArtifactStore({ cwd, root: config.artifacts.root, runId: orch.runId });
		if (config.artifacts.gitignore) {
			try { ensureGitignored(cwd, config.artifacts.root); } catch { /* best-effort */ }
		}
		return { config, store };
	}

	function fourLayerUi(ctx: { hasUI: boolean; ui: any }): HumanGateUi {
		return {
			hasUI: ctx.hasUI,
			select: ctx.hasUI ? (t: string, o: string[]) => ctx.ui.select(t, o) : undefined,
			input: ctx.hasUI ? (t: string, p?: string) => ctx.ui.input(t, p) : undefined,
			notify: (m: string, level?: "info" | "warning" | "error") => note(ctx, m, level ?? "info"),
		};
	}

	function summarizeFour(r: CodePipelineResult): string {
		const lines = [r.summary];
		for (const [name, v] of [["L0", r.l0], ["L1", r.l1], ["L2", r.l2]] as const) {
			if (v) lines.push(`  ${name}: ${v.verdict}${v.findings.length ? ` (${v.findings.length} findings)` : ""}`);
		}
		if (r.panel) {
			lines.push(`  面板: ${r.panel.outcome} 有效票 ${r.panel.validVotes}/${r.panel.quorum} 家族 ${r.panel.votingFamilies.join(",") || "无"}`);
		}
		if (r.risk) lines.push(`  风险: ${r.risk.level}`);
		if (r.reviewPackage) lines.push(`  审查包: ${r.reviewPackage.dir} (hash ${r.reviewPackage.packageHash.slice(0, 12)})`);
		if (r.humanDecision) lines.push(`  L3: ${r.humanDecision.decision} by ${r.humanDecision.decidedBy}`);
		for (const e of r.escalations) lines.push(`  升级: ${e.reason} — ${e.detail}`);
		return lines.join("\n");
	}

	async function executeFourLayer(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		// print/json mode has no notify surface; mirror errors/no-diff so the run is
		// never silently empty.
		const reportFailure = (msg: string, level: "info" | "warning" | "error" = "info") => {
			note(ctx, msg, level);
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "orch-result", content: msg, display: true }, { deliverAs: "nextTurn" });
			}
		};
		const built = orchContext(ctx.cwd);
		if ("error" in built) {
			reportFailure(built.error, "error");
			return;
		}
		const { config, store } = built;

		orch.attempt = nextAttempt({ attempt: orch.attempt, continuation: orch.continuation });
		orch.continuation = false;
		orch.pendingRecheck = false;
		// Each round gets its own checkpoint: a fixed id would deadlock, because a
		// fix changes the package hash while an old decision cannot be overwritten.
		orch.round += 1;
		const checkpointId = `cp-${String(orch.round).padStart(3, "0")}`;
		orch.checkpointId = checkpointId;

		status(ctx, "L0 → L1 → L2 panel → L3 running…");
		let result: CodePipelineResult;
		try {
			result = await runCodePipeline({
				cwd: ctx.cwd,
				config,
				store,
				checkpointId,
				run: makeRunner(pi),
				runChild: runReviewChild,
				systemPrompt: (layer) => loadAgentPrompt(ctx.cwd, layer),
				constraintChecklist: loadConstraintChecklist(ctx.cwd),
				ui: fourLayerUi(ctx),
				coderModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				// Deterministic grading drives which gates run; never a model's opinion.
				assessRisk: (input) => assessRisk(config.risk, input),
				attempt: orch.attempt,
				l0ConsecutiveFailures: orch.l0ConsecutiveFailures,
				onLog: (line) => {
					const layer = /^\[(L[012])\]/.exec(line)?.[1];
					if (layer) status(ctx, `${layer} running…`);
				},
			});
		} catch (error) {
			reportFailure(`Review 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			status(ctx, undefined);
		}

		orch.lastDiffHash = result.diffHash;
		orch.l0ConsecutiveFailures = result.l0 && result.l0.verdict === "fail" ? orch.l0ConsecutiveFailures + 1 : 0;

		const report = summarizeFour(result);
		if (result.outcome === "no-diff") {
			reportFailure("工作区没有改动，跳过审查。", "info");
			return;
		}

		if (result.outcome === "pass") {
			orch.attempt = 0;
			orch.l0ConsecutiveFailures = 0;
			orch.pendingRecheck = false;
			pi.sendMessage({ customType: "orch-result", content: report, display: true, details: { outcome: result.outcome } }, { deliverAs: "nextTurn" });
			note(ctx, "审查通过。", "info");
			return;
		}

		if (result.outcome === "awaiting-human") {
			// Parked. Do NOT arm a recheck: only a human decision may advance this.
			orch.pendingRecheck = false;
			pi.sendMessage({ customType: "orch-result", content: report, display: true, details: { outcome: result.outcome } }, { deliverAs: "nextTurn" });
			note(ctx, `等待 L3 人工决定。用 /orch approve | /orch changes <说明> | /orch reject。`, "warning");
			return;
		}

		if (result.outcome === "aborted" || result.outcome === "escalated" || result.outcome === "invalid") {
			orch.pendingRecheck = false;
			pi.sendMessage({ customType: "orch-result", content: report, display: true, details: { outcome: result.outcome } }, { deliverAs: "nextTurn" });
			note(ctx, result.summary, result.outcome === "aborted" ? "warning" : "error");
			return;
		}

		// blocked → evidence-backed rejection, bounded by the same brakes as before.
		orch.attempt += 1;
		const header = `[审查未通过 · 第 ${orch.attempt}/${config.limits.maxRetries} 轮 · ${checkpointId}]`;
		if (orch.attempt > config.limits.maxRetries) {
			orch.pendingRecheck = false;
			pi.sendMessage(
				{ customType: "orch-result", content: `${header}\n已达重试上限，转人工。\n\n${report}\n\n${result.rejectionText}`, display: true },
				{ deliverAs: "nextTurn" },
			);
			note(ctx, `连续 ${config.limits.maxRetries} 轮未通过，转人工介入。`, "error");
			return;
		}
		orch.pendingRecheck = true;
		note(ctx, `审查未通过，已附带证据打回（第 ${orch.attempt}/${config.limits.maxRetries} 轮）。`, "warning");
		pi.sendUserMessage([header, "请按下列证据修复；修好后会自动重跑审查。", "", result.rejectionText].join("\n"));
	}

	// Settle hook for the four-layer flow: same two brakes as the legacy loop.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!orch.pendingRecheck || orch.active || state.active) return;
		const built = orchContext(ctx.cwd);
		if ("error" in built) { orch.pendingRecheck = false; return; }
		let diffHash = "";
		try {
			diffHash = hashText(await collectDiff(makeRunner(pi), ctx.cwd));
		} catch {
			orch.pendingRecheck = false;
			return;
		}
		const decision = decideRetry({
			attempt: orch.attempt,
			maxRetries: built.config.limits.maxRetries,
			diffHash,
			lastDiffHash: orch.lastDiffHash,
		});
		orch.pendingRecheck = false;
		if (decision.action !== "repair") {
			note(ctx, `审查已停止：${decision.reason}。`, decision.action === "manual" ? "error" : "warning");
			return;
		}
		orch.continuation = true;
		pi.sendUserMessage("/review", { expandPromptTemplates: true });
	});

	// ------------------------------------------------------------- /orch commands
	// L3 decisions only need to prove the package is unchanged: re-running
	// L0/L1/L2 would burn tokens to re-derive a pass we already recorded.
	//
	// All state changes go through the transition table (`applyEvent`). Command
	// handlers do not invent a next state — `/orch approve` used to hard-code
	// CODE_LOOP/COMMITTED, which was wrong for SPEC_HUMAN / PLAN_HUMAN.
	pi.registerCommand("orch", {
		description:
			"Orchestrator: /orch start [discussion|spec|plan|task] [path] | resume [run] | status | approve | changes <note> | reject | abort | export.",
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			// `note` is a no-op without a UI. print/json mode must still be able to
			// read the outcome — including config errors — so mirror every report
			// into the message stream.
			const emit = (msg: string, level: "info" | "warning" | "error" = "info") => {
				note(ctx, msg, level);
				if (!ctx.hasUI) {
					pi.sendMessage(
						{ customType: "orch-result", content: msg, display: true, details: { verb } },
						{ deliverAs: "nextTurn" },
					);
				}
			};

			const built = orchContext(ctx.cwd);
			if ("error" in built) {
				emit(built.error, "error");
				return;
			}
			const { config } = built;
			let store = built.store;

			// ---- start: run one deliverable stage -------------------------------
			if (verb === "start") {
				const stageArg = (rest[0] ?? "discussion").toLowerCase();
				if (!(stageArg in PRODUCER_FILES)) {
					emit(`未知阶段 "${stageArg}"。可用：${Object.keys(PRODUCER_FILES).join(" | ")}`, "error");
					return;
				}
				const stage = stageArg as DeliverableStage;
				const pathArg = rest.slice(1).join(" ").trim() || undefined;
				let document = "";
				if (pathArg) {
					try {
						document = readDocument(ctx.cwd, pathArg);
					} catch (e) {
						emit(`读取交付物失败：${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
				}

				const loaded = loadMachine(store);
				if (!loaded.ok) {
					emit(loaded.error, "error");
					return;
				}
				// Only reuse a snapshot that is actually runnable for this stage. A run
				// parked at SPEC_HUMAN/PLAN_HUMAN cannot accept "draft-ready"; reusing it
				// would log an illegal transition and then run gates out of order.
				const startState: Record<DeliverableStage, string> = {
					discussion: "DISCUSSION", spec: "SPEC_DRAFT", plan: "PLAN_DRAFT", task: "TASK_LOOP",
				};
				let machine = loaded.snapshot;
				const reusable = machine && !isTerminal(machine.state) &&
					machine.stage === stage && machine.state === startState[stage];
				if (!reusable) {
					if (machine && isTerminal(machine.state)) {
						// A finished run must not be reopened: start a new evidence chain.
						orch.runId = newRunId();
						store = new ArtifactStore({ cwd: ctx.cwd, root: config.artifacts.root, runId: orch.runId });
					}
					machine = snapshotAtStage(stage);
				}

				const documentPath = stage === "spec" && pathArg
					? path.relative(ctx.cwd, path.resolve(ctx.cwd, pathArg)).split(path.sep).join("/")
					: undefined;

				status(ctx, `[${stage}] L0 → L1${stage === "spec" ? " → L2 面板" : ""} → L3…`);
				let result: DeliverableStageResult;
				try {
					result = await runDeliverableStage({
						cwd: ctx.cwd,
						config,
						store,
						machine,
						stage,
						document,
						documentPath,
						run: makeRunner(pi),
						runChild: runReviewChild,
						producerPrompt: loadProducerPrompt(ctx.cwd, stage),
						reviewerPrompt: (layer) => loadAgentPrompt(ctx.cwd, layer),
						constraintChecklist: loadConstraintChecklist(ctx.cwd),
						ui: fourLayerUi(ctx),
						coderModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						onLog: (line) => {
							const layer = /^\[(L[012])\]/.exec(line)?.[1];
							if (layer) status(ctx, `${layer} running…`);
						},
					});
				} catch (e) {
					emit(`阶段执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				} finally {
					status(ctx, undefined);
				}

				orch.machine = result.machine;
				orch.checkpointId = result.machine.checkpointId;
				orch.attempt = result.machine.attempt;
				const report = summarizeStage(result);
				const nextState = result.machine.state;
				const tail = result.outcome === "blocked"
					? `\n\n修复后重跑：/orch start ${stage}${pathArg ? ` ${pathArg}` : ""}`
					: `\n\n下一步：${nextStepHint(nextState)}`;
				emit(report + tail, result.outcome === "pass" ? "info" : result.outcome === "aborted" ? "warning" : "error");
				if (ctx.hasUI) {
					pi.sendMessage(
						{ customType: "orch-result", content: report, display: true, details: { stage, outcome: result.outcome } },
						{ deliverAs: "nextTurn" },
					);
				}
				return;
			}

			// ---- resume: adopt an interrupted run --------------------------------
			if (verb === "resume") {
				const runs = listRuns(ctx.cwd, config.artifacts.root);
				const picked = selectResumeRun(runs, rest[0]);
				if (!picked.ok) {
					emit(picked.error, "warning");
					return;
				}
				orch.runId = picked.runId;
				store = new ArtifactStore({ cwd: ctx.cwd, root: config.artifacts.root, runId: picked.runId });
				const loaded = loadMachine(store);
				if (!loaded.ok || !loaded.snapshot) {
					emit(loaded.ok ? `${picked.runId} 没有 state.json，无法恢复。` : loaded.error, "error");
					return;
				}
				orch.machine = loaded.snapshot;
				orch.checkpointId = loaded.snapshot.checkpointId;
				orch.attempt = loaded.snapshot.attempt;
				orch.pendingRecheck = false;
				const st = store.loadState<any>();
				emit([
					`已恢复 run ${picked.runId}`,
					`state: ${loaded.snapshot.state}`,
					`stage: ${loaded.snapshot.stage}`,
					`checkpoint: ${loaded.snapshot.checkpointId ?? "-"}`,
					`outcome: ${st?.outcome ?? "-"}`,
					`下一步: ${nextStepHint(loaded.snapshot.state)}`,
				].join("\n"), "info");
				return;
			}

			// ---- abort: operator stop, legal from every working state -----------
			if (verb === "abort") {
				const loaded = loadMachine(store);
				if (!loaded.ok || !loaded.snapshot) {
					emit(loaded.ok ? "没有可终止的运行（state.json 缺失）。" : loaded.error, "warning");
					return;
				}
				if (isTerminal(loaded.snapshot.state)) {
					emit(`运行已是终态 ${loaded.snapshot.state}，无需终止。`, "info");
					return;
				}
				const moved = applyEvent(loaded.snapshot, "abort");
				if (!moved.ok) {
					emit(moved.error ?? "无法终止该运行", "error");
					return;
				}
				const st = store.loadState<any>();
				store.saveState({
					...st, ...moved.snapshot,
					outcome: "aborted", updatedAt: new Date().toISOString(),
				});
				orch.machine = moved.snapshot;
				orch.pendingRecheck = false;
				emit(`已终止：${loaded.snapshot.state} → ABORTED（证据链保留在 ${store.runDir}）。`, "warning");
				return;
			}

			// ---- status ---------------------------------------------------------
			if (verb === "status") {
				const st = store.loadState<any>();
				const loaded = loadMachine(store);
				const lines = [`run: ${store.runId}`];
				if (!st) lines.push("（本会话尚无运行记录；/orch resume 可恢复历史 run）");
				else {
					const m = loaded.ok ? loaded.snapshot : undefined;
					lines.push(`state: ${m?.state ?? st.state}`, `stage: ${m?.stage ?? st.stage ?? "-"}`);
					lines.push(`checkpoint: ${m?.checkpointId ?? st.checkpointId ?? "-"}`, `outcome: ${st.outcome ?? "-"}`);
					lines.push(`layers: ${JSON.stringify(st.layers)}`, `human: ${st.humanDecision ?? "未决定"}`);
					if (st.packageHash) lines.push(`package: ${String(st.packageHash).slice(0, 12)}`);
					if (m) {
						lines.push(`round: ${m.round} attempt: ${m.attempt} l0-red: ${m.l0ConsecutiveFailures}`);
						lines.push(`下一步: ${nextStepHint(m.state)}`);
						if (awaitsHuman(m.state)) {
							lines.push(`等待人工：approve | changes <说明> | reject（可用事件：${legalEvents(m.state).join(", ")}）`);
						}
					}
					if (!loaded.ok) lines.push(`（state.json 恢复失败：${loaded.error}）`);
				}
				const esc = store.listEscalations();
				if (esc.length) lines.push(`escalations: ${esc.length}（最新 ${esc[0]}）`);
				const runs = listRuns(ctx.cwd, config.artifacts.root);
				if (runs.length > 1) lines.push(`历史 run: ${runs.slice(0, 3).join(", ")}${runs.length > 3 ? " …" : ""}`);
				emit(lines.join("\n"), "info");
				return;
			}

			if (verb === "export") {
				const cp = orch.checkpointId ?? store.loadState<any>()?.checkpointId;
				if (!cp) { emit("没有可导出的 checkpoint。", "warning"); return; }
				try {
					const r = exportReviewPackage(store, cp, ctx.cwd, config.artifacts.exportDir);
					emit(`已导出 ${r.files.length} 个文件到 ${r.dir}`, "info");
				} catch (e) {
					emit(`导出失败：${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}

			// ---- human decisions ------------------------------------------------
			const decisionMap: Record<string, HumanDecision> = { approve: "approve", changes: "request_changes", reject: "reject" };
			const decision = decisionMap[verb];
			if (!decision) {
				emit(`未知子命令 "${verb}"。可用：start | resume | status | approve | changes <说明> | reject | abort | export`, "warning");
				return;
			}

			const st = store.loadState<any>();
			const loaded = loadMachine(store);
			if (!loaded.ok || !loaded.snapshot) {
				emit(loaded.ok ? "没有运行中的状态机。先 /orch start 或 /orch resume。" : loaded.error, "warning");
				return;
			}
			const machine = loaded.snapshot;
			// Legality is checked BEFORE writing anything: a rejected decision must
			// not leave a decision record that makes the run unrecoverable.
			const preview = planDecision(machine, decision);
			if (!preview.ok) {
				emit(preview.error, "error");
				return;
			}

			// ESCALATED has no review package by construction (the escalation fired
			// before one could be built). Requiring a package hash here made every
			// ruling unreachable except `/orch abort`; a ruling resumes work instead.
			if (machine.state === "ESCALATED") {
				const applied = applyEvent(machine, preview.plan.event, { now: new Date() });
				if (!applied.ok) {
					emit(applied.error ?? "状态机拒绝该裁决", "error");
					return;
				}
				const at = new Date().toISOString();
				try {
					store.writeJson(store.escalationFile("human-ruling"), {
						decision, note: rest.join(" ") || undefined, decidedBy: "user", decidedAt: at,
						from: machine.state, to: applied.snapshot.state, stage: machine.stage,
					});
				} catch (e) {
					emit(`裁决记录写入失败（继续应用状态）：${e instanceof Error ? e.message : String(e)}`, "warning");
				}
				store.saveState({
					...st, ...applied.snapshot,
					outcome: preview.plan.outcome,
					humanDecision: decision,
					updatedAt: at,
				});
				orch.machine = applied.snapshot;
				orch.checkpointId = applied.snapshot.checkpointId;
				emit([
					`人工裁决：${decision}（${machine.stage}）`,
					`状态：ESCALATED → ${applied.snapshot.state}`,
					`下一步：${nextStepHint(applied.snapshot.state)}`,
				].join("\n"), decision === "reject" ? "warning" : "info");
				if (decision !== "reject") {
					pi.sendUserMessage(
						[`[人工裁决 · 恢复 ${machine.stage} · ${decision}]`, rest.join(" ") || "人工裁决后恢复推进。", "", `下一步：${nextStepHint(applied.snapshot.state)}`].join("\n"),
					);
				}
				return;
			}

			const cp = machine.checkpointId ?? st?.checkpointId ?? orch.checkpointId;
			if (!cp || !st?.packageHash) {
				emit("当前没有等待人工决定的审查包。", "warning");
				return;
			}
			// Re-derive the package hash from disk: proves nothing changed since the
			// human read it, and detects tampering.
			const pkgDir = store.reviewPackageDir(cp);
			const verified = store.verifyEvidenceManifest(pkgDir);
			if (!verified.ok) {
				emit(`审查包校验失败，拒绝记录决定：${verified.problems.join("; ")}`, "error");
				return;
			}
			const currentHash = st.packageHash as string;
			const saved = decideByCommand({
				store, runId: store.runId, checkpointId: cp, stage: machine.stage,
				packageHash: currentHash, packageDir: pkgDir, decision,
				note: rest.join(" ") || undefined, currentPackageHash: currentHash,
			});
			if (!saved.ok || !saved.record) {
				emit(`无法记录决定：${saved.error ?? "未知"}`, "error");
				return;
			}

			const applied = applyEvent(machine, preview.plan.event, { now: new Date() });
			if (!applied.ok) {
				emit(applied.error ?? "状态机拒绝该决定", "error");
				return;
			}
			store.saveState({
				...st, ...applied.snapshot,
				outcome: preview.plan.outcome,
				humanDecision: decision,
				updatedAt: new Date().toISOString(),
			});
			orch.machine = applied.snapshot;
			orch.checkpointId = applied.snapshot.checkpointId;

			const lines = [
				`L3 已记录：${decision}（${cp}）`,
				`状态：${machine.state} → ${applied.snapshot.state}`,
			];
			if (machine.stage === "spec" && decision === "approve" && st.packageHash) {
				const advice = store.readText(store.stageFile("spec", "status-advice.md"));
				if (advice?.trim()) lines.push("", advice.trim());
			}
			lines.push(`下一步：${nextStepHint(applied.snapshot.state)}`);
			emit(lines.join("\n"), decision === "reject" ? "warning" : "info");

			if (decision === "request_changes") {
				const noteText = rest.join(" ").trim();
				if (machine.stage === "code") {
					// Code stage: the main agent repairs the diff, then the settle hook
					// re-runs /review. Deliverable stages instead wait for an explicit
					// `/orch start <stage>` with the revised document.
					orch.pendingRecheck = true;
					orch.attempt += 1;
					pi.sendUserMessage(
						[`[L3 要求修改 · ${cp}]`, noteText ? `人工说明：${noteText}` : "人工要求修改，未附说明；请向人确认具体诉求。", "", `审查包：${pkgDir}`].join("\n"),
					);
				} else {
					pi.sendUserMessage(
						[`[L3 要求修改 · ${machine.stage} · ${cp}]`, noteText || "人工要求修改，未附说明。", "", `修复后重跑：/orch start ${machine.stage}${machine.stage === "spec" ? " <规格路径>" : ""}`].join("\n"),
					);
				}
			}
		},
	});
}