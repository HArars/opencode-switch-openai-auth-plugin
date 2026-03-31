# opencode-switch-openai-auth-plugin

OpenCode TUI plugin for saving and switching between multiple OpenAI OAuth accounts with a single `/switch` command.

## Features

- one `/switch` command for login, switch, and remove
- reuses the native OpenCode OpenAI OAuth flow
- stores saved accounts in a plugin-owned JSON file
- switches only `auth.json.openai` when you pick an account
- keeps saved-account removal separate from active auth
- supports multiple credentials for the same email by keying entries from the refresh token hash

## Behavior

The `/switch` dialog can show:

- `login`
- saved accounts
- `logout`

Saved accounts are displayed with:

- title: email, or account id, or generated fallback key
- footer: `Current` for the active credential

`login` behavior:

- calls the native OpenCode provider auth flow for `openai`
- rereads the active OpenAI auth after OAuth completes
- saves that credential into `auth-switch/accounts.json`

`switch` behavior:

- writes the selected saved credential into `auth.json.openai`
- refreshes host auth state when runtime support is available

`logout` behavior:

- removes a saved credential from the plugin store
- does not delete the currently active OpenAI auth from `auth.json`

## Storage

Plugin account store locations:

- Linux: `~/.local/share/opencode/auth-switch/accounts.json`
- macOS: `~/Library/Application Support/opencode/auth-switch/accounts.json`
- Windows: `%LOCALAPPDATA%/opencode/auth-switch/accounts.json`

`OPENCODE_TEST_HOME` is supported for tests.

## Local Development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun test
bunx tsc -p tsconfig.json --noEmit
```

## Loading The Plugin

After publishing to npm, add the package name directly to your OpenCode `tui.json`.

Example:

```json
{
  "plugin": [
    "@harars/opencode-switch-openai-auth-plugin"
  ],
  "plugin_enabled": {
    "harars.switch-auth": true
  }
}
```

This package is published as source files so OpenCode can load the TUI entry directly from the installed package.

For local development, you can still point `tui.json` at a local file path.

Example local file setup:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-switch-openai-auth-plugin/src/tui.tsx"
  ],
  "plugin_enabled": {
    "harars.switch-auth": true
  }
}
```

## Package

- package name: `@harars/opencode-switch-openai-auth-plugin`
- plugin id: `harars.switch-auth`
- license: MIT
