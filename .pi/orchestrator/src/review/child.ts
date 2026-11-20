// Synchronous Pi subprocess runner for L1/L2 review children.
//
// Design (deviation from plan, documented in README):
// The orchestrator does NOT use the `subagent` tool. Two reasons:
//   1. ExtensionCommandContext (command handlers) has no executeTool().
//   2. In TUI the subagent tool returns a run id asynchronously; the verdict
//      steers back later, so a /review command cannot get it synchronously to
//      validate and drive the retry loop.
// Instead we spawn `pi -p --mode json` directly. This is strictly stronger for
// the verification goals:
//   - --no-session: each child gets a FRESH context and can NEVER see the
//     parent/coder conversation → anti-crosstalk (verification #5, #6).
//   - --tools read,grep,find,ls: write/edit/bash are mechanically absent →
//     read-only enforced by construction (verification #7), no hook needed.
//   - synchronous result → in-process verdict validation + retry + bounded loop.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ChildOutput, OutputTail, summarizeAssistant } from "./child-output.ts";

export interface RunChildOptions {
	cwd: string;
	systemPrompt: string; // body of the agent .md (after frontmatter)
	userPrompt: string;   // the task text (diff + structured fields only)
	tools: string[];      // e.g. ["read","grep","find","ls"]
	thinking?: string;    // default "low"
	timeoutMs?: number;   // default 10 min
	/**
	 * Optional "provider/model-id" override. Required for the cross-vendor L2
	 * panel: each member must run on a different model family. Omitted → the
	 * child inherits the parent's model exactly as before.
	 */
	model?: string;
	signal?: AbortSignal;
	onLog?: (line: string) => void;
}

export interface RunChildResult {
	ok: boolean;
	assistantText: string; // last assistant text message
	/** Model the child actually reported using (from JSONL), for panel auditing. */
	model?: string;
	/**
	 * Provider-reported stop reason. "error" means the model call failed even
	 * though pi exited 0 — a panel member must be counted absent, not passed.
	 */
	stopReason?: string;
	/** Provider error text (e.g. 403 model access disabled), for escalation. */
	errorMessage?: string;
	rawStdout: string; // Diagnostic tail, not the full stream.
	stderr: string;    // Diagnostic tail, not the full stream.
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timeout: boolean;
	error?: string;
}

/** Extract the final assistant text from a pi --mode json JSONL stream. */
export function extractAssistantText(jsonl: string): string {
	return summarizeAssistant(jsonl).text;
}

/** Report the actual model, independent of the requested model. */
export function extractAssistantModel(jsonl: string): string | undefined {
	return summarizeAssistant(jsonl).model;
}

/** Detect provider failures even when Pi exits 0. */
export function extractAssistantOutcome(jsonl: string): { stopReason?: string; errorMessage?: string } {
	const { stopReason, errorMessage } = summarizeAssistant(jsonl);
	return { stopReason, errorMessage };
}

async function prepareLauncher(command: string, args: string[], dir: string, cwd: string) {
	if (process.platform !== "win32") return { command, args };
	const manifest = path.join(dir, "invocation.json");
	// Windows CRT argument escaping, including a trailing backslash inside quotes.
	const quote = (arg: string) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
	await fs.promises.writeFile(manifest, JSON.stringify({
		commandLine: [command, ...args].map(quote).join(" "), cwd,
	}), { encoding: "utf8", mode: 0o600 });
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	return {
		command: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		args: [
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
			"-File", fileURLToPath(new URL("./windows-review-job.ps1", import.meta.url)), "-Manifest", manifest,
		],
	};
}

/** 解析 Pi 的可执行入口。独立运行验证脚本时，当前脚本不是 Pi 的入口。 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const piEntry = /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js$/i;
	const override = process.env.PI_REVIEW_PI_BIN?.trim();
	if (override) {
		if (script && !piEntry.test(script) && fs.existsSync(script) && fs.existsSync(override)) {
			const current = fs.realpathSync(script);
			const candidate = fs.realpathSync(override);
			const sameFile = process.platform === "win32"
				? current.toLowerCase() === candidate.toLowerCase()
				: current === candidate;
			if (sameFile) throw new Error("PI_REVIEW_PI_BIN cannot point to the current script.");
		}
		if (/\.(?:js|mjs|cjs)$/i.test(override)) {
			return { command: process.execPath, args: [override, ...args] };
		}
		return { command: override, args };
	}
	if (script && piEntry.test(script) && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	if (/^pi(?:\.exe)?$/i.test(path.basename(process.execPath))) {
		return { command: process.execPath, args };
	}
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install");
	const versionFile = path.join(installRoot, "current-version");
	if (fs.existsSync(versionFile)) {
		const version = fs.readFileSync(versionFile, "utf8").trim();
		if (!/^[0-9][\w.+-]*$/.test(version)) throw new Error("Invalid managed Pi version.");
		const cli = path.resolve(
			installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle",
			"cli.js",
		);
		if (fs.existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
	}
	if (process.platform === "win32") {
		throw new Error("Pi CLI was not found. Set PI_REVIEW_PI_BIN to its JavaScript entry or native executable.");
	}
	return { command: "pi", args };
}

/**
 * Build the child's pi arguments. Pure so the "no model → unchanged behaviour"
 * guarantee is assertable without spawning anything.
 *
 * Read-only is enforced by construction: only the listed tools exist in the
 * child, and --no-session gives it a fresh context that cannot see the parent.
 */
export function buildChildArgs(opts: {
	systemPromptFile: string;
	tools: string[];
	thinking?: string;
	model?: string;
	userPrompt: string;
}): string[] {
	const args: string[] = [
		"--mode", "json", "-p", "--no-session", "--no-mcp", "--approve",
		"--thinking", opts.thinking ?? "low",
		"--tools", opts.tools.join(","),
		"--append-system-prompt", opts.systemPromptFile,
	];
	// Only add --model when explicitly requested, so the default path stays
	// byte-identical to the previously verified behaviour.
	if (opts.model?.trim()) args.push("--model", opts.model.trim());
	args.push(opts.userPrompt);
	return args;
}

function abortedBeforeStart(): RunChildResult {
	return {
		ok: false, assistantText: "", rawStdout: "", stderr: "",
		exitCode: null, signal: null, timeout: false, error: "Review child aborted before start.",
	};
}

export async function runReviewChild(opts: RunChildOptions): Promise<RunChildResult> {
	if (opts.signal?.aborted) return abortedBeforeStart();
	const thinking = opts.thinking ?? "low";
	const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
	const cwd = path.resolve(opts.cwd);
	const invocation = getPiInvocation([]);
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-review-"));
	return await run().finally(() => fs.promises.rm(tempDir, { recursive: true, force: true }));

	async function run(): Promise<RunChildResult> {
		const promptFile = path.join(tempDir, "system.md");
		await fs.promises.writeFile(promptFile, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
		const args = buildChildArgs({
			systemPromptFile: promptFile,
			tools: opts.tools,
			thinking,
			model: opts.model,
			userPrompt: opts.userPrompt,
		});
		const launcher = await prepareLauncher(invocation.command, [...invocation.args, ...args], tempDir, cwd);
		const stdout = new OutputTail();
		const stderr = new OutputTail();
		const output = new ChildOutput();
		let timedOut = false;

		return await new Promise<RunChildResult>((resolve) => {
			if (!opts.signal?.aborted) opts.onLog?.(`[child] spawn ${invocation.command} ${args.slice(0, 6).join(" ")} ...`);
			if (opts.signal?.aborted) {
				resolve(abortedBeforeStart());
				return;
			}
			const proc = spawn(launcher.command, launcher.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			// Both timers are tracked so every exit path can clear them. An untracked
			// SIGKILL fallback would keep the event loop alive for its full grace
			// period even after the child already exited on SIGTERM.
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let terminating = false;
			const terminate = () => {
				if (terminating) return;
				terminating = true;
				clearTimeout(killTimer);
				proc.kill("SIGTERM");
				if (process.platform !== "win32") {
					forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 4000);
				}
			};
			const killTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);

			const clearTimers = () => {
				clearTimeout(killTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};

			const onAbort = () => terminate();
			if (opts.signal?.aborted) {
				// An already-aborted signal never emits "abort" again; without this the
				// child would run to the full timeout (10 min by default).
				terminate();
			} else {
				opts.signal?.addEventListener("abort", onAbort, { once: true });
			}

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout.write(chunk);
				output.write(chunk);
				if (output.error) terminate();
			});
			proc.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));

			proc.on("error", (err) => {
				clearTimers();
				opts.signal?.removeEventListener("abort", onAbort);
				resolve({
					ok: false, assistantText: "", rawStdout: stdout.text(), stderr: stderr.text(),
					exitCode: null, signal: null, timeout: false, error: `spawn failed: ${err.message}`,
				});
			});

			proc.on("close", (code, sig) => {
				clearTimers();
				opts.signal?.removeEventListener("abort", onAbort);
				output.finish();
				const { text, model, stopReason, errorMessage } = output.summary;
				const modelFailed = stopReason === "error" || Boolean(errorMessage);
				const aborted = opts.signal?.aborted === true;
				const diagnostic = stderr.text();
				// Always explain a failure. "exit 0 but no text" is not a usable reason.
				let error: string | undefined;
				if (timedOut) error = `timed out after ${timeoutMs}ms`;
				else if (aborted) error = "Review child was aborted.";
				else if (output.error) error = output.error;
				else if (modelFailed) error = `model error (${stopReason ?? "error"}): ${errorMessage ?? "no provider message"}`;
				else if (code !== 0) error = `exit ${code}`;
				else if (!text.trim()) error = "child produced no assistant text";
				resolve({
					ok: error === undefined, assistantText: text, model, stopReason, errorMessage,
					rawStdout: stdout.text(), stderr: diagnostic,
					exitCode: code, signal: sig, timeout: timedOut, error,
				});
			});

		});
	}
}

/** Parse YAML-ish frontmatter from an agent .md and return { body, fields }. */
export function parseAgentMd(text: string): { body: string; fields: Record<string, string> } {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return { body: text, fields };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { body: text, fields };
	const fm = text.slice(3, end);
	for (const line of fm.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { body: text.slice(end + 4).trim(), fields };
}
