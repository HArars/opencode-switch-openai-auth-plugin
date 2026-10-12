export type OpenAIAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export type Identity = { issuer: string; userId?: string; accountId?: string; email?: string }
export type StoreEntry = {
  key: string
  identity: Identity
  email?: string
  accountId?: string
  plan?: string
  savedAt: number
  updatedAt: number
  lastUsedAt?: number
  auth: OpenAIAuth
}
export type StoreFile = { version: 2; openai: Record<string, StoreEntry> }
export type StoredAccount = StoreEntry & { id: string }
export type Claims = Record<string, unknown>
export type SwitchAction = { type: "login" } | { type: "account"; id: string } | { type: "remove" }
export type AuthGateway = {
  assertAvailable: () => Promise<void>
  read: () => Promise<OpenAIAuth | undefined>
  set: (auth: OpenAIAuth, signal?: AbortSignal) => Promise<void>
  refresh: () => Promise<void>
}
export type ProviderPrompt = {
  type: "text" | "select"
  key: string
  message: string
  placeholder?: string
  options?: Array<{ label: string; value: string; hint?: string }>
  when?: { key: string; op: "eq" | "neq"; value: string }
}
export type ProviderMethod = { type: "oauth" | "api"; label: string; prompts?: ProviderPrompt[] }
export type OAuthAuthz = { url: string; method: "auto" | "code"; instructions: string }
