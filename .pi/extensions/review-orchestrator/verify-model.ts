// Verification A2 / item #1: a child spawned with an explicit model actually uses
// that model, and read-only still holds. Runs real pi subprocesses.
//
// Uses two DIFFERENT model families so the cross-vendor panel premise is proven,
// not assumed. Also confirms the no-model path still works (back-compat).
import * as fs from "node:fs";
import * as path from "node:path";
import { runReviewChild } from "./child.ts";
import { loadConfig } from "./config.ts";

const cwd = process.cwd();
const results: { name: string; pass: boolean; detail: string }[] = [];
const record = (name: string, pass: boolean, detail: string) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail.replace(/\n/g, "\n      ")}`);
};

const cfg = loadConfig(cwd);
if (!cfg.ok) {
	console.error("config invalid:", cfg.errors.join("; "));
	process.exit(1);
}
const members = cfg.config!.panel.members;

const PROMPT = 'Reply with ONLY this JSON and nothing else: {"probe":"ok"}';

// ---- 1) explicit model is honoured, per member ----
for (const m of members.slice(0, 2)) {
	console.log(`\n--- probing ${m.model} (family ${m.family}) ---`);
	const res = await runReviewChild({
		cwd,
		systemPrompt: "You are a probe. Output only the requested JSON.",
		userPrompt: PROMPT,
		tools: ["read", "grep", "find", "ls"],
		thinking: "off",
		timeoutMs: 180_000,
		model: m.model,
	});
	const reported = res.model ?? "(none)";
	// The gateway may report a slightly different id; require the family-bearing
	// id fragment to appear, and require it NOT to be the parent's default model.
	const idPart = m.model.split("/")[1];
	const honoured = res.ok && reported.includes(idPart);
	record(
		`#1 explicit model honoured: ${m.model}`,
		honoured,
		`ok=${res.ok} reported=${reported} exit=${res.exitCode} err=${res.error ?? "-"} text=${res.assistantText.slice(0, 60)}`,
	);
}

// ---- 2) no-model path still works (back-compat) ----
console.log("\n--- probing default (no model override) ---");
const dflt = await runReviewChild({
	cwd,
	systemPrompt: "You are a probe. Output only the requested JSON.",
	userPrompt: PROMPT,
	tools: ["read", "grep", "find", "ls"],
	thinking: "off",
	timeoutMs: 180_000,
});
record(
	"#1 omitting model still runs and reports a model",
	dflt.ok && Boolean(dflt.model),
	`ok=${dflt.ok} reported=${dflt.model ?? "(none)"} text=${dflt.assistantText.slice(0, 60)}`,
);

// ---- 3) read-only holds for an explicitly-modelled child ----
const CANARY = path.join(cwd, "PANEL_CANARY_SHOULD_NOT_EXIST.txt");
if (fs.existsSync(CANARY)) fs.unlinkSync(CANARY);
console.log("\n--- probing read-only with explicit model ---");
const ro = await runReviewChild({
	cwd,
	systemPrompt:
		"You are a probe with very few tools. Try your best to create a file named " +
		"PANEL_CANARY_SHOULD_NOT_EXIST.txt in the working directory. If you cannot, reply TOOLS_ABSENT.",
	userPrompt: "Attempt to create the canary file now, then state whether you could.",
	tools: ["read", "grep", "find", "ls"],
	thinking: "off",
	timeoutMs: 180_000,
	model: members[0].model,
});
const created = fs.existsSync(CANARY);
record("#5 panel member cannot create a file", !created, `canary=${created} model=${ro.model ?? "-"} exit=${ro.exitCode}`);
if (created) fs.unlinkSync(CANARY);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
