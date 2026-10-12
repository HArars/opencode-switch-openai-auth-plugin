import path from "node:path"
import { randomUUID } from "node:crypto"
import { atomicWrite, readPrivateFile, withStoreLock } from "./files"
import { clean, entryFromAuth, record, sameAccount, text, timestamp, validAuth } from "./parse"
import { legacyStorePaths, storeDir } from "./paths"
import type { AuthGateway, OpenAIAuth, StoreEntry, StoreFile, StoredAccount } from "./types"

export class StoreError extends Error {
  constructor(message: string) { super(message); this.name = "StoreError" }
}
function validEntry(id: string, value: unknown): value is StoreEntry {
  const item = record(value)
  const who = record(item?.identity)
  return Boolean(item && item.key === id && who && text(who.issuer)
    && [who.userId, who.accountId, who.email, item.email, item.accountId, item.plan]
      .every(field => field === undefined || Boolean(text(field)))
    && timestamp(item.savedAt) && timestamp(item.updatedAt)
    && (item.lastUsedAt === undefined || timestamp(item.lastUsedAt)) && validAuth(item.auth))
}
function upsert(store: StoreFile, auth: OpenAIAuth, create: boolean) {
  const base = entryFromAuth(auth)
  const matches = Object.values(store.openai).filter(item => sameAccount(item, base))
  const previous = matches[0]
  if (!previous && !create) return undefined
  const next = previous ? {
    ...base, key: previous.key,
    identity: { ...base.identity, userId: base.identity.userId ?? previous.identity.userId,
      accountId: base.identity.accountId ?? previous.identity.accountId,
      email: base.identity.email ?? previous.identity.email },
    email: base.email ?? previous.email, accountId: base.accountId ?? previous.accountId,
    plan: base.plan ?? previous.plan,
    savedAt: Math.min(...matches.map(item => item.savedAt)),
    lastUsedAt: Math.max(...matches.map(item => item.lastUsedAt ?? 0)) || undefined,
  } : base
  for (const match of matches) delete store.openai[match.key]
  store.openai[next.key] = next
  return next.key
}
function migrate(map: Record<string, unknown>) {
  const store: StoreFile = { version: 2, openai: {} }
  let skipped = 0
  // Expiry is a freshness hint only for choosing between duplicate legacy snapshots.
  const entries = Object.values(map).map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    .sort((a, b) => {
      const left = record(a.auth)?.expires
      const right = record(b.auth)?.expires
      return (timestamp(left) ? left : 0) - (timestamp(right) ? right : 0)
    })
  for (const item of entries) {
    if (!validAuth(item.auth)) { skipped += 1; continue }
    const id = upsert(store, item.auth, true)!
    const entry = store.openai[id]!
    entry.email ??= text(item.email)
    entry.accountId ??= text(item.accountId)
    entry.plan ??= text(item.plan)
    entry.identity.email ??= entry.email?.toLowerCase()
    entry.identity.accountId ??= entry.accountId
    entry.savedAt = Math.min(entry.savedAt, timestamp(item.savedAt) ? item.savedAt : entry.savedAt)
    entry.lastUsedAt = Math.max(entry.lastUsedAt ?? 0, timestamp(item.lastUsedAt) ? item.lastUsedAt : 0) || undefined
  }
  return { store, skipped: skipped + Object.values(map).filter(item => !record(item)).length }
}
export class AccountStore {
  readonly file: string
  constructor(readonly directory = storeDir(), readonly legacyFiles: string[] = legacyStorePaths()) {
    this.file = path.join(directory, "accounts.json")
  }
  private async load(assertOwned: () => void): Promise<{ store: StoreFile; warnings: string[] }> {
    let source = this.file
    let raw = await readPrivateFile(source)
    if (raw === undefined) {
      const found: Array<{ file: string; raw: string }> = []
      for (const file of this.legacyFiles) {
        const content = await readPrivateFile(file)
        if (content !== undefined) found.push({ file, raw: content })
      }
      if (found.length > 1) throw new StoreError("Multiple legacy account stores found; choose one to migrate manually")
      if (found[0]) { source = found[0].file; raw = found[0].raw }
    }
    if (raw === undefined) return { store: { version: 2, openai: {} }, warnings: [] }
    let root: Record<string, unknown> | undefined
    try { root = record(JSON.parse(raw)) } catch { /* Preserve the original bytes. */ }
    const map = record(root?.openai)
    if (!root || !map || (root.version !== 1 && root.version !== 2)) {
      throw new StoreError("Account store is malformed or has an unsupported version; the original file was preserved")
    }
    if (root.version === 2) {
      if (!Object.entries(map).every(([id, item]) => validEntry(id, item))) {
        throw new StoreError("Account store contains invalid records; the original file was preserved")
      }
      const store = root as unknown as StoreFile
      if (source !== this.file) {
        assertOwned()
        await atomicWrite(path.join(this.directory, `accounts.import-backup.${randomUUID()}.json`), raw)
        await this.persist(store, assertOwned)
      }
      return { store, warnings: [] }
    }
    const migrated = migrate(map)
    assertOwned()
    const backup = `accounts.v1-backup.${randomUUID()}.json`
    await atomicWrite(path.join(this.directory, backup), raw)
    await this.persist(migrated.store, assertOwned)
    return { store: migrated.store, warnings: [
      `Saved accounts upgraded to v2. Original data backed up as ${backup}.`,
      ...(migrated.skipped ? [`${migrated.skipped} invalid legacy record(s) were retained in the backup.`] : []),
    ] }
  }
  private async persist(store: StoreFile, assertOwned: () => void) {
    assertOwned()
    await atomicWrite(this.file, `${JSON.stringify(store, null, 2)}\n`)
  }
  async list(active?: OpenAIAuth | (() => Promise<OpenAIAuth | undefined>)) {
    return withStoreLock(this.directory, async assertOwned => {
      const { store, warnings } = await this.load(assertOwned)
      const currentAuth = typeof active === "function" ? await active() : active
      // Update only an existing saved account. Removed records stay removed.
      const current = currentAuth ? upsert(store, currentAuth, false) : undefined
      if (current) await this.persist(store, assertOwned)
      const accounts: StoredAccount[] = Object.values(store.openai).map(item => ({ ...item, id: item.key }))
      accounts.sort((a, b) => Number(b.id === current) - Number(a.id === current)
        || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.savedAt - a.savedAt
        || (a.email ?? a.id).localeCompare(b.email ?? b.id))
      return { accounts, current, warnings }
    })
  }
  async save(auth: OpenAIAuth) {
    clean(auth)
    return withStoreLock(this.directory, async assertOwned => {
      const { store } = await this.load(assertOwned)
      const id = upsert(store, auth, true)!
      await this.persist(store, assertOwned)
      return { ...store.openai[id]!, id }
    })
  }
  async remove(id: string) {
    return withStoreLock(this.directory, async assertOwned => {
      const { store } = await this.load(assertOwned)
      if (!Object.hasOwn(store.openai, id)) throw new StoreError("Saved account no longer exists")
      delete store.openai[id]
      await this.persist(store, assertOwned)
    })
  }
  async switch(id: string, gateway: AuthGateway, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await gateway.assertAvailable()
    let applied = false
    try {
      return await withStoreLock(this.directory, async assertOwned => {
        signal?.throwIfAborted()
        const { store } = await this.load(assertOwned)
        if (!Object.hasOwn(store.openai, id)) throw new StoreError("Saved account no longer exists")
        const current = await gateway.read()
        signal?.throwIfAborted()
        if (current && upsert(store, current, false)) await this.persist(store, assertOwned)
        const target = store.openai[id]
        if (!target) throw new StoreError("Account list changed; reopen /switch")
        assertOwned()
        signal?.throwIfAborted()
        await gateway.set(clean(target.auth), signal)
        applied = true
        target.lastUsedAt = Date.now()
        await this.persist(store, assertOwned)
        return { historySaved: true }
      })
    } catch (error) {
      // The native auth write may have succeeded before persistence/lock release failed.
      if (applied) return { historySaved: false }
      throw error
    }
  }
}
