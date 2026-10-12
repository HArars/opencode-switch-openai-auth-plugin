import { data, HostError, success } from "./host"
import type { HostClient } from "./host"
import type { AccountStore } from "./store"
import type { Operation } from "./operation"
import type { AuthGateway, OAuthAuthz, ProviderMethod, ProviderPrompt } from "./types"

export type LoginDialogs = {
  choose: (methods: ProviderMethod[]) => Promise<number | null>
  prompt: (title: string, prompt: ProviderPrompt) => Promise<string | null>
  code: (title: string, authorization: OAuthAuthz, submit: (code: string) => Promise<void>) => Promise<boolean>
  wait: (title: string, authorization: OAuthAuthz, submit: () => Promise<void>) => Promise<boolean>
}

export async function authMethods(client: HostClient, signal?: AbortSignal) {
  const methods = data(await client.provider.auth({}, { signal }), "Could not load OpenAI login methods")
  return methods.openai ?? []
}

export function visible(prompt: ProviderPrompt, inputs: Record<string, string>) {
  if (!prompt.when) return true
  const value = inputs[prompt.when.key]
  if (value === undefined) return false
  return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
}

export async function loginOpenAI(client: HostClient, gateway: AuthGateway, store: AccountStore, dialogs: LoginDialogs, operation: Operation) {
  await gateway.assertAvailable()
  operation.check()
  // Capture a rotated outgoing credential before the native callback replaces it.
  await store.list(() => gateway.read())
  operation.check()
  const methods = (await authMethods(client, operation.signal))
    .map((method, index) => ({ method, index })).filter(item => item.method.type === "oauth")
  if (!methods.length) throw new HostError("OpenAI OAuth login is unavailable")
  const selected = methods.length === 1 ? 0 : await dialogs.choose(methods.map(item => item.method))
  operation.check()
  if (selected === null) return undefined
  const picked = methods[selected]
  if (!picked) throw new HostError("Invalid login method selected")
  const inputs: Record<string, string> = {}
  for (const prompt of picked.method.prompts ?? []) {
    if (!visible(prompt, inputs)) continue
    const value = await dialogs.prompt(picked.method.label, prompt)
    operation.check()
    if (value === null) return undefined
    inputs[prompt.key] = value
  }
  const authorization = data(await client.provider.oauth.authorize({
    providerID: "openai", method: picked.index, inputs,
  }, { signal: operation.signal }), "OpenCode could not start OAuth login. Retry or use the device-code method.")
  operation.check()
  if (authorization.method !== "auto" && authorization.method !== "code") throw new HostError("Unsupported OAuth authorization method")
  const submit = async (code?: string) => {
    operation.check()
    success(await client.provider.oauth.callback({ providerID: "openai", method: picked.index, code }, {
      signal: operation.signal,
    }), "OpenAI authorization failed. Retry the login.")
  }
  const completed = authorization.method === "code"
    ? await dialogs.code(picked.method.label, authorization, submit)
    : await dialogs.wait(picked.method.label, authorization, () => submit())
  operation.check()
  if (!completed) return undefined
  const active = await gateway.read()
  operation.check()
  if (!active) throw new HostError("Login completed, but OpenCode's new credentials could not be read")
  // The callback already wrote native auth. Save first; a refresh failure must not lose the account.
  try { await store.save(active) } catch {
    throw new HostError("Login completed and changed the active account, but saving failed. Repair the account store and retry.")
  }
  operation.check()
  try {
    await gateway.refresh()
    return { saved: true, refreshed: true }
  } catch {
    return { saved: true, refreshed: false }
  }
}
