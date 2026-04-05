import type { OAuthAuthz } from "./types"

export async function clip(text: string) {
  let copied = false
  if (process.stdout.isTTY) {
    const base64 = Buffer.from(text).toString("base64")
    const osc52 = `\x1b]52;c;${base64}\x07`
    const seq = process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
    process.stdout.write(seq)
    copied = true
  }

  const cmds = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

  try {
    await Promise.any(
      cmds.map(async (cmd) => {
        const proc = Bun.spawn({
          cmd,
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        })
        await proc.stdin.write(new TextEncoder().encode(text))
        proc.stdin.end()
        const code = await proc.exited
        if (code !== 0) throw new Error("copy failed")
      }),
    )
    return true
  } catch {
    return copied
  }
}

export function target(authz: OAuthAuthz) {
  return authz.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? authz.url
}

export function detail(err: unknown) {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export async function runOAuthCallback(
  callback: (input: { providerID: "openai"; method: number; code?: string }) => Promise<{ error?: unknown }>,
  input: { providerID: "openai"; method: number; code?: string },
) {
  try {
    const res = await callback(input)
    return res.error
      ? { ok: false as const, error: res.error }
      : { ok: true as const }
  } catch (err) {
    return { ok: false as const, error: detail(err) }
  }
}
