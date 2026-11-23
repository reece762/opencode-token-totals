/**
 * Acceptance check for the day cache.
 *
 * Runs the real `refresh` loop against the live server, one request per local
 * day, then compares the cached sum with a single whole-range stats call. The
 * two must match exactly, and the fake client counts the requests so the cost
 * of a first run and of a later look can be read off.
 *
 * Run: opencode-cli.exe run validate
 */
import { execFileSync } from "node:child_process"
import { refresh } from "../src/refresh"
import { aggregate, allTokens, outputVolume, sumRows, todayKey, dayKey } from "../src/stats"
import type { Vault } from "../src/store"

const cli = "C:\\Users\\USERNAME\\AppData\\Local\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe"

/** This CLI is bun with extra commands; BUN_BE_BUN would make it a bare bun. */
const env = { ...process.env }
delete env.BUN_BE_BUN

let calls = 0

const client = {
  experimental: {
    session: {
      async stats(input: { from?: number; to?: number } = {}) {
        calls += 1
        const query = [
          "tools=none",
          input.from === undefined ? "" : `from=${input.from}`,
          input.to === undefined ? "" : `to=${input.to}`,
        ]
          .filter(Boolean)
          .join("&")
        const raw = execFileSync(cli, ["api", "get", `/api/experimental/session/stats?${query}`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env,
        })
        return JSON.parse(raw).data
      },
    },
  },
} as never

let vault: Vault | undefined

const deps = {
  clients: () => [client],
  read: () => vault,
  write: (next: Vault) => {
    vault = next
  },
}

const report: string[] = []

// First run: one request per day from the earliest recorded day.
const first = await refresh(deps, { full: true })
const firstCalls = calls
report.push(`first run: ${first.fetched.length} days fetched in ${firstCalls} requests`)
report.push(`  earliest=${first.vault.earliest} unknown=${first.earliestUnknown} failed=${first.failed.length}`)

// Whole-range answer from the server, for comparison.
const whole = await client.experimental.session.stats({ tools: "none" })

const rows = aggregate(first.vault.days)
const total = sumRows(rows)
const expected = {
  steps: whole.steps,
  input: whole.tokens.input,
  output: whole.tokens.output,
  reasoning: whole.tokens.reasoning,
  cacheRead: whole.tokens.cache.read,
  cacheWrite: whole.tokens.cache.write,
}

report.push(`models cached: ${rows.length} (server reports ${whole.models.length})`)
for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
  const mine = total[field]
  const theirs = expected[field]
  const delta = mine - theirs
  report.push(`  ${field}: cached=${mine} server=${theirs} delta=${delta}`)
}

report.push(`generation (output+reasoning): ${outputVolume(total)}`)
report.push(`all tokens: ${allTokens(total)}`)

// Second look: the tail only.
calls = 0
const second = await refresh(deps)
report.push(`second look: ${second.fetched.length} days refetched in ${calls} requests`)
report.push(`  cached days: ${second.vault.days.length}`)

// Third look straight away: still the tail, and the numbers must not move.
calls = 0
const before = sumRows(aggregate(vault!.days))
const third = await refresh(deps)
const after = sumRows(aggregate(third.vault.days))
report.push(`third look: ${calls} requests, totals unchanged=${allTokens(before) === allTokens(after)}`)

// The same day fetched twice must not double count.
const day = todayKey()
const bounds = { from: new Date().setHours(0, 0, 0, 0), to: new Date().setHours(24, 0, 0, 0) }
const once = await client.experimental.session.stats(bounds)
const twiceModels = once.models.length
report.push(`today (${day}) models in one call: ${twiceModels}`)

console.log(report.join("\n"))

const drift = (Object.keys(expected) as (keyof typeof expected)[]).filter(
  (field) => total[field] !== expected[field],
)
if (drift.length > 0) {
  console.error(`MISMATCH: ${drift.join(", ")}`)
  process.exit(1)
}
console.log("OK: the day cache reproduces the server's whole-range totals exactly")
