"use client"

/**
 * The `pre` override `MessageResponse` installs: Mermaid's, plus json-render.
 *
 * A ```spec fence in an assistant reply renders as a json-render card
 * (`components/message/json-render-block.tsx`, loaded the first time one
 * appears). No switch gates it: an agent writes the fence once it has the
 * `ui-render` skill, which is what the user enables per agent (Settings >
 * Skill Packs > UI), and a card it drew stays a card after that. Every other
 * fence — and a spec fence anywhere else: a user message, a tool's output —
 * goes on to `MermaidAwarePre` exactly as before.
 *
 * The override itself must be a module constant: neither `MessageResponse`
 * nor Streamdown re-renders when `components` changes, so the reply scope is
 * read inside the fence's own component, the way Mermaid reads the appearance
 * setting.
 */

import {
  Component,
  createContext,
  isValidElement,
  lazy,
  Suspense,
  useContext,
  type ReactNode,
} from "react"
import type { Components } from "streamdown"

import { MermaidAwarePre } from "./mermaid-block"

const JsonRenderBlock = lazy(
  () => import("@/components/message/json-render-block")
)

const AssistantReplyContext = createContext(false)

/** Marks the Markdown below it as an assistant reply's text — the one place
 *  a spec fence becomes a card, as in json-render's own chat examples. */
export function JsonRenderScope({ children }: { children: ReactNode }) {
  return (
    <AssistantReplyContext.Provider value>
      {children}
    </AssistantReplyContext.Provider>
  )
}

/** `language-spec` and nothing else, among Streamdown's other classes. */
const SPEC_LANGUAGE = /(?:^|\s)language-spec(?:\s|$)/

/**
 * The text of a ```spec fence that may hold a json-render spec, or `null`.
 * Whether it really does is decided by json-render's own parser inside the
 * card; this only keeps the card's code from loading for a fence whose first
 * line cannot be a patch, such as an RPM spec file.
 */
function specSourceFromPre(child: ReactNode): string | null {
  if (!isValidElement<{ className?: unknown; children?: unknown }>(child)) {
    return null
  }
  const { className, children: source } = child.props
  if (typeof className !== "string" || !SPEC_LANGUAGE.test(className)) {
    return null
  }
  if (typeof source !== "string") return null
  const first = source.split("\n").find((line) => line.trim() !== "")
  return first?.trimStart().startsWith("{") ? source : null
}

/**
 * Shows the fence as code when the card cannot render — a spec json-render
 * throws on, or a card chunk that failed to load — instead of letting the
 * error take down the message list around it. A new version of the fence
 * (the reply still streaming) gets another try.
 */
class CardBoundary extends Component<
  { source: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean; source: string }
> {
  state = { failed: false, source: this.props.source }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: { source: string },
    state: { failed: boolean; source: string }
  ) {
    return props.source === state.source
      ? null
      : { failed: false, source: props.source }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function SpecFence({
  source,
  children,
}: {
  source: string
  children?: ReactNode
}) {
  const inReply = useContext(AssistantReplyContext)
  const code = <MermaidAwarePre>{children}</MermaidAwarePre>
  if (!inReply) return code
  return (
    <CardBoundary source={source} fallback={code}>
      <Suspense fallback={code}>
        <JsonRenderBlock source={source} fallback={code} />
      </Suspense>
    </CardBoundary>
  )
}

function JsonRenderAwarePre({ children }: { children?: ReactNode }) {
  const source = specSourceFromPre(children)
  if (source === null) return <MermaidAwarePre>{children}</MermaidAwarePre>
  return <SpecFence source={source}>{children}</SpecFence>
}

export const messageBlockComponents: Components = {
  pre: JsonRenderAwarePre as Components["pre"],
}
