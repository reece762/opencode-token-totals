import type { OpenCodeClient } from "@opencode/client"
import {
  addDays,
  dayBounds,
  dayKey,
  daysBetween,
  mergeDay,
  modelsFromStats,
  todayKey,
  type DayUsage,
  type ModelUsage,
} from "./stats"
import { vaultVersion, type Vault } from "./store"

/** How far back a first run reaches when the server reports no earlier day. */
const fallbackLookbackDays = 400

/** Days refetched by a routine look: today, and yesterday for turns crossing midnight. */
const tailDays = 2

export interface RefreshDeps {
  /** Each listed server's client. Every server records its own usage. */
  clients(): readonly OpenCodeClient[]
  read(): Vault | undefined
  write(vault: Vault): void
  now?(): number
}

export interface RefreshOptions {
  /** Refetch from the earliest recorded day instead of only the tail. */
  full?: boolean
  onProgress?(done: number, total: number, day: string): void
}

export interface RefreshResult {
  vault: Vault
  fetched: string[]
  failed: string[]
  /** The server reported no earlier day, so the first cached day is a guess. */
  earliestUnknown: boolean
}

/**
 * Fills and extends the day cache.
 *
 * A finished local day never changes again, so it is fetched once and afterwards
 * only read from the cache. A routine look therefore costs `tailDays` requests;
 * the first run costs one request per day since the earliest recorded day.
 *
 * Each request covers a whole local day, and a later request for the same day
 * replaces its row, so a day can be refetched safely at any time.
 */
export async function refresh(deps: RefreshDeps, options: RefreshOptions = {}): Promise<RefreshResult> {
  const now = deps.now?.() ?? Date.now()
  const today = todayKey(now)
  const clients = deps.clients()
  const stored = deps.read()
  const current: Vault = stored && stored.version === vaultVersion ? stored : { version: vaultVersion, days: [] }
  const fetched: string[] = []
  const failed: string[] = []

  if (clients.length === 0) return { vault: current, fetched, failed, earliestUnknown: !current.earliest }

  let earliest = current.earliest
  let earliestUnknown = false
  if (!earliest || options.full) {
    // One all-time call answers the question a first run cannot: where it starts.
    earliest = await earliestDay(clients)
    if (!earliest) {
      earliestUnknown = true
      earliest = addDays(today, -fallbackLookbackDays + 1)
    }
  }

  const wanted = daysBetween(earliest, today)
  const cached = new Set(current.days.map((day) => day.date))
  const tail = wanted.slice(-tailDays)
  // Older days are fetched once and then only read: they are refetched only when
  // the cache lacks them, as on a first run. The tail is always refetched.
  const older = wanted.slice(0, -tailDays).filter((day) => !cached.has(day))
  const todo = options.full ? wanted : [...older, ...tail]

  let vault: Vault = { ...current, earliest }
  let index = 0

  for (const date of todo) {
    options.onProgress?.(index, todo.length, date)
    index += 1

    const models = await dayFor(clients, date)
    if (models === undefined) {
      failed.push(date)
      continue
    }

    vault = { ...vault, days: mergeDay(vault.days, { date, fetchedAt: now, models }) }
    fetched.push(date)
    // Written after every day, so a long first run survives closing the window.
    deps.write(vault)
  }

  options.onProgress?.(todo.length, todo.length, today)
  return { vault, fetched, failed, earliestUnknown }
}

/** The earliest local day any server reports recordings for. */
async function earliestDay(clients: readonly OpenCodeClient[]) {
  let earliest: string | undefined
  for (const client of clients) {
    const stats = await callStats(client, {})
    const from = stats?.range?.from
    if (typeof from !== "number" || from <= 0) continue
    const day = dayKey(from)
    if (!earliest || day < earliest) earliest = day
  }
  return earliest
}

/** One local day's per-model totals, summed across every server. */
async function dayFor(clients: readonly OpenCodeClient[], date: string) {
  const bounds = dayBounds(date)
  const merged: ModelUsage[] = []
  let answered = false

  for (const client of clients) {
    const stats = await callStats(client, { from: bounds.from, to: bounds.to, tools: "none" })
    if (!stats) continue
    answered = true
    for (const model of modelsFromStats(stats.models ?? [])) {
      const existing = merged.find(
        (entry) =>
          entry.providerID === model.providerID &&
          entry.modelID === model.modelID &&
          entry.variant === model.variant,
      )
      if (!existing) {
        merged.push({ ...model })
        continue
      }
      existing.steps += model.steps
      existing.input += model.input
      existing.output += model.output
      existing.reasoning += model.reasoning
      existing.cacheRead += model.cacheRead
      existing.cacheWrite += model.cacheWrite
    }
  }

  return answered ? merged : undefined
}

interface StatsInput {
  from?: number
  to?: number
  tools?: "none"
}

async function callStats(client: OpenCodeClient, input: StatsInput) {
  try {
    return await client.experimental.session.stats(input)
  } catch {
    return undefined
  }
}

export type { DayUsage }
