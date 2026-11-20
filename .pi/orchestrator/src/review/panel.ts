// L2 panel membership: resolve families and exclude the coder's own vendor.
//
// THE TRAP THIS MODULE EXISTS FOR: provider id ≠ vendor.
// `opencode-go` is a gateway hosting Claude (Anthropic), Gemini (Google), GLM
// (Zhipu), Grok (xAI), GPT (OpenAI) and DeepSeek. Excluding by provider id would
// wipe out the whole panel whenever the coder happens to use that gateway.
// Exclusion MUST be by model FAMILY.
//
// Pure module: no I/O, no Pi imports.

import type { OrchestratorConfig, PanelMember } from "../workflow/config.ts";

/**
 * Infer a model's family from its model id (never from the provider id).
 *
 * Order matters: more specific patterns first, so e.g. "deepseek-v4-pro" is not
 * mistaken for something else and "gpt-6-luna" maps to openai.
 */
const FAMILY_PATTERNS: Array<[RegExp, string]> = [
	[/claude|anthropic/i, "anthropic"],
	[/gemini|palm|bard/i, "google"],
	[/deepseek/i, "deepseek"],
	[/glm|chatglm|zhipu/i, "zhipu"],
	[/grok|xai/i, "xai"],
	[/qwen|qwq|tongyi/i, "qwen"],
	[/kimi|moonshot/i, "moonshot"],
	[/llama/i, "meta"],
	[/mistral|mixtral|codestral/i, "mistral"],
	[/gpt|codex|chatgpt|(^|[/:-])o[134]([-.]|$)/i, "openai"],
	[/ernie|wenxin/i, "baidu"],
	[/hunyuan/i, "tencent"],
	[/doubao|skylark/i, "bytedance"],
	[/minimax|abab/i, "minimax"],
	[/yi-|01-ai/i, "lingyiwanwu"],
	[/command|cohere/i, "cohere"],
	[/phi-/i, "microsoft"],
	[/nova|titan/i, "amazon"],
];

/** Split "provider/model-id" into its parts. Tolerates a bare model id. */
export function splitModel(model: string): { provider?: string; id: string } {
	const trimmed = model.trim();
	const slash = trimmed.indexOf("/");
	if (slash < 0) return { id: trimmed };
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/**
 * Family of a model, inferred from the model id only.
 * Returns "unknown:<id>" when nothing matches, so an unrecognised model is never
 * silently grouped with a known vendor (which could fake independence).
 */
export function inferFamily(model: string): string {
	const { id } = splitModel(model);
	for (const [re, family] of FAMILY_PATTERNS) {
		if (re.test(id)) return family;
	}
	return `unknown:${id.toLowerCase()}`;
}

export interface PanelResolution {
	ok: boolean;
	errors: string[];
	/** Members that will actually vote (coder's family removed). */
	members: PanelMember[];
	/** Members removed because they share the coder's family. */
	excluded: PanelMember[];
	coderModel?: string;
	coderFamily?: string;
	/** Distinct families among the surviving members. */
	families: string[];
}

/**
 * Resolve the voting panel for a given coder model.
 *
 * `familyOverrides` lets the caller supply authoritative families (e.g. from the
 * config, or a catalogue) instead of relying on inference.
 */
export function resolvePanel(
	config: OrchestratorConfig,
	coderModel?: string,
	familyOverrides?: Record<string, string>,
): PanelResolution {
	const errors: string[] = [];
	const familyOf = (m: PanelMember): string =>
		(familyOverrides?.[m.model] ?? m.family).trim().toLowerCase();

	const coderFamily = coderModel
		? (familyOverrides?.[coderModel] ?? inferFamily(coderModel)).trim().toLowerCase()
		: undefined;

	const all = config.panel.members.map((m) => ({ model: m.model, family: familyOf(m) }));
	const excluded = coderFamily ? all.filter((m) => m.family === coderFamily) : [];
	const members = coderFamily ? all.filter((m) => m.family !== coderFamily) : all;
	const families = [...new Set(members.map((m) => m.family))];

	if (coderModel && coderFamily?.startsWith("unknown:")) {
		// Do not fail the run, but make the uncertainty explicit: we could not
		// identify the coder's vendor, so independence cannot be guaranteed.
		errors.push(
			`cannot infer the coder's model family from "${coderModel}"; ` +
			`vendor independence is unverified — declare it explicitly to remove this warning`,
		);
	}

	if (members.length < config.panel.quorum) {
		errors.push(
			`after excluding the coder's family (${coderFamily ?? "none"}), ${members.length} member(s) remain ` +
			`but quorum is ${config.panel.quorum}; the panel would always be BLOCKED`,
		);
	}
	if (families.length < config.panel.minDistinctFamilies) {
		errors.push(
			`after exclusion only ${families.length} distinct family(ies) remain (${families.join(", ") || "none"}) ` +
			`but ${config.panel.minDistinctFamilies} are required for independent review`,
		);
	}

	// "unknown:*" families must not be counted as independent from each other.
	const unknownCount = families.filter((f) => f.startsWith("unknown:")).length;
	if (unknownCount > 1) {
		errors.push(`${unknownCount} members have unrecognised families; they cannot be treated as distinct vendors`);
	}

	return { ok: errors.length === 0, errors, members, excluded, coderModel, coderFamily, families };
}

/** True when two models belong to the same vendor, regardless of gateway. */
export function sameFamily(a: string, b: string, overrides?: Record<string, string>): boolean {
	const fa = (overrides?.[a] ?? inferFamily(a)).toLowerCase();
	const fb = (overrides?.[b] ?? inferFamily(b)).toLowerCase();
	return fa === fb;
}
