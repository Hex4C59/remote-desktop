// Tests for config.ts — fail-closed validation of the deterministic config.
// Run: node --experimental-strip-types .pi/orchestrator/tests/workflow/config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { validateConfig, loadConfig } from "../../src/workflow/config.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

/** A known-good config, cloned per test so mutations stay local. */
function good(): any {
	return JSON.parse(fs.readFileSync(".pi/orchestrator/config.json", "utf-8"));
}

check("the shipped project config is valid", () => {
	const r = loadConfig(process.cwd());
	assert.ok(r.ok, r.errors.join("; "));
	assert.equal(r.config!.autoCommit, false, "autoCommit must default to false (it writes the repo)");
	assert.equal(r.config!.specStatusWrite, false, "must not silently approve specs (AGENTS.md)");
	assert.equal(r.config!.artifacts.gitignore, true);
});

check("panel members come from distinct families", () => {
	const c = good();
	c.panel.members[1].family = c.panel.members[0].family;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("distinct families")), r.errors.join("; "));
});

check("quorum larger than the panel is rejected (could never pass)", () => {
	const c = good();
	c.panel.quorum = c.panel.members.length + 1;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("exceeds member count")), r.errors.join("; "));
});

check("model must be provider/model-id", () => {
	const c = good();
	c.panel.members[0].model = "just-a-model-name";
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("provider/model-id")), r.errors.join("; "));
});

check("family is required (provider id is NOT the vendor)", () => {
	const c = good();
	delete c.panel.members[0].family;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("family")), r.errors.join("; "));
});

check("missing autoCommit is an error, not a silent default", () => {
	const c = good();
	delete c.autoCommit;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("autoCommit")), r.errors.join("; "));
});

check("missing specStatusWrite is an error", () => {
	const c = good();
	delete c.specStatusWrite;
	assert.ok(!validateConfig(c).ok);
});

check("non-boolean autoCommit is rejected", () => {
	const c = good();
	c.autoCommit = "yes";
	assert.ok(!validateConfig(c).ok);
});

check("mediumLines must be below highLines", () => {
	const c = good();
	c.risk.mediumLines = 500;
	c.risk.highLines = 100;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("smaller than")), r.errors.join("; "));
});

check("empty forbiddenPaths is rejected (a gate must not vanish)", () => {
	const c = good();
	c.risk.forbiddenPaths = [];
	assert.ok(!validateConfig(c).ok);
});

check("artifact root may not escape the project", () => {
	for (const bad of ["../outside", "/abs/path", "a/../../b"]) {
		const c = good();
		c.artifacts.root = bad;
		assert.ok(!validateConfig(c).ok, `root ${bad} must be rejected`);
	}
});

check("unknown stage l0 kind is rejected", () => {
	const c = good();
	c.stages.code.l0 = "vibes";
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("stages.code.l0")), r.errors.join("; "));
});

check("a missing stage is rejected", () => {
	const c = good();
	delete c.stages.plan;
	assert.ok(!validateConfig(c).ok);
});

check('panel/human accept boolean or "risk" only', () => {
	const c = good();
	c.stages.code.panel = "sometimes";
	assert.ok(!validateConfig(c).ok);
	const ok = good();
	ok.stages.code.panel = "risk";
	ok.stages.code.human = "risk";
	assert.ok(validateConfig(ok).ok);
});

check('deliverable stages reject "risk"/true human gates they cannot honour', () => {
	const riskSpec = good();
	riskSpec.stages.spec.human = "risk";
	const r1 = validateConfig(riskSpec);
	assert.ok(!r1.ok);
	assert.ok(r1.errors.some((e) => e.includes("stages.spec.human")), r1.errors.join("; "));

	const taskHuman = good();
	taskHuman.stages.task.human = true;
	const r2 = validateConfig(taskHuman);
	assert.ok(!r2.ok);
	assert.ok(r2.errors.some((e) => e.includes("stages.task.human")), r2.errors.join("; "));

	const discussionHuman = good();
	discussionHuman.stages.discussion.human = true;
	assert.ok(!validateConfig(discussionHuman).ok);
});

check('L2 panel is only allowed on spec/code with risk grading', () => {
	const planPanel = good();
	planPanel.stages.plan.panel = true;
	const r1 = validateConfig(planPanel);
	assert.ok(!r1.ok);
	assert.ok(r1.errors.some((e) => e.includes("stages.plan.panel")), r1.errors.join("; "));

	const specRisk = good();
	specRisk.stages.spec.panel = "risk";
	assert.ok(!validateConfig(specRisk).ok);
});

check("concurrency is capped at 3", () => {
	const c = good();
	c.panel.concurrency = 9;
	assert.ok(!validateConfig(c).ok);
});

check("invalid thinking level is rejected", () => {
	const c = good();
	c.panel.thinking = "ultra";
	assert.ok(!validateConfig(c).ok);
});

check("all problems are reported at once", () => {
	const c = good();
	delete c.autoCommit;
	c.panel.quorum = 99;
	c.risk.mediumLines = -1;
	const r = validateConfig(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.length >= 3, `expected several errors, got ${r.errors.length}`);
});

check("non-object and malformed JSON are reported, never thrown", () => {
	assert.ok(!validateConfig(null).ok);
	assert.ok(!validateConfig("nope").ok);
	assert.ok(!validateConfig([]).ok);
	const missing = loadConfig(process.cwd(), ".does-not-exist");
	assert.ok(!missing.ok);
	assert.ok(missing.errors[0].includes("cannot read"));
});

check("family values are normalised to lower case", () => {
	const c = good();
	c.panel.members[0].family = "DeepSeek";
	const r = validateConfig(c);
	assert.ok(r.ok, r.errors.join("; "));
	assert.equal(r.config!.panel.members[0].family, "deepseek");
});

console.log("== config.ts tests ==");
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
