import type {
  ContentBlock,
  DbConversationSummary,
  MessageTurn,
  SessionStats,
  TurnUsage,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { downloadImage } from "@/lib/image-download"
import { saveTextFile, type SaveFileResult } from "@/lib/save-file"
import { toPng } from "html-to-image"

/** Outcome of an export operation — see {@link SaveFileResult}. */
export type ExportResult = SaveFileResult

export interface ExportLabels {
  untitledConversation: string
  agent: string
  model: string
  status: string
  started: string
  updated: string
  tokens: string
  duration: string
  inputTokens: string
  outputTokens: string
  cacheRead: string
  cacheWrite: string
  user: string
  assistant: string
  system: string
  toolResult: string
  toolError: string
  turnFailed: string
  statusLabels: Record<string, string>
}

export interface ExportConversationData {
  summary: DbConversationSummary
  turns: MessageTurn[]
  sessionStats?: SessionStats | null
  labels: ExportLabels
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExportFilename(title: string | null, ext: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const base = (title ?? "conversation")
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
  return `${base}-${date}.${ext}`
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return `${hours}h ${remainMinutes}m`
}

function formatTokens(usage: TurnUsage, labels: ExportLabels): string {
  const parts: string[] = []
  parts.push(`${labels.inputTokens}: ${usage.input_tokens.toLocaleString()}`)
  parts.push(`${labels.outputTokens}: ${usage.output_tokens.toLocaleString()}`)
  if (usage.cache_read_input_tokens > 0)
    parts.push(
      `${labels.cacheRead}: ${usage.cache_read_input_tokens.toLocaleString()}`
    )
  if (usage.cache_creation_input_tokens > 0)
    parts.push(
      `${labels.cacheWrite}: ${usage.cache_creation_input_tokens.toLocaleString()}`
    )
  return parts.join(" | ")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
])

function sanitizeMimeType(mime: string): string {
  const lower = mime.toLowerCase().trim()
  return ALLOWED_IMAGE_MIMES.has(lower) ? lower : "image/png"
}

function localizeStatus(status: string, labels: ExportLabels): string {
  return labels.statusLabels[status] ?? status
}

function localizeRole(role: string, labels: ExportLabels): string {
  switch (role) {
    case "user":
      return labels.user
    case "assistant":
      return labels.assistant
    case "system":
      return labels.system
    default:
      return role
  }
}

// ---------------------------------------------------------------------------
// Tool call formatting helpers
// ---------------------------------------------------------------------------

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatToolContent(raw: string | null): string {
  if (!raw) return ""
  const trimmed = raw.trim()
  if (!trimmed) return ""

  // Try to parse JSON and format as key-value summary
  try {
    const parsed = JSON.parse(trimmed)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return Object.entries(parsed)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v)
          const display = val.length > 200 ? val.slice(0, 200) + "..." : val
          return `${k}: ${display}`
        })
        .join("\n")
    }
  } catch {
    // Not JSON — use as-is
  }

  if (trimmed.length > 500) return trimmed.slice(0, 500) + "..."
  return trimmed
}

// ---------------------------------------------------------------------------
// Content block formatters
// ---------------------------------------------------------------------------

function blocksToMarkdown(
  blocks: ContentBlock[],
  labels: ExportLabels
): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "thinking":
          if (block.text.trim().length === 0) return ""
          return block.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        case "tool_use": {
          const name = formatToolName(block.tool_name)
          const content = formatToolContent(block.input_preview)
          if (!content) return `> **${name}**`
          return `> **${name}**\n>\n${content
            .split("\n")
            .map((line) => `> \`${line}\``)
            .join("\n")}`
        }
        case "tool_result": {
          const content = formatToolContent(block.output_preview)
          const label = block.is_error ? labels.toolError : labels.toolResult
          if (!content) return `> *${label}*`
          return `> *${label}:*\n>\n${content
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`
        }
        case "image":
          return `![image](data:${sanitizeMimeType(block.mime_type)};base64,${block.data})`
        case "image_generation": {
          const lines: string[] = []
          if (block.revised_prompt && block.revised_prompt.trim().length > 0) {
            lines.push(`> _Revised prompt:_ ${block.revised_prompt.trim()}`)
          }
          if (block.image) {
            lines.push(
              `![image](data:${sanitizeMimeType(block.image.mime_type)};base64,${block.image.data})`
            )
          }
          return lines.join("\n\n")
        }
        case "turn_error":
          return `> **${labels.turnFailed}**\n>\n${block.message
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`
        default:
          return ""
      }
    })
    .filter(Boolean)
    .join("\n\n")
}

function blocksToHtml(blocks: ContentBlock[], labels: ExportLabels): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return `<div class="text-block">${escapeHtml(block.text).replace(/\n/g, "<br>")}</div>`
        case "thinking":
          if (block.text.trim().length === 0) return ""
          return `<blockquote class="thinking">${escapeHtml(block.text).replace(/\n/g, "<br>")}</blockquote>`
        case "tool_use": {
          const name = formatToolName(block.tool_name)
          const content = formatToolContent(block.input_preview)
          return `<details class="tool-use"><summary class="tool-summary">${escapeHtml(name)}</summary>${content ? `<div class="tool-content">${escapeHtml(content).replace(/\n/g, "<br>")}</div>` : ""}</details>`
        }
        case "tool_result": {
          const content = formatToolContent(block.output_preview)
          const label = block.is_error ? labels.toolError : labels.toolResult
          return `<details class="tool-result ${block.is_error ? "error" : ""}"><summary class="tool-summary">${escapeHtml(label)}</summary>${content ? `<div class="tool-content">${escapeHtml(content).replace(/\n/g, "<br>")}</div>` : ""}</details>`
        }
        case "image":
          return `<div class="image-block"><img src="data:${sanitizeMimeType(block.mime_type)};base64,${escapeHtml(block.data)}" alt="image" style="max-width:100%;border-radius:8px;" /></div>`
        case "image_generation": {
          const parts: string[] = ['<div class="image-generation-block">']
          if (block.revised_prompt && block.revised_prompt.trim().length > 0) {
            parts.push(
              `<blockquote class="image-generation-prompt"><em>Revised prompt:</em> ${escapeHtml(block.revised_prompt.trim()).replace(/\n/g, "<br>")}</blockquote>`
            )
          }
          if (block.image) {
            parts.push(
              `<img src="data:${sanitizeMimeType(block.image.mime_type)};base64,${escapeHtml(block.image.data)}" alt="image" style="max-width:100%;border-radius:8px;" />`
            )
          }
          parts.push("</div>")
          return parts.join("")
        }
        case "turn_error":
          return `<div class="turn-error"><strong>${escapeHtml(labels.turnFailed)}</strong><br>${escapeHtml(block.message).replace(/\n/g, "<br>")}</div>`
        default:
          return ""
      }
    })
    .filter(Boolean)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Metadata formatters
// ---------------------------------------------------------------------------

function metadataMarkdown(
  summary: DbConversationSummary,
  labels: ExportLabels,
  stats?: SessionStats | null
): string {
  const lines: string[] = []
  lines.push(`# ${summary.title ?? labels.untitledConversation}`)
  lines.push("")
  lines.push(`| | |`)
  lines.push(`|---|---|`)
  lines.push(
    `| **${labels.agent}** | ${getAgentLabel(summary.agent_type) ?? summary.agent_type} |`
  )
  if (summary.model) lines.push(`| **${labels.model}** | ${summary.model} |`)
  lines.push(
    `| **${labels.status}** | ${localizeStatus(summary.status, labels)} |`
  )
  lines.push(
    `| **${labels.started}** | ${formatTimestamp(summary.created_at)} |`
  )
  if (summary.updated_at)
    lines.push(
      `| **${labels.updated}** | ${formatTimestamp(summary.updated_at)} |`
    )
  if (stats?.total_usage)
    lines.push(
      `| **${labels.tokens}** | ${formatTokens(stats.total_usage, labels)} |`
    )
  if (stats?.total_duration_ms)
    lines.push(
      `| **${labels.duration}** | ${formatDuration(stats.total_duration_ms)} |`
    )
  return lines.join("\n")
}

function metadataHtml(
  summary: DbConversationSummary,
  labels: ExportLabels,
  stats?: SessionStats | null
): string {
  const rows: string[] = []
  rows.push(
    `<tr><td>${escapeHtml(labels.agent)}</td><td>${escapeHtml(getAgentLabel(summary.agent_type) ?? summary.agent_type)}</td></tr>`
  )
  if (summary.model)
    rows.push(
      `<tr><td>${escapeHtml(labels.model)}</td><td>${escapeHtml(summary.model)}</td></tr>`
    )
  rows.push(
    `<tr><td>${escapeHtml(labels.status)}</td><td>${escapeHtml(localizeStatus(summary.status, labels))}</td></tr>`
  )
  rows.push(
    `<tr><td>${escapeHtml(labels.started)}</td><td>${escapeHtml(formatTimestamp(summary.created_at))}</td></tr>`
  )
  if (summary.updated_at)
    rows.push(
      `<tr><td>${escapeHtml(labels.updated)}</td><td>${escapeHtml(formatTimestamp(summary.updated_at))}</td></tr>`
    )
  if (stats?.total_usage)
    rows.push(
      `<tr><td>${escapeHtml(labels.tokens)}</td><td>${escapeHtml(formatTokens(stats.total_usage, labels))}</td></tr>`
    )
  if (stats?.total_duration_ms)
    rows.push(
      `<tr><td>${escapeHtml(labels.duration)}</td><td>${escapeHtml(formatDuration(stats.total_duration_ms))}</td></tr>`
    )

  return `<header>
<h1>${escapeHtml(summary.title ?? labels.untitledConversation)}</h1>
<table class="meta">${rows.join("")}</table>
</header>`
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const HTML_STYLES = `
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f9fafb;color:#111827;line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:24px}
header{margin-bottom:24px}
h1{font-size:1.5rem;margin:0 0 16px}
.meta{width:100%;border-collapse:collapse;margin-bottom:0;background:#f3f4f6;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb}
.meta td{padding:6px 12px;font-size:0.875rem}
.meta td:first-child{font-weight:600;white-space:nowrap;width:100px}
.message{margin-bottom:16px;padding:12px 16px;border-radius:12px;border:1px solid #e5e7eb;background:#fff}
.message.user{background:#eff6ff;border-color:#bfdbfe}
.message.assistant{background:#fff}
.message.system{background:#fefce8;border-color:#fde68a}
.role{font-weight:700;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;opacity:0.7}
.turn-meta{font-size:0.75rem;color:#6b7280;margin-bottom:8px}
.text-block{white-space:pre-wrap;word-break:break-word}
.thinking{border-left:3px solid #9ca3af;padding:8px 12px;margin:8px 0;color:#6b7280;font-style:italic;background:#f9fafb;border-radius:0 8px 8px 0}
.tool-use,.tool-result{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;margin:8px 0;font-size:0.875rem}
.tool-summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:0.75rem;user-select:none;list-style:none;display:flex;align-items:center;gap:6px}
.tool-summary::before{content:"\\25B6";font-size:0.6rem;transition:transform 0.15s}
details[open]>.tool-summary::before{transform:rotate(90deg)}
.tool-summary::-webkit-details-marker{display:none}
.tool-content{padding:4px 12px 8px;font-size:0.8125rem;color:#4b5563;border-top:1px solid #e5e7eb;line-height:1.5}
.tool-result.error{border-color:#fca5a5;background:#fef2f2}
.tool-result.error .tool-summary{color:#dc2626}
.turn-error{color:#6b7280;font-size:0.8125rem;white-space:pre-wrap;word-break:break-word}
.turn-error strong{color:#dc2626}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:0.8125rem}
.image-block{margin:8px 0}
.footer{margin-top:24px;padding-top:12px;font-size:0.75rem;color:#9ca3af;text-align:center}
`

function buildHtmlDocument(data: ExportConversationData): string {
  const { summary, turns, sessionStats, labels } = data
  const header = metadataHtml(summary, labels, sessionStats)
  const messages = turns
    .map((turn) => {
      const turnMeta: string[] = []
      turnMeta.push(formatTimestamp(turn.timestamp))
      if (turn.model) turnMeta.push(turn.model)
      if (turn.usage) turnMeta.push(formatTokens(turn.usage, labels))
      if (turn.duration_ms) turnMeta.push(formatDuration(turn.duration_ms))

      return `<div class="message ${turn.role}">
<div class="role">${escapeHtml(localizeRole(turn.role, labels))}</div>
<div class="turn-meta">${escapeHtml(turnMeta.join(" · "))}</div>
${blocksToHtml(turn.blocks, labels)}
</div>`
    })
    .join("\n")

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(summary.title ?? labels.untitledConversation)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<div class="container">
${header}
<main>${messages}</main>
<div class="footer">Codeg</div>
</div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Public export functions
// ---------------------------------------------------------------------------

export async function exportAsMarkdown(
  data: ExportConversationData
): Promise<ExportResult> {
  const { summary, turns, sessionStats, labels } = data
  const parts: string[] = []

  parts.push(metadataMarkdown(summary, labels, sessionStats))
  parts.push("\n\n---\n")

  for (const turn of turns) {
    parts.push(`## ${localizeRole(turn.role, labels)}`)
    const meta: string[] = []
    meta.push(formatTimestamp(turn.timestamp))
    if (turn.model) meta.push(`${labels.model}: ${turn.model}`)
    if (turn.usage) meta.push(formatTokens(turn.usage, labels))
    if (turn.duration_ms) meta.push(formatDuration(turn.duration_ms))
    if (meta.length > 0) parts.push(`*${meta.join(" · ")}*`)
    parts.push("")
    parts.push(blocksToMarkdown(turn.blocks, labels))
    parts.push("")
  }

  parts.push("---")
  parts.push("*Codeg*")

  return saveTextFile({
    content: parts.join("\n"),
    suggestedName: makeExportFilename(summary.title, "md"),
    mimeType: "text/markdown",
    filterName: "Markdown",
    ext: "md",
  })
}

export async function exportAsHtml(
  data: ExportConversationData
): Promise<ExportResult> {
  return saveTextFile({
    content: buildHtmlDocument(data),
    suggestedName: makeExportFilename(data.summary.title, "html"),
    mimeType: "text/html",
    filterName: "HTML",
    ext: "html",
  })
}

// Safari caps at 16384, Chrome at ~32767. Use a safe limit.
const MAX_IMAGE_HEIGHT = 16000

export class ExportTooLongError extends Error {
  constructor() {
    super("Content too long for image export")
    this.name = "ExportTooLongError"
  }
}

export async function exportAsImage(
  data: ExportConversationData
): Promise<ExportResult> {
  const html = buildHtmlDocument(data)

  const iframe = document.createElement("iframe")
  iframe.style.cssText =
    "position:fixed;left:0;top:0;width:800px;height:0;border:none;opacity:0;pointer-events:none;z-index:-1;"
  document.body.appendChild(iframe)

  let dataUrl: string
  try {
    iframe.srcdoc = html
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve()
    })

    const iframeDoc = iframe.contentDocument
    if (!iframeDoc) throw new Error("Cannot access iframe document")

    const body = iframeDoc.body
    const contentHeight = Math.min(body.scrollHeight, MAX_IMAGE_HEIGHT)
    iframe.style.height = `${contentHeight}px`

    await new Promise<void>((resolve) => {
      if (iframe.contentWindow) {
        iframe.contentWindow.requestAnimationFrame(() => resolve())
      } else {
        setTimeout(resolve, 50)
      }
    })

    const target = iframeDoc.querySelector(".container") ?? body
    try {
      dataUrl = await toPng(target as HTMLElement, {
        width: 800,
        pixelRatio: 2,
        backgroundColor: "#f9fafb",
      })
    } catch {
      throw new ExportTooLongError()
    }
  } finally {
    iframe.remove()
  }

  // `dataUrl` is a `data:image/png;base64,...` URI. `downloadImage` handles
  // desktop (Save As dialog + `save_binary_file` invoke — surfaces real
  // write failures) vs web (Blob link) and returns `false` when the user
  // cancelled the dialog.
  const commaIdx = dataUrl.indexOf(",")
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  const saved = await downloadImage({
    data: base64,
    mime_type: "image/png",
    suggestedName: makeExportFilename(data.summary.title, "png"),
  })
  return saved ? "saved" : "cancelled"
}
