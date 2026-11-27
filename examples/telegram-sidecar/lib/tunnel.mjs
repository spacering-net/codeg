// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { redactText, registerSecret } from "./redact.mjs"

const TRY_CF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const NAMED_READY_RE = /Registered tunnel connection/i

export class QuickTunnelManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cloudflaredPath
   * @param {string} opts.targetUrl
   * @param {string} opts.runDir
   * @param {'quick'|'named'} [opts.mode]
   * @param {string} [opts.tokenFile]
   * @param {string} [opts.publicUrl]
   * @param {object} [opts.logger]
   */
  constructor({
    cloudflaredPath,
    targetUrl,
    runDir,
    mode = "quick",
    tokenFile = "",
    publicUrl = "",
    logger = console,
  }) {
    super()
    this.cloudflaredPath = cloudflaredPath
    this.targetUrl = targetUrl
    this.runDir = runDir
    this.mode = mode === "named" ? "named" : "quick"
    this.tokenFile = tokenFile
    if (tokenFile) {
      // Register the tunnel token so it can never surface in logs.
      try {
        const raw = fs.readFileSync(tokenFile, "utf8").trim()
        if (raw) registerSecret(raw)
      } catch {
        // missing file is reported at spawn time
      }
    }
    this.publicUrl = (publicUrl || "").replace(/\/+$/, "")
    this.logger = logger

    this.emptyCfgPath = path.join(runDir, "quick-empty.yml")
    this.pidFile = path.join(runDir, "tunnel.pid")
    this.logFile = path.join(runDir, "quick.log")
    this.urlFile = path.join(runDir, "tunnel-url.txt")

    this.child = null
    this.running = false
    this.currentUrl = ""
    this.restartTimer = null
    this._logStream = null
  }

  getUrl() {
    return this.currentUrl
  }

  isRunning() {
    return this.running && Boolean(this.child && !this.child.killed)
  }

  start() {
    if (this.running) return
    if (!fs.existsSync(this.cloudflaredPath)) {
      this.logger.warn?.(
        `[tunnel] cloudflared not found at ${this.cloudflaredPath}`
      )
      return
    }

    fs.mkdirSync(this.runDir, { recursive: true })
    if (!fs.existsSync(this.emptyCfgPath)) {
      fs.writeFileSync(
        this.emptyCfgPath,
        "# intentionally empty: prevents cloudflared from loading ~/.cloudflared/config.yml\n",
        "utf8"
      )
    }

    this._clearStalePid()
    this.running = true
    this._spawnChild()
  }

  stop() {
    this.running = false
    this.currentUrl = ""
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this._killChild()
    this._removePidAndUrl()
  }

  async rotate() {
    if (!this.running) {
      this.start()
      return
    }
    this.currentUrl = ""
    this._killChild()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this._spawnChild()
  }

  _clearStalePid() {
    try {
      if (!fs.existsSync(this.pidFile)) return
      // A persisted PID cannot prove ownership after a restart: the OS may
      // have reused it. Only _killChild signals a child started by this instance.
      fs.unlinkSync(this.pidFile)
    } catch {
      // ignore
    }
  }

  _removePidAndUrl() {
    for (const f of [this.pidFile, this.urlFile]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f)
      } catch {
        // ignore
      }
    }
  }

  _killChild() {
    const ch = this.child
    this.child = null
    if (this._logStream) {
      try {
        this._logStream.end()
      } catch {
        // ignore
      }
      this._logStream = null
    }
    if (ch && !ch.killed) {
      try {
        ch.kill("SIGTERM")
      } catch {
        // ignore
      }
    }
  }

  _spawnChild() {
    if (!this.running) return
    this.currentUrl = ""

    const cleanEnv = { ...process.env }
    for (const key of Object.keys(cleanEnv)) {
      if (/^(http|https|all)_proxy$/i.test(key)) {
        delete cleanEnv[key]
      }
    }

    try {
      this._logStream = fs.createWriteStream(this.logFile, { flags: "w" })
    } catch {
      this._logStream = null
    }

    const isNamed = this.mode === "named"
    if (isNamed && (!this.tokenFile || !fs.existsSync(this.tokenFile))) {
      this.logger.error?.(
        `[tunnel] named tunnel token file missing: ${this.tokenFile}`
      )
      return
    }

    const args = isNamed
      ? [
          "tunnel",
          "--config",
          this.emptyCfgPath,
          "--pidfile",
          this.pidFile,
          "--protocol",
          "http2",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "run",
          "--token-file",
          this.tokenFile,
        ]
      : [
          "tunnel",
          "--config",
          this.emptyCfgPath,
          "--url",
          this.targetUrl,
          "--pidfile",
          this.pidFile,
          "--protocol",
          "http2",
          "--no-autoupdate",
          "--loglevel",
          "info",
        ]

    const ch = spawn(this.cloudflaredPath, args, {
      env: cleanEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = ch
    this.logger.info?.(
      isNamed
        ? `[tunnel] starting cloudflared named tunnel -> ${this.publicUrl || "(cloudflare dashboard route)"}`
        : `[tunnel] starting cloudflared quick tunnel -> ${this.targetUrl}`
    )

    const onChunk = (chunk) => {
      // cloudflared output can echo the tunnel token; never forward it verbatim.
      const text = redactText(chunk.toString("utf8"))
      this._logStream?.write(text)
      if (!this.currentUrl) {
        let readyUrl = ""
        if (isNamed) {
          if (NAMED_READY_RE.test(text)) {
            readyUrl = this.publicUrl
          }
        } else {
          const m = text.match(TRY_CF_RE)
          if (m) readyUrl = m[0]
        }
        if (readyUrl) {
          this.currentUrl = readyUrl
          try {
            fs.writeFileSync(this.urlFile, `${this.currentUrl}\n`, "utf8")
          } catch {
            // ignore
          }
          this.logger.info?.(
            `[tunnel] ${isNamed ? "named" : "quick"} tunnel ready: ${this.currentUrl}`
          )
          this.emit("url", this.currentUrl)
        }
      }
    }

    ch.stdout?.on("data", onChunk)
    ch.stderr?.on("data", onChunk)

    ch.on("exit", (code, sig) => {
      if (this.child === ch) {
        this.child = null
      }
      if (this._logStream) {
        try {
          this._logStream.end()
        } catch {
          // ignore
        }
        this._logStream = null
      }
      if (!this.running) return
      this.logger.warn?.(
        `[tunnel] cloudflared exited (code=${code}, sig=${sig}), restarting in 4s...`
      )
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this._spawnChild()
      }, 4000)
      this.restartTimer.unref?.()
    })
  }
}
