// Tests for aggregate.ts — the panel verdict is computed by a script, never by
// asking a model to summarise the panel.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/aggregate.test.ts
import assert from "node:assert/strict";
import { aggregatePanel, panelToVerdict, type PanelVote } from "./aggregate.ts";
import type { ParsedVerdict } from "./verdict.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

function verdict(v: "pass" | "fail", findings: any[] = [], layer: "L2" = "L2"): ParsedVerdict {
	return { layer, verdict: v, findings, summary: "s", raw: {} };
}
function vote(model: string, family: string, v: ParsedVerdict): PanelVote {
	return { model, family, valid: true, verdict: v };
}
function absent(model: string, family: string, reason: string): PanelVote {
	return { model, family, valid: false, failureReason: reason };
}
const blocker = (file = "a.cpp", line = 5, evidence = "violates HANDOFF-1") => ({
	severity: "warning", file, line, evidence, required_fix: "fix it",
});

const A = (v: ParsedVerdict) => vote("deepseek/deepseek-v4-pro", "deepseek", v);
const B = (v: ParsedVerdict) => vote("opencode-go/claude-haiku-5-5", "anthropic", v);
const C = (v: ParsedVerdict) => vote("opencode-go/gemini-4-argon", "google", v);

check("all pass across families → PASS", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("pass")), C(verdict("pass"))], 2);
	assert.equal(agg.outcome, "PASS");
	assert.equal(agg.validVotes, 3);
	assert.deepEqual(agg.votingFamilies.sort(), ["anthropic", "deepseek", "google"]);
	assert.equal(agg.blockingFindings.length, 0);
});

check("a single FAIL blocks the whole panel (no averaging away)", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("fail", [blocker()])), C(verdict("pass"))], 2);
	assert.equal(agg.outcome, "FAIL");
	assert.equal(agg.blockingFindings.length, 1);
	assert.equal(agg.blockingFindings[0].family, "anthropic");
});

check("a pass verdict carrying a warning still blocks", () => {
	const agg = aggregatePanel([A(verdict("pass", [blocker()])), B(verdict("pass"))], 2);
	assert.equal(agg.outcome, "FAIL");
});

check("suggestions never block", () => {
	const sug = { severity: "suggestion", file: "a.cpp", line: 1, evidence: "PLAT-1 nit", required_fix: "x" };
	const agg = aggregatePanel([A(verdict("pass", [sug])), B(verdict("pass"))], 2);
	assert.equal(agg.outcome, "PASS");
	assert.equal(agg.blockingFindings.length, 0);
});

check("quorum not reached → BLOCKED, never PASS", () => {
	const agg = aggregatePanel([A(verdict("pass")), absent("m2", "anthropic", "timeout"), absent("m3", "google", "403")], 2);
	assert.equal(agg.outcome, "BLOCKED");
	assert.ok(agg.reasons.some((r) => r.includes("quorum not reached")));
	assert.equal(agg.absent.length, 2);
});

check("all members absent → BLOCKED", () => {
	const agg = aggregatePanel([absent("m1", "deepseek", "403"), absent("m2", "anthropic", "403")], 2);
	assert.equal(agg.outcome, "BLOCKED");
	assert.equal(agg.validVotes, 0);
});

check("a malformed verdict counts as absent, not as a pass", () => {
	const bad: PanelVote = { model: "m2", family: "anthropic", valid: false, failureReason: "not valid verdict JSON" };
	const agg = aggregatePanel([A(verdict("pass")), bad, C(verdict("pass"))], 3);
	assert.equal(agg.outcome, "BLOCKED");
	assert.ok(agg.reasons.some((r) => r.includes("not valid verdict JSON")));
});

check("failure reasons are preserved for escalation (403 vs timeout)", () => {
	const agg = aggregatePanel([
		A(verdict("pass")),
		absent("m2", "anthropic", "model error (error): 403 Model access is disabled"),
		absent("m3", "google", "timed out after 480000ms"),
	], 2);
	assert.equal(agg.outcome, "BLOCKED");
	assert.ok(agg.reasons.some((r) => r.includes("403")));
	assert.ok(agg.reasons.some((r) => r.includes("timed out")));
});

check("same-family echo cannot satisfy vendor independence", () => {
	const v1 = vote("deepseek/deepseek-v4-pro", "deepseek", verdict("pass"));
	const v2 = vote("deepseek/deepseek-flash", "deepseek", verdict("pass"));
	const agg = aggregatePanel([v1, v2], 2, { minDistinctFamilies: 2 });
	assert.equal(agg.outcome, "BLOCKED", "two votes from one vendor are not an independent review");
	assert.ok(agg.reasons.some((r) => r.includes("vendor independence")));
});

check("distinct families satisfy the independence requirement", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("pass"))], 2, { minDistinctFamilies: 2 });
	assert.equal(agg.outcome, "PASS");
});

check("duplicate findings across members are deduped", () => {
	const same = blocker("a.cpp", 5, "violates HANDOFF-1");
	const agg = aggregatePanel([A(verdict("fail", [same])), B(verdict("fail", [{ ...same }]))], 2);
	assert.equal(agg.outcome, "FAIL");
	assert.equal(agg.blockingFindings.length, 1, "same file:line:evidence must collapse");
});

check("distinct findings from different members are all kept", () => {
	const agg = aggregatePanel([
		A(verdict("fail", [blocker("a.cpp", 5, "violates HANDOFF-1")])),
		B(verdict("fail", [blocker("b.cpp", 9, "violates PLAT-3")])),
	], 2);
	assert.equal(agg.blockingFindings.length, 2);
});

check("empty panel → BLOCKED", () => {
	const agg = aggregatePanel([], 1);
	assert.equal(agg.outcome, "BLOCKED");
});

check("quorum exactly met passes", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("pass")), absent("m3", "google", "timeout")], 2);
	assert.equal(agg.outcome, "PASS");
	assert.equal(agg.absent.length, 1);
});

// ---- panelToVerdict: BLOCKED must not read as a pass ----
check("BLOCKED becomes a fail verdict with a human-decision finding", () => {
	const agg = aggregatePanel([A(verdict("pass")), absent("m2", "anthropic", "403")], 2);
	const v = panelToVerdict(agg);
	assert.equal(v.layer, "L2");
	assert.equal(v.verdict, "fail", "BLOCKED must never be surfaced as pass");
	assert.equal(v.panel.outcome, "BLOCKED");
	assert.ok(v.findings[0].evidence.includes("PANEL-BLOCKED"));
	assert.ok(v.findings[0].required_fix.includes("人工"));
	assert.equal(v.findings[0].uncertain, true);
});

check("FAIL becomes a fail verdict carrying member evidence", () => {
	const agg = aggregatePanel([A(verdict("fail", [blocker()])), B(verdict("pass"))], 2);
	const v = panelToVerdict(agg);
	assert.equal(v.verdict, "fail");
	assert.equal(v.panel.outcome, "FAIL");
	assert.ok(v.findings[0].evidence.includes("deepseek"));
	assert.ok(v.findings[0].evidence.includes("HANDOFF-1"));
	assert.equal(v.findings[0].file, "a.cpp");
	assert.equal(v.findings[0].line, 5);
});

check("PASS becomes a pass verdict with no findings", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("pass"))], 2);
	const v = panelToVerdict(agg);
	assert.equal(v.verdict, "pass");
	assert.deepEqual(v.findings, []);
	assert.equal(v.panel.outcome, "PASS");
});

check("summary records quorum, votes, families and absence for audit", () => {
	const agg = aggregatePanel([A(verdict("pass")), B(verdict("pass")), absent("m3", "google", "timeout")], 2);
	const v = panelToVerdict(agg);
	assert.ok(v.summary.includes("2/2"));
	assert.ok(v.summary.includes("deepseek"));
	assert.ok(v.summary.includes("缺席 1"));
});

console.log("== aggregate.ts tests ==");
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
