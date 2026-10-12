/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import { accountDescription, accountFooter, accountTitle } from "./format"
import { authMethods, loginOpenAI } from "./login-flow"
import { clearOwnedDialog, loginDialogs, replaceDialog, requestDialog } from "./login"
import { data, LocalAuthGateway, HostError } from "./host"
import { Operation } from "./operation"
import { AccountStore, StoreError } from "./store"
import type { AuthGateway, StoredAccount, SwitchAction } from "./types"

function frame(message: string) {
  return <box padding={2}><text>{message}</text></box>
}
function errorMessage(error: unknown) {
  // Never show serialized SDK requests, responses, headers, or token payloads.
  return error instanceof StoreError || error instanceof HostError
    ? error.message : "Could not complete the account operation. Check local storage access and retry."
}
export function switchOptions(accounts: StoredAccount[], current?: string, canLogin = false): TuiDialogSelectOption<SwitchAction>[] {
  return [
    ...(canLogin ? [{ title: "Sign in with OpenAI", value: { type: "login" } as SwitchAction, category: "Actions" }] : []),
    ...accounts.map(account => ({
      title: accountTitle(account), value: { type: "account", id: account.id } as SwitchAction,
      description: accountDescription(account), footer: accountFooter(account.id === current), category: "Accounts",
    })),
    ...(accounts.length ? [{
      title: "Remove saved account", value: { type: "remove" } as SwitchAction,
      description: "Keeps the active OpenCode login", category: "Actions",
    }] : []),
  ]
}
async function removeAccount(api: TuiPluginApi, operation: Operation, store: AccountStore, accounts: StoredAccount[]) {
  const id = await requestDialog(api, operation, finish => <api.ui.DialogSelect
    title="Remove saved account"
    options={accounts.map(account => ({ title: accountTitle(account), value: account.id, description: accountDescription(account) }))}
    onSelect={item => finish(item.value)}
  />)
  operation.check()
  const target = accounts.find(account => account.id === id)
  if (!target) return
  const confirmed = await requestDialog(api, operation, finish => <api.ui.DialogConfirm
    title="Remove saved account"
    message={"Remove " + accountTitle(target) + " from saved accounts? The current login will remain active."}
    onConfirm={() => finish(true)} onCancel={() => finish(false)}
  />)
  operation.check()
  if (!confirmed) return
  await store.remove(target.id)
  if (operation.active) api.ui.toast({ variant: "success", message: "Saved account removed" })
}
async function assertIdle(api: TuiPluginApi, operation: Operation) {
  const route = api.route.current
  if (route.name === "session" && typeof route.params?.sessionID === "string") {
    const status = api.state.session.status(route.params.sessionID)
    if (status && status.type !== "idle") throw new HostError("Wait for all responses in this OpenCode instance to finish before changing accounts.")
  }
  // The home screen and other sessions can hide an in-flight request using these credentials.
  const statuses = data(await api.client.session.status({}, {
    signal: AbortSignal.any([operation.signal, AbortSignal.timeout(8_000)]),
  }), "Could not verify running sessions. Retry before changing accounts.")
  operation.check()
  if (Object.values(statuses).some(status => status.type !== "idle")) {
    throw new HostError("Wait for all responses in this OpenCode instance to finish before changing accounts.")
  }
}
export async function registerSwitcher(api: TuiPluginApi, store: AccountStore, gateway: AuthGateway) {
  let operation: Operation | undefined
  async function open() {
    if (operation?.active) {
      api.ui.toast({ variant: "info", message: "Finish or close the current account dialog first" })
      return
    }
    const currentOperation = new Operation(api.lifecycle.signal)
    operation = currentOperation
    try {
      api.ui.dialog.setSize("large")
      const abort = () => clearOwnedDialog(api, currentOperation)
      currentOperation.signal.addEventListener("abort", abort, { once: true })
      try {
        while (currentOperation.active) {
          replaceDialog(api, currentOperation, () => frame("Loading accounts..."))
          await gateway.assertAvailable()
          currentOperation.check()
          const [listing, methods] = await Promise.all([
            store.list(() => gateway.read()),
            authMethods(api.client, currentOperation.signal).catch(() => undefined),
          ])
          currentOperation.check()
          if (!methods) api.ui.toast({ variant: "warning", message: "Could not load login methods. Saved accounts are still available." })
          for (const warning of listing.warnings) api.ui.toast({ variant: "info", message: warning, duration: 8_000 })
          const rows = switchOptions(listing.accounts, listing.current, methods?.some(method => method.type === "oauth"))
          if (!rows.length) {
            api.ui.toast({ variant: "info", message: "No saved accounts and no OpenAI OAuth login methods are available." })
            break
          }
          const selected = await requestDialog<SwitchAction>(api, currentOperation, finish => <api.ui.DialogSelect
            title="Switch OpenAI account" placeholder="Search accounts" options={rows}
            current={listing.current ? { type: "account", id: listing.current } : undefined}
            onSelect={item => finish(item.value)}
          />)
          currentOperation.check()
          if (!selected) break
          if (selected.type === "remove") {
            await removeAccount(api, currentOperation, store, listing.accounts)
            continue
          }
          await assertIdle(api, currentOperation)
          if (selected.type === "login") {
            const result = await loginOpenAI(api.client, gateway, store, loginDialogs(api, currentOperation), currentOperation)
            currentOperation.check()
            if (result) api.ui.toast({
              variant: result.refreshed ? "success" : "warning",
              message: result.refreshed ? "Account saved and active" : "Account saved and active, but refresh failed. Restart OpenCode before continuing.",
            })
            continue
          }
          const result = await store.switch(selected.id, gateway, currentOperation.signal)
          currentOperation.check()
          let refreshed = true
          try { await gateway.refresh() } catch { refreshed = false }
          currentOperation.check()
          api.ui.toast({
            variant: refreshed && result.historySaved ? "success" : "warning",
            message: !refreshed ? "Credentials switched, but refresh failed. Restart OpenCode before continuing."
              : !result.historySaved ? "Account switched, but usage history could not be saved." : "Switched OpenAI account",
          })
          break
        }
      } finally { currentOperation.signal.removeEventListener("abort", abort) }
    } catch (error) {
      if (currentOperation.active) api.ui.toast({ variant: "error", message: errorMessage(error), duration: 8_000 })
    } finally {
      currentOperation.cancel()
      currentOperation.dispose()
      if (operation === currentOperation) { operation = undefined; clearOwnedDialog(api, currentOperation) }
    }
  }
  const unregister = api.keymap.registerLayer({
    commands: [{
      namespace: "palette", name: "openai.switch", title: "Switch OpenAI account",
      desc: "Sign in, switch, or remove saved OpenAI accounts", slashName: "switch",
      run: () => open(),
    }],
  })
  api.lifecycle.onDispose(() => { operation?.cancel(); unregister() })
}
export const tui: TuiPlugin = async api => registerSwitcher(api, new AccountStore(), new LocalAuthGateway(() => api.client))
export default { id: "harars.switch-auth", tui } satisfies TuiPluginModule
