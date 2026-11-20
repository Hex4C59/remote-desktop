// Deterministic risk grading (blueprint: 风险分级规则).
//
// The level decides which gates run (L2 panel / L3 human) and whether a low-risk
// checkpoint may be auto-committed. It MUST NOT be a model's opinion: the same
// diff must always grade the same way, and the reasons must be auditable.
//
// Pure module: no I/O, no Pi imports.

import type { RiskConfig, RiskLevel } from "./config.ts";

export interface RiskInput {
	diff: string;
	changedFiles: string[];
	changedLines: number;
}

export interface RiskAssessment {
	level: RiskLevel;
	/** Deterministic, human-readable reasons; each names the rule that fired. */
	reasons: string[];
	/** Files hitting a forbidden path. Non-empty ⇒ never auto-release. */
	forbiddenHits: string[];
	changedFiles: string[];
	changedLines: number;
	/** Which rule set the final level, for audit. */
	decidedBy: string;
}

/** Normalise a path for prefix matching (windows separators, leading ./). */
function norm(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * True when `file` is inside `prefix` (directory prefix or exact file).
 *
 * A trailing slash on the prefix is optional: "src/platform" and "src/platform/"
 * behave identically. A path equal to the bare prefix also matches — for risk
 * grading the safe direction is to over-match, because missing a platform path
 * would grade the change low and skip the panel and L3.
 *
 * Sibling directories must NOT match: "src/platformish/a.cpp" is outside
 * "src/platform/".
 */
export function pathMatches(file: string, prefix: string): boolean {
	const f = norm(file);
	const bare = norm(prefix).replace(/\/+$/, "");
	if (!bare) return false;
	return f === bare || f.startsWith(`${bare}/`);
}

/**
 * Only the changed content lines, not diff headers. Scanning headers would let a
 * filename like `docs/security.md` trip the security rule without any code change.
 */
export function changedContentLines(diff: string): string[] {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+") || line.startsWith("-")) out.push(line.slice(1));
	}
	return out;
}

/**
 * Grade a change. Order is deliberate: the strongest rule wins, and forbidden
 * paths are reported separately so the escalation monitor can always fire.
 */
export function assessRisk(rules: RiskConfig, input: RiskInput): RiskAssessment {
	const changedFiles = input.changedFiles.map(norm).filter(Boolean);
	const reasons: string[] = [];

	const forbiddenHits = changedFiles.filter((f) => rules.forbiddenPaths.some((p) => pathMatches(f, p)));
	const highPathHits = changedFiles.filter((f) => rules.highPaths.some((p) => pathMatches(f, p)));
	const mediumPathHits = changedFiles.filter((f) => rules.mediumPaths.some((p) => pathMatches(f, p)));

	const content = changedContentLines(input.diff);
	const securityHits: Array<{ pattern: string; sample: string }> = [];
	for (const pattern of rules.securityPatterns) {
		const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		const hit = content.find((l) => re.test(l));
		if (hit !== undefined) {
			securityHits.push({ pattern, sample: hit.trim().slice(0, 100) });
		}
	}

	if (forbiddenHits.length > 0) {
		reasons.push(`命中禁止路径（${forbiddenHits.length} 个文件）：${forbiddenHits.join(", ")}`);
	}
	if (highPathHits.length > 0) {
		reasons.push(`改动高风险路径：${highPathHits.join(", ")}`);
	}
	if (securityHits.length > 0) {
		reasons.push(
			`改动内容命中安全/注入关键字：${securityHits.map((h) => `${h.pattern}（例：${h.sample}）`).join("；")}`,
		);
	}
	if (input.changedLines > rules.highLines) {
		reasons.push(`改动 ${input.changedLines} 行 > 高风险阈值 ${rules.highLines}`);
	}
	if (mediumPathHits.length > 0) {
		reasons.push(`改动中风险路径：${mediumPathHits.join(", ")}`);
	}
	if (input.changedLines >= rules.mediumLines && input.changedLines <= rules.highLines) {
		reasons.push(`改动 ${input.changedLines} 行 ≥ 中风险阈值 ${rules.mediumLines}`);
	}

	let level: RiskLevel = "low";
	let decidedBy = "default-low";
	if (forbiddenHits.length > 0) {
		level = "high";
		decidedBy = "forbidden-path";
	} else if (highPathHits.length > 0) {
		level = "high";
		decidedBy = "high-path";
	} else if (securityHits.length > 0) {
		level = "high";
		decidedBy = "security-pattern";
	} else if (input.changedLines > rules.highLines) {
		level = "high";
		decidedBy = "line-count-high";
	} else if (mediumPathHits.length > 0) {
		level = "medium";
		decidedBy = "medium-path";
	} else if (input.changedLines >= rules.mediumLines) {
		level = "medium";
		decidedBy = "line-count-medium";
	}

	if (reasons.length === 0) {
		reasons.push(`未命中任何升级规则（${changedFiles.length} 个文件 / ${input.changedLines} 行）`);
	}

	return { level, reasons, forbiddenHits, changedFiles, changedLines: input.changedLines, decidedBy };
}

/**
 * May this checkpoint be committed without a human?
 * Requires BOTH explicit authorisation and a low grade with no forbidden hits.
 */
export function mayAutoCommit(assessment: RiskAssessment, autoCommitEnabled: boolean): boolean {
	if (!autoCommitEnabled) return false;
	if (assessment.forbiddenHits.length > 0) return false;
	return assessment.level === "low";
}
