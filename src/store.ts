import fs from "node:fs/promises"
import path from "node:path"
import type { OpenAIAuth, StoreEntry, StoreFile, StoreLoad, StoredAccount } from "./types"
import { authPath, storeDir, storePath } from "./paths"
import { clean, entryFromAuth, extractAccountId, extractEmail, fallback } from "./parse"

function obj(v: unknown) {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
}

function text(v: unknown) {
  return typeof v === "string" && v.trim() ? v : undefined
}

function num(v: unknown) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

export function validAuth(v: unknown): v is OpenAIAuth {
  const item = obj(v)
  if (!item) return false
  if (item.type !== "oauth") return false
  if (!text(item.refresh) || !text(item.access) || num(item.expires) === undefined) return false
  if (item.accountId !== undefined && !text(item.accountId)) return false
  if (item.enterpriseUrl !== undefined && !text(item.enterpriseUrl)) return false
  return true
}

function validEntry(id: string, v: unknown): v is StoreEntry {
  const item = obj(v)
  if (!item || item.key !== id) return false
  if (item.email !== undefined && !text(item.email)) return false
  if (item.accountId !== undefined && !text(item.accountId)) return false
  if (item.plan !== undefined && !text(item.plan)) return false
  if (num(item.savedAt) === undefined) return false
  if (item.lastUsedAt !== undefined && num(item.lastUsedAt) === undefined) return false
  return validAuth(item.auth)
}

async function readJson(file: string) {
  const data = Bun.file(file)
  if (!(await data.exists())) return
  const raw = (await data.text()).trim()
  if (!raw) return
  return JSON.parse(raw) as unknown
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(storeDir(), { recursive: true })
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
}

function hydrateAccount(id: string, item: StoreEntry): StoredAccount {
  return {
    ...item,
    id,
    email: item.email || extractEmail(item.auth),
    accountId: item.accountId || extractAccountId(item.auth),
  }
}

function normalizeEntries(entries: Record<string, unknown>) {
  const normalized: Record<string, StoreEntry> = {}
  let changed = false

  for (const [id, value] of Object.entries(entries)) {
    if (!validEntry(id, value)) {
      const item = obj(value)
      if (!item || !validAuth(item.auth)) {
        changed = true
        continue
      }
      const auth = clean(item.auth)
      const nextKey = fallback(auth.refresh)
      normalized[nextKey] = {
        key: nextKey,
        email: text(item.email) || extractEmail(auth),
        accountId: text(item.accountId) || extractAccountId(auth),
        plan: text(item.plan),
        savedAt: num(item.savedAt) ?? Date.now(),
        ...(num(item.lastUsedAt) !== undefined ? { lastUsedAt: num(item.lastUsedAt) } : {}),
        auth,
      }
      changed = true
      continue
    }

    const nextKey = fallback(value.auth.refresh)
    if (nextKey !== id || value.key !== nextKey) changed = true
    normalized[nextKey] = {
      ...value,
      key: nextKey,
      auth: clean(value.auth),
    }
  }

  return { normalized, changed }
}

export async function readCurrentAuth() {
  const raw = await readJson(authPath())
  const data = obj(raw)
  if (!data) return
  const auth = data.openai
  if (!validAuth(auth)) return
  return clean(auth)
}

export async function writeCurrentOpenAI(auth: OpenAIAuth) {
  const raw = (await readJson(authPath())) ?? {}
  const next = obj(raw) ?? {}
  next.openai = clean(auth)
  await fs.mkdir(path.dirname(authPath()), { recursive: true })
  await Bun.write(authPath(), `${JSON.stringify(next, null, 2)}\n`)
}

export async function readStore(): Promise<StoreLoad> {
  const raw = await readJson(storePath())
  if (raw === undefined) return { ok: false, reason: "missing" }
  const root = obj(raw)
  const map = obj(root?.openai)
  if (!root || root.version !== 1 || !map) return { ok: false, reason: "malformed" }
  const { normalized, changed } = normalizeEntries(map)
  if (changed) {
    await writeStore({ version: 1, openai: normalized })
  }
  return {
    ok: true,
    store: {
      version: 1,
      openai: normalized,
    },
  }
}

export async function writeStore(store: StoreFile) {
  await writeJson(storePath(), store)
}

export async function readAllAccounts() {
  const load = await readStore()
  if (!load.ok) return load
  return {
    ok: true as const,
    accounts: Object.entries(load.store.openai)
      .filter(([id, item]) => validEntry(id, item))
      .map(([id, item]) => hydrateAccount(id, item)),
  }
}

export async function pruneInvalidAccounts() {
  const load = await readStore()
  if (!load.ok) return load
  const next = Object.fromEntries(Object.entries(load.store.openai).filter(([id, item]) => validEntry(id, item)))
  if (Object.keys(next).length !== Object.keys(load.store.openai).length) {
    await writeStore({ version: 1, openai: next })
  }
  return {
    ok: true as const,
    accounts: Object.entries(next).map(([id, item]) => hydrateAccount(id, item)),
  }
}

export async function currentAccountId() {
  const auth = await readCurrentAuth()
  if (!auth) return
  return fallback(auth.refresh)
}

function match(list: StoredAccount[], auth: OpenAIAuth) {
  return list.find((item) => {
    if (item.auth.refresh === auth.refresh) return true
    return item.id === fallback(auth.refresh)
  })?.id
}

export async function upsertSavedAccount(auth: OpenAIAuth) {
  const base = entryFromAuth(auth)
  const load = await readStore()
  const store = load.ok ? load.store : { version: 1 as const, openai: {} }
  const list = Object.entries(store.openai)
  const match = list.find(([id, item]) => {
    if (!validEntry(id, item)) return false
    return item.auth.refresh === auth.refresh || id === base.key
  })
  const prev = match?.[1]
  const next: StoreEntry = {
    ...base,
    savedAt: prev?.savedAt ?? base.savedAt,
    lastUsedAt: prev?.lastUsedAt,
  }
  const out = Object.fromEntries(
    list.filter(([id]) => id !== match?.[0]).filter(([id, item]) => validEntry(id, item)),
  ) as Record<string, StoreEntry>
  out[next.key] = next
  await writeStore({ version: 1, openai: out })
  return { ...next, id: next.key }
}

function sort(list: StoredAccount[], cur?: string) {
  return [...list].sort((a, b) => {
    const ac = a.id === cur ? 1 : 0
    const bc = b.id === cur ? 1 : 0
    if (ac !== bc) return bc - ac
    if ((b.lastUsedAt ?? 0) !== (a.lastUsedAt ?? 0)) return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    if (b.savedAt !== a.savedAt) return b.savedAt - a.savedAt
    return (a.email || a.accountId || a.id).localeCompare(b.email || b.accountId || b.id)
  })
}

export async function listAccounts() {
  const load = await pruneInvalidAccounts()
  if (!load.ok) return load
  const auth = await readCurrentAuth()
  const cur = auth ? match(load.accounts, auth) ?? fallback(auth.refresh) : undefined
  return { ok: true as const, accounts: sort(load.accounts, cur), current: cur }
}

export async function switchAccount(id: string) {
  const load = await readStore()
  if (!load.ok) throw new Error("account store unavailable")
  const item = load.store.openai[id]
  if (!validEntry(id, item)) throw new Error("saved account not found")
  await writeCurrentOpenAI(item.auth)
  await writeStore({
    version: 1,
    openai: {
      ...load.store.openai,
      [id]: {
        ...item,
        lastUsedAt: Date.now(),
      },
    },
  })
}

export async function deleteSavedAccount(id: string) {
  const load = await readStore()
  if (!load.ok) throw new Error("account store unavailable")
  if (!(id in load.store.openai)) throw new Error("saved account not found")
  const next = { ...load.store.openai }
  delete next[id]
  await writeStore({ version: 1, openai: next })
}
