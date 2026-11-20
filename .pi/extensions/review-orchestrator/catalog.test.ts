// Tests for catalog.ts — parses the real constraint catalog.
// Run: node --experimental-strip-types .pi/extensions/review-orchestrator/catalog.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { parseCatalogTable, buildConstraintChecklist, knownConstraintIds } from "./catalog.ts";

const CATALOG = ".pi/review/constraint-catalog.md";
let passed = 0;
function check(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		console.error(`  FAIL ${name}: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}

console.log("== catalog.ts tests ==");

const md = fs.readFileSync(CATALOG, "utf-8");
const entries = parseCatalogTable(md);
const byId = new Map(entries.map((e) => [e.id, e]));

check("extracts the deterministic L0-covered IDs from the real catalog", () => {
	for (const id of ["DEP-01", "DEP-02", "DEP-03", "DEP-04", "DEP-05", "THREAD-01", "THREAD-02"]) {
		const e = byId.get(id);
		assert.ok(e, `missing ${id}`);
		assert.equal(e.l0Covered, true, `${id} should be marked L0-covered`);
	}
});

check("extracts L2-only IDs and does not mark them L0-covered", () => {
	for (const id of ["HANDOFF-1", "HANDOFF-8", "QUEUE-1", "LATENCY-2", "HOTPATH-1", "SHUTDOWN-1", "THREAD-03"]) {
		const e = byId.get(id);
		assert.ok(e, `missing ${id}`);
		assert.equal(e.l0Covered, false, `${id} must be L2-only`);
	}
});

check("extracts platform/security IDs", () => {
	for (const id of ["PLAT-1", "PLAT-3", "PLAT-4", "SEC-1", "SEC-3"]) {
		assert.ok(byId.has(id), `missing ${id}`);
	}
});

check("ignores header rows, separators and spec placeholders", () => {
	assert.ok(!byId.has("编号"));
	assert.ok(!byId.has("spec-<stem>:<case-id>"));
	assert.ok(entries.length >= 30, `expected a full catalog, got ${entries.length} entries`);
});

check("checklist lists L2 IDs individually and L0 IDs compactly", () => {
	const list = buildConstraintChecklist(md);
	assert.ok(list.includes("HANDOFF-1"), "L2 ID must be listed with its text");
	assert.ok(list.includes("L2 专属约束"));
	assert.ok(list.includes("L0 已确定性覆盖"));
	// L0 IDs appear only in the compact line, not as per-ID bullets.
	assert.ok(!/^- DEP-01:/m.test(list), "L0 IDs must not be expanded as L2 bullets");
	assert.ok(list.includes("DEP-01, DEP-02"), "L0 IDs listed compactly");
	assert.ok(list.includes("spec-<file-stem>:<case-id>"));
});

check("knownConstraintIds covers both sections", () => {
	const ids = knownConstraintIds(md);
	assert.ok(ids.has("DEP-01"));
	assert.ok(ids.has("PLAT-7"));
	assert.ok(!ids.has("NOT-A-REAL-ID"));
});

check("every L2 checklist ID is a real catalog ID", () => {
	const list = buildConstraintChecklist(md);
	for (const m of list.matchAll(/^- ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+):/gm)) {
		assert.ok(byId.has(m[1]), `checklist cites unknown ID ${m[1]}`);
	}
});

console.log(`\n${passed}/7 passed${process.exitCode ? " — SOME FAILED" : ", all green"}`);
