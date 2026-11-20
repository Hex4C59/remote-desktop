// Deliverable-stage pipeline: discussion → spec → plan → task.
//
// Each stage runs its OWN deterministic floor (l0-stages), then L1 semantics,
// then (spec only) the cross-vendor panel, then a human gate. The machine, not a
// model, decides what happens next.
//
// AGENTS.md hard rule honoured here: approving a spec NEVER rewrites its
// `status:` line unless config.specStatusWrite is explicitly true, and even then
// the approver and timestamp are recorded. The default output is a decision
// record plus the exact line the human should change.

import * as fs from "node:fs";
import * as path from "node:path";
import type { OrchestratorConfig } from "./config.ts";
import type { CommandRunner } from "../checks/l0.ts";
import type { RunChildOptions, RunChildResult } from "../review/child.ts";
import { runStageL0, loadSpecs, type StageL0Result } from "../checks/l0-stages.ts";
import { parseAndValidate, formatFindingsForCoder, isBlocking, type ParsedVerdict } from "../review/verdict.ts";
import { structuredProjection } from "./orchestrator.ts";
import { resolvePanel } from "../review/panel.ts";
import { runPanel, type PanelMemberRecord } from "../review/panel-runner.ts";
import { panelToVerdict, type PanelAggregate } from "../review/aggregate.ts";
import { buildReviewPackage, type ReviewPackage } from "../evidence/package.ts";
import { requestHumanDecision, routeDecision, type HumanDecisionRecord, type HumanGateUi } from "../evidence/human.ts";
import { ArtifactStore, type Stage } from "../evidence/store.ts";
import { collectEscalations, raiseEscalations, type Escalation, type EscalationFacts } from "./escalate.ts";
import { applyEvent, type MachineEvent, type MachineSnapshot } from "./machine.ts";

export type StageOutcome =
	| "produced"          // producer emitted a draft; gates not yet run
	| "pass"              // every required gate cleared (incl. human approve)
	| "blocked"           // a gate failed; evidence goes back to the producer
	| "awaiting-human"
	| "escalated"
	| "aborted"
	| "invalid";

export interface DeliverableStageDeps {
	cwd: string;
	config: OrchestratorConfig;
	store: ArtifactStore;
	machine: MachineSnapshot;
	stage: Exclude<Stage, "code">;
	/** The deliverable text: DECISIONS.md / spec markdown / plan markdown / TASK.md. */
	document: string;
	/** Where the document lives, relative to cwd (for spec status advice). */
	documentPath?: string;
	run: CommandRunner;
	runChild: (opts: RunChildOptions) => Promise<RunChildResult>;
	/** Producer agent prompt (discussion / spec-writer / planner / task-writer). */
	producerPrompt: string;
	/** Reviewer prompts, keyed by layer. */
	reviewerPrompt: (layer: "L1" | "L2") => string;
	constraintChecklist: string;
	ui: HumanGateUi;
	coderModel?: string;
	decidedBy?: string;
	/** Restrict plan coverage to these spec stems. */
	specFilter?: string[];
	onLog?: (line: string) => void;
}

export interface DeliverableStageResult {
	outcome: StageOutcome;
	machine: MachineSnapshot;
	l0?: ParsedVerdict;
	l1?: ParsedVerdict;
	l2?: ParsedVerdict;
	panel?: PanelAggregate;
	panelRecords?: PanelMemberRecord[];
	stageL0?: StageL0Result;
	reviewPackage?: ReviewPackage;
	humanDecision?: HumanDecisionRecord;
	escalations: Escalation[];
	rejectionText: string;
	summary: string;
	/** For spec approval: the exact status line the human must change. */
	specStatusAdvice?: string;
	/** Discussion output persisted as DECISIONS.md. */
	decisionsPath?: string;
}

/** Read the current `status:` line of a spec without touching the file. */
export function readSpecStatus(cwd: string, relPath: string): { line?: string; status?: string; lineNumber?: number } {
	try {
		const lines = fs.readFileSync(path.join(cwd, relPath), "utf-8").split("\n");
		for (let i = 0; i < Math.min(lines.length, 10); i++) {
			const m = /^status:\s*(\S+)\s*$/.exec(lines[i]);
			if (m) return { line: lines[i], status: m[1], lineNumber: i + 1 };
		}
	} catch { /* unreadable */ }
	return {};
}

/**
 * The advice a human gets after approving a spec.
 *
 * We do NOT edit the file by default: specs/README.md forbids the implementer
 * from flipping draft → approved. The decision is recorded; the human applies it.
 */
export function specApprovalAdvice(
	cwd: string,
	relPath: string,
	decision: HumanDecisionRecord,
	autoWrite: boolean,
): { advice: string; wrote: boolean } {
	const current = readSpecStatus(cwd, relPath);
	const approver = `${decision.decidedBy}, ${decision.decidedAt.slice(0, 10)}`;
	const target = `status: approved\napproved-by: ${approver}`;
	if (!autoWrite) {
		return {
			advice: [
				`L3 已批准，但按 specs/README.md 不由实施者改状态。`,
				`请人工把 ${relPath}${current.lineNumber ? ` 第 ${current.lineNumber} 行` : ""} 改为：`,
				target,
				`（当前：${current.line ?? "未找到 status 行"}）`,
			].join("\n"),
			wrote: false,
		};
	}
	// Explicit opt-in: write the status AND the approver, never one without the other.
	try {
		const file = path.join(cwd, relPath);
		const lines = fs.readFileSync(file, "utf-8").split("\n");
		const idx = lines.findIndex((l) => /^status:\s*\S+\s*$/.test(l));
		if (idx < 0) return { advice: `${relPath} 没有 status 行，未改动。`, wrote: false };
		lines[idx] = "status: approved";
		if (idx + 1 < lines.length && /^approved-by:/.test(lines[idx + 1])) {
			lines[idx + 1] = `approved-by: ${approver}`;
		} else {
			lines.splice(idx + 1, 0, `approved-by: ${approver}`);
		}
		fs.writeFileSync(file, lines.join("\n"), "utf-8");
		return { advice: `已按显式授权写入 ${relPath}：${target.replace(/\n/g, " / ")}`, wrote: true };
	} catch (e) {
		return { advice: `写入失败：${(e as Error).message}`, wrote: false };
	}
}

/** Producer step: ask the stage's agent for the deliverable. */
async function produce(deps: DeliverableStageDeps): Promise<{ text?: string; error?: string }> {
	const task = [
		`Produce the ${deps.stage} deliverable for this project.`,
		deps.document.trim() ? "Context / previous draft and feedback:" : "No previous draft; start from the repo constraints.",
		deps.document,
	].join("\n\n");
	const res = await deps.runChild({
		cwd: deps.cwd,
		systemPrompt: deps.producerPrompt,
		userPrompt: task,
		// Producers are read-only: they emit text, the orchestrator places it.
		tools: ["read", "grep", "find", "ls"],
		thinking: "low",
		timeoutMs: deps.config.limits.childTimeoutMs,
	});
	if (!res.ok) return { error: res.error ?? `producer failed (exit ${res.exitCode})` };
	if (!res.assistantText.trim()) return { error: "producer returned no text" };
	return { text: res.assistantText };
}

export async function runDeliverableStage(deps: DeliverableStageDeps): Promise<DeliverableStageResult> {
	const { config, store, stage } = deps;
	const log = deps.onLog ?? (() => {});
	let machine = deps.machine;
	const stageCfg = config.stages[stage];
	// Every attempt gets its own checkpoint directory. A fixed `${stage}-${round}`
	// collided after L3 request_changes: the new package hash met the old
	// request_changes record and recordDecision refused to overwrite it, deadlocking
	// the retry. attempt/l0 counters are part of the id for the same reason.
	const checkpointId = `${stage}-${String(machine.round + 1).padStart(3, "0")}-a${machine.attempt + 1}-l${machine.l0ConsecutiveFailures}`;

	const escalateAndFinish = (
		base: Partial<DeliverableStageResult> & { outcome: StageOutcome; summary: string },
		facts: Partial<EscalationFacts> = {},
	): DeliverableStageResult => {
		const escalations = collectEscalations({
			runId: store.runId, stage, checkpointId,
			attempt: machine.attempt, maxRetries: config.limits.maxRetries,
			l0ConsecutiveFailures: machine.l0ConsecutiveFailures,
			maxL0ConsecutiveFailures: config.limits.maxL0ConsecutiveFailures,
			l0: base.l0, l1: base.l1, l2: base.l2, panel: base.panel, panelRecords: base.panelRecords,
			...facts,
		});
		if (escalations.length > 0) {
			raiseEscalations({ store, notify: deps.ui.notify }, escalations);
			const moved = applyEvent(machine, "escalate");
			if (moved.ok) machine = moved.snapshot;
		}
		const outcome: StageOutcome = escalations.length > 0 && base.outcome !== "aborted" ? "escalated" : base.outcome;
		// Persist machine state AND the review facts. Saving only the snapshot would
		// drop packageHash, and /orch approve could then not find the package the
		// human is supposed to decide on.
		store.saveState({
			...machine,
			outcome,
			checkpointId,
			packageHash: base.reviewPackage?.packageHash ?? null,
			layers: {
				l0: base.l0?.verdict ?? null,
				l1: base.l1?.verdict ?? null,
				l2: base.l2?.verdict ?? null,
				panel: base.panel?.outcome ?? null,
			},
			humanDecision: base.humanDecision?.decision ?? null,
			escalations: escalations.map((e) => e.reason),
		});
		return {
			...base, outcome, machine, escalations,
			rejectionText: base.rejectionText ?? "",
			summary: escalations.length > 0
				? `${base.summary}\n需人工裁决：${escalations.map((e) => e.reason).join(", ")}`
				: base.summary,
		};
	};

	const advance = (event: MachineEvent): boolean => {
		const r = applyEvent(machine, event, { checkpointId });
		if (!r.ok) {
			log(`[machine] rejected ${machine.state} + ${event}: ${r.error}`);
			return false;
		}
		machine = r.snapshot;
		return true;
	};

	// ---- producer ----
	let document = deps.document;
	if (!document.trim()) {
		log(`[${stage}] producer drafting`);
		const produced = await produce(deps);
		if (!produced.text) {
			return escalateAndFinish({
				outcome: "invalid",
				rejectionText: `生产侧未产出 ${stage} 交付物：${produced.error}`,
				summary: `${stage} 生产失败。`,
			});
		}
		document = produced.text;
	}

	// Persist the deliverable itself as evidence.
	const docName = stage === "discussion" ? "DECISIONS.md"
		: stage === "spec" ? "spec.md"
		: stage === "plan" ? "plan.md" : "TASK.md";
	const docRel = stage === "discussion" ? store.decisionsPath() : store.stageFile(stage, docName);
	store.writeText(docRel, document.endsWith("\n") ? document : document + "\n");

	if (stage === "discussion") {
		// Evaluate the conflict BEFORE advancing: once `decided` fires the machine
		// is in SPEC_DRAFT and `escalate` would preserve the wrong stage, sending a
		// human ruling to the spec producer instead of back to discussion.
		const conflict = /需求矛盾[\s\S]{0,40}(互斥|无法同时|不能同时|冲突)/.test(document);
		if (conflict) {
			return escalateAndFinish(
				{ outcome: "blocked", summary: "讨论发现根本需求矛盾。", decisionsPath: docRel },
				{ requirementConflict: { detail: "讨论文档标注了互斥需求，需人裁决取舍。" } },
			);
		}
		advance("decided");
		return escalateAndFinish({
			outcome: "pass",
			summary: `讨论完成，已写 ${docRel}。`,
			decisionsPath: docRel,
		});
	}

	// ---- stage L0 ----
	if (stage === "spec" || stage === "plan") advance("draft-ready");
	log(`[${stage}] L0 (${stageCfg.l0})`);
	const stageL0 = await runStageL0({
		cwd: deps.cwd, run: deps.run, kind: stageCfg.l0,
		specs: stage === "plan" ? loadSpecs(deps.cwd) : undefined,
		planText: stage === "plan" ? document : undefined,
		specFilter: deps.specFilter,
		taskFile: stage === "task" ? store.resolve(docRel) : undefined,
		onLog: log,
	});
	const l0 = stageL0.verdict;
	if (stageL0.coverageMarkdown) {
		store.writeText(store.stageFile(stage, "coverage-matrix.md"), stageL0.coverageMarkdown);
	}
	if (stageL0.coverage) {
		store.writeJson(store.stageFile(stage, "coverage-matrix.json"), stageL0.coverage);
	}
	store.writeJson(store.stageFile(stage, "l0-results.json"), l0);

	if (isBlocking(l0)) {
		advance("l0-red");
		return escalateAndFinish({
			outcome: "blocked", l0, stageL0,
			rejectionText: formatFindingsForCoder(l0) || l0.summary,
			summary: `${stage} L0 未通过；未进入 L1。`,
		});
	}
	// TASK_LOOP validates TASK.md in place: it has no draft/L0/L1 sub-states, so
	// only spec/plan drive those edges. Advancing a non-existent edge would be
	// rejected and logged as noise on every task run.
	const hasSubStates = stage === "spec" || stage === "plan";
	if (hasSubStates) advance("l0-pass");

	// Declared at function scope: every verdict must reach the review package and
	// the escalation facts, not just the branch that produced it.
	let l1: ParsedVerdict | undefined;
	let l2: ParsedVerdict | undefined;
	let panel: PanelAggregate | undefined;
	let panelRecords: PanelMemberRecord[] | undefined;

	// ---- L1 semantics ----
	if (!stageCfg.l1) {
		if (hasSubStates) advance("l1-pass");
	} else {
		const l1Task = [
			`Review this ${stage} deliverable for correctness, completeness and consistency with the project's contracts.`,
			"L0 already passed its deterministic checks — do not re-check those.",
			"Cite file:line for claims about repo files; for the deliverable itself cite its section and quote the offending text.",
			"",
			"=== L0 VERDICT (structured) ===",
			structuredProjection(l0),
			"",
			`=== ${stage.toUpperCase()} DOCUMENT ===`,
			document.slice(0, config.limits.diffCap),
		].join("\n");
		let errors: string[] = [];
		for (let i = 1; i <= 2; i++) {
			log(`[${stage}] L1 attempt ${i}`);
			const res = await deps.runChild({
				cwd: deps.cwd,
				systemPrompt: deps.reviewerPrompt("L1"),
				userPrompt: i === 1 ? l1Task : `${l1Task}\n\n[OUTPUT ERROR] Not valid verdict JSON (${errors.join("; ")}). Reply with ONLY the verdict JSON.`,
				tools: ["read", "grep", "find", "ls"],
				thinking: "low",
				timeoutMs: config.limits.childTimeoutMs,
			});
			if (!res.ok) { errors = [res.error ?? `exit ${res.exitCode}`]; continue; }
			const v = parseAndValidate(res.assistantText, "L1");
			if (v.ok && v.verdict) { l1 = v.verdict; errors = []; break; }
			errors = v.errors;
		}
		if (!l1) {
			return escalateAndFinish({
				outcome: "invalid", l0, stageL0,
				rejectionText: `L1 裁决不合规：${errors.join("; ")}`,
				summary: `${stage} L1 未产出合法 verdict。`,
			});
		}
		store.writeJson(store.stageFile(stage, "l1-findings.json"), l1);
		if (isBlocking(l1)) {
			advance("l1-blocker"); // legal for spec/plan AND the TASK_LOOP self-loop
			return escalateAndFinish({
				outcome: "blocked", l0, l1, stageL0,
				rejectionText: formatFindingsForCoder(l1) || l1.summary,
				summary: `${stage} L1 发现问题（${l1.findings.length} 项）。`,
			});
		}
		if (hasSubStates) advance("l1-pass");
	}

	// ---- L2 panel (spec only by default) ----
	// This must NOT be nested inside the L1 branch: with `stages.spec.l1=false`
	// the panel and the `l2-*` transition were skipped, so L3 approved while the
	// machine was still parked at SPEC_L2. Gates are configured independently.
	if (stageCfg.panel === true) {
		if (stage !== "spec") {
			return escalateAndFinish({
				outcome: "invalid", l0, l1, stageL0,
				rejectionText: `L2 面板只支持 spec 阶段；${stage} 没有 L2 子状态`,
				summary: `${stage} 配置非法：panel=true 只可用于 spec/code。`,
			});
		}
		const resolution = resolvePanel(config, deps.coderModel);
		if (!resolution.ok) {
			panel = {
				outcome: "BLOCKED", quorum: config.panel.quorum, validVotes: 0, absent: [],
				reasons: resolution.errors, blockingFindings: [], votingFamilies: resolution.families,
			};
			l2 = panelToVerdict(panel) as unknown as ParsedVerdict;
			advance("l2-fail");
			return escalateAndFinish({
				outcome: "blocked", l0, l1, l2, panel, stageL0,
				rejectionText: `L2 面板无法组成：${resolution.errors.join("; ")}`,
				summary: `${stage} L2 面板成员不足或缺乏家族独立性。`,
			});
		}
		const l2Task = [
			`Judge ONLY whether this ${stage} deliverable violates the project's hard architectural constraints.`,
			"You are one independent member of a cross-vendor panel.",
			"",
			"=== CONSTRAINT CHECKLIST (cite these IDs) ===",
			deps.constraintChecklist,
			"",
			"=== L1 VERDICT (structured) ===",
			l1 ? structuredProjection(l1) : "(L1 未启用：不要假定语义审查已通过，只判断硬约束)",
			"",
			`=== ${stage.toUpperCase()} DOCUMENT ===`,
			document.slice(0, config.limits.diffCap),
		].join("\n");
		const run = await runPanel({
			cwd: deps.cwd, members: resolution.members,
			systemPrompt: deps.reviewerPrompt("L2"), task: l2Task,
			quorum: config.panel.quorum, minDistinctFamilies: config.panel.minDistinctFamilies,
			concurrency: config.panel.concurrency, timeoutMs: config.panel.timeoutMs,
			thinking: config.panel.thinking, runChild: deps.runChild, onLog: log,
		});
		panel = run.aggregate;
		panelRecords = run.records;
		l2 = panelToVerdict(panel) as unknown as ParsedVerdict;
		store.writeJson(store.stageFile(stage, "l2-verdict.json"), l2);
		store.writeJson(store.stageFile(stage, "l2-panel.json"), panel);
		if (panel.outcome !== "PASS") {
			advance("l2-fail");
			return escalateAndFinish({
				outcome: "blocked", l0, l1, l2, panel, panelRecords, stageL0,
				rejectionText: formatFindingsForCoder(l2) || l2.summary,
				summary: `${stage} L2 面板 ${panel.outcome}。`,
			});
		}
		advance("l2-pass");
	} else if (stage === "spec") {
		advance("l2-skipped");
	}

	// ---- review package ----
	const wantHuman = stageCfg.human === true;
	const pkg = buildReviewPackage(store, {
		runId: store.runId, checkpointId, stage,
		outcome: wantHuman ? "awaiting-human" : "pass",
		attempt: machine.attempt, maxRetries: config.limits.maxRetries,
		diff: document, l0, l1, l2, panel, panelRecords,
		nextAction: wantHuman ? "等待 L3 人工决定。" : "门禁通过，进入下一阶段。",
		coderModel: deps.coderModel,
	});

	if (!wantHuman) {
		if (stage === "task") advance("task-ready");
		return escalateAndFinish({
			outcome: "pass", l0, l1, l2, panel, panelRecords, stageL0, reviewPackage: pkg,
			summary: `${stage} 门禁通过。`,
		});
	}

	const gate = await requestHumanDecision({
		ui: deps.ui, store, runId: store.runId, checkpointId, stage,
		packageHash: pkg.packageHash, packageDir: pkg.dir, decidedBy: deps.decidedBy,
	});
	if (gate.status !== "decided" || !gate.record) {
		return escalateAndFinish({
			outcome: "awaiting-human", l0, l1, l2, panel, panelRecords, stageL0, reviewPackage: pkg,
			summary: `${stage} 已到 L3，等待人工决定。${gate.reason ?? ""}`,
		});
	}
	const routed = routeDecision(gate.record, pkg.packageHash);
	if (routed.route === "advance") {
		advance("human-approve");
		let advice: string | undefined;
		if (stage === "spec" && deps.documentPath) {
			advice = specApprovalAdvice(deps.cwd, deps.documentPath, gate.record, config.specStatusWrite).advice;
			store.writeText(store.stageFile("spec", "status-advice.md"), advice + "\n");
		}
		return escalateAndFinish({
			outcome: "pass", l0, l1, l2, panel, panelRecords, stageL0, reviewPackage: pkg, humanDecision: gate.record,
			specStatusAdvice: advice,
			summary: `${stage} L3 已批准（${gate.record.decidedBy}）。`,
		});
	}
	if (routed.route === "abort") {
		advance("human-reject");
		store.saveState({
			...machine, outcome: "aborted", checkpointId,
			packageHash: pkg.packageHash,
			humanDecision: gate.record.decision,
		});
		return {
			outcome: "aborted", machine, l0, l1, l2, panel, panelRecords, stageL0, reviewPackage: pkg,
			humanDecision: gate.record, escalations: [],
			rejectionText: gate.record.note ?? "人工拒绝。",
			summary: `${stage} L3 拒绝：终止。`,
		};
	}
	advance("human-changes");
	return escalateAndFinish({
		outcome: "blocked", l0, l1, l2, panel, panelRecords, stageL0, reviewPackage: pkg, humanDecision: gate.record,
		rejectionText: gate.record.note ?? "人工要求修改，未附说明。",
		summary: `${stage} L3 要求修改。`,
	});
}
