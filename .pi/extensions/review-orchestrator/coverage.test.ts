// Tests for coverage.ts — Plan-stage L0 gate, exercised against the REAL specs.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/coverage.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	checkCoverage, parseAcceptanceCases, parseCoverageClaims, referencedSpecs, renderCoverageMatrix, splitTableRow,
} from "./coverage.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

/** Load the project's real specs, keyed by file stem. */
function realSpecs(): Record<string, string> {
	const dir = path.join(process.cwd(), "specs");
	const out: Record<string, string> = {};
	for (const f of fs.readdirSync(dir)) {
		if (!/^spec-.*\.md$/.test(f)) continue;
		out[f.replace(/\.md$/, "")] = fs.readFileSync(path.join(dir, f), "utf-8");
	}
	return out;
}
const SPECS = realSpecs();
const FH = "spec-screen-frame-handoff";
const PW = "spec-platform-win";

// ------------------------------------------------------------------ #15 real parsing
check("#15 extracts all 16 acceptance cases from the real frame-handoff spec", () => {
	const cases = parseAcceptanceCases(SPECS[FH], FH);
	assert.equal(cases.length, 16, `got ${cases.length}: ${cases.map((c) => c.id).join(",")}`);
	assert.deepEqual(cases.map((c) => c.id), Array.from({ length: 16 }, (_, i) => `FH-${String(i + 1).padStart(2, "0")}`));
	assert.ok(cases.every((c) => c.spec === FH));
	assert.ok(cases.every((c) => c.scenario.length > 0), "scenario text must be captured");
});

check("#15 extracts the real platform-win acceptance cases", () => {
	const cases = parseAcceptanceCases(SPECS[PW], PW);
	// 20 automatable (PW-xx) plus the real-desktop section (PWH-xx).
	const auto = cases.filter((c) => /^PW-\d+$/.test(c.id));
	const hw = cases.filter((c) => /^PWH-\d+$/.test(c.id));
	assert.ok(auto.length >= 20, `expected >=20 automatable cases, got ${auto.length}`);
	assert.ok(hw.length > 0, "real-desktop subsection must also be parsed");
	assert.ok(cases.every((c) => /^PWH?-\d+$/.test(c.id)), cases.map((c) => c.id).join(","));
});

check("only the 验收场景 section counts, not other ID tables", () => {
	const md = [
		"# spec-x", "", "## 3. 不变量", "",
		"| INV-01 | 不变量描述 |", "",
		"## 5. 验收场景", "",
		"| 编号 | 场景 | 预期 |", "| --- | --- | --- |",
		"| AC-01 | 场景一 | 预期一 |",
		"| AC-02 | 场景二 | 预期二 |", "",
		"## 6. 依赖与待决项", "",
		"| DEP-09 | 另一个表 |", "",
	].join("\n");
	const cases = parseAcceptanceCases(md, "spec-x");
	assert.deepEqual(cases.map((c) => c.id), ["AC-01", "AC-02"]);
});

check("duplicate case ids are counted once", () => {
	const md = ["## 验收场景", "| AC-01 | a |", "| AC-01 | a restated |"].join("\n");
	assert.equal(parseAcceptanceCases(md, "s").length, 1);
});

check("separator and header rows are ignored", () => {
	const md = ["## 验收场景", "| 编号 | 场景 |", "| --- | --- |", "| AC-01 | real |"].join("\n");
	assert.deepEqual(parseAcceptanceCases(md, "s").map((c) => c.id), ["AC-01"]);
});

check("a spec with no acceptance section yields no cases", () => {
	assert.deepEqual(parseAcceptanceCases("# spec\n## 范围\ntext\n", "s"), []);
});

// ------------------------------------------------------------------ claim parsing
check("parses case → task coverage tables", () => {
	const plan = ["| 验收编号 | 任务 |", "| --- | --- |", "| FH-01 | T1 |", "| FH-02 | T2, T3 |"].join("\n");
	const claims = parseCoverageClaims(plan);
	assert.deepEqual(claims.find((c) => c.caseId === "FH-01")?.tasks, ["T1"]);
	assert.deepEqual(claims.find((c) => c.caseId === "FH-02")?.tasks, ["T2", "T3"]);
});

check("parses task → cases tables", () => {
	const plan = ["| 任务 | 覆盖验收 |", "| --- | --- |", "| T1 | FH-01, FH-02 |"].join("\n");
	const claims = parseCoverageClaims(plan);
	assert.deepEqual(claims.find((c) => c.caseId === "FH-01")?.tasks, ["T1"]);
	assert.deepEqual(claims.find((c) => c.caseId === "FH-02")?.tasks, ["T1"]);
});

check("parses bullet and inline claims", () => {
	const plan = ["- T1: FH-01, FH-02", "- T2 covers FH-03"].join("\n");
	const claims = parseCoverageClaims(plan);
	assert.deepEqual(claims.find((c) => c.caseId === "FH-03")?.tasks, ["T2"]);
	assert.equal(claims.length, 3);
});

check("a line with cases but no task is not a coverage claim", () => {
	assert.deepEqual(parseCoverageClaims("参考 FH-01 的描述"), []);
});

check("claims are deduped and sorted for reproducibility", () => {
	const plan = ["| FH-02 | T2 |", "| FH-01 | T1 |", "| FH-01 | T1 |"].join("\n");
	const claims = parseCoverageClaims(plan);
	assert.deepEqual(claims.map((c) => c.caseId), ["FH-01", "FH-02"]);
	assert.deepEqual(claims[0].tasks, ["T1"]);
});

// ------------------------------------------------------------------ #15 coverage gate
check("#15 full coverage of the real spec passes", () => {
	const cases = parseAcceptanceCases(SPECS[FH], FH);
	const plan = [`实现 ${FH}`, ...cases.map((c, i) => `| ${c.id} | T${i + 1} |`)].join("\n");
	const r = checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH] });
	assert.ok(r.ok, r.problems.join("; "));
	assert.equal(r.cases.length, 16);
	assert.deepEqual(r.missing, []);
	assert.equal(r.matrix.length, 16);
});

check("#15 missing coverage is RED and lists the missing IDs", () => {
	const cases = parseAcceptanceCases(SPECS[FH], FH);
	// Cover all but the last two.
	const plan = [`实现 ${FH}`, ...cases.slice(0, 14).map((c, i) => `| ${c.id} | T${i + 1} |`)].join("\n");
	const r = checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH] });
	assert.ok(!r.ok, "missing coverage must fail the gate");
	assert.deepEqual(r.missing, ["FH-15", "FH-16"]);
	assert.ok(r.problems.some((p) => p.includes("FH-15") && p.includes("FH-16")));
});

check("#15 an empty plan misses every case", () => {
	const r = checkCoverage({ specs: SPECS, planText: `实现 ${FH}\n没有任何任务`, specFilter: [FH] });
	assert.ok(!r.ok);
	assert.equal(r.missing.length, 16);
});

check("a claim to a non-existent case id is reported", () => {
	const cases = parseAcceptanceCases(SPECS[FH], FH);
	const plan = [`实现 ${FH}`, ...cases.map((c, i) => `| ${c.id} | T${i + 1} |`), "| FH-99 | T99 |"].join("\n");
	const r = checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH] });
	assert.ok(!r.ok);
	assert.deepEqual(r.unknown, ["FH-99"]);
	assert.ok(r.problems.some((p) => p.includes("不存在的验收编号")));
});

check("referencing a missing spec file is reported", () => {
	const r = checkCoverage({ specs: SPECS, planText: "x", specFilter: ["spec-does-not-exist"] });
	assert.ok(!r.ok);
	assert.ok(r.problems.some((p) => p.includes("spec-does-not-exist")));
});

check("referencedSpecs picks only specs the plan mentions", () => {
	const available = Object.keys(SPECS);
	assert.deepEqual(referencedSpecs(`实现 ${FH}`, available), [FH]);
	// No mention → all available (fail-closed: demand coverage everywhere).
	assert.deepEqual(referencedSpecs("no spec named", available).sort(), [...available].sort());
});

check("multiple specs are checked together", () => {
	const fh = parseAcceptanceCases(SPECS[FH], FH);
	const pw = parseAcceptanceCases(SPECS[PW], PW);
	const plan = [
		`实现 ${FH} 与 ${PW}`,
		...fh.map((c, i) => `| ${c.id} | T${i + 1} |`),
		...pw.map((c, i) => `| ${c.id} | P${i + 1} |`),
	].join("\n");
	const r = checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH, PW] });
	assert.ok(r.ok, r.problems.join("; "));
	assert.equal(r.cases.length, fh.length + pw.length);
});

check("a spec with an empty acceptance section cannot pass", () => {
	const r = checkCoverage({ specs: { "spec-empty": "# spec\n## 范围\nx\n" }, planText: "spec-empty", specFilter: ["spec-empty"] });
	assert.ok(!r.ok);
	assert.ok(r.problems.some((p) => p.includes("没有可解析的编号用例") || p.includes("没有可覆盖的验收用例")));
});

// ------------------------------------------------------------------ rendering
check("matrix markdown marks missing coverage and is reproducible", () => {
	const cases = parseAcceptanceCases(SPECS[FH], FH);
	const plan = [`实现 ${FH}`, ...cases.slice(0, 15).map((c, i) => `| ${c.id} | T${i + 1} |`)].join("\n");
	const r = checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH] });
	const md = renderCoverageMatrix(r);
	assert.ok(md.includes("**缺失**"));
	assert.ok(md.includes("FH-16"));
	assert.ok(md.includes("未通过"));
	assert.equal(md, renderCoverageMatrix(checkCoverage({ specs: SPECS, planText: plan, specFilter: [FH] })));
});

check("matrix escapes a literal pipe inside scenario text", () => {
	// Markdown escapes a literal pipe as \| ; the parser must unescape it and the
	// renderer must re-escape it so the matrix table stays well-formed.
	const specs = { "spec-p": ["## 验收场景", "| AC-01 | a \\| b |"].join("\n") };
	const r = checkCoverage({ specs, planText: "spec-p\n| AC-01 | T1 |", specFilter: ["spec-p"] });
	assert.equal(r.cases[0].scenario, "a | b", `scenario must keep the whole text: ${r.cases[0].scenario}`);
	const row = renderCoverageMatrix(r).split("\n").find((l) => l.startsWith("| AC-01"))!;
	assert.ok(row.includes("\\|"), row);
	assert.equal(row.split(/(?<!\\)\|/).length, 6, row);
});

check("splitTableRow keeps escaped pipes as content", () => {
	assert.deepEqual(splitTableRow("| AC-01 | a \\| b | c |"), ["AC-01", "a | b", "c"]);
	assert.deepEqual(splitTableRow("| AC-01 | plain |"), ["AC-01", "plain"]);
});

check("nested acceptance subsections are all parsed (real spec shape)", () => {
	const md = [
		"## 5. 验收场景", "",
		"### 5.1 可自动化", "", "| AC-01 | a |", "",
		"### 5.2 真机", "", "| AC-02 | b |", "",
		"## 6. 依赖与待决项", "", "| DEP-09 | not a case |", "",
	].join("\n");
	const cases = parseAcceptanceCases(md, "s");
	assert.deepEqual(cases.map((c) => c.id), ["AC-01", "AC-02"], "subsections must not be dropped");
});

console.log("== coverage.ts tests ==");
for (const [name, fn] of tests) {
	try {
		fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
