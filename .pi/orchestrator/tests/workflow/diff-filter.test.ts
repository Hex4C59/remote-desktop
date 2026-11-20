// Regression tests for the diff self-feedback bug.
//
// Observed in the four-layer sandbox run: writing .orchestrator/ made the
// orchestrator's OWN evidence an untracked "change", which then tripped the
// forbidden-path rule (18 files) and turned a plain L0 block into an escalation.
// The artifact root must never be reviewed as a change.
//
// Run: node --experimental-strip-types .pi/orchestrator/tests/workflow/diff-filter.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_DIFF_EXCLUDES, collectDiff, filterDiff, hashText, isExcludedPath,
} from "../../src/workflow/orchestrator.ts";
import type { CommandRunner, CommandResult } from "../../src/checks/l0.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const OK = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function runner(diff: string, untracked: string): CommandRunner {
	return async (cmd, args) => {
		const key = `${cmd} ${args.join(" ")}`;
		if (cmd === "git" && args.includes("--cached")) return OK("");
		if (cmd === "git" && args.includes("--no-index")) {
			return { ...OK(section(args.at(-1)!.replace(/^\.\//, ""))), exitCode: 1 };
		}
		if (key.startsWith("git diff")) return OK(diff);
		if (key.startsWith("git ls-files")) return OK(args.includes("-z") ? untracked.replace(/\n/g, "\0") : untracked);
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

function git(cwd: string, args: string[]): CommandResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withGitRepo(test: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-diff-"));
	try {
		const init = git(cwd, ["init", "-q"]);
		assert.equal(init.exitCode, 0, init.stderr);
		await test(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const gitRunner: CommandRunner = async (_cmd, args, options) => git(options?.cwd ?? ".", args);

check("collectDiff includes paths and content that exist only in the index", async () => {
	await withGitRepo(async (cwd) => {
		fs.writeFileSync(path.join(cwd, "staged.cpp"), "int staged_only;\n");
		const add = git(cwd, ["add", "staged.cpp"]);
		assert.equal(add.exitCode, 0, add.stderr);
		const patch = await collectDiff(gitRunner, cwd);
		assert.match(patch, /\+int staged_only;/);
		fs.writeFileSync(path.join(cwd, "staged.cpp"), "int working_copy;\n");
		const mixed = await collectDiff(gitRunner, cwd);
		assert.match(mixed, /\+int staged_only;/);
		assert.match(mixed, /\+int working_copy;/);
	});
});

check("editing an untracked file is visible and changes the diff hash", async () => {
	await withGitRepo(async (cwd) => {
		const file = path.join(cwd, "new file.cpp");
		fs.writeFileSync(file, "int first_version;\n");
		const first = await collectDiff(gitRunner, cwd);
		assert.match(first, /\+int first_version;/);
		fs.writeFileSync(file, "int second_version;\n");
		const second = await collectDiff(gitRunner, cwd);
		assert.match(second, /\+int second_version;/);
		assert.notEqual(hashText(first), hashText(second));
		assert.equal(git(cwd, ["ls-files", "--cached"]).stdout, "");
	});
});

check("a failed Git command cannot masquerade as a clean worktree", async () => {
	const failing: CommandRunner = async () => ({ exitCode: 128, stdout: "", stderr: "git failed" });
	await assert.rejects(collectDiff(failing, "."), /git failed/);
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
