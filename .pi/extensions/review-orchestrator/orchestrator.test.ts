// Tests for orchestrator.ts — all deps injected, no real subprocess / toolchain.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/orchestrator.test.ts
import assert from "node:assert/strict";
import { runReviewPipeline, structuredProjection, collectNonBlockingNotes, hashText, decideRetry } from "./orchestrator.ts";
import type { CommandRunner, CommandResult } from "./l0.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];

function check(name: string, fn: () => Promise<void> | void) {
	tests.push([name, fn]);
}

const OK: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };

/** Fake git/cmake/ctest runner. */
function fakeRunner(opts: { diff?: string; untracked?: string; build?: CommandResult; ctest?: CommandResult } = {}): CommandRunner {
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		if (key.startsWith("git diff")) return { exitCode: 0, stdout: opts.diff ?? "+int changed();", stderr: "" };
		// Real git ls-files prints nothing when there are no untracked files.
		if (key.startsWith("git ls-files")) return { exitCode: 0, stdout: opts.untracked ?? "", stderr: "" };
		if (key.startsWith("cmake --build")) return opts.build ?? OK;
		if (key.startsWith("ctest")) return opts.ctest ?? OK;
		throw new Error(`unexpected: ${key}`);
	};
}

interface ChildScript {
	/** The verdict JSON text (or arbitrary text) this call returns. */
	text: string;
	/** Extra prose appended AFTER the JSON, to test anti-crosstalk. */
	trailingProse?: string;
}

/** Fake child runner that records every task it was given. */
function fakeChild(script: Partial<Record<"L1" | "L2", ChildScript[]>>) {
	const seen: { layer: "L1" | "L2"; task: string }[] = [];
	const calls = { L1: 0, L2: 0 };
	const runChild = async (o: RunChildOptions): Promise<RunChildResult> => {
		// Infer the layer from the system prompt marker we inject in the test.
		const layer: "L1" | "L2" = o.systemPrompt.includes("L2") ? "L2" : "L1";
		seen.push({ layer, task: o.userPrompt });
		const list = script[layer] ?? [];
		const idx = Math.min(calls[layer], list.length - 1);
		calls[layer]++;
		const entry = list[idx] ?? { text: '{"layer":"' + layer + '","verdict":"pass","findings":[],"summary":"ok"}' };
		return {
			ok: true,
			assistantText: entry.text + (entry.trailingProse ? `\n\n${entry.trailingProse}` : ""),
			rawStdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
			timeout: false,
		};
	};
	return { runChild, seen, calls };
}

function deps(run: CommandRunner, runChild: (o: RunChildOptions) => Promise<RunChildResult>) {
	return {
		cwd: ".",
		run,
		runChild,
		systemPrompt: (layer: "L1" | "L2") => (layer === "L1" ? "You are the L1 semantic reviewer." : "You are the L2 architecture reviewer."),
		constraintChecklist: "- HANDOFF-1: capture frame slot cap = 1",
		diffCap: 1000,
	};
}

// ---------------------------------------------------------------------------

check("hashText is stable and distinguishes content", () => {
	assert.equal(hashText("abc"), hashText("abc"));
	assert.notEqual(hashText("abc"), hashText("abd"));
});

check("no diff → outcome no-diff, no children spawned", async () => {
	const c = fakeChild({});
	const r = await runReviewPipeline(deps(fakeRunner({ diff: "" }), c.runChild));
	assert.equal(r.outcome, "no-diff");
	assert.equal(c.seen.length, 0);
});

check("untracked-only change still counts as a diff", async () => {
	const c = fakeChild({});
	const r = await runReviewPipeline(deps(fakeRunner({ diff: "", untracked: "new_file.cpp\n" }), c.runChild));
	assert.equal(r.outcome, "pass", "untracked files must not be treated as no-diff");
	assert.ok(r.diff.includes("new_file.cpp"));
});

check("L0 build failure blocks before any LLM layer", async () => {
	const c = fakeChild({});
	const r = await runReviewPipeline(
		deps(fakeRunner({ build: { exitCode: 1, stdout: "", stderr: "error: boom" } }), c.runChild),
	);
	assert.equal(r.outcome, "blocked");
	assert.equal(r.blockingLayer, "L0");
	assert.equal(c.seen.length, 0, "no child may run when L0 fails");
	assert.ok(r.rejectionText.includes("boom"), "compiler error must reach the coder");
});

check("L0 ctest gate failure names arch.layers / spec.structure", async () => {
	const c = fakeChild({});
	const r = await runReviewPipeline(
		deps(
			fakeRunner({ ctest: { exitCode: 8, stdout: " 1 - arch.layers (Failed)\n 2 - spec.structure (Failed)", stderr: "" } }),
			c.runChild,
		),
	);
	assert.equal(r.blockingLayer, "L0");
	assert.ok(r.rejectionText.includes("ctest:arch.layers"));
	assert.ok(r.rejectionText.includes("ctest:spec.structure"));
});

check("L1 fail blocks before L2", async () => {
	const c = fakeChild({
		L1: [
			{
				text: JSON.stringify({
					layer: "L1",
					verdict: "fail",
					findings: [{ severity: "warning", file: "a.cpp", line: 7, evidence: "null deref when x==0", required_fix: "guard x" }],
					summary: "L1 found a bug",
				}),
			},
		],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "blocked");
	assert.equal(r.blockingLayer, "L1");
	assert.deepEqual(c.seen.map((s) => s.layer), ["L1"], "L2 must not run after L1 blocks");
	assert.ok(r.rejectionText.includes("a.cpp:7"));
	assert.ok(r.rejectionText.includes("guard x"));
});

check("L1 prose never reaches the L2 task (anti-crosstalk)", async () => {
	const MARKER = "SECRET_L1_REASONING_MARKER_42";
	const c = fakeChild({
		L1: [{ text: '{"layer":"L1","verdict":"pass","findings":[],"summary":"clean"}', trailingProse: MARKER }],
		L2: [{ text: '{"layer":"L2","verdict":"pass","findings":[],"summary":"ok"}' }],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "pass");
	const l2Task = c.seen.find((s) => s.layer === "L2")?.task ?? "";
	assert.ok(l2Task.length > 0, "L2 must have run");
	assert.ok(!l2Task.includes(MARKER), "L1 prose leaked into the L2 task");
	// The structured verdict itself IS allowed through.
	assert.ok(l2Task.includes('"layer": "L1"'), "L2 should receive L1's structured verdict");
});

check("L2 task carries the constraint checklist", async () => {
	const c = fakeChild({});
	await runReviewPipeline(deps(fakeRunner(), c.runChild));
	const l2Task = c.seen.find((s) => s.layer === "L2")?.task ?? "";
	assert.ok(l2Task.includes("HANDOFF-1"), "constraint checklist missing from L2 task");
	assert.ok(l2Task.includes("CONSTRAINT CHECKLIST"));
});

check("malformed verdict is retried once, then reported invalid", async () => {
	const c = fakeChild({
		L1: [
			{ text: "I think the code looks fine overall." },
			{ text: "Still no JSON here." },
		],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "invalid");
	assert.equal(r.blockingLayer, "L1");
	assert.equal(c.calls.L1, 2, "must retry exactly once");
	assert.equal(c.seen.filter((s) => s.layer === "L2").length, 0);
});

check("a retry that yields valid JSON succeeds", async () => {
	const c = fakeChild({
		L1: [
			{ text: "no json" },
			{ text: '{"layer":"L1","verdict":"pass","findings":[],"summary":"ok"}' },
		],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "pass");
	assert.equal(c.calls.L1, 2);
});

check("L2 verdict with a made-up constraint ID is rejected, not accepted", async () => {
	const c = fakeChild({
		L2: [
			{ text: '{"layer":"L2","verdict":"fail","findings":[{"file":"a.cpp","line":1,"evidence":"feels wrong","required_fix":"x"}],"summary":"bad"}' },
			{ text: '{"layer":"L2","verdict":"fail","findings":[{"file":"a.cpp","line":1,"evidence":"feels wrong","required_fix":"x"}],"summary":"bad"}' },
		],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "invalid", "an L2 finding without a constraint ID must not be accepted");
});

check("suggestions / uncertain do not block and are reported as notes", async () => {
	const c = fakeChild({
		L2: [
			{
				text: JSON.stringify({
					layer: "L2",
					verdict: "pass",
					findings: [{ severity: "suggestion", uncertain: true, file: "d.cpp", line: 3, evidence: "PLAT-1 maybe violated", required_fix: "check" }],
					summary: "needs human review",
				}),
			},
		],
	});
	const r = await runReviewPipeline(deps(fakeRunner(), c.runChild));
	assert.equal(r.outcome, "pass");
	assert.ok(r.summary.includes("需人工留意"));
	assert.ok(r.summary.includes("PLAT-1"));
});

check("structuredProjection drops raw and keeps evidence fields", () => {
	const p = structuredProjection({
		layer: "L1",
		verdict: "fail",
		findings: [{ severity: "warning", file: "a.cpp", line: 2, evidence: "e", required_fix: "f", secret: "should-not-copy" } as any],
		summary: "s",
		raw: { secret: "raw-blob" },
	});
	assert.ok(!p.includes("raw-blob"), "raw verdict blob must not cross layers");
	assert.ok(!p.includes("should-not-copy"), "unknown finding fields must not cross layers");
	assert.ok(p.includes('"file": "a.cpp"'));
});

check("collectNonBlockingNotes ignores blocking findings", () => {
	const notes = collectNonBlockingNotes({
		L1: { layer: "L1", verdict: "pass", findings: [{ severity: "suggestion", file: "a", line: 1, evidence: "nit" }], summary: "x", raw: {} },
	});
	assert.ok(notes.includes("nit"));
	const empty = collectNonBlockingNotes({
		L1: { layer: "L1", verdict: "pass", findings: [], summary: "x", raw: {} },
	});
	assert.equal(empty, "");
});

check("decideRetry repairs while inside the retry budget", () => {
	const d = decideRetry({ attempt: 1, maxRetries: 2, diffHash: "b", lastDiffHash: "a" });
	assert.deepEqual(d, { action: "repair", attempt: 1 });
	const second = decideRetry({ attempt: 2, maxRetries: 2, diffHash: "c", lastDiffHash: "b" });
	assert.equal(second.action, "repair", "the 2nd retry must still be allowed");
});

check("decideRetry hands control to the human past the budget", () => {
	const d = decideRetry({ attempt: 3, maxRetries: 2, diffHash: "d", lastDiffHash: "c" });
	assert.equal(d.action, "manual");
	assert.ok(d.reason.includes("2"));
});

check("decideRetry stops when the fix changed nothing", () => {
	const same = decideRetry({ attempt: 1, maxRetries: 2, diffHash: "same", lastDiffHash: "same" });
	assert.equal(same.action, "stop", "re-reviewing an unchanged diff burns tokens for nothing");
	const empty = decideRetry({ attempt: 1, maxRetries: 2, diffHash: "", lastDiffHash: "x" });
	assert.equal(empty.action, "stop");
});

check("decideRetry terminates for any attempt count (no unbounded loop)", () => {
	for (let attempt = 0; attempt <= 50; attempt++) {
		const d = decideRetry({ attempt, maxRetries: 2, diffHash: `h${attempt}`, lastDiffHash: `h${attempt - 1}` });
		assert.ok(["repair", "manual", "stop"].includes(d.action));
		if (attempt > 2) assert.equal(d.action, "manual", `attempt ${attempt} must be terminal`);
	}
});

console.log("== orchestrator.ts tests ==");
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
