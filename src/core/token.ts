/**
 * Where the GitHub token lives.
 *
 * Obsidian's secret storage is per vault, so with it alone the token has to be
 * pasted into every vault. When the system keychain can encrypt (Keychain on
 * macOS, DPAPI on Windows, libsecret on Linux), one encrypted copy is kept for the
 * whole computer in app-wide storage instead, the same way Obsidian protects its
 * own secrets. Without encryption the token stays in the vault's secret storage:
 * a clear-text copy is never written to app-wide storage.
 */

/** App-wide string storage (window.localStorage in Obsidian). */
export interface KeyValue {
	get(key: string): string | null;
	set(key: string, value: string | null): void;
}

/** System encryption; strings in, base64 out. */
export interface Cipher {
	available(): boolean;
	encrypt(plain: string): string;
	decrypt(data: string): string;
}

/** The token slot in this vault's secret storage; an empty string means none. */
export interface VaultSecret {
	get(): string | null;
	set(value: string): void;
}

export const MACHINE_TOKEN_KEY = "vault-profile-sync:token";

export class TokenStore {
	constructor(
		private readonly machine: KeyValue,
		private readonly cipher: Cipher | null,
		private readonly vault: VaultSecret,
	) {}

	/** True when the token is kept once for every vault on this computer. */
	shared(): boolean {
		try {
			return !!this.cipher?.available();
		} catch {
			return false;
		}
	}

	get(): string | null {
		return this.readMachine() ?? (this.vault.get() || null);
	}

	set(token: string): void {
		const value = token.trim();
		if (!value) return;
		if (this.shared()) {
			this.machine.set(MACHINE_TOKEN_KEY, JSON.stringify({ v: 1, data: this.cipher!.encrypt(value) }));
			// A second copy in the vault would outlive a token change made in another vault.
			if (this.vault.get()) this.vault.set("");
		} else {
			this.vault.set(value);
		}
	}

	/** Remove the token from this computer and from this vault. */
	forget(): void {
		this.machine.set(MACHINE_TOKEN_KEY, null);
		if (this.vault.get()) this.vault.set("");
	}

	/** Move a token saved per vault by an earlier version into the shared copy. */
	migrate(): void {
		if (!this.shared() || this.readMachine()) return;
		const own = this.vault.get();
		if (own) this.set(own);
	}

	private readMachine(): string | null {
		const raw = this.machine.get(MACHINE_TOKEN_KEY);
		if (!raw || !this.shared()) return null;
		try {
			const parsed = JSON.parse(raw) as { v?: unknown; data?: unknown };
			if (parsed.v !== 1 || typeof parsed.data !== "string") return null;
			return this.cipher!.decrypt(parsed.data) || null;
		} catch {
			// Encrypted by another user or computer, or the keychain entry was reset.
			return null;
		}
	}
}
