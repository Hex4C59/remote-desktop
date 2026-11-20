// L0 deterministic gate — zero LLM.
//
// Runs the project's build and test commands and turns their exit codes into an
// L0 verdict (verdict-schema.md §2 "L0 确定性门禁"). The command runner is
// injected so the logic is testable without a real toolchain, and so the Pi
// extension can back it with pi.exec().
//
// Division of labour (plan §6): arch.layers and spec.structure are ctest cases
// and therefore belong to L0. L1/L2 must not re-report what this gate already
// decides deterministically.

import type { Check, Finding, ParsedVerdict } from "./verdict.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	killed?: boolean;
	truncated?: boolean;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<CommandResult>;

export interface L0Options {
	cwd: string;
	run: CommandRunner;
	/** Defaults to ["debug"]. Both build and ctest presets must exist. */
	preset?: string;
	/** Extra ctest name filter; when set, only matching tests are required. */
	testFilter?: string;
	timeoutMs?: number;
	onLog?: (line: string) => void;
}

/**
 * Pick a preset that has BOTH a build and a test preset, so the gate never
 * hardcodes a project-specific version. Prefers debug, then any usable pair.
 */
export function detectPreset(cwd: string): string {
	try {
		const raw = fs.readFileSync(path.join(cwd, "CMakePresets.json"), "utf-8");
		const parsed = JSON.parse(raw) as {
			buildPresets?: { name?: string }[];
			testPresets?: { name?: string }[];
		};
		const builds = new Set((parsed.buildPresets ?? []).map((p) => p.name).filter(Boolean) as string[]);
		const tests = new Set((parsed.testPresets ?? []).map((p) => p.name).filter(Boolean) as string[]);
		for (const preferred of ["debug", "dev", "default"]) {
			if (builds.has(preferred) && tests.has(preferred)) return preferred;
		}
		for (const name of tests) {
			if (builds.has(name)) return name;
		}
	} catch {
		/* no presets file or unreadable: fall back to the project convention */
	}
	return "debug";
}

/** Keep log excerpts short enough for a verdict, keeping the informative tail. */
export function excerpt(text: string, maxLines = 25, maxChars = 2400): string {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	let out = lines.slice(-maxLines).join("\n");
	if (out.length > maxChars) out = out.slice(out.length - maxChars);
	return out;
}

/** Pull the failing test names out of ctest output, e.g. " 3 - arch.layers (Failed)". */
export function failedTests(ctestOutput: string): string[] {
	const names = new Set<string>();
	for (const line of ctestOutput.split("\n")) {
		const m = /^\s*\d+\s*-\s*([^\s(]+)\s+\(Failed\)/.exec(line);
		if (m) names.add(m[1]);
		const m2 = /\*\*\*Failed\s*:\s*(\S+)/.exec(line);
		if (m2) names.add(m2[1]);
	}
	return [...names];
}

function toCheck(name: string, r: CommandResult, log: string): Check {
	return {
		name,
		exit_code: r.exitCode ?? -1,
		...(log ? { log_excerpt: log } : {}),
	};
}

/**
 * Run build + ctest and build an L0 verdict.
 * L0 reports facts only: it never invents required_fix / failing_test.
 */
export async function runL0Gate(opts: L0Options): Promise<ParsedVerdict> {
	const preset = opts.preset ?? detectPreset(opts.cwd);
	const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
	const checks: Check[] = [];
	const findings: Finding[] = [];

	// 1) build
	opts.onLog?.(`[L0] cmake --build --preset ${preset} -j`);
	const build = await opts.run("cmake", ["--build", "--preset", preset, "-j"], {
		cwd: opts.cwd,
		timeout,
	});
	const buildLog = excerpt(`${build.stdout}\n${build.stderr}`);
	checks.push(toCheck("cmake_build", build, buildLog));
	if ((build.exitCode ?? -1) !== 0) {
		findings.push({
			// L0 findings carry a check category, not a source location.
			file: "build",
			evidence:
				`cmake --build --preset ${preset} exited ${build.exitCode ?? "null"}` +
				(build.killed ? " (killed/timeout)" : "") +
				(buildLog ? `\n${buildLog}` : ""),
		});
	}

	// 2) ctest — arch.layers / spec.structure live here, so this is where the
	//    deterministic architecture checks actually run.
	if (findings.length === 0) {
		const ctestArgs = ["--preset", preset, "--output-on-failure"];
		if (opts.testFilter) ctestArgs.push("-R", opts.testFilter);
		opts.onLog?.(`[L0] ctest ${ctestArgs.join(" ")}`);
		const test = await opts.run("ctest", ctestArgs, { cwd: opts.cwd, timeout });
		const testLog = excerpt(`${test.stdout}\n${test.stderr}`);
		checks.push(toCheck("ctest", test, testLog));
		if ((test.exitCode ?? -1) !== 0) {
			const failed = failedTests(`${test.stdout}\n${test.stderr}`);
			if (failed.length > 0) {
				for (const name of failed) {
					const isGate = name === "arch.layers" || name === "spec.structure";
					findings.push({
						file: isGate ? `ctest:${name}` : "ctest",
						evidence:
							`ctest ${name} failed (exit ${test.exitCode ?? "null"})` +
							(isGate ? " — deterministic architecture/spec constraint gate" : "") +
							(testLog ? `\n${testLog}` : ""),
					});
				}
			} else {
				findings.push({
					file: "ctest",
					evidence: `ctest exited ${test.exitCode ?? "null"}\n${testLog}`,
				});
			}
		}
	}

	const pass = checks.every((c) => c.exit_code === 0) && findings.length === 0;
	return {
		layer: "L0",
		verdict: pass ? "pass" : "fail",
		findings,
		summary: pass
			? `L0 通过：build 与 ctest（含 arch.layers / spec.structure）退出码均为 0。`
			: `L0 未通过：${findings.length} 项确定性检查失败（见 findings 的退出码与日志摘录）。`,
		checks,
		raw: { checks },
	};
}
