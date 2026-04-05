# opencode-switch-openai-auth-plugin

<img width="1107" height="525" alt="screenshot" src="https://github.com/user-attachments/assets/511a6118-e470-4955-b5a0-c8d9672d060b" />

OpenCode TUI plugin for switching between saved OpenAI OAuth accounts with a single `/switch` command.

## Features

- one `/switch` command for login, switching, and removal
- uses the native OpenCode OpenAI OAuth flow
- supports multiple saved accounts
- marks the current account in the picker
- keeps saved-account removal separate from the active session

## Installation

Install the plugin with the OpenCode plugin command:

```bash
opencode plugin @harars/opencode-switch-openai-auth-plugin
```

## Usage

Run the command below in OpenCode:

```text
/switch
```

From there you can:

- sign in with another OpenAI account
- switch to a saved account
- remove a saved account

## Storage

Saved accounts are stored in a plugin-managed JSON file:

- Linux: `~/.local/share/opencode/auth-switch/accounts.json`
- macOS: `~/Library/Application Support/opencode/auth-switch/accounts.json`
- Windows: `%LOCALAPPDATA%/opencode/auth-switch/accounts.json`

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

Build the package output:

```bash
bun run build
```

For local development, point your workspace `tui.json` at the local source entry:

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
- license: MIT
