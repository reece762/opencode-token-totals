const group = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

/** Exact count with the reader's grouping. */
export function count(value: number) {
  return group.format(value)
}

/** A count with a short suffix once it passes a thousand. */
export function compact(value: number) {
  if (value < 10_000) return group.format(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0)}K`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}

export function percent(part: number, whole: number) {
  if (whole <= 0) return "0%"
  const value = (part / whole) * 100
  if (value > 0 && value < 1) return "<1%"
  return `${Math.round(value)}%`
}

/** A `YYYY-MM-DD` day in the reader's short date format. */
export function shortDay(date: string) {
  const [year, month, day] = date.split("-").map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function when(at: number) {
  const date = new Date(at)
  const today = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (date.toDateString() === today.toDateString()) return time
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
}
