/**
 * Secret redaction for JSON settings.
 *
 * String values of keys that look like credentials are replaced with a marker
 * before hashing and pushing. On pull the marker is replaced with the value the
 * vault already has, or with an empty string, so that a rescan yields the marker
 * again and the item stays in sync.
 */

import type { Json } from "./canonical";

export const SECRET_MARKER = "<vps:secret>";

const BUILTIN_SUFFIXES = [
	"token",
	"secret",
	"password",
	"passwd",
	"apikey",
	"accesskey",
	"privatekey",
	"credential",
	"credentials",
	"clientsecret",
];

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class SecretMatcher {
	private readonly extra: Set<string>;

	constructor(extraKeys: string[] = []) {
		this.extra = new Set(extraKeys.map(normalizeKey).filter((k) => k.length > 0));
	}

	isSecretKey(key: string): boolean {
		const k = normalizeKey(key);
		if (k.length === 0) return false;
		if (this.extra.has(k)) return true;
		return BUILTIN_SUFFIXES.some((s) => k === s || k.endsWith(s));
	}
}

/** Return a copy of value with secret string values replaced by the marker. */
export function redactSecrets(value: Json, matcher: SecretMatcher): Json {
	if (Array.isArray(value)) return value.map((v) => redactSecrets(v, matcher));
	if (value !== null && typeof value === "object") {
		const out: { [key: string]: Json } = {};
		for (const [key, v] of Object.entries(value)) {
			out[key] = typeof v === "string" && matcher.isSecretKey(key) ? SECRET_MARKER : redactSecrets(v, matcher);
		}
		return out;
	}
	return value;
}

/**
 * Replace markers in incoming with the values found at the same place in local.
 * A marker with no local string value becomes an empty string.
 */
export function restoreSecrets(incoming: Json, local: Json | undefined): Json {
	if (incoming === SECRET_MARKER) return typeof local === "string" ? local : "";
	if (Array.isArray(incoming)) {
		const localArr = Array.isArray(local) ? local : [];
		return incoming.map((v, i) => restoreSecrets(v, localArr[i]));
	}
	if (incoming !== null && typeof incoming === "object") {
		const localObj = local !== null && typeof local === "object" && !Array.isArray(local) ? local : {};
		const out: { [key: string]: Json } = {};
		for (const [key, v] of Object.entries(incoming)) out[key] = restoreSecrets(v, localObj[key]);
		return out;
	}
	return incoming;
}
