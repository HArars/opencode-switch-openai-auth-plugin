import "@opentui/solid/runtime-plugin-support"

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: false,
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
