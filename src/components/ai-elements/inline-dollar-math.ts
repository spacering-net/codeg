import { fromMarkdown } from "mdast-util-from-markdown"
import type { Nodes } from "mdast"

/**
 * Opt in only tightly delimited, same-line formulas, not currency or shell
 * expansions. Keep remark-math's permissive single-dollar mode disabled.
 * Protect code using CommonMark positions, including unfinished fences and
 * indented/nested blocks. Regex-only masking misses those while streaming.
 */
export function normalizeInlineDollarMath(source: string): string {
  if (source.indexOf("$", source.indexOf("$") + 1) < 0) return source
  const literals: { start: number; end: number }[] = []
  function collect(node: Nodes) {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined)
        literals.push({ start, end })
    } else if ("children" in node) {
      for (const child of node.children) collect(child)
    }
  }
  // Most prose/formulas need no extra parse; every CommonMark literal code
  // span has a backtick, tilde fence, tab, or a run of four spaces.
  if (/`|~{3}|\t| {4}/.test(source)) collect(fromMarkdown(source))
  const dollars = [...source.matchAll(/\\.|\$+/g)].filter(
    (match) => match[0][0] === "$"
  )
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
    if (!close || close[0] !== "$") continue
    const start = open.index
    const end = close.index
    const inner = source.slice(start + 1, end)
    if (
      (literal && literal.start < end) ||
      /[\w$]/.test(source[start - 1] ?? "") ||
      /[\w$]/.test(source[end + 1] ?? "") ||
      !inner ||
      /^[\s{]|\s$|[\n\r\0]/.test(inner) ||
      // Plain letter symbols (including AV), TeX commands, operators and
      // function notation. Bare amounts and ordinary prose stay literal.
      !(/^[a-zA-Z]+$/.test(inner) || /[\\^_=+<>-]|[a-zA-Z]\(/.test(inner))
    ) {
      continue
    }
    parts.push(source.slice(copied, start), `$$${inner}$$`)
    copied = end + 1
    i += 1
  }
  if (!parts.length) return source
  parts.push(source.slice(copied))
  return parts.join("")
}
