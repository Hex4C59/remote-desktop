// Standalone tests for l0.ts — CommandRunner is injected, so no toolchain needed.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/l0.test.ts
import assert from "node:assert/strict";
import { runL0Gate, failedTests, excerpt, type CommandResult, type CommandRunner } from "./l0.ts";
import { validateVerdict } from "./verdict.ts";

let passed = 0;
function check(name: string, fn: () => Promise<void> | void) {
	const p = Promise.resolve().then(fn);
	return p.then(
		() => {
			passed++;
			console.log(`  ok  ${name}`);
		},
		(e: Error) => {
			console.error(`  FAIL ${name}: ${e.message}`);
			process.exitCode = 1;
		},
	);
}

function runner(map: Record<string, CommandResult>): CommandRunner {
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		for (const [prefix, result] of Object.entries(map)) {
			if (key.startsWith(prefix)) return result;
		}
		throw new Error(`unexpected command: ${key}`);
	};
}

const ok: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };
const failBuild: CommandResult = { exitCode: 1, stdout: "", stderr: "error: 'x' was not declared" };
const failCtest: CommandResult = {
	exitCode: 8,
	stdout: "Test #1: arch.layers\n 1 - arch.layers (Failed)\nTest #2: spec.structure\n 2 - spec.structure (Failed)\n\n0% tests passed, 2 tests failed out of 2",
	stderr: "",
};
const failOneTest: CommandResult = {
	exitCode: 8,
	stdout: " 1 - arch.layers (Failed)\n\n0% tests passed, 1 tests failed out of 3",
	stderr: "",
};

const tests: Array<[string, () => Promise<void> | void]> = [
	[
		"failedTests parses '(Failed)' lines",
		() => {
			assert.deepEqual(failedTests(failCtest.stdout).sort(), ["arch.layers", "spec.structure"]);
			assert.deepEqual(failedTests(failOneTest.stdout), ["arch.layers"]);
			assert.deepEqual(failedTests("100% tests passed"), []);
		},
	],
	[
		"excerpt keeps the informative tail and caps size",
		() => {
			assert.equal(excerpt(""), "");
			const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
			const e = excerpt(long, 10, 1000);
			assert.ok(e.includes("line 99"), "keeps last line");
			assert.ok(!e.includes("line 0\n"), "drops early lines");
			assert.ok(e.length <= 1000);
		},
	],
	[
		"all-green run produces a valid passing L0 verdict",
		async () => {
			const v = await runL0Gate({
				cwd: ".",
				run: runner({
					"cmake --build": ok,
					"ctest ": { exitCode: 0, stdout: "100% tests passed, 3 tests passed out of 3", stderr: "" },
				}),
			});
			assert.equal(v.layer, "L0");
			assert.equal(v.verdict, "pass");
			assert.equal(v.findings.length, 0);
			assert.deepEqual(v.checks?.map((c) => c.name), ["cmake_build", "ctest"]);
			const r = validateVerdict(v, "L0");
			assert.ok(r.ok, r.errors.join("; "));
		},
	],
	[
		"build failure blocks before ctest and yields a valid failing verdict",
		async () => {
			const seen: string[] = [];
			const run: CommandRunner = async (c) => {
				seen.push(c);
				return failBuild;
			};
			const v = await runL0Gate({ cwd: ".", run });
			assert.equal(v.verdict, "fail");
			assert.deepEqual(seen, ["cmake"], "ctest must not run after a failed build");
			assert.equal(v.findings[0].file, "build");
			assert.ok(v.findings[0].evidence.includes("was not declared"), "keeps the compiler error");
			const r = validateVerdict(v, "L0");
			assert.ok(r.ok, r.errors.join("; "));
		},
	],
	[
		"ctest failure names the gate cases explicitly",
		async () => {
			const v = await runL0Gate({
				cwd: ".",
				run: runner({ "cmake --build": ok, "ctest ": failCtest }),
			});
			assert.equal(v.verdict, "fail");
			const files = v.findings.map((f) => f.file).sort();
			assert.deepEqual(files, ["ctest:arch.layers", "ctest:spec.structure"]);
			const r = validateVerdict(v, "L0");
			assert.ok(r.ok, r.errors.join("; "));
		},
	],
	[
		"L0 never invents required_fix / failing_test",
		async () => {
			const v = await runL0Gate({ cwd: ".", run: runner({ "cmake --build": failBuild }) });
			assert.ok(v.findings.length > 0);
			for (const f of v.findings) {
				assert.equal(f.required_fix, undefined);
				assert.equal(f.failing_test, undefined);
			}
		},
	],
];

console.log("== l0.ts tests ==");
for (const [name, fn] of tests) await check(name, fn);
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
