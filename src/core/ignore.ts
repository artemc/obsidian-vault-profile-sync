/**
 * Keys inside a JSON settings file that this vault does not track
 * (`enabledCssSnippets` in appearance.json, for example).
 *
 * An ignored key never makes the file differ: both sides are hashed without it.
 * It does not travel either: the side that receives the file keeps its own value,
 * and takes the sender's only when it has none. Other keys of the file sync as usual.
 *
 * The hash of a file compared without some keys carries the rule after a `~`, so a
 * base recorded under another rule is recognised as such and can be carried over
 * (see SyncEngine.compare) instead of turning the file into a conflict.
 */

import { canonicalJson, gitBlobSha, tryParseJson, type Json } from "./canonical";

/** Path of a key inside a JSON object, one segment per level (keys may contain dots). */
export type KeyPath = string[];

/** Ignored key paths by item key (`config:appearance.json`). */
export type IgnoredKeys = Record<string, KeyPath[]>;

export function isObject(v: Json | undefined): v is { [key: string]: Json } {
	return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

export function getAt(root: Json | undefined, segments: string[]): Json | undefined {
	let node: Json | undefined = root;
	for (const key of segments) {
		if (!isObject(node)) return undefined;
		node = node[key];
	}
	return node;
}

/** Set (or with `undefined` remove) the value at `segments` inside `root`; returns the new root. */
export function setAt(root: Json, segments: string[], value: Json | undefined): Json | undefined {
	if (segments.length === 0) return value;
	if (!isObject(root)) return root;
	let node: { [key: string]: Json } = root;
	for (const key of segments.slice(0, -1)) {
		const next = node[key];
		if (!isObject(next)) {
			if (value === undefined) return root;
			node[key] = {};
		}
		node = node[key] as { [key: string]: Json };
	}
	const last = segments[segments.length - 1];
	if (value === undefined) delete node[last];
	else node[last] = value;
	return root;
}

function samePath(a: KeyPath, b: KeyPath): boolean {
	return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Whether the key at `segments` is ignored: it or one of its parents is listed. */
export function isIgnoredPath(segments: string[], paths: KeyPath[]): boolean {
	return paths.some((p) => p.length > 0 && p.length <= segments.length && p.every((s, i) => s === segments[i]));
}

export function addPath(paths: KeyPath[], path: KeyPath): KeyPath[] {
	return paths.some((p) => samePath(p, path)) ? paths : [...paths, path];
}

export function removePath(paths: KeyPath[], path: KeyPath): KeyPath[] {
	return paths.filter((p) => !samePath(p, path));
}

/** Keep only well-formed entries of stored data. */
export function normalizeIgnored(value: unknown): IgnoredKeys {
	const out: IgnoredKeys = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		const paths = list.filter((p): p is KeyPath => Array.isArray(p) && p.length > 0 && p.every((s) => typeof s === "string"));
		if (paths.length > 0) out[key] = paths;
	}
	return out;
}

function signature(paths: KeyPath[]): string {
	return JSON.stringify(paths.map((p) => JSON.stringify(p)).sort());
}

/** The rule a hash was made under: the ignored paths after `~`, none for a plain git sha. */
export function hashRule(hash: string): KeyPath[] {
	const i = hash.indexOf("~");
	if (i < 0) return [];
	try {
		return (JSON.parse(hash.slice(i + 1)) as string[]).map((p) => JSON.parse(p) as KeyPath);
	} catch {
		return [];
	}
}

export function sameRule(a: KeyPath[], b: KeyPath[]): boolean {
	return signature(a) === signature(b);
}

/** Canonical text without the ignored keys, or the text itself when there is nothing to leave out. */
export function comparedText(text: string, paths: KeyPath[]): string {
	if (paths.length === 0) return text;
	const parsed = tryParseJson(text);
	if (parsed === undefined) return text;
	let v: Json | undefined = structuredClone(parsed);
	for (const p of paths) v = setAt(v as Json, p, undefined);
	return canonicalJson(v ?? {});
}

/**
 * Hash for comparing an item. Without ignored keys it is the git blob sha of the text,
 * which is what the remote listing gives; with them, the sha of the text without
 * those keys, marked with the rule.
 */
export async function comparedHash(text: string, paths: KeyPath[]): Promise<string> {
	if (paths.length === 0 || tryParseJson(text) === undefined) return gitBlobSha(text);
	return `${await gitBlobSha(comparedText(text, paths))}~${signature(paths)}`;
}

/**
 * `value` with the ignored keys taken from `keeper` wherever `keeper` has them:
 * the receiving side keeps its own values and takes the sender's only where it has none.
 */
export function keepIgnored(value: Json, keeper: Json | undefined, paths: KeyPath[]): Json {
	let out: Json | undefined = value;
	for (const p of paths) {
		const kept = getAt(keeper, p);
		if (kept !== undefined) out = setAt(out as Json, p, structuredClone(kept));
	}
	return out ?? value;
}

/** Display form of a key path. */
export function pathLabel(path: KeyPath): string {
	return path.join(".");
}
