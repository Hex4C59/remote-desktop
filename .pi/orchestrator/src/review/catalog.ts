// Builds the L2 constraint checklist from .pi/review/constraint-catalog.md.
//
// The catalog is the single source of citable constraint IDs. We extract only the
// ID + short constraint text (not the whole table), so the L2 child task stays
// focused and cheap, and every ID it may cite is visible up front.

export interface CatalogEntry {
	id: string;
	text: string;
	/** True for entries the deterministic L0 gate (ctest) already covers. */
	l0Covered: boolean;
}

const L0_SECTION_MARKER = "## 已由 L0（ctest）确定性覆盖的约束";
const L2_SECTION_MARKER = "## L2 专属约束";

/**
 * Parse `| \`ID\` | text | ... |` rows out of a markdown table.
 * Tolerates the backtick-less form too (`| ID | text |`).
 */
export function parseCatalogTable(md: string): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	let section = "";
	let l0 = false;
	for (const raw of md.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("## ")) {
			section = line;
			// Anything before "L2 专属约束" that mentions ctest counts as L0-covered.
			l0 = line.includes("L0") || (section !== "" && !line.includes(L2_SECTION_MARKER) && line.includes("覆盖"));
			continue;
		}
		if (!line.startsWith("|")) continue;
		// Skip separator rows like | --- | --- |
		if (/^\|[\s:|-]+\|$/.test(line)) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 2) continue;
		const rawId = cells[0].replace(/`/g, "").trim();
		// Only accept concrete IDs; skip header rows and range shorthand like T-01..T-09.
		if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(rawId)) continue;
		const text = cells[1].replace(/\s+/g, " ").trim();
		if (!text) continue;
		entries.push({ id: rawId, text, l0Covered: l0 });
	}
	return entries;
}

/** Compact checklist text handed to L2; L0-covered IDs are listed separately. */
export function buildConstraintChecklist(md: string): string {
	const entries = parseCatalogTable(md);
	const l2 = entries.filter((e) => !e.l0Covered);
	const l0 = entries.filter((e) => e.l0Covered);
	const out: string[] = [];

	if (l2.length > 0) {
		out.push("L2 专属约束（必须引用下列 ID）：");
		for (const e of l2) out.push(`- ${e.id}: ${e.text}`);
	}
	if (l0.length > 0) {
		out.push("");
		out.push("L0 已确定性覆盖（普通 #include / 文件头问题不要重复报告，仅在能指出静态扫描看不到的形式时才引用）：");
		out.push(`- ${l0.map((e) => e.id).join(", ")}`);
	}
	out.push("");
	out.push("此外可用 spec-<file-stem>:<case-id> 引用 specs/spec-*.md 中的验收用例。");
	return out.join("\n");
}

/** Every ID the catalog allows (used to validate L2 citations). */
export function knownConstraintIds(md: string): Set<string> {
	return new Set(parseCatalogTable(md).map((e) => e.id));
}
