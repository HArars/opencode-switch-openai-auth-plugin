# Changelog

## 0.2.0

- Replace refresh-token-hash record IDs with stable IDs and user/workspace-aware identity matching.
- Capture native refreshed tokens when listing accounts and before login/switch; preserve original save/usage metadata.
- Add private, backed-up v1 migration and conservative import of old platform directories.
- Serialize saved-store transactions across processes; use atomic synchronized writes and explicit Unix permissions.
- Preserve corrupted/unsupported stores, reject malformed auth and JSON roots, and support nested/legacy JWT claims.
- Use native auth writes and checked instance disposal; report history/refresh failure separately from successful switching.
- Align XDG paths, SDK 1.19.0, OpenTUI 0.4.5 and Solid 1.9.12; migrate slash registration to keymap.
- Restrict the credential-read workflow to verified directly launched local TUI sessions, rejecting attach/environment-auth overrides.
- Separate login workflow from dialogs; handle cancellation/unload, stale callbacks, same-account re-login and duplicate submissions.
- Rename logout to Remove saved account, display plan/workspace/expiry information, and use Ctrl+y for clipboard copying.
- Add behavioral, cross-process, OpenTUI rendering/input, and isolated installed-host smoke tests.
- Stage clean builds before replacing dist so stale native/parser resources do not enter the package.

- Check native session statuses before switching/login so background busy/retrying sessions cannot be bypassed from the home screen.
- Propagate switch cancellation through queued store transactions and native auth requests.
- Allow live smoke tests to target a specific executable without changing the installed host.

Compatibility now targets OpenCode 1.18.33–1.19.x. Version 0.1.x's broad 1.x declaration is no longer used.
