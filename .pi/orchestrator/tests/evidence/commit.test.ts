// Tests for commit.ts — the only place the orchestrator writes the repository.
// Run: node --experimental-strip-types .pi/orchestrator/tests/evidence/commit.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoCommitCheckpoint, autoCommitGuard } from "../../src/evidence/commit.ts";
import { ArtifactStore } from "../../src/evidence/store.ts";
import type { CommandRunner, CommandResult } from "../../src/checks/l0.ts";
import type { RiskAssessment } from "../../src/review/risk.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const check = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const low: RiskAssessment = { level: "low", reasons: ["小改动"], forbiddenHits: [], changedFiles: ["README.md"], changedLines: 2, decidedBy: "default-low" };
const medium: RiskAssessment = { ...low, level: "medium", decidedBy: "medium-path" };
const high: RiskAssessment = { ...low, level: "high", decidedBy: "high-path" };

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-commit-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	return { cwd, store, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const OK = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** Records every git invocation so tests can prove nothing was written. */
function gitRunner(o: { headBefore?: string; headAfter?: string; addFails?: boolean; commitFails?: boolean } = {}) {
	const calls: string[][] = [];
	const run: CommandRunner = async (cmd, args) => {
		calls.push([cmd, ...args]);
		if (args[0] === "rev-parse") {
			const committed = calls.some((c) => c[1] === "commit");
			return OK(committed ? (o.headAfter ?? "newsha") : (o.headBefore ?? "oldsha"));
		}
		if (args[0] === "add") return o.addFails ? { exitCode: 1, stdout: "", stderr: "add failed" } : OK();
		if (args[0] === "commit") return o.commitFails ? { exitCode: 1, stdout: "", stderr: "commit failed" } : OK();
		throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
	};
	return { run, calls };
}

// ------------------------------------------------------------------ pure guard
check("#13 guard refuses when autoCommit is disabled", () => {
	const g = autoCommitGuard({ assessment: low, enabled: false, files: ["README.md"] });
	assert.ok(!g.ok);
	assert.ok(g.reason.includes("autoCommit=false"));
});

check("#13 guard refuses medium and high even when enabled", () => {
	for (const a of [medium, high]) {
		const g = autoCommitGuard({ assessment: a, enabled: true, files: ["README.md"] });
		assert.ok(!g.ok, `${a.level} must not auto-commit`);
	}
});

check("#13 guard refuses forbidden hits regardless of level", () => {
	const g = autoCommitGuard({ assessment: { ...low, forbiddenHits: ["third_party/x.h"] }, enabled: true, files: ["README.md"] });
	assert.ok(!g.ok);
	assert.ok(g.reason.includes("禁止路径"));
});

check("guard refuses when L3 was required but not approved", () => {
	const g = autoCommitGuard({ assessment: low, enabled: true, humanRequired: true, humanApproved: false, files: ["README.md"] });
	assert.ok(!g.ok);
	assert.ok(g.reason.includes("L3"));
});

check("guard allows low + enabled + approved", () => {
	assert.ok(autoCommitGuard({ assessment: low, enabled: true, humanRequired: true, humanApproved: true, files: ["README.md"] }).ok);
	assert.ok(autoCommitGuard({ assessment: low, enabled: true, files: ["README.md"] }).ok);
});

check("guard refuses an empty file list (never blind git add)", () => {
	const g = autoCommitGuard({ assessment: low, enabled: true, files: [] });
	assert.ok(!g.ok);
	assert.ok(g.reason.includes("git add"));
});

check("guard refuses unsafe paths", () => {
	for (const bad of ["--force", "../outside", "/abs/path"]) {
		const g = autoCommitGuard({ assessment: low, enabled: true, files: [bad] });
		assert.ok(!g.ok, `${bad} must be refused`);
	}
});

// ------------------------------------------------------------------ #13 no writes when disabled
check("#13 disabled autoCommit performs ZERO git writes", async () => {
	const s = sandbox();
	try {
		const g = gitRunner();
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: low, enabled: false, message: "m", files: ["README.md"],
		});
		assert.equal(r.outcome, "refused");
		assert.deepEqual(g.calls, [], "not even rev-parse should run");
		assert.ok(s.store.exists("checkpoints/cp1/auto-commit.json"), "refusal is itself evidence");
		assert.equal(s.store.readJson<any>("checkpoints/cp1/auto-commit.json").outcome, "refused");
	} finally { s.cleanup(); }
});

check("medium risk performs zero git writes", async () => {
	const s = sandbox();
	try {
		const g = gitRunner();
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: medium, enabled: true, message: "m", files: ["docs/x.md"],
		});
		assert.equal(r.outcome, "refused");
		assert.deepEqual(g.calls, []);
	} finally { s.cleanup(); }
});

// ------------------------------------------------------------------ happy path
check("#13 enabled + low commits exactly the reviewed files and records a spot-check", async () => {
	const s = sandbox();
	try {
		const g = gitRunner({ headBefore: "old", headAfter: "abc123" });
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: low, enabled: true, message: "feat: x", files: ["README.md", "tools/a.py"],
		});
		assert.equal(r.outcome, "committed");
		assert.equal(r.commit, "abc123");
		const add = g.calls.find((c) => c[1] === "add")!;
		assert.deepEqual(add, ["git", "add", "--", "README.md", "tools/a.py"]);
		assert.ok(g.calls.some((c) => c[1] === "commit"));
		const spot = s.store.readJson<any>("checkpoints/cp1/spot-check.json");
		assert.equal(spot.commit, "abc123");
		assert.equal(spot.status, "pending-async-review");
		assert.ok(spot.note.includes("异步抽检"));
		assert.equal(s.store.readJson<any>("checkpoints/cp1/auto-commit.json").outcome, "committed");
	} finally { s.cleanup(); }
});

check("a failed git add is reported, not silently ignored", async () => {
	const s = sandbox();
	try {
		const g = gitRunner({ addFails: true });
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: low, enabled: true, message: "m", files: ["README.md"],
		});
		assert.equal(r.outcome, "failed");
		assert.ok(r.reason.includes("git add"));
		assert.ok(!g.calls.some((c) => c[1] === "commit"), "must not commit after a failed add");
	} finally { s.cleanup(); }
});

check("a failed git commit is reported", async () => {
	const s = sandbox();
	try {
		const g = gitRunner({ commitFails: true });
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: low, enabled: true, message: "m", files: ["README.md"],
		});
		assert.equal(r.outcome, "failed");
		assert.ok(r.reason.includes("git commit"));
	} finally { s.cleanup(); }
});

check("an unchanged HEAD after commit is treated as NOT committed", async () => {
	const s = sandbox();
	try {
		const g = gitRunner({ headBefore: "same", headAfter: "same" });
		const r = await autoCommitCheckpoint({
			cwd: s.cwd, run: g.run, store: s.store, checkpointId: "cp1",
			assessment: low, enabled: true, message: "m", files: ["README.md"],
		});
		assert.equal(r.outcome, "failed");
		assert.ok(r.reason.includes("HEAD 未变化"));
		assert.equal(s.store.exists("checkpoints/cp1/spot-check.json"), false, "no spot-check for a non-commit");
	} finally { s.cleanup(); }
});

console.log("== commit.ts tests ==");
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
