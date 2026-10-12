import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AccountStore } from "../src/store"
import type { AuthGateway, OpenAIAuth } from "../src/types"

export async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-switch-test-"))
  const store = new AccountStore(path.join(root, "accounts"), [])
  let current: OpenAIAuth | undefined
  const gateway: AuthGateway = {
    assertAvailable: async () => {},
    read: async () => current && structuredClone(current),
    set: async auth => { current = structuredClone(auth) },
    refresh: async () => {},
  }
  return {
    root, store, gateway,
    setCurrent(auth?: OpenAIAuth) { current = auth && structuredClone(auth) },
    getCurrent() { return current },
    async [Symbol.asyncDispose]() { await fs.rm(root, { recursive: true, force: true }) },
  }
}
