// A11 + B3 verification: the four-layer pipeline against a REAL toolchain and
// REAL cross-vendor panel children, inside a throwaway git repo.
//
// Proves (plan verification items #3 #6 #7 #8 #9 #12 #13):
//   - L0 red blocks before any LLM spend
//   - L1 catches a real contract violation with file:line evidence
//   - the L2 panel really runs on two different model families
//   - a panel member with no model access makes the panel BLOCKED (never PASS)
//   - L3 in print mode parks the machine; only an explicit decision advances it
//   - the evidence manifest recomputes independently
//   - autoCommit=false leaves the repository HEAD untouched
//
// The user's repository is never touched: everything happens in a temp sandbox.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCodePipeline } from "../../src/workflow/pipeline.ts";
import { assessRisk } from "../../src/review/risk.ts";
import { ArtifactStore, sha256 } from "../../src/evidence/store.ts";
import { loadConfig, type OrchestratorConfig } from "../../src/workflow/config.ts";
import { runReviewChild, parseAgentMd, type RunChildOptions, type RunChildResult } from "../../src/review/child.ts";
import { decideByCommand, loadDecision } from "../../src/evidence/human.ts";
import { buildConstraintChecklist } from "../../src/review/catalog.ts";
import type { CommandRunner, CommandResult } from "../../src/checks/l0.ts";

const REAL = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rd-4layer-"));
const results: { name: string; pass: boolean; detail: string }[] = [];
const log = (m: string) => console.log(m);
const record = (name: string, pass: boolean, detail: string) => {
	results.push({ name, pass, detail });
	log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail.replace(/\n/g, "\n      ")}`);
};

const runner: CommandRunner = (command, args, options) =>
	new Promise<CommandResult>((resolve) => {
		execFile(command, args, {
			cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
		}, (error, stdout, stderr) => {
			const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
			resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

// ---- sandbox project ----
// Mirror the real repo's ignore rules: build output is not a reviewed change.
// Without this the sandbox reports cmake's build/ tree as untracked "changes"
// and trips the forbidden-path rule, which the real repo never does.
fs.writeFileSync(path.join(sandbox, ".gitignore"), "/build/\n/.orchestrator/\n", "utf-8");
fs.mkdirSync(path.join(sandbox, ".pi", "review"), { recursive: true });
for (const f of ["verdict-schema.md", "constraint-catalog.md"]) {
	fs.copyFileSync(path.join(REAL, ".pi", "review", f), path.join(sandbox, ".pi", "review", f));
}
fs.writeFileSync(path.join(sandbox, "CMakeLists.txt"), [
	"cmake_minimum_required(VERSION 3.28)", "project(probe CXX)",
	"add_executable(probe main.cpp)", "enable_testing()",
	"add_test(NAME probe.run COMMAND probe)", "",
].join("\n"), "utf-8");
fs.writeFileSync(path.join(sandbox, "CMakePresets.json"), JSON.stringify({
	version: 3,
	configurePresets: [{ name: "debug", binaryDir: "build/debug", generator: "Ninja", cacheVariables: { CMAKE_BUILD_TYPE: "Debug" } }],
	buildPresets: [{ name: "debug", configurePreset: "debug" }],
	testPresets: [{ name: "debug", configurePreset: "debug" }],
}, null, 2), "utf-8");

const MAIN = path.join(sandbox, "main.cpp");
const BROKEN = "int main() { return 0; }\nsyntax error here!;\n";
const BUGGY = [
	"// Thread: any",
	"// Contract: clamp(v, lo, hi) returns v limited to the closed range [lo, hi].",
	"int clamp(int v, int lo, int hi) {",
	"  if (v < lo) return lo;",
	"  return v;",
	"}",
	"int main() { return clamp(5, 0, 10) == 5 ? 0 : 1; }", "",
].join("\n");
const FIXED = BUGGY.replace("  if (v < lo) return lo;\n", "  if (v < lo) return lo;\n  if (v > hi) return hi;\n");

const agentBody = (n: string) => parseAgentMd(fs.readFileSync(path.join(REAL, ".pi", "agents", n), "utf-8")).body;
const prompts = { L1: agentBody("reviewer-l1.md"), L2: agentBody("architect-l2.md") };
const checklist = buildConstraintChecklist(fs.readFileSync(path.join(REAL, ".pi", "review", "constraint-catalog.md"), "utf-8"));

// Small real panel: two DIFFERENT families, both verified reachable.
const cfg = loadConfig(REAL);
if (!cfg.ok) { console.error("config invalid:", cfg.errors.join("; ")); process.exit(1); }
function baseConfig(): OrchestratorConfig {
	const c = structuredClone(cfg.config!);
	c.panel.members = [
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
	];
	c.panel.quorum = 2;
	c.panel.minDistinctFamilies = 2;
	c.panel.concurrency = 2;
	c.panel.timeoutMs = 300_000;
	c.panel.thinking = "low";
	c.autoCommit = false;
	c.stages.code.panel = true;
	c.stages.code.human = true;
	return c;
}

interface Call { layer: "L1" | "L2"; model?: string; task: string; raw: string }
let calls: Call[] = [];

async function round(label: string, over: { config?: OrchestratorConfig; hasUI?: boolean; select?: string } = {}) {
	calls = [];
	const config = over.config ?? baseConfig();
	const store = new ArtifactStore({ cwd: sandbox, root: ".orchestrator", runId: "verify-run" });
	const wrapped = async (o: RunChildOptions): Promise<RunChildResult> => {
		const layer: "L1" | "L2" = o.systemPrompt === prompts.L2 ? "L2" : "L1";
		const res = await runReviewChild(o);
		calls.push({ layer, model: o.model, task: o.userPrompt, raw: res.assistantText });
		return res;
	};
	log(`\n===== ${label} =====`);
	const r = await runCodePipeline({
		cwd: sandbox, config, store, checkpointId: label.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
		run: runner, runChild: wrapped,
		systemPrompt: (l) => prompts[l], constraintChecklist: checklist,
		ui: {
			hasUI: over.hasUI ?? false,
			select: over.select ? async () => over.select : undefined,
			notify: (m) => log(`  [notify] ${m.split("\n")[0]}`),
		},
		coderModel: "hellocode/gpt-6-luna",
		assessRisk: (i) => assessRisk(config.risk, i),
		onLog: (m) => log("  " + m),
	});
	log(`  outcome=${r.outcome} state=${r.state} risk=${r.risk?.level ?? "-"}`);
	if (r.panel) log(`  panel=${r.panel.outcome} votes=${r.panel.validVotes}/${r.panel.quorum} families=${r.panel.votingFamilies.join(",")}`);
	return { r, store, config };
}

async function head(): Promise<string> {
	const h = await runner("git", ["rev-parse", "HEAD"], { cwd: sandbox });
	return h.stdout.trim() || "(no commits)";
}

async function main() {
	await runner("git", ["init", "-q"], { cwd: sandbox });
	await runner("git", ["config", "user.email", "probe@example.com"], { cwd: sandbox });
	await runner("git", ["config", "user.name", "probe"], { cwd: sandbox });
	fs.writeFileSync(MAIN, "int main() { return 0; }\n", "utf-8");
	await runner("git", ["add", "-A"], { cwd: sandbox });
	await runner("git", ["commit", "-qm", "baseline"], { cwd: sandbox });
	const headBefore = await head();
	const cfgExit = await runner("cmake", ["--preset", "debug"], { cwd: sandbox, timeout: 180_000 });
	log(`configure exit=${cfgExit.exitCode}, HEAD=${headBefore.slice(0, 8)}`);

	// ---- 1) L0 hard floor ----
	fs.writeFileSync(MAIN, BROKEN, "utf-8");
	const r1 = await round("round1 broken", {});
	record("#3 real compile error blocks at L0", r1.r.outcome === "blocked" && !r1.r.l1, `outcome=${r1.r.outcome} L1=${r1.r.l1 ? "ran" : "not run"}`);
	record("#3 zero LLM children on broken code", calls.length === 0, `children=${calls.length}`);

	// ---- 2) L1 catches a real contract violation ----
	fs.writeFileSync(MAIN, BUGGY, "utf-8");
	const r2 = await round("round2 contract violation", {});
	const l1Found = Boolean(r2.r.l1?.findings.some((f) => /clamp|hi|upper|上界|上限/i.test(String(f.evidence))));
	record("#3 L1 catches the contract violation with evidence", l1Found,
		r2.r.l1?.findings.map((f) => `${f.file}:${f.line} ${String(f.evidence).slice(0, 90)}`).join(" | ") || "(none)");
	record("#3 panel not started while L1 blocked", !calls.some((c) => c.layer === "L2"), `L2 calls=${calls.filter((c) => c.layer === "L2").length}`);

	// ---- 3) full pass path: real panel + print-mode L3 park ----
	fs.writeFileSync(MAIN, FIXED, "utf-8");
	const r3 = await round("round3 fixed", {});
	// state.json is the CURRENT machine state for the run (blueprint), so later
	// rounds overwrite it. Snapshot it now instead of reading it at the end.
	const state3 = r3.store.loadState<any>();
	const panelCalls = calls.filter((c) => c.layer === "L2");
	record("#1 panel really ran on two model families",
		panelCalls.length === 2 && new Set(panelCalls.map((c) => c.model)).size === 2,
		panelCalls.map((c) => c.model).join(", "));
	record("#4 panel members share one identical task", new Set(panelCalls.map((c) => c.task)).size <= 1, `distinct tasks=${new Set(panelCalls.map((c) => c.task)).size}`);
	record("#4 panel task carries structured L1 verdict + checklist",
		panelCalls.every((c) => c.task.includes('"layer": "L1"') && c.task.includes("HANDOFF-1")), "structured + checklist present");
	record("#6 print mode parks at AWAITING_HUMAN_REVIEW",
		r3.r.outcome === "awaiting-human" && r3.r.state === "AWAITING_HUMAN_REVIEW", `outcome=${r3.r.outcome} state=${r3.r.state}`);
	record("#6 no decision recorded without a human", loadDecision(r3.store, "round3-fixed") === undefined, "human-decision.json absent");

	const pkg = r3.r.reviewPackage;
	record("#8 review package written and hash-verifiable",
		Boolean(pkg) && r3.store.verifyEvidenceManifest(pkg!.dir).ok && pkg!.packageHash === sha256(pkg!.manifest),
		pkg ? `hash=${pkg.packageHash.slice(0, 12)} verify=${r3.store.verifyEvidenceManifest(pkg.dir).ok}` : "(no package)");
	if (pkg) {
		for (const line of pkg.manifest.split("\n").filter(Boolean)) {
			const i = line.indexOf("  ");
			const rel = line.slice(i + 2);
			const bytes = fs.readFileSync(r3.store.resolve(`${pkg.dir}/${rel}`));
			if (sha256(bytes) !== line.slice(0, i)) { record("#8 independent hash recomputation", false, rel); break; }
		}
		record("#8 independent hash recomputation", true, `${pkg.manifest.split("\n").filter(Boolean).length} files`);
	}
	for (const f of ["state.json", "checkpoints/round3-fixed/l0-results.json", "checkpoints/round3-fixed/l1-findings.json",
		"checkpoints/round3-fixed/l2-verdict.json", "checkpoints/round3-fixed/l2-panel.json"]) {
		if (!r3.store.exists(f)) { record("#8 blueprint evidence chain complete", false, `missing ${f}`); break; }
	}
	record("#8 blueprint evidence chain complete", true, "state/l0/l1/l2/panel present");

	// ---- 4) explicit decision advances the parked machine ----
	const decided = decideByCommand({
		store: r3.store, runId: r3.store.runId, checkpointId: "round3-fixed", stage: "code",
		packageHash: pkg!.packageHash, packageDir: pkg!.dir, decision: "approve",
	});
	record("#7 /orch approve resumes a print-mode wait", decided.ok && loadDecision(r3.store, "round3-fixed")?.decision === "approve",
		decided.error ?? `decision=${decided.record?.decision} via=${decided.record?.via}`);

	// ---- 5) a member without model access ⇒ BLOCKED, never PASS ----
	const broken = baseConfig();
	broken.panel.members = [
		{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
		{ model: "opencode-go/claude-haiku-5-5", family: "anthropic" }, // verified 403
	];
	const r4 = await round("round4 blocked panel", { config: broken });
	record("#3 unavailable member makes the panel BLOCKED", r4.r.panel?.outcome === "BLOCKED", `panel=${r4.r.panel?.outcome}`);
	record("#3 BLOCKED never reads as pass", r4.r.outcome !== "pass", `outcome=${r4.r.outcome}`);
	record("#9 BLOCKED raises a panel escalation", r4.r.escalations.some((e) => e.reason === "panel-unaggregatable"),
		r4.r.escalations.map((e) => e.reason).join(",") || "(none)");
	record("#9 escalation record persisted", r4.store.listEscalations().length > 0, `${r4.store.listEscalations().length} records`);

	// ---- 6) forbidden path always escalates ----
	fs.writeFileSync(path.join(sandbox, "third_party_probe.h"), "// forbidden\n", "utf-8");
	const forbCfg = baseConfig();
	forbCfg.risk.forbiddenPaths = [...forbCfg.risk.forbiddenPaths, "third_party_probe.h"];
	const r5 = await round("round5 forbidden path", { config: forbCfg });
	record("#9 forbidden path escalates", r5.r.escalations.some((e) => e.reason === "forbidden-path"),
		r5.r.escalations.map((e) => e.reason).join(",") || "(none)");
	fs.unlinkSync(path.join(sandbox, "third_party_probe.h"));

	// ---- 7) autoCommit=false must not touch the repository ----
	const headAfter = await head();
	record("#13 autoCommit=false leaves HEAD unchanged", headAfter === headBefore, `before=${headBefore.slice(0, 8)} after=${headAfter.slice(0, 8)}`);
	const st = await runner("git", ["status", "--short"], { cwd: sandbox });
	record("#13 working tree still holds the reviewed change", st.stdout.includes("main.cpp"), st.stdout.trim().split("\n")[0] ?? "(clean)");

	// ---- 8) risk routing recorded ----
	record("#12 state.json records risk and layer outcomes", Boolean(state3?.risk) && Boolean(state3?.layers?.panel),
		`risk=${state3?.risk} layers=${JSON.stringify(state3?.layers)}`);
	const ra = pkg ? r3.store.readText(`${pkg.dir}/risk-assessment.md`) ?? "" : "";
	record("#12 risk-assessment.md records the grade and gates", /level: (low|medium|high)/.test(ra) && ra.includes("L3 人类批准"),
		ra.split("\n").find((l) => l.startsWith("level:")) ?? "(missing)");

	const failed = results.filter((x) => !x.pass);
	log(`\n${results.length - failed.length}/${results.length} passed`);
	log(`sandbox: ${sandbox}`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
