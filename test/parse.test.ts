import { expect, test } from "bun:test"
import { clean, entryFromAuth, extractAccountId, extractEmail, extractPlan, parseJwtClaims, sameAccount, validAuth } from "../src/parse"
import { credential, jwt } from "./auth-fixture"

test("parses current nested claims and explicit workspace metadata", () => {
  const auth = credential()
  expect(extractEmail(auth)).toBe("user-1@example.test")
  expect(extractPlan(auth)).toBe("business")
  expect(extractAccountId({ ...auth, accountId: undefined })).toBe("workspace-1")
  expect(extractAccountId({ ...auth, accountId: "explicit" })).toBe("explicit")
})
test("accepts legacy flat claims and nested profile email", () => {
  const auth = { ...credential(), accountId: undefined, access: jwt({
    "https://api.openai.com/profile": { email: "profile@example.test" },
    "https://api.openai.com/auth.chatgpt_plan_type": "team",
    "https://api.openai.com/auth.chatgpt_account_id": "old-workspace",
  }) }
  expect([extractEmail(auth), extractPlan(auth), extractAccountId(auth)]).toEqual(["profile@example.test", "team", "old-workspace"])
})
test("malformed and non-object JWT payloads produce empty metadata", () => {
  for (const token of ["opaque", "a.b", "a.%.c", jwt(null), jwt([]), jwt(42), jwt("text")]) {
    expect(parseJwtClaims(token)).toEqual({})
    expect(extractEmail({ ...credential(), access: token })).toBeUndefined()
  }
})
test("identity survives refresh rotation without merging users or workspaces", () => {
  const original = entryFromAuth(credential())
  expect(sameAccount(original, entryFromAuth(credential("rotated")))).toBe(true)
  expect(sameAccount(original, entryFromAuth(credential("other", "user-2")))).toBe(false)
  expect(sameAccount(original, entryFromAuth(credential("other", "user-1", "workspace-2")))).toBe(false)
  expect(sameAccount(original, entryFromAuth({ ...credential("other"), enterpriseUrl: "https://different.test" }))).toBe(false)
})
test("workspace alone and unidentifiable credentials never deduplicate rotated tokens", () => {
  const auth = { ...credential(), access: jwt({}) }
  expect(sameAccount(entryFromAuth(auth), entryFromAuth({ ...auth, refresh: "other" }))).toBe(false)
  expect(sameAccount(entryFromAuth(auth), entryFromAuth(auth))).toBe(true)
  expect(entryFromAuth(auth).key).not.toBe(entryFromAuth(auth).key)
})
test("rejects credentials outside the native schema; clean omits unknown fields", () => {
  for (const expires of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(validAuth({ ...credential(), expires })).toBe(false)
  expect(validAuth({ ...credential(), expires: 0 })).toBe(true)
  expect(validAuth({ ...credential(), refresh: " " })).toBe(false)
  expect(validAuth([])).toBe(false)
  expect(clean({ ...credential(), extra: "discard" } as never)).not.toHaveProperty("extra")
})
