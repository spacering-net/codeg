// SPDX-License-Identifier: Apache-2.0
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;")
}

export function truncateText(str, maxChars = 200) {
  const s = String(str ?? "")
  if (s.length <= maxChars) return s
  if (maxChars <= 1) return s.slice(0, maxChars)
  return `${s.slice(0, maxChars - 1)}…`
}

export function tailText(str, maxChars = 2600) {
  const s = String(str ?? "")
  if (s.length <= maxChars) return s
  return `…\n${s.slice(s.length - maxChars)}`
}

export function formatRelativeTime(isoStr) {
  if (!isoStr) return ""
  const ts = Date.parse(isoStr)
  if (Number.isNaN(ts)) return ""
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return "刚刚"
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * Lightweight, safe Markdown-to-Telegram-HTML converter.
 * Guarantees balanced HTML tags by extracting fenced code blocks and inline code first.
 */
export function mdToTelegramHtml(md) {
  const src = String(md ?? "").replace(/\r\n/g, "\n")
  const tokens = []
  const stash = (html) => {
    const key = `\u0000TGTOK${tokens.length}\u0000`
    tokens.push(html)
    return key
  }

  // 1. Fenced code blocks ```lang\n...\n```
  let work = src.replace(
    /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const cleanCode = escapeHtml(code.replace(/\n$/, ""))
      if (lang) {
        return stash(
          `<pre><code class="language-${escapeAttr(lang)}">${cleanCode}</code></pre>`
        )
      }
      return stash(`<pre><code>${cleanCode}</code></pre>`)
    }
  )

  // 2. Inline code `...`
  work = work.replace(/`([^`\n]+)`/g, (_, code) =>
    stash(`<code>${escapeHtml(code)}</code>`)
  )

  // 3. Markdown links [label](https://...)
  work = work.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) =>
      stash(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`)
  )

  // 4. Escape remaining text
  work = escapeHtml(work)

  // 5. Horizontal rules -> blank spacing
  work = work.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")

  // 6. Headings -> bold lines
  work = work.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")

  // 7. Lists (- / *) -> clean dot bullets
  work = work.replace(/^([ \t]*)[-*]\s+(.+)$/gm, "$1• $2")

  // 8. Bold, italic, strikethrough
  work = work.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  work = work.replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,!?]|$)/gm, "$1<b>$2</b>")
  work = work.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>")
  work = work.replace(
    /(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[^\w*]|$)/g,
    "$1<i>$2</i>"
  )

  // 9. Consecutive blockquote lines (> ...) -> Telegram <blockquote>
  const lines = work.split("\n")
  const outLines = []
  let quoteBuf = []
  const flushQuote = () => {
    if (quoteBuf.length === 0) return
    outLines.push(`<blockquote>${quoteBuf.join("\n")}</blockquote>`)
    quoteBuf = []
  }
  for (const line of lines) {
    const m = line.match(/^&gt;\s?(.*)$/)
    if (m) {
      quoteBuf.push(m[1])
    } else {
      flushQuote()
      outLines.push(line)
    }
  }
  flushQuote()
  work = outLines.join("\n").replace(/\n{3,}/g, "\n\n")

  // 10. Restore stashed HTML tokens
  work = work.replace(
    /\u0000TGTOK(\d+)\u0000/g,
    (_, idx) => tokens[Number(idx)] ?? ""
  )

  return work.trim()
}

/**
 * Split raw Markdown into chunks whose converted Telegram HTML stays <= maxChars,
 * keeping fenced code blocks balanced across splits.
 */
export function splitMarkdownForTelegram(md, maxChars = 3800) {
  const raw = String(md ?? "").replace(/\r\n/g, "\n")
  if (!raw.trim()) return ["(空回复)"]
  if (mdToTelegramHtml(raw).length <= maxChars) {
    return [raw]
  }

  const lines = raw.split("\n")
  const chunks = []
  let buf = []
  let openFenceLang = null // null when outside fence, string (possibly '') when inside fence

  const flush = () => {
    if (buf.length === 0) return
    let body = buf.join("\n")
    if (openFenceLang !== null) {
      body += "\n```"
    }
    if (body.trim()) chunks.push(body)
    buf = openFenceLang !== null ? [`\`\`\`${openFenceLang}`] : []
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/)
    const candidate = [...buf, line]
    let candidateText = candidate.join("\n")
    if (openFenceLang !== null && !fenceMatch) {
      candidateText += "\n```"
    }

    if (buf.length > 0 && mdToTelegramHtml(candidateText).length > maxChars) {
      flush()
    }

    // Single oversized line guard
    if (
      buf.length === 0 &&
      mdToTelegramHtml(line + (openFenceLang !== null ? "\n```" : "")).length >
        maxChars
    ) {
      const step = Math.max(400, Math.floor(maxChars * 0.65))
      for (let i = 0; i < line.length; i += step) {
        const piece = line.slice(i, i + step)
        if (openFenceLang !== null) {
          chunks.push(`\`\`\`${openFenceLang}\n${piece}\n\`\`\``)
        } else {
          chunks.push(piece)
        }
      }
    } else {
      buf.push(line)
    }

    if (fenceMatch) {
      if (openFenceLang === null) {
        openFenceLang = fenceMatch[1] || ""
      } else {
        openFenceLang = null
      }
    }
  }

  flush()
  return chunks.length > 0 ? chunks : ["(空回复)"]
}

export function formatAgentBadge(agentType) {
  const map = {
    claude_code: "Claude",
    codex: "Codex",
    open_code: "OpenCode",
    gemini: "Gemini",
    grok: "Grok",
    cursor: "Cursor",
    deepseek: "DeepSeek",
    zcode: "ZCode",
    trae: "TRAE",
    kimi_code: "Kimi",
    qoder: "Qoder",
    kiro: "Kiro",
    cline: "Cline",
    code_buddy: "CodeBuddy",
    pi: "Pi",
    hermes: "Hermes",
    antigravity: "Antigravity",
  }
  if (map[agentType]) return map[agentType]
  if (String(agentType || "").startsWith("custom:")) {
    return String(agentType).slice("custom:".length)
  }
  return String(agentType || "Agent")
}

function optionIcon(kind) {
  switch (kind) {
    case "allow_once":
      return "✓"
    case "allow_always":
      return "🔓"
    case "reject_once":
    case "reject_always":
      return "✕"
    default:
      return "•"
  }
}

function parseJsonSafe(val) {
  if (!val) return null
  if (typeof val === "object") return val
  if (typeof val === "string") {
    try {
      return JSON.parse(val)
    } catch {
      return null
    }
  }
  return null
}

function extractToolDetails(toolCall) {
  const tc = toolCall && typeof toolCall === "object" ? toolCall : {}
  const title = tc.title || tc.name || tc.kind || "工具调用"
  const kind = tc.kind || ""
  const rawInputObj = parseJsonSafe(tc.rawInput ?? tc.raw_input)
  const rawInputStr =
    typeof (tc.rawInput ?? tc.raw_input) === "string"
      ? (tc.rawInput ?? tc.raw_input)
      : rawInputObj
        ? JSON.stringify(rawInputObj, null, 2)
        : ""

  const command =
    rawInputObj?.command ||
    rawInputObj?.cmd ||
    rawInputObj?.CommandLine ||
    rawInputObj?.script ||
    null

  const locations = Array.isArray(tc.locations)
    ? tc.locations
        .map((loc) => (typeof loc === "string" ? loc : loc?.path || loc?.uri))
        .filter(Boolean)
    : []
  const filePath =
    rawInputObj?.file_path ||
    rawInputObj?.path ||
    rawInputObj?.TargetFile ||
    rawInputObj?.AbsolutePath ||
    (locations.length > 0 ? locations.join(", ") : null)

  let contentPreview = ""
  if (typeof tc.content === "string") {
    contentPreview = tc.content
  } else if (Array.isArray(tc.content)) {
    contentPreview = tc.content
      .map((item) => {
        if (typeof item === "string") return item
        if (item?.type === "diff") {
          const p = item.path || ""
          const next = String(item.newText || "")
          return `${p ? `${p}\n` : ""}${next.slice(0, 600)}`
        }
        return item?.content?.text || item?.text || ""
      })
      .filter(Boolean)
      .join("\n")
  }

  return { title, kind, command, filePath, rawInputStr, contentPreview }
}

/**
 * Format a Codeg PermissionRequest event into Telegram HTML + InlineKeyboard.
 */
export function formatPermissionCard({
  toolCall,
  options = [],
  queued = 0,
  sessionLabel = "",
  showSession = false,
  shortId,
}) {
  const { title, command, filePath, rawInputStr, contentPreview } =
    extractToolDetails(toolCall)

  const metaParts = []
  if (showSession && sessionLabel) metaParts.push(escapeHtml(sessionLabel))
  if (queued > 0) metaParts.push(`还有 ${queued} 个待批`)
  const metaSuffix =
    metaParts.length > 0 ? `  <i>(${metaParts.join(" · ")})</i>` : ""

  const lines = [
    `<b>权限确认</b> · <code>${escapeHtml(truncateText(title, 60))}</code>${metaSuffix}`,
  ]

  if (filePath && !command) {
    lines.push(`<code>${escapeHtml(truncateText(filePath, 220))}</code>`)
  }
  if (command) {
    lines.push(
      `<pre><code>${escapeHtml(truncateText(command, 900))}</code></pre>`
    )
  } else if (contentPreview) {
    lines.push(
      `<pre><code>${escapeHtml(truncateText(contentPreview, 900))}</code></pre>`
    )
  } else if (rawInputStr && rawInputStr !== "{}") {
    lines.push(
      `<pre><code>${escapeHtml(truncateText(rawInputStr, 700))}</code></pre>`
    )
  }

  const keyboard = []
  let row = []
  options.forEach((opt, idx) => {
    const btnText = `${optionIcon(opt.kind)} ${truncateText(opt.name || opt.option_id, 24)}`
    row.push({ text: btnText, callback_data: `perm:${shortId}:${idx}` })
    if (row.length === 2) {
      keyboard.push(row)
      row = []
    }
  })
  if (row.length > 0) keyboard.push(row)

  return {
    html: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  }
}

/**
 * Format an ask_user_question QuestionRequest card.
 */
export function formatQuestionCard({
  questions = [],
  currentIdx = 0,
  selectedMap = {},
  sessionLabel = "",
  showSession = false,
  shortId,
}) {
  const q = questions[currentIdx] || questions[0]
  if (!q) {
    return {
      html: "<b>提问</b>\n<i>(无内容)</i>",
      replyMarkup: { inline_keyboard: [] },
    }
  }

  const total = questions.length
  const chosen = Array.isArray(selectedMap[q.id]) ? selectedMap[q.id] : []
  const tagParts = []
  if (total > 1) tagParts.push(`${currentIdx + 1}/${total}`)
  if (q.header) tagParts.push(escapeHtml(q.header))
  if (showSession && sessionLabel) tagParts.push(escapeHtml(sessionLabel))
  const tagSuffix =
    tagParts.length > 0 ? `  <i>(${tagParts.join(" · ")})</i>` : ""

  const lines = [`<b>需要确认</b>${tagSuffix}`, escapeHtml(q.question)]

  const opts = Array.isArray(q.options) ? q.options : []
  const hasDescriptions = opts.some((opt) => Boolean(opt.description))
  if (opts.length > 0 && (hasDescriptions || q.multi_select)) {
    const optLines = opts.map((opt) => {
      const mark = q.multi_select
        ? chosen.includes(opt.label)
          ? "✓ "
          : "· "
        : "• "
      const desc = opt.description
        ? ` — ${escapeHtml(truncateText(opt.description, 100))}`
        : ""
      return `${mark}<b>${escapeHtml(opt.label)}</b>${desc}`
    })
    lines.push(`<blockquote>${optLines.join("\n")}</blockquote>`)
  }

  if (opts.length === 0) {
    lines.push("<i>直接回复此消息输入答案</i>")
  } else if (q.allow_other !== false) {
    lines.push("<i>也可回复此消息自定义</i>")
  }

  const keyboard = []
  opts.forEach((opt, idx) => {
    const prefix = q.multi_select
      ? chosen.includes(opt.label)
        ? "✓ "
        : ""
      : ""
    keyboard.push([
      {
        text: `${prefix}${truncateText(opt.label, 38)}`,
        callback_data: `qopt:${shortId}:${currentIdx}:${idx}`,
      },
    ])
  })

  const footer = []
  if (q.multi_select && opts.length > 0) {
    footer.push({
      text: currentIdx + 1 < total ? "下一题 →" : "✓ 提交",
      callback_data: `qsub:${shortId}:${currentIdx}`,
    })
  }
  footer.push({
    text: "跳过",
    callback_data: `qskip:${shortId}`,
  })
  keyboard.push(footer)

  return {
    html: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  }
}

/**
 * Format a PlanApprovalRequest card.
 */
export function formatPlanApprovalCard({
  planMarkdown = "",
  sessionLabel = "",
  showSession = false,
  shortId,
}) {
  const suffix =
    showSession && sessionLabel ? `  <i>(${escapeHtml(sessionLabel)})</i>` : ""
  const preview = truncateText(planMarkdown, 2600)
  const rendered = mdToTelegramHtml(preview)

  const lines = [
    `<b>执行计划确认</b>${suffix}`,
    `<blockquote expandable>${rendered}</blockquote>`,
  ]
  if (planMarkdown.length > 2600) {
    lines.push("<i>完整计划见上方 plan.md</i>")
  }

  return {
    html: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✓ 批准执行", callback_data: `plan:${shortId}:approve` },
          { text: "✎ 修改意见", callback_data: `plan:${shortId}:changes` },
          { text: "✕ 放弃", callback_data: `plan:${shortId}:abandon` },
        ],
      ],
    },
  }
}

function toolStatusIcon(status) {
  switch (status) {
    case "completed":
      return "✓"
    case "failed":
      return "✕"
    case "pending":
    case "in_progress":
    default:
      return "⟳"
  }
}

export function formatStreamingMessage({
  agentLabel = "Agent",
  toolCalls = [],
  text = "",
  thinkingChars = 0,
  elapsedSec = 0,
}) {
  const hasText = Boolean(text.trim())
  const parts = []

  if (hasText) {
    parts.push(mdToTelegramHtml(tailText(text, 2600)))
    const activeTools = toolCalls
      .filter((t) => t.status !== "completed")
      .slice(-2)
    if (activeTools.length > 0) {
      const toolLines = activeTools.map(
        (tc) =>
          `${toolStatusIcon(tc.status)} <code>${escapeHtml(truncateText(tc.label || tc.kind || "tool", 55))}</code>`
      )
      parts.push(`<blockquote>${toolLines.join("\n")}</blockquote>`)
    }
    return parts.join("\n\n")
  }

  const label = escapeHtml(agentLabel || "Agent")
  if (toolCalls.length > 0) {
    parts.push(`<i>${label} 执行中 · ${elapsedSec}s</i>`)
    const visible = toolCalls.slice(-4)
    const toolLines = []
    if (toolCalls.length > visible.length) {
      toolLines.push(`<i>…已执行 ${toolCalls.length - visible.length} 步</i>`)
    }
    for (const tc of visible) {
      toolLines.push(
        `${toolStatusIcon(tc.status)} <code>${escapeHtml(truncateText(tc.label || tc.kind || "tool", 58))}</code>`
      )
    }
    parts.push(`<blockquote>${toolLines.join("\n")}</blockquote>`)
    return parts.join("\n")
  }

  if (thinkingChars > 0) {
    return `<i>${label} 思考中 · ${elapsedSec}s</i>`
  }
  return `<i>${label} 处理中 · ${elapsedSec}s</i>`
}

function convButtonPrefix(conv, { isLive, isActive, boundThread }) {
  if (isActive) return "✓ "
  if (isLive || conv.status === "in_progress") return "🟢 "
  if (conv.status === "pending_review") return "🟡 "
  if (boundThread) return "📌 "
  return ""
}

export function formatSessionList({
  conversations = [],
  foldersById = new Map(),
  liveConnByConvId = new Map(),
  threadByConvId = new Map(),
  activeConvId = null,
  page = 0,
  pageSize = 6,
  search = "",
  registerCallback,
}) {
  const total = conversations.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const slice = conversations.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize
  )

  const titlePart = search
    ? `<b>会话</b> · <code>${escapeHtml(search)}</code>`
    : "<b>会话列表</b>"
  const pagePart =
    total > pageSize ? `  <i>${safePage + 1}/${totalPages}</i>` : ""
  const header =
    slice.length === 0
      ? `${titlePart}\n<i>暂无匹配会话</i>`
      : `${titlePart}${pagePart}`

  const keyboard = []
  for (const conv of slice) {
    const folder = foldersById.get(conv.folder_id)
    const folderName = folder?.alias || folder?.name || `#${conv.folder_id}`
    const isLive = liveConnByConvId.has(conv.id)
    const boundThread = threadByConvId.get(conv.id)
    const isActive = activeConvId !== null && conv.id === activeConvId
    const prefix = convButtonPrefix(conv, { isLive, isActive, boundThread })

    const title = conv.title || `会话 #${conv.id}`
    const timeStr = formatRelativeTime(conv.updated_at)
    const tail = timeStr
      ? ` · ${truncateText(folderName, 10)} (${timeStr})`
      : ` · ${truncateText(folderName, 12)}`
    const maxTitleLen = Math.max(12, 34 - tail.length - prefix.length)
    const btnLabel = `${prefix}${truncateText(title, maxTitleLen)}${tail}`

    const sid = registerCallback("open_conv", {
      conversationId: conv.id,
      source: "sessions",
    })
    keyboard.push([{ text: btnLabel, callback_data: `sess:${sid}` }])
  }

  const navRow = []
  if (safePage > 0) {
    const prevId = registerCallback("sess_page", { page: safePage - 1, search })
    navRow.push({ text: "← 上一页", callback_data: `spg:${prevId}` })
  }
  const newId = registerCallback("quick_new", { targetThreadId: 0 })
  navRow.push({ text: "＋ 新建", callback_data: `qact:${newId}` })
  if (safePage + 1 < totalPages) {
    const nextId = registerCallback("sess_page", { page: safePage + 1, search })
    navRow.push({ text: "下一页 →", callback_data: `spg:${nextId}` })
  }
  keyboard.push(navRow)

  return {
    html: header,
    replyMarkup: { inline_keyboard: keyboard },
  }
}
