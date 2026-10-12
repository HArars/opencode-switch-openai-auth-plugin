/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import { createSignal, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { LoginDialogs } from "./login-flow"
import type { OAuthAuthz } from "./types"
import type { Operation } from "./operation"
import { clip, target } from "./login-helpers"

const owners = new WeakMap<TuiPluginApi, Operation>()
const transitions = new WeakSet<Operation>()
const acceptedCloses = new WeakSet<Operation>()

export function replaceDialog(api: TuiPluginApi, operation: Operation, render: () => JSX.Element, onClose?: () => void) {
  if (!operation.active) return
  transitions.add(operation)
  try {
    api.ui.dialog.replace(render, () => {
      if (owners.get(api) === operation) owners.delete(api)
      if (!transitions.has(operation) && !acceptedCloses.has(operation)) operation.cancel()
      acceptedCloses.delete(operation)
      onClose?.()
    })
    owners.set(api, operation)
  } finally { transitions.delete(operation) }
}

export function clearOwnedDialog(api: TuiPluginApi, operation: Operation) {
  if (owners.get(api) === operation) api.ui.dialog.clear()
}

export function requestDialog<T>(
  api: TuiPluginApi, operation: Operation,
  render: (finish: (value: T) => void, fail: (error: unknown) => void) => JSX.Element,
): Promise<T | null> {
  if (!operation.active) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => { settled = true; operation.signal.removeEventListener("abort", abort) }
    const finish = (value: T | null) => {
      if (settled) return
      cleanup()
      // Native DialogConfirm clears synchronously after invoking the accepted callback.
      acceptedCloses.add(operation)
      queueMicrotask(() => acceptedCloses.delete(operation))
      resolve(value)
    }
    const fail = (error: unknown) => { if (!settled) { cleanup(); reject(error) } }
    const abort = () => finish(null)
    operation.signal.addEventListener("abort", abort, { once: true })
    replaceDialog(api, operation, () => render(finish, fail), () => finish(null))
  })
}

function bind(api: TuiPluginApi, operation: Operation, authorization: OAuthAuthz) {
  useKeyboard(event => {
    if (event.name !== "y" || !event.ctrl || event.meta) return
    event.preventDefault()
    event.stopPropagation()
    void clip(target(authorization)).then(ok => {
      if (operation.active) api.ui.toast({
        variant: ok ? "info" : "warning", message: ok ? "Copied to clipboard" : "Could not copy to clipboard",
      })
    })
  })
}
function details(authorization: OAuthAuthz, error?: string) {
  return <box gap={1}>
    <text>{authorization.instructions}</text>
    <text>{authorization.url}</text>
    <text>Ctrl+y copies the login link or device code</text>
    {error ? <text>{error}</text> : null}
  </box>
}
function CodeView(props: {
  api: TuiPluginApi; operation: Operation; title: string; authorization: OAuthAuthz
  submit: (code: string) => Promise<void>; finish: (value: boolean) => void
}) {
  bind(props.api, props.operation, props.authorization)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  return <props.api.ui.DialogPrompt
    title={props.title} placeholder="Authorization code" busy={busy()} busyText="Authorizing..."
    description={() => details(props.authorization, error())}
    onConfirm={value => {
      if (busy() || !props.operation.active || !value.trim()) return
      setBusy(true)
      void props.submit(value.trim()).then(() => props.finish(true), () => {
        if (props.operation.active) { setError("Authorization failed. Check the code and retry."); setBusy(false) }
      })
    }}
    onCancel={() => props.operation.cancel()}
  />
}
function WaitView(props: {
  api: TuiPluginApi; operation: Operation; title: string; authorization: OAuthAuthz
  submit: () => Promise<void>; finish: (value: boolean) => void; fail: (error: unknown) => void
}) {
  bind(props.api, props.operation, props.authorization)
  onMount(() => { void props.submit().then(() => props.finish(true), props.fail) })
  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
    <text attributes={TextAttributes.BOLD}>{props.title}</text>
    {details(props.authorization)}
    <text>Waiting for authorization... Escape cancels this dialog.</text>
  </box>
}
export function loginDialogs(api: TuiPluginApi, operation: Operation): LoginDialogs {
  return {
    choose: methods => requestDialog(api, operation, finish => <api.ui.DialogSelect
      title="Select auth method"
      options={methods.map((method, index) => ({ title: method.label, value: index }))}
      onSelect={item => finish(item.value)}
    />),
    prompt: (title, prompt) => requestDialog(api, operation, finish => prompt.type === "select"
      ? <api.ui.DialogSelect title={prompt.message}
          options={(prompt.options ?? []).map(option => ({ title: option.label, value: option.value, description: option.hint }))}
          onSelect={item => finish(item.value)}
        />
      : <api.ui.DialogPrompt title={title} placeholder={prompt.placeholder}
          description={() => <text>{prompt.message}</text>}
          onConfirm={finish} onCancel={() => operation.cancel()}
        />),
    code: async (title, authorization, submit) => Boolean(await requestDialog<boolean>(api, operation, finish =>
      <CodeView api={api} operation={operation} title={title} authorization={authorization} submit={submit} finish={finish} />
    )),
    wait: async (title, authorization, submit) => Boolean(await requestDialog<boolean>(api, operation, (finish, fail) =>
      <WaitView api={api} operation={operation} title={title} authorization={authorization} submit={submit} finish={finish} fail={fail} />
    )),
  }
}
