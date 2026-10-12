/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi, TuiDialogSelectProps, TuiDialogConfirmProps, TuiDialogPromptProps } from "@opencode-ai/plugin/tui"
import { registerSwitcher } from "../src/tui"
import { loginDialogs } from "../src/login"
import { Operation } from "../src/operation"
import { HostError } from "../src/host"
import type { SwitchAction } from "../src/types"
import { fixture } from "./fixture"
import { credential } from "./auth-fixture"

async function harness() {
  const [view, setView] = createSignal<() => JSX.Element>(() => null)
  let onClose: (() => void) | undefined
  let selection: TuiDialogSelectProps<SwitchAction> | undefined
  let confirmation: TuiDialogConfirmProps | undefined
  let prompt: TuiDialogPromptProps | undefined
  let command: { name: string; slashName: string; run: () => Promise<void> } | undefined
  const lifecycle = new AbortController()
  const disposers: Array<() => void> = []
  const toasts: Array<{ variant: string; message: string; duration?: number }> = []
  let unregisters = 0
  let input = ""
  function close() {
    const previous = onClose
    onClose = undefined
    setView(() => () => null)
    previous?.()
  }
  const api = {
    lifecycle: { signal: lifecycle.signal, onDispose: (callback: () => void) => { disposers.push(callback) } },
    keymap: { registerLayer: (layer: { commands: typeof command[] }) => {
      command = layer.commands[0]
      return () => { unregisters++ }
    } },
    route: { current: { name: "home" } },
    state: { session: { status: () => ({ type: "idle" }) } },
    client: {
      provider: { auth: async () => ({ data: { openai: [] } }) },
      session: { status: async () => ({ data: {} }) },
    },
    ui: {
      toast: (toast: { variant: string; message: string }) => toasts.push(toast),
      dialog: {
        clear: close, setSize() {},
        replace(render: () => JSX.Element, closed?: () => void) {
          const previous = onClose
          onClose = undefined
          previous?.()
          onClose = closed
          setView(() => render)
        },
      },
      DialogSelect(props: TuiDialogSelectProps<SwitchAction>) {
        selection = props
        return <box><text>{props.title}</text>{props.options.map(option => <text>{option.title}</text>)}</box>
      },
      DialogConfirm(props: TuiDialogConfirmProps) {
        confirmation = { ...props,
          onConfirm: () => { props.onConfirm?.(); close() },
          onCancel: () => { props.onCancel?.(); close() },
        }
        return <text>{props.message}</text>
      },
      DialogPrompt(props: TuiDialogPromptProps) {
        prompt = props
        return <box><text>{props.title}</text>{props.description?.()}<input focused onInput={value => { input = value }} /></box>
      },
    },
  } as unknown as TuiPluginApi
  const render = await testRender(() => <box>{view()()}</box>, { width: 100, height: 18 })
  return {
    api, render, toasts, lifecycle,
    selection: () => selection, confirmation: () => confirmation, prompt: () => prompt,
    command: () => command!, input: () => input, unregisters: () => unregisters,
    close, dispose() { lifecycle.abort(); disposers.forEach(dispose => dispose()) },
    async [Symbol.asyncDispose]() { close(); render.renderer.destroy() },
  }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("TUI state did not settle")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test("new keymap command renders saved accounts and applies a selected account", async () => {
  await using f = await fixture()
  await using ui = await harness()
  const a = await f.store.save(credential("a"))
  const b = await f.store.save(credential("b", "user-2"))
  f.setCurrent(a.auth)
  await registerSwitcher(ui.api, f.store, f.gateway)
  expect(ui.command()).toMatchObject({ name: "openai.switch", slashName: "switch" })
  const running = ui.command().run()
  await until(() => ui.selection()?.title === "Switch OpenAI account")
  await ui.render.flush()
  expect(ui.render.captureCharFrame()).toContain("user-1@example.test")
  expect(ui.render.captureCharFrame()).toContain("Remove saved account")
  const selected = ui.selection()!.options.find(option => option.value.type === "account" && option.value.id === b.id)!
  ui.selection()!.onSelect!(selected)
  await running
  expect(f.getCurrent()!.refresh).toBe("b")
  expect(ui.toasts).toContainEqual({ variant: "success", message: "Switched OpenAI account" })
})

test("remove confirmation keeps the native login and refreshes the picker", async () => {
  await using f = await fixture()
  await using ui = await harness()
  const a = await f.store.save(credential())
  const b = await f.store.save(credential("b", "user-2"))
  f.setCurrent(a.auth)
  // Removal affects only saved snapshots and must remain usable while a response is running.
  ui.api.client.session.status = (async () => { throw new Error("must not query status for removal") }) as never
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => ui.selection()?.title === "Switch OpenAI account")
  ui.selection()!.onSelect!(ui.selection()!.options.find(option => option.value.type === "remove")!)
  await until(() => ui.selection()?.title === "Remove saved account")
  const picker = ui.selection()! as unknown as TuiDialogSelectProps<string>
  picker.onSelect!(picker.options.find(option => option.value === b.id)!)
  await until(() => Boolean(ui.confirmation()))
  ui.confirmation()!.onConfirm!()
  await until(() => ui.selection()?.title === "Switch OpenAI account")
  expect((await f.store.list()).accounts.map(account => account.id)).toEqual([a.id])
  expect(f.getCurrent()!.refresh).toBe(a.auth.refresh)
  ui.close()
  await running
})

test("busy and retrying background sessions block switching from the home screen", async () => {
  for (const type of ["busy", "retry"] as const) {
    await using f = await fixture()
    await using ui = await harness()
    const a = await f.store.save(credential("a"))
    const b = await f.store.save(credential("b", "user-2"))
    f.setCurrent(a.auth)
    ui.api.client.session.status = (async () => ({ data: { background: { type } } })) as never
    await registerSwitcher(ui.api, f.store, f.gateway)
    const running = ui.command().run()
    await until(() => Boolean(ui.selection()))
    ui.selection()!.onSelect!(ui.selection()!.options.find(option => option.value.type === "account" && option.value.id === b.id)!)
    await running
    expect(f.getCurrent()!.refresh).toBe("a")
    expect(ui.toasts).toContainEqual({ variant: "error", message: "Wait for all responses in this OpenCode instance to finish before changing accounts.", duration: 8_000 })
    expect((await f.store.list()).accounts.find(account => account.id === b.id)!.lastUsedAt).toBeUndefined()
  }
})

test("status lookup errors block native writes without exposing SDK payloads", async () => {
  await using f = await fixture()
  await using ui = await harness()
  await f.store.save(credential())
  ui.api.client.session.status = (async () => ({ error: { message: "fake-secret-must-not-leak" } })) as never
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(ui.selection()))
  ui.selection()!.onSelect!(ui.selection()!.options[0]!)
  await running
  expect(f.getCurrent()).toBeUndefined()
  expect(ui.toasts).toContainEqual({ variant: "error", message: "Could not verify running sessions. Retry before changing accounts.", duration: 8_000 })
})

test("background generation blocks a new OAuth login before native authorization starts", async () => {
  await using f = await fixture()
  await using ui = await harness()
  ui.api.client.provider.auth = (async () => ({ data: { openai: [{ type: "oauth", label: "Browser" }] } })) as never
  ui.api.client.session.status = (async () => ({ data: { background: { type: "busy" } } })) as never
  let authorizations = 0
  Object.assign(ui.api.client.provider, {
    oauth: { authorize: async () => { authorizations++; return { data: {} } } },
  })
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(ui.selection()))
  ui.selection()!.onSelect!(ui.selection()!.options.find(option => option.value.type === "login")!)
  await running
  expect(authorizations).toBe(0)
  expect(f.getCurrent()).toBeUndefined()
  expect(ui.toasts.map(toast => toast.variant)).toEqual(["error"])
})

test("closing during session verification prevents a late successful status read from switching", async () => {
  await using f = await fixture()
  await using ui = await harness()
  await f.store.save(credential())
  let release!: () => void
  ui.api.client.session.status = (async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { data: {} }
  }) as never
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(ui.selection()))
  ui.selection()!.onSelect!(ui.selection()!.options[0]!)
  await until(() => Boolean(release))
  ui.close()
  release()
  await running
  expect(f.getCurrent()).toBeUndefined()
  expect(ui.toasts).toEqual([])
})

test("closing Loading prevents a late read from reopening the dialog", async () => {
  await using f = await fixture()
  await using ui = await harness()
  let release!: () => void
  f.gateway.assertAvailable = () => new Promise<void>(resolve => { release = resolve })
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(release))
  ui.close()
  release()
  await running
  expect(ui.selection()).toBeUndefined()
  expect(ui.toasts).toEqual([])
})

test("an unrelated host dialog is preserved when it replaces a pending account operation", async () => {
  await using f = await fixture()
  await using ui = await harness()
  let release!: () => void
  f.gateway.assertAvailable = () => new Promise<void>(resolve => { release = resolve })
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(release))
  ui.api.ui.dialog.replace(() => <text>Unrelated host dialog</text>)
  release()
  await running
  await ui.render.flush()
  expect(ui.render.captureCharFrame()).toContain("Unrelated host dialog")
  expect(ui.toasts).toEqual([])
})

test("an unrelated dialog remains open after an accepted switch finishes asynchronously", async () => {
  await using f = await fixture()
  await using ui = await harness()
  await f.store.save(credential())
  let release!: () => void
  f.gateway.set = async auth => {
    await new Promise<void>(resolve => { release = resolve })
    f.setCurrent(auth)
  }
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(ui.selection()))
  ui.selection()!.onSelect!(ui.selection()!.options[0]!)
  await until(() => Boolean(release))
  ui.api.ui.dialog.replace(() => <text>Another host dialog</text>)
  release()
  await running
  await ui.render.flush()
  expect(ui.render.captureCharFrame()).toContain("Another host dialog")
  expect(ui.toasts).toEqual([])
})

test("native switch errors do not emit success and unloading unregisters the command", async () => {
  await using f = await fixture()
  await using ui = await harness()
  await f.store.save(credential())
  f.gateway.set = async () => { throw new HostError("The host refused this switch") }
  await registerSwitcher(ui.api, f.store, f.gateway)
  const running = ui.command().run()
  await until(() => Boolean(ui.selection()))
  ui.selection()!.onSelect!(ui.selection()!.options[0]!)
  await running
  expect(ui.toasts.map(toast => toast.variant)).toEqual(["error"])
  ui.dispose()
  expect(ui.unregisters()).toBe(1)
})

test("authorization code accepts c and suppresses duplicate callback submissions", async () => {
  await using ui = await harness()
  const op = new Operation(ui.lifecycle.signal)
  let submissions = 0
  let release!: () => void
  const pending = loginDialogs(ui.api, op).code("Code login", {
    url: "https://example.test", instructions: "Enter your authorization code", method: "code",
  }, async () => { submissions++; await new Promise<void>(resolve => { release = resolve }) })
  try {
    await until(() => Boolean(ui.prompt()))
    await ui.render.mockInput.typeText("abc123")
    await ui.render.flush()
    expect(ui.input()).toBe("abc123")
    ui.prompt()!.onConfirm!("abc123")
    ui.prompt()!.onConfirm!("abc123")
    expect(submissions).toBe(1)
    release()
    expect(await pending).toBe(true)
  } finally { op.cancel(); op.dispose() }
})

test("unloading a waiting OAuth dialog cancels its promise without later UI changes", async () => {
  await using ui = await harness()
  const op = new Operation(ui.lifecycle.signal)
  let release!: () => void
  const pending = loginDialogs(ui.api, op).wait("Browser login", {
    url: "https://example.test", instructions: "Open your browser", method: "auto",
  }, () => new Promise<void>(resolve => { release = resolve }))
  try {
    await until(() => Boolean(release))
    ui.lifecycle.abort()
    expect(await pending).toBe(false)
    release()
    await ui.render.flush()
    expect(ui.toasts).toEqual([])
  } finally { op.dispose() }
})
