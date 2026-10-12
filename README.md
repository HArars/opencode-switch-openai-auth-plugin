# opencode-switch-openai-auth-plugin

Switch saved OpenAI OAuth accounts from OpenCode with one command:

```text
/switch
```

Version 0.2 uses stable account IDs, preserves refreshed credentials, and migrates the old account store automatically.

## Compatibility

- OpenCode `1.18.33 <= version < 1.20.0`.
- OpenTUI 0.4.5 and Solid 1.9.12, shared with the host.
- Local interactive `opencode` sessions. `opencode attach` is intentionally unsupported because this OpenCode API does not expose remote credential reads.
- A writable project directory is required for a short-lived local filesystem check.
- `OPENCODE_AUTH_CONTENT` must be unset. Environment-injected credentials cannot be switched by updating the disk store.

The source, built, and unpacked-package entrypoints have been exercised with OpenCode 1.19.0 on Linux. macOS/Windows and live browser/device authorization still need platform/account testing.

## Installation

This checkout contains the 0.2.0 implementation and an optional local tarball; producing the tarball does not publish a registry release. Until 0.2.0 is published, build this checkout and use the local entry described under Development. The registry command below installs the available published version.

```bash
opencode plugin @harars/opencode-switch-openai-auth-plugin
```

Use `opencode plugin -g` for a global installation. Once published, existing 0.1.x users should update the installed package to 0.2.0.

## Usage

Open `/switch` and select an action:

- **Sign in with OpenAI** uses OpenCode's native browser/device OAuth flow. Successful login changes the active OpenAI account and saves it.
- **Select an account** switches native OpenAI credentials, captures the outgoing account's latest tokens, and refreshes OpenCode.
- **Remove saved account** removes that saved record after confirmation. It keeps the active login intact.

The picker displays email, plan, workspace and the current account. An expired access token is retained: OpenCode can refresh it when used.

Switching and login query all session statuses in the current OpenCode instance and wait for busy/retrying responses to finish. Credentials are shared with other local OpenCode instances, so avoid switching while another window is generating a response.

Press **Escape** to close a dialog. **Ctrl+y** copies the authorization link or device code without intercepting normal authorization-code input. Closing a dialog cancels further plugin actions, including switches waiting for the store lock and pending native requests. A credential write or OAuth callback already accepted by OpenCode may still change the native login.

If a native write succeeds but refreshing OpenCode fails, the plugin reports the partial success and asks you to restart. A saved-account history error is also reported separately from the actual credential switch.

## Storage and upgrade

The store is separate from OpenCode's active `auth.json`:

```text
$XDG_DATA_HOME/opencode/auth-switch/accounts.json
```

Without `XDG_DATA_HOME`, OpenCode's XDG resolver defaults to `~/.local/share/opencode` on all platforms. The plugin uses the same resolver. `OPENCODE_TEST_HOME` does not independently redirect the data directory.

On first access to a v1 store:

1. The plugin creates a private, byte-for-byte `accounts.v1-backup.<id>.json`.
2. It migrates to v2 stable record IDs and deduplicates only accounts with matching user/workspace identity.
3. Invalid legacy records remain recoverable in the backup. Expired tokens are retained.

If the new directory has no store, the plugin can import the old macOS `Library/Application Support` or Windows `LOCALAPPDATA` / `APPDATA` store. Multiple legacy candidates require manual selection; originals are not deleted.

A malformed, empty, or unsupported-version store is preserved and blocks writes. Back up the current files before restoring a known-good copy. Never edit the store while OpenCode instances are using it. Migration backups contain credentials too.

Unix directories/files are restricted to `0700` / `0600`. Windows uses the directory's inherited ACLs; chmod is not an ACL guarantee. Writes use a cross-process lock, same-directory temporary file, synchronization, and atomic replacement. Stale locks from a crashed process are reclaimed automatically.

This plugin manages OpenCode OAuth credentials. It does not manage Codex CLI credentials or share token refresh ownership with Codex.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

The check runs type checking, behavioral tests, OpenTUI rendering tests, and the build. Tests use fake credentials and temporary directories.

For a local source entry, add to your project's `.opencode/tui.json`:

```json
{
  "plugin": ["file:///absolute/path/to/switch-auth-plugin/src/tui.tsx"],
  "plugin_enabled": { "harars.switch-auth": true }
}
```

With `opencode` and `tmux` installed, run the live smoke test:

```bash
bun run test:live
# Or check a specific downloaded host without replacing your installation:
bun run test:live /absolute/path/to/opencode
```

It opens isolated source, built, and unpacked-package TUI sessions with fake accounts. It checks native switching, removal confirmation, preservation of the active login and unrelated providers, and leaves screen captures as text in its reported temporary directory. The unpacked package uses the dependency graph from the project lockfile; this is not a separate registry installation. It does not perform a real OAuth login.

Latest upstream review: [latest_source_review_2026-10-12.md](latest_source_review_2026-10-12.md).

See [DESIGN.md](DESIGN.md) for the current storage and lifecycle contract and [CHANGELOG.md](CHANGELOG.md) for changes.
