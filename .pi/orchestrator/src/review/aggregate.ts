// Deterministic L2 panel aggregation — pure, no LLM, no I/O.
//
// Blueprint rule: the panel verdict is computed by a SCRIPT, never by asking a
// model to "summarise the panel". Three outcomes only:
//   PASS    — quorum reached and every valid vote passed
//   FAIL    — at least one valid vote failed (a single blocker blocks)
//   BLOCKED — quorum not reached, or votes are mutually contradictory
//
// BLOCKED must escalate to a human. It must NEVER be silently treated as a pass:
// "we could not decide" is not "it is fine".

import type { ParsedVerdict } from "./verdict.ts";

export type PanelOutcome = "PASS" | "FAIL" | "BLOCKED";

/** One member's participation record. */
export interface PanelVote {
	model: string;
	family: string;
	/** True when the member produced a schema-valid verdict. */
	valid: boolean;
	/** Present only when valid. */
	verdict?: ParsedVerdict;
	/** Why the member is absent: timeout / model error / malformed verdict. */
	failureReason?: string;
}

export interface PanelAggregate {
	outcome: PanelOutcome;
	quorum: number;
	validVotes: number;
	absent: PanelVote[];
	/** Human-readable, deterministic reasons for the outcome. */
	reasons: string[];
	/** Findings merged from failing members, deduped by file:line:evidence. */
	blockingFindings: PanelBlocker[];
	/** Distinct families that actually voted (independence evidence). */
	votingFamilies: string[];
}

export interface PanelBlocker {
	model: string;
	family: string;
	severity?: string;
	file: string;
	line?: number;
	evidence: string;
	required_fix?: string;
	failing_test?: string;
}

/** A verdict blocks when it fails, or carries a critical/warning finding. */
function voteBlocks(v: ParsedVerdict): boolean {
	if (v.verdict === "fail") return true;
	return v.findings.some((f) => f.severity === "critical" || f.severity === "warning");
}

/** Suggestions and uncertain items never block, but are still reported. */
function blockingFindingsOf(v: ParsedVerdict): ParsedVerdict["findings"] {
	return v.findings.filter((f) => f.severity === "critical" || f.severity === "warning" || v.verdict === "fail");
}

/**
 * Aggregate panel votes.
 *
 * `requiredFamilies` (optional) enforces cross-vendor independence: if the votes
 * that reached quorum all come from one family, the panel is BLOCKED even if
 * every vote passed — a same-vendor echo is not an independent review.
 */
export function aggregatePanel(
	votes: PanelVote[],
	quorum: number,
	options?: { minDistinctFamilies?: number },
): PanelAggregate {
	const reasons: string[] = [];
	const valid = votes.filter((v) => v.valid && v.verdict);
	const absent = votes.filter((v) => !v.valid || !v.verdict);
	const votingFamilies = [...new Set(valid.map((v) => v.family))];

	for (const a of absent) {
		reasons.push(`absent: ${a.model} (${a.family}) — ${a.failureReason ?? "no valid verdict"}`);
	}

	const blockers: PanelBlocker[] = [];
	const seen = new Set<string>();
	let failCount = 0;
	let passCount = 0;
	for (const v of valid) {
		const verdict = v.verdict!;
		if (voteBlocks(verdict)) {
			failCount++;
			for (const f of blockingFindingsOf(verdict)) {
				const key = `${f.file}:${f.line ?? "-"}:${String(f.evidence).trim()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				blockers.push({
					model: v.model,
					family: v.family,
					severity: f.severity,
					file: f.file,
					line: f.line,
					evidence: String(f.evidence),
					required_fix: f.required_fix,
					failing_test: f.failing_test,
				});
			}
		} else {
			passCount++;
		}
	}

	// Quorum first: without enough independent votes nothing can be concluded.
	if (valid.length < quorum) {
		reasons.push(`quorum not reached: ${valid.length} valid vote(s) < required ${quorum}`);
		return { outcome: "BLOCKED", quorum, validVotes: valid.length, absent, reasons, blockingFindings: blockers, votingFamilies };
	}

	const minFamilies = options?.minDistinctFamilies ?? 1;
	if (votingFamilies.length < minFamilies) {
		reasons.push(
			`insufficient vendor independence: ${votingFamilies.length} distinct family(ies) < required ${minFamilies}` +
			` (voted: ${votingFamilies.join(", ") || "none"})`,
		);
		return { outcome: "BLOCKED", quorum, validVotes: valid.length, absent, reasons, blockingFindings: blockers, votingFamilies };
	}

	// A single blocker blocks — do not average opinions away.
	if (failCount > 0) {
		reasons.push(`${failCount} member(s) reported blocking findings; ${passCount} passed`);
		return { outcome: "FAIL", quorum, validVotes: valid.length, absent, reasons, blockingFindings: blockers, votingFamilies };
	}

	// Contradiction: some members fail while others pass on the SAME finding
	// location with opposite conclusions. With quorum met and no blockers this
	// cannot happen, but a split on a shared location is still worth flagging.
	const split = findContradictions(valid);
	if (split.length > 0) {
		for (const s of split) reasons.push(`contradictory verdicts on ${s}`);
		return { outcome: "BLOCKED", quorum, validVotes: valid.length, absent, reasons, blockingFindings: blockers, votingFamilies };
	}

	reasons.push(`all ${valid.length} valid votes passed across ${votingFamilies.length} family(ies)`);
	return { outcome: "PASS", quorum, validVotes: valid.length, absent, reasons, blockingFindings: [], votingFamilies };
}

/**
 * Locations where one member asserts a violation and another explicitly clears
 * the same location. Returns "file:line" strings.
 */
function findContradictions(valid: PanelVote[]): string[] {
	const flagged = new Map<string, Set<string>>();
	for (const v of valid) {
		for (const f of v.verdict!.findings) {
			if (f.severity !== "critical" && f.severity !== "warning") continue;
			const loc = `${f.file}:${f.line ?? "-"}`;
			if (!flagged.has(loc)) flagged.set(loc, new Set());
			flagged.get(loc)!.add(v.model);
		}
	}
	const out: string[] = [];
	for (const [loc, models] of flagged) {
		const clearers = valid.filter(
			(v) => !models.has(v.model) && v.verdict!.verdict === "pass" &&
				v.verdict!.findings.every((f) => `${f.file}:${f.line ?? "-"}` !== loc),
		);
		if (models.size > 0 && clearers.length > 0) out.push(loc);
	}
	return out;
}

/** Render the aggregate as the structured L2 verdict handed to the next stage. */
export function panelToVerdict(agg: PanelAggregate): {
	layer: "L2";
	verdict: "pass" | "fail";
	findings: any[];
	summary: string;
	panel: { outcome: PanelOutcome; quorum: number; validVotes: number; families: string[]; reasons: string[] };
} {
	// BLOCKED is NOT a pass. It is surfaced as a fail carrying an explicit
	// "needs human decision" finding so the pipeline stops instead of proceeding.
	const blocked = agg.outcome === "BLOCKED";
	const findings = blocked
		? [{
				severity: "critical",
				file: "panel",
				evidence: `PANEL-BLOCKED: ${agg.reasons.join("; ")}`,
				required_fix: "人工裁决：补齐面板成员/恢复模型访问，或由人直接审查后决定放行。",
				uncertain: true,
			}]
		: agg.blockingFindings.map((b) => ({
				severity: b.severity ?? "warning",
				file: b.file,
				...(b.line ? { line: b.line } : {}),
				evidence: `[${b.family}] ${b.evidence}`,
				...(b.required_fix ? { required_fix: b.required_fix } : {}),
				...(b.failing_test ? { failing_test: b.failing_test } : {}),
			}));

	return {
		layer: "L2",
		verdict: agg.outcome === "PASS" ? "pass" : "fail",
		findings,
		summary:
			`L2 面板 ${agg.outcome}：有效票 ${agg.validVotes}/${agg.quorum}（法定），` +
			`家族 ${agg.votingFamilies.join(", ") || "无"}，缺席 ${agg.absent.length}。${agg.reasons.join("；")}`,
		panel: {
			outcome: agg.outcome,
			quorum: agg.quorum,
			validVotes: agg.validVotes,
			families: agg.votingFamilies,
			reasons: agg.reasons,
		},
	};
}
