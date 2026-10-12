import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { authPath } from "./paths"
import { readPrivateFile } from "./files"
import { clean, record, validAuth } from "./parse"
import type { AuthGateway, OpenAIAuth } from "./types"

export class HostError extends Error {
  constructor(message: string) { super(message); this.name = "HostError" }
}

export function data<T>(result: { data?: T; error?: unknown }, message: string): T {
  if (result.error != null || result.data === undefined) throw new HostError(message)
  return result.data
}

export function success(result: { error?: unknown }, message: string) {
  if (result.error != null) throw new HostError(message)
}

export async function readActiveAuth(file: string): Promise<OpenAIAuth | undefined> {
  const raw = await readPrivateFile(file)
  if (raw === undefined) return undefined
  let root: Record<string, unknown> | undefined
  try { root = record(JSON.parse(raw)) } catch { /* Leave malformed credentials intact. */ }
  if (!root) throw new HostError("OpenCode auth.json is malformed; repair it before switching accounts")
  if (root.openai === undefined) return undefined
  if (record(root.openai)?.type !== "oauth") return undefined
  if (!validAuth(root.openai)) throw new HostError("OpenCode contains invalid OpenAI OAuth credentials")
  return clean(root.openai)
}

export type HostClient = Pick<OpencodeClient, "path" | "file" | "auth" | "instance" | "provider" | "session">

// The 1.18/1.19 API has no public credential-read endpoint. Verify a directly launched local TUI.
export class LocalAuthGateway implements AuthGateway {
  private verifiedDirectory?: string
  constructor(private client: () => HostClient, readonly file = authPath(), private environment = {
    args: process.argv, home: process.env.OPENCODE_TEST_HOME ?? os.homedir(),
    authContent: process.env.OPENCODE_AUTH_CONTENT,
  }) {}

  async assertAvailable() {
    if (this.environment.args.includes("attach")) {
      throw new HostError("Account switching supports local OpenCode only. Start opencode directly instead of attach.")
    }
    if (this.environment.authContent) {
      throw new HostError("Accounts are controlled by OPENCODE_AUTH_CONTENT. Remove that override before using /switch.")
    }
    const client = this.client()
    const host = data(await client.path.get({}, { signal: AbortSignal.timeout(8_000) }), "Could not verify the OpenCode environment")
    if (host.home !== this.environment.home) throw new HostError("OpenCode is using a different home directory; local account switching is unavailable")
    if (this.verifiedDirectory === host.directory) return
    let probe: string | undefined
    try {
      probe = await fs.mkdtemp(path.join(host.directory, ".opencode-auth-switch-probe-"))
      const nonce = randomUUID()
      await fs.writeFile(path.join(probe, "proof.txt"), nonce, { mode: 0o600 })
      const response = data(await client.file.read({ path: path.relative(host.directory, path.join(probe, "proof.txt")) }, {
        signal: AbortSignal.timeout(8_000),
      }), "Could not verify local access to OpenCode")
      if (response.content !== nonce) throw new HostError("OpenCode is connected to a different filesystem; account switching is unavailable")
      this.verifiedDirectory = host.directory
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError("Could not verify local OpenCode access. The current project must be writable to use /switch.")
    } finally {
      if (probe) await fs.rm(probe, { recursive: true, force: true })
    }
  }

  async read() {
    await this.assertAvailable()
    return readActiveAuth(this.file)
  }
  async set(auth: OpenAIAuth, signal?: AbortSignal) {
    await this.assertAvailable()
    signal?.throwIfAborted()
    success(await this.client().auth.set({ providerID: "openai", auth: clean(auth) }, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }), "OpenCode rejected the account switch")
  }
  async refresh() {
    success(await this.client().instance.dispose({}, { signal: AbortSignal.timeout(10_000) }),
      "Credentials were updated, but OpenCode could not refresh. Restart OpenCode before continuing.")
    // The host's server.instance.disposed listener bootstraps the TUI and closes OAuth sockets.
  }
}
