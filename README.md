# Token Totals

A local OpenCode Desktop GUI plugin: **per-model token totals across every project on the device**, with the models you tick added up together.

Run History shows the last 500 turns it happened to observe. This panel instead asks OpenCode's own stats endpoint for each local day, caches that day, and never reads it again — so the first run reads the whole history and every later look costs two requests.

## Install

Point the plugin list at this directory instead of an npm package:

```json
// ~/.config/opencode/opencode.json
{
  "plugins": ["C:/Users/USERNAME/Documents/opencode/token-usage"]
}
```

Build after changing the source:

```powershell
$env:BUN_BE_BUN="1"
& "C:\Users\USERNAME\AppData\Local\Programs\ai.opencode.desktop\resources\opencode-cli.exe" run build
```

`opencode-cli.exe` ships bun 1.4.4, so no separate node or bun install is needed.

## How the cache works

The unit is **one local calendar day**.

- The first run makes one all-time stats call to learn the earliest recorded day, then fetches **one stats call per day** from that day to today.
- Each day is stored as `{ date, fetchedAt, models[] }`, where `models[]` carries the per-model `steps / input / output / reasoning / cacheRead / cacheWrite`.
- A finished day never changes, so afterwards it is only read from the cache.
- A routine look refetches **today and yesterday** (a turn can cross midnight). That is two requests.
- Every request covers a whole local day, `[day 00:00, next day 00:00)`, and a later fetch **replaces** that day's row. A day can therefore be refetched at any time without counting its figures twice.
- Each day is written to the store as it arrives, so a long first run survives closing the window.

`Refresh` in the panel toolbar forces a full refetch. Settings › Token totals clears the cache entirely.

## Token definitions

OpenCode records five buckets per assistant step. The panel shows each one separately and never mixes them:

| Field | Meaning |
| --- | --- |
| `input` | Fresh input tokens, cache misses only |
| `cacheRead` | Input tokens served from the provider cache |
| `cacheWrite` | Input tokens written to the provider cache |
| `output` | Visible output tokens, reasoning excluded |
| `reasoning` | Reasoning tokens |

Two sums are shown, on purpose kept apart:

- **Output + reasoning** — what the model generated. Use this for "how much did the model produce".
- **All tokens** — all five buckets, each counted once. Dominated by cache reads, so it is not a meaningful "spend".

The Go console's own `input` column is `input + cache_read + cache_write`, and its billed `output` includes reasoning. When comparing against the console, compare `bound: all tokens` against the console's input total minus output, or compare the buckets side by side.

## What is and is not counted

- Totals are the counts OpenCode recorded from each provider, per assistant step, for **all projects and all subagents on this server**. Nothing is estimated.
- `cost` is not shown. On Go it is recorded as `0` locally, so any figure would be made up.
- Only days with recorded activity appear in the cache; empty days store nothing.
- The day boundary is the **local calendar**, matching what the stats endpoint does with its own `from`/`to` bounds.

## Files

| File | Role |
| --- | --- |
| `src/store.ts` | Effect schemas for the cached day rows |
| `src/stats.ts` | Day keys, bounds, per-model merging, aggregation |
| `src/refresh.ts` | The incremental fetch loop |
| `src/panel.tsx` | The side-panel tab: range switch, model checkboxes, selected totals |
| `src/gui.tsx` | Registration: panel tab, + menu item, settings page, style |
| `src/i18n/en.ts` | Copy for every string |

## Compatibility

Built against `@opencode/plugin` 2.3.0 and `@opencode/client` 2.3.0, and type-checked against them. It reads `client.experimental.session.stats({ from, to, tools: "none" })`, the endpoint `GET /api/experimental/session/stats`. That endpoint is marked experimental upstream; if it moves, only this panel stops working.
