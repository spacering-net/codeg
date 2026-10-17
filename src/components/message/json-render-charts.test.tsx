import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const animations = vi.hoisted(() => ({ on: false }))
vi.mock("@/hooks/use-appearance", () => ({
  useChatAnimationsEnabled: () => animations.on,
}))

import type { ChartType } from "@/lib/json-render/charts"

import JsonRenderChart from "./json-render-charts"

const SALES = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
]
const SERIES = [
  { key: "desktop", label: "Desktop" },
  { key: "mobile", label: "Mobile" },
]
const BROWSERS = [
  { browser: "Chrome", visitors: 275 },
  { browser: "Safari", visitors: 200 },
]

// jsdom lays nothing out: give the chart's measuring box a size, and only it,
// so a legend or tick label does not measure as big as the whole chart.
beforeEach(() => {
  animations.on = false
  const real = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!this.classList.contains("recharts-responsive-container")) {
        return real.call(this)
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 400,
        bottom: 250,
        width: 400,
        height: 250,
        toJSON: () => ({}),
      } as DOMRect
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function draw(
  type: ChartType,
  props: Record<string, unknown>,
  streaming = false
) {
  return render(
    <JsonRenderChart type={type} props={props} streaming={streaming} />
  ).container
}

const count = (root: Element, selector: string) =>
  root.querySelectorAll(selector).length

/** The SVG's text, and the legend's, one string per element. */
const texts = (root: Element) =>
  [...root.querySelectorAll("svg text, .recharts-legend-item-text")].map(
    (node) => node.textContent
  )

/** The y of each point of a path drawn with straight lines (`M x,y L x,y`). */
const ys = (path: Element | undefined) =>
  [...(path?.getAttribute("d") ?? "").matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
    (point) => Number(point[2])
  )

describe("json-render charts", () => {
  it("draw an area per series, with a legend", () => {
    const chart = draw("AreaChart", {
      data: SALES,
      xKey: "month",
      series: SERIES,
      legend: true,
    })
    expect(count(chart, ".recharts-area")).toBe(2)
    expect(chart.textContent).toContain("Desktop")
    expect(chart.textContent).toContain("Mobile")
    expect(texts(chart)).toEqual(expect.arrayContaining(["Jan", "Feb", "Mar"]))
  })

  it("stack areas on request, each on the one below", () => {
    // An area's path runs along its top line, then back along its floor.
    const floors = (stacked: boolean) => {
      const chart = draw("AreaChart", {
        data: SALES,
        xKey: "month",
        series: SERIES,
        stacked,
        curve: "linear",
      })
      const lines = chart.querySelectorAll(".recharts-area-curve")
      const areas = chart.querySelectorAll(".recharts-area-area")
      const result = {
        firstLine: ys(lines[0]),
        secondFloor: ys(areas[1]).slice(SALES.length).reverse(),
      }
      cleanup()
      return result
    }
    const stacked = floors(true)
    expect(stacked.secondFloor).toHaveLength(SALES.length)
    stacked.secondFloor.forEach((y, index) =>
      expect(y).toBeCloseTo(stacked.firstLine[index])
    )
    // Unstacked, every area stands on the axis.
    expect(new Set(floors(false).secondFloor).size).toBe(1)
  })

  it("draw a bar per value, with the values printed on request", () => {
    const chart = draw("BarChart", {
      data: SALES,
      xKey: "month",
      series: SERIES,
      labels: true,
    })
    expect(count(chart, ".recharts-bar-rectangle path")).toBe(6)
    expect(texts(chart)).toEqual(
      expect.arrayContaining(["186", "305", "237", "80", "200", "120"])
    )
  })

  it("lay bars out sideways, labelled on the vertical axis", () => {
    const chart = draw("BarChart", {
      data: SALES,
      xKey: "month",
      series: SERIES,
      horizontal: true,
      stacked: true,
    })
    expect(count(chart, ".recharts-bar-rectangle path")).toBe(6)
    expect(count(chart, ".recharts-yAxis .recharts-cartesian-axis-tick")).toBe(
      3
    )
    expect(count(chart, ".recharts-xAxis")).toBe(0)
  })

  it("draw a line per series, with a dot per point on request", () => {
    const chart = draw("LineChart", {
      data: SALES,
      xKey: "month",
      series: SERIES,
      dots: true,
    })
    expect(count(chart, ".recharts-line-curve")).toBe(2)
    expect(count(chart, ".recharts-line-dot")).toBe(6)
  })

  it("draw a slice per row, the total in the middle of the donut", () => {
    const chart = draw("PieChart", {
      data: BROWSERS,
      nameKey: "browser",
      valueKey: "visitors",
      centerLabel: "Visitors",
      legend: true,
    })
    expect(count(chart, ".recharts-pie-sector")).toBe(2)
    expect(texts(chart)).toContain("475Visitors")
    expect(chart.querySelector(".recharts-legend-wrapper")?.textContent).toBe(
      "ChromeSafari"
    )
  })

  it("draw a radar shape per series on the grid asked for", () => {
    const chart = draw("RadarChart", {
      data: SALES,
      xKey: "month",
      series: SERIES,
      grid: "circle",
    })
    expect(count(chart, ".recharts-radar-polygon")).toBe(2)
    expect(count(chart, ".recharts-polar-grid-concentric-circle")).toBe(5)
    expect(count(chart, ".recharts-polar-grid-concentric-polygon")).toBe(0)
  })

  it("draw a ring per row, named on request, the total in the middle", () => {
    const chart = draw("RadialChart", {
      data: BROWSERS,
      nameKey: "browser",
      valueKey: "visitors",
      labels: true,
      centerLabel: "Visitors",
    })
    expect(count(chart, ".recharts-radial-bar-sector")).toBe(2)
    expect(texts(chart)).toEqual(
      expect.arrayContaining(["475Visitors", "Chrome", "Safari"])
    )
  })

  it("draw a point per row, colored by group", () => {
    const chart = draw("ScatterChart", {
      data: [
        { size: 1, ms: 10, team: "web" },
        { size: 2, ms: 20, team: "api" },
        { size: 3, ms: 30, team: "web" },
      ],
      xKey: "size",
      yKey: "ms",
      nameKey: "team",
      legend: true,
    })
    expect(count(chart, ".recharts-scatter")).toBe(2)
    expect(count(chart, ".recharts-scatter-symbol")).toBe(3)
    expect(chart.querySelector(".recharts-legend-wrapper")?.textContent).toBe(
      "webapi"
    )
  })

  it("give round charts the card's width at a set height, and room for a legend", () => {
    // jsdom does no layout, so this checks the box itself. Its width: a
    // card's content is a flex column, where a box centred with `mx-auto`
    // alone shrinks to a chart with no size of its own, and draws nothing.
    // Its height: in a square capped by `max-height`, as in shadcn's
    // examples, WebKit sizes the chart from the square, past the cap, and
    // it spills out of the card.
    const box = (type: ChartType, props: Record<string, unknown>) => {
      const chart = draw(type, props).querySelector<HTMLElement>(
        '[data-slot="chart"]'
      )
      cleanup()
      return chart
    }
    const pie = { data: BROWSERS, nameKey: "browser", valueKey: "visitors" }
    for (const type of ["PieChart", "RadarChart", "RadialChart"] as const) {
      const plain = box(type, { ...pie, xKey: "browser", series: SERIES })
      expect(plain?.classList.contains("w-full")).toBe(true)
      expect(plain?.classList.contains("aspect-square")).toBe(false)
      expect(plain?.style.height).toBe("250px")
      expect(plain?.style.maxHeight).toBe("")
    }
    expect(box("PieChart", { ...pie, legend: true })?.style.height).toBe(
      "300px"
    )
    expect(box("PieChart", { ...pie, height: 200 })?.style.height).toBe("200px")
  })

  it("show any name as text and keep it out of the chart's style", () => {
    const name = "</style><b>x</b> a;}*{display:none}"
    const chart = draw("BarChart", {
      data: [{ month: "Jan", [name]: 5 }],
      xKey: "month",
      series: [{ key: name, label: name }],
      legend: true,
    })
    expect(count(chart, ".recharts-bar-rectangle path")).toBe(1)
    expect(chart.querySelector("b")).toBeNull()
    expect(chart.querySelector(".recharts-legend-wrapper")?.textContent).toBe(
      name
    )
    const style = chart.querySelector("style")?.textContent ?? ""
    expect(style).toContain("--color-series-0: var(--chart-1);")
    expect(style).not.toContain("display")
  })

  it("plot numbers written as text", () => {
    const chart = draw("BarChart", {
      data: [
        { month: "Jan", v: "12" },
        { month: "Feb", v: "30" },
      ],
      xKey: "month",
      series: ["v"],
      labels: true,
    })
    expect(count(chart, ".recharts-bar-rectangle path")).toBe(2)
    expect(texts(chart)).toEqual(expect.arrayContaining(["12", "30"]))
  })

  it("animate only once the reply is in, and only with chat animations on", () => {
    const bars = (streaming: boolean) => {
      const chart = draw(
        "BarChart",
        { data: SALES, xKey: "month", series: SERIES },
        streaming
      )
      const n = count(chart, ".recharts-bar-rectangle path")
      cleanup()
      return n
    }
    // Without animation every bar is drawn from the first frame; an
    // animated chart grows its bars from nothing, so draws none yet.
    expect(bars(false)).toBe(6)
    animations.on = true
    expect(bars(true)).toBe(6)
    expect(bars(false)).toBe(0)
  })
})
