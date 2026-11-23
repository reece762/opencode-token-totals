import type { SessionStatsModelUsage } from "@opencode/client"

/** The token buckets OpenCode recorded for one model. */
export interface Totals {
  steps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelUsage extends Totals {
  providerID: string
  modelID: string
  variant?: string
}

export interface DayUsage {
  date: string
  fetchedAt: number
  models: readonly ModelUsage[]
}

export interface ModelRow extends Totals {
  key: string
  providerID: string
  modelID: string
  variant?: string
}

export function emptyTotals(): Totals {
  return { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

const pad = (value: number) => String(value).padStart(2, "0")

/** The local calendar day of an epoch timestamp, `YYYY-MM-DD`. */
export function dayKey(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function todayKey(now = Date.now()) {
  return dayKey(now)
}

/** The `[from, to)` epoch bounds of a local calendar day. */
export function dayBounds(date: string) {
  const [year, month, day] = date.split("-").map(Number)
  const start = new Date(year, month - 1, day, 0, 0, 0, 0)
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0)
  return { from: start.getTime(), to: end.getTime() }
}

export function addDays(date: string, delta: number) {
  const [year, month, day] = date.split("-").map(Number)
  const next = new Date(year, month - 1, day + delta, 12)
  return dayKey(next.getTime())
}

export function daysBetween(first: string, last: string) {
  const keys: string[] = []
  let cursor = first
  while (cursor <= last) {
    keys.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return keys
}

export function modelKey(model: { providerID: string; modelID?: string; id?: string; variant?: string }) {
  const id = model.modelID ?? model.id ?? ""
  return `${model.providerID}/${id}${model.variant ? `#${model.variant}` : ""}`
}

/** Turns a stats response's per-model list into the cached shape. */
export function modelsFromStats(models: readonly SessionStatsModelUsage[]): ModelUsage[] {
  return models.map((entry) => ({
    providerID: entry.model.providerID,
    modelID: entry.model.id,
    variant: entry.model.variant,
    steps: entry.steps,
    input: entry.tokens.input,
    output: entry.tokens.output,
    reasoning: entry.tokens.reasoning,
    cacheRead: entry.tokens.cache.read,
    cacheWrite: entry.tokens.cache.write,
  }))
}

export function addTotals(target: Totals, source: Totals) {
  target.steps += source.steps
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

/**
 * Replaces a day's row. A request always covers the whole day, so replacing
 * cannot double count and a repeated fetch simply refreshes the numbers.
 */
export function mergeDay(days: readonly DayUsage[], next: DayUsage): DayUsage[] {
  return [...days.filter((day) => day.date !== next.date), next].sort((a, b) => a.date.localeCompare(b.date))
}

export interface AggregateOptions {
  /** First local day to include, inclusive. */
  from?: string
  /** Last local day to include, inclusive. */
  to?: string
}

/** Sums cached days into one row per model, largest generation first. */
export function aggregate(days: readonly DayUsage[], options: AggregateOptions = {}): ModelRow[] {
  const rows = new Map<string, ModelRow>()
  for (const day of days) {
    if (options.from && day.date < options.from) continue
    if (options.to && day.date > options.to) continue
    for (const model of day.models) {
      const key = modelKey(model)
      const row = rows.get(key) ?? {
        key,
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
        ...emptyTotals(),
      }
      addTotals(row, model)
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort(
    (a, b) => outputVolume(b) - outputVolume(a) || allTokens(b) - allTokens(a) || a.key.localeCompare(b.key),
  )
}

/** Output plus reasoning: what the model generated. */
export function outputVolume(totals: Totals) {
  return totals.output + totals.reasoning
}

/** Every recorded bucket, counted once each. */
export function allTokens(totals: Totals) {
  return totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
}

export function sumRows(rows: readonly Totals[]): Totals {
  const total = emptyTotals()
  for (const row of rows) addTotals(total, row)
  return total
}

/** The first cached day, if any. */
export function firstDay(days: readonly DayUsage[]) {
  return days[0]?.date
}

/** Days in the range that the cache does not hold yet. */
export function missingDays(days: readonly DayUsage[], first: string, last: string) {
  const cached = new Set(days.map((day) => day.date))
  return daysBetween(first, last).filter((date) => !cached.has(date))
}
