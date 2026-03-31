import { describe, expect, test } from "bun:test"
import { entryFromAuth, extractAccountId, extractEmail, extractPlan, fallback } from "../src/parse"
import type { OpenAIAuth } from "../src/types"

function token(payload: Record<string, unknown>) {
  return `a.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.b`
}

test("extracts email plan and account id from claims", () => {
  const auth: OpenAIAuth = {
    type: "oauth",
    refresh: "refresh-1",
    access: token({
      "https://api.openai.com/profile.email": "user@example.com",
      "https://api.openai.com/auth.chatgpt_plan_type": "team",
      chatgpt_account_id: "acct_123",
    }),
    expires: Date.now() + 10_000,
  }
  expect(extractEmail(auth)).toBe("user@example.com")
  expect(extractPlan(auth)).toBe("team")
  expect(extractAccountId(auth)).toBe("acct_123")
})

test("entry key uses refresh fallback hash", () => {
  const auth: OpenAIAuth = {
    type: "oauth",
    refresh: "refresh-2",
    access: token({}),
    expires: Date.now() + 10_000,
  }
  expect(entryFromAuth(auth).key).toBe(fallback("refresh-2"))
})
