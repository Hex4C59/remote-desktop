// Deterministic delivery state machine (blueprint figure 2).
//
// The orchestrator advances by an EXPLICIT transition table, never by asking a
// model "what next". Every transition is a pure function of (state, event), so
// the whole flow is unit-testable and a crashed run resumes from state.json.
//
// Invariants enforced here:
//   - a stage cannot advance past its human gate without an approve event
//   - L0 red always returns to the producer, never forward
//   - ESCALATED only leaves via a human ruling; ABORTED/DONE are terminal
//   - an unknown (state,event) pair is REJECTED, not silently ignored

import type { Stage } from "./store.ts";

export type MachineState =
	| "DISCUSSION"
	| "SPEC_DRAFT" | "SPEC_L0" | "SPEC_L1" | "SPEC_L2" | "SPEC_HUMAN"
	| "PLAN_DRAFT" | "PLAN_L0" | "PLAN_L1" | "PLAN_HUMAN"
	| "TASK_LOOP" | "CODE_LOOP" | "AWAITING_HUMAN_REVIEW" | "COMMITTED"
	| "ESCALATED" | "DONE" | "ABORTED";

export type MachineEvent =
	| "start"
	| "decided"            // discussion produced DECISIONS.md
	| "draft-ready"        // producer emitted a spec/plan/task draft
	| "l0-pass" | "l0-red"
	| "l1-pass" | "l1-blocker"
	| "l2-pass" | "l2-fail" | "l2-skipped"
	| "human-approve" | "human-changes" | "human-reject"
	| "task-ready"
	| "code-pass" | "code-blocked" | "code-await-human"
	| "committed"
	| "next-checkpoint" | "all-checkpoints-done"
	| "escalate"
	| "abort"              // /orch abort: operator stops the run from any working state
	| "human-resume-discussion" | "human-resume-spec" | "human-resume-plan"
	| "human-resume-task" | "human-resume-code"
	| "human-abort";

export const TERMINAL_STATES: MachineState[] = ["DONE", "ABORTED"];

export interface Transition {
	from: MachineState;
	event: MachineEvent;
	to: MachineState;
	/** Why this edge exists; surfaces in the audit trail. */
	note: string;
}

/**
 * The full blueprint table. Order matters only for readability; lookup is exact.
 */
export const TRANSITIONS: Transition[] = [
	// ---- discussion ----
	{ from: "DISCUSSION", event: "start", to: "DISCUSSION", note: "idempotent start" },
	{ from: "DISCUSSION", event: "decided", to: "SPEC_DRAFT", note: "方案选定，写 DECISIONS.md" },

	// ---- spec ----
	{ from: "SPEC_DRAFT", event: "draft-ready", to: "SPEC_L0", note: "规格草稿进入结构门禁" },
	{ from: "SPEC_L0", event: "l0-red", to: "SPEC_DRAFT", note: "结构红：回草稿，不进 L1" },
	{ from: "SPEC_L0", event: "l0-pass", to: "SPEC_L1", note: "结构绿：进语义审查" },
	{ from: "SPEC_L1", event: "l1-blocker", to: "SPEC_DRAFT", note: "语义 blocker：回草稿" },
	{ from: "SPEC_L1", event: "l1-pass", to: "SPEC_L2", note: "通过/仅建议：进跨 vendor 面板" },
	{ from: "SPEC_L2", event: "l2-fail", to: "SPEC_DRAFT", note: "面板 FAIL/BLOCKED：回草稿或升级" },
	{ from: "SPEC_L2", event: "l2-pass", to: "SPEC_HUMAN", note: "面板 PASS：交人批准" },
	{ from: "SPEC_L2", event: "l2-skipped", to: "SPEC_HUMAN", note: "未触发面板：仍须人批准" },
	{ from: "SPEC_HUMAN", event: "human-changes", to: "SPEC_DRAFT", note: "request_changes" },
	{ from: "SPEC_HUMAN", event: "human-reject", to: "ABORTED", note: "reject 终止" },
	{ from: "SPEC_HUMAN", event: "human-approve", to: "PLAN_DRAFT", note: "approve 后才可规划" },

	// ---- plan ----
	{ from: "PLAN_DRAFT", event: "draft-ready", to: "PLAN_L0", note: "计划进入覆盖率门禁" },
	{ from: "PLAN_L0", event: "l0-red", to: "PLAN_DRAFT", note: "覆盖率红：回草稿" },
	{ from: "PLAN_L0", event: "l0-pass", to: "PLAN_L1", note: "覆盖率绿：进语义审查" },
	{ from: "PLAN_L1", event: "l1-blocker", to: "PLAN_DRAFT", note: "语义 blocker：回草稿" },
	{ from: "PLAN_L1", event: "l1-pass", to: "PLAN_HUMAN", note: "通过：交人批准" },
	{ from: "PLAN_HUMAN", event: "human-changes", to: "PLAN_DRAFT", note: "request_changes" },
	{ from: "PLAN_HUMAN", event: "human-reject", to: "ABORTED", note: "reject 终止" },
	{ from: "PLAN_HUMAN", event: "human-approve", to: "TASK_LOOP", note: "approve 后才可拆任务" },

	// ---- task / code ----
	{ from: "TASK_LOOP", event: "task-ready", to: "CODE_LOOP", note: "TASK.md 就绪" },
	{ from: "TASK_LOOP", event: "l0-red", to: "TASK_LOOP", note: "TASK 结构红：重写任务" },
	// TASK_LOOP validates TASK.md in place (no draft/L0/L1 sub-states), so a
	// semantic rejection must be a legal self-loop or the retry would be dropped.
	{ from: "TASK_LOOP", event: "l1-blocker", to: "TASK_LOOP", note: "任务语义打回：重写 TASK.md" },
	{ from: "CODE_LOOP", event: "code-blocked", to: "CODE_LOOP", note: "L0/L1/L2 打回 coder" },
	{ from: "CODE_LOOP", event: "code-await-human", to: "AWAITING_HUMAN_REVIEW", note: "中高风险交人" },
	{ from: "CODE_LOOP", event: "code-pass", to: "COMMITTED", note: "低风险门禁通过（是否真提交由 commit 守卫决定）" },
	{ from: "AWAITING_HUMAN_REVIEW", event: "human-changes", to: "CODE_LOOP", note: "request_changes 回 coder" },
	{ from: "AWAITING_HUMAN_REVIEW", event: "human-reject", to: "ABORTED", note: "reject 终止" },
	{ from: "AWAITING_HUMAN_REVIEW", event: "human-approve", to: "COMMITTED", note: "approve 前进" },
	{ from: "COMMITTED", event: "committed", to: "COMMITTED", note: "记录提交结果（幂等）" },
	{ from: "COMMITTED", event: "next-checkpoint", to: "TASK_LOOP", note: "下一 checkpoint" },
	{ from: "COMMITTED", event: "all-checkpoints-done", to: "DONE", note: "全部完成" },

	// ---- escalation: any working state may escalate ----
	{ from: "ESCALATED", event: "human-resume-discussion", to: "DISCUSSION", note: "人裁决：回讨论" },
	{ from: "ESCALATED", event: "human-resume-spec", to: "SPEC_DRAFT", note: "人裁决：回规格" },
	{ from: "ESCALATED", event: "human-resume-plan", to: "PLAN_DRAFT", note: "人裁决：回计划" },
	{ from: "ESCALATED", event: "human-resume-task", to: "TASK_LOOP", note: "人裁决：回任务" },
	{ from: "ESCALATED", event: "human-resume-code", to: "CODE_LOOP", note: "人裁决：回编码" },
	{ from: "ESCALATED", event: "human-abort", to: "ABORTED", note: "人终止" },
];

/** States that may raise an escalation (everything except terminals/ESCALATED). */
const ESCALATABLE: MachineState[] = [
	"DISCUSSION", "SPEC_DRAFT", "SPEC_L0", "SPEC_L1", "SPEC_L2", "SPEC_HUMAN",
	"PLAN_DRAFT", "PLAN_L0", "PLAN_L1", "PLAN_HUMAN",
	"TASK_LOOP", "CODE_LOOP", "AWAITING_HUMAN_REVIEW", "COMMITTED",
];

const INDEX = new Map<string, Transition>();
for (const t of TRANSITIONS) INDEX.set(`${t.from}|${t.event}`, t);
for (const s of ESCALATABLE) {
	INDEX.set(`${s}|escalate`, { from: s, event: "escalate", to: "ESCALATED", note: "异常升级：交人裁决" });
	// `/orch abort` is an operator action, not a gate result. It must work from
	// every non-terminal state — otherwise a run parked at L3 or stuck in a
	// retry loop could not be stopped without killing the process.
	INDEX.set(`${s}|abort`, { from: s, event: "abort", to: "ABORTED", note: "人工终止本次运行" });
}
// ESCALATED is already parked at the human, but `/orch abort` must still stop it
// without forcing a resume first.
INDEX.set("ESCALATED|abort", { from: "ESCALATED", event: "abort", to: "ABORTED", note: "人工终止本次运行" });

export interface MachineSnapshot {
	state: MachineState;
	/** Which deliverable stage we are in, for artifact placement. */
	stage: Stage;
	checkpointId?: string;
	/** Completed checkpoint ids, in order. */
	completed: string[];
	/** Remaining checkpoint ids from the plan. */
	pending: string[];
	round: number;
	attempt: number;
	l0ConsecutiveFailures: number;
	updatedAt: string;
	history: Array<{ from: MachineState; event: MachineEvent; to: MachineState; at: string; note: string }>;
}

export function initialSnapshot(now = new Date()): MachineSnapshot {
	return {
		state: "DISCUSSION", stage: "discussion", completed: [], pending: [],
		round: 0, attempt: 0, l0ConsecutiveFailures: 0,
		updatedAt: now.toISOString(), history: [],
	};
}

/**
 * Snapshot that starts EXPLICITLY at a deliverable stage.
 *
 * Used only by `/orch start <stage>`, i.e. after a human said "begin at this
 * stage". It is not a transition and must never be used to skip a gate
 * automatically: history records the override so the audit trail shows that the
 * earlier human gates were not run in this run.
 */
export function snapshotAtStage(stage: Exclude<Stage, "code">, now = new Date()): MachineSnapshot {
	const state: MachineState =
		stage === "discussion" ? "DISCUSSION"
			: stage === "spec" ? "SPEC_DRAFT"
				: stage === "plan" ? "PLAN_DRAFT" : "TASK_LOOP";
	return {
		...initialSnapshot(now),
		state,
		stage,
		history: [{
			from: state, event: "start", to: state, at: now.toISOString(),
			note: `人工指定从 ${stage} 阶段开始（未经过本 run 的前置人工门禁）`,
		}],
	};
}

/** Which artifact stage a state belongs to. */
export function stageOf(state: MachineState): Stage {
	if (state.startsWith("SPEC")) return "spec";
	if (state.startsWith("PLAN")) return "plan";
	if (state === "TASK_LOOP") return "task";
	if (state === "DISCUSSION") return "discussion";
	return "code";
}

export function isTerminal(state: MachineState): boolean {
	return TERMINAL_STATES.includes(state);
}

export interface ApplyResult {
	ok: boolean;
	snapshot: MachineSnapshot;
	transition?: Transition;
	error?: string;
}

/**
 * Apply one event. Pure: returns a NEW snapshot, never mutates the input.
 * An illegal transition is rejected with a reason, leaving state untouched.
 */
export function applyEvent(
	snapshot: MachineSnapshot,
	event: MachineEvent,
	options: { now?: Date; checkpointId?: string; pending?: string[] } = {},
): ApplyResult {
	const now = (options.now ?? new Date()).toISOString();
	if (isTerminal(snapshot.state)) {
		return { ok: false, snapshot, error: `${snapshot.state} 是终态，不接受事件 ${event}` };
	}
	const t = INDEX.get(`${snapshot.state}|${event}`);
	if (!t) {
		return { ok: false, snapshot, error: `非法转移：${snapshot.state} + ${event}` };
	}

	const next: MachineSnapshot = {
		...snapshot,
		state: t.to,
		// Escalation/abort are exits, not stage changes: keeping the original stage
		// is what lets a human ruling resume the stage that actually escalated.
		stage: event === "escalate" || event === "abort" || event === "human-abort"
			? snapshot.stage
			: stageOf(t.to),
		completed: [...snapshot.completed],
		pending: options.pending ? [...options.pending] : [...snapshot.pending],
		history: [...snapshot.history, { from: t.from, event, to: t.to, at: now, note: t.note }],
		updatedAt: now,
	};

	// Counters are part of the machine, not of a caller's memory.
	if (event === "l0-red") next.l0ConsecutiveFailures = snapshot.l0ConsecutiveFailures + 1;
	if (event === "l0-pass") next.l0ConsecutiveFailures = 0;
	if (event === "code-blocked" || event === "human-changes" || event === "l1-blocker") {
		next.attempt = snapshot.attempt + 1;
	}
	if (event === "code-pass" || event === "human-approve") next.attempt = 0;
	if (event === "task-ready") {
		next.round = snapshot.round + 1;
		next.attempt = 0;
		next.l0ConsecutiveFailures = 0;
	}
	if (options.checkpointId) next.checkpointId = options.checkpointId;

	if (event === "next-checkpoint") {
		if (snapshot.checkpointId) next.completed.push(snapshot.checkpointId);
		const [head, ...rest] = next.pending;
		next.pending = rest;
		next.checkpointId = head;
	}
	if (event === "all-checkpoints-done") {
		if (snapshot.checkpointId && !next.completed.includes(snapshot.checkpointId)) {
			next.completed.push(snapshot.checkpointId);
		}
		next.pending = [];
	}

	return { ok: true, snapshot: next, transition: t };
}

/** Events legal from a state, for UI hints and tests. */
export function legalEvents(state: MachineState): MachineEvent[] {
	if (isTerminal(state)) return [];
	const out: MachineEvent[] = [];
	for (const key of INDEX.keys()) {
		const [from, event] = key.split("|");
		if (from === state) out.push(event as MachineEvent);
	}
	return out.sort();
}

/**
 * Restore a snapshot from disk.
 *
 * Unknown or corrupt state is NOT silently reset to DISCUSSION: that would
 * re-run gates a human already approved. It is reported so the caller can ask.
 */
export function restoreSnapshot(raw: unknown): { ok: boolean; snapshot?: MachineSnapshot; error?: string } {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: "state.json 不是对象" };
	const r = raw as Record<string, unknown>;
	const state = r["state"];
	const known: MachineState[] = [
		...TRANSITIONS.map((t) => t.from), ...TRANSITIONS.map((t) => t.to), "ESCALATED",
	];
	if (typeof state !== "string" || !known.includes(state as MachineState)) {
		return { ok: false, error: `state.json 的 state 未知：${JSON.stringify(state)}` };
	}
	const base = initialSnapshot();
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
	const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	const stages: Stage[] = ["discussion", "spec", "plan", "task", "code"];
	const rawStage = r["stage"];
	return {
		ok: true,
		snapshot: {
			state: state as MachineState,
			// ESCALATED/ABORTED do not encode a stage, so restore must take the saved
			// one; recomputing from the state would turn every escalated spec into a
			// code-stage run and resume to the wrong producer.
			stage: typeof rawStage === "string" && (stages as string[]).includes(rawStage)
				? rawStage as Stage
				: stageOf(state as MachineState),
			checkpointId: typeof r["checkpointId"] === "string" ? r["checkpointId"] : undefined,
			completed: strs(r["completed"]),
			pending: strs(r["pending"]),
			round: num(r["round"], base.round),
			attempt: num(r["attempt"], base.attempt),
			l0ConsecutiveFailures: num(r["l0ConsecutiveFailures"], base.l0ConsecutiveFailures),
			updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : base.updatedAt,
			history: Array.isArray(r["history"]) ? (r["history"] as MachineSnapshot["history"]) : [],
		},
	};
}

/** True when the machine is parked waiting for a human and must not advance. */
export function awaitsHuman(state: MachineState): boolean {
	return state === "SPEC_HUMAN" || state === "PLAN_HUMAN" || state === "AWAITING_HUMAN_REVIEW" || state === "ESCALATED";
}
