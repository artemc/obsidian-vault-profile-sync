/** Human-readable names and one-line descriptions of changes. */

import type { Change, Direction } from "../core/classify";
import { splitKey, type SnapItem } from "../core/model";
import { has, t } from "./i18n";

export function itemLabel(key: string): string {
	if (has(key)) return t(key);
	const { kind, name } = splitKey(key);
	switch (kind) {
		case "plugin":
			return t("labelPlugin", { name });
		case "plugin-data":
			return t("labelPluginData", { name });
		case "snippet":
			return t("labelSnippet", { name });
		case "theme":
			return t("labelTheme", { name });
		case "settings":
			return t("labelSettings");
		default:
			return t("labelConfig", { name });
	}
}

function version(item: SnapItem | null): string | undefined {
	return item?.plugin?.version ?? item?.theme?.version;
}

/** What happens to the target side: `from` is what it has now, `to` what it gets. */
function entryDetail(from: SnapItem | null, to: SnapItem | null): string {
	const parts: string[] = [];
	const vf = version(from);
	const vt = version(to);
	if (!to) parts.push(t("uninstall"));
	else if (!from) parts.push(t("install", { v: vt ?? "" }));
	else if (vf !== vt) parts.push(`${vf} → ${vt}`);
	if (from?.plugin && to?.plugin && from.plugin.enabled !== to.plugin.enabled) parts.push(to.plugin.enabled ? t("enable") : t("disable"));
	if (!from && to?.plugin && !to.plugin.enabled) parts.push(t("disable"));
	return parts.join(", ");
}

/** Short name of an item inside its group of the two-panel view. */
export function shortName(key: string): string {
	const { kind, name } = splitKey(key);
	switch (kind) {
		case "plugin-data":
			return t("pluginSettings");
		case "snippet":
			return `${name}.css`;
		case "settings":
			return t("labelSettings");
		default:
			return name;
	}
}

export function itemVersion(item: SnapItem | null): string | undefined {
	return version(item);
}

/** What applying `dir` does, said about the side that changes. */
export function actionDetail(change: Change, dir: Direction): string {
	const { kind } = splitKey(change.key);
	const isEntry = kind === "plugin" || kind === "theme";
	const { local, remote } = change;
	if (dir === "pull") {
		const action = !remote ? t("doRemoveVault") : !local ? t("doAddVault") : t("doReplaceVault");
		const extra = isEntry ? entryDetail(local, remote) : "";
		return extra ? `${action}: ${extra}` : action;
	}
	if (dir === "push") {
		const action = !local ? t("doRemoveRemote") : !remote ? t("doAddRemote") : t("doReplaceRemote");
		const extra = isEntry ? entryDetail(remote, local) : "";
		return extra ? `${action}: ${extra}` : action;
	}
	if (dir === "merge") return t("doMerge");
	return t("doSkip");
}
