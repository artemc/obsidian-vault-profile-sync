# Vault Profile Sync

Keep one **settings profile** for many Obsidian vaults in a GitHub repository:
community plugins (with their versions), plugin settings, hotkeys, CSS snippets,
themes and Obsidian's own settings. In any vault you see what changed, then **Pull**
or **Push**. A new vault is set up by installing this plugin, entering the repository
and pressing Pull.

Built for people who keep many vaults with the same setup (one vault per project) and
are tired of copying `.obsidian` around.

## How it works

- **One copy of each thing.** The profile on GitHub, the live config folder of each
  vault, and a small *base* per vault: what that vault and the profile agreed on at the
  last pull or push. There is no staging area and no second copy inside the vault.
- **Three-way comparison.** Every item is compared in three versions: this vault, the
  profile and the base. That tells *who* changed it:

  | This vault vs base | Profile vs base | Result |
  |---|---|---|
  | same | changed | **incoming**: pull applies it here |
  | changed | same | **outgoing**: push sends it to the profile |
  | changed | changed (differently) | **conflict**: you choose |

  A removal is just another change. Remove a plugin in one vault and push: the other
  vaults see an incoming removal. A vault that has not pulled yet cannot bring the
  plugin back, because for that vault the plugin is not an outgoing change.
- **Plugin code is not stored.** The profile records each plugin's id, version and
  whether it is enabled. On pull the exact version is downloaded from the plugin's
  GitHub release and installed byte for byte the way Obsidian's own installer does it. Plugins that are not in the
  community catalog (BRAT betas, your own) are stored in the profile under `vendor/`.
- **Secrets stay home.** String values of keys that look like credentials (`token`,
  `password`, `apiKey`, `clientSecret`, their plurals, ...) and values that look like
  credentials whatever the key (URLs with a password such as `socks5://user:pass@host`,
  `ghp_…`, `github_pat_…`, `sk-…` tokens) are replaced with `<vps:secret>` before
  pushing. On pull each vault keeps its own value.
- **Every pull can be undone.** Before a pull the files it touches are backed up (the
  last 5 are kept). *Undo last pull* restores them.
- **Nothing happens by itself.** When the vault opens (and every 30 minutes by default)
  the plugin checks the profile and shows a notice and a status-bar counter
  (`Profile ↓3 ↑1`). Changes are applied only when you press a button.

### What is synced

| Item | In the profile |
|---|---|
| Community plugin: version, enabled | `profile.json` |
| Plugin settings (`data.json`) | `plugins/<id>/data.json` |
| Obsidian settings (`app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, core plugin settings, ...) | `config/<file>.json` |
| CSS snippets | `snippets/<name>.css` |
| Themes: name and version | `profile.json` |
| Shared sync settings (exclusions, extra secret keys) | `profile.json` |

Never synced: `workspace.json`, `workspace-mobile.json`, `workspaces.json`,
`bookmarks.json` (they describe one vault), and this plugin itself.
`community-plugins.json` is rebuilt from the profile.

JSON is stored with sorted keys, so a different key order is not a change, and the
history of the repository is a readable log of who changed what.

## Setup

1. Create a **private** GitHub repository for the profile. It may be empty.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   with access to **that repository only** and the permission
   **Contents: Read and write**.
3. Install the plugin. Until it is in the community catalog, use
   [BRAT](https://github.com/TfTHacker/obsidian42-brat) with this repository's URL, or
   copy `main.js`, `manifest.json` and `styles.css` from a release into
   `<vault>/.obsidian/plugins/vault-profile-sync/`.
4. Open *Settings → Vault Profile Sync*, enter the repository (`owner/name`), the
   branch and the token, and press *Check connection*.
5. In the vault whose setup you want to share, open the profile window (ribbon icon,
   status bar or the command *Open settings profile*) and press **Push**.

The repository, branch and folder are remembered on this computer and prefilled in the
next vault. The token lives in Obsidian's secret storage; if your Obsidian keeps it per
vault, paste it once in each new vault. Then open the profile window and press **Take
everything from the profile**. Obsidian reloads, and the vault has the same plugins,
settings, hotkeys and snippets.

## Everyday use

Open the profile window. It lists:

- **Incoming** - changed in the profile; **Pull** applies them and reloads Obsidian.
- **Outgoing** - changed in this vault; **Push** sends them as one commit.
- **Conflicts** - changed on both sides; pick *Keep mine* or *Take profile* for each.

Each row has a **Diff** button (JSON is compared key by key, CSS line by line) and an
eye button that excludes the item in this vault. **Sync all** pushes and then pulls.

If the profile changes on GitHub while you are reviewing, the push is refused and the
comparison is shown again. A push never overwrites what it has not shown you.

### Exclusions

Patterns, one per line:

- `plugin:<id>` - a plugin and its settings;
- `plugin-data:<id>` - only a plugin's settings, for example when they hold
  vault-specific paths;
- `config:<file>.json`, `snippet:<name>`, `theme:<name>`;
- a bare name matches every kind; `*` matches anything.

*This vault only* exclusions keep a plugin local: it is neither pushed nor removed by a
pull. *Shared* exclusions and extra secret keys travel with the profile to every vault.

### Several profiles

Set a **profile folder** (for example `profiles/legal` and `profiles/personal`) to keep
several profiles in one repository. A vault follows one profile at a time.

## Limitations

- Desktop only for now (`isDesktopOnly`); the code avoids Node APIs, so mobile is
  planned, not ruled out.
- Requires Obsidian 1.11.4 or newer (secret storage for the token).
- After a pull Obsidian is reloaded: this is the reliable way to apply plugin, hotkey
  and appearance changes.
- Themes often do not publish a release per version. If the profile's version is not
  published, the current theme version is installed and a warning is shown.
- Plugins that keep extra files in their folder (besides `data.json`) sync only
  `data.json`.

## Development

```bash
npm install
npm test          # unit and multi-vault scenario tests (in-memory vaults and GitHub)
npm run build     # type-check and bundle main.js
npm run dev       # rebuild on change
```

Layout:

- `src/core/` - pure logic, no Obsidian imports: canonical JSON and git blob hashes,
  secret redaction, exclusions, the three-way comparison, diffs;
- `src/engine/` - vault scanning, profile reading, catalog downloads, pull, push and
  backups, written against small interfaces (`src/io.ts`);
- `src/remote/github.ts` - the GitHub REST client;
- `src/ui/` and `src/main.ts` - the Obsidian side.

Releases are built by GitHub Actions when a version tag is pushed (`git tag 0.1.0 &&
git push origin 0.1.0`).

## License

MIT
