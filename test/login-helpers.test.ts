import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { clip, runOAuthCallback } from "../src/login-helpers"

afterEach(() => {
  mock.restore()
})

test("runOAuthCallback returns false when callback rejects", async () => {
  const callback = mock(async () => {
    throw new Error("boom")
  })

  const ok = await runOAuthCallback(callback, { providerID: "openai", method: 0 })

  expect(ok).toBe(false)
  expect(callback).toHaveBeenCalledTimes(1)
})

test("clip returns false when all copy methods fail without tty", async () => {
  const tty = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  })

  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
    stdin: {
      write: async () => {},
      end: () => {},
    },
    exited: Promise.resolve(1),
  }) as never)

  const ok = await clip("copy me")

  expect(ok).toBe(false)
  expect(spawn).toHaveBeenCalled()

  Object.defineProperty(process.stdout, "isTTY", {
    value: tty,
    configurable: true,
  })
})
