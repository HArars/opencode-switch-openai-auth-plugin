/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import type { OAuthAuthz, ProviderMethod, ProviderPrompt } from "./types"
import { readCurrentAuth, upsertSavedAccount } from "./store"

type OAuthMethod = {
  index: number
  method: ProviderMethod
}

function visible(prompt: ProviderPrompt, values: Record<string, string>) {
  if (!prompt.when) return true
  const cur = values[prompt.when.key]
  if (prompt.when.op === "eq") return cur === prompt.when.value
  return cur !== prompt.when.value
}

function same(prev: Awaited<ReturnType<typeof readCurrentAuth>>, next: Awaited<ReturnType<typeof readCurrentAuth>>) {
  if (!prev || !next) return false
  return prev.refresh === next.refresh
}

function clip(text: string) {
  if (process.stdout.isTTY) {
    const base64 = Buffer.from(text).toString("base64")
    const osc52 = `\x1b]52;c;${base64}\x07`
    const seq = process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
    process.stdout.write(seq)
  }

  const cmds = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

  return Promise.any(
    cmds.map(async (cmd) => {
      const proc = Bun.spawn({
        cmd,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      })
      await proc.stdin.write(new TextEncoder().encode(text))
      proc.stdin.end()
      const code = await proc.exited
      if (code !== 0) throw new Error("copy failed")
    }),
  ).catch(() => {})
}

function target(authz: OAuthAuthz) {
  return authz.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? authz.url
}

function bind(api: TuiPluginApi, authz: OAuthAuthz) {
  useKeyboard((evt) => {
    if (evt.name !== "c" || evt.ctrl || evt.meta) return
    evt.preventDefault()
    evt.stopPropagation()
    void clip(target(authz))
      .then(() => api.ui.toast({ variant: "info", message: "Copied to clipboard" }))
  })
}

function WaitView(props: { api: TuiPluginApi; title: string; authz: OAuthAuthz }) {
  bind(props.api, props.authz)
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
  api.ui.dialog.replace(() => <WaitView api={api} title={title} authz={authz} />)
  void run()
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
  const ok = await new Promise<boolean>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <CodePrompt
          api={api}
          title={method.label}
          authz={authz}
          onConfirm={async (value) => {
            const res = await api.client.provider.oauth.callback({ providerID: "openai", method: index, code: value })
            resolve(!res.error)
          }}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
  if (!ok) {
    api.ui.toast({ variant: "error", message: "Login failed" })
    return false
  }
  return save(api, prev)
}

async function auto(api: TuiPluginApi, index: number, method: ProviderMethod, authz: OAuthAuthz) {
  const prev = await readCurrentAuth()
  const ok = await new Promise<boolean>((resolve) => {
    wait(api, method.label, authz, async () => {
      const res = await api.client.provider.oauth.callback({ providerID: "openai", method: index })
      resolve(!res.error)
    })
  })
  if (!ok) {
    api.ui.toast({ variant: "error", message: "Login failed" })
    return false
  }
  return save(api, prev)
}

export async function hasLogin(api: TuiPluginApi) {
  try {
    const res = await api.client.provider.auth()
    const methods = (res.data?.openai ?? []) as ProviderMethod[]
    return methods.some((item) => item.type === "oauth")
  } catch {
    return false
  }
}

export async function loginOpenAI(api: TuiPluginApi) {
  try {
    const auth = await api.client.provider.auth()
    const methods = ((auth.data?.openai ?? []) as ProviderMethod[])
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
    const inputs = await prompts(api, method.label, method)
    if (method.prompts?.length && !inputs) return false
    const authz = await api.client.provider.oauth.authorize({
      providerID: "openai",
      method: picked.index,
      inputs,
    })
    if (authz.error || !authz.data) {
      api.ui.toast({ variant: "error", message: "Login failed" })
      return false
    }
    if (authz.data.method === "code") return code(api, picked.index, method, authz.data as OAuthAuthz)
    if (authz.data.method === "auto") return auto(api, picked.index, method, authz.data as OAuthAuthz)
    api.ui.toast({ variant: "error", message: "Unsupported auth method" })
    return false
  } catch {
    api.ui.toast({ variant: "error", message: "Login failed" })
    return false
  }
}
