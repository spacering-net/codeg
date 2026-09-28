import type { Nodes, Root } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"

export interface SpeakableLabels {
  codeOmitted: string
  tableOmitted: string
}

const BARE_URL = /https?:\/\/\S+/g
const SENTENCE_END = /[.!?:;。！？：；]$/
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/

const parser = unified().use(remarkParse).use(remarkGfm)

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function asSentence(text: string): string {
  const clean = collapse(text)
  if (!clean) return ""
  return SENTENCE_END.test(clean) ? clean : `${clean}.`
}

function inlineText(node: Nodes, labels: SpeakableLabels): string {
  switch (node.type) {
    case "text":
      return node.value.replace(BARE_URL, "")
    case "inlineCode":
      return node.value
    case "break":
      return " "
    case "image":
    case "imageReference":
    case "html":
    case "footnoteReference":
      return ""
    default:
      if ("children" in node) {
        return (node.children as Nodes[])
          .map((child) => inlineText(child, labels))
          .join("")
      }
      return ""
  }
}

function blockSentences(node: Nodes, labels: SpeakableLabels): string[] {
  switch (node.type) {
    case "code":
      return [asSentence(labels.codeOmitted)]
    case "table":
      return [asSentence(labels.tableOmitted)]
    case "html":
    case "thematicBreak":
    case "footnoteDefinition":
    case "definition":
    case "yaml":
      return []
    case "heading":
    case "paragraph":
      return [asSentence(inlineText(node, labels))]
    case "root":
    case "blockquote":
    case "list":
    case "listItem":
      return node.children.flatMap((child) =>
        blockSentences(child as Nodes, labels)
      )
    default:
      return [asSentence(inlineText(node, labels))]
  }
}

export function toSpeakableText(
  markdown: string,
  labels: SpeakableLabels
): string {
  const tree = parser.parse(markdown) as Root
  return blockSentences(tree, labels).filter(Boolean).join(" ")
}

function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let current = ""
  for (const char of text) {
    current += char
    if (/[.!?。！？\n]/.test(char)) {
      sentences.push(current)
      current = ""
    }
  }
  if (current) sentences.push(current)
  return sentences
}

function hardSplit(sentence: string, maxLen: number): string[] {
  const pieces: string[] = []
  let rest = sentence
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen)
    const space = window.lastIndexOf(" ")
    const cut =
      space > 0 && !CJK.test(window.charAt(maxLen - 1)) ? space + 1 : maxLen
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) pieces.push(rest)
  return pieces
}

/**
 * Packs whole sentences greedily into chunks of at most `maxLen` characters.
 * Chunks keep their original spacing, so `chunks.join("")` is the input.
 */
export function chunkSpeakableText(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let current = ""
  for (const sentence of splitSentences(text)) {
    for (const piece of hardSplit(sentence, maxLen)) {
      if (current.length + piece.length > maxLen && current) {
        chunks.push(current)
        current = ""
      }
      current += piece
    }
  }
  if (current) chunks.push(current)
  return chunks.filter((chunk) => chunk.trim().length > 0)
}
