import "@opentui/solid/runtime-plugin-support"

process.env.NODE_ENV = "production"

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
