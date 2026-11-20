// Tests for risk.ts — deterministic grading must be table-driven and auditable.
// Run: node --experimental-strip-types .pi/orchestrator/tests/review/risk.test.ts
import assert from "node:assert/strict";
import { assessRisk, mayAutoCommit, pathMatches, changedContentLines } from "../../src/review/risk.ts";
import { loadConfig, type RiskConfig } from "../../src/workflow/config.ts";

let passed = 0;
const tests: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

const cfg = loadConfig(process.cwd());
assert.ok(cfg.ok, cfg.errors.join("; "));
const RULES: RiskConfig = cfg.config!.risk;

/** Build a realistic unified diff for one file with n added lines. */
function diffFor(file: string, lines: string[]): string {
	return [
		`diff --git a/${file} b/${file}`,
		`--- a/${file}`,
		`+++ b/${file}`,
		"@@ -1 +1 @@",
		...lines.map((l) => `+${l}`),
	].join("\n");
}

function grade(file: string, lines: string[] = ["int x = 1;"]) {
	const diff = diffFor(file, lines);
	return assessRisk(RULES, { diff, changedFiles: [file], changedLines: lines.length });
}

// ------------------------------------------------------------------ path matching
check("pathMatches treats prefixes as directories, not substrings", () => {
	assert.ok(pathMatches("src/platform/win/a.cpp", "src/platform/"));
	assert.ok(pathMatches("src/platform", "src/platform/"));
	assert.ok(!pathMatches("src/platformish/a.cpp", "src/platform/"), "prefix must not match a sibling");
	assert.ok(pathMatches("./src/platform/a.cpp", "src/platform/"));
	assert.ok(pathMatches("src\\platform\\a.cpp", "src/platform/"), "windows separators normalised");
	assert.ok(pathMatches("include/remotedesktop/assert.h", "include/remotedesktop/"));
	assert.ok(!pathMatches("docs/architecture.md", "src/"));
});

check("changedContentLines ignores diff headers", () => {
	const d = diffFor("docs/security.md", ["auth token rotation"]);
	const lines = changedContentLines(d);
	assert.deepEqual(lines, ["auth token rotation"]);
	assert.ok(!lines.some((l) => l.includes("docs/security.md")), "filename must not be scanned as content");
});

// ------------------------------------------------------------------ #11 grading table
const TABLE: Array<{ file: string; lines: string[]; expect: "low" | "medium" | "high"; why: string }> = [
	{ file: "src/platform/win/input_inject_win.cpp", lines: ["int x=1;"], expect: "high", why: "platform layer" },
	{ file: "src/transport/tls.cpp", lines: ["int x=1;"], expect: "high", why: "transport layer" },
	{ file: "src/session/state.cpp", lines: ["int x=1;"], expect: "high", why: "session layer" },
	{ file: "src/input/queue.cpp", lines: ["int x=1;"], expect: "high", why: "input layer" },
	{ file: "include/remotedesktop/assert.h", lines: ["int x=1;"], expect: "high", why: "public API header" },
	{ file: "src/capture/frame.cpp", lines: ["int x=1;"], expect: "medium", why: "capture layer" },
	{ file: "src/codec/enc.cpp", lines: ["int x=1;"], expect: "medium", why: "codec layer" },
	{ file: "specs/spec-x.md", lines: ["text"], expect: "medium", why: "spec change" },
	{ file: "docs/architecture.md", lines: ["text"], expect: "medium", why: "docs change" },
	{ file: "README.md", lines: ["text"], expect: "low", why: "small unrelated file" },
	{ file: "tools/helper.py", lines: ["x = 1"], expect: "low", why: "tooling, small" },
	{ file: "third_party/gtest/x.h", lines: ["int x=1;"], expect: "high", why: "forbidden path" },
	{ file: "build/debug/x.o", lines: ["bin"], expect: "high", why: "forbidden build dir" },
];

for (const row of TABLE) {
	check(`#11 ${row.why}: ${row.file} → ${row.expect}`, () => {
		const r = grade(row.file, row.lines);
		assert.equal(r.level, row.expect, `${row.file} reasons: ${r.reasons.join("; ")}`);
		assert.ok(r.reasons.length > 0, "every grade must be explained");
		assert.ok(r.decidedBy, "audit must record which rule decided");
	});
}

// ------------------------------------------------------------------ line thresholds
check("#11 line-count thresholds are inclusive/exclusive as configured", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => `int v${i} = ${i};`);
	// below medium → low
	assert.equal(grade("tools/a.py", many(RULES.mediumLines - 1)).level, "low");
	// exactly medium → medium
	assert.equal(grade("tools/a.py", many(RULES.mediumLines)).level, "medium");
	// exactly high threshold → still medium (rule is > highLines)
	assert.equal(grade("tools/a.py", many(RULES.highLines)).level, "medium");
	// above high threshold → high
	const big = grade("tools/a.py", many(RULES.highLines + 1));
	assert.equal(big.level, "high");
	assert.equal(big.decidedBy, "line-count-high");
});

// ------------------------------------------------------------------ security patterns
check("#11 security keywords in changed CONTENT raise the grade", () => {
	for (const kw of ["encrypt_frame", "verify_token", "SendInput(", "check_password"]) {
		const r = grade("tools/a.py", [`${kw} // touched`]);
		assert.equal(r.level, "high", `${kw} should be high`);
		assert.equal(r.decidedBy, "security-pattern");
	}
});

check("#11 a security word only in the FILENAME does not raise the grade", () => {
	// docs/ is medium by path, but must NOT be high just because of its name.
	const r = grade("docs/security.md", ["ordinary prose about the design"]);
	assert.equal(r.level, "medium");
	assert.notEqual(r.decidedBy, "security-pattern");
});

check("security matching is case-insensitive", () => {
	assert.equal(grade("tools/a.py", ["ENCRYPT_BUFFER"]).level, "high");
});

check("security patterns are treated literally, not as regex", () => {
	// A pattern containing regex metacharacters must not blow up or over-match.
	const rules: RiskConfig = { ...RULES, securityPatterns: ["a.b("] };
	const r = assessRisk(rules, {
		diff: diffFor("tools/a.py", ["axb stuff"]),
		changedFiles: ["tools/a.py"],
		changedLines: 1,
	});
	assert.equal(r.level, "low", "a.b( must match literally, not as regex");
});

// ------------------------------------------------------------------ forbidden paths
check("#11 forbidden hits are reported separately and force high", () => {
	const r = grade("third_party/gtest/x.h");
	assert.equal(r.level, "high");
	assert.deepEqual(r.forbiddenHits, ["third_party/gtest/x.h"]);
	assert.equal(r.decidedBy, "forbidden-path");
	assert.ok(r.reasons.some((x) => x.includes("禁止路径")));
});

check("forbidden path wins over every other rule", () => {
	const r = assessRisk(RULES, {
		diff: diffFor("third_party/x.h", ["int x=1;"]),
		changedFiles: ["third_party/x.h", "README.md"],
		changedLines: 1,
	});
	assert.equal(r.level, "high");
	assert.equal(r.decidedBy, "forbidden-path");
});

check("a clean change has no forbidden hits", () => {
	assert.deepEqual(grade("README.md").forbiddenHits, []);
});

// ------------------------------------------------------------------ determinism
check("#11 grading is deterministic for identical input", () => {
	const input = { diff: diffFor("src/platform/a.cpp", ["int x=1;"]), changedFiles: ["src/platform/a.cpp"], changedLines: 1 };
	const a = assessRisk(RULES, input);
	const b = assessRisk(RULES, input);
	assert.deepEqual(a, b);
});

check("the strongest rule wins when several fire", () => {
	const r = assessRisk(RULES, {
		diff: diffFor("src/platform/a.cpp", ["encrypt_frame();"]),
		changedFiles: ["src/platform/a.cpp", "docs/x.md"],
		changedLines: 500,
	});
	assert.equal(r.level, "high");
	// platform path is checked before security/line-count
	assert.equal(r.decidedBy, "high-path");
	assert.ok(r.reasons.length >= 3, "all applicable reasons should still be listed");
});

check("reasons name the concrete files and thresholds for audit", () => {
	const r = grade("src/platform/win/a.cpp");
	assert.ok(r.reasons.some((x) => x.includes("src/platform/win/a.cpp")));
	const big = grade("tools/a.py", Array.from({ length: RULES.highLines + 5 }, (_, i) => `int v${i};`));
	assert.ok(big.reasons.some((x) => x.includes(String(RULES.highLines))));
});

check("empty input grades low with an explicit reason", () => {
	const r = assessRisk(RULES, { diff: "", changedFiles: [], changedLines: 0 });
	assert.equal(r.level, "low");
	assert.ok(r.reasons.length > 0);
});

// ------------------------------------------------------------------ #13 auto-commit
check("#13 mayAutoCommit requires explicit authorisation", () => {
	const low = grade("README.md");
	assert.equal(mayAutoCommit(low, false), false, "default off must never commit");
	assert.equal(mayAutoCommit(low, true), true);
});

check("#13 medium and high never auto-commit even when enabled", () => {
	assert.equal(mayAutoCommit(grade("docs/x.md"), true), false);
	assert.equal(mayAutoCommit(grade("src/platform/a.cpp"), true), false);
});

check("#13 forbidden hits never auto-commit even at low grade", () => {
	const forced = { ...grade("README.md"), forbiddenHits: ["third_party/x.h"] };
	assert.equal(mayAutoCommit(forced, true), false);
});

console.log("== risk.ts tests ==");
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
