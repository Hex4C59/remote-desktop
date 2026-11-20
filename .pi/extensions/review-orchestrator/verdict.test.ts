// Standalone test for verdict.ts — pure logic, no Pi.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/verdict.test.ts
import assert from "node:assert/strict";
import { extractJson, validateVerdict, parseAndValidate, isBlocking, formatFindingsForCoder } from "./verdict.ts";

let passed = 0;
function check(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}

console.log("== verdict.ts tests ==");

check("extractJson ignores prose before/after", () => {
	const t = "Here is my verdict:\n```json\n{\"layer\":\"L1\",\"verdict\":\"pass\",\"findings\":[],\"summary\":\"ok\"}\n```\nDone.";
	const obj = extractJson(t) as any;
	assert.equal(obj.layer, "L1");
	assert.equal(obj.verdict, "pass");
});

check("extractJson handles nested braces/strings", () => {
	const t = 'prefix {"layer":"L0","verdict":"fail","findings":[{"evidence":"a {b} c \\"d\\""}]} suffix';
	const obj = extractJson(t) as any;
	assert.equal(obj.findings[0].evidence, 'a {b} c "d"');
});

check("extractJson returns null when no object", () => {
	assert.equal(extractJson("no json here"), null);
});

// Regression: JSON only allows double-quoted strings. Treating ' as a string
// delimiter made any prose with an odd number of apostrophes (Reviewer's,
// don't, it's) swallow the whole verdict, so a valid review was rejected as
// "裁决不合规" and needlessly retried.
check("extractJson tolerates an apostrophe in prose before the JSON", () => {
	const obj = extractJson('Reviewer\'s verdict:\n{"layer":"L1","verdict":"pass","findings":[],"summary":"ok"}') as any;
	assert.ok(obj, "apostrophe in prose must not swallow the JSON");
	assert.equal(obj.verdict, "pass");
});

check("extractJson tolerates contractions in prose (don't / it's)", () => {
	const obj = extractJson('I don\'t see issues; it\'s fine.\n{"layer":"L1","verdict":"pass","findings":[],"summary":"ok"}') as any;
	assert.ok(obj, "contractions must not swallow the JSON");
	assert.equal(obj.layer, "L1");
});

check("extractJson keeps apostrophes INSIDE json string values", () => {
	const obj = extractJson('{"layer":"L1","verdict":"pass","findings":[],"summary":"it\'s fine"}') as any;
	assert.ok(obj);
	assert.equal(obj.summary, "it's fine");
});

check("valid L1 pass verdict", () => {
	const r = validateVerdict(
		{ layer: "L1", verdict: "pass", findings: [], summary: "clean" },
		"L1",
	);
	assert.ok(r.ok, r.errors.join("; "));
});

check("L1 missing line is rejected", () => {
	const r = validateVerdict(
		{ layer: "L1", verdict: "fail", findings: [{ file: "a.cpp", evidence: "bug", required_fix: "fix" }], summary: "x" },
		"L1",
	);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("line")), r.errors.join("; "));
});

check("L1 non-evidence wording without required_fix/failing_test rejected", () => {
	const r = validateVerdict(
		{ layer: "L1", verdict: "fail", findings: [{ file: "a.cpp", line: 3, evidence: "consider improving" }], summary: "x" },
		"L1",
	);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("required_fix")), r.errors.join("; "));
});

check("L2 evidence without constraint ID is rejected", () => {
	const r = validateVerdict(
		{ layer: "L2", verdict: "fail", findings: [{ file: "a.cpp", line: 1, evidence: "bad code smell", required_fix: "x" }], summary: "x" },
		"L2",
	);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("constraint ID")), r.errors.join("; "));
});

check("L2 evidence with constraint ID accepted", () => {
	const r = validateVerdict(
		{ layer: "L2", verdict: "fail", findings: [{ file: "a.cpp", line: 1, evidence: "violates HANDOFF-1 and spec-platform-win:PW-03", required_fix: "x" }], summary: "x" },
		"L2",
	);
	assert.ok(r.ok, r.errors.join("; "));
});

check("L2 layer mismatch rejected", () => {
	const r = validateVerdict(
		{ layer: "L1", verdict: "pass", findings: [], summary: "x" },
		"L2",
	);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("expected")), r.errors.join("; "));
});

check("L0 without checks rejected", () => {
	const r = validateVerdict(
		{ layer: "L0", verdict: "pass", findings: [], summary: "x" },
		"L0",
	);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("checks")), r.errors.join("; "));
});

check("L0 with checks accepted", () => {
	const r = validateVerdict(
		{ layer: "L0", verdict: "fail", findings: [], summary: "x", checks: [{ name: "build", exit_code: 1 }] },
		"L0",
	);
	assert.ok(r.ok, r.errors.join("; "));
});

check("parseAndValidate on real L1 smoke output", () => {
	const t = '{"layer":"L1","verdict":"fail","findings":[{"severity":"warning","file":"docs/platform-abstraction.md","line":76,"evidence":"contract contradiction","required_fix":"align specs"}],"summary":"L1 failed"}';
	const r = parseAndValidate(t, "L1");
	assert.ok(r.ok, r.errors.join("; "));
	assert.ok(isBlocking(r.verdict!));
});

check("isBlocking: pass with only suggestion is not blocking", () => {
	const r = validateVerdict(
		{ layer: "L2", verdict: "pass", findings: [{ severity: "suggestion", uncertain: true, file: "a", line: 1, evidence: "PLAT-1 maybe", required_fix: "x" }], summary: "x" },
		"L2",
	);
	assert.ok(r.ok);
	assert.equal(isBlocking(r.verdict!), false);
});

check("formatFindingsForCoder drops non-blocking suggestions", () => {
	const r = validateVerdict(
		{ layer: "L1", verdict: "fail", findings: [
			{ severity: "warning", file: "a.cpp", line: 5, evidence: "null deref", required_fix: "guard" },
			{ severity: "suggestion", file: "a.cpp", line: 9, evidence: "style nit", required_fix: "rename" },
		], summary: "x" },
		"L1",
	);
	const out = formatFindingsForCoder(r.verdict!);
	assert.ok(out.includes("a.cpp:5"));
	assert.ok(!out.includes("a.cpp:9"));
});

console.log(`\n${passed} checks passed, ${process.exitCode ? "SOME FAILED" : "all green"}`);
