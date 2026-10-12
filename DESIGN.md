# Account switching design, v0.2

## Ownership

OpenCode owns OAuth authorization, native active credentials, token refresh, provider lifecycle, and sockets. The plugin owns saved snapshots and the account picker. It does not implement OpenAI endpoints or add credentials to model-visible tools/messages.

- `parse.ts`: defensive claim parsing, schema validation, identity comparison.
- `files.ts`: private files, crash-safe replacement, cross-process lock.
- `store.ts`: versioned records, migration, deduplication, outgoing-token capture.
- `host.ts`: local-host verification, native auth writes, checked instance disposal.
- `login-flow.ts`: the UI-independent OAuth workflow.
- `login.tsx`: cancellable dialogs and submission guards.
- `operation.ts`: per-operation cancellation linked to plugin lifecycle.
- `tui.tsx`: keymap registration and the single `/switch` workflow.

## Record identity

The v2 store retains a provider-keyed shape:

```typescript
type StoreFile = {
  version: 2
  openai: Record<string, {
    key: string                 // Stable random record ID, not a token hash
    identity: {
      issuer: string
      userId?: string
      accountId?: string       // Workspace identity, not necessarily one person
      email?: string
    }
    email?: string
    accountId?: string
    plan?: string
    savedAt: number
    updatedAt: number
    lastUsedAt?: number
    auth: OpenAIAuth
  }>
}
```

Matching requires the same issuer and compatible workspace/user metadata. An identical refresh token can match the same saved credential. Across refresh rotation, matching requires both a workspace and a user ID or email. Conflicting user IDs never merge, even with the same email. Missing workspace or user information remains conservative: opaque rotated credentials may produce distinct records instead of guessing their identity.

Claims are metadata, not verified assertions. Authentication still comes exclusively from OpenCode's OAuth flow. Timestamps and auth structure are validated; expired access tokens are not invalid credentials by themselves.

An upsert keeps the stable record ID and earliest savedAt, updates the credential snapshot, and preserves lastUsedAt. Explicit switching updates lastUsedAt. Removed accounts are not automatically re-created by snapshot synchronization.

## Transactions and migration

All reads that can migrate/synchronize and all mutations use the same store lock. The lock is managed by proper-lockfile, with a heartbeat, a 30-second stale threshold, and bounded retries. All plugin instances use the same settings. The directory is canonicalized before resolving its lock location.

Writes create a unique 0600 temporary file in the same directory, sync it, replace the destination, and sync the directory on Unix. Permission tightening applies to existing files too. Symlinked final store/auth files are rejected. This is not a claim that a hostile filesystem or an external program ignoring the lock is transaction-safe.

Migration creates a private exact-byte backup before replacing v1. Valid legacy entries are processed in ascending access expiry so a newer duplicate snapshot wins; this is a local freshness heuristic, not remote validation of a refresh token. A supplied current native credential supersedes that migrated snapshot. Malformed v2 data blocks all writes instead of silently pruning it. Invalid v1 records remain in the backup.

Cross-platform legacy paths are imported only if the target store is absent. Ambiguous legacy candidates fail explicitly. Source files are retained.

## Native credential operations

The 1.18/1.19 API can write native auth, but has no public endpoint to read it. The supported runtime is a directly launched local TUI with inherited OpenCode environment. `attach` and `OPENCODE_AUTH_CONTENT` are rejected. A nonce file in the project verifies that the client/server can read the same filesystem; it is always removed. A read-only project cannot pass this check.

Opening the picker reads the current auth under the saved-store transaction and updates only matching existing records. Before login and before switching away, the outgoing snapshot is captured again. Writes use `client.auth.set`, never a plugin-owned replacement of the whole native auth map.

After a successful switch, lastUsedAt is persisted and `instance.dispose` is called. The native disposal event bootstraps TUI state and releases provider resources. SDK `{ error }` results are checked explicitly. A history/refresh failure after a successful native auth write is partial success, not a failed switch.

The plugin lock cannot prevent native token refresh or another process that ignores it. Switching while other windows are generating is outside the guaranteed workflow; both the visible session and a fresh native session-status map are checked for busy/retry state, including background sessions in the current instance. This status check and the native write are separate operations; other instances/projects are not covered. Remote support needs a server-side saved-store/read contract before extending the current environment check.

## Login and dialog lifecycle

Login methods come from `provider.auth`; OAuth filtering preserves their original native indexes. Prompt conditions are applied before authorization. The native callback writes active auth once. The plugin then reads and saves it before requesting native disposal. Re-login with the same refresh token is permitted.

Each `/switch` interaction has one Operation linked to the host lifecycle signal. Closing an unanswered dialog aborts it. Internal replacements are distinguished from external dialog changes, and a native confirmation's synchronous automatic clear is allowed after an accepted answer. Cleanup clears only a dialog the operation still owns. Loading cancellation, OAuth cancellation, unrelated host dialogs, stale completions, and duplicate code submission are covered by UI tests.

Cancellation stops further plugin actions, checks again after acquiring the store lock and reading outgoing auth, and reaches the native auth request and OAuth HTTP waiting. It cannot undo a credential write or callback the server already accepted. Normal code-input characters are preserved; clipboard copying uses Ctrl+y. SDK payloads are never serialized into toasts.

## Validation

Behavioral tests cover migration, identity separation, rotation, corruption preservation, Unix permissions, stale locks, independent processes, SDK errors, and partial success. OpenTUI tests mount real rendering/input contexts with an injected fake host/store. `test:live` additionally loads source, built and unpacked npm artifacts in an installed OpenCode TUI with isolated XDG directories and fake accounts. It checks native switch/refresh and native removal confirmation. The unpacked package uses the project lockfile's existing dependency graph.

Real OAuth, remote mode, shared in-flight response switching, and macOS/Windows runtime behavior require their own environments; this design does not assert those were exercised.
