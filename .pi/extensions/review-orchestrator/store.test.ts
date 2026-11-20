// Tests for store.ts — the evidence chain must be atomic, reproducible and secret-free.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/store.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	ArtifactStore, SecretInArtifactError, ensureGitignored, exportReviewPackage,
	findSecrets, newRunId, safeId, sha256, stableJson, writeAtomic,
} from "./store.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

function sandbox(): { cwd: string; store: ArtifactStore; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "20260101T000000Z-abc123" });
	return { cwd, store, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------ ids & hashing
check("run ids are sortable and unique", () => {
	const a = newRunId(new Date("2026-01-01T00:00:00Z"));
	const b = newRunId(new Date("2026-01-02T00:00:00Z"));
	assert.ok(a < b, "timestamp prefix must sort chronologically");
	assert.notEqual(newRunId(), newRunId(), "random suffix prevents collisions");
});

check("safeId strips path traversal and separators", () => {
	assert.equal(safeId("../../etc/passwd"), "etc-passwd");
	assert.equal(safeId("CP 01/first"), "cp-01-first");
	assert.equal(safeId("   "), "unnamed");
	assert.ok(!safeId("a/b\\c").includes("/"));
});

// Regression: dots used to survive, so safeId("..") === ".." and the run /
// checkpoint directory resolved OUTSIDE the artifact root.
check("safeId can never yield a traversal component", () => {
	for (const raw of ["..", ".", "...", "a/../b", "../..", ".hidden"]) {
		const id = safeId(raw);
		assert.ok(!id.includes("."), `safeId(${JSON.stringify(raw)}) = ${id} must contain no dots`);
		assert.notEqual(id, "..");
		assert.notEqual(id, ".");
		assert.ok(id.length > 0);
	}
});

check("a traversal runId stays inside the artifact root", () => {
	const cwd = path.join(os.tmpdir(), "rd-escape-probe");
	for (const runId of ["..", "../..", "."]) {
		const st = new ArtifactStore({ cwd, root: ".orchestrator", runId });
		const rel = path.relative(path.join(cwd, ".orchestrator"), st.runDir);
		assert.ok(!rel.startsWith(".."), `runId ${runId} escaped: ${st.runDir}`);
		assert.ok(st.runDir.includes(".orchestrator"), st.runDir);
		const cp = st.resolve(st.checkpointDir(".."));
		assert.ok(cp.startsWith(st.runDir), `checkpoint escaped: ${cp}`);
	}
});

check("sha256 matches node crypto", () => {
	assert.equal(sha256("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

check("stableJson sorts keys so hashes do not depend on insertion order", () => {
	const a = stableJson({ b: 1, a: { d: 2, c: 3 } });
	const b = stableJson({ a: { c: 3, d: 2 }, b: 1 });
	assert.equal(a, b);
	assert.equal(sha256(a), sha256(b));
});

check("stableJson preserves array order", () => {
	assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
});

// ------------------------------------------------------------------ secret guard
check("findSecrets detects common credential shapes", () => {
	assert.ok(findSecrets("sk-abcdefghijklmnopqrstuvwx").length > 0);
	assert.ok(findSecrets("ghp_abcdefghijklmnopqrstuvwxyz012345").length > 0);
	assert.ok(findSecrets("AKIAIOSFODNN7EXAMPLE").length > 0);
	assert.ok(findSecrets("-----BEGIN RSA PRIVATE KEY-----").length > 0);
	assert.ok(findSecrets('api_key = "abcdefghijklmnopqrstuvwxyz123456"').length > 0);
	assert.ok(findSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123").length > 0);
});

check("findSecrets does not flag ordinary review text", () => {
	assert.deepEqual(findSecrets("L0 passed: cmake_build exit 0; ctest 10/10"), []);
	assert.deepEqual(findSecrets("- [warning] src/capture/a.cpp:12 violates HANDOFF-1"), []);
});

check("writing a secret is refused and nothing lands on disk", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.throws(
			() => store.writeText("checkpoints/cp1/leak.txt", "token=sk-abcdefghijklmnopqrstuvwx"),
			SecretInArtifactError,
		);
		assert.equal(store.exists("checkpoints/cp1/leak.txt"), false);
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ path safety
check("artifact root may not escape the project", () => {
	assert.throws(() => new ArtifactStore({ cwd: ".", root: "../outside", runId: "r" }));
	assert.throws(() => new ArtifactStore({ cwd: ".", root: "/abs", runId: "r" }));
	assert.throws(() => new ArtifactStore({ cwd: ".", root: "a/../b", runId: "r" }));
});

check("resolve refuses traversal inside the run dir", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.throws(() => store.resolve("..", "..", "escape.txt"));
		assert.throws(() => store.resolve("a/../../b.txt"));
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ atomic write
check("writeAtomic creates parent dirs and leaves no temp files", () => {
	const { store, cleanup } = sandbox();
	try {
		store.writeText("checkpoints/cp1/deep/nested/file.json", "{}");
		assert.ok(store.exists("checkpoints/cp1/deep/nested/file.json"));
		const dir = path.dirname(store.resolve("checkpoints/cp1/deep/nested/file.json"));
		assert.deepEqual(fs.readdirSync(dir), ["file.json"], "no .tmp-* leftovers");
	} finally { cleanup(); }
});

check("writeAtomic cleans up the temp file when the write fails", () => {
	const { cwd, cleanup } = sandbox();
	try {
		// A directory where the target file should be makes rename fail.
		const target = path.join(cwd, "blocked");
		fs.mkdirSync(target, { recursive: true });
		assert.throws(() => writeAtomic(target, "content"));
		const leftovers = fs.readdirSync(cwd).filter((f) => f.includes(".tmp-"));
		assert.deepEqual(leftovers, [], "temp file must be removed on failure");
	} finally { cleanup(); }
});

check("state round-trips through save/load", () => {
	const { store, cleanup } = sandbox();
	try {
		store.saveState({ state: "CODE_LOOP", attempt: 2, checkpoint: "cp1" });
		const loaded = store.loadState<any>();
		assert.equal(loaded.state, "CODE_LOOP");
		assert.equal(loaded.attempt, 2);
	} finally { cleanup(); }
});

check("reading a missing or corrupt artifact returns undefined, never throws", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.equal(store.readText("nope.json"), undefined);
		assert.equal(store.readJson("nope.json"), undefined);
		store.writeText("bad.json", "{not json");
		assert.equal(store.readJson("bad.json"), undefined);
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ blueprint layout
check("directory contract matches blueprint figure 4", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.equal(store.statePath(), "state.json");
		assert.equal(store.decisionsPath(), "DECISIONS.md");
		assert.equal(store.stageFile("spec", "l1-findings.json"), "spec/l1-findings.json");
		assert.equal(store.stageFile("plan", "coverage-matrix.json"), "plan/coverage-matrix.json");
		assert.equal(store.checkpointFile("CP 01", "TASK.md"), "checkpoints/cp-01/TASK.md");
		assert.equal(store.reviewPackageDir("cp1"), "checkpoints/cp1/review-package");
		assert.ok(store.escalationFile("L0 consecutive red").startsWith("escalations/"));
		assert.ok(store.escalationFile("L0 consecutive red").endsWith("-l0-consecutive-red.json"));
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ evidence manifest
function seedPackage(store: ArtifactStore) {
	store.writeText("checkpoints/cp1/diff.patch", "diff --git a/a.cpp b/a.cpp\n+int x;\n");
	store.writeJson("checkpoints/cp1/l0-results.json", { layer: "L0", verdict: "pass", checks: [] });
	store.writeText("checkpoints/cp1/review-package/summary.md", "# Summary\nL0 pass\n");
	store.writeText("checkpoints/cp1/review-package/risk-assessment.md", "# Risk\nlevel: medium\n");
}

check("manifest is reproducible and excludes itself", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		const first = store.writeEvidenceManifest("checkpoints/cp1");
		assert.ok(!first.includes("evidence.sha256"), "manifest must not hash itself");
		const second = store.hashDir("checkpoints/cp1");
		assert.equal(first, second, "recomputation must be identical");
		assert.ok(store.verifyEvidenceManifest("checkpoints/cp1").ok);
	} finally { cleanup(); }
});

check("#8 manifest is verifiable with plain sha256sum (no custom tooling)", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		store.writeEvidenceManifest("checkpoints/cp1");
		const dir = store.resolve("checkpoints/cp1");
		// sha256sum -c reads "<hex>  <path>" relative to cwd.
		let out = "";
		try {
			out = execFileSync("sha256sum", ["-c", "evidence.sha256"], { cwd: dir, encoding: "utf-8" });
		} catch (e: any) {
			// sha256sum may be unavailable; fall back to an independent recomputation.
			const manifest = fs.readFileSync(path.join(dir, "evidence.sha256"), "utf-8");
			for (const line of manifest.split("\n").filter(Boolean)) {
				const i = line.indexOf("  ");
				const expected = line.slice(0, i);
				const rel = line.slice(i + 2);
				assert.equal(sha256(fs.readFileSync(path.join(dir, rel))), expected, `independent hash mismatch: ${rel}`);
			}
			return;
		}
		assert.ok(!/FAILED/.test(out), out);
		assert.ok(/OK/.test(out), out);
	} finally { cleanup(); }
});

check("tampering with an artifact is detected by name", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		store.writeEvidenceManifest("checkpoints/cp1");
		store.writeText("checkpoints/cp1/review-package/summary.md", "# Summary\nTAMPERED\n");
		const v = store.verifyEvidenceManifest("checkpoints/cp1");
		assert.ok(!v.ok);
		assert.ok(v.problems.some((p) => p.includes("changed") && p.includes("summary.md")), v.problems.join("; "));
	} finally { cleanup(); }
});

check("a deleted artifact is reported missing", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		store.writeEvidenceManifest("checkpoints/cp1");
		fs.unlinkSync(store.resolve("checkpoints/cp1/diff.patch"));
		const v = store.verifyEvidenceManifest("checkpoints/cp1");
		assert.ok(!v.ok);
		assert.ok(v.problems.some((p) => p.includes("missing") && p.includes("diff.patch")));
	} finally { cleanup(); }
});

check("an unexpected new file is reported", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		store.writeEvidenceManifest("checkpoints/cp1");
		store.writeText("checkpoints/cp1/sneaky.txt", "extra");
		const v = store.verifyEvidenceManifest("checkpoints/cp1");
		assert.ok(!v.ok);
		assert.ok(v.problems.some((p) => p.includes("unexpected new file")));
	} finally { cleanup(); }
});

check("a missing manifest is reported, not treated as verified", () => {
	const { store, cleanup } = sandbox();
	try {
		seedPackage(store);
		const v = store.verifyEvidenceManifest("checkpoints/cp1");
		assert.ok(!v.ok);
		assert.ok(v.problems[0].includes("missing"));
	} finally { cleanup(); }
});

// ------------------------------------------------------------------ gitignore & export
check("ensureGitignored is idempotent", () => {
	const { cwd, cleanup } = sandbox();
	try {
		const first = ensureGitignored(cwd, ".orchestrator");
		assert.ok(first.added);
		assert.ok(fs.readFileSync(first.file, "utf-8").includes("/.orchestrator/"));
		const second = ensureGitignored(cwd, ".orchestrator");
		assert.ok(!second.added, "must not duplicate the entry");
	} finally { cleanup(); }
});

check("ensureGitignored preserves existing content", () => {
	const { cwd, cleanup } = sandbox();
	try {
		fs.writeFileSync(path.join(cwd, ".gitignore"), "/build/\n");
		ensureGitignored(cwd, ".orchestrator");
		const text = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
		assert.ok(text.includes("/build/"));
		assert.ok(text.includes("/.orchestrator/"));
	} finally { cleanup(); }
});

check("export copies the review package and keeps its hashes valid", () => {
	const { cwd, store, cleanup } = sandbox();
	try {
		seedPackage(store);
		store.writeEvidenceManifest("checkpoints/cp1/review-package");
		const r = exportReviewPackage(store, "cp1", cwd, "export-out");
		assert.ok(r.files.includes("summary.md"));
		assert.ok(r.files.includes("evidence.sha256"));
		const manifest = fs.readFileSync(path.join(r.dir, "evidence.sha256"), "utf-8");
		for (const line of manifest.split("\n").filter(Boolean)) {
			const i = line.indexOf("  ");
			const rel = line.slice(i + 2);
			if (rel === "evidence.sha256") continue;
			assert.equal(sha256(fs.readFileSync(path.join(r.dir, rel))), line.slice(0, i));
		}
	} finally { cleanup(); }
});

check("export refuses to copy a secret-bearing package", () => {
	const { cwd, store, cleanup } = sandbox();
	try {
		// Write with the guard off to simulate a legacy/poisoned artifact.
		const loose = new ArtifactStore({ cwd, root: ".orchestrator", runId: store.runId, guardSecrets: false });
		loose.writeText("checkpoints/cp1/review-package/summary.md", "key sk-abcdefghijklmnopqrstuvwx");
		assert.throws(() => exportReviewPackage(store, "cp1", cwd, "export-out"), SecretInArtifactError);
	} finally { cleanup(); }
});

check("export dir may not escape the project", () => {
	const { cwd, store, cleanup } = sandbox();
	try {
		seedPackage(store);
		assert.throws(() => exportReviewPackage(store, "cp1", cwd, "../outside"));
		assert.throws(() => exportReviewPackage(store, "cp1", cwd, "/abs"));
	} finally { cleanup(); }
});

check("escalations are listed newest first", () => {
	const { store, cleanup } = sandbox();
	try {
		store.writeJson(store.escalationFile("first", new Date("2026-01-01T00:00:00Z")), { reason: "first" });
		store.writeJson(store.escalationFile("second", new Date("2026-01-02T00:00:00Z")), { reason: "second" });
		const list = store.listEscalations();
		assert.equal(list.length, 2);
		assert.ok(list[0].includes("second"), list.join(","));
	} finally { cleanup(); }
});

check("listEscalations on a fresh run is empty, not an error", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.deepEqual(store.listEscalations(), []);
	} finally { cleanup(); }
});

console.log("== store.ts tests ==");
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
