import { randomUUID } from "node:crypto"
import type { Claims, Identity, OpenAIAuth, StoreEntry } from "./types"

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
export function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
export function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
export function validAuth(value: unknown): value is OpenAIAuth {
  const item = record(value)
  return Boolean(item && item.type === "oauth" && text(item.refresh) && text(item.access)
    && timestamp(item.expires)
    && (item.accountId === undefined || text(item.accountId))
    && (item.enterpriseUrl === undefined || text(item.enterpriseUrl)))
}
// Claims are display/matching metadata, never proof that a token is authentic.
export function parseJwtClaims(token: string): Claims {
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some(part => !part)) return {}
  try {
    return record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))) ?? {}
  } catch { return {} }
}
export function extractEmail(auth: OpenAIAuth) {
  const claims = parseJwtClaims(auth.access)
  return text(record(claims["https://api.openai.com/profile"])?.email)
    ?? text(claims.email) ?? text(claims["https://api.openai.com/profile.email"])
}
export function extractPlan(auth: OpenAIAuth) {
  const claims = parseJwtClaims(auth.access)
  return text(record(claims["https://api.openai.com/auth"])?.chatgpt_plan_type)
    ?? text(claims["https://api.openai.com/auth.chatgpt_plan_type"])
}
export function extractAccountId(auth: OpenAIAuth) {
  const claims = parseJwtClaims(auth.access)
  const orgs = claims.organizations
  return text(auth.accountId) ?? text(claims.chatgpt_account_id)
    ?? text(record(claims["https://api.openai.com/auth"])?.chatgpt_account_id)
    ?? text(claims["https://api.openai.com/auth.chatgpt_account_id"])
    ?? (Array.isArray(orgs) ? text(record(orgs[0])?.id) : undefined)
}
export function identity(auth: OpenAIAuth): Identity {
  const claims = parseJwtClaims(auth.access)
  const namespaced = record(claims["https://api.openai.com/auth"])
  return {
    issuer: (text(auth.enterpriseUrl) ?? text(claims.iss) ?? "https://auth.openai.com").replace(/\/+$/, ""),
    userId: text(namespaced?.chatgpt_user_id) ?? text(namespaced?.user_id)
      ?? text(namespaced?.chatgpt_account_user_id) ?? text(claims.sub),
    accountId: extractAccountId(auth),
    email: extractEmail(auth)?.toLowerCase(),
  }
}
export function sameAccount(a: Pick<StoreEntry, "auth" | "identity">, b: Pick<StoreEntry, "auth" | "identity">) {
  const left = a.identity
  const right = b.identity
  if (left.issuer !== right.issuer) return false
  if (left.accountId && right.accountId && left.accountId !== right.accountId) return false
  if (left.userId && right.userId && left.userId !== right.userId) return false
  if (a.auth.refresh === b.auth.refresh) return true
  // Workspace identity alone is not a user identity; unknown workspaces cannot be merged.
  if (!left.accountId || left.accountId !== right.accountId) return false
  if (left.userId && right.userId) return left.userId === right.userId
  return Boolean(left.email && left.email === right.email)
}
export function clean(auth: OpenAIAuth): OpenAIAuth {
  if (!validAuth(auth)) throw new Error("Invalid OpenAI OAuth credentials")
  return {
    type: "oauth", refresh: auth.refresh, access: auth.access, expires: auth.expires,
    ...(text(auth.accountId) ? { accountId: auth.accountId } : {}),
    ...(text(auth.enterpriseUrl) ? { enterpriseUrl: auth.enterpriseUrl } : {}),
  }
}
export function entryFromAuth(auth: OpenAIAuth, now = Date.now(), id = randomUUID()): StoreEntry {
  return {
    key: id, identity: identity(auth), email: extractEmail(auth),
    accountId: extractAccountId(auth), plan: extractPlan(auth),
    savedAt: now, updatedAt: now, auth: clean(auth),
  }
}
