/**
 * Key-by-key merge of two versions of a JSON settings file.
 *
 * The base keeps only a hash, not the content, so it is unknown which side changed
 * a given key: the user picks a side for every differing key. Both texts are the
 * canonical, secret-redacted texts the comparison works with, so the result is in
 * the same form and its hash is comparable with either side.
 */

import { canonicalJson, tryParseJson, type Json } from "./canonical";
import type { Change } from "./classify";
import { jsonDiff, type JsonDiffRow } from "./diff";
import { fileItem, splitKey } from "./model";

export type MergeSide = "local" | "remote";

/** Stable key of a diff row for a picks map. */
export function rowId(row: JsonDiffRow): string {
	return JSON.stringify(row.segments);
}

export interface JsonMerge {
	localText: string;
	remoteText: string;
	local: Json;
	remote: Json;
	rows: JsonDiffRow[];
}

/** Rows that can be picked, or null if either side is absent or not JSON. */
export function prepareMerge(localText: string | undefined, remoteText: string | undefined): JsonMerge | null {
	if (localText === undefined || remoteText === undefined) return null;
	const local = tryParseJson(localText);
	const remote = tryParseJson(remoteText);
	if (local === undefined || remote === undefined) return null;
	return { localText, remoteText, local, remote, rows: jsonDiff(local, remote) };
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
	return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** Set (or with `undefined` remove) the value at `segments` inside `root`; returns the new root. */
function setAt(root: Json, segments: string[], value: Json | undefined): Json | undefined {
	if (segments.length === 0) return value;
	if (!isObject(root)) return root;
	let node: { [key: string]: Json } = root;
	for (const key of segments.slice(0, -1)) {
		const next = node[key];
		if (!isObject(next)) node[key] = {};
		node = node[key] as { [key: string]: Json };
	}
	const last = segments[segments.length - 1];
	if (value === undefined) delete node[last];
	else node[last] = value;
	return root;
}

function getAt(root: Json, segments: string[]): Json | undefined {
	let node: Json | undefined = root;
	for (const key of segments) {
		if (!isObject(node)) return undefined;
		node = node[key];
	}
	return node;
}

/**
 * The local version with the profile's value taken for every row picked "remote".
 * Rows without a pick keep the local value.
 */
export function mergeJson(m: JsonMerge, picks: Map<string, MergeSide>): string {
	let result: Json | undefined = structuredClone(m.local);
	for (const row of m.rows) {
		if (picks.get(rowId(row)) !== "remote") continue;
		const value = getAt(m.remote, row.segments);
		result = setAt(result as Json, row.segments, value === undefined ? undefined : structuredClone(value));
	}
	return canonicalJson(result ?? {});
}

/**
 * The merge as a change whose both sides are the merged text. Pushed, it updates the
 * profile; pulled, it updates this vault (secrets restored); either way the base
 * becomes its hash. A side that already holds the result needs nothing.
 */
export async function mergedChange(
	change: Change,
	m: JsonMerge,
	picks: Map<string, MergeSide>,
): Promise<{ change: Change; pull: boolean; push: boolean }> {
	const text = mergeJson(m, picks);
	const { kind, name } = splitKey(change.key);
	const item = await fileItem(kind, name, text);
	return { change: { ...change, local: item, remote: item }, pull: text !== m.localText, push: text !== m.remoteText };
}
