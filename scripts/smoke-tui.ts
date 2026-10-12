import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { AccountStore } from "../src/store"
import { credential } from "../test/auth-fixture"

const executable = Bun.which(Bun.argv[2] ?? "opencode")
if (!executable || !Bun.which("tmux")) throw new Error("Live TUI smoke tests require opencode and tmux")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-switch-live-"))
const socket = path.join(root, "tmux.sock")
const project = path.resolve(import.meta.dir, "..")
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
async function command(args: string[], env?: Record<string, string>) {
  const proc = Bun.spawn(args, { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [status, output, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (status) throw new Error(`Command ${args[0]} failed: ${error.trim()}`)
  return output
}
const tmux = (...args: string[]) => command(["tmux", "-S", socket, ...args])
async function capture(session: string) { return tmux("capture-pane", "-p", "-t", session) }
async function waitFor(session: string, expected: string | string[] | ((frame: string) => boolean)) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const frame = await capture(session)
    const matches = typeof expected === "function" ? expected(frame)
      : (typeof expected === "string" ? [expected] : expected).every(text => frame.includes(text))
    if (matches) return frame
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${expected}. Screen capture: ${await capture(session)}`)
}

try {
  await command([process.execPath, path.join(project, "scripts", "build.ts")])
  const packed = path.join(root, "package.tgz")
  await command([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", packed])
  const packageRoot = path.join(root, "node_modules", "@harars", "opencode-switch-openai-auth-plugin")
  await fs.mkdir(packageRoot, { recursive: true })
  await command(["tar", "-xzf", packed, "--strip-components", "1", "-C", packageRoot])
  // Use exactly the dependency graph installed by the frozen project lockfile.
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    const link = path.join(root, "node_modules", name)
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.symlink(path.join(project, "node_modules", name), link, "junction")
  }
  const entries: Array<[string, string]> = [
    ["source", path.join(project, "src/tui.tsx")], ["built", path.join(project, "dist/tui.js")],
    ["packed", path.join(packageRoot, "dist/tui.js")],
  ]
  for (const [session, entry] of entries) {
    const directory = path.join(root, session!)
    const workspace = path.join(directory, "workspace")
    const data = path.join(directory, "data", "opencode")
    const home = path.join(directory, "home")
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(path.join(workspace, ".opencode"))
    await fs.writeFile(path.join(workspace, ".opencode", "tui.json"), JSON.stringify({ plugin: [pathToFileURL(entry).href] }))
    const store = new AccountStore(path.join(data, "auth-switch"), [])
    const a = credential("fake-live-a", "alice", "test-workspace", Date.now() + 3_600_000)
    const b = credential("fake-live-b", "bob", "test-workspace", Date.now() + 3_600_000)
    await store.save(a)
    await store.save(b)
    await fs.writeFile(path.join(data, "auth.json"), JSON.stringify({ openai: a, unrelated: { type: "api", key: "fake-unrelated" } }), { mode: 0o600 })
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
      && !/TOKEN|SECRET|PASSWORD|API_KEY|OPENCODE_AUTH_CONTENT|OPENCODE_CONFIG/.test(entry[0])))
    Object.assign(env, {
      OPENCODE_TEST_HOME: home, XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_TERMINAL_TITLE: "true", TERM: "xterm-256color",
    })
    await command(["tmux", "-S", socket, "new-session", "-d", "-s", session!, "-x", "120", "-y", "40",
      "exec " + shellQuote(executable) + " " + shellQuote(workspace)], env)
    await tmux("set-option", "-t", session!, "remain-on-exit", "on")
    await waitFor(session!, "ctrl+p commands")
    await sleep(1_000)
    await tmux("send-keys", "-t", session!, "-l", "/switch")
    await waitFor(session!, "Sign in, switch, or remove saved OpenAI accounts")
    await tmux("send-keys", "-t", session!, "Enter")
    const picker = await waitFor(session!, ["Switch OpenAI account", "alice@example.test", "bob@example.test"])
    if (!picker.includes("alice@example.test") || !picker.includes("bob@example.test")) throw new Error("Saved accounts were not rendered")
    // Search selects the saved account independently of the position of the login action.
    await tmux("send-keys", "-t", session!, "-l", "bob@example.test")
    await sleep(300)
    await tmux("send-keys", "-t", session!, "Enter")
    const deadline = Date.now() + 10_000
    while (JSON.parse(await fs.readFile(path.join(data, "auth.json"), "utf8")).openai.refresh !== b.refresh) {
      if (Date.now() > deadline) throw new Error("Native account switch did not update the isolated credentials")
      await sleep(150)
    }
    const native = JSON.parse(await fs.readFile(path.join(data, "auth.json"), "utf8"))
    if (native.unrelated?.key !== "fake-unrelated") throw new Error("Unrelated provider changed")
    await waitFor(session!, "Switched OpenAI account")
    if (!(await store.list()).accounts.find(account => account.auth.refresh === b.refresh)?.lastUsedAt) {
      throw new Error("Account usage history was not persisted")
    }
    await tmux("send-keys", "-t", session!, "C-p")
    await waitFor(session!, "Commands")
    await tmux("send-keys", "-t", session!, "-l", "Switch OpenAI account")
    await sleep(300)
    await tmux("send-keys", "-t", session!, "Enter")
    await waitFor(session!, ["Switch OpenAI account", "alice@example.test", "bob@example.test"])
    await tmux("send-keys", "-t", session!, "-l", "Remove saved account")
    await waitFor(session!, frame => frame.includes("Switch OpenAI account") && frame.includes("Remove saved account")
      && !frame.includes("alice@example.test") && !frame.includes("bob@example.test"))
    await tmux("send-keys", "-t", session!, "Enter")
    await waitFor(session!, ["Remove saved account", "alice@example.test", "bob@example.test"])
    await tmux("send-keys", "-t", session!, "-l", "bob@example.test")
    await waitFor(session!, frame => frame.includes("Remove saved account") && frame.includes("bob@example.test")
      && !frame.includes("alice@example.test"))
    await tmux("send-keys", "-t", session!, "Enter")
    const confirmation = await waitFor(session!, ["Remove bob@example.test", "Confirm"])
    await fs.writeFile(path.join(directory, "confirmation.txt"), confirmation)
    await tmux("send-keys", "-t", session!, "Enter")
    await waitFor(session!, "Saved account removed")
    if ((await store.list()).accounts.length !== 1) throw new Error("Native confirmation did not remove the saved record")
    if (JSON.parse(await fs.readFile(path.join(data, "auth.json"), "utf8")).openai.refresh !== b.refresh) {
      throw new Error("Removing the saved account changed the native login")
    }
    await tmux("send-keys", "-t", session!, "Escape")
    await fs.writeFile(path.join(directory, "picker.txt"), picker)
    console.log(JSON.stringify({ session, host: (await command([executable, "--version"], env)).trim(), picker: true, nativeSwitch: true, nativeRemoval: true, activeLoginPreserved: true, unrelatedProviderPreserved: true }))
    await tmux("kill-session", "-t", session!)
  }
  console.log(`Isolated TUI evidence: ${root}`)
} finally {
  await tmux("kill-server").catch(() => {})
}
