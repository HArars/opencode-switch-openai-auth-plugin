import os from "node:os"
import path from "node:path"
import { xdgData } from "xdg-basedir"

// Match OpenCode Global.Path.data, including xdg-basedir's import-time resolution.
export function dataPath() {
  if (!xdgData) throw new Error("OpenCode data directory is unavailable")
  return path.join(xdgData, "opencode")
}
export function authPath() { return path.join(dataPath(), "auth.json") }
export function storeDir() { return path.join(dataPath(), "auth-switch") }
export function legacyStorePaths() {
  const roots = process.platform === "darwin"
    ? [path.join(os.homedir(), "Library", "Application Support", "opencode")]
    : process.platform === "win32"
      ? [process.env.LOCALAPPDATA, process.env.APPDATA].filter((root): root is string => Boolean(root)).map(root => path.join(root, "opencode"))
      : []
  return [...new Set(roots.map(root => path.join(root, "auth-switch", "accounts.json")))]
    .filter(file => file !== path.join(storeDir(), "accounts.json"))
}
