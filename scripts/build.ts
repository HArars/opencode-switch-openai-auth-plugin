import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

process.env.NODE_ENV = "production"

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: false,
  packages: "external",
  plugins: [createSolidTransformPlugin()],
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
