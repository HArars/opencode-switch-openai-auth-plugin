import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { clip, target } from "../src/login-helpers"

afterEach(() => mock.restore())
test("device authorization copies the code; browser authorization copies the URL", () => {
  expect(target({ url: "https://example.test/login", method: "auto", instructions: "Use code ABCD-12345" })).toBe("ABCD-12345")
  expect(target({ url: "https://example.test/login", method: "auto", instructions: "Open your browser" })).toBe("https://example.test/login")
})
test("clipboard fallback is sequential and stops after the first success", async () => {
  const tty = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
  let running = 0
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
    stdin: { write() {}, end() {} },
    exited: Promise.resolve(++running === 1 ? 1 : 0), kill() {},
  }) as never)
  try {
    expect(await clip("copy me")).toBe(process.platform === "linux")
    expect(spawn).toHaveBeenCalledTimes(process.platform === "linux" ? 2 : 1)
  } finally { Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true }) }
})
