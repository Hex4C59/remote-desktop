// Escalation monitor — the machine notices trouble, not the reviewing model.
//
// Blueprint: eight triggers must reach a human. Relying on a review agent to
// volunteer "something is wrong" is exactly the failure mode this replaces, so
// each trigger is a deterministic predicate over recorded facts.
//
// Every escalation is written to escalations/<timestamp>-<reason>.json with the
// evidence that fired it, so the human can act without re-reading the session.

import type { ArtifactStore } from "./store.ts";
import type { ParsedVerdict } from "./verdict.ts";
import type { PanelAggregate } from "./aggregate.ts";
import type { PanelMemberRecord } from "./panel-runner.ts";

export type EscalationReason =
	| "l0-consecutive-red"
	| "l1-self-contradiction"
	| "l0-l2-conflict"
	| "forbidden-path"
	| "timeout"
	| "retry-limit"
	| "panel-unaggregatable"
	| "requirement-conflict";

export const ESCALATION_REASONS: EscalationReason[] = [
	"l0-consecutive-red",
	"l1-self-contradiction",
	"l0-l2-conflict",
	"forbidden-path",
	"timeout",
	"retry-limit",
	"panel-unaggregatable",
	"requirement-conflict",
];

export interface Escalation {
	reason: EscalationReason;
	at: string;
	runId: string;
	stage: string;
	checkpointId?: string;
	/** One-line human-facing statement of what went wrong. */
	detail: string;
	/** Structured facts that fired the trigger. */
	evidence: Record<string, unknown>;
	/** Concrete options for the human; never "try harder". */
	suggestedActions: string[];
}

/** Constraint IDs that L0's ctest already decides mechanically. */
const L0_COVERED_IDS = /\b(?:DEP-0[1-5]|THREAD-0[12])\b|\bspec\.structure\b/;

export interface EscalationFacts {
	runId: string;
	stage: string;
	checkpointId?: string;
	/** Consecutive L0 failures observed for this checkpoint. */
	l0ConsecutiveFailures?: number;
	maxL0ConsecutiveFailures?: number;
	l0?: ParsedVerdict;
	l1?: ParsedVerdict;
	l2?: ParsedVerdict;
	panel?: PanelAggregate;
	panelRecords?: PanelMemberRecord[];
	changedFiles?: string[];
	forbiddenPaths?: string[];
	attempt?: number;
	maxRetries?: number;
	/** Discussion/spec reported mutually exclusive requirements. */
	requirementConflict?: { detail: string; sides?: string[] };
	/** A reviewer child (not a panel member) timed out; carries its error text. */
	evidenceTimeout?: string;
	now?: Date;
}

function base(facts: EscalationFacts, reason: EscalationReason, detail: string, evidence: Record<string, unknown>, suggestedActions: string[]): Escalation {
	return {
		reason,
		at: (facts.now ?? new Date()).toISOString(),
		runId: facts.runId,
		stage: facts.stage,
		checkpointId: facts.checkpointId,
		detail,
		evidence,
		suggestedActions,
	};
}

// ---------------------------------------------------------------- detectors

export function detectL0ConsecutiveRed(f: EscalationFacts): Escalation | undefined {
	const n = f.l0ConsecutiveFailures ?? 0;
	const max = f.maxL0ConsecutiveFailures ?? 2;
	if (n < max) return undefined;
	return base(f, "l0-consecutive-red",
		`L0 确定性门禁连续 ${n} 次失败（上限 ${max}）：不是审查问题，是实现或环境问题。`,
		{ consecutiveFailures: n, max, checks: f.l0?.checks ?? [] },
		["人工检查构建/测试环境或任务本身是否可行", "修正任务描述后重跑", "终止本次运行"]);
}

export function detectL1SelfContradiction(f: EscalationFacts): Escalation | undefined {
	const v = f.l1;
	if (!v) return undefined;
	const problems: string[] = [];
	// A pass verdict carrying blocking findings contradicts itself.
	const blocking = v.findings.filter((x) => !x.uncertain && (x.severity === "critical" || x.severity === "warning"));
	if (v.verdict === "pass" && blocking.length > 0) {
		problems.push(`verdict=pass 但含 ${blocking.length} 条 critical/warning findings`);
	}
	// Schema says uncertainty must be a suggestion; a critical+uncertain finding
	// asserts a blocker while admitting it is unsure.
	const uncertainBlockers = v.findings.filter((x) => x.uncertain && (x.severity === "critical" || x.severity === "warning"));
	if (uncertainBlockers.length > 0) {
		problems.push(`${uncertainBlockers.length} 条 finding 同时标 uncertain 与 critical/warning`);
	}
	// Same location reported twice with different conclusions.
	const byLoc = new Map<string, Set<string>>();
	for (const x of v.findings) {
		const loc = `${x.file}:${x.line ?? "-"}`;
		if (!byLoc.has(loc)) byLoc.set(loc, new Set());
		byLoc.get(loc)!.add(String(x.severity ?? "?"));
	}
	const ambiguous = [...byLoc.entries()].filter(([, sevs]) => sevs.has("suggestion") && (sevs.has("critical") || sevs.has("warning")));
	if (ambiguous.length > 0) {
		problems.push(`同一位置给出互相矛盾的严重度: ${ambiguous.map(([loc]) => loc).join(", ")}`);
	}
	if (problems.length === 0) return undefined;
	return base(f, "l1-self-contradiction",
		`L1 裁决自相矛盾：${problems.join("；")}`,
		{ problems, verdict: v.verdict, findings: v.findings },
		["人工判断该 finding 是否成立", "要求 L1 重审并给出一致裁决", "调整 reviewer prompt 后重跑"]);
}

export function detectL0L2Conflict(f: EscalationFacts): Escalation | undefined {
	const l0 = f.l0;
	const l2 = f.l2;
	if (!l0 || !l2) return undefined;
	if (l0.verdict !== "pass") return undefined; // L0 red is not a conflict
	const gateChecks = (l0.checks ?? []).filter((c) => c.exit_code === 0);
	const l0SaysGreen = gateChecks.length > 0;
	if (!l0SaysGreen) return undefined;
	const conflicts = l2.findings.filter((x) => L0_COVERED_IDS.test(String(x.evidence ?? "")));
	if (conflicts.length === 0) return undefined;
	return base(f, "l0-l2-conflict",
		`L0 与 L2 结论冲突：确定性检查通过，但 L2 报告了 L0 已机械覆盖的约束违反（${conflicts.length} 条）。`,
		{
			l0Checks: gateChecks.map((c) => ({ name: c.name, exit_code: c.exit_code })),
			l2Findings: conflicts.map((x) => ({ file: x.file, line: x.line, evidence: x.evidence })),
		},
		["人工核对：可能是静态扫描漏检，或 L2 误报", "若确为漏检，补强 tools/check_layers.py", "若为误报，修正 L2 约束清单"]);
}

export function detectForbiddenPath(f: EscalationFacts): Escalation | undefined {
	const files = f.changedFiles ?? [];
	const forbidden = f.forbiddenPaths ?? [];
	if (files.length === 0 || forbidden.length === 0) return undefined;
	const hits = files.filter((file) => forbidden.some((p) => file.startsWith(p) || file.includes(`/${p}`)));
	if (hits.length === 0) return undefined;
	return base(f, "forbidden-path",
		`改动命中禁止路径（${hits.length} 个文件）：不得自动放行。`,
		{ hits, forbiddenPaths: forbidden },
		["人工确认该改动是否被授权", "回退越界改动", "显式调整禁止路径配置后重跑"]);
}

export function detectTimeout(f: EscalationFacts): Escalation | undefined {
	const timedOut = (f.panelRecords ?? []).filter((r) => !r.ok && /timed out/i.test(r.error ?? ""));
	const childTimeout = /timed out/i.test(String(f.evidenceTimeout ?? ""));
	if (timedOut.length === 0 && !childTimeout) return undefined;
	return base(f, "timeout",
		`审查超时：${timedOut.length} 个面板成员超时${childTimeout ? "，审查子进程超时" : ""}。`,
		{ members: timedOut.map((r) => ({ model: r.model, family: r.family, error: r.error, durationMs: r.durationMs })) },
		["提高 panel.timeoutMs 或减少成员", "改用更快的模型", "人工直接审查"]);
}

export function detectRetryLimit(f: EscalationFacts): Escalation | undefined {
	const attempt = f.attempt ?? 0;
	const max = f.maxRetries ?? 2;
	if (attempt <= max) return undefined;
	return base(f, "retry-limit",
		`打回次数超限（第 ${attempt} 轮，上限 ${max}）：自动修复未能收敛。`,
		{ attempt, max },
		["人工介入修复", "缩小任务范围后重跑", "终止本次运行"]);
}

export function detectPanelUnaggregatable(f: EscalationFacts): Escalation | undefined {
	const p = f.panel;
	if (!p || p.outcome !== "BLOCKED") return undefined;
	return base(f, "panel-unaggregatable",
		`L2 面板无法聚合（BLOCKED）：有效票 ${p.validVotes}/法定 ${p.quorum}，家族 ${p.votingFamilies.join(", ") || "无"}。不得静默放行。`,
		{
			outcome: p.outcome, quorum: p.quorum, validVotes: p.validVotes,
			families: p.votingFamilies, reasons: p.reasons,
			absent: p.absent.map((a) => ({ model: a.model, family: a.family, reason: a.failureReason })),
		},
		["恢复不可用成员的模型访问（如 403）", "补充其他家族成员以满足法定人数与独立性", "人工直接审查后决定放行"]);
}

export function detectRequirementConflict(f: EscalationFacts): Escalation | undefined {
	const rc = f.requirementConflict;
	if (!rc?.detail?.trim()) return undefined;
	return base(f, "requirement-conflict",
		`需求/方案存在根本矛盾：${rc.detail}`,
		{ detail: rc.detail, sides: rc.sides ?? [] },
		["人工裁决取舍并写入 DECISIONS.md", "拆分为互不冲突的两个规格", "终止本次运行"]);
}

const DETECTORS: Array<(f: EscalationFacts) => Escalation | undefined> = [
	detectL0ConsecutiveRed,
	detectL1SelfContradiction,
	detectL0L2Conflict,
	detectForbiddenPath,
	detectTimeout,
	detectRetryLimit,
	detectPanelUnaggregatable,
	detectRequirementConflict,
];

/** Run every detector. Order is stable so artifacts are reproducible. */
export function collectEscalations(facts: EscalationFacts): Escalation[] {
	const out: Escalation[] = [];
	for (const d of DETECTORS) {
		const e = d(facts);
		if (e) out.push(e);
	}
	return out;
}

export interface EscalationSink {
	store: ArtifactStore;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** Persist escalations and tell the human. Returns the written relative paths. */
export function raiseEscalations(sink: EscalationSink, escalations: Escalation[]): string[] {
	const paths: string[] = [];
	for (const e of escalations) {
		const rel = sink.store.escalationFile(e.reason, new Date(e.at));
		sink.store.writeJson(rel, e);
		paths.push(rel);
		sink.notify?.(
			`[升级:${e.reason}] ${e.detail}\n证据: ${rel}\n可选处置: ${e.suggestedActions.join(" / ")}`,
			"error",
		);
	}
	return paths;
}

/** Convenience: detect + persist + notify in one call. */
export function monitorAndEscalate(sink: EscalationSink, facts: EscalationFacts): { escalations: Escalation[]; paths: string[] } {
	const escalations = collectEscalations(facts);
	const paths = raiseEscalations(sink, escalations);
	return { escalations, paths };
}

/** True when the machine must stop and hand control to a human. */
export function requiresHuman(escalations: Escalation[]): boolean {
	return escalations.length > 0;
}
