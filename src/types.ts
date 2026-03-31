export type OpenAIAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export type StoreEntry = {
  key: string
  email?: string
  accountId?: string
  plan?: string
  savedAt: number
  lastUsedAt?: number
  auth: OpenAIAuth
}

export type StoreFile = {
  version: 1
  openai: Record<string, StoreEntry>
}

export type StoredAccount = StoreEntry & {
  id: string
}

export type SwitchAction =
  | { type: "login" }
  | { type: "account"; id: string }
  | { type: "logout" }

export type SwitchOption = {
  title: string
  value: SwitchAction
  description?: string
  category?: string
  footer?: string
}

export type Claims = Record<string, unknown>

export type StoreLoad =
  | { ok: true; store: StoreFile }
  | { ok: false; reason: "malformed" | "missing" }

export type ProviderPrompt = {
  type: "text" | "select"
  key: string
  message: string
  placeholder?: string
  options?: Array<{ label: string; value: string; hint?: string }>
  when?: {
    key: string
    op: "eq" | "neq"
    value: string
  }
}

export type ProviderMethod = {
  type: "oauth" | "api"
  label: string
  prompts?: ProviderPrompt[]
}

export type OAuthAuthz = {
  url: string
  method: "auto" | "code"
  instructions: string
}
