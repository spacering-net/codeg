import { describe, expect, it } from "vitest"

import {
  CATEGORY,
  categoryChartData,
  chartBox,
  chartHeight,
  chartNumber,
  paletteColor,
  scatterChartData,
  seriesChartData,
} from "./chart-data"

const SALES = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
]

/** Every key and color a config would print into the chart's `<style>`. */
function printed(config: Record<string, { color?: string }>) {
  return Object.entries(config)
    .filter(([, entry]) => entry.color)
    .map(([key, entry]) => `--color-${key}: ${entry.color}`)
}

describe("series charts", () => {
  it("plot the listed fields under generated ids, labelled as the agent wrote", () => {
    const chart = seriesChartData(SALES, "month", [
      { key: "desktop", label: "Desktop" },
      { key: "mobile", label: null },
    ])
    expect(chart.rows).toEqual([
      { [CATEGORY]: "Jan", "series-0": 186, "series-1": 80 },
      { [CATEGORY]: "Feb", "series-0": 305, "series-1": 200 },
    ])
    expect(chart.series).toEqual([
      { id: "series-0", label: "Desktop" },
      { id: "series-1", label: "mobile" },
    ])
    expect(printed(chart.config)).toEqual([
      "--color-series-0: var(--chart-1)",
      "--color-series-1: var(--chart-2)",
    ])
  })

  it("take bare field names as series", () => {
    const chart = seriesChartData(SALES, "month", ["mobile"])
    expect(chart.series).toEqual([{ id: "series-0", label: "mobile" }])
    expect(chart.rows[1]["series-0"]).toBe(200)
  })

  it("plot every numeric field but the category's when no series is named", () => {
    for (const series of [undefined, null, [], "desktop", [{ label: "x" }]]) {
      expect(seriesChartData(SALES, "month", series).series).toEqual([
        { id: "series-0", label: "desktop" },
        { id: "series-1", label: "mobile" },
      ])
    }
  })

  it("never print a name the agent wrote into the chart's style", () => {
    const name = "a;} body{display:none} .x{"
    const chart = seriesChartData(
      [{ [name]: 1, "收入 (元)": 2, month: "Jan" }],
      "month",
      [{ key: name, label: name }, { key: "收入 (元)" }]
    )
    expect(printed(chart.config)).toEqual([
      "--color-series-0: var(--chart-1)",
      "--color-series-1: var(--chart-2)",
    ])
    expect(chart.series.map((s) => s.label)).toEqual([name, "收入 (元)"])
    expect(chart.rows[0]).toEqual({
      [CATEGORY]: "Jan",
      "series-0": 1,
      "series-1": 2,
    })
  })

  it("read numbers written as text, and leave anything else as a gap", () => {
    const chart = seriesChartData(
      [
        { month: "Jan", v: "12.5" },
        { month: "Feb", v: "n/a" },
        { month: "Mar", v: null },
        { month: "Apr", v: Infinity },
      ],
      "month",
      ["v"]
    )
    expect(chart.rows.map((row) => row["series-0"])).toEqual([
      12.5,
      null,
      null,
      null,
    ])
  })

  it("keep going with rows that are not objects, or no rows at all", () => {
    expect(
      seriesChartData([SALES[0], 3, null, ["x"]], "month", ["desktop"]).rows
    ).toEqual([{ [CATEGORY]: "Jan", "series-0": 186 }])
    expect(seriesChartData({ rows: SALES }, "month", ["desktop"]).rows).toEqual(
      []
    )
    expect(seriesChartData(SALES, undefined, ["desktop"]).rows[0]).toEqual({
      [CATEGORY]: "",
      "series-0": 186,
    })
  })

  it("take the theme's five colors in turn", () => {
    expect([0, 1, 4, 5, 6].map(paletteColor)).toEqual([
      "var(--chart-1)",
      "var(--chart-2)",
      "var(--chart-5)",
      "var(--chart-1)",
      "var(--chart-2)",
    ])
  })
})

describe("slice and ring charts", () => {
  const BROWSERS = [
    { browser: "Chrome", visitors: 275 },
    { browser: "Safari", visitors: "200" },
    { browser: "", visitors: 25 },
  ]

  it("give each row an id, its name, its value and a theme color", () => {
    const chart = categoryChartData(BROWSERS, "browser", "visitors")
    expect(chart.rows).toEqual([
      {
        id: "category-0",
        label: "Chrome",
        value: 275,
        fill: "var(--color-category-0)",
      },
      {
        id: "category-1",
        label: "Safari",
        value: 200,
        fill: "var(--color-category-1)",
      },
      // A row with no name is still a slice, numbered.
      {
        id: "category-2",
        label: "3",
        value: 25,
        fill: "var(--color-category-2)",
      },
    ])
    expect(chart.total).toBe(500)
    expect(printed(chart.config)).toEqual([
      "--color-category-0: var(--chart-1)",
      "--color-category-1: var(--chart-2)",
      "--color-category-2: var(--chart-3)",
    ])
    expect(chart.config["category-0"].label).toBe("Chrome")
  })

  it("find the value and name fields when they are not given", () => {
    const chart = categoryChartData(BROWSERS, null, undefined)
    expect(chart.rows.map(({ label, value }) => [label, value])).toEqual([
      ["Chrome", 275],
      ["Safari", 200],
      ["3", 25],
    ])
  })
})

describe("scatter plots", () => {
  it("group points by nameKey in the order the groups appear", () => {
    const chart = scatterChartData(
      [
        { size: 1, ms: 10, team: "web" },
        { size: 2, ms: "20", team: "api" },
        { size: 3, ms: 30, team: "web" },
        { size: "big", ms: 40, team: "api" },
      ],
      "size",
      "ms",
      "team"
    )
    expect(chart.groups).toEqual([
      {
        id: "series-0",
        points: [
          { x: 1, y: 10, fill: "var(--color-series-0)" },
          { x: 3, y: 30, fill: "var(--color-series-0)" },
        ],
      },
      {
        id: "series-1",
        points: [{ x: 2, y: 20, fill: "var(--color-series-1)" }],
      },
    ])
    expect(chart.config["series-0"].label).toBe("web")
    expect(chart.config.x.label).toBe("size")
    expect(chart.config.y.label).toBe("ms")
    expect(printed(chart.config)).toEqual([
      "--color-series-0: var(--chart-1)",
      "--color-series-1: var(--chart-2)",
    ])
  })

  it("put every point in one group named after y without nameKey", () => {
    const chart = scatterChartData([{ a: 1, b: 2 }], "a", "b", undefined)
    expect(chart.groups).toHaveLength(1)
    expect(chart.config["series-0"].label).toBe("b")
  })
})

describe("chart props", () => {
  it("read numbers written as text", () => {
    expect(chartNumber("1e3")).toBe(1000)
    expect(chartNumber(" ")).toBeNull()
    expect(chartNumber(true)).toBeNull()
  })

  it("size a chart 250 pixels unless given a positive height", () => {
    expect(chartHeight(undefined)).toBe(250)
    expect(chartHeight(-10)).toBe(250)
    expect(chartHeight("x")).toBe(250)
    expect(chartHeight(320)).toBe(320)
    expect(chartHeight("180")).toBe(180)
  })

  it("give cartesian charts the card's width at their height", () => {
    expect(chartBox("BarChart", { height: 180, legend: true })).toEqual({
      className: "aspect-auto w-full",
      style: { height: 180 },
    })
  })

  // Not a square capped by `max-height`, as in shadcn's examples: WebKit
  // sizes the chart inside such a box from the square, past the cap.
  it("give round charts the card's width at their height, and room for a legend", () => {
    for (const type of ["PieChart", "RadarChart", "RadialChart"]) {
      expect(chartBox(type, {})).toEqual({
        className: "aspect-auto w-full",
        style: { height: 250 },
      })
      expect(chartBox(type, { legend: true, height: 200 })).toEqual({
        className: "aspect-auto w-full",
        style: { height: 250 },
      })
    }
  })
})
