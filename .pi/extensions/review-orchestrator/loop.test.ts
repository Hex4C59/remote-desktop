// Retry-loop state machine tests (verification item #8).
//
// Regression: the /review command handler used to zero `attempt` on EVERY
// invocation, including the auto-recheck dispatched by agent_settled. That
// reset the budget each round, so MAX_RETRIES never fired and a persistently
// failing review looped forever. The fix routes the decision through the real
// `nextAttempt()` helper with an explicit `continuation` flag.
//
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/loop.test.ts
import assert from "node:assert/strict";
import { decideRetry, nextAttempt } from "./orchestrator.ts";

const MAX_RETRIES = 2;
const HARD_CAP = 50; // more rounds than this means the loop is unbounded

/**
 * Replay /review → blocked → coder fixes → agent_settled → /review …
 * using the SAME helpers index.ts calls, so this covers the real decision logic.
 *
 * The diff changes every round, so the "nothing changed" brake must not be what
 * stops the loop — only the retry budget may stop it.
 */
function simulate(opts: { resetAlways: boolean }): { rounds: number; terminal: string } {
	let attempt = 0;
	let continuation = false;
	let round = 0;

	while (round < HARD_CAP) {
		round++;

		// --- /review command handler ---
		attempt = opts.resetAlways ? 0 : nextAttempt({ attempt, continuation });
		continuation = false;

		// --- pipeline blocks; executePipeline increments the counter ---
		attempt += 1;
		const reviewedHash = `diff-round-${round}`;
		if (attempt > MAX_RETRIES) return { rounds: round, terminal: "manual" };

		// --- coder edits something, then agent_settled fires ---
		const decision = decideRetry({
			attempt,
			maxRetries: MAX_RETRIES,
			diffHash: `diff-fix-${round}`,
			lastDiffHash: reviewedHash,
		});
		if (decision.action !== "repair") return { rounds: round, terminal: decision.action };
		continuation = true; // settle hook marks the next /review as a continuation
	}
	return { rounds: round, terminal: "UNBOUNDED" };
}

let passed = 0;
const tests: Array<[string, () => void]> = [
	[
		"nextAttempt: a human-typed /review starts a fresh budget",
		() => {
			assert.equal(nextAttempt({ attempt: 5, continuation: false }), 0);
			assert.equal(nextAttempt({ attempt: 0, continuation: false }), 0);
		},
	],
	[
		"nextAttempt: an auto-recheck keeps counting (the regression)",
		() => {
			assert.equal(nextAttempt({ attempt: 1, continuation: true }), 1);
			assert.equal(nextAttempt({ attempt: 2, continuation: true }), 2);
		},
	],
	[
		"#8 persistently failing review terminates within the retry budget",
		() => {
			const r = simulate({ resetAlways: false });
			assert.notEqual(r.terminal, "UNBOUNDED", "the retry loop must not run forever");
			assert.equal(r.terminal, "manual", "it must hand back to the human");
			assert.ok(r.rounds <= MAX_RETRIES + 1, `expected <= ${MAX_RETRIES + 1} rounds, got ${r.rounds}`);
		},
	],
	[
		"#8 zeroing the counter every round is provably unbounded",
		() => {
			assert.equal(simulate({ resetAlways: true }).terminal, "UNBOUNDED");
			assert.notEqual(simulate({ resetAlways: false }).terminal, "UNBOUNDED");
		},
	],
	[
		"#8 the unchanged-diff brake stops the loop even inside the budget",
		() => {
			const d = decideRetry({ attempt: 1, maxRetries: MAX_RETRIES, diffHash: "same", lastDiffHash: "same" });
			assert.equal(d.action, "stop");
		},
	],
];

console.log("== retry loop tests ==");
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
