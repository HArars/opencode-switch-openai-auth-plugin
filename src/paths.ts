import os from "node:os"
import path from "node:path"

export function dataPath() {
  if (process.env.OPENCODE_TEST_HOME) {
    return path.join(process.env.OPENCODE_TEST_HOME, ".local", "share", "opencode")
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode")
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "opencode")
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA
    if (root) return path.join(root, "opencode")
  }
  return path.join(os.homedir(), ".local", "share", "opencode")
}

export function authPath() {
  return path.join(dataPath(), "auth.json")
}

export function storeDir() {
  return path.join(dataPath(), "auth-switch")
}

export function storePath() {
  return path.join(storeDir(), "accounts.json")
}
