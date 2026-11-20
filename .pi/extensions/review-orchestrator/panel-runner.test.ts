// Tests for panel-runner.ts — injected child runner, no real subprocess.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/panel-runner.test.ts
import assert from "node:assert/strict";
import { runPanel, type PanelRunOptions } from "./panel-runner.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";

let passed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const check = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const MEMBERS = [
	{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
	{ model: "qoder/Qwen4-Max-Preview", family: "qwen" },
	{ model: "hellocode/gpt-6-luna", family: "openai" },
];

const L2_PASS = JSON.stringify({ layer: "L2", verdict: "pass", findings: [], summary: "ok" });
const L2_FAIL = JSON.stringify({
	layer: "L2", verdict: "fail",
	findings: [{ severity: "warning", file: "a.cpp", line: 5, evidence: "violates HANDOFF-1", required_fix: "fix" }],
	summary: "bad",
});

function ok(text: string, model: string): RunChildResult {
	return { ok: true, assistantText: text, model, rawStdout: "", stderr: "", exitCode: 0, signal: null, timeout: false };
}
function fail(model: string, error: string): RunChildResult {
	return {
		ok: false, assistantText: "", model, rawStdout: "", stderr: "", exitCode: 0, signal: null,
		timeout: false, error, stopReason: "error", errorMessage: error,
	};
}

function opts(runChild: (o: RunChildOptions) => Promise<RunChildResult>, over: Partial<PanelRunOptions> = {}): PanelRunOptions {
	return {
		cwd: ".",
		members: MEMBERS,
		systemPrompt: "L2 reviewer prompt",
		task: "=== DIFF ===\n+code",
		quorum: 2,
		minDistinctFamilies: 2,
		concurrency: 2,
		timeoutMs: 1000,
		thinking: "low",
		runChild,
		...over,
	};
}

check("each member gets its own model, read-only tools and identical task", async () => {
	const seen: RunChildOptions[] = [];
	const r = await runPanel(opts(async (o) => {
		seen.push(o);
		return ok(L2_PASS, o.model!);
	}));
	assert.equal(seen.length, 3);
	assert.deepEqual(seen.map((s) => s.model).sort(), MEMBERS.map((m) => m.model).sort());
	for (const s of seen) {
		assert.deepEqual(s.tools, ["read", "grep", "find", "ls"], "write tools must be absent");
		assert.equal(s.userPrompt, "=== DIFF ===\n+code", "members must see the same task");
		assert.equal(s.systemPrompt, "L2 reviewer prompt");
		assert.equal(s.thinking, "low");
	}
	assert.equal(r.aggregate.outcome, "PASS");
});

check("members cannot see each other's output (no cross-member leakage)", async () => {
	const tasks: string[] = [];
	await runPanel(opts(async (o) => {
		tasks.push(o.userPrompt);
		// A member's reply contains a marker that must never reach another member.
		return ok(L2_PASS, o.model!);
	}));
	assert.equal(new Set(tasks).size, 1, "all tasks identical → no member output injected");
});

check("a failing member does not abort the batch", async () => {
	let calls = 0;
	const r = await runPanel(opts(async (o) => {
		calls++;
		if (o.model === MEMBERS[1].model) return fail(o.model!, "model error (error): 403 Model access is disabled");
		return ok(L2_PASS, o.model!);
	}));
	assert.equal(calls, 3, "all members must still be attempted");
	assert.equal(r.aggregate.outcome, "PASS", "2 valid votes across 2 families meet quorum");
	assert.equal(r.aggregate.absent.length, 1);
	assert.ok(r.aggregate.reasons.some((x) => x.includes("403")));
});

check("a thrown runner is recorded absent, not fatal", async () => {
	const r = await runPanel(opts(async (o) => {
		if (o.model === MEMBERS[0].model) throw new Error("spawn exploded");
		return ok(L2_PASS, o.model!);
	}));
	assert.equal(r.aggregate.outcome, "PASS");
	assert.ok(r.records.find((x) => x.model === MEMBERS[0].model)?.error?.includes("spawn exploded"));
});

check("malformed verdict counts absent with the validation reason", async () => {
	const r = await runPanel(opts(async (o) => {
		if (o.model === MEMBERS[0].model) return ok("I think it looks fine.", o.model!);
		return ok(L2_PASS, o.model!);
	}));
	assert.equal(r.aggregate.absent.length, 1);
	assert.ok(r.records[0].error?.includes("invalid verdict"));
});

check("one FAIL makes the panel FAIL and carries member evidence", async () => {
	const r = await runPanel(opts(async (o) =>
		o.model === MEMBERS[2].model ? ok(L2_FAIL, o.model!) : ok(L2_PASS, o.model!),
	));
	assert.equal(r.aggregate.outcome, "FAIL");
	assert.equal(r.aggregate.blockingFindings.length, 1);
	assert.equal(r.aggregate.blockingFindings[0].family, "openai");
});

check("too many absent members → BLOCKED, never PASS", async () => {
	const r = await runPanel(opts(async (o) =>
		o.model === MEMBERS[0].model ? ok(L2_PASS, o.model!) : fail(o.model!, "timed out after 1000ms"),
	));
	assert.equal(r.aggregate.outcome, "BLOCKED");
	assert.ok(r.aggregate.reasons.some((x) => x.includes("quorum not reached")));
});

check("same-family survivors cannot fake independence", async () => {
	const r = await runPanel(opts(async (o) => ok(L2_PASS, o.model!), {
		members: [
			{ model: "deepseek/deepseek-v4-pro", family: "deepseek" },
			{ model: "trae-cn/deepseek-v4.1-flash", family: "deepseek" },
		],
		quorum: 2,
		minDistinctFamilies: 2,
	}));
	assert.equal(r.aggregate.outcome, "BLOCKED");
	assert.ok(r.aggregate.reasons.some((x) => x.includes("vendor independence")));
});

check("concurrency cap is respected", async () => {
	let active = 0;
	let peak = 0;
	await runPanel(opts(async (o) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 20));
		active--;
		return ok(L2_PASS, o.model!);
	}, { concurrency: 2 }));
	assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
	assert.equal(peak, 2, "should actually use the allowed parallelism");
});

check("records keep member order and record the reported model", async () => {
	const r = await runPanel(opts(async (o) => {
		// Finish out of order to prove ordering is by member, not completion.
		const delay = o.model === MEMBERS[0].model ? 30 : 5;
		await new Promise((res) => setTimeout(res, delay));
		return ok(L2_PASS, `reported/${o.model!.split("/")[1]}`);
	}));
	assert.deepEqual(r.records.map((x) => x.model), MEMBERS.map((m) => m.model));
	assert.ok(r.records.every((x) => x.reportedModel?.startsWith("reported/")));
	assert.ok(r.records.every((x) => typeof x.durationMs === "number" && x.durationMs >= 0));
});

check("empty member list yields BLOCKED without calling the runner", async () => {
	let calls = 0;
	const r = await runPanel(opts(async (o) => { calls++; return ok(L2_PASS, o.model!); }, { members: [], quorum: 1 }));
	assert.equal(calls, 0);
	assert.equal(r.aggregate.outcome, "BLOCKED");
});

check("abort signal is forwarded to every member", async () => {
	const ac = new AbortController();
	const seen: (AbortSignal | undefined)[] = [];
	await runPanel(opts(async (o) => {
		seen.push(o.signal);
		return ok(L2_PASS, o.model!);
	}, { signal: ac.signal }));
	assert.equal(seen.length, 3);
	assert.ok(seen.every((s) => s === ac.signal));
});

console.log("== panel-runner.ts tests ==");
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
