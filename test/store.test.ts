import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fallback } from "../src/parse"
import { authPath, storePath } from "../src/paths"
import { readCurrentAuth, readStore, switchAccount, upsertSavedAccount } from "../src/store"
import type { OpenAIAuth } from "../src/types"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "switch-auth-"))
process.env.OPENCODE_TEST_HOME = root

const auth: OpenAIAuth = {
  type: "oauth",
  refresh: "refresh-token",
  access: `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/profile.email": "user@example.com" })).toString("base64url")}.b`,
  expires: Date.now() + 60_000,
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
})

test("upsert creates store file", async () => {
  const item = await upsertSavedAccount(auth)
  const load = await readStore()
  expect(item.id).toBe(fallback("refresh-token"))
  expect(load.ok).toBe(true)
  if (load.ok) expect(load.store.openai[fallback("refresh-token")]?.email).toBe("user@example.com")
})

test("switchAccount rewrites current openai auth", async () => {
  const item = await upsertSavedAccount(auth)
  await switchAccount(item.id)
  const cur = await readCurrentAuth()
  expect(cur?.refresh).toBe("refresh-token")
})

test("upsert does not overwrite malformed store", async () => {
  const file = storePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "{not-json}\n")

  await expect(upsertSavedAccount(auth)).rejects.toThrow("account store malformed")
  const load = await readStore()
  expect(load).toEqual({ ok: false, reason: "malformed" })
  expect(await fs.readFile(file, "utf8")).toBe("{not-json}\n")
})

test("switchAccount does not overwrite malformed auth.json", async () => {
  const item = await upsertSavedAccount(auth)
  const file = authPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "{not-json}\n")

  await expect(switchAccount(item.id)).rejects.toThrow("Expected '}'")
  expect(await fs.readFile(file, "utf8")).toBe("{not-json}\n")
})
