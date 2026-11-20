// Command-layer helpers for `/orch …`.
//
// Pure functions only: no Pi imports, no I/O. The extension entry (index.ts)
// does the side effects; everything that can be *decided* wrongly lives here so
// it is covered by `commands.test.ts` without spawning a child process.
//
// Invariants:
//   - a human decision is only accepted in a state that actually waits for one
//     (otherwise `/orch approve` would be a backdoor around the machine)
//   - the next state comes from the transition table, never from a hard-coded
//     "approve means CODE_LOOP" guess (that was wrong for SPEC_HUMAN/PLAN_HUMAN)
//   - resume adopts the NEWEST interrupted run unless the operator names one

import type { ArtifactStore, Stage } from "./store.ts";
import type { HumanDecision } from "./human.ts";
import {
	applyEvent, awaitsHuman, restoreSnapshot,
	type MachineEvent, type MachineSnapshot,
} from "./machine.ts";

export interface DecisionPlan {
	event: MachineEvent;
	next: MachineSnapshot;
	/** Metadata written next to the decision. */
	outcome: "pass" | "blocked" | "aborted";
}

/**
 * Map a human decision to the machine event for the CURRENT state.
 *
 * ESCALATED has no ordinary gate edges: a human ruling there means "resume the
 * stage that escalated" (approve/changes) or "stop" (reject). Guessing anything
 * else would either drop the event or advance past a gate that never ran.
 */
export function planDecision(
	snapshot: MachineSnapshot,
	decision: HumanDecision,
	now = new Date(),
): { ok: true; plan: DecisionPlan } | { ok: false; error: string } {
	let event: MachineEvent;
	if (snapshot.state === "ESCALATED") {
		if (decision === "reject") {
			event = "human-abort";
		} else {
			const resume: Record<Stage, MachineEvent> = {
				discussion: "human-resume-discussion",
				spec: "human-resume-spec",
				plan: "human-resume-plan",
				task: "human-resume-task",
				code: "human-resume-code",
			};
			event = resume[snapshot.stage];
		}
	} else if (awaitsHuman(snapshot.state)) {
		event = decision === "approve" ? "human-approve"
			: decision === "request_changes" ? "human-changes" : "human-reject";
	} else {
		return {
			ok: false,
			error: `当前状态 ${snapshot.state} 不等待人工决定；只有 SPEC_HUMAN / PLAN_HUMAN / AWAITING_HUMAN_REVIEW / ESCALATED 接受 approve/changes/reject`,
		};
	}

	const applied = applyEvent(snapshot, event, { now });
	if (!applied.ok) return { ok: false, error: applied.error ?? `非法转移：${snapshot.state} + ${event}` };
	return {
		ok: true,
		plan: {
			event,
			next: applied.snapshot,
			// Leaving ESCALATED means "resume work", not "gate approved".
			outcome: snapshot.state === "ESCALATED"
				? (decision === "reject" ? "aborted" : "blocked")
				: decision === "approve" ? "pass" : decision === "request_changes" ? "blocked" : "aborted",
		},
	};
}

/** Restore the machine from state.json, reporting corruption instead of resetting. */
export function loadMachine(store: ArtifactStore): { ok: true; snapshot?: MachineSnapshot } | { ok: false; error: string } {
	// `readJson` returns undefined for BOTH "missing" and "unparseable", so the
	// existence check must come first; otherwise a truncated state.json would be
	// silently replaced by a fresh DISCUSSION snapshot.
	if (!store.exists(store.statePath())) return { ok: true, snapshot: undefined };
	const raw = store.loadState<unknown>();
	if (raw === undefined) return { ok: false, error: "state.json 存在但无法解析（可能写入中断）" };
	const restored = restoreSnapshot(raw);
	if (!restored.ok || !restored.snapshot) {
		return { ok: false, error: `state.json 无法恢复：${restored.error ?? "未知错误"}` };
	}
	return { ok: true, snapshot: restored.snapshot };
}

/**
 * Pick the run `/orch resume` should adopt.
 * Runs are timestamp-prefixed, so `listRuns` already returns newest first.
 */
export function selectResumeRun(
	runs: string[],
	requested?: string,
): { ok: true; runId: string } | { ok: false; error: string } {
	const named = requested?.trim();
	if (named) {
		// Run directories are safeId()-normalised (lowercase), so accept the id as
		// displayed in /orch status.
		const found = runs.find((r) => r.toLowerCase() === named.toLowerCase());
		if (!found) {
			return { ok: false, error: `找不到运行记录 "${named}"。现有：${runs.length ? runs.join(", ") : "无"}` };
		}
		return { ok: true, runId: found };
	}
	if (runs.length === 0) return { ok: false, error: "没有可恢复的运行记录（未找到 state.json）。" };
	return { ok: true, runId: runs[0] };
}

/** Human-readable next step; keeps the command from stranding the operator. */
export function nextStepHint(state: MachineSnapshot["state"]): string {
	switch (state) {
		case "DISCUSSION": return "/orch start discussion（讨论产出 DECISIONS.md）";
		case "SPEC_DRAFT": case "SPEC_L0": case "SPEC_L1": case "SPEC_L2":
			return "/orch start spec [规格路径]";
		case "SPEC_HUMAN": return "/orch approve | /orch changes <说明> | /orch reject";
		case "PLAN_DRAFT": case "PLAN_L0": case "PLAN_L1":
			return "/orch start plan [计划路径]";
		case "PLAN_HUMAN": return "/orch approve | /orch changes <说明> | /orch reject";
		case "TASK_LOOP": return "/orch start task [TASK.md 路径]";
		case "CODE_LOOP": return "/review（L0 → L1 → 风险触发 L2 面板 → L3）";
		case "AWAITING_HUMAN_REVIEW": return "/orch approve | /orch changes <说明> | /orch reject";
		case "COMMITTED": return "下一个 checkpoint 用 /orch start task；全部完成则人工收尾";
		case "ESCALATED": return "/orch approve 恢复原阶段 | /orch reject 终止";
		case "DONE": return "运行已结束（DONE）";
		case "ABORTED": return "运行已终止（ABORTED）；用 /orch start 开新 run";
		default: return "/orch status";
	}
}
