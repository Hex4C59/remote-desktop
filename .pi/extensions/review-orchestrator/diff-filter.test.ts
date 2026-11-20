// Regression tests for the diff self-feedback bug.
//
// Observed in the four-layer sandbox run: writing .orchestrator/ made the
// orchestrator's OWN evidence an untracked "change", which then tripped the
// forbidden-path rule (18 files) and turned a plain L0 block into an escalation.
// The artifact root must never be reviewed as a change.
//
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/diff-filter.test.ts
import assert from "node:assert/strict";
import {
	DEFAULT_DIFF_EXCLUDES, collectDiff, filterDiff, isExcludedPath,
} from "./orchestrator.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const OK = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function runner(diff: string, untracked: string): CommandRunner {
	return async (cmd, args) => {
		const key = `${cmd} ${args.join(" ")}`;
		if (key.startsWith("git diff")) return OK(diff);
		if (key.startsWith("git ls-files")) return OK(untracked);
		throw new Error(`unexpected: ${key}`);
	};
}

const section = (file: string, body = "+int x;") =>
	`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}`;

// ------------------------------------------------------------------ path exclusion
check("the artifact root is excluded by default", () => {
	assert.ok(DEFAULT_DIFF_EXCLUDES.includes(".orchestrator/"));
});

check("isExcludedPath matches the root and everything under it", () => {
	for (const f of [
		".orchestrator", ".orchestrator/state.json",
		".orchestrator/run-1/checkpoints/cp1/diff.patch",
		"./.orchestrator/x.json", ".orchestrator\\run\\state.json",
	]) {
		assert.ok(isExcludedPath(f, DEFAULT_DIFF_EXCLUDES), `${f} should be excluded`);
	}
});

check("isExcludedPath does not match siblings or unrelated paths", () => {
	for (const f of ["src/a.cpp", ".orchestratorish/x.json", "docs/.orchestrator-notes.md"]) {
		assert.ok(!isExcludedPath(f, DEFAULT_DIFF_EXCLUDES), `${f} must NOT be excluded`);
	}
});

check("an empty exclude entry never excludes everything", () => {
	assert.ok(!isExcludedPath("src/a.cpp", [""]));
	assert.ok(!isExcludedPath("src/a.cpp", []));
});

// ------------------------------------------------------------------ diff filtering
check("filterDiff drops only the excluded file sections", () => {
	const diff = [
		section("src/a.cpp"),
		section(".orchestrator/run-1/state.json"),
		section("docs/x.md"),
	].join("\n");
	const kept = filterDiff(diff, DEFAULT_DIFF_EXCLUDES);
	assert.ok(kept.includes("src/a.cpp"));
	assert.ok(kept.includes("docs/x.md"));
	assert.ok(!kept.includes(".orchestrator"), kept);
});

check("filterDiff keeps the real change when artifacts come first", () => {
	const diff = [section(".orchestrator/x.json"), section("src/b.cpp")].join("\n");
	const kept = filterDiff(diff, DEFAULT_DIFF_EXCLUDES);
	assert.ok(kept.includes("src/b.cpp"));
	assert.ok(!kept.includes(".orchestrator"));
});

check("filterDiff returns empty when every section is excluded", () => {
	const diff = [section(".orchestrator/a.json"), section(".orchestrator/b.json")].join("\n");
	assert.equal(filterDiff(diff, DEFAULT_DIFF_EXCLUDES).trim(), "");
});

check("filterDiff is a no-op with no excludes or empty diff", () => {
	const diff = section("src/a.cpp");
	assert.equal(filterDiff(diff, []), diff);
	assert.equal(filterDiff("", DEFAULT_DIFF_EXCLUDES), "");
});

// ------------------------------------------------------------------ collectDiff
check("collectDiff omits untracked artifact files", async () => {
	const out = await collectDiff(
		runner("", ".orchestrator/run-1/state.json\n.orchestrator/run-1/checkpoints/cp1/diff.patch\nsrc/new.cpp\n"),
		".",
	);
	assert.ok(out.includes("src/new.cpp"));
	assert.ok(!out.includes(".orchestrator"), out);
});

check("collectDiff reports no change when only artifacts exist", async () => {
	const out = await collectDiff(runner("", ".orchestrator/run-1/state.json\n"), ".");
	assert.equal(out.trim(), "", "the orchestrator's own output is not a change");
});

check("collectDiff keeps a real tracked change alongside artifacts", async () => {
	const out = await collectDiff(
		runner([section(".orchestrator/x.json"), section("src/a.cpp")].join("\n"), ".orchestrator/y.json\n"),
		".",
	);
	assert.ok(out.includes("src/a.cpp"));
	assert.ok(!out.includes(".orchestrator"), out);
});

check("collectDiff honours extra excludes (e.g. a build dir without .gitignore)", async () => {
	const out = await collectDiff(
		runner("", "build/debug/x.o\nsrc/new.cpp\n"),
		".",
		[...DEFAULT_DIFF_EXCLUDES, "build/"],
	);
	assert.ok(out.includes("src/new.cpp"));
	assert.ok(!out.includes("build/"), out);
});

check("collectDiff still returns real untracked files by default", async () => {
	const out = await collectDiff(runner("", "src/new.cpp\ndocs/note.md\n"), ".");
	assert.ok(out.includes("src/new.cpp"));
	assert.ok(out.includes("docs/note.md"));
});

console.log("== diff-filter tests ==");
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
