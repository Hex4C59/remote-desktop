// Tests for l0-stages.ts — every deliverable stage has its own deterministic floor.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/l0-stages.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	TASK_REQUIRED_SECTIONS, checkTaskStructure, loadSpecs, runDiscussionL0,
	runPlanL0, runSpecL0, runStageL0, runTaskL0,
} from "./l0-stages.ts";
import { validateVerdict } from "./verdict.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const OK = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const REAL = process.cwd();

function sandbox(): { cwd: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-l0stage-"));
	return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function runner(map: Record<string, CommandResult>): { run: CommandRunner; calls: string[] } {
	const calls: string[] = [];
	const run: CommandRunner = async (cmd, args) => {
		const key = `${cmd} ${args.join(" ")}`;
		calls.push(key);
		for (const [prefix, result] of Object.entries(map)) {
			if (key.startsWith(prefix)) return result;
		}
		throw new Error(`unexpected command: ${key}`);
	};
	return { run, calls };
}

// ------------------------------------------------------------------ discussion
check("discussion has no mechanical gate, stated explicitly", () => {
	const v = runDiscussionL0();
	assert.equal(v.verdict, "pass");
	assert.ok(v.summary.includes("不适用"));
	assert.ok(validateVerdict(v, "L0").ok);
});

// ------------------------------------------------------------------ spec stage
check("#14 spec L0 runs the project checker and passes on exit 0", async () => {
	const s = sandbox();
	try {
		fs.mkdirSync(path.join(s.cwd, "tools"), { recursive: true });
		fs.writeFileSync(path.join(s.cwd, "tools", "check_specs.py"), "# stub\n");
		const r = runner({ "python tools/check_specs.py": OK("all specs ok") });
		const v = await runSpecL0({ cwd: s.cwd, run: r.run, kind: "specs" });
		assert.equal(v.verdict, "pass");
		assert.deepEqual(r.calls, ["python tools/check_specs.py"]);
		assert.equal(v.checks?.[0].name, "spec.structure");
		assert.equal(v.checks?.[0].exit_code, 0);
		assert.ok(validateVerdict(v, "L0").ok);
	} finally { s.cleanup(); }
});

check("#14 spec L0 fails on a non-zero exit and keeps the log", async () => {
	const s = sandbox();
	try {
		fs.mkdirSync(path.join(s.cwd, "tools"), { recursive: true });
		fs.writeFileSync(path.join(s.cwd, "tools", "check_specs.py"), "# stub\n");
		const r = runner({ "python tools/check_specs.py": { exitCode: 1, stdout: "spec-x.md: 第 3 行必须是 status", stderr: "" } });
		const v = await runSpecL0({ cwd: s.cwd, run: r.run, kind: "specs" });
		assert.equal(v.verdict, "fail");
		assert.ok(v.findings[0].evidence.includes("第 3 行"));
		assert.ok(validateVerdict(v, "L0").ok);
	} finally { s.cleanup(); }
});

check("a missing spec checker is a red gate, not a silent pass", async () => {
	const s = sandbox();
	try {
		const v = await runSpecL0({ cwd: s.cwd, run: async () => OK(), kind: "specs" });
		assert.equal(v.verdict, "fail");
		assert.ok(v.findings[0].evidence.includes("不存在"));
	} finally { s.cleanup(); }
});

check("#14 spec L0 against the REAL project passes", async () => {
	const { execFile } = await import("node:child_process");
	const real: CommandRunner = (cmd, args, opts) => new Promise<CommandResult>((resolve) => {
		execFile(cmd, args, { cwd: opts?.cwd, windowsHide: true }, (err, stdout, stderr) => {
			const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
			resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
	const v = await runSpecL0({ cwd: REAL, run: real, kind: "specs" });
	assert.equal(v.verdict, "pass", v.findings.map((f) => f.evidence).join("; "));
});

// ------------------------------------------------------------------ plan stage
const SPEC = ["# spec-t", "", "## 5. 验收场景", "", "| AC-01 | a |", "| AC-02 | b |", ""].join("\n");

check("#14 plan L0 passes when every acceptance case has a task", () => {
	const r = runPlanL0({
		cwd: ".", run: async () => OK(), kind: "coverage",
		specs: { "spec-t": SPEC }, planText: "实现 spec-t\n| AC-01 | T1 |\n| AC-02 | T2 |",
	});
	assert.equal(r.verdict.verdict, "pass");
	assert.deepEqual(r.coverage.missing, []);
	assert.ok(r.markdown.includes("AC-01"));
	assert.ok(validateVerdict(r.verdict, "L0").ok);
});

check("#14 plan L0 is RED on missing coverage and lists the ids", () => {
	const r = runPlanL0({
		cwd: ".", run: async () => OK(), kind: "coverage",
		specs: { "spec-t": SPEC }, planText: "实现 spec-t\n| AC-01 | T1 |",
	});
	assert.equal(r.verdict.verdict, "fail");
	assert.deepEqual(r.coverage.missing, ["AC-02"]);
	assert.ok(r.verdict.findings.some((f) => f.evidence.includes("AC-02")));
	assert.ok(r.markdown.includes("**缺失**"));
	assert.ok(validateVerdict(r.verdict, "L0").ok);
});

check("plan L0 without specs cannot pass", () => {
	const r = runPlanL0({ cwd: ".", run: async () => OK(), kind: "coverage", specs: {}, planText: "x" });
	assert.equal(r.verdict.verdict, "fail");
	assert.ok(r.verdict.findings[0].evidence.includes("specs"));
});

// ------------------------------------------------------------------ task stage
const GOOD_TASK = [
	"# TASK", "",
	"## 目标", "实现帧槽上界", "",
	"## 验收依据", "FH-01, FH-02", "",
	"## 变更范围", "src/capture/frame_slot.cpp", "",
	"## 验证方式", "ctest --preset debug -R capture", "",
].join("\n");

check("#14 task L0 passes on a complete TASK.md", () => {
	const s = sandbox();
	try {
		fs.writeFileSync(path.join(s.cwd, "TASK.md"), GOOD_TASK);
		const r = runTaskL0({ cwd: s.cwd, run: async () => OK(), kind: "task" });
		assert.equal(r.verdict.verdict, "pass");
		assert.deepEqual(r.structure.caseIds, ["FH-01", "FH-02"]);
		assert.ok(validateVerdict(r.verdict, "L0").ok);
	} finally { s.cleanup(); }
});

check("#14 a missing TASK.md is red", () => {
	const s = sandbox();
	try {
		const r = runTaskL0({ cwd: s.cwd, run: async () => OK(), kind: "task" });
		assert.equal(r.verdict.verdict, "fail");
		assert.ok(r.verdict.findings[0].evidence.includes("不存在"));
	} finally { s.cleanup(); }
});

check("#14 each required section is enforced individually", () => {
	for (const section of TASK_REQUIRED_SECTIONS) {
		const text = GOOD_TASK.replace(new RegExp(`## ${section.key}\\n[^\\n]*\\n`), "");
		const r = checkTaskStructure(text);
		assert.ok(!r.ok, `removing ${section.key} must fail`);
		assert.ok(r.missingSections.includes(section.key), `${section.key} not reported: ${r.missingSections.join(",")}`);
	}
});

check("a task with no acceptance reference cannot be traced and is red", () => {
	const r = checkTaskStructure(GOOD_TASK.replace("FH-01, FH-02", "见规格"));
	assert.ok(!r.ok);
	assert.ok(r.problems.some((p) => p.includes("验收编号")));
});

check("an empty TASK.md is red with all sections missing", () => {
	const r = checkTaskStructure("   \n");
	assert.ok(!r.ok);
	assert.equal(r.missingSections.length, TASK_REQUIRED_SECTIONS.length);
});

check("english section labels are accepted", () => {
	const en = ["## Goal", "x", "## Acceptance", "FH-01", "## Scope", "src/a.cpp", "## Verification", "ctest"].join("\n");
	assert.ok(checkTaskStructure(en).ok);
});

// ------------------------------------------------------------------ dispatch
check("runStageL0 dispatches by kind", async () => {
	const s = sandbox();
	try {
		fs.mkdirSync(path.join(s.cwd, "tools"), { recursive: true });
		fs.writeFileSync(path.join(s.cwd, "tools", "check_specs.py"), "# stub\n");
		fs.writeFileSync(path.join(s.cwd, "TASK.md"), GOOD_TASK);
		const r = runner({ "python tools/check_specs.py": OK(), "cmake": OK(), "ctest": OK("100% tests passed") });

		assert.equal((await runStageL0({ cwd: s.cwd, run: r.run, kind: "none" })).verdict.verdict, "pass");
		assert.equal((await runStageL0({ cwd: s.cwd, run: r.run, kind: "specs" })).verdict.verdict, "pass");
		assert.equal((await runStageL0({ cwd: s.cwd, run: r.run, kind: "task" })).verdict.verdict, "pass");
		const build = await runStageL0({ cwd: s.cwd, run: r.run, kind: "build" });
		assert.equal(build.verdict.verdict, "pass");
		assert.ok(r.calls.some((c) => c.startsWith("cmake")));
		assert.ok(r.calls.some((c) => c.startsWith("ctest")));
	} finally { s.cleanup(); }
});

check("plan dispatch loads real specs from disk and reports coverage", async () => {
	const s = sandbox();
	try {
		fs.mkdirSync(path.join(s.cwd, "specs"), { recursive: true });
		fs.writeFileSync(path.join(s.cwd, "specs", "spec-t.md"), SPEC);
		const r = await runStageL0({ cwd: s.cwd, run: async () => OK(), kind: "coverage", planText: "spec-t\n| AC-01 | T1 |" });
		assert.equal(r.verdict.verdict, "fail");
		assert.deepEqual(r.coverage?.missing, ["AC-02"]);
		assert.ok(r.coverageMarkdown?.includes("AC-02"));
	} finally { s.cleanup(); }
});

check("an unknown L0 kind fails closed", async () => {
	const r = await runStageL0({ cwd: ".", run: async () => OK(), kind: "vibes" as any });
	assert.equal(r.verdict.verdict, "fail");
	assert.ok(r.verdict.summary.includes("fail-closed"));
});

check("loadSpecs reads the real project specs by stem", () => {
	const specs = loadSpecs(REAL);
	assert.ok(specs["spec-screen-frame-handoff"], Object.keys(specs).join(","));
	assert.ok(specs["spec-platform-win"]);
	assert.ok(!Object.keys(specs).some((k) => k.endsWith(".md")));
});

check("loadSpecs on a directory without specs returns empty, not an error", () => {
	const s = sandbox();
	try {
		assert.deepEqual(loadSpecs(s.cwd), {});
	} finally { s.cleanup(); }
});

check("L0 never invents a fix at any stage", async () => {
	const s = sandbox();
	try {
		const r = runTaskL0({ cwd: s.cwd, run: async () => OK(), kind: "task" });
		for (const f of r.verdict.findings) {
			assert.equal(f.required_fix, undefined);
			assert.equal(f.failing_test, undefined);
		}
	} finally { s.cleanup(); }
});

console.log("== l0-stages.ts tests ==");
for (const [name, fn] of tests) {
	try {
		await fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
