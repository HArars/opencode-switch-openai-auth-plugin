import fs from "node:fs/promises"
import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

process.env.NODE_ENV = "production"
const root = path.resolve(import.meta.dir, "..")
const staging = await fs.mkdtemp(path.join(root, ".build-"))
const output = path.join(staging, "output")
const previous = path.join(staging, "previous")
const destination = path.join(root, "dist")

try {
  const result = await Bun.build({
    entrypoints: [path.join(root, "src/index.ts"), path.join(root, "src/tui.tsx")],
    outdir: output, target: "bun", minify: false, packages: "external",
    plugins: [createSolidTransformPlugin()],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("Plugin build failed; previous dist was preserved")
  }
  // Published code is public; credential modes belong only to the saved store.
  await fs.chmod(output, 0o755)
  for (const artifact of result.outputs) await fs.chmod(artifact.path, 0o644)
  let hadPrevious = false
  try {
    await fs.rename(destination, previous)
    hadPrevious = true
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
  }
  try {
    await fs.rename(output, destination)
  } catch (error) {
    if (hadPrevious) await fs.rename(previous, destination)
    throw error
  }
} finally {
  await fs.rm(staging, { recursive: true, force: true })
}
