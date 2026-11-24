import type { RootContent } from "mdast"
import { fromMarkdown, type Options } from "mdast-util-from-markdown"

const BLOCK_START =
  /^(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*<(?:html|style|div|section|article|aside|main|header|footer|nav|figure|details|table|ul|ol|dl|blockquote|pre|svg|p|h[1-6])(?:\s|>)/i
const LONE_STYLE = /^(?:\s|<!--[\s\S]*?-->)*<style(?:\s|>)/i
const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " "
  )
)
const RAW = new Set(
  "style script textarea title xmp iframe noembed noframes".split(" ")
)

/**
 * A line that can open a top-level HTML block (at most three spaces, then `<`)
 * or an HTML fence. Text without one holds nothing this file rewrites, so it
 * skips the Markdown parse — run on every streamed delta of a long reply, that
 * parse is what the rewrite costs (a `Map<string, T>` in prose or code is
 * enough to need it otherwise).
 */
const CANDIDATE_LINE = /(?:^|\n) {0,3}(?:<[!a-z]|(?:`{3,}|~{3,})[ \t]*htm)/i

/**
 * Block structure only. Which top-level blocks are HTML or code, and where
 * they start and end, is settled before CommonMark looks at any inline content,
 * so the inline constructs — most of the parse — can stay off.
 */
const BLOCKS_ONLY: Options = {
  extensions: [
    {
      disable: {
        null: [
          "attention",
          "autolink",
          "characterEscape",
          "characterReference",
          "codeText",
          "hardBreakEscape",
          "htmlText",
          "labelEnd",
          "labelStartImage",
          "labelStartLink",
        ],
      },
    },
  ],
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LINE_DONE = /[ \t]*\r?\n/y
const NON_SPACE = /\S/g

const LANGUAGE = {
  complete: "codeg-html",
  pending: "codeg-html-pending",
  source: "codeg-html-source",
} as const

/** What CommonMark makes of a line indented four spaces after a blank line —
 *  inside an HTML element written that way, still part of the element. */
function isIndentedCode(block: RootContent, text: string): boolean {
  const start = block.position?.start.offset
  return (
    block.type === "code" &&
    start !== undefined &&
    !FENCE_OPEN.test(text.slice(start, start + 8))
  )
}

/** Whether the line `at` is on has ended: while streaming it may still grow. */
function lineDone(text: string, at: number): boolean {
  LINE_DONE.lastIndex = at
  return LINE_DONE.test(text)
}

/**
 * Whether the text after `at` already shows the block that comes next. While
 * streaming, a line still arriving that opens with `<` may yet turn out to be
 * HTML and belong with what precedes it; anything else shows it does not.
 */
function shownAfter(text: string, at: number, streaming: boolean): boolean {
  NON_SPACE.lastIndex = at
  const next = NON_SPACE.exec(text)
  if (!next) return false
  return !streaming || next[0] !== "<" || text.includes("\n", next.index)
}

/** A fence's content so far: everything after its opening line. */
function fenceBody(text: string): string {
  const lineEnd = text.indexOf("\n")
  return lineEnd === -1 ? "" : text.slice(lineEnd + 1)
}

/** A line that closes a fence opened with `marker`. */
function fenceCloser(marker: string): RegExp {
  return new RegExp(
    `\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?(?:\\n|$)`
  )
}

/**
 * 找到一个完整根元素的末尾。引号、注释和原始文本元素中的尖括号不参与配对。
 * 前置 style 属于紧随其后的可视化根元素；不把半个流式元素交给浏览器自动补全。
 */
function htmlEnd(source: string, start: number): number | null {
  const stack: string[] = []
  let visual = false
  let cursor = start
  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor)
    if (lt === -1) return null
    if (stack.length === 0 && source.slice(cursor, lt).trim()) return null
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      if (end === -1) return null
      cursor = end + 3
      continue
    }
    const tag = /^<(\/)?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(source.slice(lt))
    if (!tag) {
      if (/^<!doctype\b/i.test(source.slice(lt))) {
        const end = source.indexOf(">", lt)
        if (end === -1) return null
        cursor = end + 1
      } else {
        cursor = lt + 1
      }
      continue
    }
    const name = tag[2].toLowerCase()
    let end = lt + tag[0].length
    let quote = ""
    for (; end < source.length; end++) {
      const char = source[end]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === ">") break
    }
    if (end === source.length) return null
    cursor = end + 1
    if (tag[1]) {
      const index = stack.lastIndexOf(name)
      if (index === -1) return null
      stack.length = index
      if (visual && stack.length === 0) return cursor
    } else {
      if (stack.length === 0 && name !== "style" && name !== "script")
        visual = true
      if (VOID.has(name) || /\/\s*>$/.test(source.slice(lt, cursor))) {
        if (visual && stack.length === 0) return cursor
        continue
      }
      stack.push(name)
      if (RAW.has(name)) {
        const close = new RegExp(`</${name}(?=[\\s/>])`, "i").exec(
          source.slice(cursor)
        )
        if (!close) return null
        cursor += close.index
      }
    }
  }
  return null
}

function fence(source: string, language: string): string {
  let longest = 2
  for (const match of source.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length)
  const marker = "`".repeat(longest + 1)
  return `${marker}${language}\n${source}\n${marker}`
}

/**
 * 每条回复各用一个处理器。流式追加时，已经定稿的结构——完整的 HTML 片段、仍在生成的
 * 片段之前的内容，以及最后一个顶层块之前的全部内容——不再重新解析，只解析其后的尾部；
 * 尾部若只是一个尚未闭合的代码围栏，就只留意它的闭合行。正文的 `transform` 仍按片段
 * 之间的整段执行（与一次性处理相同），所以只缓存到最后一个定稿片段为止的输出。
 */
export function createChatHtmlProcessor() {
  // The whole text of the last call: anything but an append starts over.
  let previous = ""
  // How much of the text is settled, and its output up to the end of the last
  // settled fragment. The settled text after that fragment, `sealedProse`, is
  // kept raw: the Markdown around fragments is transformed a whole stretch at
  // a time, and that stretch is still open.
  let sealedSource = ""
  let sealedOutput = ""
  let sealedProse = ""
  // The unsettled text is one fence still open: until a line that could close
  // it arrives, nothing in it can change how it parses.
  let openFence: { closer: RegExp; html: boolean } | null = null
  return (
    source: string,
    streaming: boolean,
    transform: (markdown: string) => string = (text) => text
  ): string => {
    if (!source.startsWith(previous)) {
      sealedSource = ""
      sealedOutput = ""
      sealedProse = ""
      openFence = null
    }
    previous = source
    const tail = source.slice(sealedSource.length)
    if (openFence && streaming && !openFence.closer.test(tail)) {
      return openFence.html
        ? sealedOutput +
            transform(sealedProse) +
            fence(fenceBody(tail), LANGUAGE.pending)
        : sealedOutput + transform(sealedProse + tail)
    }
    openFence = null
    if (!CANDIDATE_LINE.test(tail))
      return sealedOutput + transform(sealedProse + tail)
    const blocks = fromMarkdown(tail, BLOCKS_ONLY).children
    let result = sealedOutput
    // The Markdown since the last fragment, not yet transformed.
    let prose = sealedProse
    let cursor = 0
    // What this call settles: up to `sealedEnd` in `tail`.
    let sealedEnd = 0
    let nextOutput = sealedOutput
    let nextProse = sealedProse
    for (let index = 0; index < blocks.length; index++) {
      const node = blocks[index]
      const start = node.position?.start.offset
      const nodeEnd = node.position?.end.offset
      if (start === undefined || nodeEnd === undefined || start < cursor)
        continue
      const raw = node.type === "html" && BLOCK_START.test(tail.slice(start))
      const code = node.type === "code" && /^html?$/i.test(node.lang ?? "")
      if (!raw && !code) continue
      let end: number
      let html: string
      let state: keyof typeof LANGUAGE
      // Whether later text can no longer change this fragment.
      let final: boolean
      if (code) {
        html = node.value
        end = nodeEnd
        const original = tail.slice(start, end)
        const marker = FENCE_OPEN.exec(original)?.[1]
        const closed =
          marker !== undefined &&
          new RegExp(`\\n[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`).test(
            original
          )
        // Closed, and its closing line ended: until then it may still grow.
        final = closed && lineDone(tail, end)
        const htmlStart = html.search(/\S/)
        // A closed fence is what its author meant to show. One cut off
        // unclosed (the reply ended) shows only once a whole root is in it.
        state =
          streaming && !final
            ? "pending"
            : htmlStart !== -1 && (closed || htmlEnd(html, htmlStart) !== null)
              ? "complete"
              : "source"
      } else {
        // A fragment is the HTML blocks in a row this one starts (with the
        // indented-code blocks blank lines make of its indented lines): its
        // root has to close inside them. Tags that close only across Markdown
        // wrap Markdown — a <details> around a list — and are not a fragment.
        let last = index
        while (
          last + 1 < blocks.length &&
          (blocks[last + 1].type === "html" ||
            isIndentedCode(blocks[last + 1], tail))
        )
          last++
        const run = blocks.slice(index, last + 1)
        const runEnd = run[run.length - 1].position?.end.offset ?? nodeEnd
        const scope = tail.slice(0, runEnd)
        // Where the block holding `at` ends.
        const reach = (at: number) => {
          let limit = nodeEnd
          for (const block of run) {
            if ((block.position?.start.offset ?? Infinity) < at)
              limit = Math.max(limit, block.position?.end.offset ?? 0)
          }
          return limit
        }
        let found = htmlEnd(scope, start)
        end = found ?? tail.length
        // style 和可视化根元素可能分属两个 AST 节点；把同一 HTML 块的相邻根元素一起交给预览。
        while (found !== null) {
          const limit = reach(end)
          if (end >= limit) break
          const next =
            end + (/^\s*/.exec(tail.slice(end, limit))?.[0].length ?? 0)
          if (next >= limit || !BLOCK_START.test(tail.slice(next))) {
            end = limit
            break
          }
          found = htmlEnd(scope, next)
          if (found !== null) end = found
        }
        // The next block, once known, means the block a fragment ends in has
        // ended; until then another root may still join the fragment, and a
        // root that has not closed may still close.
        final = shownAfter(
          tail,
          found === null ? runEnd : reach(end),
          streaming
        )
        if (found !== null && (final || !streaming)) {
          state = "complete"
        } else if (!final) {
          // The fragment ends the text so far: still arriving, or cut off.
          state = streaming ? "pending" : "source"
          end = tail.length
        } else if (
          LONE_STYLE.test(tail.slice(start)) &&
          !BLOCK_START.test(tail.slice(nodeEnd))
        ) {
          state = "source"
          end = nodeEnd
        } else {
          continue
        }
        html = tail.slice(start, end)
      }
      prose += tail.slice(cursor, start)
      if (state === "pending" && start > sealedEnd) {
        // What comes before a fragment still arriving is settled.
        sealedEnd = start
        nextProse = prose
      }
      result += transform(prose) + fence(html, LANGUAGE[state])
      // A closing fence must end its line, or it does not close.
      if (end < tail.length && tail[end] !== "\n") result += "\n"
      prose = ""
      cursor = end
      if (final) {
        sealedEnd = end
        nextOutput = result
        nextProse = ""
      }
    }
    // Text can change only the last top-level block — extend a paragraph or a
    // list, close a fence — so everything before it is settled as well. Except
    // while that block's first line is still arriving with a `<`: it may yet
    // be HTML, and the HTML blocks right before it belong with it then.
    const lastBlock = blocks[blocks.length - 1]
    const lastStart = lastBlock?.position?.start.offset
    let stable = blocks.length - 1
    if (
      streaming &&
      lastStart !== undefined &&
      !shownAfter(tail, lastStart, streaming)
    ) {
      while (
        stable > 0 &&
        (blocks[stable - 1].type === "html" ||
          isIndentedCode(blocks[stable - 1], tail))
      )
        stable--
    }
    const stableStart = blocks[stable]?.position?.start.offset
    if (stableStart !== undefined && stableStart > cursor) {
      sealedEnd = stableStart
      nextProse = prose + tail.slice(cursor, stableStart)
    }
    if (streaming && lastBlock?.type === "code" && lastStart === sealedEnd) {
      const fenceText = tail.slice(sealedEnd)
      const marker = FENCE_OPEN.exec(fenceText)?.[1]
      const closer = marker === undefined ? null : fenceCloser(marker)
      if (closer && !closer.test(fenceText)) {
        openFence = { closer, html: /^html?$/i.test(lastBlock.lang ?? "") }
      }
    }
    result += transform(prose + tail.slice(cursor))
    if (sealedEnd > 0) {
      sealedOutput = nextOutput
      sealedProse = nextProse
      sealedSource = source.slice(0, sealedSource.length + sealedEnd)
    }
    return result
  }
}
