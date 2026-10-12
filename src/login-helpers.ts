import type { OAuthAuthz } from "./types"

export async function clip(value: string) {
  let copied = false
  if (process.stdout.isTTY) {
    const osc52 = "\x1b]52;c;" + Buffer.from(value).toString("base64") + "\x07"
    const sequence = process.env.TMUX ? "\x1bPtmux;\x1b" + osc52 + "\x1b\\" : osc52
    process.stdout.write(sequence)
    copied = true
  }
  const commands = process.platform === "darwin" ? [["pbcopy"]]
    : process.platform === "win32" ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  for (const cmd of commands) {
    try {
      const child = Bun.spawn({ cmd, stdin: "pipe", stdout: "ignore", stderr: "ignore", timeout: 1_500 })
      try {
        child.stdin.write(value)
        await child.stdin.end()
        if (await child.exited === 0) return true
      } catch {
        child.kill()
        await child.exited
      }
    } catch { /* Try the next available platform clipboard. */ }
  }
  return copied
}
export function target(authorization: OAuthAuthz) {
  return authorization.instructions.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0] ?? authorization.url
}
