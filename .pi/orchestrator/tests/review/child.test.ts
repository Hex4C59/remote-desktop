// 审查子进程参数和生命周期测试。独立入口回归仅检查构造结果。
// Run: node --experimental-strip-types .pi/orchestrator/tests/review/child.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	buildChildArgs, extractAssistantText, extractAssistantModel, extractAssistantOutcome, getPiInvocation, parseAgentMd,
	runReviewChild,
} from "../../src/review/child.ts";

let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const base = { systemPromptFile: "/tmp/sys.md", tools: ["read", "grep", "find", "ls"], userPrompt: "TASK" };

check("standalone verifier resolves Pi instead of spawning itself", () => {
	const root = mkdtempSync(join(tmpdir(), "review-invocation-"));
	const bin = join(
		root, "releases", "1.5.2", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
	);
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	const override = process.env.PI_REVIEW_PI_BIN;
	try {
		mkdirSync(dirname(bin), { recursive: true });
		writeFileSync(join(root, "current-version"), "1.5.2\n");
		writeFileSync(bin, "");
		process.env.PI_MANAGED_INSTALL_ROOT = root;
		delete process.env.PI_REVIEW_PI_BIN;
		assert.deepEqual(getPiInvocation(["--mode", "json"]), {
			command: process.execPath,
			args: [bin, "--mode", "json"],
		});
	} finally {
		if (installRoot === undefined) delete process.env.PI_MANAGED_INSTALL_ROOT;
		else process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
		if (override === undefined) delete process.env.PI_REVIEW_PI_BIN;
		else process.env.PI_REVIEW_PI_BIN = override;
		rmSync(root, { recursive: true, force: true });
	}
});

check("explicit overrides cannot restart the invoking verifier", () => {
	const override = process.env.PI_REVIEW_PI_BIN;
	try {
		process.env.PI_REVIEW_PI_BIN = process.argv[1];
		assert.throws(() => getPiInvocation([]), /cannot point to the current script/i);
	} finally {
		if (override === undefined) delete process.env.PI_REVIEW_PI_BIN;
		else process.env.PI_REVIEW_PI_BIN = override;
	}
});

check("pre-aborted reviews return before starting a child", async () => {
	const root = mkdtempSync(join(tmpdir(), "review-pre-abort-"));
	const script = join(root, "unused.cjs");
	const override = process.env.PI_REVIEW_PI_BIN;
	let startRequested = false;
	try {
		writeFileSync(script, "process.exitCode = 0;\n");
		process.env.PI_REVIEW_PI_BIN = script;
		const result = await runReviewChild({
			cwd: root, systemPrompt: "", userPrompt: "", tools: ["read"], timeoutMs: 1000,
			signal: AbortSignal.abort(), onLog: () => { startRequested = true; },
		});
		assert.equal(startRequested, false);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /aborted before start/i);
	} finally {
		if (override === undefined) delete process.env.PI_REVIEW_PI_BIN;
		else process.env.PI_REVIEW_PI_BIN = override;
		rmSync(root, { recursive: true, force: true });
	}
});

async function withChildFixture(source: string, test: (cwd: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "review runner fixtures "));
	const script = join(root, "helper child.cjs");
	const override = process.env.PI_REVIEW_PI_BIN;
	try {
		writeFileSync(script, source);
		process.env.PI_REVIEW_PI_BIN = script;
		await test(root);
	} finally {
		if (override === undefined) delete process.env.PI_REVIEW_PI_BIN;
		else process.env.PI_REVIEW_PI_BIN = override;
		rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 30 });
	}
}

check("streams JSONL with bounded diagnostic tails and preserves UTF-8 and the final verdict", async () => {
	await withChildFixture(`
		const { once } = require("node:events");
		(async () => {
			const line = JSON.stringify({ type: "tool_output", text: "X".repeat(65500) }) + "\\n";
			for (let i = 0; i < 128; i++) {
				if (!process.stdout.write(line)) await once(process.stdout, "drain");
			}
			process.stderr.write("Y".repeat(128 * 1024) + "stderr tail");
			const text = "review " + String.fromCodePoint(0x4e2d) + ' "quoted" \\u005c\\u005c';
			if (process.argv.at(-1) !== text) throw new Error("Incorrect prompt arguments");
			const message = { role: "assistant", provider: "fixture", model: "offline", stopReason: "stop",
				content: [{ type: "text", text }] };
			const encoded = Buffer.from(JSON.stringify({ type: "message_end", message }));
			const split = encoded.indexOf(Buffer.from(text[7])) + 1;
			process.stdout.write(encoded.subarray(0, split));
			setTimeout(() => process.stdout.write(encoded.subarray(split)), 20);
		})().catch((error) => { console.error(error); process.exitCode = 1; });
	`, async (cwd) => {
		const text = 'review \u4e2d "quoted" \\\\';
		const result = await runReviewChild({ cwd, tools: ["read"], systemPrompt: "", userPrompt: text });
		assert.equal(result.ok, true, result.error);
		assert.ok(Buffer.byteLength(result.rawStdout) <= 64 * 1024, "stdout tail exceeded its limit");
		assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024, "stderr tail exceeded its limit");
		assert.ok(result.stderr.endsWith("stderr tail"));
		assert.equal(result.assistantText, text);
		assert.equal(result.model, "fixture/offline");
		assert.equal(result.stopReason, "stop");
	});
});

check("rejects an oversized JSONL record rather than accepting an earlier verdict", async () => {
	await withChildFixture(`
		process.stdout.write(JSON.stringify({ type: "message_end", message: {
			role: "assistant", content: [{ type: "text", text: "early verdict" }],
		} }) + "\\n");
		process.stdout.write("X".repeat(3 * 1024 * 1024));
	`, async (cwd) => {
		const result = await runReviewChild({ cwd, tools: ["read"], systemPrompt: "", userPrompt: "" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /JSONL record exceeded/i);
		assert.ok(Buffer.byteLength(result.rawStdout) <= 64 * 1024);
	});
});

if (process.platform === "win32") {
	for (const mode of ["timeout", "abort", "complete"] as const) {
		check(`Windows ${mode} closes the job and reaps a detached descendant`, async () => {
			await withChildFixture(`
				const fs = require("node:fs");
				const { spawn } = require("node:child_process");
				const { join } = require("node:path");
				const { execPath, cwd } = process;
				const pidFile = join(cwd(), "detached.pid");
				const child = spawn(execPath, ["-e", "setTimeout(() => {}, 9000)"], {
					detached: true, stdio: "ignore", windowsHide: true,
				});
				child.unref();
				fs.writeFileSync(pidFile, String(child.pid));
				const verdict = { role: "assistant", content: [{ type: "text", text: "fixture" }] };
				if (process.argv.at(-1) === "complete") {
					console.log(JSON.stringify({ type: "message_end", message: verdict }));
				} else {
					setTimeout(() => {}, 10000);
				}
			`, async (cwd) => {
				const controller = new AbortController();
				const pidFile = join(cwd, "detached.pid");
				const timeoutMs = mode === "timeout" ? 3000 : 8000;
				const running = runReviewChild({
					cwd, tools: ["read"], systemPrompt: "", userPrompt: mode, timeoutMs, signal: controller.signal,
				});
				const ready = (async () => {
					while (!existsSync(pidFile)) await delay(20, undefined, { ref: false });
					return Number(readFileSync(pidFile, "utf8"));
				})();
				if (mode === "abort") void Promise.race([ready, running]).then(() => controller.abort());
				const result = await running;
				assert.ok(existsSync(pidFile), result.error ?? "fixture did not start");
				const pid = await ready;
				try {
					assert.equal(result.timeout, mode === "timeout");
					assert.equal(result.ok, mode === "complete");
					if (mode === "abort") assert.match(result.error ?? "", /aborted/i);
					assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
				} finally {
					try { process.kill(pid); } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			});
		});
	}
}

check("omitting model keeps the argument list unchanged (back-compat)", () => {
	const a = buildChildArgs(base);
	assert.ok(!a.includes("--model"), "no --model when not requested");
	assert.deepEqual(a, [
		"--mode", "json", "-p", "--no-session", "--no-mcp", "--approve",
		"--thinking", "low",
		"--tools", "read,grep,find,ls",
		"--append-system-prompt", "/tmp/sys.md",
		"TASK",
	]);
});

check("model override appends --model provider/id", () => {
	const a = buildChildArgs({ ...base, model: "opencode-go/claude-haiku-5-5" });
	const i = a.indexOf("--model");
	assert.ok(i >= 0);
	assert.equal(a[i + 1], "opencode-go/claude-haiku-5-5");
});

check("blank model is ignored rather than passing an empty flag", () => {
	for (const m of ["", "   ", undefined]) {
		assert.ok(!buildChildArgs({ ...base, model: m }).includes("--model"));
	}
});

check("model is trimmed", () => {
	const a = buildChildArgs({ ...base, model: "  deepseek/deepseek-v4-pro  " });
	assert.equal(a[a.indexOf("--model") + 1], "deepseek/deepseek-v4-pro");
});

check("isolation flags are always present", () => {
	const a = buildChildArgs({ ...base, model: "x/y" });
	for (const flag of ["--no-session", "--no-mcp", "--mode", "-p"]) {
		assert.ok(a.includes(flag), `${flag} missing`);
	}
});

check("read-only tool allowlist never includes write tools", () => {
	const a = buildChildArgs(base);
	const tools = a[a.indexOf("--tools") + 1];
	assert.equal(tools, "read,grep,find,ls");
	for (const w of ["write", "edit", "bash", "powershell"]) {
		assert.ok(!tools.split(",").includes(w), `${w} must not be granted`);
	}
});

check("the task is the final positional argument", () => {
	const a = buildChildArgs({ ...base, model: "x/y", userPrompt: "MY TASK TEXT" });
	assert.equal(a[a.length - 1], "MY TASK TEXT");
});

check("thinking defaults to low and can be overridden", () => {
	assert.equal(buildChildArgs(base)[buildChildArgs(base).indexOf("--thinking") + 1], "low");
	const a = buildChildArgs({ ...base, thinking: "off" });
	assert.equal(a[a.indexOf("--thinking") + 1], "off");
});

// ---- JSONL extraction ----
const jsonl = (msgs: any[]) => msgs.map((m) => JSON.stringify(m)).join("\n");

check("extractAssistantText returns the last assistant text", () => {
	const stream = jsonl([
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "noise" }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"verdict":"pass"}' }] } },
	]);
	assert.equal(extractAssistantText(stream), '{"verdict":"pass"}');
});

check("extractAssistantText tolerates junk lines", () => {
	const stream = `not json\n\n${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}`;
	assert.equal(extractAssistantText(stream), "ok");
	assert.equal(extractAssistantText("no messages at all"), "");
});

check("extractAssistantModel reports provider/id actually used", () => {
	const stream = jsonl([
		{ type: "message_end", message: { role: "assistant", provider: "opencode-go", model: "claude-haiku-5-5", content: [{ type: "text", text: "x" }] } },
	]);
	assert.equal(extractAssistantModel(stream), "opencode-go/claude-haiku-5-5");
});

check("extractAssistantModel falls back to bare id, and undefined when absent", () => {
	const bare = jsonl([{ type: "message_end", message: { role: "assistant", model: "gpt-6-luna", content: [] } }]);
	assert.equal(extractAssistantModel(bare), "gpt-6-luna");
	assert.equal(extractAssistantModel("nothing"), undefined);
});

check("extractAssistantModel takes the LAST assistant model (panel audit)", () => {
	const stream = jsonl([
		{ type: "message_end", message: { role: "assistant", provider: "a", model: "one", content: [] } },
		{ type: "message_end", message: { role: "assistant", provider: "b", model: "two", content: [] } },
	]);
	assert.equal(extractAssistantModel(stream), "b/two");
});

// ---- provider-reported failure (regression) ----
// pi can exit 0 while the model call failed (observed: opencode-go returned
// 403 "Model access is disabled"). Previously that surfaced as ok=false with
// error=undefined, so a panel member's failure reason was lost.
check("extractAssistantOutcome surfaces a provider error despite exit 0", () => {
	const stream = jsonl([{
		type: "message_end",
		message: {
			role: "assistant", provider: "opencode-go", model: "claude-haiku-5-5",
			content: [], stopReason: "error",
			errorMessage: '403 {"type":"error","error":{"type":"permission_error","message":"Model access is disabled."}}',
		},
	}]);
	const o = extractAssistantOutcome(stream);
	assert.equal(o.stopReason, "error");
	assert.ok(o.errorMessage?.includes("403"));
	assert.ok(o.errorMessage?.includes("Model access is disabled"));
	// Text is empty but the reason must NOT be lost.
	assert.equal(extractAssistantText(stream), "");
});

check("extractAssistantOutcome reports a normal stop without error", () => {
	const stream = jsonl([{
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
	}]);
	const o = extractAssistantOutcome(stream);
	assert.equal(o.stopReason, "stop");
	assert.equal(o.errorMessage, undefined);
});

check("extractAssistantOutcome takes the last assistant turn", () => {
	const stream = jsonl([
		{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "first failure" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } },
	]);
	const o = extractAssistantOutcome(stream);
	assert.equal(o.stopReason, "stop");
	// The earlier error text is retained for diagnosis, but stopReason is current.
	assert.equal(o.errorMessage, "first failure");
});

check("extractAssistantOutcome is undefined-safe on junk", () => {
	assert.deepEqual(extractAssistantOutcome("not json\n\n"), { stopReason: undefined, errorMessage: undefined });
});

// ---- agent markdown ----
check("parseAgentMd splits frontmatter from body", () => {
	const md = "---\nname: reviewer-l1\ntools: read, grep\nthinking: low\n---\n\nYou are the L1 reviewer.";
	const { body, fields } = parseAgentMd(md);
	assert.equal(fields["name"], "reviewer-l1");
	assert.equal(fields["thinking"], "low");
	assert.equal(body, "You are the L1 reviewer.");
});

check("parseAgentMd handles a file without frontmatter", () => {
	const { body, fields } = parseAgentMd("Just a prompt.");
	assert.equal(body, "Just a prompt.");
	assert.deepEqual(fields, {});
});

console.log("== child.ts tests ==");
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
