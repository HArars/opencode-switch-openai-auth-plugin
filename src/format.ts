import type { StoredAccount } from "./types"

function short(id?: string) {
  if (!id) return
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-4)}`
}

export function accountTitle(account: StoredAccount) {
  return account.email || account.accountId || account.id
}

export function accountDescription(account: StoredAccount, current: boolean) {
  return short(account.accountId)
}

export function accountFooter(current: boolean) {
  return current ? "Current" : undefined
}

export function loginTitle() {
  return "login"
}

export function logoutTitle(has: boolean) {
  return has ? "logout" : "logout unavailable"
}
