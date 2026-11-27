/**
 * Three-way comparison of the vault (L), the profile (R) and this vault's base (B),
 * the state both sides agreed on at the last pull or push. A missing item has the
 * hash null, and so does a key the base has never seen.
 *
 *   L == R             same      (base is moved to L)
 *   L == B, R != B     incoming  (changed, added or removed in the profile)
 *   R == B, L != B     outgoing  (changed, added or removed in this vault)
 *   otherwise          conflict
 *
 * Because a removal is just another change against the base, a plugin removed in
 * one vault is removed from the others on pull, and a vault that has not touched
 * it since its base cannot bring it back on push.
 */

import type { SnapItem, Snapshot } from "./model";

export type Status = "same" | "incoming" | "outgoing" | "conflict";

export type ChangeAction = "add" | "remove" | "modify";

export interface Change {
	key: string;
	status: Status;
	local: SnapItem | null;
	remote: SnapItem | null;
	base: string | null;
}

export type Base = Record<string, string>;

export interface Classification {
	incoming: Change[];
	outgoing: Change[];
	conflicts: Change[];
	same: Change[];
	/** Base after recording every item both sides already agree on. */
	settledBase: Base;
}

export function classifyOne(l: string | null, r: string | null, b: string | null): Status {
	if (l === r) return "same";
	if (l === b) return "incoming";
	if (r === b) return "outgoing";
	return "conflict";
}

export function classify(local: Snapshot, remote: Snapshot, base: Base): Classification {
	const keys = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
	const result: Classification = { incoming: [], outgoing: [], conflicts: [], same: [], settledBase: { ...base } };
	for (const key of [...keys].sort()) {
		const l = local.get(key) ?? null;
		const r = remote.get(key) ?? null;
		const b = base[key] ?? null;
		const status = classifyOne(l?.hash ?? null, r?.hash ?? null, b);
		const change: Change = { key, status, local: l, remote: r, base: b };
		switch (status) {
			case "same":
				if (l) result.settledBase[key] = l.hash;
				else delete result.settledBase[key];
				if (l) result.same.push(change);
				break;
			case "incoming":
				result.incoming.push(change);
				break;
			case "outgoing":
				result.outgoing.push(change);
				break;
			case "conflict":
				result.conflicts.push(change);
				break;
		}
	}
	return result;
}

/** What applying the change does to the side it is applied to. */
export function incomingAction(c: Change): ChangeAction {
	if (!c.remote) return "remove";
	if (!c.local) return "add";
	return "modify";
}

export function outgoingAction(c: Change): ChangeAction {
	if (!c.local) return "remove";
	if (!c.remote) return "add";
	return "modify";
}

/**
 * How one side of an item differs from the base, for the two-panel view.
 * When both sides have the item, they disagree and the base has never seen it (a vault
 * that has not synced yet), both are `edited`: it is unknown which one is newer.
 */
export type SideState = "same" | "edited" | "added" | "removed" | "absent";

export function sideStates(c: Change): { local: SideState; remote: SideState } {
	const l = c.local?.hash ?? null;
	const r = c.remote?.hash ?? null;
	if (l === r) return { local: "same", remote: "same" };
	if (c.base === null && l !== null && r !== null) return { local: "edited", remote: "edited" };
	const one = (h: string | null): SideState => {
		if (h === c.base) return h === null ? "absent" : "same";
		if (h === null) return "removed";
		return c.base === null ? "added" : "edited";
	};
	return { local: one(l), remote: one(r) };
}

/** Which way an item travels: into this vault, into the profile, merged into both, or not at all. */
export type Direction = "pull" | "push" | "merge" | "skip";

export function defaultDirection(c: Change): Direction {
	switch (c.status) {
		case "incoming":
			return "pull";
		case "outgoing":
			return "push";
		default:
			return "skip";
	}
}
