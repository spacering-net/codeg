import { act, render, screen } from "@testing-library/react"
import { useContext, type ReactNode } from "react"
import { StreamdownContext } from "streamdown"
import { describe, expect, it, vi } from "vitest"

// The chart chunk, reduced to what this file checks: when it loads, and what
// it is given.
const chunk = vi.hoisted(() => ({ loads: 0 }))
vi.mock("./json-render-charts", () => {
  chunk.loads++
  return {
    default: ({
      type,
      props,
      streaming,
    }: {
      type: string
      props: Record<string, unknown>
      streaming: boolean
    }) => (
      <div
        data-testid="chart"
        data-type={type}
        data-streaming={String(streaming)}
      >
        {JSON.stringify(props.data)}
      </div>
    ),
  }
})

import JsonRenderBlock from "./json-render-block"

const line = (patch: object) => JSON.stringify(patch)

function spec(...elements: [string, object][]) {
  return [
    line({ op: "add", path: "/root", value: "main" }),
    line({
      op: "add",
      path: "/elements/main",
      value: {
        type: "Card",
        props: { title: "Sales" },
        children: elements.map(([key]) => key),
      },
    }),
    ...elements.map(([key, value]) =>
      line({ op: "add", path: `/elements/${key}`, value })
    ),
  ]
}

const SALES = [{ month: "Jan", desktop: 186 }]
const BAR = {
  type: "BarChart",
  props: { data: SALES, xKey: "month", series: ["desktop"], height: 300 },
  children: [],
}
const PIE = {
  type: "PieChart",
  props: { data: SALES, nameKey: "month", valueKey: "desktop", legend: true },
  children: [],
}

/** A finished reply: Streamdown's own context, out of streaming mode. */
function Finished({ children }: { children: ReactNode }) {
  const context = useContext(StreamdownContext)
  return (
    <StreamdownContext.Provider value={{ ...context, mode: "static" }}>
      {children}
    </StreamdownContext.Provider>
  )
}

describe("charts in a json-render card", () => {
  it("are never loaded for a card without one", async () => {
    const source = spec([
      "note",
      { type: "Text", props: { text: "No chart here" }, children: [] },
    ]).join("\n")
    render(<JsonRenderBlock source={source} fallback={null} />)
    expect(screen.getByText("No chart here")).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(chunk.loads).toBe(0)
  })

  // A lazy component always shows its fallback first, the chunk being
  // loaded only once it is asked for.
  it("hold the chart's own box until their chunk arrives", async () => {
    const { container } = render(
      <Finished>
        <JsonRenderBlock
          source={spec(["bar", BAR], ["pie", PIE]).join("\n")}
          fallback={null}
        />
      </Finished>
    )
    expect(screen.getByText("Sales")).toBeInTheDocument()
    expect(screen.queryByTestId("chart")).toBeNull()
    const [bar, pie] = container.querySelectorAll<HTMLElement>(
      '[data-slot="skeleton"]'
    )
    expect(bar.style.height).toBe("300px")
    expect(bar.classList.contains("w-full")).toBe(true)
    // A round chart's box: the card's width, and room for a legend.
    expect(pie.style.height).toBe("300px")
    expect(pie.classList.contains("w-full")).toBe(true)

    const charts = await screen.findAllByTestId("chart")
    expect(chunk.loads).toBe(1)
    expect(charts.map((chart) => chart.dataset.type)).toEqual([
      "BarChart",
      "PieChart",
    ])
    expect(charts[0].dataset.streaming).toBe("false")
    expect(charts[0].textContent).toBe(JSON.stringify(SALES))
  })

  it("get data bound to state, and know while the reply streams", async () => {
    const source = [
      ...spec([
        "line",
        {
          type: "LineChart",
          props: { data: { $state: "/sales" }, xKey: "month", series: [] },
          children: [],
        },
      ]),
      line({ op: "add", path: "/state/sales", value: SALES }),
    ].join("\n")
    // Outside a finished reply, Streamdown's context says it streams.
    render(<JsonRenderBlock source={source} fallback={null} />)
    const chart = await screen.findByTestId("chart")
    expect(chart.dataset.type).toBe("LineChart")
    expect(chart.dataset.streaming).toBe("true")
    expect(chart.textContent).toBe(JSON.stringify(SALES))
  })
})
