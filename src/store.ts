import { Schema } from "effect"

/**
 * What one model recorded on one local day.
 *
 * Every field is a count OpenCode reported, summed over the day. The same day
 * can be fetched again at any time: a later fetch replaces the row instead of
 * adding to it, so figures never accumulate twice.
 */
export const ModelUsage = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  steps: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})

export const DayUsage = Schema.Struct({
  /** The local calendar day, `YYYY-MM-DD`. */
  date: Schema.String,
  /** When the stats call that produced this row finished, epoch milliseconds. */
  fetchedAt: Schema.Number,
  models: Schema.Array(ModelUsage),
})

export const Vault = Schema.Struct({
  /** Bumped when a stored field's meaning changes, so old rows are refetched. */
  version: Schema.Number,
  /** The earliest local day the server reported recordings for. */
  earliest: Schema.optional(Schema.String),
  days: Schema.Array(DayUsage),
})

export type ModelUsage = Schema.Schema.Type<typeof ModelUsage>
export type DayUsage = Schema.Schema.Type<typeof DayUsage>
export type Vault = Schema.Schema.Type<typeof Vault>

/** The vault layout this build writes. Rows from another version are dropped. */
export const vaultVersion = 1
export const emptyVault: Vault = { version: vaultVersion, days: [] }
