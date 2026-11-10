import { z } from "zod"

/**
 * The charts an agent may put in a json-render card, one per family of
 * shadcn's chart examples (https://ui.shadcn.com/charts) plus a scatter plot,
 * which shadcn has no example of. json-render ships no charts of its own; its
 * chat example adds them to its catalog the same way.
 *
 * These are only the definitions — what the skill tells an agent. The
 * components that draw them are `components/message/json-render-charts.tsx`.
 */

const data = z.array(z.record(z.string(), z.unknown()))
const series = z.array(
  z.object({ key: z.string(), label: z.string().nullable() })
)
const legend = z.boolean().nullable()
const height = z.number().nullable()
const curve = z.enum(["natural", "linear", "step"]).nullable()

const SALES = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
]
const SALES_SERIES = [
  { key: "desktop", label: "Desktop" },
  { key: "mobile", label: "Mobile" },
]
const BROWSERS = [
  { browser: "Chrome", visitors: 275 },
  { browser: "Safari", visitors: 200 },
  { browser: "Firefox", visitors: 187 },
]

export const chartComponentDefinitions = {
  AreaChart: {
    props: z.object({
      data,
      xKey: z.string(),
      series,
      stacked: z.boolean().nullable(),
      curve,
      legend,
      height,
    }),
    description:
      'Area chart over categories. data: one object per x-axis point, e.g. [{"month":"Jan","desktop":186,"mobile":80}]; xKey: the field labelling each point ("month"); series: the numeric fields to plot, e.g. [{"key":"desktop","label":"Desktop"}]. stacked stacks the areas; curve is "natural" (default), "linear" or "step"; legend shows a legend; height is in pixels (default 250).',
    example: {
      data: SALES,
      xKey: "month",
      series: SALES_SERIES,
      stacked: true,
    },
  },
  BarChart: {
    props: z.object({
      data,
      xKey: z.string(),
      series,
      stacked: z.boolean().nullable(),
      horizontal: z.boolean().nullable(),
      labels: z.boolean().nullable(),
      legend,
      height,
    }),
    description:
      "Bar chart over categories. data, xKey and series as for AreaChart. stacked stacks the bars; horizontal lays them out sideways (good for long labels); labels prints each value on its bar.",
    example: { data: SALES, xKey: "month", series: SALES_SERIES },
  },
  LineChart: {
    props: z.object({
      data,
      xKey: z.string(),
      series,
      curve,
      dots: z.boolean().nullable(),
      labels: z.boolean().nullable(),
      legend,
      height,
    }),
    description:
      'Line chart over categories, for trends. data, xKey and series as for AreaChart. curve is "natural" (default), "linear" or "step"; dots marks each point; labels prints each value above its point.',
    example: { data: SALES, xKey: "month", series: SALES_SERIES, dots: true },
  },
  PieChart: {
    props: z.object({
      data,
      nameKey: z.string(),
      valueKey: z.string(),
      donut: z.boolean().nullable(),
      centerLabel: z.string().nullable(),
      labels: z.boolean().nullable(),
      legend,
      height,
    }),
    description:
      'Pie chart of the parts of a whole. data: one object per slice, e.g. [{"browser":"Chrome","visitors":275}]; nameKey: the field naming each slice ("browser"); valueKey: its numeric field ("visitors"). donut leaves a hole in the middle; centerLabel shows the total there with this caption under it; labels prints each value by its slice; legend lists the slices.',
    example: {
      data: BROWSERS,
      nameKey: "browser",
      valueKey: "visitors",
      centerLabel: "Visitors",
    },
  },
  RadarChart: {
    props: z.object({
      data,
      xKey: z.string(),
      series,
      grid: z.enum(["polygon", "circle"]).nullable(),
      filled: z.boolean().nullable(),
      dots: z.boolean().nullable(),
      legend,
      height,
    }),
    description:
      'Radar chart comparing values across several axes. data: one object per axis, e.g. [{"skill":"Speed","alice":80,"bob":65}]; xKey: the field naming each axis ("skill"); series: the numeric fields to plot, one shape each. grid is "polygon" (default) or "circle"; filled false draws outlines only; dots marks each value.',
    example: {
      data: [
        { skill: "Speed", alice: 80, bob: 65 },
        { skill: "Accuracy", alice: 70, bob: 90 },
        { skill: "Stamina", alice: 60, bob: 75 },
      ],
      xKey: "skill",
      series: [
        { key: "alice", label: "Alice" },
        { key: "bob", label: "Bob" },
      ],
    },
  },
  RadialChart: {
    props: z.object({
      data,
      nameKey: z.string(),
      valueKey: z.string(),
      centerLabel: z.string().nullable(),
      labels: z.boolean().nullable(),
      legend,
      height,
    }),
    description:
      "Radial bar chart: one ring per row, as long as its value. data, nameKey and valueKey as for PieChart. centerLabel shows the total in the middle with this caption under it; labels names each ring.",
    example: {
      data: BROWSERS,
      nameKey: "browser",
      valueKey: "visitors",
      labels: true,
    },
  },
  ScatterChart: {
    props: z.object({
      data,
      xKey: z.string(),
      yKey: z.string(),
      nameKey: z.string().nullable(),
      legend,
      height,
    }),
    description:
      'Scatter plot of points placed by two numeric fields. data: one object per point, e.g. [{"size":12,"ms":340,"team":"web"}]; xKey and yKey: the numeric fields for the two axes ("size", "ms"); nameKey: a field that groups the points into colored series ("team").',
    example: {
      data: [
        { size: 12, ms: 340, team: "web" },
        { size: 30, ms: 610, team: "api" },
      ],
      xKey: "size",
      yKey: "ms",
      nameKey: "team",
      legend: true,
    },
  },
}

export type ChartType = keyof typeof chartComponentDefinitions
