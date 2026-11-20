// Full-chain verification (plan step 11): a real small task through
// L0 fail → fix → L1 fail → fix → L2 → pass, using the REAL toolchain and REAL
// L1/L2 child processes.
//
// Runs in a throwaway git repo so the user's in-progress specs are never touched.
// The scratch project gets copies of the verdict schema + constraint catalog so
// the children can read the same contracts they read in the real project.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReviewPipeline, type PipelineResult } from "./orchestrator.ts";
import { buildConstraintChecklist } from "./catalog.ts";
import { runReviewChild, parseAgentMd, type RunChildOptions, type RunChildResult } from "./child.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";

const REAL = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rd-fullchain-"));
const log = (m: string) => console.log(m);

const runner: CommandRunner = (command, args, options) =>
	new Promise<CommandResult>((resolve) => {
		execFile(command, args, {
			cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
		}, (error, stdout, stderr) => {
			const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
			resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

// ---- scratch project -------------------------------------------------------
fs.mkdirSync(path.join(scratch, ".pi", "review"), { recursive: true });
for (const f of ["verdict-schema.md", "constraint-catalog.md"]) {
	fs.copyFileSync(path.join(REAL, ".pi", "review", f), path.join(scratch, ".pi", "review", f));
}
fs.writeFileSync(path.join(scratch, "CMakeLists.txt"), [
	"cmake_minimum_required(VERSION 3.28)",
	"project(probe CXX)",
	"add_executable(probe main.cpp)",
	"enable_testing()",
	"add_test(NAME probe.run COMMAND probe)",
	"",
].join("\n"), "utf-8");
fs.writeFileSync(path.join(scratch, "CMakePresets.json"), JSON.stringify({
	version: 3,
	configurePresets: [{ name: "debug", binaryDir: "build/debug", generator: "Ninja", cacheVariables: { CMAKE_BUILD_TYPE: "Debug" } }],
	buildPresets: [{ name: "debug", configurePreset: "debug" }],
	testPresets: [{ name: "debug", configurePreset: "debug" }],
}, null, 2), "utf-8");

const MAIN = path.join(scratch, "main.cpp");
const BROKEN = "int main() { return 0; }\nsyntax error here!;\n";
// Compiles and the test passes, but the implementation contradicts a contract
// stated right above it. L0 cannot see this (the tested path is fine); L1 must
// catch it with file:line evidence. A stated contract makes this a real,
// non-speculative bug rather than an undefined-behaviour judgement call.
const BUGGY = [
	"// Thread: any",
	"// Contract: clamp(v, lo, hi) returns v limited to the closed range [lo, hi].",
	"int clamp(int v, int lo, int hi) {",
	"  if (v < lo) return lo;",
	"  return v;",
	"}",
	"int main() { return clamp(5, 0, 10) == 5 ? 0 : 1; }",
	"",
].join("\n");
const FIXED = [
	"// Thread: any",
	"// Contract: clamp(v, lo, hi) returns v limited to the closed range [lo, hi].",
	"int clamp(int v, int lo, int hi) {",
	"  if (v < lo) return lo;",
	"  if (v > hi) return hi;",
	"  return v;",
	"}",
	"int main() { return clamp(5, 0, 10) == 5 ? 0 : 1; }",
	"",
].join("\n");

const agentBody = (name: string) => parseAgentMd(fs.readFileSync(path.join(REAL, ".pi", "agents", name), "utf-8")).body;
const prompts = { L1: agentBody("reviewer-l1.md"), L2: agentBody("architect-l2.md") };
const checklist = buildConstraintChecklist(fs.readFileSync(path.join(REAL, ".pi", "review", "constraint-catalog.md"), "utf-8"));

interface ChildCall { layer: "L1" | "L2"; task: string; raw: string }
const calls: ChildCall[] = [];

async function round(label: string): Promise<PipelineResult> {
	calls.length = 0;
	// Diagnostics: on Windows a transient git failure used to surface as
	// "no-diff" and hide which command was empty. Print the raw state so a
	// failure is attributable instead of ambiguous.
	const status = await runner("git", ["status", "--porcelain"], { cwd: scratch });
	log(`  git status: exit=${status.exitCode} entries=${status.stdout.split("\n").filter(Boolean).length}`);
	const wrapped = async (o: RunChildOptions): Promise<RunChildResult> => {
		const layer: "L1" | "L2" = o.systemPrompt === prompts.L2 ? "L2" : "L1";
		const res = await runReviewChild(o);
		calls.push({ layer, task: o.userPrompt, raw: res.assistantText });
		return res;
	};
	log(`\n===== ${label} =====`);
	const r = await runReviewPipeline({
		cwd: scratch, run: runner, runChild: wrapped,
		systemPrompt: (l) => prompts[l], constraintChecklist: checklist, diffCap: 12000,
		onLog: (m) => log("  " + m),
	});
	log(`  outcome=${r.outcome} blocking=${r.blockingLayer ?? "-"}`);
	for (const l of ["L0", "L1", "L2"] as const) {
		const v = r.verdicts[l];
		if (v) log(`  ${l}: ${v.verdict} findings=${v.findings.length}`);
	}
	if (r.rejectionText) log("  rejection:\n" + r.rejectionText.split("\n").slice(0, 8).map((s) => "    " + s).join("\n"));
	return r;
}

const results: { name: string; pass: boolean; detail: string }[] = [];
const record = (name: string, pass: boolean, detail: string) => {
	results.push({ name, pass, detail });
	log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail.replace(/\n/g, "\n      ")}`);
};

async function main() {
	await runner("git", ["init", "-q"], { cwd: scratch });
	fs.writeFileSync(MAIN, BROKEN, "utf-8");
	// Mark the fixture files intent-to-add so `git diff` carries their CONTENT.
	// Plain untracked files only appear as a filename list, which made round 3's
	// one-line fix invisible to the diff hash.
	for (const f of ["main.cpp", "CMakeLists.txt", "CMakePresets.json"]) {
		await runner("git", ["add", "-N", f], { cwd: scratch });
	}
	const cfg = await runner("cmake", ["--preset", "debug"], { cwd: scratch, timeout: 180000 });
	log(`configure exit=${cfg.exitCode}`);

	// Round 1: compile error must block at L0 with zero LLM spend.
	const r1 = await round("round 1: broken syntax");
	record("L0 blocks a real compile error", r1.outcome === "blocked" && r1.blockingLayer === "L0", `outcome=${r1.outcome} layer=${r1.blockingLayer}`);
	record("no LLM child ran on broken code", calls.length === 0, `children=${calls.length}`);
	record("compiler evidence reaches the coder", /error|FAILED/.test(r1.rejectionText), r1.rejectionText.split("\n").slice(0, 3).join(" | "));

	// Round 2: compiles + test passes, but an unguarded divide() is a real bug.
	fs.writeFileSync(MAIN, BUGGY, "utf-8");
	const r2 = await round("round 2: compiles, unguarded divide()");
	record("L0 passes once the code builds and tests pass", r2.verdicts.L0?.verdict === "pass", `L0=${r2.verdicts.L0?.verdict}`);
	const l1 = r2.verdicts.L1;
	record("L1 ran on L0-approved code", Boolean(l1), `L1=${l1?.verdict ?? "absent"}`);
	const l1FoundBug = Boolean(l1 && l1.findings.some((f) => /clamp|hi|upper|上界|上限/i.test(String(f.evidence))));
	record("L1 caught the contract violation (missing upper clamp) with evidence", l1FoundBug,
		l1 ? l1.findings.map((f) => `${f.file}:${f.line} ${String(f.evidence).slice(0, 110)}`).join(" | ") || "(no findings)" : "(L1 absent)");
	const l1EvidenceOk = Boolean(l1 && l1.findings.every((f) => f.file && typeof f.line === "number" && (f.required_fix || f.failing_test)));
	record("every L1 finding carries file:line + a fix or failing test", l1EvidenceOk, `findings=${l1?.findings.length ?? 0}`);
	// Conditional: only meaningful when L1 actually blocked. If L1 passed, L2
	// running is correct behaviour, not a failure.
	if (r2.outcome === "blocked" && r2.blockingLayer === "L1") {
		record("L2 did not run while L1 blocked", !calls.some((c) => c.layer === "L2"), `L2 calls=${calls.filter((c) => c.layer === "L2").length}`);
	} else {
		log(`  note: L1 did not block (outcome=${r2.outcome}); L2 running is correct, assertion skipped`);
	}

	// Round 3: apply L1's fix, expect the whole chain to pass.
	fs.writeFileSync(MAIN, FIXED, "utf-8");
	const r3 = await round("round 3: guard applied");
	record("full chain passes after the evidence-backed fix", r3.outcome === "pass", `outcome=${r3.outcome} blocking=${r3.blockingLayer ?? "-"}`);
	record("all three layers produced verdicts", Boolean(r3.verdicts.L0 && r3.verdicts.L1 && r3.verdicts.L2),
		["L0", "L1", "L2"].map((l) => `${l}=${(r3.verdicts as any)[l]?.verdict ?? "-"}`).join(" "));

	// Anti-crosstalk on REAL child output: L2 must receive only the structured
	// projection of L1's verdict, never L1's raw prose.
	const l1Call = calls.find((c) => c.layer === "L1");
	const l2Call = calls.find((c) => c.layer === "L2");
	if (l1Call && l2Call) {
		record("L2 task carries L1's structured verdict", l2Call.task.includes('"layer": "L1"'), "structured projection present");
		record("L2 task carries the constraint checklist", /HANDOFF-1|PLAT-1|CONSTRAINT CHECKLIST/.test(l2Call.task), "checklist present");
		const rawOnly = l1Call.raw.replace(/\s+/g, " ").trim();
		const leaked = rawOnly.length > 0 && l2Call.task.replace(/\s+/g, " ").includes(rawOnly);
		record("L1's raw output is NOT pasted into L2's task", !leaked, `rawLen=${rawOnly.length} leaked=${leaked}`);
	} else {
		record("L1 and L2 both ran in the passing round", false, `L1=${Boolean(l1Call)} L2=${Boolean(l2Call)}`);
	}

	const failed = results.filter((r) => !r.pass);
	log(`\n${results.length - failed.length}/${results.length} passed`);
	log(`scratch: ${scratch}`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
