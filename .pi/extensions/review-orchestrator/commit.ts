// Low-risk auto-commit (blueprint: 低风险自动 commit + 异步抽检).
//
// This is the ONLY place the orchestrator writes to the user's repository, so it
// is guarded three ways:
//   1. explicit authorisation (config.autoCommit === true; default false)
//   2. a low risk grade with no forbidden-path hits (mayAutoCommit)
//   3. a recorded human decision when the stage required L3
//
// A spot-check record is always written, so an auto-committed checkpoint is still
// auditable afterwards. Nothing here runs unless every guard passes.

import type { CommandRunner } from "./l0.ts";
import { mayAutoCommit, type RiskAssessment } from "./risk.ts";
import type { ArtifactStore } from "./store.ts";

export interface AutoCommitInput {
	cwd: string;
	run: CommandRunner;
	store: ArtifactStore;
	checkpointId: string;
	assessment: RiskAssessment;
	enabled: boolean;
	/** Required when the stage ran L3: the approval that authorises this commit. */
	humanApproved?: boolean;
	/** Stage required L3 but no approval exists → refuse. */
	humanRequired?: boolean;
	message: string;
	/** Files to stage. Empty → refuse (never `git add -A` blindly). */
	files: string[];
}

export type AutoCommitOutcome = "committed" | "skipped" | "refused" | "failed";

export interface AutoCommitResult {
	outcome: AutoCommitOutcome;
	reason: string;
	commit?: string;
	/** Relative path of the spot-check record, when written. */
	spotCheckFile?: string;
}

/** Pure guard: may we commit at all? Exported so it is testable on its own. */
export function autoCommitGuard(input: {
	assessment: RiskAssessment;
	enabled: boolean;
	humanRequired?: boolean;
	humanApproved?: boolean;
	files: string[];
}): { ok: boolean; reason: string } {
	if (!input.enabled) {
		return { ok: false, reason: "autoCommit=false：未获显式授权，改动保留在工作区待人工提交" };
	}
	if (!mayAutoCommit(input.assessment, input.enabled)) {
		return { ok: false, reason: `风险等级 ${input.assessment.level}${input.assessment.forbiddenHits.length ? "（含禁止路径命中）" : ""}：不允许自动提交` };
	}
	if (input.humanRequired && !input.humanApproved) {
		return { ok: false, reason: "本阶段要求 L3 人工批准，但尚无批准记录" };
	}
	if (input.files.length === 0) {
		return { ok: false, reason: "没有明确的待提交文件清单：拒绝盲目 git add" };
	}
	const unsafe = input.files.filter((f) => f.startsWith("-") || f.includes("..") || f.startsWith("/"));
	if (unsafe.length > 0) {
		return { ok: false, reason: `待提交路径不安全：${unsafe.join(", ")}` };
	}
	return { ok: true, reason: "低风险且已授权" };
}

/**
 * Commit a low-risk checkpoint, or explain why not.
 * Never throws for a refused/skipped case: the caller routes on `outcome`.
 */
export async function autoCommitCheckpoint(input: AutoCommitInput): Promise<AutoCommitResult> {
	const guard = autoCommitGuard(input);
	if (!guard.ok) {
		// Record the decision either way: "we deliberately did not commit" is
		// itself evidence.
		const file = input.store.checkpointFile(input.checkpointId, "auto-commit.json");
		input.store.writeJson(file, {
			outcome: "refused",
			reason: guard.reason,
			risk: input.assessment.level,
			forbiddenHits: input.assessment.forbiddenHits,
			at: new Date().toISOString(),
		});
		return { outcome: "refused", reason: guard.reason, spotCheckFile: file };
	}

	const headBefore = await input.run("git", ["rev-parse", "HEAD"], { cwd: input.cwd, timeout: 30_000 });

	// Stage exactly the reviewed files.
	const add = await input.run("git", ["add", "--", ...input.files], { cwd: input.cwd, timeout: 60_000 });
	if ((add.exitCode ?? -1) !== 0) {
		return { outcome: "failed", reason: `git add 失败（exit ${add.exitCode}）：${(add.stderr || add.stdout).trim().slice(0, 300)}` };
	}

	const commit = await input.run("git", ["commit", "-m", input.message], { cwd: input.cwd, timeout: 60_000 });
	if ((commit.exitCode ?? -1) !== 0) {
		return { outcome: "failed", reason: `git commit 失败（exit ${commit.exitCode}）：${(commit.stderr || commit.stdout).trim().slice(0, 300)}` };
	}

	const headAfter = await input.run("git", ["rev-parse", "HEAD"], { cwd: input.cwd, timeout: 30_000 });
	const sha = headAfter.stdout.trim();
	if (!sha || sha === headBefore.stdout.trim()) {
		return { outcome: "failed", reason: "提交后 HEAD 未变化：视为未提交" };
	}

	// Async spot-check record: what was committed without a human reading it.
	const spotCheckFile = input.store.checkpointFile(input.checkpointId, "spot-check.json");
	input.store.writeJson(spotCheckFile, {
		commit: sha,
		checkpointId: input.checkpointId,
		risk: input.assessment.level,
		reasons: input.assessment.reasons,
		files: input.files,
		changedLines: input.assessment.changedLines,
		committedAt: new Date().toISOString(),
		status: "pending-async-review",
		note: "低风险自动提交：需异步抽检。抽检发现问题应回退该提交并升级为人工审查。",
	});
	input.store.writeJson(input.store.checkpointFile(input.checkpointId, "auto-commit.json"), {
		outcome: "committed",
		commit: sha,
		risk: input.assessment.level,
		at: new Date().toISOString(),
	});

	return { outcome: "committed", reason: guard.reason, commit: sha, spotCheckFile };
}
