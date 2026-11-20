// Review pipeline orchestration — framework-agnostic, fully injectable.
//
// Order: diff → L0 (deterministic, zero LLM) → L1 (semantic) → L2 (architecture).
// Each layer's verdict is validated against verdict-schema.md §3. A blocked layer
// stops the pipeline; the caller turns the structured findings into a打回 message.
//
// Anti-crosstalk is enforced here, not by prompt wording: the L2 task is built
// from the diff, a constraint checklist and L1's STRUCTURED verdict fields only.
// L1's prose, the coder's reasoning and the parent conversation never enter it.

import type { CommandRunner } from "./l0.ts";
import { runL0Gate } from "./l0.ts";
import type { ParsedVerdict, Layer } from "./verdict.ts";
import { isBlocking, parseAndValidate, formatFindingsForCoder } from "./verdict.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";

export type PipelineOutcome = "pass" | "blocked" | "no-diff" | "invalid";

export interface PipelineDeps {
	cwd: string;
	run: CommandRunner;
	runChild: (opts: RunChildOptions) => Promise<RunChildResult>;
	/** Agent system prompt (markdown body) for a reviewer layer. */
	systemPrompt: (layer: "L1" | "L2") => string;
	/** Constraint checklist text handed to L2 (IDs + one-liners from the catalog). */
	constraintChecklist: string;
	preset?: string;
	/** Max characters of diff embedded in a child task (Windows argv budget). */
	diffCap?: number;
	onLog?: (line: string) => void;
}

export interface PipelineResult {
	outcome: PipelineOutcome;
	verdicts: Partial<Record<Layer, ParsedVerdict>>;
	blockingLayer?: Layer;
	/** Evidence-backed findings for the coder; empty when passing. */
	rejectionText: string;
	/** Human-facing summary line(s). */
	summary: string;
	diff: string;
	diffHash: string;
}

const DEFAULT_DIFF_CAP = 14000;

/** Cheap stable hash for "did anything change since last run". */
export function hashText(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = (h1 ^ c) * 0x01000193 >>> 0;
		h2 = (h2 + c * 31) >>> 0;
	}
	return `${h1.toString(16)}${h2.toString(16)}`;
}

/**
 * The orchestrator's own output must never be reviewed as a change.
 *
 * Without this the evidence chain feeds back into the next run: writing
 * .orchestrator/ makes it an untracked "change", which then trips forbidden-path
 * and risk rules. Excluded unconditionally, not only via .gitignore, so a repo
 * without an ignore entry still behaves correctly.
 */
export const DEFAULT_DIFF_EXCLUDES = [".orchestrator/"];

function normPath(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isExcludedPath(file: string, excludes: string[]): boolean {
	const f = normPath(file);
	return excludes.some((raw) => {
		const bare = normPath(raw).replace(/\/+$/, "");
		return bare.length > 0 && (f === bare || f.startsWith(`${bare}/`));
	});
}

/** Drop per-file sections of a unified diff whose path is excluded. */
export function filterDiff(diff: string, excludes: string[]): string {
	if (!diff.trim() || excludes.length === 0) return diff;
	const sections: string[] = [];
	let current: string[] = [];
	let currentPath = "";
	const flush = () => {
		if (current.length && !isExcludedPath(currentPath, excludes)) sections.push(current.join("\n"));
		current = [];
	};
	for (const line of diff.split("\n")) {
		const header = /^diff --git a\/(.+?) b\//.exec(line);
		if (header) {
			flush();
			currentPath = header[1];
		}
		current.push(line);
	}
	flush();
	return sections.join("\n");
}

/**
 * Collect the working-tree diff plus the names of untracked files.
 * `excludes` defaults to the orchestrator's own artifact root.
 */
export async function collectDiff(
	run: CommandRunner,
	cwd: string,
	excludes: string[] = DEFAULT_DIFF_EXCLUDES,
): Promise<string> {
	const diff = await run("git", ["diff", "--no-color"], { cwd, timeout: 60_000 });
	const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 60_000 });
	const parts: string[] = [];
	const kept = filterDiff(diff.stdout, excludes);
	if (kept.trim()) parts.push(kept.trim());
	const files = untracked.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((f) => !isExcludedPath(f, excludes));
	if (files.length > 0) {
		parts.push(`--- untracked files (contents not inlined) ---\n${files.join("\n")}`);
	}
	return parts.join("\n\n");
}

function capDiff(diff: string, cap: number): string {
	if (diff.length <= cap) return diff;
	return `${diff.slice(0, cap)}\n\n[... diff truncated to ${cap} chars for the child task ...]`;
}

/** Structured-only projection of a verdict — the only thing that crosses layers. */
export function structuredProjection(v: ParsedVerdict): string {
	return JSON.stringify(
		{
			layer: v.layer,
			verdict: v.verdict,
			summary: v.summary,
			findings: v.findings.map((f) => ({
				severity: f.severity,
				file: f.file,
				line: f.line,
				evidence: f.evidence,
				required_fix: f.required_fix,
				failing_test: f.failing_test,
				uncertain: f.uncertain,
			})),
		},
		null,
		2,
	);
}

/** Run one LLM layer, retrying once if the verdict is malformed. */
async function runReviewLayer(
	deps: PipelineDeps,
	layer: "L1" | "L2",
	task: string,
): Promise<{ verdict?: ParsedVerdict; errors: string[]; attempts: number }> {
	const tools = ["read", "grep", "find", "ls"]; // write/edit/bash are absent by construction
	let lastErrors: string[] = [];
	for (let attempt = 1; attempt <= 2; attempt++) {
		deps.onLog?.(`[${layer}] child attempt ${attempt}`);
		const res = await deps.runChild({
			cwd: deps.cwd,
			systemPrompt: deps.systemPrompt(layer),
			userPrompt: attempt === 1 ? task : `${task}\n\n[OUTPUT ERROR] Your previous reply was not a valid verdict JSON (${lastErrors.join("; ")}). Reply with ONLY the verdict JSON object.`,
			tools,
			thinking: "low",
			timeoutMs: 10 * 60 * 1000,
			onLog: deps.onLog,
		});
		if (!res.ok) {
			lastErrors = [`child failed: ${res.error ?? `exit ${res.exitCode}`}`];
			continue;
		}
		const validation = parseAndValidate(res.assistantText, layer);
		if (validation.ok && validation.verdict) {
			return { verdict: validation.verdict, errors: [], attempts: attempt };
		}
		lastErrors = validation.errors;
	}
	return { errors: lastErrors, attempts: 2 };
}

export async function runReviewPipeline(deps: PipelineDeps): Promise<PipelineResult> {
	const diff = await collectDiff(deps.run, deps.cwd);
	const diffHash = hashText(diff);
	const verdicts: Partial<Record<Layer, ParsedVerdict>> = {};
	if (!diff.trim()) {
		return { outcome: "no-diff", verdicts, rejectionText: "", summary: "工作区没有改动，跳过 review。", diff, diffHash };
	}
	const capped = capDiff(diff, deps.diffCap ?? DEFAULT_DIFF_CAP);

	// ---- L0: deterministic, zero LLM ----
	const l0 = await runL0Gate({ cwd: deps.cwd, run: deps.run, preset: deps.preset, onLog: deps.onLog });
	verdicts.L0 = l0;
	if (isBlocking(l0)) {
		return {
			outcome: "blocked",
			verdicts,
			blockingLayer: "L0",
			rejectionText: formatFindingsForCoder(l0) || l0.summary,
			summary: `L0 确定性门禁未通过（${l0.findings.length} 项）。L1/L2 未启动。`,
			diff,
			diffHash,
		};
	}

	// ---- L1: semantic ----
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
	const l1 = await runReviewLayer(deps, "L1", l1Task);
	if (!l1.verdict) {
		return {
			outcome: "invalid",
			verdicts,
			blockingLayer: "L1",
			rejectionText: `L1 裁决不合规，重试后仍无法解析：${l1.errors.join("; ")}`,
			summary: "L1 未产出合法 verdict（裁决不合规），请检查 agent 定义或输出格式。",
			diff,
			diffHash,
		};
	}
	verdicts.L1 = l1.verdict;
	if (isBlocking(l1.verdict)) {
		return {
			outcome: "blocked",
			verdicts,
			blockingLayer: "L1",
			rejectionText: formatFindingsForCoder(l1.verdict) || l1.verdict.summary,
			summary: `L1 语义审查发现问题（${l1.verdict.findings.length} 项）。L2 未启动。`,
			diff,
			diffHash,
		};
	}

	// ---- L2: architecture / constraints ----
	// Only diff + checklist + L1's structured fields. No L1 prose, no coder reasoning.
	const l2Task = [
		"Judge ONLY whether the diff below violates the project's hard architectural constraints.",
		"Do not review logic, style or code quality (L1 already did that).",
		"",
		"=== CONSTRAINT CHECKLIST (cite these IDs) ===",
		deps.constraintChecklist,
		"",
		"=== L1 VERDICT (structured) ===",
		structuredProjection(l1.verdict),
		"",
		"=== DIFF ===",
		capped,
	].join("\n");
	const l2 = await runReviewLayer(deps, "L2", l2Task);
	if (!l2.verdict) {
		return {
			outcome: "invalid",
			verdicts,
			blockingLayer: "L2",
			rejectionText: `L2 裁决不合规，重试后仍无法解析：${l2.errors.join("; ")}`,
			summary: "L2 未产出合法 verdict（裁决不合规），请检查 agent 定义或约束目录。",
			diff,
			diffHash,
		};
	}
	verdicts.L2 = l2.verdict;
	if (isBlocking(l2.verdict)) {
		return {
			outcome: "blocked",
			verdicts,
			blockingLayer: "L2",
			rejectionText: formatFindingsForCoder(l2.verdict) || l2.verdict.summary,
			summary: `L2 架构/约束审查发现问题（${l2.verdict.findings.length} 项）。`,
			diff,
			diffHash,
		};
	}

	const notes = collectNonBlockingNotes(verdicts);
	return {
		outcome: "pass",
		verdicts,
		rejectionText: "",
		summary: `三层全部通过：L0（build + ctest 含 arch.layers/spec.structure）、L1（语义）、L2（架构约束）。${notes}`,
		diff,
		diffHash,
	};
}

/** Suggestions / uncertain findings are reported but never block. */
export function collectNonBlockingNotes(verdicts: Partial<Record<Layer, ParsedVerdict>>): string {
	const notes: string[] = [];
	for (const layer of ["L1", "L2"] as const) {
		const v = verdicts[layer];
		if (!v) continue;
		for (const f of v.findings) {
			if (f.severity !== "suggestion" && !f.uncertain) continue;
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			notes.push(`${layer} ${loc}${f.uncertain ? "（不确定，建议人工复核）" : ""}: ${String(f.evidence).split("\n")[0]}`);
		}
	}
	return notes.length > 0 ? `\n需人工留意（不阻断）：\n- ${notes.join("\n- ")}` : "";
}

/**
 * Attempt counter for a pipeline run.
 *
 * A human typing /review starts a fresh budget. An auto-recheck dispatched by
 * the settle hook is a CONTINUATION of the same review and must keep counting,
 * otherwise every round resets the counter and max_retries never fires.
 */
export function nextAttempt(input: { attempt: number; continuation: boolean }): number {
	return input.continuation ? input.attempt : 0;
}

export type RetryDecision =
	| { action: "repair"; attempt: number }
	| { action: "manual"; attempt: number; reason: string }
	| { action: "stop"; attempt: number; reason: string };

/**
 * Decide what to do after a blocked pipeline run.
 *
 * Pure so the bounded-loop guarantee is testable without a live session. Two
 * independent brakes, either of which stops the loop:
 *   1. The fix changed nothing → re-reviewing the same diff would only burn tokens.
 *   2. attempt > maxRetries → hand the decision back to the human.
 */
export function decideRetry(input: {
	attempt: number;
	maxRetries: number;
	diffHash: string;
	lastDiffHash: string;
}): RetryDecision {
	const attempt = input.attempt;
	if (!input.diffHash || input.diffHash === input.lastDiffHash) {
		return { action: "stop", attempt, reason: "修复后工作区没有变化（或无法读取 diff）" };
	}
	if (attempt > input.maxRetries) {
		return { action: "manual", attempt, reason: `连续 ${input.maxRetries} 轮未通过` };
	}
	return { action: "repair", attempt };
}