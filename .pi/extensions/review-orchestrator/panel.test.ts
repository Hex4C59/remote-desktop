// Tests for panel.ts — cross-vendor membership resolution.
//
// The critical case: provider id ≠ vendor. A gateway (opencode-go) hosts many
// families; excluding by provider id would wipe out the whole panel.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/panel.test.ts
import assert from "node:assert/strict";
import { inferFamily, splitModel, resolvePanel, sameFamily } from "./panel.ts";
import { loadConfig, type OrchestratorConfig } from "./config.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

/** Build a config with an arbitrary panel, reusing the shipped valid sections. */
function withPanel(members: Array<{ model: string; family: string }>, quorum = 2, minFamilies = 2): OrchestratorConfig {
	const base = loadConfig(process.cwd());
	assert.ok(base.ok, base.errors.join("; "));
	const c = structuredClone(base.config!);
	c.panel.members = members;
	c.panel.quorum = quorum;
	c.panel.minDistinctFamilies = minFamilies;
	return c;
}

// ---------------------------------------------------------------- family inference
check("family is inferred from the model id, not the provider", () => {
	assert.equal(inferFamily("opencode-go/claude-haiku-5-5"), "anthropic");
	assert.equal(inferFamily("opencode-go/gemini-4-argon"), "google");
	assert.equal(inferFamily("opencode-go/glm-5.3"), "zhipu");
	assert.equal(inferFamily("opencode-go/grok-4.7"), "xai");
	assert.equal(inferFamily("opencode-go/gpt-6-luna"), "openai");
	assert.equal(inferFamily("opencode-go/deepseek-v4-pro"), "deepseek");
});

check("the same family is recognised across different gateways", () => {
	assert.equal(inferFamily("deepseek/deepseek-v4-pro"), "deepseek");
	assert.equal(inferFamily("trae-cn/deepseek-v4.1-flash"), "deepseek");
	assert.equal(inferFamily("opencode-go/deepseek-v4-pro"), "deepseek");
	assert.equal(inferFamily("hellocode/gpt-6-luna"), "openai");
	assert.equal(inferFamily("github-copilot/gpt-4.1"), "openai");
	assert.equal(inferFamily("qoder/Qwen4-Max-Preview"), "qwen");
	assert.equal(inferFamily("Aimsl/qwen3.8-27b"), "qwen");
});

check("codex is an openai model", () => {
	assert.equal(inferFamily("hellocode/codex-auto-review"), "openai");
});

check("an unrecognised model is NOT silently grouped with a known vendor", () => {
	const f = inferFamily("someprovider/totally-new-model");
	assert.ok(f.startsWith("unknown:"), f);
	for (const known of ["deepseek/deepseek-v4-pro", "hellocode/gpt-6-luna", "qoder/Qwen4-Max-Preview"]) {
		assert.notEqual(f, inferFamily(known), "unknown must not collide with a known vendor");
	}
});

check("two DIFFERENT unrecognised models are not one vendor", () => {
	assert.notEqual(inferFamily("x/alpha-model"), inferFamily("y/beta-model"));
});

check("the SAME unrecognised model id behind two gateways IS one vendor", () => {
	// Family comes from the model id, so the same model is the same vendor even
	// when reached through different providers.
	assert.equal(inferFamily("x/alpha-model"), inferFamily("y/alpha-model"));
});

check("splitModel handles bare ids and provider prefixes", () => {
	assert.deepEqual(splitModel("deepseek/deepseek-v4-pro"), { provider: "deepseek", id: "deepseek-v4-pro" });
	assert.deepEqual(splitModel("bare-model"), { id: "bare-model" });
	assert.deepEqual(splitModel("  a/b  "), { provider: "a", id: "b" });
});

check("sameFamily compares vendors across gateways", () => {
	assert.ok(sameFamily("deepseek/deepseek-v4-pro", "trae-cn/deepseek-v4.1-flash"));
	assert.ok(sameFamily("hellocode/gpt-6-luna", "github-copilot/gpt-4.1"));
	assert.ok(!sameFamily("deepseek/deepseek-v4-pro", "qoder/Qwen4-Max-Preview"));
});

// ------------------------------------------------------- THE provider≠vendor trap
check("#2 coder on a gateway excludes only its own family, not the whole gateway", () => {
	// Panel deliberately mixes families behind the SAME gateway plus a direct one.
	const c = withPanel([
		{ model: "opencode-go/claude-haiku-5-5", family: "anthropic" },
		{ model: "opencode-go/gemini-4-argon", family: "google" },
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "opencode-go/gpt-6-luna", family: "openai" },
	]);
	// Coder uses the same gateway, but an OpenAI-family model.
	const r = resolvePanel(c, "opencode-go/gpt-6-luna");
	assert.ok(r.ok, r.errors.join("; "));
	assert.equal(r.coderFamily, "openai");
	assert.deepEqual(r.excluded.map((m) => m.model), ["opencode-go/gpt-6-luna"]);
	const kept = r.members.map((m) => m.model);
	assert.ok(kept.includes("opencode-go/claude-haiku-5-5"), "same-gateway anthropic member must survive");
	assert.ok(kept.includes("opencode-go/gemini-4-argon"), "same-gateway google member must survive");
	assert.ok(kept.includes("deepseek/deepseek-v4-pro"));
	assert.equal(r.members.length, 3, "only the openai-family member is removed");
});

check("#2 coder on deepseek excludes the deepseek family across gateways", () => {
	const c = withPanel([
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "trae-cn/deepseek-v4.1-flash", family: "deepseek" },
		{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
		{ model: "hellocode/gpt-6-luna", family: "openai" },
	]);
	const r = resolvePanel(c, "deepseek/deepseek-v4-pro");
	assert.ok(r.ok, r.errors.join("; "));
	assert.equal(r.excluded.length, 2, "both deepseek models removed regardless of gateway");
	assert.deepEqual(r.families.sort(), ["openai", "qwen"]);
});

check("the shipped config survives excluding each of its own families", () => {
	const c = loadConfig(process.cwd()).config!;
	for (const m of c.panel.members) {
		const r = resolvePanel(c, m.model);
		assert.ok(r.ok, `coder=${m.model} → ${r.errors.join("; ")}`);
		assert.ok(!r.families.includes(m.family), "coder family must be gone");
		assert.ok(r.members.length >= c.panel.quorum);
		assert.ok(r.families.length >= c.panel.minDistinctFamilies);
	}
});

check("no coder model → full panel is used", () => {
	const c = loadConfig(process.cwd()).config!;
	const r = resolvePanel(c);
	assert.ok(r.ok);
	assert.equal(r.members.length, c.panel.members.length);
	assert.equal(r.excluded.length, 0);
});

// ------------------------------------------------------------------ fail-closed
check("panel that cannot reach quorum after exclusion is reported", () => {
	const c = withPanel([
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
	], 2, 2);
	const r = resolvePanel(c, "deepseek/deepseek-v4-pro");
	assert.ok(!r.ok, "only one member would remain but quorum is 2");
	assert.ok(r.errors.some((e) => e.includes("quorum")));
});

check("panel that loses vendor independence after exclusion is reported", () => {
	const c = withPanel([
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "trae-cn/deepseek-v4.1-flash", family: "deepseek" },
		{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
	], 2, 2);
	const r = resolvePanel(c, "qoder/Qwen4-Max-Preview");
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("distinct family")));
});

check("unknown coder family warns instead of silently claiming independence", () => {
	const c = loadConfig(process.cwd()).config!;
	const r = resolvePanel(c, "mystery/brand-new-model");
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("cannot infer")));
});

check("multiple unknown-family members cannot count as distinct vendors", () => {
	const c = withPanel([
		{ model: "x/model-one", family: "unknown:model-one" },
		{ model: "y/model-two", family: "unknown:model-two" },
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
	], 2, 2);
	const r = resolvePanel(c);
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("unrecognised families")));
});

check("explicit family overrides beat inference", () => {
	const c = withPanel([
		{ model: "gateway/mystery-a", family: "anthropic" },
		{ model: "gateway/mystery-b", family: "google" },
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
	]);
	// Coder id looks unknown, but the caller declares its family authoritatively.
	const r = resolvePanel(c, "gateway/mystery-c", { "gateway/mystery-c": "deepseek" });
	assert.ok(r.ok, r.errors.join("; "));
	assert.equal(r.coderFamily, "deepseek");
	assert.deepEqual(r.excluded.map((m) => m.model), ["deepseek/deepseek-v4-pro"]);
});

console.log("== panel.ts tests ==");
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
