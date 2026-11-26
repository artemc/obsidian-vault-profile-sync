/** Where a profile is, as the settings and the list of stores on this machine keep it. */

export type StoreKind = "github" | "folder";

/** Where a profile is; also an entry of the list of stores shared by all vaults. */
export interface StoreRef {
	kind: StoreKind;
	repo: string;
	branch: string;
	folder: string;
	/** Absolute path of the profile folder (kind "folder"). */
	path: string;
}

export function storeLabel(s: StoreRef): string {
	if (s.kind === "folder") return s.path;
	return `${s.repo} · ${s.branch || "main"}${s.folder ? ` · ${s.folder}` : ""}`;
}

export function sameStore(a: StoreRef, b: StoreRef): boolean {
	return storeLabel(a).toLowerCase() === storeLabel(b).toLowerCase();
}

export function hasLocation(s: StoreRef): boolean {
	return s.kind === "folder" ? !!s.path.trim() : !!s.repo.trim();
}
