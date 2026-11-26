/**
 * Glue between the engine's interfaces and the running Obsidian app.
 * Everything that touches undocumented app internals lives here, behind feature
 * checks, so a change in Obsidian degrades to "reload to apply" instead of a crash.
 */

import { requestUrl, type App, type DataAdapter } from "obsidian";
import type { Cipher, KeyValue } from "./core/token";
import type { Fs, Host, Http } from "./io";
import type { DiskFs } from "./remote/folder";

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

/** App-wide storage: window.localStorage is shared by every vault of this Obsidian. */
export const appStorage: KeyValue = {
	get: (k) => window.localStorage.getItem(k),
	set: (k, v) => (v === null ? window.localStorage.removeItem(k) : window.localStorage.setItem(k, v)),
};

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plain: string): { toString(encoding: string): string };
	decryptString(data: unknown): string;
}

/**
 * Electron's safeStorage, the system keychain Obsidian itself encrypts secrets
 * with. Internal: null when it is missing (mobile, a future Obsidian), and the
 * token then stays in the vault's secret storage.
 */
export function systemCipher(): Cipher | null {
	const w = window as unknown as { electron?: { remote?: { safeStorage?: SafeStorage } } };
	const ss = w.electron?.remote?.safeStorage;
	const B = (globalThis as unknown as { Buffer?: { from(data: string, encoding: string): unknown } }).Buffer;
	if (!ss || typeof ss.encryptString !== "function" || typeof ss.decryptString !== "function" || !B) return null;
	return {
		available: () => ss.isEncryptionAvailable(),
		encrypt: (plain) => ss.encryptString(plain).toString("base64"),
		decrypt: (data) => ss.decryptString(B.from(data, "base64")),
	};
}

/** Node's fs/promises; desktop only. */
export function nodeDisk(): DiskFs {
	const req = (window as unknown as { require?: (m: string) => unknown }).require;
	const fs = req?.("fs") as { promises?: DiskFs } | undefined;
	if (!fs?.promises) throw new Error("A profile folder needs the desktop app.");
	return fs.promises;
}

export function reloadApp(app: App): void {
	const ok = internals(app).commands?.executeCommandById?.("app:reload");
	if (!ok) window.location.reload();
}
