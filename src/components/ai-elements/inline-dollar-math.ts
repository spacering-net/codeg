import { fromMarkdown } from "mdast-util-from-markdown"
import type { Nodes } from "mdast"

type DollarRun = RegExpExecArray

function dollarRuns(source: string): DollarRun[] {
  return [...source.matchAll(/\\.|\$+/g)].filter((match) => match[0][0] === "$")
}

/**
 * Whether `$…$` from `open` to `close` (adjacent single-dollar runs) is
 * tightly delimited, same-line TeX by its own text alone — before any code,
 * HTML or display-math context is considered.
 */
function isFormulaPair(source: string, open: DollarRun, close: DollarRun) {
  if (open[0] !== "$" || close[0] !== "$") return false
  const start = open.index
  const end = close.index
  const inner = source.slice(start + 1, end)
  return !(
    /[\w$]/.test(source[start - 1] ?? "") ||
    // A closer that starts another shell expansion (`$a${b}`, `$A$@`,
    // `$(a)/$(b)`) is a shell `$`, not the end of a formula.
    /[\w${(@]/.test(source[end + 1] ?? "") ||
    !inner ||
    // A trailing escaped `\$` would merge into the closing `$$` run.
    /^[\s{]|[\s$]$|[\n\r\0]/.test(inner) ||
    // Plain letter symbols (including AV), TeX commands, operators and
    // function notation. Bare amounts and ordinary prose stay literal.
    !(/^[a-zA-Z]+$/.test(inner) || /[\\^_=+<>-]|[a-zA-Z]\(/.test(inner))
  )
}

/**
 * Cheap superset of "`normalizeInlineDollarMath` would rewrite something":
 * every pair it rewrites is an adjacent pair accepted here. Skips the Markdown
 * parse, so it may also be true for a formula that only appears inside code.
 */
export function hasInlineDollarMathCandidate(source: string): boolean {
  if (source.indexOf("$", source.indexOf("$") + 1) < 0) return false
  return hasFormulaPair(source, dollarRuns(source))
}

function hasFormulaPair(source: string, dollars: DollarRun[]): boolean {
  for (let i = 0; i + 1 < dollars.length; i += 1) {
    if (isFormulaPair(source, dollars[i], dollars[i + 1])) return true
  }
  return false
}

/**
 * Opt in only tightly delimited, same-line formulas, not currency or shell
 * expansions. Keep remark-math's permissive single-dollar mode disabled.
 * Protect code and raw HTML using CommonMark positions, including unfinished
 * fences and indented/nested blocks. Regex-only masking misses those while
 * streaming.
 */
export function normalizeInlineDollarMath(source: string): string {
  if (source.indexOf("$", source.indexOf("$") + 1) < 0) return source
  const dollars = dollarRuns(source)
  // Runs on every streamed delta: without a candidate the parse below is the
  // whole cost and cannot change the result.
  if (!hasFormulaPair(source, dollars)) return source
  const literals: { start: number; end: number }[] = []
  function collect(node: Nodes) {
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html"
    ) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined)
        literals.push({ start, end })
    } else if ("children" in node) {
      for (const child of node.children) collect(child)
    }
  }
  // Most prose/formulas need no extra parse; every CommonMark literal code
  // span has a backtick, tilde fence, tab, or a run of four spaces, and raw
  // HTML has a `<`.
  if (/[`<\t]|~{3}| {4}/.test(source)) collect(fromMarkdown(source))
  const parts: string[] = []
  let copied = 0
  let literalIndex = 0
  for (let i = 0; i < dollars.length; i += 1) {
    const open = dollars[i]
    while (
      literalIndex < literals.length &&
      literals[literalIndex].end <= open.index
    ) {
      literalIndex += 1
    }
    const literal = literals[literalIndex]
    if (literal && literal.start <= open.index) continue
    if (open[0].length > 1) {
      // Never rewrite inside existing display/inline math, including an
      // unfinished display fence while a response is streaming.
      while (++i < dollars.length && dollars[i][0].length < open[0].length) {
        // Display fences may close with a longer dollar run.
      }
      continue
    }
    const close = dollars[i + 1]
    if (
      !close ||
      (literal && literal.start < close.index) ||
      !isFormulaPair(source, open, close)
    ) {
      continue
    }
    const inner = source.slice(open.index + 1, close.index)
    parts.push(source.slice(copied, open.index), `$$${inner}$$`)
    copied = close.index + 1
    i += 1
  }
  if (!parts.length) return source
  parts.push(source.slice(copied))
  return parts.join("")
}
