"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { ComponentProps } from "react"
import { cjk } from "@streamdown/cjk"
import type { Streamdown } from "streamdown"
import { hasInlineDollarMathCandidate } from "./inline-dollar-math"

// Streamdown's `plugins` prop config: `{ code?, mermaid?, math?, cjk? }`.
type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>
type CodePlugin = NonNullable<PluginConfig["code"]>
type MathPlugin = NonNullable<PluginConfig["math"]>
type MermaidPlugin = NonNullable<PluginConfig["mermaid"]>
export type HeavyKind = "code" | "math" | "mermaid"

// --- Why this module exists --------------------------------------------------
//
// The three heavy Streamdown plugins pull in the largest dependencies in the
// whole frontend: `@streamdown/code` → shiki (+ its full grammar/theme index,
// ~3.8M), `@streamdown/math` → katex (~4.3M), `@streamdown/mermaid` → mermaid +
// cytoscape + the entire d3 galaxy + dagre (~70M+ unpacked). Statically
// importing them — as `message.tsx`, `reasoning.tsx`, and `file-workspace-panel`
// each did — forces all three (and their transitive deps) into the first-paint
// chunk of `/workspace`, so even a text-only conversation downloads, parses, and
// executes them. Streamdown itself already `React.lazy`-loads its *render*
// components (code-block, mermaid) internally; the eager static plugin imports
// defeated that by pinning the heavy *engines* eagerly.
//
// This module loads each engine on demand — the first time rendered content
// actually contains the syntax that plugin handles — and at most once
// process-wide. Mounted consumers subscribe to a version counter and re-render
// when an engine resolves, upgrading the already-rendered fallback in place.
//
// Correctness: each engine only *affects* output when its trigger syntax is
// present (shiki only highlights fenced code; remark-math transforms `$$…$$`
// and ` ```math ` fences plus normalized `$…$`; mermaid only replaces ```mermaid
// blocks). Loading exactly when the trigger appears therefore reproduces the
// eager-plugin output byte-for-byte, save for a one-time pre-load fallback
// render (plain code / literal `$…$` / mermaid source) that upgrades once the
// engine arrives. Detection errs LOOSE on purpose — a false positive merely
// pre-loads an engine that then no-ops, exactly matching the previous
// always-loaded behavior; a false *negative* would silently drop real
// rendering. The math trigger is `$$` / `\(`/`\[` / a `math` fence, never a
// lone `$` (currency and `$HOME` / `$1` are prose).

const loaded: {
  code?: CodePlugin
  math?: MathPlugin
  mermaid?: MermaidPlugin
} = {}
const inflight = new Set<HeavyKind>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

function getVersion(): number {
  return version
}

// Guard against unsupported language identifiers (e.g. "##", "function", or a
// bare "mermaid" while its engine is still loading) that appear as the info
// string of fenced code blocks from tool output. Without this, Shiki's
// createHighlighter tries to load unknown grammars and produces noisy console
// errors. Verbatim behavior from the former `message.tsx` `safeCode`.
//
// NOTE: this wrapper is now applied uniformly to ALL Streamdown consumers.
// `message.tsx` previously wrapped `code`; `reasoning.tsx` and the markdown file
// preview passed the raw plugin. Applying the guard everywhere is deliberate:
// the rendered TEXT/semantic content is unchanged — an unsupported fence
// language stays plaintext either way — and it suppresses Shiki's unknown-
// grammar console noise for those two consumers too. (Styling may differ
// marginally: raw Shiki returns null for an unknown grammar and falls back to
// un-themed text, whereas mapping to "text" yields themed plaintext tokens —
// this only makes code-block theming more consistent, never changes content.)
function makeSafeCode(code: CodePlugin): CodePlugin {
  return {
    ...code,
    highlight(options, callback) {
      const language = code.supportsLanguage(options.language)
        ? options.language
        : ("text" as typeof options.language)
      return code.highlight({ ...options, language }, callback)
    },
  }
}

/**
 * Zero-width space `normalizeMathDelimiters` puts in front of a `$$` that
 * would otherwise start a line's block content and open a math FLOW fence.
 *
 * The pad in front of a CLOSING `$$` necessarily lands inside the formula, and
 * KaTeX does not ignore it: it lexes as a `textord`, which changes spacing
 * around a terminal operator or punctuation (`a+` stays `mbin` and gains
 * 0.2222em) and warns about unrecognized Unicode. Its whole job is to survive
 * micromark's block tokenizer, so it is removed once the tree exists — after
 * remark-math has built the math nodes, before rehype-katex reads them.
 */
export const MATH_FENCE_PAD = "​"

export type MdastNodeLike = {
  type: string
  value?: unknown
  data?: { hChildren?: unknown }
  children?: unknown
}

/**
 * Remove the fence pad from every math node in `tree`. Exported so the
 * KaTeX-equivalence regression can drive the real implementation.
 */
export function stripMathFencePad(node: MdastNodeLike): void {
  if (node.type === "inlineMath" || node.type === "math") {
    if (typeof node.value === "string" && node.value.endsWith(MATH_FENCE_PAD)) {
      node.value = node.value.slice(0, -MATH_FENCE_PAD.length)
    }
    // `mdast-util-math` pre-renders the value into `data.hChildren`, and that
    // is what `rehype-katex` actually reads.
    const hChildren = node.data?.hChildren
    if (Array.isArray(hChildren)) {
      for (const child of hChildren as MdastNodeLike[]) {
        if (
          child?.type === "text" &&
          typeof child.value === "string" &&
          child.value.endsWith(MATH_FENCE_PAD)
        ) {
          child.value = child.value.slice(0, -MATH_FENCE_PAD.length)
        }
      }
    }
    return
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children as MdastNodeLike[]) {
      stripMathFencePad(child)
    }
  }
}

/**
 * Wrap the math plugin so its remark half also strips the fence pad. Doing it
 * here rather than in each consumer's `remarkPlugins` keeps the pad's producer
 * and its consumer paired, and covers every caller of `useStreamdownPlugins`.
 */
function makeFencePadStripped(math: MathPlugin): MathPlugin {
  const declared = math.remarkPlugin
  const [plugin, options] = (
    Array.isArray(declared) ? declared : [declared, undefined]
  ) as [(...args: unknown[]) => unknown, unknown]
  function remarkMathWithoutFencePad(this: unknown) {
    // remark-math only registers micromark/mdast extensions and returns no
    // transformer, but chain whatever it does return rather than assume.
    const inner = plugin.call(this, options)
    return (tree: MdastNodeLike, file: unknown) => {
      if (typeof inner === "function") {
        ;(inner as (tree: unknown, file: unknown) => void)(tree, file)
      }
      stripMathFencePad(tree)
    }
  }
  return { ...math, remarkPlugin: remarkMathWithoutFencePad } as MathPlugin
}

function ensure(kind: HeavyKind): void {
  if (loaded[kind] || inflight.has(kind)) return
  inflight.add(kind)
  const settle = () => {
    inflight.delete(kind)
    emit()
  }
  if (kind === "code") {
    import("@streamdown/code")
      .then((mod) => {
        loaded.code = makeSafeCode(mod.code)
      })
      .catch(() => {})
      .finally(settle)
  } else if (kind === "math") {
    import("@streamdown/math")
      .then((mod) => {
        // `$x$` is deliberately literal. That reverts b23f6a5a ("enable
        // inline math formula rendering with single dollar signs"): `$VAR`,
        // `$1`, and `$9.99` show up in agent prose far more than `$x$`,
        // and `false` is @streamdown/math's own default. Inline math still
        // works via `$$x$$` (stays inline in a paragraph) and `\(...\)`.
        loaded.math = makeFencePadStripped(
          mod.createMathPlugin({ singleDollarTextMath: false })
        )
      })
      .catch(() => {})
      .finally(settle)
  } else {
    import("@streamdown/mermaid")
      .then((mod) => {
        loaded.mermaid = mod.mermaid
      })
      .catch(() => {})
      .finally(settle)
  }
}

/**
 * Warm one or more heavy engines ahead of first use — the same at-most-once,
 * process-wide load path as on-demand `ensure`, exposed so the workspace can
 * prefetch during idle time after first paint. This moves the multi-MB module
 * parse (shiki etc.) OFF the streaming hot path, where the first code fence in a
 * response would otherwise trigger the cold import + parse mid-stream. Idempotent:
 * re-calling for an already-loaded/in-flight engine is a no-op.
 */
export function prefetchHeavyPlugins(kinds: HeavyKind[]): void {
  for (const kind of kinds) ensure(kind)
}

/**
 * The Mermaid engine, once it has finished loading — `null` until then.
 *
 * Used by our own diagram block (`./mermaid-block.tsx`), which renders
 * ` ```mermaid ` fences instead of Streamdown's built-in component. Same
 * at-most-once module-level load as everything else here: the component only
 * mounts when a fence is actually present, so calling `ensure` from it keeps
 * the engine exactly as lazy as `useStreamdownPlugins` makes it.
 */
export function useMermaidEngine(): MermaidPlugin | null {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useEffect(() => {
    ensure("mermaid")
  }, [])
  return loaded.mermaid ?? null
}

export type HeavyPluginNeeds = Record<HeavyKind, boolean>

const NO_NEEDS: HeavyPluginNeeds = { code: false, math: false, mermaid: false }

/**
 * Cheap, behavior-preserving detection of which heavy plugins a piece of
 * Markdown needs. Runs on possibly-streaming text (once per streaming batch for
 * the live message; memoized to nothing for stable historical text), so it uses
 * only native `String` / regex scans.
 */
export function detectHeavyPlugins(text: string): HeavyPluginNeeds {
  const hasFence = text.includes("```") || text.includes("~~~")
  // CommonMark also renders indented blocks (≥4 spaces or a tab) as
  // `<pre><code>`, and the old eager plugin highlighted those too. Detecting
  // them precisely is context-sensitive — the required indent shifts inside
  // blockquotes (`>     x`), list items, and nested containers — so instead of
  // emulating a parser we use a GUARANTEED superset: every indented code line
  // has a run of ≥4 consecutive spaces or a tab in its RAW text (container
  // markers only ADD indent, never remove it), so we look for that run
  // anywhere. This can over-load the (small) Shiki engine for prose that merely
  // contains a tab or aligned spacing — safe, since it only reproduces the old
  // always-loaded behavior, the load is one-time per session, and the
  // per-language grammars (plus mermaid/katex) stay lazy regardless. Missing a
  // real indented block would instead leave it permanently unhighlighted (a
  // regression), so we err to the superset.
  const hasIndentedCode = / {4}|\t/.test(text)
  return {
    // Any fenced or indented block may want syntax highlighting.
    code: hasFence || hasIndentedCode,
    // `normalizeInlineDollarMath` rewrites tight `$…$` formulas to `$$…$$`.
    // Raw text is checked with its parse-free superset (a formula that only
    // sits in code loads KaTeX early, as `$$` in code already does).
    // `normalizeMathDelimiters` rewrites `\[…\]` / `\(...\)` to `$$…$$`.
    // rehype-katex also renders ` ```math ` fences with no `$` anywhere, so
    // those have to stay a trigger. Callers may detect on raw pre-normalized
    // text, so `\(` / `\[` count too.
    math:
      text.includes("$$") ||
      hasInlineDollarMathCandidate(text) ||
      text.includes("\\[") ||
      text.includes("\\(") ||
      /(?:```|~~~)[^\S\r\n]*math\b/i.test(text),
    // A ```mermaid (or ~~~mermaid) fence is the only thing the diagram engine
    // renders.
    mermaid: /(?:```|~~~)[^\S\r\n]*mermaid\b/i.test(text),
  }
}

const CJK_ONLY: PluginConfig = { cjk }

/**
 * Returns the Streamdown `plugins` config for `text`, loading the heavy engines
 * lazily and only when `text` needs them. Pass `null`/`undefined` (e.g. for
 * non-string children, or a non-preview mode) to request the light config only.
 */
export function useStreamdownPlugins(
  text: string | null | undefined
): PluginConfig {
  const needs = useMemo(
    () => (typeof text === "string" ? detectHeavyPlugins(text) : NO_NEEDS),
    [text]
  )
  // Destructure to primitives so the effect and the returned `plugins` object
  // stay reference-stable across streaming batches. `needs` is a fresh object
  // every time `text` grows (~60/s for the live message), but its booleans
  // rarely change; keying the effect and memo on the booleans avoids re-running
  // the effect and — crucially — avoids handing Streamdown a new `plugins`
  // object on every token, which would churn its plugin-dependent memos.
  const { code: needCode, math: needMath, mermaid: needMermaid } = needs

  // Re-render this consumer whenever a lazily-imported engine resolves.
  const currentVersion = useSyncExternalStore(subscribe, getVersion, getVersion)

  useEffect(() => {
    if (needCode) ensure("code")
    if (needMath) ensure("math")
    if (needMermaid) ensure("mermaid")
  }, [needCode, needMath, needMermaid])

  return useMemo(() => {
    if (!needCode && !needMath && !needMermaid) return CJK_ONLY
    const plugins: PluginConfig = { cjk }
    if (needCode && loaded.code) plugins.code = loaded.code
    if (needMath && loaded.math) plugins.math = loaded.math
    if (needMermaid && loaded.mermaid) plugins.mermaid = loaded.mermaid
    return plugins
    // `currentVersion` is the load signal: a resolved `ensure()` mutates the
    // module `loaded` cache and bumps the version, so this memo re-runs and
    // splices the freshly-loaded engine in. The needs booleans are the other
    // deps; `loaded` itself is intentionally read untracked (version covers it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needCode, needMath, needMermaid, currentVersion])
}

/** Test-only: reset the module-level plugin cache between test cases. */
export function __resetStreamdownPluginsForTest(): void {
  loaded.code = undefined
  loaded.math = undefined
  loaded.mermaid = undefined
  inflight.clear()
  listeners.clear()
  version = 0
}
