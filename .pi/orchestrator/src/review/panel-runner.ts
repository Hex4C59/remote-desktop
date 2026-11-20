// L2 cross-vendor panel executor.
//
// Each member runs as its OWN `pi --no-session` subprocess on its OWN model, with
// read-only tools. Members cannot see the coder conversation, each other's
// output, or the parent session — independence is structural, not a prompt rule.
//
// A member that times out, hits a provider error (e.g. 403 model access disabled)
// or emits a malformed verdict is recorded ABSENT with its reason. It must never
// be counted as a pass, and it must not abort the rest of the batch.

import type { PanelMember } from "../workflow/config.ts";
import type { RunChildOptions, RunChildResult } from "./child.ts";
import { parseAndValidate } from "./verdict.ts";
import { aggregatePanel, type PanelAggregate, type PanelVote } from "./aggregate.ts";

/** Read-only by construction: write/edit/bash are absent in the child. */
const PANEL_TOOLS = ["read", "grep", "find", "ls"];

export interface PanelRunOptions {
	cwd: string;
	members: PanelMember[];
	/** Reviewer system prompt (architect-l2 body). */
	systemPrompt: string;
	/** Task text: diff + constraint checklist + upstream STRUCTURED verdicts only. */
	task: string;
	quorum: number;
	minDistinctFamilies: number;
	concurrency: number;
	timeoutMs: number;
	thinking: string;
	runChild: (opts: RunChildOptions) => Promise<RunChildResult>;
	signal?: AbortSignal;
	onLog?: (line: string) => void;
}

/** Per-member evidence for the artifact chain. */
export interface PanelMemberRecord {
	model: string;
	family: string;
	ok: boolean;
	/** Model the child actually reported using (may differ from the request). */
	reportedModel?: string;
	assistantText: string;
	error?: string;
	durationMs: number;
}

export interface PanelRunResult {
	votes: PanelVote[];
	records: PanelMemberRecord[];
	aggregate: PanelAggregate;
}

/** Run items with a concurrency cap, preserving input order in the output. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const cap = Math.max(1, Math.min(limit, items.length));
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: cap }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

export async function runPanel(opts: PanelRunOptions): Promise<PanelRunResult> {
	const records: PanelMemberRecord[] = [];

	const votes = await mapLimit(opts.members, opts.concurrency, async (member): Promise<PanelVote> => {
		const started = Date.now();
		opts.onLog?.(`[L2] panel member ${member.model} (${member.family}) starting`);
		let res: RunChildResult;
		try {
			res = await opts.runChild({
				cwd: opts.cwd,
				systemPrompt: opts.systemPrompt,
				userPrompt: opts.task,
				tools: PANEL_TOOLS,
				thinking: opts.thinking,
				timeoutMs: opts.timeoutMs,
				model: member.model,
				signal: opts.signal,
			});
		} catch (e) {
			// A thrown runner must not take down the batch.
			const reason = `runner threw: ${(e as Error).message}`;
			records.push({
				model: member.model, family: member.family, ok: false,
				assistantText: "", error: reason, durationMs: Date.now() - started,
			});
			opts.onLog?.(`[L2] ${member.model} absent — ${reason}`);
			return { model: member.model, family: member.family, valid: false, failureReason: reason };
		}

		const durationMs = Date.now() - started;
		if (!res.ok) {
			const reason = res.error ?? `child failed (exit ${res.exitCode})`;
			records.push({
				model: member.model, family: member.family, ok: false,
				reportedModel: res.model, assistantText: res.assistantText, error: reason, durationMs,
			});
			opts.onLog?.(`[L2] ${member.model} absent — ${reason}`);
			return { model: member.model, family: member.family, valid: false, failureReason: reason };
		}

		const validation = parseAndValidate(res.assistantText, "L2");
		if (!validation.ok || !validation.verdict) {
			const reason = `invalid verdict: ${validation.errors.join("; ")}`;
			records.push({
				model: member.model, family: member.family, ok: false,
				reportedModel: res.model, assistantText: res.assistantText, error: reason, durationMs,
			});
			opts.onLog?.(`[L2] ${member.model} absent — ${reason}`);
			return { model: member.model, family: member.family, valid: false, failureReason: reason };
		}

		records.push({
			model: member.model, family: member.family, ok: true,
			reportedModel: res.model, assistantText: res.assistantText, durationMs,
		});
		opts.onLog?.(`[L2] ${member.model} voted ${validation.verdict.verdict} (${durationMs}ms)`);
		return { model: member.model, family: member.family, valid: true, verdict: validation.verdict };
	});

	// Keep records in member order for a stable evidence file.
	const order = new Map(opts.members.map((m, i) => [m.model, i]));
	records.sort((a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0));

	const aggregate = aggregatePanel(votes, opts.quorum, { minDistinctFamilies: opts.minDistinctFamilies });
	opts.onLog?.(`[L2] panel ${aggregate.outcome} — ${aggregate.reasons.join("; ")}`);
	return { votes, records, aggregate };
}
