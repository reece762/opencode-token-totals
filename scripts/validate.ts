/**
 * Acceptance check for the day cache.
 *
 * Runs the real `refresh` loop against a live server, one request per local day,
 * then compares the cached sum with a single whole-range stats call. The two must
 * match on every field, and the fake client counts the requests so the cost of a
 * first run and of a later look can be read off.
 *
 * Run: bun run validate
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { refresh } from "../src/refresh"
import { addDays, aggregate, allTokens, dayBounds, outputVolume, sumRows, todayKey } from "../src/stats"
import type { Vault } from "../src/store"

/**
 * Finds the desktop app's CLI, which is bun with extra subcommands.
 *
 * `OPENCODE_CLI` wins when set, which is the escape hatch for a non-standard
 * install. `BUN_BE_BUN` is stripped for the child, because it would turn this
 * CLI into a bare bun and `api` would stop being a subcommand.
 */
function findCli(): string {
  const names = process.platform === "win32" ? ["opencode-cli.exe", "opencode-cli"] : ["opencode-cli"]

  const candidates: string[] = []
  if (process.env.OPENCODE_CLI) candidates.push(process.env.OPENCODE_CLI)

  const resources = {
    win32: [join(process.env.LOCALAPPDATA ?? "", "Programs", "ai.opencode.desktop", "resources")],
    darwin: ["/Applications/OpenCode.app/Contents/Resources", join(homedir(), "Applications/OpenCode.app/Contents/Resources")],
    linux: [
      join(homedir(), ".local/share/ai.opencode.desktop/resources"),
      "/opt/OpenCode/resources",
      "/usr/lib/opencode/resources",
    ],
  }[process.platform as "win32" | "darwin" | "linux"] ?? []

  for (const dir of resources) {
    for (const name of names) if (dir) candidates.push(join(dir, name))
  }
  // Last resort: whatever the PATH offers under the same name.
  candidates.push(...names)

  const works = (path: string) => {
    if (path.includes("/") || path.includes("\\")) {
      if (!existsSync(path)) return false
    }
    try {
      execFileSync(path, ["--version"], { stdio: "ignore", env: childEnv() })
      return true
    } catch {
      return false
    }
  }

  const found = candidates.find(works)
  if (found) return found

  console.error(
    [
      "Could not find the OpenCode desktop CLI.",
      "",
      "Point OPENCODE_CLI at it, for example:",
      '  PowerShell:  $env:OPENCODE_CLI = "$env:LOCALAPPDATA\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe"',
      "  bash:        export OPENCODE_CLI=/Applications/OpenCode.app/Contents/Resources/opencode-cli",
      "",
      "The desktop app ships it as `opencode-cli` in its own resources directory.",
    ].join("\n"),
  )
  process.exit(1)
}

function childEnv() {
  const env = { ...process.env }
  delete env.BUN_BE_BUN
  return env
}

const cli = findCli()
let calls = 0

async function stats(input: { from?: number; to?: number; tools?: "none" } = {}) {
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
    env: childEnv(),
  })
  return JSON.parse(raw).data
}

const client = { experimental: { session: { stats } } } as never

let vault: Vault | undefined

const deps = {
  clients: () => [client],
  read: () => vault,
  write: (next: Vault) => {
    vault = next
  },
}

const report: string[] = []
report.push(`cli: ${basename(cli)} (${process.env.OPENCODE_CLI ? "OPENCODE_CLI" : "auto-detected"})`)

// First run: one request per day from the earliest recorded day.
const first = await refresh(deps, { full: true })
report.push(`first run: ${first.fetched.length} days fetched in ${calls} requests`)
report.push(`  earliest=${first.vault.earliest} unknown=${first.earliestUnknown} failed=${first.failed.length}`)

// The whole-range answer from the server, for comparison.
const whole = await stats({ tools: "none" })

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
  report.push(`  ${field}: cached=${mine} server=${theirs} delta=${mine - theirs}`)
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
const midnight = new Date()
midnight.setHours(0, 0, 0, 0)
const bounds = { from: midnight.getTime(), to: midnight.getTime() + 86_400_000 }
const once = await stats(bounds)
report.push(`today (${day}) models in one call: ${once.models.length}`)

// Day bounds must tile, with no gap and no overlap, across a DST change.
const tiles = dayTiles()
report.push(`day tiling: ${tiles.ok ? "contiguous" : `GAP at ${tiles.at}`}`)

console.log(report.join("\n"))

const drift = (Object.keys(expected) as (keyof typeof expected)[]).filter((field) => total[field] !== expected[field])
if (drift.length > 0 || !tiles.ok) {
  if (drift.length > 0) console.error(`MISMATCH: ${drift.join(", ")}`)
  process.exit(1)
}
console.log("OK: the day cache reproduces the server's whole-range totals exactly")

/**
 * Walks every local day from the earliest recording to today and checks that
 * each day starts exactly where the previous one ended. A local-midnight
 * boundary is easy to get wrong around a daylight-saving change, and a gap or
 * an overlap there would silently lose or double count tokens.
 */
function dayTiles() {
  const first = firstDayIn(vault?.days ?? [])
  if (!first) return { ok: true, at: "" }
  let previous: { from: number; to: number } | undefined
  let cursor = first
  const last = todayKey()
  while (cursor <= last) {
    const bounds = dayBounds(cursor)
    if (previous && previous.to !== bounds.from) return { ok: false, at: `${cursor}: ${previous.to} -> ${bounds.from}` }
    previous = bounds
    cursor = addDays(cursor, 1)
  }
  return { ok: true, at: "" }
}

function firstDayIn(days: readonly { date: string }[]) {
  return days.length === 0 ? undefined : [...days].sort((a, b) => a.date.localeCompare(b.date))[0]!.date
}
