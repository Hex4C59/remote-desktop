// End-to-end verification for plan step 10 (verification items #2, #3, #10).
//
// Runs the REAL toolchain through the real orchestrator, with a child runner
// that fails loudly if any LLM layer is invoked. This proves:
//   - L0 passes on a healthy tree;
//   - a real compile error makes L0 fail and L1/L2 are never called;
//   - the build log reaches the coder-facing rejection text;
//   - ctest (incl. arch.layers / spec.structure) is part of L0.
//
// The intentionally broken source is restored in a finally block.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runL0Gate, detectPreset, type CommandRunner, type CommandResult } from "./l0.ts";
import { runReviewPipeline } from "./orchestrator.ts";
import { validateVerdict } from "./verdict.ts";

const SRC = path.join(process.cwd(), "src", "assert.cpp");
const original = fs.readFileSync(SRC, "utf-8");
const cwd = process.cwd();
const preset = detectPreset(cwd);

const realRunner: CommandRunner = (command, args, options) =>
	new Promise<CommandResult>((resolve) => {
		execFile(
			command,
			args,
			{ cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
				resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
	});

let childCalls = 0;
const forbiddenChild = async () => {
	childCalls++;
	throw new Error("LLM layer was invoked while L0 should have blocked");
};

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail.split("\n").join("\n      ")}`);
}

async function main() {
	console.log(`preset detected: ${preset}\n`);

	// --- 1) healthy tree: L0 must pass, ctest must include the gate cases ---
	const healthy = await runL0Gate({ cwd, run: realRunner });
	const healthyCheck = validateVerdict(healthy, "L0");
	record(
		"#10 L0 on healthy tree passes and emits a schema-valid verdict",
		healthy.verdict === "pass" && healthyCheck.ok,
		`verdict=${healthy.verdict} schemaOk=${healthyCheck.ok} checks=${healthy.checks?.map((c) => `${c.name}=${c.exit_code}`).join(",")}`,
	);

	const ctestLog = healthy.checks?.find((c) => c.name === "ctest")?.log_excerpt ?? "";
	const sawArch = /arch\.layers/.test(ctestLog);
	const sawSpec = /spec\.structure/.test(ctestLog);
	record(
		"#3 L0 ctest run includes arch.layers and spec.structure",
		sawArch && sawSpec,
		`arch.layers seen=${sawArch} spec.structure seen=${sawSpec}`,
	);

	// --- 2) inject a real compile error; L0 must fail and block L1/L2 ---
	fs.writeFileSync(SRC, `${original}\n#if 0\n#endif\nsyntax error here!;\n`, "utf-8");
	let blocked;
	try {
		blocked = await runReviewPipeline({
			cwd,
			run: realRunner,
			runChild: forbiddenChild,
			systemPrompt: () => "unused",
			constraintChecklist: "unused",
			diffCap: 1000,
		});
	} finally {
		fs.writeFileSync(SRC, original, "utf-8");
	}

	const restored = fs.readFileSync(SRC, "utf-8") === original;
	record("source file restored byte-for-byte after the fault injection", restored, `restored=${restored}`);

	record(
		"#3 real compile error → pipeline blocked at L0",
		blocked.outcome === "blocked" && blocked.blockingLayer === "L0",
		`outcome=${blocked.outcome} blockingLayer=${blocked.blockingLayer}`,
	);
	record(
		"#3 L1/L2 were never invoked (no LLM spent on broken code)",
		childCalls === 0,
		`child invocations=${childCalls}`,
	);
	record(
		"#2 build log reaches the coder-facing rejection text",
		/error|Error|编译|syntax/.test(blocked.rejectionText),
		blocked.rejectionText.split("\n").slice(0, 6).join("\n"),
	);

	// --- 3) after restore, L0 passes again (full regression) ---
	const after = await runL0Gate({ cwd, run: realRunner });
	record(
		"#10 after restore, L0 passes again (regression clean)",
		after.verdict === "pass",
		`verdict=${after.verdict} checks=${after.checks?.map((c) => `${c.name}=${c.exit_code}`).join(",")}`,
	);

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
	fs.writeFileSync(SRC, original, "utf-8");
	console.error("harness error:", e);
	process.exit(1);
});
