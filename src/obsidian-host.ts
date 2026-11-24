/**
 * Glue between the engine's interfaces and the running Obsidian app.
 * Everything that touches undocumented app internals lives here, behind feature
 * checks, so a change in Obsidian degrades to "reload to apply" instead of a crash.
 */

import { requestUrl, type App, type DataAdapter } from "obsidian";
import type { Fs, Host, Http } from "./io";

interface PluginManager {
	plugins?: Record<string, unknown>;
	disablePlugin?: (id: string) => Promise<void>;
}

interface CommandManager {
	executeCommandById?: (id: string) => boolean;
}

function internals(app: App): { plugins?: PluginManager; commands?: CommandManager } {
	return app as unknown as { plugins?: PluginManager; commands?: CommandManager };
}

export function adapterFs(adapter: DataAdapter): Fs {
	return {
		exists: (p) => adapter.exists(p),
		read: (p) => adapter.read(p),
		write: (p, d) => adapter.write(p, d),
		readBinary: (p) => adapter.readBinary(p),
		writeBinary: (p, d) => adapter.writeBinary(p, d),
		list: (p) => adapter.list(p),
		remove: (p) => adapter.remove(p),
		rmdir: (p, r) => adapter.rmdir(p, r),
		mkdir: (p) => adapter.mkdir(p),
	};
}

export const obsidianHttp: Http = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		contentType: req.contentType,
		throw: false,
	});
	let text = "";
	try {
		text = res.text;
	} catch {
		// binary body
	}
	return { status: res.status, text, arrayBuffer: res.arrayBuffer };
};

export function appHost(app: App): Host {
	return {
		isPluginLoaded: (id) => !!internals(app).plugins?.plugins?.[id],
		disablePlugin: async (id) => {
			const pm = internals(app).plugins;
			if (typeof pm?.disablePlugin === "function") await pm.disablePlugin(id);
		},
	};
}

export function reloadApp(app: App): void {
	const ok = internals(app).commands?.executeCommandById?.("app:reload");
	if (!ok) window.location.reload();
}
