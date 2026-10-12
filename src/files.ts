import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import lockfile from "proper-lockfile"

function code(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined
}
export async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Account directory must not be a symbolic link")
  if (process.platform !== "win32") await fs.chmod(directory, 0o700)
}
export async function readPrivateFile(file: string) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile()) throw new Error("Credential storage must be a regular file")
    if (process.platform !== "win32") await fs.chmod(file, 0o600)
    return await fs.readFile(file, "utf8")
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
}
export async function atomicWrite(file: string, content: string) {
  const directory = path.dirname(file)
  const temporary = path.join(directory, "." + path.basename(file) + "." + randomUUID() + ".tmp")
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    await fs.rename(temporary, file)
    if (process.platform !== "win32") {
      const parent = await fs.open(directory, "r")
      try { await parent.sync() } finally { await parent.close() }
    }
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(temporary).catch(error => { if (code(error) !== "ENOENT") throw error })
  }
}
export async function withStoreLock<T>(directory: string, run: (assertOwned: () => void) => Promise<T>): Promise<T> {
  await privateDirectory(directory)
  const file = path.join(await fs.realpath(directory), "accounts.json")
  let compromised: Error | undefined
  const release = await lockfile.lock(file, {
    realpath: false, stale: 30_000, update: 5_000,
    retries: { retries: 30, factor: 1.2, minTimeout: 15, maxTimeout: 250 },
    onCompromised: error => { compromised = error },
  })
  const assertOwned = () => { if (compromised) throw new Error("Account store lock was lost; retry the operation") }
  try {
    const result = await run(assertOwned)
    assertOwned()
    return result
  } finally { await release() }
}
