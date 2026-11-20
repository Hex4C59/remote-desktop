// Artifact store — the evidence chain (blueprint figure 4).
//
// Layout:
//   .orchestrator/<run-id>/
//     state.json                  machine state, checkpoint, round, retry counts
//     DECISIONS.md                discussion outcome: why A and not B
//     spec/{spec.md,l0-results.json,l1-findings.json,l2-verdict.json}
//     plan/{plan.md,coverage-matrix.json,l0-results.json,...}
//     checkpoints/<cp-id>/{TASK.md,diff.patch,diff-stat.txt,l0-results.json,
//                          l1-findings.json,l2-verdict.json,l2-panel.json,
//                          review-package/{summary.md,risk-assessment.md,evidence.sha256},
//                          human-decision.json}
//     escalations/<timestamp>-<reason>.json
//
// Guarantees:
//   - atomic writes (temp file + rename) so a crash cannot leave half a verdict
//   - evidence.sha256 is recomputable with plain `sha256sum`, no custom tooling
//   - nothing secret is written: callers pass content, and a guard rejects
//     obvious credential shapes before anything hits disk

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type Stage = "discussion" | "spec" | "plan" | "task" | "code";

/** Sortable, collision-resistant run id: UTC timestamp + random suffix. */
export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Filesystem-safe id for run ids / checkpoints / escalation reasons.
 *
 * Dots are dropped entirely: allowing them let safeId("..") return "..", which
 * made runDir and checkpointDir resolve OUTSIDE the artifact root (an evidence
 * write could land in the project root or above it). Hyphens and underscores are
 * enough for readable ids and cannot traverse.
 */
export function safeId(raw: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 80) || "unnamed";
}

/**
 * Reject content that looks like a credential. The artifact chain is meant to be
 * shareable (and exportable into git), so it must never carry keys or tokens.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\bsk-[A-Za-z0-9_-]{16,}/, "OpenAI-style secret key"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
	[/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
	[/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "private key block"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
	[/(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i, "inline credential assignment"],
	[/\bBearer\s+[A-Za-z0-9._\-]{20,}/i, "bearer token"],
];

export function findSecrets(text: string): string[] {
	const hits: string[] = [];
	for (const [re, label] of SECRET_PATTERNS) {
		if (re.test(text)) hits.push(label);
	}
	return hits;
}

export class SecretInArtifactError extends Error {
	constructor(file: string, labels: string[]) {
		super(`refusing to write ${file}: looks like it contains ${labels.join(", ")}`);
		this.name = "SecretInArtifactError";
	}
}

/** Write via temp file + rename so readers never observe a partial file. */
export function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	try {
		fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (e) {
		try { fs.unlinkSync(tmp); } catch { /* noop */ }
		throw e;
	}
}

export function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Files never covered by evidence.sha256.
 *
 * The manifest cannot hash itself. artifacts-index.md LISTS those hashes, so it
 * can only be written after the manifest exists; including it would make every
 * later verification report "unexpected new file".
 */
export const MANIFEST_EXCLUDES = ["evidence.sha256", "artifacts-index.md"];

/** Stable JSON with sorted keys, so hashes do not depend on insertion order. */
export function stableJson(value: unknown): string {
	return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			out[k] = sortKeys((v as Record<string, unknown>)[k]);
		}
		return out;
	}
	return v;
}

export interface StoreOptions {
	cwd: string;
	/** Artifact root relative to cwd, e.g. ".orchestrator". */
	root: string;
	runId: string;
	/** When true (default) refuse to write anything that looks like a secret. */
	guardSecrets?: boolean;
}

export class ArtifactStore {
	readonly cwd: string;
	readonly runId: string;
	readonly runDir: string;
	private readonly guard: boolean;

	constructor(opts: StoreOptions) {
		if (path.isAbsolute(opts.root) || opts.root.split(/[\\/]/).includes("..")) {
			throw new Error(`artifact root must stay inside the project: ${opts.root}`);
		}
		this.cwd = path.resolve(opts.cwd);
		this.runId = safeId(opts.runId);
		this.runDir = path.join(this.cwd, opts.root, this.runId);
		this.guard = opts.guardSecrets !== false;
	}

	/** Resolve a path inside the run dir, refusing escapes. */
	resolve(...parts: string[]): string {
		const file = path.join(this.runDir, ...parts);
		const rel = path.relative(this.runDir, file);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`artifact path escapes the run directory: ${parts.join("/")}`);
		}
		return file;
	}

	writeText(relPath: string, content: string): string {
		const file = this.resolve(relPath);
		if (this.guard) {
			const hits = findSecrets(content);
			if (hits.length > 0) throw new SecretInArtifactError(relPath, hits);
		}
		writeAtomic(file, content);
		return file;
	}

	writeJson(relPath: string, value: unknown): string {
		return this.writeText(relPath, stableJson(value));
	}

	readText(relPath: string): string | undefined {
		try {
			return fs.readFileSync(this.resolve(relPath), "utf-8");
		} catch {
			return undefined;
		}
	}

	readJson<T = unknown>(relPath: string): T | undefined {
		const text = this.readText(relPath);
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	exists(relPath: string): boolean {
		return fs.existsSync(this.resolve(relPath));
	}

	// ---- blueprint directory contract ----
	statePath(): string { return "state.json"; }
	decisionsPath(): string { return "DECISIONS.md"; }
	stageDir(stage: Stage): string { return stage === "code" ? "checkpoints" : stage; }
	stageFile(stage: Stage, name: string): string { return `${this.stageDir(stage)}/${name}`; }
	checkpointDir(cpId: string): string { return `checkpoints/${safeId(cpId)}`; }
	checkpointFile(cpId: string, name: string): string { return `${this.checkpointDir(cpId)}/${name}`; }
	reviewPackageDir(cpId: string): string { return `${this.checkpointDir(cpId)}/review-package`; }
	escalationFile(reason: string, now = new Date()): string {
		const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
		return `escalations/${stamp}-${safeId(reason)}.json`;
	}

	saveState(state: unknown): string { return this.writeJson(this.statePath(), state); }
	loadState<T = unknown>(): T | undefined { return this.readJson<T>(this.statePath()); }

	/**
	 * Hash every file under a directory (excluding the manifest itself).
	 * Output format matches `sha256sum`: "<hex>  <relative/path>".
	 * Sorted by path so the manifest is reproducible.
	 */
	hashDir(relDir: string, exclude: string[] = MANIFEST_EXCLUDES): string {
		const base = this.resolve(relDir);
		const files: string[] = [];
		const walk = (dir: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.isFile()) {
					const rel = path.relative(base, full).split(path.sep).join("/");
					if (!exclude.includes(rel)) files.push(rel);
				}
			}
		};
		walk(base);
		files.sort();
		return files
			.map((rel) => `${sha256(fs.readFileSync(path.join(base, rel)))}  ${rel}`)
			.join("\n") + (files.length ? "\n" : "");
	}

	/** Write the manifest for a directory and return its content. */
	writeEvidenceManifest(relDir: string, exclude: string[] = MANIFEST_EXCLUDES): string {
		const manifest = this.hashDir(relDir, exclude);
		this.writeText(`${relDir}/evidence.sha256`, manifest);
		return manifest;
	}

	/** Recompute and compare against the stored manifest. */
	verifyEvidenceManifest(relDir: string, exclude: string[] = MANIFEST_EXCLUDES):
		{ ok: true; problems: string[]; packageHash: string } | { ok: false; problems: string[] } {
		const stored = this.readText(`${relDir}/evidence.sha256`);
		if (stored === undefined) return { ok: false, problems: ["evidence.sha256 missing"] };
		const current = this.hashDir(relDir, exclude);
		if (stored === current) return { ok: true, problems: [], packageHash: sha256(current) };

		const parse = (t: string) => new Map(
			t.split("\n").filter(Boolean).map((l) => {
				const i = l.indexOf("  ");
				return [l.slice(i + 2), l.slice(0, i)] as [string, string];
			}),
		);
		const a = parse(stored);
		const b = parse(current);
		const problems: string[] = [];
		for (const [file, hash] of a) {
			if (!b.has(file)) problems.push(`missing: ${file}`);
			else if (b.get(file) !== hash) problems.push(`changed: ${file}`);
		}
		for (const file of b.keys()) if (!a.has(file)) problems.push(`unexpected new file: ${file}`);
		return { ok: false, problems };
	}

	/** List escalation records, newest first. */
	listEscalations(): string[] {
		try {
			return fs.readdirSync(this.resolve("escalations"))
				.filter((f) => f.endsWith(".json"))
				.sort()
				.reverse();
		} catch {
			return [];
		}
	}
}

/**
 * List existing run ids under an artifact root, newest first.
 *
 * Run ids are timestamp-prefixed, so a lexical sort is chronological. Used by
 * `/orch resume` to adopt an interrupted run instead of starting a fresh one and
 * silently re-running gates a human already approved.
 */
export function listRuns(cwd: string, root: string): string[] {
	if (path.isAbsolute(root) || root.split(/[\\/]/).includes("..")) return [];
	try {
		return fs.readdirSync(path.join(cwd, root), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.filter((name) => fs.existsSync(path.join(cwd, root, name, "state.json")))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

/**
 * Ensure the artifact root is git-ignored. Idempotent; returns whether it added
 * a line. Artifacts contain diffs and source excerpts, so they stay out of git
 * unless explicitly exported.
 */
export function ensureGitignored(cwd: string, root: string): { added: boolean; file: string } {
	const file = path.join(cwd, ".gitignore");
	const entry = `/${root.replace(/^\/+|\/+$/g, "")}/`;
	let text = "";
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch { /* new file */ }
	const lines = text.split("\n").map((l) => l.trim());
	if (lines.includes(entry) || lines.includes(entry.slice(1))) return { added: false, file };
	const block = `${text.endsWith("\n") || text === "" ? "" : "\n"}# 编排器证据链：含 diff 与源码片段，默认不入库（用 /orch export 导出审查包）\n${entry}\n`;
	writeAtomic(file, text + block);
	return { added: true, file };
}

/** Copy a review package into an exportable directory (no secrets by construction). */
export function exportReviewPackage(
	store: ArtifactStore,
	cpId: string,
	cwd: string,
	exportDir: string,
): { dir: string; files: string[] } {
	if (path.isAbsolute(exportDir) || exportDir.split(/[\\/]/).includes("..")) {
		throw new Error(`export dir must stay inside the project: ${exportDir}`);
	}
	const src = store.resolve(store.reviewPackageDir(cpId));
	const dest = path.join(cwd, exportDir, store.runId, safeId(cpId));
	fs.mkdirSync(dest, { recursive: true });
	const files: string[] = [];
	const walk = (dir: string, prefix = "") => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, e.name);
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) walk(full, rel);
			else if (e.isFile()) {
				const content = fs.readFileSync(full, "utf-8");
				const hits = findSecrets(content);
				if (hits.length > 0) throw new SecretInArtifactError(rel, hits);
				writeAtomic(path.join(dest, rel), content);
				files.push(rel);
			}
		}
	};
	walk(src);
	return { dir: dest, files };
}
