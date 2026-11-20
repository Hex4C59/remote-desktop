// Stage-specific L0 gates (blueprint: every deliverable has a deterministic floor).
//
//   discussion → none        (nothing mechanical to check yet)
//   spec       → python tools/check_specs.py   (status line, sections, case ids, index)
//   plan       → coverage matrix               (every acceptance case has a task)
//   task       → TASK.md structure             (goal, acceptance refs, scope, verification)
//   code       → cmake --build + ctest         (existing runL0Gate)
//
// Exit codes decide. L0 never invents a fix or an opinion: it reports facts.

import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandRunner } from "./l0.ts";
import { runL0Gate, excerpt } from "./l0.ts";
import type { ParsedVerdict, Finding, Check } from "./verdict.ts";
import { checkCoverage, renderCoverageMatrix, type CoverageResult } from "./coverage.ts";
import type { L0Kind } from "./config.ts";

export interface StageL0Options {
	cwd: string;
	run: CommandRunner;
	kind: L0Kind;
	/** For plan coverage: spec stem → markdown text. */
	specs?: Record<string, string>;
	/** For plan coverage: the plan markdown. */
	planText?: string;
	/** Restrict coverage to these spec stems. */
	specFilter?: string[];
	/** For task validation: path to TASK.md (relative to cwd). */
	taskFile?: string;
	/** Python interpreter for the spec checker. */
	python?: string;
	timeoutMs?: number;
	onLog?: (line: string) => void;
}

function verdict(pass: boolean, findings: Finding[], checks: Check[], summary: string): ParsedVerdict {
	return { layer: "L0", verdict: pass ? "pass" : "fail", findings, summary, checks, raw: { checks } };
}

/** Run the project's spec structure checker. Exit code is the verdict. */
export async function runSpecL0(opts: StageL0Options): Promise<ParsedVerdict> {
	const py = opts.python ?? "python";
	const script = path.join(opts.cwd, "tools", "check_specs.py");
	if (!fs.existsSync(script)) {
		return verdict(false,
			[{ file: "spec", evidence: "tools/check_specs.py 不存在：无法执行规格结构门禁" }],
			[{ name: "spec.structure", exit_code: -1, log_excerpt: "checker missing" }],
			"L0 未通过：缺少规格结构检查器。");
	}
	opts.onLog?.(`[L0] ${py} tools/check_specs.py`);
	const res = await opts.run(py, ["tools/check_specs.py"], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000 });
	const log = excerpt(`${res.stdout}\n${res.stderr}`);
	const code = res.exitCode ?? -1;
	const checks: Check[] = [{ name: "spec.structure", exit_code: code, ...(log ? { log_excerpt: log } : {}) }];
	if (code === 0) {
		return verdict(true, [], checks, "L0 通过：规格结构检查（状态行/必需章节/验收编号/索引一致性）退出码 0。");
	}
	return verdict(false,
		[{ file: "spec", evidence: `python tools/check_specs.py exited ${code}${res.killed ? " (killed/timeout)" : ""}\n${log}` }],
		checks, "L0 未通过：规格结构检查失败（见退出码与日志摘录）。");
}

/** Plan L0: every acceptance case of the referenced specs must have a task. */
export function runPlanL0(opts: StageL0Options): { verdict: ParsedVerdict; coverage: CoverageResult; markdown: string } {
	const specs = opts.specs ?? {};
	const planText = opts.planText ?? "";
	if (Object.keys(specs).length === 0) {
		const v = verdict(false,
			[{ file: "plan", evidence: "没有可读取的 specs/spec-*.md：无法判定计划覆盖率" }],
			[{ name: "plan.coverage", exit_code: -1, log_excerpt: "no specs available" }],
			"L0 未通过：缺少规格，无法计算覆盖率。");
		return { verdict: v, coverage: checkCoverage({ specs: {}, planText }), markdown: "" };
	}
	const coverage = checkCoverage({ specs, planText, specFilter: opts.specFilter });
	const markdown = renderCoverageMatrix(coverage);
	const code = coverage.ok ? 0 : 1;
	const checks: Check[] = [{
		name: "plan.coverage",
		exit_code: code,
		log_excerpt: `${coverage.cases.length} cases, missing ${coverage.missing.length}, unknown ${coverage.unknown.length}`,
	}];
	if (coverage.ok) {
		return {
			verdict: verdict(true, [], checks, `L0 通过：${coverage.cases.length} 条验收用例全部有任务覆盖。`),
			coverage, markdown,
		};
	}
	const findings: Finding[] = coverage.problems.map((p) => ({ file: "plan", evidence: p }));
	return {
		verdict: verdict(false, findings, checks, `L0 未通过：计划覆盖率不足（缺失 ${coverage.missing.length} 条验收用例）。`),
		coverage, markdown,
	};
}

/** Required TASK.md sections. Missing ones are a red gate, not a suggestion. */
export const TASK_REQUIRED_SECTIONS = [
	{ key: "目标", pattern: /目标|goal|objective/i },
	{ key: "验收依据", pattern: /验收依据|验收|acceptance/i },
	{ key: "变更范围", pattern: /变更范围|改动范围|范围|scope|files?/i },
	{ key: "验证方式", pattern: /验证方式|验证|verification|test/i },
];

export interface TaskStructureResult {
	ok: boolean;
	missingSections: string[];
	/** Acceptance case ids referenced by the task. */
	caseIds: string[];
	problems: string[];
}

/**
 * Validate a TASK.md.
 *
 * A task must state what it does, which acceptance cases it serves, what it may
 * touch, and how it will be verified. Without acceptance references the task
 * cannot be traced back to a spec, which is the whole point of the pipeline.
 */
export function checkTaskStructure(text: string): TaskStructureResult {
	const problems: string[] = [];
	const missingSections: string[] = [];
	if (!text.trim()) {
		return { ok: false, missingSections: TASK_REQUIRED_SECTIONS.map((s) => s.key), caseIds: [], problems: ["TASK.md 为空"] };
	}
	for (const section of TASK_REQUIRED_SECTIONS) {
		// Accept a heading or a bold/label line, not just any mention in prose.
		const heading = new RegExp(`^\\s*(?:#{1,6}\\s*.*|-\\s*\\*\\*|\\*\\*)?[^\\n]{0,12}${section.pattern.source}`, "im");
		if (!heading.test(text)) missingSections.push(section.key);
	}
	if (missingSections.length > 0) {
		problems.push(`TASK.md 缺少必需小节：${missingSections.join(", ")}`);
	}
	const caseIds = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9]*-\d+)\b/g)].map((m) => m[1]))].sort();
	if (caseIds.length === 0) {
		problems.push("TASK.md 未引用任何验收编号（形如 FH-01）：无法追溯到规格");
	}
	return { ok: problems.length === 0, missingSections, caseIds, problems };
}

/** Task L0: TASK.md must exist and be structurally complete. */
export function runTaskL0(opts: StageL0Options): { verdict: ParsedVerdict; structure: TaskStructureResult } {
	const rel = opts.taskFile ?? "TASK.md";
	// Accept an absolute path: artifact-relative paths (e.g. the store's
	// "task/TASK.md") resolve under the RUN directory, not cwd. Joining those with
	// cwd looked in the wrong place and reported a false "TASK.md missing".
	const file = path.isAbsolute(rel) ? rel : path.join(opts.cwd, rel);
	let text = "";
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		const v = verdict(false,
			[{ file: "task", evidence: `${rel} 不存在：无法进入 CODE_LOOP` }],
			[{ name: "task.structure", exit_code: -1, log_excerpt: "TASK.md missing" }],
			"L0 未通过：缺少 TASK.md。");
		return { verdict: v, structure: { ok: false, missingSections: [], caseIds: [], problems: [`${rel} missing`] } };
	}
	const structure = checkTaskStructure(text);
	const checks: Check[] = [{
		name: "task.structure",
		exit_code: structure.ok ? 0 : 1,
		log_excerpt: `sections missing: ${structure.missingSections.join(",") || "none"}; cases: ${structure.caseIds.join(",") || "none"}`,
	}];
	if (structure.ok) {
		return {
			verdict: verdict(true, [], checks, `L0 通过：TASK.md 结构完整，引用 ${structure.caseIds.length} 条验收编号。`),
			structure,
		};
	}
	return {
		verdict: verdict(false, structure.problems.map((p) => ({ file: "task", evidence: p })), checks,
			"L0 未通过：TASK.md 结构不完整。"),
		structure,
	};
}

/** Discussion has no mechanical floor; say so explicitly rather than faking one. */
export function runDiscussionL0(): ParsedVerdict {
	return verdict(true, [], [{ name: "discussion.none", exit_code: 0, log_excerpt: "no deterministic gate for discussion" }],
		"L0 不适用：讨论阶段没有确定性门禁（方案质量由 L1 与人工判断）。");
}

/** Load every specs/spec-*.md keyed by stem. */
export function loadSpecs(cwd: string): Record<string, string> {
	const dir = path.join(cwd, "specs");
	const out: Record<string, string> = {};
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries.sort()) {
		if (!/^spec-.*\.md$/.test(name)) continue;
		try {
			out[name.replace(/\.md$/, "")] = fs.readFileSync(path.join(dir, name), "utf-8");
		} catch { /* skip unreadable */ }
	}
	return out;
}

export interface StageL0Result {
	verdict: ParsedVerdict;
	coverage?: CoverageResult;
	coverageMarkdown?: string;
	taskStructure?: TaskStructureResult;
}

/** Dispatch to the right deterministic gate for a stage. */
export async function runStageL0(opts: StageL0Options): Promise<StageL0Result> {
	switch (opts.kind) {
		case "none":
			return { verdict: runDiscussionL0() };
		case "specs":
			return { verdict: await runSpecL0(opts) };
		case "coverage": {
			const specs = opts.specs ?? loadSpecs(opts.cwd);
			const r = runPlanL0({ ...opts, specs });
			return { verdict: r.verdict, coverage: r.coverage, coverageMarkdown: r.markdown };
		}
		case "task": {
			const r = runTaskL0(opts);
			return { verdict: r.verdict, taskStructure: r.structure };
		}
		case "build":
			return { verdict: await runL0Gate({ cwd: opts.cwd, run: opts.run, timeoutMs: opts.timeoutMs, onLog: opts.onLog }) };
		default:
			return {
				verdict: verdict(false, [{ file: "l0", evidence: `未知的 L0 类型：${String(opts.kind)}` }],
					[{ name: "l0.unknown", exit_code: -1 }], "L0 未通过：未知门禁类型（fail-closed）。"),
			};
	}
}
