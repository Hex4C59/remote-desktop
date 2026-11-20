// L3 human gate.
//
// Two hard rules:
//   1. NO decision → NO progress. The machine must stop at AWAITING_HUMAN_REVIEW
//      and stay there. "The human did not answer" is never an approval.
//   2. An approval binds to the EXACT package hash. If the diff or any verdict
//      changed after the package was built, the old approval is stale and must
//      not be applied — otherwise a human could approve code they never saw.
//
// print/json mode has no interactive UI (ctx.hasUI === false). There we write the
// package and wait for `/orch approve|changes|reject` instead of guessing.

import type { ArtifactStore } from "./store.ts";

export type HumanDecision = "approve" | "request_changes" | "reject";

export const HUMAN_DECISIONS: HumanDecision[] = ["approve", "request_changes", "reject"];

export interface HumanDecisionRecord {
	decision: HumanDecision;
	decidedBy: string;
	decidedAt: string;
	runId: string;
	checkpointId: string;
	stage: string;
	/** sha256 of the review package manifest this decision applies to. */
	packageHash: string;
	note?: string;
	/** How the decision was obtained: interactive UI or an explicit command. */
	via: "ui" | "command";
}

/** Minimal UI surface, injected so this module is testable without Pi. */
export interface HumanGateUi {
	hasUI: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string) => Promise<string | undefined>;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

export interface HumanGateResult {
	status: "decided" | "awaiting";
	record?: HumanDecisionRecord;
	/** Why we are still waiting (shown to the user). */
	reason?: string;
}

export interface HumanGateArgs {
	ui: HumanGateUi;
	store: ArtifactStore;
	runId: string;
	checkpointId: string;
	stage: string;
	packageHash: string;
	packageDir: string;
	decidedBy?: string;
}

function decisionFile(checkpointId: string): string {
	return `checkpoints/${checkpointId}/human-decision.json`;
}

/** Persist a decision. Refuses to overwrite an existing one silently. */
export function recordDecision(
	store: ArtifactStore,
	record: HumanDecisionRecord,
): { ok: boolean; error?: string; file?: string } {
	if (!HUMAN_DECISIONS.includes(record.decision)) {
		return { ok: false, error: `unknown decision: ${record.decision}` };
	}
	if (!record.packageHash || !/^[0-9a-f]{64}$/.test(record.packageHash)) {
		return { ok: false, error: "decision must bind to a valid package hash" };
	}
	if (!record.decidedBy.trim()) {
		return { ok: false, error: "decision must record who decided" };
	}
	const rel = decisionFile(record.checkpointId);
	if (store.exists(rel)) {
		return { ok: false, error: `a decision already exists for ${record.checkpointId}; refusing to overwrite` };
	}
	const file = store.writeJson(rel, record);
	return { ok: true, file };
}

export function loadDecision(store: ArtifactStore, checkpointId: string): HumanDecisionRecord | undefined {
	return store.readJson<HumanDecisionRecord>(decisionFile(checkpointId));
}

/**
 * Is a recorded decision still applicable to the current package?
 * A changed package invalidates the approval — the human approved other bytes.
 */
export function isDecisionCurrent(
	record: HumanDecisionRecord | undefined,
	currentPackageHash: string,
): { ok: boolean; reason?: string } {
	if (!record) return { ok: false, reason: "no human decision recorded" };
	if (record.packageHash !== currentPackageHash) {
		return {
			ok: false,
			reason:
				`审查包已变化（批准时 ${record.packageHash.slice(0, 12)}，当前 ${currentPackageHash.slice(0, 12)}）；` +
				`旧批准失效，需重新审查`,
		};
	}
	return { ok: true };
}

/**
 * Ask the human. In interactive mode this blocks on a select; otherwise it
 * returns "awaiting" and the caller must keep the machine parked.
 */
export async function requestHumanDecision(args: HumanGateArgs): Promise<HumanGateResult> {
	const existing = loadDecision(args.store, args.checkpointId);
	if (existing) {
		const fresh = isDecisionCurrent(existing, args.packageHash);
		if (fresh.ok) return { status: "decided", record: existing };
		// Stale decision: do NOT apply it, and do not silently discard the record.
		return { status: "awaiting", reason: fresh.reason };
	}

	const hint = `审查包: ${args.packageDir}（sha256sum -c evidence.sha256 可复算）`;
	if (!args.ui.hasUI || !args.ui.select) {
		args.ui.notify?.(
			`需要 L3 人工批准。${hint}\n用 /orch approve | /orch changes <说明> | /orch reject 决定。`,
			"warning",
		);
		return {
			status: "awaiting",
			reason: "print/json 模式无交互 UI：已写审查包，等待 /orch approve|changes|reject",
		};
	}

	const title = `L3 人工审查 · ${args.stage} · ${args.checkpointId}`;
	const choice = await args.ui.select(
		`${title}\n${hint}\napprove=通过并前进 / request_changes=带证据打回 / reject=终止本次运行`,
		[...HUMAN_DECISIONS],
	);
	if (!choice || !HUMAN_DECISIONS.includes(choice as HumanDecision)) {
		// Cancelled / dismissed is NOT an approval.
		return { status: "awaiting", reason: "未做出选择（取消或关闭对话框）；状态机保持等待" };
	}

	let note: string | undefined;
	if (choice === "request_changes" && args.ui.input) {
		note = (await args.ui.input("打回说明（会连同证据发回生产侧）", "需要改什么"))?.trim() || undefined;
	}

	const record: HumanDecisionRecord = {
		decision: choice as HumanDecision,
		decidedBy: args.decidedBy ?? "user",
		decidedAt: new Date().toISOString(),
		runId: args.runId,
		checkpointId: args.checkpointId,
		stage: args.stage,
		packageHash: args.packageHash,
		note,
		via: "ui",
	};
	const saved = recordDecision(args.store, record);
	if (!saved.ok) return { status: "awaiting", reason: saved.error };
	return { status: "decided", record };
}

/** Command path: `/orch approve|changes|reject` in any mode. */
export function decideByCommand(
	args: Omit<HumanGateArgs, "ui"> & { decision: HumanDecision; note?: string; currentPackageHash?: string },
): { ok: boolean; record?: HumanDecisionRecord; error?: string } {
	const hash = args.currentPackageHash ?? args.packageHash;
	const existing = loadDecision(args.store, args.checkpointId);
	if (existing) {
		const fresh = isDecisionCurrent(existing, hash);
		if (fresh.ok) return { ok: true, record: existing };
		return { ok: false, error: fresh.reason };
	}
	const record: HumanDecisionRecord = {
		decision: args.decision,
		decidedBy: args.decidedBy ?? "user",
		decidedAt: new Date().toISOString(),
		runId: args.runId,
		checkpointId: args.checkpointId,
		stage: args.stage,
		packageHash: hash,
		note: args.note?.trim() || undefined,
		via: "command",
	};
	const saved = recordDecision(args.store, record);
	if (!saved.ok) return { ok: false, error: saved.error };
	return { ok: true, record };
}

/** What the machine should do with a decision. Pure, so it is unit-testable. */
export type HumanRoute = "advance" | "back-to-producer" | "abort" | "wait";

export function routeDecision(
	record: HumanDecisionRecord | undefined,
	currentPackageHash: string,
): { route: HumanRoute; reason?: string } {
	if (!record) return { route: "wait", reason: "尚无人工决定" };
	const fresh = isDecisionCurrent(record, currentPackageHash);
	if (!fresh.ok) return { route: "wait", reason: fresh.reason };
	switch (record.decision) {
		case "approve": return { route: "advance" };
		case "request_changes": return { route: "back-to-producer" };
		case "reject": return { route: "abort" };
		default: return { route: "wait", reason: `unknown decision ${String(record.decision)}` };
	}
}
