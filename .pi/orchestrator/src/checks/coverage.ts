// Plan coverage matrix — the Plan-stage L0 gate.
//
// A plan is only usable if every acceptance case of the specs it implements is
// covered by some task. "We'll test it later" is exactly the gap this closes, so
// missing coverage is a RED gate with the missing IDs listed, not a warning.
//
// Pure module: parsing only, no I/O beyond the injected reader.

export interface AcceptanceCase {
	/** e.g. "FH-01" */
	id: string;
	/** Spec file stem, e.g. "spec-screen-frame-handoff" */
	spec: string;
	/** Scenario text from the table row, trimmed. */
	scenario: string;
}

export interface CoverageEntry {
	caseId: string;
	/** Task ids that claim to cover this case. */
	tasks: string[];
}

export interface CoverageResult {
	ok: boolean;
	/** Every acceptance case found in the referenced specs. */
	cases: AcceptanceCase[];
	/** caseId → covering task ids. */
	covered: Record<string, string[]>;
	/** Acceptance cases with no task. */
	missing: string[];
	/** Task references to ids that do not exist in any referenced spec. */
	unknown: string[];
	problems: string[];
	/** Machine-readable matrix for the artifact chain. */
	matrix: Array<{ caseId: string; spec: string; scenario: string; tasks: string[] }>;
}

/**
 * Split a markdown table row into cells, honouring backslash-escaped pipes.
 *
 * Markdown escapes a literal `|` inside a cell as `\|`. Splitting on every pipe
 * truncates the scenario text (the real specs use this heavily), which would
 * silently lose acceptance detail.
 */
export function splitTableRow(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && line[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	// A row like "| a | b |" yields ["", " a ", " b ", ""] — drop the outer empties.
	if (cells.length > 0 && cells[0].trim() === "") cells.shift();
	if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}

/**
 * Extract numbered acceptance rows from a spec's 验收场景 section.
 *
 * Only that section counts: constraint tables elsewhere in the file also use
 * `| ID-01 |` shapes, and treating them as acceptance cases would demand coverage
 * for things that are not testable acceptance criteria.
 */
export function parseAcceptanceCases(specText: string, specStem: string): AcceptanceCase[] {
	const lines = specText.split("\n");
	// Heading level of the acceptance section, or 0 when outside it.
	// Real specs nest subsections (## 5. 验收场景 → ### 5.1 可自动化 / ### 5.2 真机);
	// leaving on ANY heading would silently drop those cases and under-demand
	// coverage, so only a heading at the same or higher level ends the section.
	let sectionLevel = 0;
	const out: AcceptanceCase[] = [];
	const seen = new Set<string>();

	for (const raw of lines) {
		const line = raw.trim();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			if (/验收场景|验收用例|acceptance/i.test(heading[2])) {
				sectionLevel = level;
				continue;
			}
			if (sectionLevel > 0 && level <= sectionLevel) sectionLevel = 0;
			continue;
		}
		const inSection = sectionLevel > 0;
		if (!inSection || !line.startsWith("|")) continue;
		if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
		const cells = splitTableRow(line);
		if (cells.length < 2) continue;
		const id = cells[0].replace(/`/g, "").trim();
		if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) continue;
		if (seen.has(id)) continue; // a case may be restated; count it once
		seen.add(id);
		out.push({ id, spec: specStem, scenario: cells[1].replace(/\s+/g, " ").slice(0, 200) });
	}
	return out;
}

/**
 * Parse a plan's coverage claims.
 *
 * Accepted forms (both are used in practice):
 *   | FH-01 | T1 | ...            coverage table: case → task
 *   | T1 | ... | FH-01, FH-02 |   task table: task → cases
 *   - T1: FH-01, FH-02            bullet list
 *   covers: FH-01 FH-02           inline claim on a task line
 */
export function parseCoverageClaims(planText: string): CoverageEntry[] {
	const map = new Map<string, Set<string>>();
	const add = (caseId: string, task: string) => {
		const key = caseId.toUpperCase();
		if (!map.has(key)) map.set(key, new Set());
		map.get(key)!.add(task);
	};
	const CASE = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
	// Task identifiers are NOT restricted to a "T" prefix: plans legitimately use
	// P1, TASK-001, cp-01, etc. Accepting only T\d+ silently dropped those claims
	// and reported missing coverage for a plan that did cover the case.
	// A token is a task when it ends in a digit and is not a case id.
	const TOKEN = /\b([A-Za-z][A-Za-z0-9_-]*\d)\b/g;
	const isCaseId = (t: string) => /^[A-Z][A-Z0-9]*-\d+$/.test(t);
	const taskTokens = (text: string): string[] =>
		[...text.matchAll(TOKEN)].map((m) => m[1]).filter((t) => !isCaseId(t));
	const firstTask = (text: string): string | undefined => taskTokens(text)[0];

	for (const raw of planText.split("\n")) {
		const line = raw.trim();
		if (!line) continue;

		if (line.startsWith("|")) {
			if (/^\|[\s:|-]+\|$/.test(line)) continue;
			const cells = splitTableRow(line);
			if (cells.length < 2) continue;
			const first = cells[0].replace(/`/g, "").trim();
			if (isCaseId(first)) {
				// case → task(s)
				for (const cell of cells.slice(1)) {
					for (const task of taskTokens(cell)) add(first, task);
				}
			} else {
				// task → case(s)
				const task = firstTask(first);
				if (!task) continue;
				for (const cell of cells.slice(1)) {
					for (const m of cell.matchAll(CASE)) add(m[1], task);
				}
			}
			continue;
		}

		// Bullet / inline forms: need both a task token and at least one case id.
		const task = firstTask(line);
		if (!task) continue;
		const ids = [...line.matchAll(CASE)].map((m) => m[1]);
		if (ids.length === 0) continue;
		for (const id of ids) add(id, task);
	}

	return [...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([caseId, tasks]) => ({ caseId, tasks: [...tasks].sort() }));
}

/** Spec file stems referenced by a plan (explicit mentions, else all provided). */
export function referencedSpecs(planText: string, available: string[]): string[] {
	const mentioned = available.filter((stem) => planText.includes(stem));
	return mentioned.length > 0 ? mentioned : available;
}

export interface CoverageInput {
	/** spec stem → full markdown text */
	specs: Record<string, string>;
	planText: string;
	/** Restrict to these specs; omitted → those referenced, else all. */
	specFilter?: string[];
}

export function checkCoverage(input: CoverageInput): CoverageResult {
	const problems: string[] = [];
	const available = Object.keys(input.specs).sort();
	const stems = input.specFilter?.length
		? input.specFilter.filter((s) => available.includes(s))
		: referencedSpecs(input.planText, available);

	if (input.specFilter?.length) {
		for (const s of input.specFilter) {
			if (!available.includes(s)) problems.push(`引用的规格不存在：${s}`);
		}
	}

	const cases: AcceptanceCase[] = [];
	for (const stem of stems) {
		const found = parseAcceptanceCases(input.specs[stem], stem);
		if (found.length === 0) {
			problems.push(`${stem}: 验收场景章节没有可解析的编号用例`);
		}
		cases.push(...found);
	}

	const claims = parseCoverageClaims(input.planText);
	const known = new Set(cases.map((c) => c.id));
	const covered: Record<string, string[]> = {};
	const unknown: string[] = [];
	for (const claim of claims) {
		if (!known.has(claim.caseId)) {
			unknown.push(claim.caseId);
			continue;
		}
		covered[claim.caseId] = claim.tasks;
	}

	const missing = cases.filter((c) => !covered[c.id]?.length).map((c) => c.id);
	if (missing.length > 0) {
		problems.push(`缺少任务覆盖的验收用例（${missing.length}）：${missing.join(", ")}`);
	}
	if (unknown.length > 0) {
		problems.push(`计划引用了不存在的验收编号：${[...new Set(unknown)].sort().join(", ")}`);
	}
	if (cases.length === 0) {
		problems.push("没有可覆盖的验收用例：无法判定计划完整性");
	}

	const matrix = cases.map((c) => ({
		caseId: c.id,
		spec: c.spec,
		scenario: c.scenario,
		tasks: covered[c.id] ?? [],
	}));

	return { ok: problems.length === 0, cases, covered, missing, unknown: [...new Set(unknown)].sort(), problems, matrix };
}

/** Render the matrix as markdown for the artifact chain. */
export function renderCoverageMatrix(result: CoverageResult): string {
	const out: string[] = ["# 覆盖率矩阵", "", `结论: ${result.ok ? "通过" : "未通过"}`, ""];
	if (result.problems.length) {
		out.push("## 问题", "");
		for (const p of result.problems) out.push(`- ${p}`);
		out.push("");
	}
	out.push("| 验收编号 | 规格 | 场景 | 覆盖任务 |", "| --- | --- | --- | --- |");
	for (const row of result.matrix) {
		const scenario = row.scenario.replace(/\|/g, "\\|");
		out.push(`| ${row.caseId} | ${row.spec} | ${scenario} | ${row.tasks.join(", ") || "**缺失**"} |`);
	}
	out.push("");
	out.push(`合计 ${result.cases.length} 条验收用例，缺失 ${result.missing.length} 条。`, "");
	return out.join("\n");
}
