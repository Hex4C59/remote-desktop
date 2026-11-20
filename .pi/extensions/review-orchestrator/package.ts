// Review package generator — templated, never AI-written.
//
// The human at L3 must approve a FIXED, hashable artifact. Letting a model write
// the summary would make the approval target unverifiable and could smuggle in
// persuasion ("this looks fine overall"). So every byte here is produced by a
// template from structured inputs.
//
// The package is self-contained: it carries its own diff, verdicts and manifest,
// so `sha256sum -c evidence.sha256` works inside the package directory and the
// exported copy stays verifiable on its own.

import { ArtifactStore, sha256, type Stage } from "./store.ts";
import type { ParsedVerdict } from "./verdict.ts";
import type { PanelAggregate } from "./aggregate.ts";
import type { PanelMemberRecord } from "./panel-runner.ts";

/** Structurally compatible with risk.ts's RiskAssessment (B1). */
export interface RiskInfo {
	level: "low" | "medium" | "high";
	reasons: string[];
	forbiddenHits?: string[];
	changedFiles?: string[];
	changedLines?: number;
	gates?: { l0: boolean; l1: boolean; panel: boolean; human: boolean };
}

export interface PackageInput {
	runId: string;
	checkpointId: string;
	stage: Stage;
	/** Pipeline outcome, e.g. pass / blocked / awaiting-human. */
	outcome: string;
	attempt: number;
	maxRetries: number;
	diff: string;
	diffStat?: string;
	l0?: ParsedVerdict;
	l1?: ParsedVerdict;
	l2?: ParsedVerdict;
	panel?: PanelAggregate;
	panelRecords?: PanelMemberRecord[];
	risk?: RiskInfo;
	coderModel?: string;
	/** Deterministic statement of what the machine will do next. */
	nextAction: string;
	generatedAt?: string;
}

export interface ReviewPackage {
	/** Package directory, relative to the run dir. */
	dir: string;
	files: string[];
	manifest: string;
	/** sha256 of the manifest — the exact thing a human approval binds to. */
	packageHash: string;
	summary: string;
}

function fmtVerdictRow(layer: string, v?: ParsedVerdict): string {
	if (!v) return `| ${layer} | 未执行 | - | - |`;
	const note = v.summary.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
	return `| ${layer} | ${v.verdict} | ${v.findings.length} | ${note} |`;
}

function isBlockingFinding(f: { severity?: string; uncertain?: boolean }): boolean {
	if (f.uncertain) return false;
	return f.severity === "critical" || f.severity === "warning";
}

function renderFindings(verdicts: Array<[string, ParsedVerdict | undefined]>, blocking: boolean): string {
	const lines: string[] = [];
	for (const [layer, v] of verdicts) {
		if (!v) continue;
		for (const f of v.findings) {
			const block = isBlockingFinding(f) || (v.verdict === "fail" && !f.uncertain);
			if (block !== blocking) continue;
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			lines.push(`- **[${layer}] ${f.severity ?? "?"}** \`${loc}\`${f.uncertain ? " （不确定，需人工复核）" : ""}`);
			lines.push(`  - 证据：${String(f.evidence ?? "").replace(/\n/g, " ").trim()}`);
			if (f.required_fix) lines.push(`  - 修法：${String(f.required_fix).replace(/\n/g, " ").trim()}`);
			if (f.failing_test) lines.push(`  - 失败测试：${String(f.failing_test).replace(/\n/g, " ").trim()}`);
		}
	}
	return lines.length ? lines.join("\n") : "（无）";
}

/** Deterministic summary.md. */
export function renderSummary(input: PackageInput): string {
	const at = input.generatedAt ?? new Date().toISOString();
	const layers: Array<[string, ParsedVerdict | undefined]> = [
		["L0", input.l0], ["L1", input.l1], ["L2", input.l2],
	];
	const out: string[] = [];
	out.push(`# 审查包 · ${input.stage} · ${input.checkpointId}`);
	out.push("");
	out.push(`- run: \`${input.runId}\``);
	out.push(`- 生成时间: ${at}`);
	out.push(`- 流水线结论: **${input.outcome}**`);
	out.push(`- 打回轮次: ${input.attempt}/${input.maxRetries}`);
	if (input.coderModel) out.push(`- coder 模型: \`${input.coderModel}\``);
	if (input.risk) out.push(`- 风险等级: **${input.risk.level}**`);
	out.push("");
	out.push("## 各层裁决");
	out.push("");
	out.push("| 层 | 结论 | findings | 摘要 |");
	out.push("| --- | --- | --- | --- |");
	for (const [layer, v] of layers) out.push(fmtVerdictRow(layer, v));
	out.push("");

	if (input.panel) {
		out.push("## L2 跨 vendor 面板");
		out.push("");
		out.push(`- 聚合结论: **${input.panel.outcome}**`);
		out.push(`- 有效票: ${input.panel.validVotes} / 法定 ${input.panel.quorum}`);
		out.push(`- 参与家族: ${input.panel.votingFamilies.join(", ") || "（无）"}`);
		out.push(`- 缺席成员: ${input.panel.absent.length}`);
		for (const r of input.panel.reasons) out.push(`  - ${r}`);
		if (input.panelRecords?.length) {
			out.push("");
			out.push("| 成员 | 家族 | 有效 | 实际模型 | 耗时 | 失败原因 |");
			out.push("| --- | --- | --- | --- | --- | --- |");
			for (const r of input.panelRecords) {
				out.push(
					`| \`${r.model}\` | ${r.family} | ${r.ok ? "是" : "否"} | ${r.reportedModel ?? "-"} | ${r.durationMs}ms | ${(r.error ?? "-").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120)} |`,
				);
			}
		}
		out.push("");
	}

	out.push("## 阻断项（必须处理）");
	out.push("");
	out.push(renderFindings(layers, true));
	out.push("");
	out.push("## 建议项 / 不确定项（不阻断）");
	out.push("");
	out.push(renderFindings(layers, false));
	out.push("");
	out.push("## 下一步（由状态机决定，非建议）");
	out.push("");
	out.push(input.nextAction);
	out.push("");
	out.push("## 证据校验");
	out.push("");
	out.push("本包含 `evidence.sha256`，可在本目录内直接复算：");
	out.push("");
	out.push("```bash");
	out.push("sha256sum -c evidence.sha256");
	out.push("```");
	out.push("");
	out.push("批准记录会绑定本包的 hash；包内容一旦变化，旧批准即失效。");
	out.push("");
	return out.join("\n");
}

/** Deterministic risk-assessment.md. */
export function renderRiskAssessment(input: PackageInput): string {
	const out: string[] = ["# 风险评估", ""];
	if (!input.risk) {
		out.push("level: （未分级）");
		out.push("");
		out.push("本次运行未启用确定性风险分级；门禁按阶段配置执行。");
		return out.join("\n");
	}
	const r = input.risk;
	out.push(`level: ${r.level}`);
	out.push("");
	out.push("## 分级依据（确定性规则，非模型判断）");
	out.push("");
	for (const reason of r.reasons) out.push(`- ${reason}`);
	if (!r.reasons.length) out.push("- （无）");
	out.push("");
	if (r.forbiddenHits?.length) {
		out.push("## 禁止路径命中（必须升级，不得自动放行）");
		out.push("");
		for (const f of r.forbiddenHits) out.push(`- \`${f}\``);
		out.push("");
	}
	if (r.changedFiles?.length) {
		out.push(`## 改动文件（${r.changedFiles.length}）`);
		out.push("");
		for (const f of r.changedFiles) out.push(`- \`${f}\``);
		out.push("");
	}
	if (typeof r.changedLines === "number") {
		out.push(`改动行数: ${r.changedLines}`);
		out.push("");
	}
	if (r.gates) {
		out.push("## 本次执行的门禁");
		out.push("");
		out.push(`- L0 确定性: ${r.gates.l0 ? "执行" : "跳过"}`);
		out.push(`- L1 语义: ${r.gates.l1 ? "执行" : "跳过"}`);
		out.push(`- L2 跨 vendor 面板: ${r.gates.panel ? "执行" : "跳过"}`);
		out.push(`- L3 人类批准: ${r.gates.human ? "执行" : "跳过"}`);
		out.push("");
	}
	return out.join("\n");
}

/**
 * Write the canonical checkpoint artifacts plus a self-contained review package.
 * Returns the package hash that a human approval must bind to.
 */
export function buildReviewPackage(store: ArtifactStore, input: PackageInput): ReviewPackage {
	const cp = store.checkpointDir(input.checkpointId);
	const pkg = store.reviewPackageDir(input.checkpointId);

	// Canonical artifacts (the machine's record).
	const artifacts: Array<[string, string]> = [];
	artifacts.push(["diff.patch", input.diff.endsWith("\n") ? input.diff : input.diff + "\n"]);
	if (input.diffStat !== undefined) artifacts.push(["diff-stat.txt", input.diffStat]);
	if (input.l0) artifacts.push(["l0-results.json", jsonText(input.l0)]);
	if (input.l1) artifacts.push(["l1-findings.json", jsonText(input.l1)]);
	if (input.l2) artifacts.push(["l2-verdict.json", jsonText(input.l2)]);
	if (input.panel) artifacts.push(["l2-panel.json", jsonText(input.panel)]);
	if (input.panelRecords) artifacts.push(["l2-panel-members.json", jsonText(input.panelRecords)]);

	for (const [name, content] of artifacts) {
		store.writeText(`${cp}/${name}`, content);
	}

	// Human-facing snapshot: same bytes, inside the package, so it stands alone.
	for (const [name, content] of artifacts) {
		store.writeText(`${pkg}/${name}`, content);
	}
	const summary = renderSummary(input);
	store.writeText(`${pkg}/summary.md`, summary);
	store.writeText(`${pkg}/risk-assessment.md`, renderRiskAssessment(input));

	// Manifest covers everything in the package except itself.
	const manifest = store.writeEvidenceManifest(pkg);

	// Index is written AFTER hashing so it can list the hashes; it is itself
	// excluded from the manifest to avoid a self-reference cycle.
	const indexLines = ["# 证据索引", "", "| 文件 | sha256（前 16） | 字节 |", "| --- | --- | --- |"];
	for (const line of manifest.split("\n").filter(Boolean)) {
		const i = line.indexOf("  ");
		const hash = line.slice(0, i);
		const rel = line.slice(i + 2);
		const bytes = Buffer.byteLength(store.readText(`${pkg}/${rel}`) ?? "", "utf-8");
		indexLines.push(`| \`${rel}\` | \`${hash.slice(0, 16)}\` | ${bytes} |`);
	}
	indexLines.push("", "完整 hash 见 `evidence.sha256`。索引本身不参与 hash，避免自引用。", "");
	store.writeText(`${pkg}/artifacts-index.md`, indexLines.join("\n"));

	const files = manifest.split("\n").filter(Boolean).map((l) => l.slice(l.indexOf("  ") + 2));
	return {
		dir: pkg,
		// The manifest and the derived index are real package files even though
		// they are excluded from hashing; callers listing the package need them.
		files: [...files, "evidence.sha256", "artifacts-index.md"],
		manifest,
		packageHash: sha256(manifest),
		summary,
	};
}

function jsonText(v: unknown): string {
	return JSON.stringify(v, null, 2) + "\n";
}
