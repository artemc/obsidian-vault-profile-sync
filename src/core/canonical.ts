/**
 * Canonical serialization and hashing.
 *
 * Every item is compared by a hash of its canonical text. JSON is written with
 * sorted keys, two-space indent and a trailing newline, so that a different key
 * order in two vaults is not reported as a change. File items are hashed with the
 * git blob SHA-1, which lets us compare against a GitHub tree without downloading
 * the blobs.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array {
	return encoder.encode(text);
}

export function utf8Decode(bytes: ArrayBuffer | Uint8Array): string {
	return decoder.decode(bytes);
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = sortDeep(v);
		}
		return out;
	}
	return value;
}

/** Serialize a JSON value with sorted keys, two-space indent and a final newline. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortDeep(value), null, 2) + "\n";
}

/** Parse JSON, returning undefined instead of throwing. */
export function tryParseJson(text: string): Json | undefined {
	try {
		return JSON.parse(text) as Json;
	} catch {
		return undefined;
	}
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-1", bytes as BufferSource));
}

/** Git blob id of the given content: sha1("blob <size>\0" + content). */
export async function gitBlobSha(content: string | Uint8Array): Promise<string> {
	const body = typeof content === "string" ? utf8Encode(content) : content;
	const header = utf8Encode(`blob ${body.byteLength}\0`);
	const all = new Uint8Array(header.byteLength + body.byteLength);
	all.set(header, 0);
	all.set(body, header.byteLength);
	return sha1Hex(all);
}

export function base64Encode(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
	const binary = atob(text.replace(/\s+/g, ""));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}
