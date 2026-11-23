import { createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { definition } from "./definition"
import { aggregate, allTokens, addDays, outputVolume, sumRows, todayKey, type ModelRow } from "./stats"
import { emptyVault } from "./store"
import { count, compact, percent, shortDay, when } from "./format"

const ranges = [
  { id: "24h", label: "panel.range.24h", days: 1 },
  { id: "7d", label: "panel.range.7d", days: 7 },
  { id: "30d", label: "panel.range.30d", days: 30 },
  { id: "all", label: "panel.range.all", days: undefined },
] as const

type RangeID = (typeof ranges)[number]["id"]

export interface TokenTotalsPanelProps {
  onLook(): void
  onRefresh(): void
  busy: () => boolean
  progress: () => { done: number; total: number; day: string } | undefined
  notice: () => string | undefined
}

export default function TokenTotalsPanel(props: TokenTotalsPanelProps) {
  const ctx = usePlugin<typeof definition>()
  const groupName = createUniqueId()
  const [range, setRange] = createSignal<RangeID>("30d")
  const [now, setNow] = createSignal(Date.now())
  const [selected, setSelected] = createSignal<string[]>([])
  const [provider, setProvider] = createSignal("")
  const selectId = createUniqueId()
  const timer = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(timer))

  // Reading the panel is what asks for a look, so a closed panel costs nothing.
  props.onLook()

  const days = () => (ctx.stores.vault.value ?? emptyVault).days
  const earliest = () => (ctx.stores.vault.value ?? emptyVault).earliest
  const rangeDays = () => ranges.find((entry) => entry.id === range())?.days

  const from = createMemo(() => {
    const span = rangeDays()
    return span === undefined ? earliest() : addDays(todayKey(now()), -(span - 1))
  })

  const rows = createMemo(() => aggregate(days(), { from: from() }))
  const anyRows = createMemo(() => rows().some((row) => allTokens(row) > 0))
  const generation = createMemo(() => rows().reduce((total, row) => total + outputVolume(row), 0))

  /** One entry per provider present in the range, with its model count. */
  const providers = createMemo(() => {
    const list = new Map<string, { id: string; models: number; generation: number }>()
    for (const row of rows()) {
      const entry = list.get(row.providerID) ?? { id: row.providerID, models: 0, generation: 0 }
      entry.models += 1
      entry.generation += outputVolume(row)
      list.set(row.providerID, entry)
    }
    return [...list.values()].sort((a, b) => a.id.localeCompare(b.id))
  })

  // A provider that leaves the range falls back to every provider.
  const activeProvider = createMemo(() =>
    providers().some((entry) => entry.id === provider()) ? provider() : "",
  )

  /** The rows the model list shows: the provider filter applies only here. */
  const visible = createMemo(() => {
    const id = activeProvider()
    return id === "" ? rows() : rows().filter((row) => row.providerID === id)
  })

  // Selection spans every provider; only a model that left the range drops out.
  const keys = createMemo(() => {
    const live = new Set(rows().map((row) => row.key))
    return selected().filter((key) => live.has(key))
  })

  const chosen = createMemo(() => rows().filter((row) => keys().includes(row.key)))
  const totals = createMemo(() => sumRows(chosen()))

  const visibleKeys = createMemo(() => visible().map((row) => row.key))
  const allVisibleSelected = createMemo(
    () => visibleKeys().length > 0 && visibleKeys().every((key) => keys().includes(key)),
  )

  const toggle = (key: string, on: boolean) => {
    setSelected((current) =>
      on ? (current.includes(key) ? current : [...current, key]) : current.filter((entry) => entry !== key),
    )
  }

  /** Selects every model the filter shows and keeps selections from other providers. */
  const selectAll = () =>
    setSelected((current) => {
      const next = [...current]
      for (const key of visibleKeys()) if (!next.includes(key)) next.push(key)
      return next
    })

  /** Clears only the models the filter shows, leaving other providers alone. */
  const clear = () =>
    setSelected((current) => {
      const shown = new Set(visibleKeys())
      return current.filter((key) => !shown.has(key))
    })

  const cachedCount = () => days().length
  const lastFetch = createMemo(() => {
    const latest = days().reduce((at, day) => Math.max(at, day.fetchedAt), 0)
    return latest > 0 ? when(latest) : undefined
  })

  return (
    <div data-component="token-totals">
      <p data-slot="token-scope">{ctx.t("panel.scope")}</p>

      <div data-slot="token-bar">
        <div data-slot="token-segments" role="radiogroup" aria-label={ctx.t("panel.models")}>
          <For each={ranges}>
            {(entry) => (
              <label data-slot="token-segment">
                <input
                  type="radio"
                  name={groupName}
                  value={entry.id}
                  checked={range() === entry.id}
                  onChange={() => setRange(entry.id)}
                />
                <span>{ctx.t(entry.label)}</span>
              </label>
            )}
          </For>
        </div>
        <div data-slot="token-refresh">
          <span data-slot="token-cache-note" title={lastFetch() ? ctx.t("panel.stale", { when: lastFetch()! }) : undefined}>
            {cachedCount() > 0
              ? ctx.t("panel.cached", { count: cachedCount() })
              : ctx.t("panel.never")}
          </span>
          <ctx.ui.IconButton
            icon="refresh"
            label={ctx.t("panel.refresh", { days: 2 })}
            size="small"
            busy={props.busy()}
            onClick={() => props.onRefresh()}
          />
        </div>
      </div>

      <Show when={props.notice()}>
        {(message) => (
          <div data-slot="token-progress" role="status">
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <Show when={props.progress()}>
        {(value) => (
          <div data-slot="token-progress">
            <span>
              {ctx.t("panel.refetching")} {shortDay(value().day)}
            </span>
            <span data-slot="token-progress-track">
              <span
                data-slot="token-progress-fill"
                style={{ width: `${value().total > 0 ? (value().done / value().total) * 100 : 0}%` }}
              />
            </span>
            <span>
              {value().done}/{value().total}
            </span>
          </div>
        )}
      </Show>

      <Show when={anyRows()} fallback={<Empty />}>
        <section data-slot="token-section" aria-label={ctx.t("panel.selected")}>
          <div data-slot="token-head-actions">
            <h2 data-slot="token-heading">{ctx.t("panel.selected")}</h2>
            <span data-slot="token-card-hint">
              {ctx.t("panel.selectedCount", { count: keys().length, count_models: rows().length })}
            </span>
          </div>
          <Show when={keys().length === 0}>
            <p data-slot="token-card-hint">{ctx.t("panel.selectedHint")}</p>
          </Show>
          <div data-slot="token-card">
            <div data-slot="token-card-row">
              <span data-slot="token-card-label">{ctx.t("panel.billed")}</span>
              <span data-slot="token-card-value" data-emphasis>
                {count(outputVolume(totals()))}
              </span>
            </div>
            <div data-slot="token-card-row">
              <span data-slot="token-card-label">{ctx.t("panel.allTokens")}</span>
              <span data-slot="token-card-value">{count(allTokens(totals()))}</span>
            </div>
            <div data-slot="token-detail">
              <Detail label={ctx.t("panel.input")} value={count(totals().input)} />
              <Detail label={ctx.t("panel.cacheRead")} value={count(totals().cacheRead)} />
              <Detail label={ctx.t("panel.cacheWrite")} value={count(totals().cacheWrite)} />
              <Detail label={ctx.t("panel.output")} value={count(totals().output)} />
              <Detail label={ctx.t("panel.reasoning")} value={count(totals().reasoning)} />
              <Detail
                label={ctx.t("panel.steps")}
                value={ctx.plural("panel.turn", totals().steps)}
              />
            </div>
          </div>
        </section>

        <section data-slot="token-section" aria-label={ctx.t("panel.models")}>
          <div data-slot="token-head-actions">
            <h2 data-slot="token-heading">{ctx.t("panel.models")}</h2>
            <span data-slot="token-head-actions">
              <span data-slot="token-select">
                <select
                  id={selectId}
                  value={activeProvider()}
                  aria-label={ctx.t("panel.provider")}
                  title={ctx.t("panel.provider")}
                  onChange={(event) => setProvider(event.currentTarget.value)}
                >
                  <option value="">{ctx.t("panel.allProviders")}</option>
                  <For each={providers()}>
                    {(entry) => (
                      <option value={entry.id}>
                        {entry.id} · {entry.models}
                      </option>
                    )}
                  </For>
                </select>
                <span data-slot="token-select-chevron" aria-hidden="true" />
              </span>
              <ctx.ui.Button variant="ghost-muted" size="small" onClick={selectAll} disabled={allVisibleSelected()}>
                {ctx.t("panel.selectAll")}
              </ctx.ui.Button>
              <ctx.ui.Button
                variant="ghost-muted"
                size="small"
                onClick={clear}
                disabled={!visibleKeys().some((key) => keys().includes(key))}
              >
                {ctx.t("panel.clear")}
              </ctx.ui.Button>
            </span>
          </div>
          <div data-slot="token-models">
            <For each={visible()}>
              {(row) => (
                <ModelLine
                  row={row}
                  checked={keys().includes(row.key)}
                  share={generation() > 0 ? outputVolume(row) / generation() : 0}
                  onToggle={(on) => toggle(row.key, on)}
                />
              )}
            </For>
          </div>
        </section>

        <p data-slot="token-note">{ctx.t("panel.note")}</p>
      </Show>
    </div>
  )
}

function Detail(props: { label: string; value: string }) {
  return (
    <div data-slot="token-detail-item">
      <span data-slot="token-detail-label">{props.label}</span>
      <span data-slot="token-detail-value">{props.value}</span>
    </div>
  )
}

function ModelLine(props: { row: ModelRow; checked: boolean; share: number; onToggle(on: boolean): void }) {
  const label = () => (props.row.variant ? `${props.row.modelID} · ${props.row.variant}` : props.row.modelID)
  return (
    <label data-slot="token-model">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onToggle(event.currentTarget.checked)} />
      <span data-slot="token-model-copy">
        <span data-slot="token-model-name" dir="auto" title={`${props.row.providerID}/${props.row.modelID}`}>
          {label()}
        </span>
        <span data-slot="token-model-meta">
          {props.row.providerID} · {count(allTokens(props.row))} · {percent(props.share * 100, 100)}
        </span>
      </span>
      <span data-slot="token-model-values">
        <span data-slot="token-model-total">{count(outputVolume(props.row))}</span>
        <span data-slot="token-model-share">{compact(props.row.input)} in</span>
      </span>
      <span data-slot="token-model-bar" aria-hidden="true">
        <span
          data-slot="token-model-bar-fill"
          style={{ width: `${Math.min(100, props.share * 100)}%` }}
        />
      </span>
    </label>
  )
}

function Empty() {
  const ctx = usePlugin<typeof definition>()
  return (
    <div data-slot="token-empty">
      <span data-slot="token-empty-title">{ctx.t("panel.empty")}</span>
      <span data-slot="token-empty-hint">{ctx.t("panel.emptyHint")}</span>
    </div>
  )
}
