import { createHash } from "node:crypto"
import type { Claims, OpenAIAuth, StoreEntry } from "./types"

function text(v: unknown) {
  return typeof v === "string" && v.trim() ? v : undefined
}

function obj(v: unknown) {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
}

export function parseJwtClaims(token: string): Claims {
  const part = token.split(".")[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Claims
  } catch {
    return {}
  }
}

export function extractEmail(auth: OpenAIAuth) {
  const claims = parseJwtClaims(auth.access)
  const direct = text(claims["https://api.openai.com/profile.email"])
  if (direct) return direct
  return text(obj(claims["https://api.openai.com/profile"] as unknown)?.email)
}

export function extractPlan(auth: OpenAIAuth) {
  return text(parseJwtClaims(auth.access)["https://api.openai.com/auth.chatgpt_plan_type"])
}

export function extractAccountId(auth: OpenAIAuth) {
  if (text(auth.accountId)) return text(auth.accountId)
  const claims = parseJwtClaims(auth.access)
  const direct = text(claims.chatgpt_account_id)
  if (direct) return direct
  const namespaced = text(claims["https://api.openai.com/auth.chatgpt_account_id"])
  if (namespaced) return namespaced
  const orgs = claims.organizations
  if (!Array.isArray(orgs) || !orgs.length) return
  return text(obj(orgs[0])?.id)
}

export function fallback(refresh: string) {
  return `fallback:${createHash("sha256").update(refresh).digest("hex").slice(0, 16)}`
}

export function key(auth: OpenAIAuth) {
  return fallback(auth.refresh)
}

export function entryFromAuth(auth: OpenAIAuth, now = Date.now()): StoreEntry {
  return {
    key: key(auth),
    email: extractEmail(auth),
    accountId: extractAccountId(auth),
    plan: extractPlan(auth),
    savedAt: now,
    auth: clean(auth),
  }
}

export function clean(auth: OpenAIAuth): OpenAIAuth {
  return {
    type: "oauth",
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
    ...(text(auth.accountId) ? { accountId: auth.accountId } : {}),
    ...(text(auth.enterpriseUrl) ? { enterpriseUrl: auth.enterpriseUrl } : {}),
  }
}
