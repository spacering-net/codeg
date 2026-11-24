import type { ChartConfig } from "@/components/ui/chart"

/**
 * What a json-render chart draws, taken from the props an agent wrote.
 *
 * json-render passes props through as written, so nothing here assumes their
 * shape. And nothing an agent wrote becomes a `ChartConfig` key or color:
 * shadcn's `ChartStyle` prints both into a `<style>` tag unescaped, so a
 * field named `a b` would break it and a color could carry any CSS. Series
 * and slices get generated keys instead, and colors come from the theme.
 */

type Row = Record<string, unknown>

/** The field every series row keeps its category label under. */
export const CATEGORY = "category"

const DEFAULT_HEIGHT = 250

/** The theme's five chart colors, in turn. */
export function paletteColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`
}

/** The objects in a `data` prop, in order. */
export function chartRows(data: unknown): Row[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (row): row is Row =>
      typeof row === "object" && row !== null && !Array.isArray(row)
  )
}

/** A cell as a plotted value: a number, or text that reads as one. Anything
 *  else is a gap in the chart. */
export function chartNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** A cell as a label. */
export function chartLabel(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return ""
}

/** A field name prop, or null when there is none. */
export function fieldName(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** The `height` prop in pixels. */
export function chartHeight(value: unknown): number {
  const height = chartNumber(value)
  return height !== null && height > 0 ? height : DEFAULT_HEIGHT
}

const ROUND_CHARTS: ReadonlySet<string> = new Set([
  "PieChart",
  "RadarChart",
  "RadialChart",
])

/**
 * The box a chart draws in, which its loading placeholder takes too, so the
 * card does not jump when the chart arrives: the card's full width, `height`
 * tall, and for a round chart with a legend under it 50 pixels more, as in
 * shadcn's examples (their pie-with-legend box is 300 to the others' 250).
 *
 * Their round charts sit in a square capped by a `max-height` instead
 * (`mx-auto aspect-square max-h-[250px]`), which a card cannot use: WebKit —
 * the desktop app's webview on macOS — sizes the chart inside, 100% tall,
 * from the square before the cap, so the chart is drawn as tall as the card
 * is wide and spills out of it.
 */
export function chartBox(
  type: string,
  props: { height?: unknown; legend?: unknown }
): { className: string; style: { height: number } } {
  const legend = ROUND_CHARTS.has(type) && props.legend === true ? 50 : 0
  return {
    className: "aspect-auto w-full",
    style: { height: chartHeight(props.height) + legend },
  }
}

/** The fields of the first row that hold numbers, other than `except`. */
function numericFields(rows: Row[], except: (string | null)[]): string[] {
  const first = rows[0] ?? {}
  return Object.keys(first).filter(
    (key) => !except.includes(key) && chartNumber(first[key]) !== null
  )
}

/** The `series` prop: `{ key, label }` objects, or bare field names. When it
 *  names none, every numeric field of the first row but the category's. */
function seriesFields(
  series: unknown,
  rows: Row[],
  category: string | null
): { field: string; label: string }[] {
  const listed = Array.isArray(series)
    ? series.flatMap((item) => {
        if (typeof item === "string" && item !== "") {
          return [{ field: item, label: item }]
        }
        if (typeof item !== "object" || item === null) return []
        const { key, label } = item as Row
        if (typeof key !== "string" || key === "") return []
        return [
          {
            field: key,
            label: typeof label === "string" && label !== "" ? label : key,
          },
        ]
      })
    : []
  if (listed.length > 0) return listed
  return numericFields(rows, [category]).map((field) => ({
    field,
    label: field,
  }))
}

export interface SeriesChartData {
  /** One object per row: its label under `CATEGORY`, then each series' value
   *  under the series' id. */
  rows: Record<string, string | number | null>[]
  series: { id: string; label: string }[]
  config: ChartConfig
}

/** The data of a chart that plots series over categories: area, bar, line
 *  and radar charts. */
export function seriesChartData(
  data: unknown,
  xKey: unknown,
  series: unknown
): SeriesChartData {
  const rows = chartRows(data)
  const category = fieldName(xKey)
  const fields = seriesFields(series, rows, category).map((entry, index) => ({
    ...entry,
    id: `series-${index}`,
  }))
  return {
    rows: rows.map((row) => {
      const out: Record<string, string | number | null> = {
        [CATEGORY]: category === null ? "" : chartLabel(row[category]),
      }
      for (const { field, id } of fields) out[id] = chartNumber(row[field])
      return out
    }),
    series: fields.map(({ id, label }) => ({ id, label })),
    config: Object.fromEntries(
      fields.map(({ id, label }, index) => [
        id,
        { label, color: paletteColor(index) },
      ])
    ),
  }
}

export interface CategoryChartData {
  /** One object per row: `id` names its config entry, `label` is the name
   *  the agent gave it, `fill` its theme color. */
  rows: { id: string; label: string; value: number | null; fill: string }[]
  config: ChartConfig
  /** The sum of the values. */
  total: number
}

/** The data of a chart with one slice or ring per row: pie and radial
 *  charts. Without a `valueKey`, the first numeric field; without a
 *  `nameKey`, the first other field. */
export function categoryChartData(
  data: unknown,
  nameKey: unknown,
  valueKey: unknown
): CategoryChartData {
  const rows = chartRows(data)
  const name = fieldName(nameKey)
  const value = fieldName(valueKey) ?? numericFields(rows, [name])[0] ?? null
  const label =
    name ?? Object.keys(rows[0] ?? {}).find((key) => key !== value) ?? null
  const out = rows.map((row, index) => ({
    id: `category-${index}`,
    label: (label === null ? "" : chartLabel(row[label])) || `${index + 1}`,
    value: value === null ? null : chartNumber(row[value]),
    fill: `var(--color-category-${index})`,
  }))
  return {
    rows: out,
    config: Object.fromEntries(
      out.map(({ id, label }, index) => [
        id,
        { label, color: paletteColor(index) },
      ])
    ),
    total: out.reduce((sum, row) => sum + (row.value ?? 0), 0),
  }
}

export interface ScatterChartData {
  /** One group per value of `nameKey` (one in all without it), in the order
   *  they first appear; points whose x or y is not a number are left out. */
  groups: {
    id: string
    points: { x: number; y: number; fill: string }[]
  }[]
  config: ChartConfig
}

/** The data of a scatter plot. The config also labels the two axes, under
 *  `x` and `y`, for the tooltip. */
export function scatterChartData(
  data: unknown,
  xKey: unknown,
  yKey: unknown,
  nameKey: unknown
): ScatterChartData {
  const x = fieldName(xKey)
  const y = fieldName(yKey)
  const name = fieldName(nameKey)
  const groups = new Map<string, { x: number; y: number }[]>()
  for (const row of chartRows(data)) {
    const px = x === null ? null : chartNumber(row[x])
    const py = y === null ? null : chartNumber(row[y])
    if (px === null || py === null) continue
    const group = name === null ? (y ?? "") : chartLabel(row[name])
    const points = groups.get(group) ?? []
    points.push({ x: px, y: py })
    groups.set(group, points)
  }
  const entries = [...groups.entries()].map(([label, points], index) => ({
    id: `series-${index}`,
    label,
    points,
  }))
  return {
    groups: entries.map(({ id, points }) => ({
      id,
      points: points.map((point) => ({ ...point, fill: `var(--color-${id})` })),
    })),
    config: {
      x: { label: x ?? "x" },
      y: { label: y ?? "y" },
      ...Object.fromEntries(
        entries.map(({ id, label }, index) => [
          id,
          { label, color: paletteColor(index) },
        ])
      ),
    },
  }
}
