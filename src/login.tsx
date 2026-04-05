/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { clip, detail, runOAuthCallback, target } from "./login-helpers"
import type { OAuthAuthz, ProviderMethod, ProviderPrompt } from "./types"
import { readCurrentAuth, upsertSavedAccount } from "./store"

type OAuthMethod = {
  index: number
  method: ProviderMethod
}

type ClientResult<T> =
  | T
  | {
      data?: T
      error?: unknown
    }

function visible(prompt: ProviderPrompt, values: Record<string, string>) {
  if (!prompt.when) return true
  const cur = values[prompt.when.key]
  if (cur === undefined) return false
  if (prompt.when.op === "eq") return cur === prompt.when.value
  return cur !== prompt.when.value
}

function same(prev: Awaited<ReturnType<typeof readCurrentAuth>>, next: Awaited<ReturnType<typeof readCurrentAuth>>) {
  if (!prev || !next) return false
  return prev.refresh === next.refresh
}

function unwrap<T>(input: ClientResult<T>) {
  if (!input || typeof input !== "object") {
    return { ok: true as const, data: input as T }
  }
  if ("error" in input && input.error !== undefined) {
    return { ok: false as const, error: input.error }
  }
  if ("data" in input) {
    return input.data === undefined ? { ok: false as const, error: "Missing response data" } : { ok: true as const, data: input.data }
  }
  return { ok: true as const, data: input as T }
}

async function authMethods(api: TuiPluginApi) {
  const res = unwrap(await api.client.provider.auth())
  if (!res.ok) return []
  return (res.data.openai ?? []) as ProviderMethod[]
}

function bind(api: TuiPluginApi, authz: OAuthAuthz) {
  useKeyboard((evt) => {
    if (evt.name !== "c" || evt.ctrl || evt.meta) return
    evt.preventDefault()
    evt.stopPropagation()
    void clip(target(authz))
      .then((ok) => api.ui.toast({
        variant: ok ? "info" : "warning",
        message: ok ? "Copied to clipboard" : "Failed to copy to clipboard",
      }))
  })
}

function WaitView(props: { api: TuiPluginApi; title: string; authz: OAuthAuthz; run: () => Promise<void> }) {
  bind(props.api, props.authz)
  onMount(() => {
    void props.run()
  })
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <text attributes={TextAttributes.BOLD}>{props.title}</text>
      <text>{props.authz.instructions}</text>
      <text>{props.authz.url}</text>
      <text>Waiting for authorization...</text>
      <text>Press c to copy the link</text>
    </box>
  )
}

function CodePrompt(props: {
  api: TuiPluginApi
  title: string
  authz: OAuthAuthz
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  bind(props.api, props.authz)
  return (
    <props.api.ui.DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
      description={() => (
        <box gap={1}>
          <text>{props.authz.instructions}</text>
          <text>{props.authz.url}</text>
          <text>Press c to copy the code</text>
        </box>
      )}
    />
  )
}

function wait(api: TuiPluginApi, title: string, authz: OAuthAuthz, run: () => Promise<void>) {
  api.ui.dialog.replace(() => <WaitView api={api} title={title} authz={authz} run={run} />)
}

async function choose(api: TuiPluginApi, methods: OAuthMethod[]) {
  if (methods.length === 1) return 0
  return await new Promise<number | null>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogSelect
          title="Select auth method"
          options={methods.map((item, index) => ({ title: item.method.label, value: index }))}
          onSelect={(item) => resolve(item.value)}
        />
      ),
      () => resolve(null),
    )
  })
}

async function ask(api: TuiPluginApi, title: string, prompt: ProviderPrompt) {
  if (prompt.type === "text") {
    return await new Promise<string | null>((resolve) => {
      api.ui.dialog.replace(
        () => (
          <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2}>
            <api.ui.DialogPrompt
              title={title}
              placeholder={prompt.placeholder}
              onConfirm={(value) => resolve(value)}
              onCancel={() => resolve(null)}
              description={() => <text>{prompt.message}</text>}
            />
          </box>
        ),
        () => resolve(null),
      )
    })
  }
  return await new Promise<string | null>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2}>
          <api.ui.DialogSelect
            title={prompt.message}
            options={(prompt.options ?? []).map((item) => ({
              title: item.label,
              value: item.value,
              description: item.hint,
            }))}
            onSelect={(item) => resolve(item.value)}
          />
        </box>
      ),
      () => resolve(null),
    )
  })
}

async function prompts(api: TuiPluginApi, title: string, method: ProviderMethod) {
  const values: Record<string, string> = {}
  for (const prompt of method.prompts ?? []) {
    if (!visible(prompt, values)) continue
    const value = await ask(api, title, prompt)
    if (value == null) return
    values[prompt.key] = value
  }
  return values
}

async function save(api: TuiPluginApi, prev?: Awaited<ReturnType<typeof readCurrentAuth>>) {
  let activeUpdated = false
  try {
    const client = api.client as TuiPluginApi["client"] & {
      sync?: { bootstrap?: () => Promise<void> }
    }
    if (typeof api.client.instance.dispose === "function") {
      await api.client.instance.dispose()
    }
    if (typeof client.sync?.bootstrap === "function") {
      await client.sync.bootstrap()
    }
    const auth = await readCurrentAuth()
    if (!auth) {
      api.ui.toast({ variant: "error", message: "Login completed, but saved account could not be loaded" })
      return false
    }
    activeUpdated = true
    if (same(prev, auth)) {
      api.ui.toast({ variant: "warning", message: "Login completed, but OpenAI account did not change" })
      return false
    }
    await upsertSavedAccount(auth)
    return true
  } catch {
    api.ui.toast({
      variant: "error",
      message: activeUpdated
        ? "Login completed, but saving the account failed"
        : "Login completed, but account sync failed",
    })
    return false
  }
}

async function code(api: TuiPluginApi, index: number, method: ProviderMethod, authz: OAuthAuthz) {
  const prev = await readCurrentAuth()
  const ok = await new Promise<Awaited<ReturnType<typeof runOAuthCallback>>>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <CodePrompt
          api={api}
          title={method.label}
          authz={authz}
          onConfirm={async (value) => {
            resolve(await runOAuthCallback(
              (input) => api.client.provider.oauth.callback(input),
              { providerID: "openai", method: index, code: value },
            ))
          }}
          onCancel={() => resolve({ ok: false, error: "Cancelled" })}
        />
      ),
      () => resolve({ ok: false, error: "Cancelled" }),
    )
  })
  if (!ok.ok) {
    api.ui.toast({ variant: "error", message: `Login failed: ${detail(ok.error)}` })
    return false
  }
  return save(api, prev)
}

async function auto(api: TuiPluginApi, index: number, method: ProviderMethod, authz: OAuthAuthz) {
  const prev = await readCurrentAuth()
  const ok = await new Promise<Awaited<ReturnType<typeof runOAuthCallback>>>((resolve) => {
    wait(api, method.label, authz, async () => {
      resolve(await runOAuthCallback(
        (input) => api.client.provider.oauth.callback(input),
        { providerID: "openai", method: index },
      ))
    })
  })
  if (!ok.ok) {
    api.ui.toast({ variant: "error", message: `Login failed: ${detail(ok.error)}` })
    return false
  }
  return save(api, prev)
}

export async function hasLogin(api: TuiPluginApi) {
  try {
    return (await authMethods(api)).some((item) => item.type === "oauth")
  } catch {
    return false
  }
}

export async function loginOpenAI(api: TuiPluginApi) {
  try {
    const available = await authMethods(api)
    const methods = available
      .map((method, index) => ({ method, index }))
      .filter((item) => item.method.type === "oauth")
    if (!methods.length) {
      api.ui.toast({ variant: "error", message: "OpenAI OAuth login unavailable" })
      return false
    }
    const index = await choose(api, methods)
    if (index == null) return false
    const picked = methods[index]
    const method = picked.method
    let inputs: Record<string, string> | undefined
    if (method.prompts?.length) {
      const value = await prompts(api, method.label, method)
      if (!value) return false
      inputs = value
    }
    const authz = unwrap(await api.client.provider.oauth.authorize({
      providerID: "openai",
      method: picked.index,
      inputs,
    }))
    if (!authz.ok) {
      api.ui.toast({ variant: "error", message: `Login failed: ${detail(authz.error)}` })
      return false
    }
    if (authz.data.method === "code") return code(api, picked.index, method, authz.data as OAuthAuthz)
    if (authz.data.method === "auto") return auto(api, picked.index, method, authz.data as OAuthAuthz)
    api.ui.toast({ variant: "error", message: "Unsupported auth method" })
    return false
  } catch (err) {
    api.ui.toast({ variant: "error", message: `Login failed: ${detail(err)}` })
    return false
  }
}
