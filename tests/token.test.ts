import { describe, expect, it } from "vitest";
import { MACHINE_TOKEN_KEY, TokenStore, type Cipher, type KeyValue, type VaultSecret } from "../src/core/token";

/** One computer: app-wide storage and a keychain shared by all vaults. */
class Computer {
	storage = new Map<string, string>();
	encryption = true;
	keychainKey = "k1";
	machine: KeyValue = {
		get: (k) => this.storage.get(k) ?? null,
		set: (k, v) => (v === null ? this.storage.delete(k) : this.storage.set(k, v)),
	};
	cipher: Cipher = {
		available: () => this.encryption,
		encrypt: (s) => btoa(`${this.keychainKey}:${s}`),
		decrypt: (d) => {
			const [key, ...rest] = atob(d).split(":");
			if (key !== this.keychainKey) throw new Error("cannot decrypt");
			return rest.join(":");
		},
	};
	vault(): VaultSecret & { value: string | null } {
		const v = { value: null as string | null, get: () => v.value, set: (s: string) => (v.value = s) };
		return v;
	}
}

describe("token store", () => {
	it("is entered once and seen by every vault on the computer", () => {
		const pc = new Computer();
		const a = new TokenStore(pc.machine, pc.cipher, pc.vault());
		const b = new TokenStore(pc.machine, pc.cipher, pc.vault());
		expect(b.get()).toBeNull();
		a.set("  github_pat_one ");
		expect(b.get()).toBe("github_pat_one");
		expect(pc.storage.get(MACHINE_TOKEN_KEY)).not.toContain("github_pat_one");
		b.set("github_pat_two");
		expect(a.get()).toBe("github_pat_two");
	});

	it("keeps the token per vault when nothing can encrypt it", () => {
		const pc = new Computer();
		pc.encryption = false;
		const va = pc.vault();
		const a = new TokenStore(pc.machine, pc.cipher, va);
		const b = new TokenStore(pc.machine, null, pc.vault());
		a.set("github_pat_one");
		expect(a.shared()).toBe(false);
		expect(va.value).toBe("github_pat_one");
		expect(pc.storage.size).toBe(0);
		expect(b.get()).toBeNull();
	});

	it("moves a token saved per vault into the shared copy", () => {
		const pc = new Computer();
		const va = pc.vault();
		va.value = "github_pat_old";
		const a = new TokenStore(pc.machine, pc.cipher, va);
		a.migrate();
		expect(va.value).toBe("");
		expect(new TokenStore(pc.machine, pc.cipher, pc.vault()).get()).toBe("github_pat_old");
	});

	it("a changed token is not shadowed by an old copy in some vault", () => {
		const pc = new Computer();
		const va = pc.vault();
		va.value = "github_pat_old";
		const a = new TokenStore(pc.machine, pc.cipher, va);
		new TokenStore(pc.machine, pc.cipher, pc.vault()).set("github_pat_new");
		a.migrate();
		expect(a.get()).toBe("github_pat_new");
	});

	it("falls back to the vault's own token when the shared copy cannot be decrypted", () => {
		const pc = new Computer();
		const va = pc.vault();
		const a = new TokenStore(pc.machine, pc.cipher, va);
		a.set("github_pat_one");
		pc.keychainKey = "k2";
		expect(a.get()).toBeNull();
		va.value = "github_pat_vault";
		expect(a.get()).toBe("github_pat_vault");
		a.set("github_pat_new");
		expect(a.get()).toBe("github_pat_new");
	});

	it("forget removes the token from the computer and the vault", () => {
		const pc = new Computer();
		const va = pc.vault();
		const a = new TokenStore(pc.machine, pc.cipher, va);
		a.set("github_pat_one");
		va.value = "github_pat_stale";
		a.forget();
		expect(a.get()).toBeNull();
		expect(pc.storage.has(MACHINE_TOKEN_KEY)).toBe(false);
	});
});
