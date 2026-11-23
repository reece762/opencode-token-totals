import { createMemo, createSignal, createUniqueId, For, onCleanup, Show, Suspense, lazy } from "solid-js"
import {
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Style,
  type MenuItem as MenuItemType,
  type PanelTab,
} from "@opencode/plugin/gui"
import { definition } from "./definition"
import panelCss from "./panel.css?inline"
import { refresh } from "./refresh"
import { emptyVault } from "./store"

const TokenTotalsPanel = lazy(() => import("./panel"))

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  ctx.add(Style, panelCss)

  const vault = () => ctx.stores.vault
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal<{ done: number; total: number; day: string }>()
  const [notice, setNotice] = createSignal<string>()
  let running = false
  let lastLook = 0

  /** A routine look refetches only the tail, so it is cheap to repeat. */
  const lookIntervalMs = 10 * 60_000

  const clients = () =>
    ctx
      .servers
      .list()
      .flatMap((id) => {
        const server = ctx.servers.get(id)
        return server ? [server.client] : []
      })

  const run = async (full: boolean) => {
    if (running) return
    running = true
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await refresh(
        {
          clients,
          read: () => vault().value,
          write: (next) => vault().set(next),
        },
        {
          full,
          onProgress: (done, total, day) => setProgress({ done, total, day }),
        },
      )
      if (result.failed.length > 0) setNotice(`${result.failed.length} days could not be read`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setProgress(undefined)
      setBusy(false)
      running = false
    }
  }

  /**
   * The panel asks for a look every time it opens, and once at startup if it is
   * already open. A look refetches only today and yesterday, so the whole history
   * is read once and afterwards costs two requests.
   */
  const look = () => {
    if (!vault().ready()) return
    if (Date.now() - lastLook < lookIntervalMs) return
    lastLook = Date.now()
    void run(false)
  }

  const start = setInterval(() => {
    if (!ctx.layout.ready()) return
    clearInterval(start)
    look()
  }, 250)
  onCleanup(() => clearInterval(start))
  const tab: PanelTab = {
    id: "totals",
    get title() {
      return ctx.t("panel.title")
    },
    closable: "hover",
  }

  ctx.add(Panel, {
    id: "totals",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("panel.title")
      },
      order: 41,
      kind: "menu",
      icon: "window-analytics",
    },
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render: () => (
      <Suspense fallback={<div data-slot="token-scope">{ctx.t("panel.loading")}</div>}>
        <TokenTotalsPanel
          onLook={() => void run(false)}
          onRefresh={() => void run(true)}
          busy={busy}
          progress={progress}
          notice={notice}
        />
      </Suspense>
    ),
  })

  ctx.add(MenuItem, (): MenuItemType | undefined => {
    const session = ctx.sessions.current()
    return {
      menu: "session.panel",
      id: "totals",
      title: ctx.t("panel.menuOpen"),
      icon: "window-analytics",
      order: 30,
      opened: !!session && ctx.layout.state(`${ctx.id}:${tab.id}`, session) !== "closed",
      run: () => {
        if (session) ctx.layout.open(`${ctx.id}:${tab.id}`, session)
      },
    }
  })

  ctx.add(SettingsPage, {
    id: "token-totals",
    icon: "window-analytics",
    get title() {
      return ctx.t("settings.title")
    },
    render: () => (
      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section" aria-label={ctx.t("settings.section.data")}>
          <h3 class="settings-section-title">{ctx.t("settings.section.data")}</h3>
          <div data-component="settings-list">
            <div data-component="settings-row">
              <div data-slot="settings-row-copy">
                <div data-slot="settings-row-title">{ctx.t("settings.clear")}</div>
                <div data-slot="settings-row-description">{ctx.t("settings.clearDescription")}</div>
              </div>
              <div data-slot="settings-row-control">
                <ctx.ui.Button
                  variant="neutral"
                  size="small"
                  disabled={busy()}
                  onClick={() => {
                    ctx.storage.remove("vault", { scope: "global" })
                    lastLook = 0
                    void run(true)
                  }}
                >
                  {ctx.t("settings.clear")}
                </ctx.ui.Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    ),
  })
}

export default Plugin.define({ ...definition, setup })
