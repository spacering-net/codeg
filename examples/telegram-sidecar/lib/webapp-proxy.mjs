// SPDX-License-Identifier: Apache-2.0
import http from "node:http"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { EventEmitter } from "node:events"
import { redactText, registerSecret } from "./redact.mjs"

const COOKIE_NAME = "codeg_tg_sess"

const MINIAPP_POLISH_STYLE = `<style id="tg-miniapp-polish">
@media (max-width: 767px) {
  div.h-8.shrink-0.border-t.ws-surface-muted {
    display: none !important;
  }
}
</style>`

/**
 * Verify Telegram Mini App WebApp.initData HMAC-SHA256 signature and user authorization.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(
  initDataRaw,
  botToken,
  {
    allowedUserIds = [],
    maxAgeSec = 300,
    nowSec = Math.floor(Date.now() / 1000),
  } = {}
) {
  if (!initDataRaw || typeof initDataRaw !== "string") {
    return { ok: false, reason: "missing_init_data" }
  }
  if (!botToken) {
    return { ok: false, reason: "missing_bot_token" }
  }

  let params
  try {
    params = new URLSearchParams(initDataRaw)
  } catch {
    return { ok: false, reason: "invalid_query_format" }
  }

  const hash = params.get("hash")
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, reason: "invalid_hash_format" }
  }

  const entries = []
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue
    entries.push([k, v])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n")

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest()
  const computedHex = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")

  const actualBuf = Buffer.from(hash.toLowerCase(), "hex")
  const expectedBuf = Buffer.from(computedHex, "hex")
  if (
    actualBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return { ok: false, reason: "bad_signature" }
  }

  const authDate = Number.parseInt(params.get("auth_date") || "", 10)
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: "missing_auth_date" }
  }
  if (nowSec - authDate > maxAgeSec || authDate - nowSec > 60) {
    return { ok: false, reason: "expired_auth_date" }
  }

  let user = null
  const userRaw = params.get("user")
  if (!userRaw) {
    return { ok: false, reason: "missing_user" }
  }
  try {
    user = JSON.parse(userRaw)
  } catch {
    return { ok: false, reason: "invalid_user_json" }
  }

  const allowed = new Set((allowedUserIds || []).map((id) => Number(id)))
  const uid = Number(user?.id)
  if (!Number.isFinite(uid) || !allowed.has(uid)) {
    return { ok: false, reason: "unauthorized_user" }
  }

  return { ok: true, user, authDate }
}

function parseCookies(cookieHeader) {
  const out = Object.create(null)
  if (!cookieHeader) return out
  const parts = String(cookieHeader).split(";")
  for (const part of parts) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = v
  }
  return out
}

function renderGateHtml(botUsername = "") {
  const safeBot = String(botUsername || "").replace(/[^a-zA-Z0-9_]/g, "")
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<title>Codeg · 安全验证</title>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #111318);
    --fg: var(--tg-theme-text-color, #eef1f7);
    --muted: var(--tg-theme-hint-color, #8e98aa);
    --card: var(--tg-theme-secondary-bg-color, #1b1f29);
    --accent: var(--tg-theme-button-color, #3b82f6);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 20px;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--card);
    border-radius: 16px;
    padding: 24px 20px;
    text-align: center;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .icon { font-size: 32px; margin-bottom: 10px; }
  h1 { font-size: 17px; margin: 0 0 8px; font-weight: 600; }
  p { font-size: 13px; line-height: 1.5; margin: 0; color: var(--muted); }
  .err { color: #f87171; margin-top: 10px; }
  .btn {
    display: inline-block;
    margin-top: 16px;
    padding: 10px 18px;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    border: 0;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" id="icon">🔐</div>
    <h1 id="title">正在验证 Telegram 身份…</h1>
    <p id="msg">正在核验签名并接入本机 Codeg 工作区</p>
    <div id="action"></div>
  </div>
<script>
(async () => {
  const iconEl = document.getElementById('icon');
  const titleEl = document.getElementById('title');
  const msgEl = document.getElementById('msg');
  const actEl = document.getElementById('action');

  const showDenied = (title, msg, showOpenBot) => {
    iconEl.textContent = '🛡️';
    titleEl.textContent = title;
    msgEl.textContent = msg;
    msgEl.className = 'err';
    if (showOpenBot && '${safeBot}') {
      actEl.innerHTML = '<a class="btn" href="https://t.me/${safeBot}">前往 @${safeBot}</a>';
    }
  };

  let initData = '';
  try {
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    initData = hashParams.get('tgWebAppData') || '';
  } catch {}

  if (!initData) {
    await new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://telegram.org/js/telegram-web-app.js';
      sc.onload = resolve;
      sc.onerror = resolve;
      setTimeout(resolve, 2500);
      document.head.appendChild(sc);
    });
    const tg = window.Telegram && window.Telegram.WebApp;
    initData = tg && typeof tg.initData === 'string' ? tg.initData : '';
    try { tg && tg.ready(); tg && tg.expand(); } catch {}
  }

  if (!initData) {
    showDenied(
      '仅限 Telegram Mini App 访问',
      '此入口受 Telegram 签名保护，请从 ${safeBot ? `@${safeBot}` : "Telegram Bot"} 菜单按钮打开。',
      true
    );
    return;
  }

  try {
    const res = await fetch('/__tg_auth__', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showDenied('身份验证失败', data.error || ('HTTP ' + res.status), false);
      return;
    }
    try {
      localStorage.removeItem('codeg_token');
      localStorage.setItem('codeg_proxy_auth', '1');
    } catch {}
    window.location.replace('/workspace');
  } catch (err) {
    showDenied('连接失败', err && err.message ? err.message : '网络异常', false);  }
})();
</script>
</body>
</html>`
}

export class WebAppProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {string} opts.upstreamUrl
   * @param {string} opts.botToken
   * @param {string} [opts.botUsername]
   * @param {() => string} opts.codegTokenProvider
   * @param {number[]} opts.allowedUserIds
   * @param {number} [opts.sessionTtlMs]
   * @param {object} [opts.logger]
   */
  constructor({
    host = "127.0.0.1",
    port = 3081,
    upstreamUrl = "http://127.0.0.1:3080",
    botToken,
    botUsername = "",
    codegTokenProvider,
    allowedUserIds = [],
    sessionTtlMs = 12 * 3600 * 1000,
    logger = console,
  }) {
    super()
    this.host = host
    this.port = port
    this.upstream = new URL(upstreamUrl)
    if (
      this.upstream.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        this.upstream.hostname
      )
    ) {
      throw new Error(
        "Mini App gateway requires an http:// loopback Codeg upstream"
      )
    }
    this.botToken = botToken
    // The bot token is an HMAC key here; keep it out of any log line.
    if (botToken) registerSecret(botToken)
    this.botUsername = botUsername
    this.codegTokenProvider = codegTokenProvider
    this.allowedUserIds = new Set(
      (allowedUserIds || []).map((id) => Number(id))
    )
    this.sessionTtlMs = sessionTtlMs
    this.logger = logger

    this.bootKey = crypto.randomBytes(32)
    this.sessions = new Map()
    this.authFailures = new Map()
    this.activeSockets = new Set()
    this.upstreamAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 24,
      maxFreeSockets: 8,
    })
    this.server = null
    this.boundPort = null
  }

  getSessionCount() {
    const now = Date.now()
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess.expiresAt <= now) this.sessions.delete(sid)
    }
    return this.sessions.size
  }

  revokeAllSessions() {
    const count = this.sessions.size
    this.sessions.clear()
    for (const sock of this.activeSockets) {
      try {
        sock.destroy()
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear()
    return count
  }

  async start() {
    if (this.server) return { host: this.host, port: this.boundPort }

    this.server = http.createServer((req, res) => {
      this._handleHttp(req, res).catch((err) => {
        this.logger.warn?.(`[webapp] http error: ${redactText(err.message)}`)
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
        }
        res.end("Bad Gateway")
      })
    })

    this.server.on("upgrade", (req, socket, head) => {
      this._handleUpgrade(req, socket, head).catch((err) => {
        this.logger.warn?.(
          `[webapp] ws upgrade error: ${redactText(err.message)}`
        )
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      })
    })

    await new Promise((resolve, reject) => {
      const onErr = (err) => reject(err)
      this.server.once("error", onErr)
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener("error", onErr)
        const addr = this.server.address()
        this.boundPort =
          typeof addr === "object" && addr ? addr.port : this.port
        resolve()
      })
    })

    this.logger.info?.(
      `[webapp] auth proxy listening at http://${this.host}:${this.boundPort} -> ${this.upstream.origin}`
    )
    return { host: this.host, port: this.boundPort }
  }

  async stop() {
    this.revokeAllSessions()
    this.upstreamAgent?.destroy()
    if (!this.server) return
    const srv = this.server
    this.server = null
    this.boundPort = null
    srv.closeAllConnections?.()
    await new Promise((resolve) => srv.close(() => resolve()))
  }

  _signSid(sid) {
    return crypto
      .createHmac("sha256", this.bootKey)
      .update(sid)
      .digest("base64url")
  }

  _createSession(user) {
    const sid = crypto.randomBytes(24).toString("base64url")
    const sig = this._signSid(sid)
    const now = Date.now()
    this.sessions.set(sid, {
      userId: Number(user.id),
      username: user.username || "",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    })
    return `${sid}.${sig}`
  }

  _verifySessionCookie(req) {
    const cookies = parseCookies(req.headers.cookie)
    const raw = cookies[COOKIE_NAME]
    if (!raw || !raw.includes(".")) return null
    const dotIdx = raw.indexOf(".")
    const sid = raw.slice(0, dotIdx)
    const sig = raw.slice(dotIdx + 1)
    if (!sid || !sig) return null

    const expectedSig = this._signSid(sid)
    const actualBuf = Buffer.from(sig, "utf8")
    const expectedBuf = Buffer.from(expectedSig, "utf8")
    if (
      actualBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return null
    }

    const sess = this.sessions.get(sid)
    if (!sess) return null
    if (sess.expiresAt <= Date.now() || !this.allowedUserIds.has(sess.userId)) {
      this.sessions.delete(sid)
      return null
    }
    sess.lastSeenAt = Date.now()
    return sess
  }

  _clientIp(req) {
    const cf = req.headers["cf-connecting-ip"]
    if (cf) return String(cf).trim()
    const xff = req.headers["x-forwarded-for"]
    if (xff) return String(xff).split(",")[0].trim()
    return req.socket?.remoteAddress || "unknown"
  }

  _isRateLimited(ip) {
    const now = Date.now()
    const rec = this.authFailures.get(ip)
    if (!rec || rec.resetAt <= now) return false
    return rec.count >= 15
  }

  _recordAuthFailure(ip) {
    const now = Date.now()
    const rec = this.authFailures.get(ip)
    if (!rec || rec.resetAt <= now) {
      this.authFailures.set(ip, { count: 1, resetAt: now + 60000 })
    } else {
      rec.count += 1
    }
  }

  _checkSameOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const originHost = new URL(origin).host
      const expectedHost =
        req.headers["x-forwarded-host"] || req.headers.host || ""
      return originHost === String(expectedHost).split(",")[0].trim()
    } catch {
      return false
    }
  }

  _setBaseSecurityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("X-Robots-Tag", "noindex, nofollow")
    res.setHeader("Referrer-Policy", "no-referrer")
  }

  async _handleHttp(req, res) {
    this._setBaseSecurityHeaders(res)
    const urlObj = new URL(req.url || "/", "http://localhost")
    const pathname = urlObj.pathname

    if (req.method === "GET" && pathname === "/__gate_health__") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end('{"ok":true}')
      return
    }

    if (req.method === "POST" && pathname === "/__tg_auth__") {
      await this._handleAuthPost(req, res)
      return
    }

    const session = this._verifySessionCookie(req)
    if (!session) {
      if (
        req.method === "GET" &&
        (pathname === "/" || pathname === "/workspace" || pathname === "/login")
      ) {
        const html = renderGateHtml(this.botUsername)
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self' 'unsafe-inline' https://telegram.org; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org 'self'",
        })
        res.end(html)
        return
      }

      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }

    if (pathname.startsWith("/api/") && !this._checkSameOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "forbidden_origin" }))
      return
    }

    await this._proxyHttpToUpstream(req, res)
  }

  async _handleAuthPost(req, res) {
    const ip = this._clientIp(req)
    if (this._isRateLimited(ip)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "请求过于频繁，请稍后再试" }))
      return
    }

    const chunks = []
    let totalBytes = 0
    for await (const chunk of req) {
      totalBytes += chunk.length
      if (totalBytes > 16384) {
        res.writeHead(413, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "payload_too_large" }))
        return
      }
      chunks.push(chunk)
    }

    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "invalid_json" }))
      return
    }

    const check = verifyTelegramInitData(body.initData, this.botToken, {
      allowedUserIds: Array.from(this.allowedUserIds),
    })

    if (!check.ok) {
      this._recordAuthFailure(ip)
      this.logger.warn?.(`[webapp] auth denied from ${ip}: ${check.reason}`)
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: `验证未通过 (${check.reason})` }))
      return
    }

    this.authFailures.delete(ip)
    const cookieVal = this._createSession(check.user)
    const ttlSec = Math.max(60, Math.floor(this.sessionTtlMs / 1000))
    const isHttps =
      req.headers["x-forwarded-proto"] === "https" ||
      req.headers["cf-visitor"]?.includes("https") ||
      Boolean(req.socket?.encrypted)

    const cookieAttrs = [
      `${COOKIE_NAME}=${cookieVal}`,
      "HttpOnly",
      "Path=/",
      `Max-Age=${ttlSec}`,
      isHttps ? "Secure; SameSite=None" : "SameSite=Lax",
    ]

    this.logger.info?.(`[webapp] auth ok user=${check.user.id} ip=${ip}`)
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": cookieAttrs.join("; "),
    })
    res.end(JSON.stringify({ ok: true }))
  }

  _proxyHttpToUpstream(req, res) {
    return new Promise((resolve, reject) => {
      const codegToken = String(this.codegTokenProvider?.() || "").trim()
      const urlPath = (req.url || "/").split("?")[0]
      const isStaticOrApi =
        urlPath.startsWith("/_next/") ||
        urlPath.startsWith("/api/") ||
        /\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|ico|map|json)$/i.test(urlPath)
      const clientAcceptEncoding = String(req.headers["accept-encoding"] || "")

      const headers = { ...req.headers }
      delete headers.cookie
      if (!isStaticOrApi) {
        delete headers["accept-encoding"]
      }
      headers.host = this.upstream.host
      if (codegToken) {
        headers.authorization = `Bearer ${codegToken}`
      }

      const upReq = http.request(
        {
          hostname: this.upstream.hostname,
          port: Number(this.upstream.port || 80),
          path: req.url,
          method: req.method,
          headers,
          agent: this.upstreamAgent,
        },
        (upRes) => {
          const respHeaders = { ...upRes.headers }
          delete respHeaders["set-cookie"]
          if (
            urlPath.startsWith("/_next/static/") &&
            upRes.statusCode === 200 &&
            !respHeaders["cache-control"]
          ) {
            respHeaders["cache-control"] = "public, max-age=31536000, immutable"
          }

          const contentType = String(
            respHeaders["content-type"] || ""
          ).toLowerCase()
          const isHtml = !isStaticOrApi && contentType.includes("text/html")

          if (!isHtml) {
            res.writeHead(upRes.statusCode || 502, respHeaders)
            upRes.pipe(res)
            upRes.on("end", resolve)
            upRes.on("error", reject)
            return
          }

          const chunks = []
          upRes.on("data", (c) => chunks.push(c))
          upRes.on("error", reject)
          upRes.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8")
            if (!html.includes("tg-miniapp-polish")) {
              if (/<\/head>/i.test(html)) {
                html = html.replace(
                  /<\/head>/i,
                  `${MINIAPP_POLISH_STYLE}</head>`
                )
              } else {
                html = `${MINIAPP_POLISH_STYLE}${html}`
              }
            }
            let outBuf = Buffer.from(html, "utf8")
            delete respHeaders["content-length"]
            delete respHeaders["content-encoding"]
            delete respHeaders["transfer-encoding"]
            if (/\bgzip\b/i.test(clientAcceptEncoding)) {
              outBuf = zlib.gzipSync(outBuf, { level: 6 })
              respHeaders["content-encoding"] = "gzip"
            }
            respHeaders["content-length"] = String(outBuf.length)
            res.writeHead(upRes.statusCode || 502, respHeaders)
            res.end(outBuf)
            resolve()
          })
        }
      )

      upReq.on("error", reject)
      req.pipe(upReq)
    })
  }

  async _handleUpgrade(req, clientSocket, head) {
    const session = this._verifySessionCookie(req)
    if (!session || !this._checkSameOrigin(req)) {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      clientSocket.destroy()
      return
    }

    const codegToken = String(this.codegTokenProvider?.() || "").trim()
    const headers = { ...req.headers }
    delete headers.cookie
    headers.host = this.upstream.host

    const protoList = String(headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("codeg-token."))
    if (!protoList.includes("codeg-events")) {
      protoList.unshift("codeg-events")
    }
    if (codegToken) {
      protoList.push(
        `codeg-token.${Buffer.from(codegToken, "utf8").toString("base64url")}`
      )
    }
    headers["sec-websocket-protocol"] = protoList.join(", ")

    const upReq = http.request({
      hostname: this.upstream.hostname,
      port: Number(this.upstream.port || 80),
      path: req.url,
      method: req.method,
      headers,
      agent: false,
    })

    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      this.activeSockets.add(clientSocket)
      this.activeSockets.add(upSocket)

      const headerLines = [
        `HTTP/1.1 ${upRes.statusCode || 101} ${upRes.statusMessage || "Switching Protocols"}`,
      ]
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        const name = upRes.rawHeaders[i]
        const val = upRes.rawHeaders[i + 1]
        if (name.toLowerCase() === "sec-websocket-protocol") {
          const cleanProto = String(val)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith("codeg-token."))
            .join(", ")
          if (cleanProto) headerLines.push(`${name}: ${cleanProto}`)
        } else {
          headerLines.push(`${name}: ${val}`)
        }
      }
      headerLines.push("", "")
      clientSocket.write(headerLines.join("\r\n"))

      if (upHead && upHead.length > 0) clientSocket.write(upHead)
      if (head && head.length > 0) upSocket.write(head)

      const cleanup = () => {
        this.activeSockets.delete(clientSocket)
        this.activeSockets.delete(upSocket)
        if (!clientSocket.destroyed) clientSocket.destroy()
        if (!upSocket.destroyed) upSocket.destroy()
      }
      clientSocket.on("error", cleanup)
      upSocket.on("error", cleanup)
      clientSocket.on("close", cleanup)
      upSocket.on("close", cleanup)

      upSocket.pipe(clientSocket)
      clientSocket.pipe(upSocket)
    })

    upReq.on("response", (upRes) => {
      clientSocket.write(
        `HTTP/1.1 ${upRes.statusCode || 502} ${upRes.statusMessage || "Bad Gateway"}\r\n\r\n`
      )
      clientSocket.destroy()
    })

    upReq.on("error", () => {
      if (!clientSocket.destroyed) clientSocket.destroy()
    })

    upReq.end()
  }
}
