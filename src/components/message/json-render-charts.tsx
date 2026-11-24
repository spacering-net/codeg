"use client"

/**
 * The charts of a json-render card (`lib/json-render/charts.ts`), each drawn
 * the way shadcn's chart examples draw its family
 * (https://ui.shadcn.com/charts): Recharts inside shadcn's `ChartContainer`,
 * with its tooltip and legend.
 *
 * Loaded on its own the first time a card has a chart (see
 * `./json-render-block.tsx`): Recharts weighs nearly as much as the rest of
 * the card.
 */

import type { ReactElement, ReactNode } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { useChatAnimationsEnabled } from "@/hooks/use-appearance"
import {
  CATEGORY,
  categoryChartData,
  chartBox,
  fieldName,
  scatterChartData,
  seriesChartData,
} from "@/lib/json-render/chart-data"
import type { ChartType } from "@/lib/json-render/charts"
import { cn } from "@/lib/utils"

type Props = Record<string, unknown>

interface ChartProps {
  props: Props
  animate: boolean
}

const CURVES = ["natural", "linear", "step"] as const

function curveOf(value: unknown): (typeof CURVES)[number] {
  return CURVES.find((curve) => curve === value) ?? "natural"
}

/** The total in the middle of a donut or radial chart, as shadcn's
 *  donut-with-text and radial-text examples draw it. */
function centerLabel(total: number, caption: string) {
  return function CenterLabel({
    viewBox,
  }: {
    viewBox?: unknown
  }): ReactElement | null {
    if (!viewBox || typeof viewBox !== "object") return null
    const { cx, cy } = viewBox as { cx?: number; cy?: number }
    if (typeof cx !== "number" || typeof cy !== "number") return null
    return (
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
        <tspan x={cx} y={cy} className="fill-foreground text-3xl font-bold">
          {total.toLocaleString()}
        </tspan>
        <tspan x={cx} y={cy + 24} className="fill-muted-foreground">
          {caption}
        </tspan>
      </text>
    )
  }
}

function AreaChartView({ props, animate }: ChartProps) {
  const { rows, series, config } = seriesChartData(
    props.data,
    props.xKey,
    props.series
  )
  const stacked = props.stacked === true
  const curve = curveOf(props.curve)
  return (
    <ChartContainer config={config} {...chartBox("AreaChart", props)}>
      <AreaChart
        accessibilityLayer
        data={rows}
        margin={{ left: 12, right: 12 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey={CATEGORY}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator={stacked ? "dot" : "line"} />}
        />
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent />} />
        )}
        {series.map(({ id }) => (
          <Area
            key={id}
            dataKey={id}
            type={curve}
            fill={`var(--color-${id})`}
            fillOpacity={0.4}
            stroke={`var(--color-${id})`}
            stackId={stacked ? "a" : undefined}
            isAnimationActive={animate}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}

/** shadcn's corners: rounded bars, and a stack rounded only at its ends. */
function barRadius(
  index: number,
  count: number,
  stacked: boolean,
  horizontal: boolean
): number | [number, number, number, number] {
  if (!stacked) return count > 1 ? 4 : horizontal ? 5 : 8
  if (count === 1) return 4
  const first = index === 0
  const last = index === count - 1
  if (horizontal) return first ? [4, 0, 0, 4] : last ? [0, 4, 4, 0] : 0
  return first ? [0, 0, 4, 4] : last ? [4, 4, 0, 0] : 0
}

function BarChartView({ props, animate }: ChartProps) {
  const { rows, series, config } = seriesChartData(
    props.data,
    props.xKey,
    props.series
  )
  const stacked = props.stacked === true
  const horizontal = props.horizontal === true
  const labels = props.labels === true
  return (
    <ChartContainer config={config} {...chartBox("BarChart", props)}>
      <BarChart
        accessibilityLayer
        data={rows}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={labels ? (horizontal ? { right: 32 } : { top: 20 }) : undefined}
      >
        {horizontal ? (
          <>
            <XAxis type="number" hide />
            <YAxis
              dataKey={CATEGORY}
              type="category"
              width="auto"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
            />
          </>
        ) : (
          <>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey={CATEGORY}
              tickLine={false}
              tickMargin={10}
              axisLine={false}
            />
          </>
        )}
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideLabel={series.length === 1}
              indicator={series.length > 1 && !stacked ? "dashed" : "dot"}
            />
          }
        />
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent />} />
        )}
        {series.map(({ id }, index) => (
          <Bar
            key={id}
            dataKey={id}
            fill={`var(--color-${id})`}
            stackId={stacked ? "a" : undefined}
            radius={barRadius(index, series.length, stacked, horizontal)}
            isAnimationActive={animate}
          >
            {labels && (
              <LabelList
                position={horizontal ? "right" : "top"}
                offset={horizontal ? 8 : 12}
                className="fill-foreground"
                fontSize={12}
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  )
}

function LineChartView({ props, animate }: ChartProps) {
  const { rows, series, config } = seriesChartData(
    props.data,
    props.xKey,
    props.series
  )
  const labels = props.labels === true
  const dots = labels || props.dots === true
  return (
    <ChartContainer config={config} {...chartBox("LineChart", props)}>
      <LineChart
        accessibilityLayer
        data={rows}
        margin={{ top: labels ? 20 : undefined, left: 12, right: 12 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey={CATEGORY}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideLabel={series.length === 1 && !labels}
              indicator={labels ? "line" : "dot"}
            />
          }
        />
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent />} />
        )}
        {series.map(({ id }) => (
          <Line
            key={id}
            dataKey={id}
            type={curveOf(props.curve)}
            stroke={`var(--color-${id})`}
            strokeWidth={2}
            dot={dots ? { fill: `var(--color-${id})` } : false}
            activeDot={dots ? { r: 6 } : undefined}
            isAnimationActive={animate}
          >
            {labels && (
              <LabelList
                position="top"
                offset={12}
                className="fill-foreground"
                fontSize={12}
              />
            )}
          </Line>
        ))}
      </LineChart>
    </ChartContainer>
  )
}

function PieChartView({ props, animate }: ChartProps) {
  const { rows, config, total } = categoryChartData(
    props.data,
    props.nameKey,
    props.valueKey
  )
  const caption = fieldName(props.centerLabel)
  const donut = props.donut === true || caption !== null
  const labels = props.labels === true
  const box = chartBox("PieChart", props)
  return (
    <ChartContainer
      config={config}
      className={cn(
        box.className,
        labels && "[&_.recharts-pie-label-text]:fill-foreground"
      )}
      style={box.style}
    >
      <PieChart>
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel nameKey="id" />}
        />
        <Pie
          data={rows}
          dataKey="value"
          nameKey="id"
          innerRadius={donut ? "48%" : undefined}
          strokeWidth={donut ? 5 : undefined}
          label={labels}
          isAnimationActive={animate}
        >
          {caption !== null && <Label content={centerLabel(total, caption)} />}
        </Pie>
        {props.legend === true && (
          <ChartLegend
            content={<ChartLegendContent nameKey="id" />}
            className="-translate-y-2 flex-wrap gap-2 *:basis-1/4 *:justify-center"
          />
        )}
      </PieChart>
    </ChartContainer>
  )
}

function RadarChartView({ props, animate }: ChartProps) {
  const { rows, series, config } = seriesChartData(
    props.data,
    props.xKey,
    props.series
  )
  const filled = props.filled !== false
  return (
    <ChartContainer config={config} {...chartBox("RadarChart", props)}>
      <RadarChart data={rows}>
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="line" />}
        />
        <PolarAngleAxis dataKey={CATEGORY} />
        <PolarGrid
          gridType={props.grid === "circle" ? "circle" : "polygon"}
          radialLines={filled}
        />
        {series.map(({ id }) => (
          <Radar
            key={id}
            dataKey={id}
            fill={`var(--color-${id})`}
            fillOpacity={filled ? (series.length > 1 ? 0.4 : 0.6) : 0}
            stroke={filled ? undefined : `var(--color-${id})`}
            strokeWidth={filled ? undefined : 2}
            dot={props.dots === true ? { r: 4, fillOpacity: 1 } : false}
            isAnimationActive={animate}
          />
        ))}
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent />} />
        )}
      </RadarChart>
    </ChartContainer>
  )
}

function RadialChartView({ props, animate }: ChartProps) {
  const { rows, config, total } = categoryChartData(
    props.data,
    props.nameKey,
    props.valueKey
  )
  const caption = fieldName(props.centerLabel)
  const labels = props.labels === true
  return (
    <ChartContainer config={config} {...chartBox("RadialChart", props)}>
      <RadialBarChart
        data={rows}
        startAngle={labels ? -90 : undefined}
        endAngle={labels ? 380 : undefined}
        innerRadius={caption !== null ? "32%" : "24%"}
        outerRadius="88%"
      >
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel nameKey="id" />}
        />
        <RadialBar dataKey="value" background isAnimationActive={animate}>
          {labels && (
            <LabelList
              position="insideStart"
              dataKey="label"
              className="fill-white mix-blend-luminosity"
              fontSize={11}
            />
          )}
        </RadialBar>
        {caption !== null && (
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <Label content={centerLabel(total, caption)} />
          </PolarRadiusAxis>
        )}
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent nameKey="id" />} />
        )}
      </RadialBarChart>
    </ChartContainer>
  )
}

function ScatterChartView({ props, animate }: ChartProps) {
  const { groups, config } = scatterChartData(
    props.data,
    props.xKey,
    props.yKey,
    props.nameKey
  )
  return (
    <ChartContainer config={config} {...chartBox("ScatterChart", props)}>
      <ScatterChart accessibilityLayer margin={{ left: 12, right: 12 }}>
        <CartesianGrid />
        <XAxis
          type="number"
          dataKey="x"
          name="x"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="y"
          width="auto"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <ChartTooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={<ChartTooltipContent hideLabel />}
        />
        {props.legend === true && (
          <ChartLegend content={<ChartLegendContent nameKey="value" />} />
        )}
        {groups.map(({ id, points }) => (
          <Scatter
            key={id}
            name={id}
            data={points}
            fill={`var(--color-${id})`}
            isAnimationActive={animate}
          />
        ))}
      </ScatterChart>
    </ChartContainer>
  )
}

const VIEWS: Record<ChartType, (props: ChartProps) => ReactNode> = {
  AreaChart: AreaChartView,
  BarChart: BarChartView,
  LineChart: LineChartView,
  PieChart: PieChartView,
  RadarChart: RadarChartView,
  RadialChart: RadialChartView,
  ScatterChart: ScatterChartView,
}

export default function JsonRenderChart({
  type,
  props,
  streaming,
}: {
  type: ChartType
  props: Props
  /** The reply is still arriving: each new row would restart the
   *  animation, so the chart just grows. */
  streaming: boolean
}) {
  const animations = useChatAnimationsEnabled()
  const View = VIEWS[type]
  return <View props={props} animate={animations && !streaming} />
}
