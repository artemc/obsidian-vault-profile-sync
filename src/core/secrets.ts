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

/** Key names (lowercase, letters and digits only) that hold credentials; a plural "s" is allowed. */
const BUILTIN_SUFFIXES = ["token", "secret", "password", "passwd", "apikey", "accesskey", "privatekey", "credential", "clientsecret"];

/**
 * Values that are credentials whatever their key is called: URLs with a password
 * (`socks5://user:pass@host`) and tokens with well-known prefixes.
 */
const SECRET_VALUES = [
	/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
	/^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/,
	/^github_pat_[A-Za-z0-9_]{20,}$/,
	/^glpat-[A-Za-z0-9_-]{20,}$/,
	/^sk-[A-Za-z0-9_-]{20,}$/,
	/^xox[abprs]-[A-Za-z0-9-]{10,}$/,
	/^AKIA[0-9A-Z]{16}$/,
	/^AIza[0-9A-Za-z_-]{30,}$/,
];

export function isSecretValue(value: string): boolean {
	return SECRET_VALUES.some((r) => r.test(value));
}

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
		const singular = k.endsWith("s") ? k.slice(0, -1) : k;
		return BUILTIN_SUFFIXES.some((s) => k.endsWith(s) || singular.endsWith(s));
	}
}

/** Return a copy of value with secret string values (by key name or by shape) replaced by the marker. */
export function redactSecrets(value: Json, matcher: SecretMatcher): Json {
	if (Array.isArray(value)) return value.map((v) => (typeof v === "string" && isSecretValue(v) ? SECRET_MARKER : redactSecrets(v, matcher)));
	if (value !== null && typeof value === "object") {
		const out: { [key: string]: Json } = {};
		for (const [key, v] of Object.entries(value)) {
			const secret = typeof v === "string" && v !== SECRET_MARKER && (matcher.isSecretKey(key) || isSecretValue(v));
			out[key] = secret || v === SECRET_MARKER ? SECRET_MARKER : redactSecrets(v, matcher);
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
