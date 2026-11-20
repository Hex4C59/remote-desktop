// Four-layer code pipeline: L0 → L1 → (risk-gated) L2 panel → L3 human.
//
// This composes the A-stage modules. It does NOT write code and does NOT review
// code itself: it runs gates, records evidence, and routes. Every decision is
// either a script result (L0, aggregation, risk) or an explicit human decision.
//
// All side effects are injected (run / runChild / store / ui), so the whole
// pipeline is testable without a toolchain, a model, or a terminal.

import type { OrchestratorConfig, RiskLevel } from "./config.ts";
import type { CommandRunner } from "../checks/l0.ts";
import { runL0Gate } from "../checks/l0.ts";
import type { RunChildOptions, RunChildResult } from "../review/child.ts";
import { collectDiff, hashText, structuredProjection, type PipelineOutcome } from "./orchestrator.ts";
import { parseAndValidate, formatFindingsForCoder, isBlocking, type ParsedVerdict } from "../review/verdict.ts";
import { resolvePanel } from "../review/panel.ts";
import { runPanel, type PanelMemberRecord } from "../review/panel-runner.ts";
import { panelToVerdict, type PanelAggregate } from "../review/aggregate.ts";
import { buildReviewPackage, type ReviewPackage } from "../evidence/package.ts";
import type { RiskAssessment } from "../review/risk.ts";
import { requestHumanDecision, routeDecision, type HumanDecisionRecord, type HumanGateUi } from "../evidence/human.ts";
import { ArtifactStore } from "../evidence/store.ts";
import { collectEscalations, raiseEscalations, type Escalation, type EscalationFacts } from "./escalate.ts";
import { autoCommitCheckpoint } from "../evidence/commit.ts";

export type CodeOutcome =
	| "pass"              // every required gate cleared (incl. human approve)
	| "blocked"           // a gate failed; findings go back to the producer
	| "awaiting-human"    // parked at L3; NO progress until a decision exists
	| "escalated"         // an anomaly needs a human ruling
	| "aborted"           // human rejected
	| "no-diff"
	| "invalid";          // a layer never produced a usable verdict

/** Single source of truth for the grade shape (risk.ts owns it). */
export type { RiskAssessment };

export interface CodePipelineDeps {
	cwd: string;
	config: OrchestratorConfig;
	store: ArtifactStore;
	checkpointId: string;
	run: CommandRunner;
	runChild: (opts: RunChildOptions) => Promise<RunChildResult>;
	systemPrompt: (layer: "L1" | "L2") => string;
	constraintChecklist: string;
	ui: HumanGateUi;
	/** Model the coder used; its family is excluded from the panel. */
	coderModel?: string;
	/** Deterministic risk grading (B1). Omitted → treat "risk" gates as required. */
	assessRisk?: (input: { diff: string; changedFiles: string[]; changedLines: number }) => RiskAssessment;
	/** Retry round for this checkpoint, carried by the caller. */
	attempt?: number;
	/** Consecutive L0 failures observed so far for this checkpoint. */
	l0ConsecutiveFailures?: number;
	decidedBy?: string;
	onLog?: (line: string) => void;
}

export interface CodePipelineResult {
	outcome: CodeOutcome;
	l0?: ParsedVerdict;
	l1?: ParsedVerdict;
	l2?: ParsedVerdict;
	panel?: PanelAggregate;
	panelRecords?: PanelMemberRecord[];
	risk?: RiskAssessment;
	reviewPackage?: ReviewPackage;
	humanDecision?: HumanDecisionRecord;
	escalations: Escalation[];
	/** Evidence-backed text for the producer; empty when nothing to fix. */
	rejectionText: string;
	summary: string;
	diff: string;
	diffHash: string;
	changedFiles: string[];
	/** Machine state to persist; never advances past a missing human decision. */
	state: string;
}

/** Parse `git diff --numstat`-ish info out of a unified diff. */
export function diffStats(diff: string): { files: string[]; lines: number } {
	const files = new Set<string>();
	let lines = 0;
	for (const line of diff.split("\n")) {
		// Binary and mode-only patches have no ---/+++ paths. The collector disables
		// rename detection, so the repeated path also disambiguates spaces in names.
		const header = /^diff --git (?:a\/(.+) b\/\1|"a\/(.+)" "b\/\2")$/.exec(line);
		if (header) {
			files.add((header[1] ?? header[2]).replace(/^\.\//, ""));
			continue;
		}
		const m = /^\+\+\+ b\/(.+)$/.exec(line);
		if (m) { files.add(m[1].trim()); continue; }
		const d = /^--- a\/(.+)$/.exec(line);
		if (d && d[1] !== "/dev/null") { files.add(d[1].trim()); continue; }
		if (/^\+[^+]/.test(line) || /^-[^-]/.test(line)) lines++;
	}
	// Untracked files are listed by collectDiff under a marker heading.
	const marker = diff.indexOf("--- untracked files");
	if (marker >= 0) {
		for (const line of diff.slice(marker).split("\n").slice(1)) {
			const t = line.trim();
			if (t && !t.startsWith("[")) files.add(t);
		}
	}
	return { files: [...files], lines };
}

function capDiff(diff: string, cap: number): string {
	if (diff.length <= cap) return diff;
	return `${diff.slice(0, cap)}\n\n[... diff truncated to ${cap} chars for the child task ...]`;
}

/** Should a "risk"-gated layer run for this assessment? */
export function gateEnabled(flag: boolean | "risk", risk?: { level: RiskLevel }): boolean {
	if (typeof flag === "boolean") return flag;
	// No grading available → run the gate. Fail-closed: never skip a gate just
	// because risk grading is missing.
	if (!risk) return true;
	return risk.level !== "low";
}

export async function runCodePipeline(deps: CodePipelineDeps): Promise<CodePipelineResult> {
	const { config, store, checkpointId } = deps;
	const log = deps.onLog ?? (() => {});
	const attempt = deps.attempt ?? 0;
	const stage = "code" as const;

	const diff = await collectDiff(deps.run, deps.cwd);
	const diffHash = hashText(diff);
	const { files: changedFiles, lines: changedLines } = diffStats(diff);

	const finish = (r: Partial<CodePipelineResult> & { outcome: CodeOutcome; summary: string; state: string }): CodePipelineResult => {
		const result: CodePipelineResult = {
			escalations: [], rejectionText: "", diff, diffHash, changedFiles,
			...r,
		} as CodePipelineResult;
		store.saveState({
			runId: store.runId,
			stage,
			checkpointId,
			state: result.state,
			outcome: result.outcome,
			attempt,
			diffHash,
			changedFiles,
			changedLines,
			risk: result.risk?.level ?? null,
			layers: {
				l0: result.l0?.verdict ?? null,
				l1: result.l1?.verdict ?? null,
				l2: result.l2?.verdict ?? null,
				panel: result.panel?.outcome ?? null,
			},
			humanDecision: result.humanDecision?.decision ?? null,
			packageHash: result.reviewPackage?.packageHash ?? null,
			escalations: result.escalations.map((e) => e.reason),
			updatedAt: new Date().toISOString(),
		});
		return result;
	};

	if (!diff.trim()) {
		return finish({ outcome: "no-diff", summary: "工作区没有改动，跳过审查。", state: "CODE_LOOP" });
	}

	const risk = deps.assessRisk?.({ diff, changedFiles, changedLines });
	const stageCfg = config.stages.code;
	const wantPanel = gateEnabled(stageCfg.panel, risk);
	const wantHuman = gateEnabled(stageCfg.human, risk);

	// Facts accumulated for the escalation monitor.
	const facts: EscalationFacts = {
		runId: store.runId, stage, checkpointId,
		l0ConsecutiveFailures: deps.l0ConsecutiveFailures ?? 0,
		maxL0ConsecutiveFailures: config.limits.maxL0ConsecutiveFailures,
		changedFiles,
		forbiddenPaths: config.risk.forbiddenPaths,
		attempt,
		maxRetries: config.limits.maxRetries,
	};

	const escalateAndFinish = (
		base: Partial<CodePipelineResult> & { outcome: CodeOutcome; summary: string; state: string },
	): CodePipelineResult => {
		const escalations = collectEscalations({ ...facts, l0: base.l0, l1: base.l1, l2: base.l2, panel: base.panel, panelRecords: base.panelRecords });
		if (escalations.length > 0) {
			raiseEscalations({ store, notify: deps.ui.notify }, escalations);
		}
		// An anomaly always wins over a normal outcome: the human must rule.
		const outcome: CodeOutcome = escalations.length > 0 && base.outcome !== "aborted" ? "escalated" : base.outcome;
		return finish({
			...base,
			outcome,
			state: escalations.length > 0 ? "ESCALATED" : base.state,
			escalations,
			summary: escalations.length > 0
				? `${base.summary}\n需人工裁决：${escalations.map((e) => e.reason).join(", ")}`
				: base.summary,
		});
	};

	// ---- L0: deterministic, zero LLM ----
	log("[L0] running deterministic gate");
	const l0 = await runL0Gate({ cwd: deps.cwd, run: deps.run, onLog: log });
	if (isBlocking(l0)) {
		const consecutive = (deps.l0ConsecutiveFailures ?? 0) + 1;
		// The monitor must see THIS failure, otherwise "L0 consecutive red" could
		// never fire on the very run that reaches the limit.
		facts.l0ConsecutiveFailures = consecutive;
		return escalateAndFinish({
			outcome: "blocked", l0, risk,
			rejectionText: formatFindingsForCoder(l0) || l0.summary,
			summary: `L0 未通过（连续第 ${consecutive} 次）；L1/L2/L3 未启动。`,
			state: "CODE_LOOP",
		});
	}

	// ---- L1: independent semantic review ----
	const capped = capDiff(diff, config.limits.diffCap);
	const l1Task = [
		"Review the diff below for logic correctness, edge cases, error handling and spec consistency.",
		"L0 already passed (build + ctest, including arch.layers and spec.structure) — do not re-check those.",
		"Do not review architecture/constraint boundaries (that is L2).",
		"",
		"=== L0 VERDICT (structured) ===",
		structuredProjection(l0),
		"",
		"=== DIFF ===",
		capped,
	].join("\n");

	let l1: ParsedVerdict | undefined;
	let l1Errors: string[] = [];
	for (let i = 1; i <= 2; i++) {
		log(`[L1] child attempt ${i}`);
		const res = await deps.runChild({
			cwd: deps.cwd,
			systemPrompt: deps.systemPrompt("L1"),
			userPrompt: i === 1 ? l1Task : `${l1Task}\n\n[OUTPUT ERROR] Not a valid verdict JSON (${l1Errors.join("; ")}). Reply with ONLY the verdict JSON.`,
			tools: ["read", "grep", "find", "ls"],
			thinking: "low",
			timeoutMs: config.limits.childTimeoutMs,
		});
		if (!res.ok) {
			l1Errors = [res.error ?? `exit ${res.exitCode}`];
			if (/timed out/i.test(l1Errors[0])) facts.evidenceTimeout = l1Errors[0];
			continue;
		}
		const v = parseAndValidate(res.assistantText, "L1");
		if (v.ok && v.verdict) { l1 = v.verdict; l1Errors = []; break; }
		l1Errors = v.errors;
	}
	if (!l1) {
		return escalateAndFinish({
			outcome: "invalid", l0, risk,
			rejectionText: `L1 裁决不合规：${l1Errors.join("; ")}`,
			summary: "L1 未产出合法 verdict。",
			state: "CODE_LOOP",
		});
	}
	if (isBlocking(l1)) {
		return escalateAndFinish({
			outcome: "blocked", l0, l1, risk,
			rejectionText: formatFindingsForCoder(l1) || l1.summary,
			summary: `L1 发现问题（${l1.findings.length} 项）；L2/L3 未启动。`,
			state: "CODE_LOOP",
		});
	}

	// ---- L2: cross-vendor panel (risk-gated) ----
	let l2: ParsedVerdict | undefined;
	let panel: PanelAggregate | undefined;
	let panelRecords: PanelMemberRecord[] | undefined;
	if (wantPanel) {
		const resolution = resolvePanel(config, deps.coderModel);
		if (!resolution.ok) {
			// Cannot form an independent panel → BLOCKED, never a silent pass.
			panel = {
				outcome: "BLOCKED", quorum: config.panel.quorum, validVotes: 0, absent: [],
				reasons: resolution.errors, blockingFindings: [], votingFamilies: resolution.families,
			};
			l2 = panelToVerdict(panel) as unknown as ParsedVerdict;
			return escalateAndFinish({
				outcome: "blocked", l0, l1, l2, panel, risk,
				rejectionText: `L2 面板无法组成：${resolution.errors.join("; ")}`,
				summary: "L2 面板成员不足或缺乏家族独立性。",
				state: "CODE_LOOP",
			});
		}
		const l2Task = [
			"Judge ONLY whether the diff below violates the project's hard architectural constraints.",
			"Do not review logic, style or code quality (L1 already did that).",
			"You are one independent member of a cross-vendor panel; other members cannot see your output.",
			"",
			"=== CONSTRAINT CHECKLIST (cite these IDs) ===",
			deps.constraintChecklist,
			"",
			"=== L1 VERDICT (structured) ===",
			structuredProjection(l1),
			"",
			"=== DIFF ===",
			capped,
		].join("\n");
		const run = await runPanel({
			cwd: deps.cwd,
			members: resolution.members,
			systemPrompt: deps.systemPrompt("L2"),
			task: l2Task,
			quorum: config.panel.quorum,
			minDistinctFamilies: config.panel.minDistinctFamilies,
			concurrency: config.panel.concurrency,
			timeoutMs: config.panel.timeoutMs,
			thinking: config.panel.thinking,
			runChild: deps.runChild,
			onLog: log,
		});
		panel = run.aggregate;
		panelRecords = run.records;
		l2 = panelToVerdict(panel) as unknown as ParsedVerdict;
		if (panel.outcome !== "PASS") {
			return escalateAndFinish({
				outcome: "blocked", l0, l1, l2, panel, panelRecords, risk,
				rejectionText: formatFindingsForCoder(l2) || l2.summary,
				summary: `L2 面板 ${panel.outcome}。`,
				state: "CODE_LOOP",
			});
		}
	}

	/**
	 * Commit only when explicitly authorised AND graded low risk.
	 *
	 * Returns the TRUTHFUL state: recording COMMITTED without an actual commit
	 * would be a false audit record. When autoCommit is off the guard refuses
	 * before touching git, so no repository write happens at all.
	 */
	const commitIfAuthorised = async (humanApproved: boolean): Promise<{ state: string; note: string }> => {
		if (!config.autoCommit) {
			return { state: "CODE_LOOP", note: "autoCommit=false：改动保留在工作区待人工提交。" };
		}
		if (!risk) {
			return { state: "CODE_LOOP", note: "缺少确定性风险分级：不自动提交。" };
		}
		const res = await autoCommitCheckpoint({
			cwd: deps.cwd, run: deps.run, store, checkpointId,
			assessment: risk, enabled: config.autoCommit,
			humanRequired: wantHuman, humanApproved,
			message: `orch(${checkpointId}): reviewed checkpoint`,
			files: changedFiles,
		});
		if (res.outcome === "committed") {
			return { state: "COMMITTED", note: `已自动提交 ${res.commit?.slice(0, 8)}（低风险，需异步抽检）。` };
		}
		return { state: "CODE_LOOP", note: `未自动提交：${res.reason}` };
	};

	// ---- Review package (always written: it is the audit record) ----
	const gates = { l0: true, l1: true, panel: wantPanel, human: wantHuman };
	const nextAction = wantHuman
		? "等待 L3 人工决定：approve 前进 / request_changes 带证据打回 / reject 终止。"
		: config.autoCommit
			? "低风险且已授权自动提交：提交本 checkpoint 并异步抽检。"
			: "门禁通过；autoCommit=false，改动保留在工作区待人工提交。";
	const pkg = buildReviewPackage(store, {
		runId: store.runId, checkpointId, stage,
		outcome: wantHuman ? "awaiting-human" : "pass",
		attempt, maxRetries: config.limits.maxRetries,
		diff, l0, l1, l2, panel, panelRecords,
		risk: risk ? { ...risk, gates } : undefined,
		coderModel: deps.coderModel,
		nextAction,
	});

	// ---- L3: human gate ----
	if (!wantHuman) {
		const committed = await commitIfAuthorised(false);
		return escalateAndFinish({
			outcome: "pass", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
			summary: `门禁通过（L0/L1${wantPanel ? "/L2 面板" : ""}）；未要求 L3。${committed.note}`,
			state: committed.state,
		});
	}

	const gate = await requestHumanDecision({
		ui: deps.ui, store, runId: store.runId, checkpointId, stage,
		packageHash: pkg.packageHash, packageDir: pkg.dir, decidedBy: deps.decidedBy,
	});
	if (gate.status !== "decided" || !gate.record) {
		return escalateAndFinish({
			outcome: "awaiting-human", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
			summary: `已到 L3，等待人工决定。${gate.reason ?? ""}`,
			state: "AWAITING_HUMAN_REVIEW",
		});
	}

	const routed = routeDecision(gate.record, pkg.packageHash);
	if (routed.route === "advance") {
		const committed = await commitIfAuthorised(true);
		return escalateAndFinish({
			outcome: "pass", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
			humanDecision: gate.record,
			summary: `L3 已批准（${gate.record.decidedBy}）。${committed.note}`,
			state: committed.state,
		});
	}
	if (routed.route === "abort") {
		return finish({
			outcome: "aborted", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
			humanDecision: gate.record, escalations: [],
			rejectionText: gate.record.note ?? "人工拒绝本次改动。",
			summary: "L3 拒绝：本次运行终止。",
			state: "ABORTED",
		});
	}
	if (routed.route === "back-to-producer") {
		const evidence = [
			l2 && isBlocking(l2) ? formatFindingsForCoder(l2) : "",
			l1 && isBlocking(l1) ? formatFindingsForCoder(l1) : "",
			gate.record.note ? `人工说明：${gate.record.note}` : "",
		].filter(Boolean).join("\n");
		return escalateAndFinish({
			outcome: "blocked", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
			humanDecision: gate.record,
			rejectionText: evidence || "人工要求修改，但未附具体说明；请向人确认。",
			summary: "L3 要求修改：带证据回生产侧。",
			state: "CODE_LOOP",
		});
	}
	return escalateAndFinish({
		outcome: "awaiting-human", l0, l1, l2, panel, panelRecords, risk, reviewPackage: pkg,
		humanDecision: gate.record,
		summary: `L3 决定不可用：${routed.reason ?? "未知"}`,
		state: "AWAITING_HUMAN_REVIEW",
	});
}

/** Legacy outcome mapping so callers of the old 3-layer API keep working. */
export function toLegacyOutcome(o: CodeOutcome): PipelineOutcome {
	switch (o) {
		case "pass": return "pass";
		case "no-diff": return "no-diff";
		case "invalid": return "invalid";
		default: return "blocked";
	}
}
