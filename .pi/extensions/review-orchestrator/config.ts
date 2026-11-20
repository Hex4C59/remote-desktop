// Deterministic orchestrator configuration — load + validate, fail-closed.
//
// Every routing / risk / gate decision comes from this file, never from an LLM.
// A missing or invalid field is an ERROR, not a silent default: silently
// defaulting a gate to "off" would turn a hard floor into a suggestion.
//
// Pure module: no Pi imports, no I/O beyond the injected reader, so it is
// testable standalone with `node --experimental-strip-types`.

import * as fs from "node:fs";
import * as path from "node:path";

export type StageName = "discussion" | "spec" | "plan" | "task" | "code";
export type L0Kind = "none" | "specs" | "coverage" | "task" | "build";
export type RiskLevel = "low" | "medium" | "high";

export interface PanelMember {
	/** provider/model-id, e.g. "opencode-go/claude-haiku-5-5". */
	model: string;
	/** Model FAMILY (vendor), not the provider id. A gateway hosts many families. */
	family: string;
}

export interface PanelConfig {
	members: PanelMember[];
	quorum: number;
	/**
	 * Minimum distinct model families that must actually vote. Two votes from one
	 * vendor are an echo, not an independent review.
	 */
	minDistinctFamilies: number;
	concurrency: number;
	timeoutMs: number;
	thinking: string;
}

export interface RiskConfig {
	forbiddenPaths: string[];
	highPaths: string[];
	mediumPaths: string[];
	securityPatterns: string[];
	mediumLines: number;
	highLines: number;
}

export interface LimitsConfig {
	maxRetries: number;
	maxL0ConsecutiveFailures: number;
	childTimeoutMs: number;
	diffCap: number;
}

export interface ArtifactsConfig {
	root: string;
	gitignore: boolean;
	exportDir: string;
}

export interface StageConfig {
	l0: L0Kind;
	l1: boolean;
	/** true = always, false = never, "risk" = only when risk routing says so. */
	panel: boolean | "risk";
	human: boolean | "risk";
}

export interface OrchestratorConfig {
	panel: PanelConfig;
	risk: RiskConfig;
	limits: LimitsConfig;
	autoCommit: boolean;
	specStatusWrite: boolean;
	artifacts: ArtifactsConfig;
	stages: Record<StageName, StageConfig>;
}

export interface ConfigResult {
	ok: boolean;
	errors: string[];
	config?: OrchestratorConfig;
}

const STAGES: StageName[] = ["discussion", "spec", "plan", "task", "code"];
const L0_KINDS: L0Kind[] = ["none", "specs", "coverage", "task", "build"];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
}

/** A rule list that must not be empty: an empty gate silently disappears. */
function nonEmptyStrArray(v: unknown): v is string[] {
	return strArray(v) && v.length > 0;
}

function posInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validate a parsed config object. Returns every problem found, so a bad config
 * reports all issues at once instead of one per run.
 */
export function validateConfig(raw: unknown): ConfigResult {
	const errors: string[] = [];
	if (!isObj(raw)) return { ok: false, errors: ["config is not a JSON object"] };

	// ---- panel ----
	const panelRaw = raw["panel"];
	let panel: PanelConfig | undefined;
	if (!isObj(panelRaw)) {
		errors.push('"panel" must be an object');
	} else {
		const membersRaw = panelRaw["members"];
		const members: PanelMember[] = [];
		if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
			errors.push('"panel.members" must be a non-empty array');
		} else {
			membersRaw.forEach((m, i) => {
				if (!isObj(m)) {
					errors.push(`panel.members[${i}] must be an object`);
					return;
				}
				const model = m["model"];
				const family = m["family"];
				if (typeof model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(model)) {
					errors.push(`panel.members[${i}].model must be "provider/model-id", got ${JSON.stringify(model)}`);
				}
				if (typeof family !== "string" || !family.trim()) {
					errors.push(`panel.members[${i}].family must be a non-empty string (the vendor, not the provider)`);
				}
				if (typeof model === "string" && typeof family === "string") {
					members.push({ model, family: family.trim().toLowerCase() });
				}
			});
			const families = members.map((m) => m.family);
			const dupFamily = families.find((f, i) => families.indexOf(f) !== i);
			if (dupFamily) {
				errors.push(`panel members must come from distinct families; "${dupFamily}" appears twice`);
			}
			const models = members.map((m) => m.model);
			const dupModel = models.find((m, i) => models.indexOf(m) !== i);
			if (dupModel) errors.push(`panel member "${dupModel}" is listed twice`);
		}

		const quorum = panelRaw["quorum"];
		const concurrency = panelRaw["concurrency"];
		const timeoutMs = panelRaw["timeoutMs"];
		const thinking = panelRaw["thinking"];
		if (!posInt(quorum)) errors.push('"panel.quorum" must be a positive integer');
		else if (members.length > 0 && quorum > members.length) {
			errors.push(`"panel.quorum" (${quorum}) exceeds member count (${members.length}); the panel could never reach quorum`);
		}
		const minFamilies = panelRaw["minDistinctFamilies"];
		if (!posInt(minFamilies)) {
			errors.push('"panel.minDistinctFamilies" must be a positive integer (same-vendor votes are not independent)');
		} else {
			const distinct = new Set(members.map((m) => m.family)).size;
			if (minFamilies > distinct) {
				errors.push(`"panel.minDistinctFamilies" (${minFamilies}) exceeds distinct families configured (${distinct})`);
			}
			// After excluding the coder's own family at least minFamilies must remain,
			// otherwise every run would end BLOCKED.
			if (distinct > 0 && distinct - 1 < minFamilies) {
				errors.push(
					`panel needs at least ${minFamilies + 1} distinct families so that excluding the coder's family still leaves ${minFamilies}; configured ${distinct}`,
				);
			}
			if (posInt(quorum) && distinct > 0 && distinct - 1 < quorum) {
				errors.push(
					`panel needs at least ${quorum + 1} members in distinct families so quorum ${quorum} survives excluding the coder's family; configured ${distinct}`,
				);
			}
		}
		if (!posInt(concurrency) || (posInt(concurrency) && concurrency > 3)) {
			errors.push('"panel.concurrency" must be an integer in 1..3');
		}
		if (!posInt(timeoutMs)) errors.push('"panel.timeoutMs" must be a positive integer');
		if (typeof thinking !== "string" || !THINKING.has(thinking)) {
			errors.push(`"panel.thinking" must be one of ${[...THINKING].join("/")}`);
		}
		if (
			members.length > 0 && posInt(quorum) && posInt(minFamilies) && posInt(concurrency) && posInt(timeoutMs) &&
			typeof thinking === "string" && THINKING.has(thinking)
		) {
			panel = { members, quorum, minDistinctFamilies: minFamilies, concurrency, timeoutMs, thinking };
		}
	}

	// ---- risk ----
	const riskRaw = raw["risk"];
	let risk: RiskConfig | undefined;
	if (!isObj(riskRaw)) {
		errors.push('"risk" must be an object');
	} else {
		for (const key of ["forbiddenPaths", "highPaths", "mediumPaths", "securityPatterns"] as const) {
			// forbiddenPaths / securityPatterns are safety gates: emptying them would
			// silently disable the gate, so they must stay non-empty.
			const mustHaveEntries = key === "forbiddenPaths" || key === "securityPatterns";
			const valid = mustHaveEntries ? nonEmptyStrArray(riskRaw[key]) : strArray(riskRaw[key]);
			if (!valid) {
				errors.push(
					mustHaveEntries
						? `"risk.${key}" must be a non-empty array of strings (emptying it would disable the gate)`
						: `"risk.${key}" must be an array of non-empty strings`,
				);
			}
		}
		const mediumLines = riskRaw["mediumLines"];
		const highLines = riskRaw["highLines"];
		if (!posInt(mediumLines)) errors.push('"risk.mediumLines" must be a positive integer');
		if (!posInt(highLines)) errors.push('"risk.highLines" must be a positive integer');
		if (posInt(mediumLines) && posInt(highLines) && mediumLines >= highLines) {
			errors.push('"risk.mediumLines" must be smaller than "risk.highLines"');
		}
		if (
			nonEmptyStrArray(riskRaw["forbiddenPaths"]) && strArray(riskRaw["highPaths"]) &&
			strArray(riskRaw["mediumPaths"]) && nonEmptyStrArray(riskRaw["securityPatterns"]) &&
			posInt(mediumLines) && posInt(highLines) && mediumLines < highLines
		) {
			risk = {
				forbiddenPaths: riskRaw["forbiddenPaths"],
				highPaths: riskRaw["highPaths"],
				mediumPaths: riskRaw["mediumPaths"],
				securityPatterns: riskRaw["securityPatterns"],
				mediumLines,
				highLines,
			};
		}
	}

	// ---- limits ----
	const limitsRaw = raw["limits"];
	let limits: LimitsConfig | undefined;
	if (!isObj(limitsRaw)) {
		errors.push('"limits" must be an object');
	} else {
		for (const key of ["maxRetries", "maxL0ConsecutiveFailures", "childTimeoutMs", "diffCap"] as const) {
			if (!posInt(limitsRaw[key])) errors.push(`"limits.${key}" must be a positive integer`);
		}
		if (
			posInt(limitsRaw["maxRetries"]) && posInt(limitsRaw["maxL0ConsecutiveFailures"]) &&
			posInt(limitsRaw["childTimeoutMs"]) && posInt(limitsRaw["diffCap"])
		) {
			limits = {
				maxRetries: limitsRaw["maxRetries"],
				maxL0ConsecutiveFailures: limitsRaw["maxL0ConsecutiveFailures"],
				childTimeoutMs: limitsRaw["childTimeoutMs"],
				diffCap: limitsRaw["diffCap"],
			};
		}
	}

	// ---- safety switches: must be explicit booleans ----
	const autoCommit = raw["autoCommit"];
	const specStatusWrite = raw["specStatusWrite"];
	if (typeof autoCommit !== "boolean") {
		errors.push('"autoCommit" must be an explicit boolean (it writes to the repository)');
	}
	if (typeof specStatusWrite !== "boolean") {
		errors.push('"specStatusWrite" must be an explicit boolean (AGENTS.md forbids silently approving specs)');
	}

	// ---- artifacts ----
	const artRaw = raw["artifacts"];
	let artifacts: ArtifactsConfig | undefined;
	if (!isObj(artRaw)) {
		errors.push('"artifacts" must be an object');
	} else {
		const root = artRaw["root"];
		const gitignore = artRaw["gitignore"];
		const exportDir = artRaw["exportDir"];
		if (typeof root !== "string" || !root.trim() || path.isAbsolute(root) || root.includes("..")) {
			errors.push('"artifacts.root" must be a relative path inside the project without ".."');
		}
		if (typeof gitignore !== "boolean") errors.push('"artifacts.gitignore" must be a boolean');
		if (typeof exportDir !== "string" || !exportDir.trim() || path.isAbsolute(exportDir) || exportDir.includes("..")) {
			errors.push('"artifacts.exportDir" must be a relative path without ".."');
		}
		if (
			typeof root === "string" && root.trim() && !path.isAbsolute(root) && !root.includes("..") &&
			typeof gitignore === "boolean" &&
			typeof exportDir === "string" && exportDir.trim() && !path.isAbsolute(exportDir) && !exportDir.includes("..")
		) {
			artifacts = { root, gitignore, exportDir };
		}
	}

	// ---- stages ----
	const stagesRaw = raw["stages"];
	let stages: Record<StageName, StageConfig> | undefined;
	if (!isObj(stagesRaw)) {
		errors.push('"stages" must be an object');
	} else {
		const parsed = {} as Record<StageName, StageConfig>;
		let stagesOk = true;
		for (const name of STAGES) {
			const s = stagesRaw[name];
			if (!isObj(s)) {
				errors.push(`"stages.${name}" must be an object`);
				stagesOk = false;
				continue;
			}
			const l0 = s["l0"];
			const l1 = s["l1"];
			const panelFlag = s["panel"];
			const humanFlag = s["human"];
			if (typeof l0 !== "string" || !L0_KINDS.includes(l0 as L0Kind)) {
				errors.push(`"stages.${name}.l0" must be one of ${L0_KINDS.join("/")}`);
				stagesOk = false;
			}
			if (typeof l1 !== "boolean") {
				errors.push(`"stages.${name}.l1" must be a boolean`);
				stagesOk = false;
			}
			for (const [key, val] of [["panel", panelFlag], ["human", humanFlag]] as const) {
				if (typeof val !== "boolean" && val !== "risk") {
					errors.push(`"stages.${name}.${key}" must be a boolean or "risk"`);
					stagesOk = false;
				}
			}
			// Deliverable stages have no deterministic risk grade, and discussion/task
			// have no human-gate state at all. Silently treating these as false would
			// turn a declared gate into "never runs"; reject the config instead.
			if (name !== "code" && humanFlag === "risk") {
				errors.push(`"stages.${name}.human" cannot be "risk": risk grading only exists for the code stage`);
				stagesOk = false;
			}
			if ((name === "discussion" || name === "task") && humanFlag === true) {
				errors.push(`"stages.${name}.human" cannot be true: that stage has no human-gate state`);
				stagesOk = false;
			}
			// Only spec (explicit panel) and code (explicit or risk-gated panel) have
			// an L2 sub-state. Allowing it elsewhere would silently skip the gate.
			if (name !== "spec" && name !== "code" && panelFlag !== false) {
				errors.push(`"stages.${name}.panel" cannot be ${JSON.stringify(panelFlag)}: that stage has no L2 sub-state`);
				stagesOk = false;
			}
			if (name === "spec" && panelFlag === "risk") {
				errors.push(`"stages.spec.panel" cannot be "risk": deliverable stages have no risk grading`);
				stagesOk = false;
			}
			if (stagesOk) {
				parsed[name] = {
					l0: l0 as L0Kind,
					l1: l1 as boolean,
					panel: panelFlag as boolean | "risk",
					human: humanFlag as boolean | "risk",
				};
			}
		}
		if (stagesOk) stages = parsed;
	}

	const ok =
		errors.length === 0 &&
		Boolean(panel && risk && limits && artifacts && stages) &&
		typeof autoCommit === "boolean" && typeof specStatusWrite === "boolean";

	if (!ok) return { ok: false, errors };
	return {
		ok: true,
		errors: [],
		config: {
			panel: panel!, risk: risk!, limits: limits!,
			autoCommit: autoCommit as boolean,
			specStatusWrite: specStatusWrite as boolean,
			artifacts: artifacts!, stages: stages!,
		},
	};
}

/** Load and validate the project config. Never throws for a bad file: reports it. */
export function loadConfig(cwd: string, configDirName = ".pi"): ConfigResult {
	const file = path.join(cwd, configDirName, "orchestrator", "config.json");
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (e) {
		return { ok: false, errors: [`cannot read ${file}: ${(e as Error).message}`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { ok: false, errors: [`${file} is not valid JSON: ${(e as Error).message}`] };
	}
	return validateConfig(parsed);
}
