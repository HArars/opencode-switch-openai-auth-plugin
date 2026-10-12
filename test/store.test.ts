import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AccountStore } from "../src/store"
import { withStoreLock } from "../src/files"
import { fixture } from "./fixture"
import { credential, jwt } from "./auth-fixture"

test("rotation keeps stable record ID and original savedAt", async () => {
  await using f = await fixture()
  const before = await f.store.save(credential())
  const after = await f.store.save(credential("rotated"))
  expect(after.id).toBe(before.id)
  expect(after.savedAt).toBe(before.savedAt)
  expect((await f.store.list()).accounts).toHaveLength(1)
})
test("listing native refreshed credentials restores Current and preserves freshest token", async () => {
  await using f = await fixture()
  const saved = await f.store.save(credential())
  f.setCurrent(credential("native-rotated"))
  const listing = await f.store.list(f.getCurrent())
  expect(listing.current).toBe(saved.id)
  expect(listing.accounts[0]!.auth.refresh).toBe("native-rotated")
  await f.store.switch(saved.id, f.gateway)
  expect(f.getCurrent()!.refresh).toBe("native-rotated")
})
test("A to B to A captures outgoing refresh even without reopening the picker", async () => {
  await using f = await fixture()
  const a = await f.store.save(credential("a"))
  const b = await f.store.save(credential("b", "user-2"))
  f.setCurrent(credential("a-rotated"))
  await f.store.switch(b.id, f.gateway)
  expect(f.getCurrent()!.refresh).toBe("b")
  await f.store.switch(a.id, f.gateway)
  expect(f.getCurrent()!.refresh).toBe("a-rotated")
})
test("cancelling a switch queued behind another transaction prevents any native write", async () => {
  await using f = await fixture()
  const a = await f.store.save(credential("a"))
  const b = await f.store.save(credential("b", "user-2"))
  f.setCurrent(a.auth)
  let release!: () => void
  let acquired!: () => void
  const ready = new Promise<void>(resolve => { acquired = resolve })
  const locked = withStoreLock(f.store.directory, async () => {
    acquired()
    await new Promise<void>(resolve => { release = resolve })
  })
  await ready
  const controller = new AbortController()
  let started!: () => void
  const entering = new Promise<void>(resolve => { started = resolve })
  f.gateway.assertAvailable = async () => { started() }
  const switching = f.store.switch(b.id, f.gateway, controller.signal)
  const outcome = switching.then(() => undefined, error => error as Error)
  await entering
  controller.abort()
  release()
  await locked
  expect(await outcome).toMatchObject({ name: "AbortError" })
  expect(f.getCurrent()).toEqual(a.auth)
  expect((await f.store.list()).accounts.find(account => account.id === b.id)!.lastUsedAt).toBeUndefined()
})
test("removing the active saved record keeps login and does not resurrect it", async () => {
  await using f = await fixture()
  const auth = credential()
  f.setCurrent(auth)
  const saved = await f.store.save(auth)
  await f.store.remove(saved.id)
  expect(f.getCurrent()).toEqual(auth)
  expect(await f.store.list(auth)).toMatchObject({ accounts: [], current: undefined })
})
test("expiry does not prune accounts; shared workspaces do not merge people", async () => {
  await using f = await fixture()
  await f.store.save(credential("old", "user-1", "workspace-1", 0))
  await f.store.save(credential("other", "user-2"))
  await f.store.save(credential("personal", "user-1", "personal"))
  expect((await f.store.list()).accounts).toHaveLength(3)
})
test("legacy migration backs up exact bytes, merges duplicates, and keeps time metadata", async () => {
  await using f = await fixture()
  await fs.mkdir(f.store.directory)
  const old = credential("old", "user-1", "workspace-1", 1)
  const next = credential("new", "user-1", "workspace-1", 2)
  const raw = JSON.stringify({ version: 1, openai: {
    old: { key: "old", savedAt: 10, lastUsedAt: 30, auth: old },
    next: { key: "next", savedAt: 20, lastUsedAt: 40, auth: next },
    invalid: { auth: { type: "api" } },
    invalidExpiry: { auth: { ...credential(), expires: { valueOf: false, toString: false } } },
  } })
  await fs.writeFile(f.store.file, raw)
  const result = await f.store.list()
  expect(result.accounts).toHaveLength(1)
  expect(result.accounts[0]).toMatchObject({ savedAt: 10, lastUsedAt: 40, auth: next })
  expect(result.warnings).toHaveLength(2)
  const backup = (await fs.readdir(f.store.directory)).find(file => file.startsWith("accounts.v1-backup."))!
  expect(await fs.readFile(path.join(f.store.directory, backup), "utf8")).toBe(raw)
  expect(JSON.parse(await fs.readFile(f.store.file, "utf8")).version).toBe(2)
  expect((await f.store.list()).warnings).toEqual([])
})
test("imports old platform directory without deleting source data", async () => {
  await using f = await fixture()
  const legacy = path.join(f.root, "legacy.json")
  const raw = JSON.stringify({ version: 1, openai: { a: { savedAt: 10, auth: credential() } } })
  await fs.writeFile(legacy, raw)
  const store = new AccountStore(f.store.directory, [legacy])
  expect((await store.list()).accounts).toHaveLength(1)
  expect(await fs.readFile(legacy, "utf8")).toBe(raw)
})
test("malformed, empty, future, and array stores preserve original bytes", async () => {
  await using f = await fixture()
  await fs.mkdir(f.store.directory)
  for (const raw of ["", "{broken", "[]", '{"version":2,"openai":[]}', '{"version":99,"openai":{}}', '{"version":2,"openai":{"bad":{}}}']) {
    await fs.writeFile(f.store.file, raw)
    await expect(f.store.save(credential())).rejects.toThrow("preserved")
    expect(await fs.readFile(f.store.file, "utf8")).toBe(raw)
  }
})
test("concurrent operations from independent instances preserve all writes", async () => {
  await using f = await fixture()
  await Promise.all(Array.from({ length: 24 }, (_, i) =>
    new AccountStore(f.store.directory, []).save(credential("fake-" + i, "user-" + i))))
  expect((await f.store.list()).accounts).toHaveLength(24)
  const leftovers = await fs.readdir(f.store.directory)
  expect(leftovers).toEqual(["accounts.json"])
}, 15_000)
test("independent processes preserve every account", async () => {
  await using f = await fixture()
  const workers = Array.from({ length: 5 }, (_, index) => Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "store-worker.ts"), f.store.directory, String(index)],
    stdout: "ignore", stderr: "pipe",
  }))
  const results = await Promise.all(workers.map(async worker => ({ code: await worker.exited, error: await new Response(worker.stderr).text() })))
  expect(results).toEqual(Array(5).fill({ code: 0, error: "" }))
  expect((await f.store.list()).accounts).toHaveLength(30)
}, 20_000)
test.skipIf(process.platform === "win32")("private modes are enforced under permissive umask and existing public files", async () => {
  await using f = await fixture()
  const old = process.umask(0o022)
  try {
    await f.store.save(credential())
    expect((await fs.stat(f.store.file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(f.store.directory)).mode & 0o777).toBe(0o700)
    await fs.chmod(f.store.file, 0o644)
    await fs.chmod(f.store.directory, 0o755)
    await f.store.list()
    expect((await fs.stat(f.store.file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(f.store.directory)).mode & 0o777).toBe(0o700)
  } finally { process.umask(old) }
})
test("native auth errors do not update usage or replace active credentials", async () => {
  await using f = await fixture()
  const saved = await f.store.save(credential())
  f.setCurrent(credential("other", "user-2"))
  f.gateway.set = async () => { throw new Error("rejected") }
  await expect(f.store.switch(saved.id, f.gateway)).rejects.toThrow("rejected")
  expect(f.getCurrent()!.refresh).toBe("other")
  expect((await f.store.list()).accounts[0]!.lastUsedAt).toBeUndefined()
})
test("a history write failure reports a successful native switch separately", async () => {
  await using f = await fixture()
  const saved = await f.store.save(credential())
  f.gateway.set = async auth => {
    f.setCurrent(auth)
    await fs.unlink(f.store.file)
    await fs.mkdir(f.store.file)
  }
  expect(await f.store.switch(saved.id, f.gateway)).toEqual({ historySaved: false })
  expect(f.getCurrent()!.refresh).toBe("fake-refresh-1")
})
test("opaque tokens never guess a user identity during refresh rotation", async () => {
  await using f = await fixture()
  const opaque = { ...credential(), accountId: undefined, access: jwt({}) }
  await f.store.save(opaque)
  await f.store.save({ ...opaque, refresh: "new" })
  expect((await f.store.list()).accounts).toHaveLength(2)
})

test("a crashed process's expired lock is reclaimed", async () => {
  await using f = await fixture()
  await fs.mkdir(f.store.directory)
  const lock = f.store.file + ".lock"
  await fs.mkdir(lock)
  const stale = new Date(Date.now() - 120_000)
  await fs.utimes(lock, stale, stale)
  await f.store.save(credential())
  expect((await f.store.list()).accounts).toHaveLength(1)
  expect(await fs.readdir(f.store.directory)).toEqual(["accounts.json"])
})

test.skipIf(process.platform === "win32")("symlinked stores are rejected without replacing their targets", async () => {
  await using f = await fixture()
  await fs.mkdir(f.store.directory)
  const target = path.join(f.root, "target.json")
  const raw = JSON.stringify({ version: 2, openai: {} })
  await fs.writeFile(target, raw)
  await fs.symlink(target, f.store.file)
  await expect(f.store.save(credential())).rejects.toThrow("regular file")
  expect(await fs.readFile(target, "utf8")).toBe(raw)
})
