/** Human-readable names and one-line descriptions of changes. */

import { incomingAction, outgoingAction, type Change } from "../core/classify";
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

export function changeDetail(change: Change, direction: "in" | "out" | "conflict"): string {
	const { kind } = splitKey(change.key);
	const isEntry = kind === "plugin" || kind === "theme";
	if (direction === "conflict") {
		const extra = isEntry ? `: ${version(change.local) ?? t("absent")} / ${version(change.remote) ?? t("absent")}` : "";
		return t("actConflict") + extra;
	}
	if (direction === "in") {
		const action = { add: t("actAddIn"), remove: t("actRemoveIn"), modify: t("actModifyIn") }[incomingAction(change)];
		const extra = isEntry ? entryDetail(change.local, change.remote) : "";
		return extra ? `${action}: ${extra}` : action;
	}
	const action = { add: t("actAddOut"), remove: t("actRemoveOut"), modify: t("actModifyOut") }[outgoingAction(change)];
	const extra = isEntry ? entryDetail(change.remote, change.local) : "";
	return extra ? `${action}: ${extra}` : action;
}
