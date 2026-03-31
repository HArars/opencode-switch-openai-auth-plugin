/** @jsxImportSource @opentui/solid */
import type { TuiCommand, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { accountDescription, accountFooter, accountTitle, loginTitle, logoutTitle } from "./format"
import { hasLogin, loginOpenAI } from "./login"
import { deleteSavedAccount, listAccounts, switchAccount } from "./store"
import type { StoredAccount, SwitchAction, SwitchOption } from "./types"

let seq = 0

function frame(text: string) {
  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2}>
      <text>{text}</text>
    </box>
  )
}

async function pick(api: Parameters<TuiPlugin>[0], list: StoredAccount[]) {
  return await new Promise<string | null>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogSelect
          title="Remove saved account"
          options={list.map((item) => ({
            title: accountTitle(item),
            value: item.id,
            category: accountDescription(item, false),
          }))}
          onSelect={(item) => resolve(item.value)}
        />
      ),
      () => resolve(null),
    )
  })
}

async function confirm(api: Parameters<TuiPlugin>[0], title: string, message: string) {
  return await new Promise<boolean>((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}

async function remove(api: Parameters<TuiPlugin>[0], list: StoredAccount[]) {
  const id = await pick(api, list)
  if (!id) return
  const item = list.find((row) => row.id === id)
  if (!item) return
  const ok = await confirm(api, "Remove saved account", `Remove ${accountTitle(item)} from saved accounts?`)
  if (!ok) return
  try {
    await deleteSavedAccount(id)
    api.ui.toast({ variant: "success", message: "Saved account removed" })
  } catch {
    api.ui.toast({ variant: "error", message: "Failed to remove saved account" })
  }
}

function options(list: StoredAccount[], current: string | undefined, canLogin: boolean): SwitchOption[] {
  const rows = list.map((item) => ({
    title: accountTitle(item),
    value: { type: "account", id: item.id } as SwitchAction,
    description: accountDescription(item, item.id === current),
    footer: accountFooter(item.id === current),
    category: "Accounts",
  }))
  return [
    ...(canLogin ? [{ title: loginTitle(), value: { type: "login" } as SwitchAction }] : []),
    ...rows,
    ...(list.length
      ? [
          {
            title: logoutTitle(true),
            value: { type: "logout" } as SwitchAction,
            description: "Remove a saved account",
            category: "Actions",
          },
        ]
      : []),
  ]
}

async function open(api: Parameters<TuiPlugin>[0]) {
  const id = ++seq
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => frame("Loading accounts..."))

  const [store, canLogin] = await Promise.all([listAccounts(), hasLogin(api)])
  if (id !== seq) return

  if (!store.ok && store.reason === "malformed") {
    api.ui.toast({ variant: "error", message: "Failed to load account store" })
  }

  const accounts = store.ok ? store.accounts : []
  const current = store.ok ? store.current : undefined
  const rows = options(accounts, current, canLogin)

  if (!rows.length) {
    api.ui.dialog.replace(() => frame("OpenAI login unavailable and no saved accounts found"))
    return
  }

  if (!accounts.length && canLogin) {
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Switch OpenAI account"
        options={rows}
        placeholder="Search"
        onSelect={(item) => void act(api, item.value, accounts)}
      />
    ))
    return
  }

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Switch OpenAI account"
      options={rows}
      placeholder="Search"
      current={current ? ({ type: "account", id: current } as SwitchAction) : undefined}
      onSelect={(item) => void act(api, item.value, accounts)}
    />
  ))
}

async function act(api: Parameters<TuiPlugin>[0], action: SwitchAction, list: StoredAccount[]) {
  if (action.type === "login") {
    const ok = await loginOpenAI(api)
    if (ok) {
      api.ui.toast({ variant: "success", message: "Account saved" })
      await open(api)
    }
    return
  }
  if (action.type === "logout") {
    await remove(api, list)
    await open(api)
    return
  }
  try {
    await switchAccount(action.id)
  } catch {
    api.ui.toast({ variant: "error", message: "Failed to switch account" })
    return
  }

  try {
    const client = api.client as typeof api.client & {
      sync?: { bootstrap?: () => Promise<void> }
    }
    if (typeof api.client.instance.dispose === "function") {
      await api.client.instance.dispose()
    }
    if (typeof client.sync?.bootstrap === "function") {
      await client.sync.bootstrap()
    }
    api.ui.toast({ variant: "success", message: "Switched OpenAI account" })
    api.ui.dialog.clear()
  } catch {
    api.ui.toast({
      variant: "warning",
      message: "Account file was switched, but session refresh failed",
    })
  }
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Switch OpenAI account",
      value: "openai.switch",
      description: "Login, switch, or remove saved OpenAI accounts",
      slash: { name: "switch" },
      onSelect: () => {
        void open(api)
      },
    } satisfies TuiCommand,
  ])
}

export default {
  id: "harars.switch-auth",
  tui,
} satisfies TuiPluginModule & { id: string }
