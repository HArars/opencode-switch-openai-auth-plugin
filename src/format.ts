import type { StoredAccount } from "./types"

function short(value: string) {
  return value.length <= 16 ? value : value.slice(0, 8) + "..." + value.slice(-4)
}
export function accountTitle(account: StoredAccount) {
  return account.email ?? account.identity.userId ?? account.accountId ?? "Account " + short(account.id)
}
export function accountDescription(account: StoredAccount) {
  return [
    account.plan,
    account.accountId ? "workspace " + short(account.accountId) : undefined,
    account.auth.expires <= Date.now() ? "Access token expired; OpenCode refreshes on use" : undefined,
  ].filter(Boolean).join(" · ")
}
export function accountFooter(current: boolean) { return current ? "Current" : undefined }
