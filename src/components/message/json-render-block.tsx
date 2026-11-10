"use client"

/**
 * A ```spec fence from an assistant reply, rendered as json-render UI.
 *
 * Loaded on demand (see `ai-elements/json-render-pre.tsx`): json-render, zod
 * and the 36 shadcn components weigh about 200 KB gzipped, and most replies
 * never contain a spec.
 *
 * Everything here is json-render's own — its compiler, its provider and
 * renderer, its shadcn components — wired the way its chat examples wire
 * them. Codeg swaps two components. `Link`: json-render's is a bare
 * `<a href>`, and Codeg's main window has no navigation guard, so a click on
 * it would navigate the whole app away. Codeg's own Markdown link opens it
 * the way every other link in the chat opens. And `Card`, for one without
 * a shadow. The one thing Codeg adds is charts, which json-render leaves to
 * each app (`./json-render-charts.tsx`).
 */

import {
  lazy,
  Suspense,
  useContext,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  defineRegistry,
  JSONUIProvider,
  Renderer,
  type BaseComponentProps,
} from "@json-render/react"
import { shadcnComponents, type ShadcnProps } from "@json-render/shadcn"
import { StreamdownContext } from "streamdown"

import { MarkdownLink } from "@/components/ai-elements/markdown-link"
import { Skeleton } from "@/components/ui/skeleton"
import { jsonRenderCatalog } from "@/lib/json-render/catalog"
import { chartBox } from "@/lib/json-render/chart-data"
import type { ChartType } from "@/lib/json-render/charts"
import {
  compileSpec,
  hasChildCycle,
  isSpecStream,
} from "@/lib/json-render/spec"
import { cn } from "@/lib/utils"

/**
 * json-render's Link semantics on Codeg's link: `press` fires first, and an
 * `on.press` binding that asks to prevent the default keeps the link from
 * opening. Without an `href` there is nothing to open, so it is a button that
 * only fires `press` — still reachable from the keyboard.
 */
function Link({ props, on }: BaseComponentProps<ShadcnProps<"Link">>) {
  if (!props.href) {
    return (
      <button
        type="button"
        className="wrap-anywhere appearance-none text-left text-sm font-medium text-primary underline"
        onClick={() => on("press").emit()}
      >
        {props.label}
      </button>
    )
  }
  const handleClickCapture = (event: MouseEvent<HTMLSpanElement>) => {
    // React bubbles events from portals through the component tree, so the
    // link's own context menu (copy, open in…) passes through here too; only
    // a click on the link itself is a press.
    if (!event.currentTarget.contains(event.target as Node)) return
    const press = on("press")
    if (press.shouldPreventDefault) {
      event.preventDefault()
      event.stopPropagation()
    }
    press.emit()
  }
  return (
    <span className="text-sm" onClickCapture={handleClickCapture}>
      <MarkdownLink href={props.href}>{props.label}</MarkdownLink>
    </span>
  )
}

const ShadcnCard = shadcnComponents.Card

/** json-render's card without its shadow, whatever classes the spec gives
 *  it: a card in a reply is part of the message, not a layer above it. */
function Card({ props, ...rest }: BaseComponentProps<ShadcnProps<"Card">>) {
  return (
    <ShadcnCard
      {...rest}
      props={{ ...props, className: cn(props.className, "shadow-none") }}
    />
  )
}

/** Recharts and the charts that use it, loaded the first time a card has a
 *  chart: they weigh nearly as much as the rest of this chunk. */
const JsonRenderChart = lazy(() => import("./json-render-charts"))

function chart(type: ChartType) {
  return function Chart({
    props,
    loading,
  }: BaseComponentProps<Record<string, unknown>>) {
    return (
      <Suspense fallback={<Skeleton {...chartBox(type, props)} />}>
        <JsonRenderChart
          type={type}
          props={props}
          streaming={loading === true}
        />
      </Suspense>
    )
  }
}

const { registry } = defineRegistry(jsonRenderCatalog, {
  components: {
    ...shadcnComponents,
    Card,
    Link,
    AreaChart: chart("AreaChart"),
    BarChart: chart("BarChart"),
    LineChart: chart("LineChart"),
    PieChart: chart("PieChart"),
    RadarChart: chart("RadarChart"),
    RadialChart: chart("RadialChart"),
    ScatterChart: chart("ScatterChart"),
  },
})

export default function JsonRenderBlock({
  source,
  fallback,
}: {
  source: string
  /** The fence as an ordinary code block: shown for anything that is not a
   *  spec json-render can render. */
  fallback: ReactNode
}) {
  // Streamdown's own streaming flag for this message: while the reply is
  // still arriving, json-render keeps quiet about children that have not
  // arrived yet.
  const { mode } = useContext(StreamdownContext)
  const spec = useMemo(() => {
    if (!isSpecStream(source)) return null
    try {
      const compiled = compileSpec(source)
      return hasChildCycle(compiled) ? null : compiled
    } catch {
      // A `test` patch that fails throws; the fence stays code.
      return null
    }
  }, [source])

  if (!spec) return <>{fallback}</>
  return (
    <div className="my-3 w-full min-w-0" data-json-render="">
      <JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
        <Renderer
          spec={spec}
          registry={registry}
          loading={mode === "streaming"}
        />
      </JSONUIProvider>
    </div>
  )
}
