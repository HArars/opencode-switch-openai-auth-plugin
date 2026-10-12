import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LocalAuthGateway, readActiveAuth } from "../src/host"
import type { HostClient } from "../src/host"
import { fixture } from "./fixture"
import { credential } from "./auth-fixture"

test("local proof is verified and removed; auth set preserves other providers through the host", async () => {
  await using f = await fixture()
  const file = path.join(f.root, "auth.json")
  const other = { type: "api", key: "fake-unrelated-key" }
  await fs.writeFile(file, JSON.stringify({ other }))
  let proofReads = 0
  const client = {
    path: { get: async () => ({ data: { directory: f.root, home: "test-home" } }) },
    file: { read: async ({ path: relative }: { path: string }) => {
      proofReads++
      return { data: { content: await fs.readFile(path.join(f.root, relative), "utf8") } }
    } },
    auth: { set: async ({ providerID, auth }: { providerID: string; auth: unknown }) => {
      const content = JSON.parse(await fs.readFile(file, "utf8"))
      await fs.writeFile(file, JSON.stringify({ ...content, [providerID]: auth }))
      return { data: true }
    } },
    instance: { dispose: async () => ({ data: true }) },
  } as unknown as HostClient
  const gateway = new LocalAuthGateway(() => client, file, { args: [], home: "test-home", authContent: undefined })
  const auth = credential()
  await gateway.set(auth)
  expect(await gateway.read()).toEqual(auth)
  expect(JSON.parse(await fs.readFile(file, "utf8")).other).toEqual(other)
  expect(proofReads).toBe(1)
  expect((await fs.readdir(f.root)).filter(name => name.includes("probe"))).toEqual([])
})

test("attach and environment-injected authentication are rejected before server or disk access", async () => {
  const client = () => { throw new Error("must not be accessed") }
  const attach = new LocalAuthGateway(client, "/unused", { args: ["opencode", "attach"], home: "test", authContent: undefined })
  await expect(attach.read()).rejects.toThrow("local OpenCode only")
  const injected = new LocalAuthGateway(client, "/unused", { args: [], home: "test", authContent: "{}" })
  await expect(injected.set(credential())).rejects.toThrow("OPENCODE_AUTH_CONTENT")
})

test("remote home and mismatched filesystem proof fail without changing credentials", async () => {
  await using f = await fixture()
  const client = {
    path: { get: async () => ({ data: { home: "remote", directory: f.root } }) },
    file: { read: async () => ({ data: { content: "not-the-local-nonce" } }) },
  } as unknown as HostClient
  const mismatchedHome = new LocalAuthGateway(() => client, "/unused", { args: [], home: "local", authContent: undefined })
  await expect(mismatchedHome.assertAvailable()).rejects.toThrow("different home")
  const mismatchedFS = new LocalAuthGateway(() => client, "/unused", { args: [], home: "remote", authContent: undefined })
  await expect(mismatchedFS.assertAvailable()).rejects.toThrow("different filesystem")
  expect(await fs.readdir(f.root)).toEqual([])
})

test("SDK error objects are checked for native auth and instance refresh", async () => {
  await using f = await fixture()
  const client = {
    path: { get: async () => ({ data: { home: "test", directory: f.root } }) },
    file: { read: async ({ path: relative }: { path: string }) => ({ data: { content: await fs.readFile(path.join(f.root, relative), "utf8") } }) },
    auth: { set: async () => ({ error: { message: "fake-secret-token" } }) },
    instance: { dispose: async () => ({ error: { message: "fake-secret-token" } }) },
  } as unknown as HostClient
  const gateway = new LocalAuthGateway(() => client, "/unused", { args: [], home: "test", authContent: undefined })
  await expect(gateway.set(credential())).rejects.toThrow("rejected the account switch")
  await expect(gateway.refresh()).rejects.toThrow("could not refresh")
})

test("cancellation during local verification prevents the subsequent native auth request", async () => {
  await using f = await fixture()
  const controller = new AbortController()
  let writes = 0
  const client = {
    path: { get: async () => ({ data: { home: "test", directory: f.root } }) },
    file: { read: async ({ path: relative }: { path: string }) => {
      controller.abort()
      return { data: { content: await fs.readFile(path.join(f.root, relative), "utf8") } }
    } },
    auth: { set: async () => { writes++; return { data: true } } },
  } as unknown as HostClient
  const gateway = new LocalAuthGateway(() => client, "/unused", { args: [], home: "test", authContent: undefined })
  await expect(gateway.set(credential(), controller.signal)).rejects.toThrow("abort")
  expect(writes).toBe(0)
  expect(await fs.readdir(f.root)).toEqual([])
})

test("malformed auth roots stay intact and API-key/missing auth are normal", async () => {
  await using f = await fixture()
  const file = path.join(f.root, "auth.json")
  expect(await readActiveAuth(file)).toBeUndefined()
  for (const raw of ["[]", "null", "", "{broken", '"text"']) {
    await fs.writeFile(file, raw)
    await expect(readActiveAuth(file)).rejects.toThrow("malformed")
    expect(await fs.readFile(file, "utf8")).toBe(raw)
  }
  await fs.writeFile(file, JSON.stringify({ openai: { type: "api", key: "fake" } }))
  expect(await readActiveAuth(file)).toBeUndefined()
  await fs.writeFile(file, JSON.stringify({ openai: { ...credential(), expires: -1 } }))
  await expect(readActiveAuth(file)).rejects.toThrow("invalid OpenAI OAuth")
})
