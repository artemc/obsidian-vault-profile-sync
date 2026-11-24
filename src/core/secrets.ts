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

/** Keys of `a` that `b` also lists, compared the way the matcher compares them. */
export function commonKeys(a: string[], b: string[]): string[] {
	const other = keySet(b);
	return a.filter((k) => other.has(normalizeKey(k)));
}

function keySet(keys: string[]): Set<string> {
	return new Set(keys.map(normalizeKey).filter((k) => k.length > 0));
}

export class SecretMatcher {
	private readonly extra: Set<string>;
	private readonly plain: Set<string>;

	/**
	 * `plainKeys` turn off the key-name rule for those names. Values shaped like
	 * credentials (see SECRET_VALUES) are removed whatever the key is called.
	 */
	constructor(extraKeys: string[] = [], plainKeys: string[] = []) {
		this.extra = keySet(extraKeys);
		this.plain = keySet(plainKeys);
	}

	isSecretKey(key: string): boolean {
		const k = normalizeKey(key);
		if (k.length === 0) return false;
		if (this.extra.has(k)) return true;
		if (this.plain.has(k)) return false;
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
 *
 * The result must scan back to incoming (`redactSecrets(restoreSecrets(x)) == x`),
 * otherwise the pulled item shows up as an outgoing change and the next push
 * overwrites the profile's secret. So a marker becomes:
 * - the local value, if the matcher will hide it again (secret key name or
 *   credential-shaped value);
 * - an empty string, if there is no such value and the key name is secret;
 * - otherwise the marker itself: the secret was recognised by its shape, and
 *   neither an empty string nor a harmless local value would be hidden again.
 */
export function restoreSecrets(incoming: Json, local: Json | undefined, matcher: SecretMatcher): Json {
	return restore(incoming, local, matcher, null);
}

function restore(incoming: Json, local: Json | undefined, matcher: SecretMatcher, key: string | null): Json {
	if (incoming === SECRET_MARKER) {
		const byName = key !== null && matcher.isSecretKey(key);
		if (typeof local === "string" && (byName || isSecretValue(local))) return local;
		return byName ? "" : SECRET_MARKER;
	}
	if (Array.isArray(incoming)) {
		const localArr = Array.isArray(local) ? local : [];
		return incoming.map((v, i) => restore(v, localArr[i], matcher, null));
	}
	if (incoming !== null && typeof incoming === "object") {
		const localObj = local !== null && typeof local === "object" && !Array.isArray(local) ? local : {};
		const out: { [key: string]: Json } = {};
		for (const [k, v] of Object.entries(incoming)) out[k] = restore(v, localObj[k], matcher, k);
		return out;
	}
	return incoming;
}
