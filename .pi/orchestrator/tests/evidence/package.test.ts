// Tests for package.ts — the L3 approval target must be templated and hashable.
// Run: node --experimental-strip-types .pi/orchestrator/tests/evidence/package.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, sha256, SecretInArtifactError } from "../../src/evidence/store.ts";
import { buildReviewPackage, renderSummary, renderRiskAssessment, type PackageInput } from "../../src/evidence/package.ts";
import type { ParsedVerdict } from "../../src/review/verdict.ts";
import type { PanelAggregate } from "../../src/review/aggregate.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

function sandbox() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rd-pkg-"));
	const store = new ArtifactStore({ cwd, root: ".orchestrator", runId: "run-1" });
	return { cwd, store, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const l0: ParsedVerdict = {
	layer: "L0", verdict: "pass", findings: [], summary: "build+ctest 通过",
	checks: [{ name: "cmake_build", exit_code: 0 }, { name: "ctest", exit_code: 0 }], raw: {},
};
const l1Fail: ParsedVerdict = {
	layer: "L1", verdict: "fail",
	findings: [{ severity: "warning", file: "src/a.cpp", line: 12, evidence: "b==0 时除零", required_fix: "加零判断" }],
	summary: "发现除零", raw: {},
};
const l1Pass: ParsedVerdict = { layer: "L1", verdict: "pass", findings: [], summary: "无问题", raw: {} };
const l2Uncertain: ParsedVerdict = {
	layer: "L2", verdict: "pass",
	findings: [{ severity: "suggestion", uncertain: true, file: "docs/x.md", line: 3, evidence: "PLAT-1 可能越界", required_fix: "人工复核" }],
	summary: "需人工复核", raw: {},
};

function input(over: Partial<PackageInput> = {}): PackageInput {
	return {
		runId: "run-1", checkpointId: "cp1", stage: "code", outcome: "blocked",
		attempt: 1, maxRetries: 2,
		diff: "diff --git a/src/a.cpp b/src/a.cpp\n+int divide(int a,int b){return a/b;}\n",
		diffStat: " src/a.cpp | 1 +\n",
		l0, l1: l1Fail,
		nextAction: "按 findings 修复后重跑 L0→L1。",
		generatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

const panelAgg: PanelAggregate = {
	outcome: "BLOCKED", quorum: 2, validVotes: 1,
	absent: [{ model: "qoder/Qwen4-Max-Preview", family: "qwen", valid: false, failureReason: "403 disabled" }],
	reasons: ["quorum not reached: 1 valid vote(s) < required 2"],
	blockingFindings: [], votingFamilies: ["deepseek"],
};

// ------------------------------------------------------------------ determinism
check("summary is deterministic for identical input", () => {
	const a = renderSummary(input());
	const b = renderSummary(input());
	assert.equal(a, b);
	assert.equal(sha256(a), sha256(b));
});

check("summary contains every layer verdict and the blocking finding", () => {
	const s = renderSummary(input());
	assert.ok(s.includes("| L0 | pass"));
	assert.ok(s.includes("| L1 | fail"));
	assert.ok(s.includes("| L2 | 未执行"));
	assert.ok(s.includes("src/a.cpp:12"));
	assert.ok(s.includes("b==0 时除零"));
	assert.ok(s.includes("加零判断"));
	assert.ok(s.includes("1/2"), "retry round must be visible");
});

check("blocking and non-blocking findings are separated", () => {
	const s = renderSummary(input({ l1: l1Pass, l2: l2Uncertain, outcome: "pass" }));
	const blockingSection = s.split("## 阻断项")[1].split("## 建议项")[0];
	const suggestionSection = s.split("## 建议项")[1].split("## 下一步")[0];
	assert.ok(blockingSection.includes("（无）"), "no blockers when all pass");
	assert.ok(suggestionSection.includes("PLAT-1"));
	assert.ok(suggestionSection.includes("不确定"));
});

check("a fail verdict's findings are treated as blocking even without severity", () => {
	const bare: ParsedVerdict = {
		layer: "L1", verdict: "fail",
		findings: [{ file: "a.cpp", line: 1, evidence: "broken", required_fix: "fix" } as any],
		summary: "x", raw: {},
	};
	const s = renderSummary(input({ l1: bare }));
	assert.ok(s.split("## 阻断项")[1].split("## 建议项")[0].includes("a.cpp:1"));
});

check("panel section records quorum, families and absence reasons", () => {
	const s = renderSummary(input({
		panel: panelAgg,
		panelRecords: [
			{ model: "deepseek/deepseek-v4-pro", family: "deepseek", ok: true, reportedModel: "deepseek/deepseek-v4-pro", assistantText: "{}", durationMs: 1200 },
			{ model: "qoder/Qwen4-Max-Preview", family: "qwen", ok: false, assistantText: "", error: "403 disabled", durationMs: 300 },
		],
	}));
	assert.ok(s.includes("**BLOCKED**"));
	assert.ok(s.includes("1 / 法定 2"));
	assert.ok(s.includes("deepseek"));
	assert.ok(s.includes("403 disabled"));
	assert.ok(s.includes("quorum not reached"));
});

check("pipes and newlines in evidence cannot break the markdown table", () => {
	const nasty: ParsedVerdict = {
		layer: "L1", verdict: "pass", findings: [],
		summary: "a | b\nc | d", raw: {},
	};
	const s = renderSummary(input({ l1: nasty }));
	const row = s.split("\n").find((l) => l.startsWith("| L1 |"))!;
	// Count UNESCAPED pipes: \| is literal content, not a cell separator.
	const cells = row.split(/(?<!\\)\|/);
	assert.equal(cells.length, 6, `table row must stay well-formed: ${row}`);
	assert.ok(row.includes("\\|"), "pipes in content must be escaped");
	assert.ok(!row.includes("\n"));
});

check("risk assessment is deterministic and lists forbidden hits", () => {
	const withRisk = input({
		risk: {
			level: "high",
			reasons: ["命中 src/platform/", "改动 400 行 > 300"],
			forbiddenHits: ["third_party/x.cpp"],
			changedFiles: ["src/platform/win/a.cpp", "third_party/x.cpp"],
			changedLines: 400,
			gates: { l0: true, l1: true, panel: true, human: true },
		},
	});
	const a = renderRiskAssessment(withRisk);
	assert.equal(a, renderRiskAssessment(withRisk));
	assert.ok(a.includes("level: high"));
	assert.ok(a.includes("third_party/x.cpp"));
	assert.ok(a.includes("命中 src/platform/"));
	assert.ok(a.includes("L2 跨 vendor 面板: 执行"));
});

check("risk assessment without grading says so explicitly", () => {
	const s = renderRiskAssessment(input());
	assert.ok(s.includes("未分级"));
	assert.ok(!s.includes("level: low"), "must not invent a level");
});

// ------------------------------------------------------------------ package build
check("package writes the blueprint artifacts and a self-contained copy", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input());
		for (const f of ["diff.patch", "diff-stat.txt", "l0-results.json", "l1-findings.json", "summary.md", "risk-assessment.md", "evidence.sha256", "artifacts-index.md"]) {
			assert.ok(store.exists(`${pkg.dir}/${f}`), `package missing ${f}`);
			assert.ok(pkg.files.includes(f), `files list missing ${f}`);
		}
		// Canonical checkpoint copies exist too.
		assert.ok(store.exists("checkpoints/cp1/diff.patch"));
		assert.ok(store.exists("checkpoints/cp1/l0-results.json"));
		assert.equal(pkg.dir, "checkpoints/cp1/review-package");
	} finally { cleanup(); }
});

check("#8 package manifest verifies with the store and by independent recomputation", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input());
		const v = store.verifyEvidenceManifest(pkg.dir);
		assert.ok(v.ok, v.problems.join("; "));
		// Independent recomputation, no store helpers.
		for (const line of pkg.manifest.split("\n").filter(Boolean)) {
			const i = line.indexOf("  ");
			const rel = line.slice(i + 2);
			const bytes = fs.readFileSync(store.resolve(`${pkg.dir}/${rel}`));
			assert.equal(sha256(bytes), line.slice(0, i), `hash mismatch: ${rel}`);
		}
	} finally { cleanup(); }
});

check("manifest excludes itself and the derived index", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input());
		assert.ok(!pkg.manifest.includes("evidence.sha256"));
		assert.ok(!pkg.manifest.includes("artifacts-index.md"));
	} finally { cleanup(); }
});

check("packageHash binds to the manifest and changes when content changes", () => {
	const { store, cleanup } = sandbox();
	try {
		const first = buildReviewPackage(store, input());
		assert.equal(first.packageHash, sha256(first.manifest));
		const second = buildReviewPackage(store, input({ diff: "diff --git a/b.cpp b/b.cpp\n+other\n" }));
		assert.notEqual(first.packageHash, second.packageHash, "a different diff must invalidate the hash");
	} finally { cleanup(); }
});

check("identical input produces an identical packageHash (reproducible approval target)", () => {
	const { store, cleanup } = sandbox();
	try {
		const a = buildReviewPackage(store, input());
		const b = buildReviewPackage(store, input());
		assert.equal(a.packageHash, b.packageHash);
	} finally { cleanup(); }
});

check("tampering with a packaged artifact is detected", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input());
		store.writeText(`${pkg.dir}/summary.md`, "# TAMPERED\n");
		const v = store.verifyEvidenceManifest(pkg.dir);
		assert.ok(!v.ok);
		assert.ok(v.problems.some((p) => p.includes("summary.md")));
	} finally { cleanup(); }
});

check("#8 a secret in the diff is refused before anything is written", () => {
	const { store, cleanup } = sandbox();
	try {
		assert.throws(
			() => buildReviewPackage(store, input({ diff: "+const key = \"sk-abcdefghijklmnopqrstuvwx\";\n" })),
			SecretInArtifactError,
		);
		assert.equal(store.exists("checkpoints/cp1/review-package/evidence.sha256"), false);
	} finally { cleanup(); }
});

check("artifacts index lists the hashed files with byte counts", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input());
		const idx = store.readText(`${pkg.dir}/artifacts-index.md`)!;
		assert.ok(idx.includes("diff.patch"));
		assert.ok(idx.includes("summary.md"));
		assert.ok(/`[0-9a-f]{16}`/.test(idx), "index should show a hash prefix");
		assert.ok(idx.includes("索引本身不参与 hash"));
	} finally { cleanup(); }
});

check("panel artifacts are persisted when a panel ran", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input({ panel: panelAgg, panelRecords: [] }));
		assert.ok(store.exists(`${pkg.dir}/l2-panel.json`));
		assert.ok(store.exists(`${pkg.dir}/l2-panel-members.json`));
		const saved = store.readJson<PanelAggregate>(`${pkg.dir}/l2-panel.json`)!;
		assert.equal(saved.outcome, "BLOCKED");
	} finally { cleanup(); }
});

check("checkpoint ids are normalised so they cannot traverse", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input({ checkpointId: "../../evil" }));
		assert.ok(pkg.dir.startsWith("checkpoints/"), pkg.dir);
		assert.ok(!pkg.dir.includes(".."), pkg.dir);
		assert.ok(store.verifyEvidenceManifest(pkg.dir).ok);
	} finally { cleanup(); }
});

check("stage is recorded so spec/plan packages are distinguishable", () => {
	const { store, cleanup } = sandbox();
	try {
		const pkg = buildReviewPackage(store, input({ stage: "spec", checkpointId: "spec-1" }));
		assert.ok(pkg.summary.includes("· spec ·"));
		assert.ok(store.exists("checkpoints/spec-1/review-package/summary.md"));
	} finally { cleanup(); }
});

console.log("== package.ts tests ==");
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
