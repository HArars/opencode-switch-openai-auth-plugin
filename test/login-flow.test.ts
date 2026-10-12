import { expect, test } from "bun:test"
import { Operation } from "../src/operation"
import { loginOpenAI } from "../src/login-flow"
import type { LoginDialogs } from "../src/login-flow"
import type { HostClient } from "../src/host"
import { fixture } from "./fixture"
import { credential } from "./auth-fixture"

function operation() { return new Operation(new AbortController().signal) }
function dialogs(): LoginDialogs {
  return {
    choose: async () => 0,
    prompt: async () => "value",
    code: async (_title, _authorization, submit) => { await submit("code"); return true },
    wait: async (_title, _authorization, submit) => { await submit(); return true },
  }
}

test("OAuth filtering preserves native indexes and conditional inputs, saves before refreshing", async () => {
  await using f = await fixture()
  f.setCurrent(credential("outgoing"))
  const previous = await f.store.save(credential("old-outgoing"))
  const calls: string[] = []
  const client = { provider: {
    auth: async () => ({ data: { openai: [
      { type: "api", label: "API key" }, { type: "oauth", label: "Browser" },
      { type: "oauth", label: "Device", prompts: [
        { type: "select", key: "mode", message: "mode", options: [{ label: "Team", value: "team" }] },
        { type: "text", key: "workspace", message: "workspace", when: { key: "mode", op: "eq", value: "team" } },
        { type: "text", key: "skip", message: "hidden", when: { key: "mode", op: "neq", value: "team" } },
      ] },
    ] } }),
    oauth: {
      authorize: async (input: { method: number; inputs: unknown }) => {
        expect(input).toMatchObject({ method: 2, inputs: { mode: "team", workspace: "value" } })
        calls.push("authorize")
        return { data: { url: "https://example.test", method: "auto", instructions: "ABCD-12345" } }
      },
      callback: async (input: { method: number }) => {
        expect(input.method).toBe(2)
        f.setCurrent(credential("new-login", "user-2"))
        calls.push("callback")
        return { data: true }
      },
    },
  } } as unknown as HostClient
  const ui = dialogs()
  ui.choose = async () => 1
  ui.prompt = async (_title, prompt) => prompt.key === "mode" ? "team" : "value"
  f.gateway.refresh = async () => {
    expect((await f.store.list()).accounts.some(account => account.auth.refresh === "new-login")).toBe(true)
    calls.push("refresh")
  }
  const op = operation()
  try {
    expect(await loginOpenAI(client, f.gateway, f.store, ui, op)).toEqual({ saved: true, refreshed: true })
    expect(calls).toEqual(["authorize", "callback", "refresh"])
    expect((await f.store.list()).accounts.find(account => account.id === previous.id)!.auth.refresh).toBe("outgoing")
  } finally { op.dispose() }
})

test("re-login to unchanged native credentials can save the current account", async () => {
  await using f = await fixture()
  f.setCurrent(credential())
  const client = fakeClient()
  const op = operation()
  try {
    await loginOpenAI(client, f.gateway, f.store, dialogs(), op)
    expect((await f.store.list()).accounts).toHaveLength(1)
  } finally { op.dispose() }
})

function fakeClient() {
  return { provider: {
    auth: async () => ({ data: { openai: [{ type: "oauth", label: "Browser" }] } }),
    oauth: {
      authorize: async () => ({ data: { url: "https://example.test", method: "auto", instructions: "Open browser" } }),
      callback: async () => ({ data: true }),
    },
  } } as unknown as HostClient
}

test("refresh failure preserves the saved account and returns a partial-success outcome", async () => {
  await using f = await fixture()
  f.setCurrent(credential())
  f.gateway.refresh = async () => { throw new Error("unavailable") }
  const op = operation()
  try {
    expect(await loginOpenAI(fakeClient(), f.gateway, f.store, dialogs(), op)).toEqual({ saved: true, refreshed: false })
    expect((await f.store.list()).accounts).toHaveLength(1)
  } finally { op.dispose() }
})

test("cancelled or unloaded login cannot save or reopen after a late callback", async () => {
  await using f = await fixture()
  f.setCurrent(credential())
  const op = operation()
  const ui = dialogs()
  ui.wait = async (_title, _authorization, submit) => { await submit(); op.cancel(); return true }
  try {
    await expect(loginOpenAI(fakeClient(), f.gateway, f.store, ui, op)).rejects.toThrow("Cancelled")
    expect((await f.store.list()).accounts).toEqual([])
  } finally { op.dispose() }
})

test("callback SDK error objects cannot be mistaken for login success", async () => {
  await using f = await fixture()
  const client = fakeClient()
  client.provider.oauth.callback = (async () => ({ error: { message: "secret-should-not-leak" } })) as never
  const op = operation()
  try {
    await expect(loginOpenAI(client, f.gateway, f.store, dialogs(), op)).rejects.toThrow("authorization failed")
    expect((await f.store.list()).accounts).toEqual([])
  } finally { op.dispose() }
})

test("method lookup errors remain distinct from absence of OAuth", async () => {
  await using f = await fixture()
  const client = fakeClient()
  const op = operation()
  try {
    client.provider.auth = (async () => ({ error: {} })) as never
    await expect(loginOpenAI(client, f.gateway, f.store, dialogs(), op)).rejects.toThrow("load OpenAI login methods")
    client.provider.auth = (async () => ({ data: { openai: [{ type: "api", label: "API key" }] } })) as never
    await expect(loginOpenAI(client, f.gateway, f.store, dialogs(), op)).rejects.toThrow("OAuth login is unavailable")
  } finally { op.dispose() }
})
