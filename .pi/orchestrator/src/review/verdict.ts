// Pure verdict parsing & validation per .pi/review/verdict-schema.md §3.
// No Pi imports, no I/O — runnable standalone with `node --experimental-strip-types`.

export type Layer = "L0" | "L1" | "L2";
export type Severity = "critical" | "warning" | "suggestion";
export type Verdict = "pass" | "fail";

export interface Finding {
	severity?: Severity;
	file: string;
	line?: number;
	evidence: string;
	required_fix?: string;
	failing_test?: string;
	uncertain?: boolean;
	[key: string]: unknown;
}

export interface ParsedVerdict {
	layer: Layer;
	verdict: Verdict;
	findings: Finding[];
	summary: string;
	checks?: Check[];
	raw: unknown;
}

export interface Check {
	name: string;
	exit_code: number;
	log_excerpt?: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	verdict?: ParsedVerdict;
}

const CONSTRAINT_ID_RE = /[A-Z]+-\d+/;
const SPEC_REF_RE = /spec-\S+:\S+/;
const SEVERITIES = new Set<Severity>(["critical", "warning", "suggestion"]);
const LAYERS = new Set<Layer>(["L0", "L1", "L2"]);
const VALID_VERDICTS = new Set<Verdict>(["pass", "fail"]);

/**
 * Extract the first complete top-level JSON object from `text`, tolerating
 * prose/markdown fences before or after it. Returns null if none parses.
 * Uses a brace-depth scan so nested braces/strings are handled correctly.
 */
export function extractJson(text: string): unknown | null {
	let start = -1;
	let depth = 0;
	let inStr = false;
	let strCh = "";
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === strCh) inStr = false;
			continue;
		}
		// JSON strings are double-quoted only. Treating ' as a delimiter made any
		// prose with an odd number of apostrophes (Reviewer's, don't, it's) swallow
		// the whole verdict, rejecting a valid review as "裁决不合规".
		if (ch === '"') {
			inStr = true;
			strCh = ch;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start >= 0) {
					const candidate = text.slice(start, i + 1);
					try {
						return JSON.parse(candidate);
					} catch {
						// Keep scanning; a later object may be valid.
						start = -1;
					}
				}
			}
		}
	}
	return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyStr(v: unknown): boolean {
	return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate a parsed object against verdict-schema.md §3.
 * `layer` is the layer the caller EXPECTED; mismatch is an error.
 */
export function validateVerdict(raw: unknown, expectedLayer: Layer): ValidationResult {
	const errors: string[] = [];
	if (!isObj(raw)) {
		return { ok: false, errors: ["output is not a JSON object"] };
	}

	const layer = raw["layer"];
	if (typeof layer !== "string" || !LAYERS.has(layer as Layer)) {
		errors.push(`"layer" must be one of L0/L1/L2, got ${JSON.stringify(layer)}`);
	} else if (layer !== expectedLayer) {
		errors.push(`"layer" is "${layer}" but expected "${expectedLayer}"`);
	}

	const verdict = raw["verdict"];
	if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict as Verdict)) {
		errors.push(`"verdict" must be "pass" or "fail", got ${JSON.stringify(verdict)}`);
	}

	const findings = raw["findings"];
	if (!Array.isArray(findings)) {
		errors.push('"findings" must be an array');
	}

	const summary = raw["summary"];
	if (!nonEmptyStr(summary)) {
		errors.push('"summary" must be a non-empty string');
	}

	// Layer-specific checks.
	const l = (typeof layer === "string" ? layer : "") as Layer;
	if (l === "L0") {
		const checks = raw["checks"];
		if (!Array.isArray(checks) || checks.length === 0) {
			errors.push('L0 must include a non-empty "checks" array');
		} else {
			for (let i = 0; i < checks.length; i++) {
				const c = checks[i];
				if (!isObj(c) || typeof c["name"] !== "string" || typeof c["exit_code"] !== "number") {
					errors.push(`L0 checks[${i}] must have string "name" and number "exit_code"`);
				}
			}
		}
	}

	if (Array.isArray(findings)) {
		findings.forEach((f, i) => {
			if (!isObj(f)) {
				errors.push(`findings[${i}] is not an object`);
				return;
			}
			if (!nonEmptyStr(f["file"])) errors.push(`findings[${i}] missing non-empty "file"`);
			if (!nonEmptyStr(f["evidence"])) errors.push(`findings[${i}] missing non-empty "evidence"`);

			// verdict-schema.md §3 rule 5: only L1/L2 findings must carry an
			// actionable fix or a failing test. L0 reports facts only (§2), so it
			// must NOT invent one.
			if (l === "L1" || l === "L2") {
				const hasFix = nonEmptyStr(f["required_fix"]) || nonEmptyStr(f["failing_test"]);
				if (!hasFix) errors.push(`findings[${i}] needs "required_fix" or "failing_test"`);
			}

			if (l === "L1") {
				const line = f["line"];
				if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) {
					errors.push(`findings[${i}] (L1) must have positive integer "line"`);
				}
				if (f["severity"] !== undefined && !SEVERITIES.has(f["severity"] as Severity)) {
					errors.push(`findings[${i}] "severity" not in critical/warning/suggestion`);
				}
			}

			if (l === "L2") {
				const ev = String(f["evidence"] ?? "");
				if (!CONSTRAINT_ID_RE.test(ev) && !SPEC_REF_RE.test(ev)) {
					errors.push(`findings[${i}] (L2) evidence must cite a constraint ID ([A-Z]+-\\d+) or spec-<stem>:<case>`);
				}
			}
		});
	}

	const ok = errors.length === 0;
	const parsed: ParsedVerdict | undefined = ok
		? {
				layer: layer as Layer,
				verdict: verdict as Verdict,
				findings: (findings as Finding[]).filter((f) => isObj(f)),
				summary: summary as string,
				checks: Array.isArray(raw["checks"]) ? (raw["checks"] as Check[]) : undefined,
				raw,
			}
		: undefined;
	return { ok, errors, verdict: parsed };
}

/** Convenience: extract + validate in one call. */
export function parseAndValidate(text: string, expectedLayer: Layer): ValidationResult {
	const obj = extractJson(text);
	if (obj === null) return { ok: false, errors: ["no parseable JSON object in output"] };
	return validateVerdict(obj, expectedLayer);
}

/** True when the verdict blocks the pipeline (fail, or any critical/warning finding). */
export function isBlocking(v: ParsedVerdict): boolean {
	if (v.verdict === "fail") return true;
	return v.findings.some((f) => f.severity === "critical" || f.severity === "warning");
}

/** Render findings as an evidence-backed打回 message for the coder (no reviewer prose). */
export function formatFindingsForCoder(v: ParsedVerdict): string {
	const lines: string[] = [];
	for (const f of v.findings) {
		if (f.severity === "suggestion" && !f.uncertain) continue; // suggestions don't block
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(`- [${f.severity ?? "?"}] ${loc}`);
		lines.push(`  evidence: ${String(f.evidence ?? "").trim()}`);
		if (f.required_fix) lines.push(`  fix: ${f.required_fix.trim()}`);
		if (f.failing_test) lines.push(`  failing_test: ${f.failing_test.trim()}`);
	}
	return lines.join("\n");
}
