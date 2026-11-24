/**
 * Human-readable differences between two versions of an item.
 * JSON is compared by key path, other text by line.
 */

import { diffLines } from "diff";
import { tryParseJson, type Json } from "./canonical";

export interface JsonDiffRow {
	path: string;
	type: "added" | "removed" | "changed";
	before?: string;
	after?: string;
}

export interface LineDiffRow {
	type: "added" | "removed" | "context";
	text: string;
}

export type ItemDiff = { kind: "json"; rows: JsonDiffRow[] } | { kind: "text"; rows: LineDiffRow[] };

function isObject(v: Json | undefined): v is { [key: string]: Json } {
	return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

function show(v: Json | undefined): string {
	return JSON.stringify(v);
}

function walk(path: string, a: Json | undefined, b: Json | undefined, rows: JsonDiffRow[]): void {
	if (isObject(a) && isObject(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const k of keys) walk(path ? `${path}.${k}` : k, a[k], b[k], rows);
		return;
	}
	if (a === undefined && b === undefined) return;
	if (a === undefined) rows.push({ path: path || "(root)", type: "added", after: show(b) });
	else if (b === undefined) rows.push({ path: path || "(root)", type: "removed", before: show(a) });
	else if (JSON.stringify(a) !== JSON.stringify(b)) {
		rows.push({ path: path || "(root)", type: "changed", before: show(a), after: show(b) });
	}
}

export function jsonDiff(before: Json | undefined, after: Json | undefined): JsonDiffRow[] {
	const rows: JsonDiffRow[] = [];
	walk("", before, after, rows);
	return rows;
}

export function lineDiff(before: string, after: string, context = 3): LineDiffRow[] {
	const all: LineDiffRow[] = [];
	for (const part of diffLines(before, after)) {
		const lines = part.value.replace(/\n$/, "").split("\n");
		const type = part.added ? "added" : part.removed ? "removed" : "context";
		for (const text of lines) all.push({ type, text });
	}
	// Keep only `context` unchanged lines around each change.
	const keep = new Array<boolean>(all.length).fill(false);
	all.forEach((row, i) => {
		if (row.type === "context") return;
		for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true;
	});
	const out: LineDiffRow[] = [];
	let skipped = false;
	all.forEach((row, i) => {
		if (keep[i]) {
			out.push(row);
			skipped = false;
		} else if (!skipped) {
			out.push({ type: "context", text: "…" });
			skipped = true;
		}
	});
	return out;
}

/** Diff from `before` to `after`; either side may be absent (item added or removed). */
export function itemDiff(before: string | undefined, after: string | undefined): ItemDiff {
	const a = before === undefined ? undefined : tryParseJson(before);
	const b = after === undefined ? undefined : tryParseJson(after);
	const jsonA = before === undefined || a !== undefined;
	const jsonB = after === undefined || b !== undefined;
	if (jsonA && jsonB && (a !== undefined || b !== undefined)) return { kind: "json", rows: jsonDiff(a, b) };
	return { kind: "text", rows: lineDiff(before ?? "", after ?? "") };
}
