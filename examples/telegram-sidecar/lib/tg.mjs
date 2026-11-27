// SPDX-License-Identifier: Apache-2.0
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import crypto from "node:crypto"
import { redactText, redactError, registerSecret } from "./redact.mjs"

export class TelegramApiError extends Error {
  constructor(
    method,
    statusCode,
    description,
    errorCode = null,
    parameters = null
  ) {
    super(
      redactText(
        `Telegram ${method} failed (${errorCode ?? statusCode}): ${description}`
      )
    )
    this.name = "TelegramApiError"
    this.method = method
    this.statusCode = statusCode
    this.errorCode = errorCode ?? statusCode
    this.description = redactText(description)
    this.parameters = parameters || {}
  }
}

export function isNotModifiedError(err) {
  return (
    err instanceof TelegramApiError &&
    /message is not modified/i.test(err.description || "")
  )
}

export function isConflictError(err) {
  return (
    err instanceof TelegramApiError &&
    (err.errorCode === 409 || err.statusCode === 409)
  )
}

export function isTopicDisabledError(err) {
  return (
    err instanceof TelegramApiError &&
    err.errorCode === 400 &&
    /topic|forum|supergroup|thread|not enabled|rights/i.test(
      err.description || ""
    )
  )
}

export function isEntityParseError(err) {
  return (
    err instanceof TelegramApiError &&
    err.errorCode === 400 &&
    /can't parse entities|parse entities/i.test(err.description || "")
  )
}

export function isThreadNotFoundError(err) {
  return (
    err instanceof TelegramApiError &&
    err.errorCode === 400 &&
    /message thread not found|thread not found/i.test(err.description || "")
  )
}

function stripHtmlFallback(html) {
  return String(html || "")
    .replace(/<\/?(b|strong|i|em|code|pre|u|s|a|blockquote)[^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
}

function isLocalHostname(hostname) {
  const h = (hostname || "").toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]"
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * HTTPS Agent that tunnels connections over an HTTP CONNECT proxy.
 * Used exclusively for Telegram API requests so localhost Codeg traffic never touches the proxy.
 */
class HttpConnectHttpsAgent extends https.Agent {
  constructor(proxyUrl, connectTimeoutMs = 10000) {
    super({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 12,
      maxFreeSockets: 6,
    })
    this.proxy = new URL(proxyUrl)
    this.connectTimeoutMs = connectTimeoutMs
  }

  createConnection(options, callback) {
    const targetHost = options.host || options.hostname || options.servername
    const targetPort = Number(options.port || 443)
    const proxyPort = Number(
      this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80)
    )

    const headers = {
      Host: `${targetHost}:${targetPort}`,
    }
    if (this.proxy.username || this.proxy.password) {
      const creds = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
      headers["Proxy-Authorization"] =
        `Basic ${Buffer.from(creds).toString("base64")}`
    }

    let settled = false
    const done = (err, socket) => {
      if (settled) return
      settled = true
      callback(err, socket)
    }

    const req = http.request({
      host: this.proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: this.connectTimeoutMs,
    })

    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Proxy CONNECT timeout to ${this.proxy.hostname}:${proxyPort}`
        )
      )
    })
    req.on("error", (err) => done(redactError(err)))

    req.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        done(
          new Error(
            `Proxy CONNECT ${targetHost}:${targetPort} returned HTTP ${res.statusCode}`
          )
        )
        return
      }
      if (head && head.length > 0) {
        socket.unshift(head)
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
      })
      tlsSocket.once("error", (err) => done(redactError(err)))
      done(null, tlsSocket)
    })

    req.end()
  }
}

export class TelegramClient {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} [opts.apiBase]
   * @param {string} [opts.proxyUrl]
   * @param {object} [opts.logger]
   */
  constructor({
    token,
    apiBase = "https://api.telegram.org",
    proxyUrl = "",
    logger = console,
  } = {}) {
    if (!token) throw new Error("TelegramClient requires a bot token")
    this.token = token
    // The token is embedded in every request path; register it so any error text
    // that still echoes it is masked by the shared redaction boundary.
    registerSecret(token)
    this.apiBase = apiBase.replace(/\/+$/, "")
    this.proxyUrl = (proxyUrl || "").trim()
    if (this.proxyUrl) {
      try {
        const proxy = new URL(this.proxyUrl)
        const user = decodeURIComponent(proxy.username || "")
        const pass = decodeURIComponent(proxy.password || "")
        registerSecret(pass)
        registerSecret(user)
        if (pass)
          registerSecret(Buffer.from(`${user}:${pass}`).toString("base64"))
      } catch {
        // An unparsable proxy URL fails later with a redacted message.
      }
    }
    this.logger = logger
    this.proxyAgent = this.proxyUrl
      ? new HttpConnectHttpsAgent(this.proxyUrl)
      : null
  }

  _requestRaw(
    urlString,
    { method = "GET", headers = {}, body = null, timeoutMs = 30000 } = {}
  ) {
    const urlObj = new URL(urlString)
    const isHttps = urlObj.protocol === "https:"
    const transport = isHttps ? https : http
    const useProxy =
      isHttps && this.proxyAgent && !isLocalHostname(urlObj.hostname)
    // Redacted once, up front: the path carries the bot token.
    const safePath = redactText(urlObj.pathname)

    return new Promise((resolve, reject) => {
      const reqOpts = {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method,
        headers,
        timeout: timeoutMs,
        agent: useProxy ? this.proxyAgent : false,
      }

      const req = transport.request(reqOpts, (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      })

      req.on("timeout", () => {
        req.destroy(
          new Error(
            redactText(
              `Telegram HTTP timeout (${timeoutMs}ms) on ${method} ${safePath}`
            )
          )
        )
      })
      req.on("error", (err) => reject(redactError(err)))

      if (body !== null && body !== undefined) {
        req.write(body)
      }
      req.end()
    })
  }

  async call(
    method,
    params = {},
    { timeoutMs = 35000, retryOn429 = true } = {}
  ) {
    const url = `${this.apiBase}/bot${this.token}/${method}`
    const cleanParams = {}
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) cleanParams[k] = v
    }
    const payload = JSON.stringify(cleanParams)

    const res = await this._requestRaw(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      body: payload,
      timeoutMs,
    })

    let parsed
    const text = res.body.toString("utf8")
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new TelegramApiError(
        method,
        res.statusCode,
        `Invalid JSON response: ${text.slice(0, 200)}`
      )
    }

    if (!parsed.ok) {
      const errCode = parsed.error_code ?? res.statusCode
      const err = new TelegramApiError(
        method,
        res.statusCode,
        parsed.description || "Unknown Telegram API error",
        errCode,
        parsed.parameters
      )
      if (errCode === 429 && retryOn429) {
        const retryAfter = Math.min(
          30,
          Math.max(1, Number(parsed.parameters?.retry_after || 2))
        )
        this.logger.warn?.(
          `[tg] 429 rate limited on ${method}, retrying in ${retryAfter}s`
        )
        await sleep(retryAfter * 1000)
        return this.call(method, params, { timeoutMs, retryOn429: false })
      }
      throw err
    }

    return parsed.result
  }

  async callMultipart(
    method,
    fields = {},
    fileField = null,
    { timeoutMs = 45000 } = {}
  ) {
    const boundary = `----codegTgBot${crypto.randomBytes(12).toString("hex")}`
    const parts = []

    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue
      const serialized =
        typeof value === "object" ? JSON.stringify(value) : String(value)
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${serialized}\r\n`,
          "utf8"
        )
      )
    }

    if (fileField) {
      const {
        fieldName = "document",
        filename = "file.txt",
        contentType = "text/plain; charset=utf-8",
        data,
      } = fileField
      const fileBuf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(String(data), "utf8")
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
          "utf8"
        ),
        fileBuf,
        Buffer.from("\r\n", "utf8")
      )
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"))
    const body = Buffer.concat(parts)
    const url = `${this.apiBase}/bot${this.token}/${method}`

    const res = await this._requestRaw(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      body,
      timeoutMs,
    })

    const text = res.body.toString("utf8")
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new TelegramApiError(
        method,
        res.statusCode,
        `Invalid JSON response: ${text.slice(0, 200)}`
      )
    }
    if (!parsed.ok) {
      throw new TelegramApiError(
        method,
        res.statusCode,
        parsed.description || "Unknown Telegram API error",
        parsed.error_code ?? res.statusCode,
        parsed.parameters
      )
    }
    return parsed.result
  }

  getMe() {
    return this.call("getMe", {})
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands })
  }

  getUpdates({
    offset,
    timeout = 25,
    allowed_updates = ["message", "callback_query"],
  } = {}) {
    return this.call(
      "getUpdates",
      { offset, timeout, allowed_updates },
      { timeoutMs: (timeout + 15) * 1000, retryOn429: true }
    )
  }

  getFile(fileId) {
    return this.call("getFile", { file_id: fileId })
  }

  async downloadFile(filePath, { timeoutMs = 45000 } = {}) {
    const cleanPath = String(filePath).replace(/^\/+/, "")
    const url = `${this.apiBase}/file/bot${this.token}/${cleanPath}`
    const res = await this._requestRaw(url, { method: "GET", timeoutMs })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(
        redactText(
          `Failed downloading Telegram file (${res.statusCode}): ${cleanPath}`
        )
      )
    }
    return res.body
  }

  async sendMessage(
    chatId,
    text,
    {
      threadId,
      parseMode = "HTML",
      replyMarkup,
      replyToMessageId,
      disableNotification,
    } = {}
  ) {
    const params = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
      reply_to_message_id: replyToMessageId,
      disable_notification: disableNotification,
      link_preview_options: { is_disabled: true },
    }
    if (Number.isInteger(threadId) && threadId > 0) {
      params.message_thread_id = threadId
    }

    try {
      return await this.call("sendMessage", params)
    } catch (err) {
      if (parseMode && isEntityParseError(err)) {
        const fallback = { ...params, text: stripHtmlFallback(text) }
        delete fallback.parse_mode
        return this.call("sendMessage", fallback)
      }
      throw err
    }
  }

  async editMessageText(
    chatId,
    messageId,
    text,
    { parseMode = "HTML", replyMarkup } = {}
  ) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
      link_preview_options: { is_disabled: true },
    }
    try {
      return await this.call("editMessageText", params)
    } catch (err) {
      if (isNotModifiedError(err)) return null
      if (parseMode && isEntityParseError(err)) {
        const fallback = { ...params, text: stripHtmlFallback(text) }
        delete fallback.parse_mode
        try {
          return await this.call("editMessageText", fallback)
        } catch (err2) {
          if (isNotModifiedError(err2)) return null
          throw err2
        }
      }
      throw err
    }
  }

  async editMessageReplyMarkup(
    chatId,
    messageId,
    replyMarkup = { inline_keyboard: [] }
  ) {
    try {
      return await this.call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      })
    } catch (err) {
      if (isNotModifiedError(err)) return null
      throw err
    }
  }

  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    })
  }

  sendChatAction(chatId, action = "typing", { threadId } = {}) {
    const params = { chat_id: chatId, action }
    if (Number.isInteger(threadId) && threadId > 0) {
      params.message_thread_id = threadId
    }
    return this.call("sendChatAction", params).catch(() => null)
  }

  answerCallbackQuery(callbackQueryId, { text, showAlert } = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    }).catch(() => null)
  }

  sendDocument(
    chatId,
    filename,
    data,
    { threadId, caption, parseMode = "HTML" } = {}
  ) {
    const fields = {
      chat_id: chatId,
      caption,
      parse_mode: caption ? parseMode : undefined,
    }
    if (Number.isInteger(threadId) && threadId > 0) {
      fields.message_thread_id = threadId
    }
    return this.callMultipart("sendDocument", fields, {
      fieldName: "document",
      filename,
      contentType: "text/plain; charset=utf-8",
      data,
    })
  }

  createForumTopic(chatId, name) {
    const safeName = String(name || "Codeg Session").slice(0, 128)
    return this.call("createForumTopic", { chat_id: chatId, name: safeName })
  }

  editForumTopic(chatId, threadId, { name } = {}) {
    const safeName = name ? String(name).slice(0, 128) : undefined
    return this.call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
      name: safeName,
    })
  }

  closeForumTopic(chatId, threadId) {
    return this.call("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    })
  }

  reopenForumTopic(chatId, threadId) {
    return this.call("reopenForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    })
  }

  deleteForumTopic(chatId, threadId) {
    return this.call("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    })
  }

  setChatMenuButton({ chatId, menuButton } = {}) {
    return this.call("setChatMenuButton", {
      chat_id: chatId,
      menu_button: menuButton,
    })
  }
}
