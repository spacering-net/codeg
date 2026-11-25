// SPDX-License-Identifier: Apache-2.0
import http from "node:http"
import https from "node:https"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { redactText } from "./redact.mjs"

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/**
 * Zero-dependency RFC 6455 WebSocket client built directly on node:http / node:https
 * with `agent: false` so local loopback connections never touch HTTP_PROXY / undici.
 */
export class SimpleWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  /**
   * @param {string} urlString
   * @param {string | string[]} [protocols]
   */
  constructor(urlString, protocols = []) {
    super()
    this.url = urlString
    this.protocols = Array.isArray(protocols)
      ? protocols
      : typeof protocols === "string" && protocols
        ? [protocols]
        : []
    this.readyState = SimpleWebSocket.CONNECTING
    this.protocol = ""

    this._req = null
    this._socket = null
    this._rxBuf = Buffer.alloc(0)
    this._fragOpcode = null
    this._fragChunks = []
    this._closeEmitted = false
    this._closeCode = 1006
    this._closeReason = ""

    this._connect()
  }

  addEventListener(type, listener) {
    this.on(type, listener)
  }

  removeEventListener(type, listener) {
    this.off(type, listener)
  }

  _connect() {
    let urlObj
    try {
      urlObj = new URL(this.url)
    } catch (err) {
      queueMicrotask(() => {
        this._failConnection(err)
      })
      return
    }

    const isSecure = urlObj.protocol === "wss:" || urlObj.protocol === "https:"
    const transport = isSecure ? https : http
    const key = crypto.randomBytes(16).toString("base64")
    const expectedAccept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64")

    const headers = {
      Host: urlObj.host,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    }
    if (this.protocols.length > 0) {
      headers["Sec-WebSocket-Protocol"] = this.protocols.join(", ")
    }

    const req = transport.request({
      protocol: isSecure ? "https:" : "http:",
      hostname: urlObj.hostname,
      port: urlObj.port || (isSecure ? 443 : 80),
      path: `${urlObj.pathname || "/"}${urlObj.search || ""}`,
      method: "GET",
      headers,
      agent: false, // bypass any global agent or proxy
    })
    this._req = req

    req.on("upgrade", (res, socket, head) => {
      if (this.readyState !== SimpleWebSocket.CONNECTING) {
        socket.destroy()
        return
      }

      const accept = res.headers["sec-websocket-accept"]
      if (accept !== expectedAccept) {
        socket.destroy()
        this._failConnection(
          new Error(`Invalid Sec-WebSocket-Accept header: ${accept}`)
        )
        return
      }

      this._socket = socket
      socket.setNoDelay?.(true)
      this.protocol = res.headers["sec-websocket-protocol"] || ""
      this.readyState = SimpleWebSocket.OPEN

      socket.on("data", (chunk) => this._onData(chunk))
      socket.on("error", (err) => {
        if (this.listenerCount("error") > 0) {
          this.emit("error", { message: redactText(err.message), error: err })
        }
      })
      socket.on("close", () => {
        this._emitClose(this._closeCode, this._closeReason)
      })

      this.emit("open", {})
      if (head && head.length > 0) {
        this._onData(head)
      }
    })

    req.on("response", (res) => {
      res.resume()
      this._failConnection(
        new Error(
          `Unexpected HTTP response ${res.statusCode} on WebSocket upgrade`
        )
      )
    })

    req.on("error", (err) => {
      this._failConnection(err)
    })

    req.end()
  }

  _failConnection(err) {
    if (this.readyState === SimpleWebSocket.CLOSED) return
    this.readyState = SimpleWebSocket.CLOSED
    try {
      this._socket?.destroy()
    } catch {
      // ignore
    }
    // The upgrade URL carries the Codeg token in its subprotocol list, so any
    // socket-level error text is redacted before it can reach a logger.
    const message = redactText(err?.message || "WebSocket error")
    if (this.listenerCount("error") > 0) {
      this.emit("error", { message, error: err })
    }
    this._emitClose(1006, message)
  }

  _emitClose(code = 1006, reason = "") {
    if (this._closeEmitted) return
    this._closeEmitted = true
    this.readyState = SimpleWebSocket.CLOSED
    this.emit("close", { code, reason })
  }

  send(data) {
    if (this.readyState !== SimpleWebSocket.OPEN || !this._socket) {
      throw new Error("WebSocket is not open")
    }
    const isBuf = Buffer.isBuffer(data)
    const opcode = isBuf ? 0x02 : 0x01
    const payload = isBuf ? data : Buffer.from(String(data), "utf8")
    this._sendFrame(opcode, payload)
  }

  close(code = 1000, reason = "") {
    if (this.readyState === SimpleWebSocket.CLOSED) return
    if (this.readyState === SimpleWebSocket.CONNECTING) {
      this.readyState = SimpleWebSocket.CLOSING
      try {
        this._req?.destroy()
      } catch {
        // ignore
      }
      this._emitClose(1006, reason)
      return
    }
    if (this.readyState === SimpleWebSocket.OPEN && this._socket) {
      this.readyState = SimpleWebSocket.CLOSING
      this._closeCode = code
      this._closeReason = reason
      const reasonBuf = Buffer.from(String(reason || ""), "utf8").subarray(
        0,
        123
      )
      const payload = Buffer.alloc(2 + reasonBuf.length)
      payload.writeUInt16BE(code, 0)
      reasonBuf.copy(payload, 2)
      try {
        this._sendFrame(0x08, payload)
        this._socket.end()
        this._socket.destroy()
      } catch {
        this._socket.destroy()
      }
      this._emitClose(code, reason)
    }
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || this._socket.destroyed) return
    const len = payload.length
    const maskKey = crypto.randomBytes(4)
    let header

    if (len < 126) {
      header = Buffer.alloc(6)
      header[0] = 0x80 | (opcode & 0x0f)
      header[1] = 0x80 | len
      maskKey.copy(header, 2)
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[0] = 0x80 | (opcode & 0x0f)
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
      maskKey.copy(header, 4)
    } else {
      header = Buffer.alloc(14)
      header[0] = 0x80 | (opcode & 0x0f)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
      maskKey.copy(header, 10)
    }

    const maskedPayload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ maskKey[i & 3]
    }

    this._socket.write(Buffer.concat([header, maskedPayload]))
  }

  _onData(chunk) {
    this._rxBuf =
      this._rxBuf.length === 0 ? chunk : Buffer.concat([this._rxBuf, chunk])

    while (this._rxBuf.length >= 2) {
      const b0 = this._rxBuf[0]
      const b1 = this._rxBuf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (this._rxBuf.length < 4) return
        payloadLen = this._rxBuf.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this._rxBuf.length < 10) return
        payloadLen = Number(this._rxBuf.readBigUInt64BE(2))
        offset = 10
      }

      const maskLen = masked ? 4 : 0
      if (this._rxBuf.length < offset + maskLen + payloadLen) return

      const maskKey = masked ? this._rxBuf.subarray(offset, offset + 4) : null
      offset += maskLen

      const payload = Buffer.from(
        this._rxBuf.subarray(offset, offset + payloadLen)
      )
      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3]
        }
      }

      this._rxBuf = this._rxBuf.subarray(offset + payloadLen)
      this._handleFrame(fin, opcode, payload)
    }
  }

  _handleFrame(fin, opcode, payload) {
    // Control frames (0x8 Close, 0x9 Ping, 0xA Pong)
    if (opcode >= 0x08) {
      if (opcode === 0x09) {
        if (this.readyState === SimpleWebSocket.OPEN) {
          this._sendFrame(0x0a, payload)
        }
        return
      }
      if (opcode === 0x0a) {
        this.emit("pong", payload)
        return
      }
      if (opcode === 0x08) {
        let code = 1000
        let reason = ""
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0)
          reason = payload.subarray(2).toString("utf8")
        }
        this._closeCode = code
        this._closeReason = reason
        if (this.readyState === SimpleWebSocket.OPEN) {
          this.readyState = SimpleWebSocket.CLOSING
          try {
            const reply = Buffer.alloc(2)
            reply.writeUInt16BE(code, 0)
            this._sendFrame(0x08, reply)
          } catch {
            // ignore
          }
        }
        try {
          this._socket?.end()
        } catch {
          // ignore
        }
        this._emitClose(code, reason)
        return
      }
      return
    }

    // Data frames (0x1 text, 0x2 binary, 0x0 continuation)
    if (opcode === 0x00) {
      if (this._fragOpcode === null) return
      this._fragChunks.push(payload)
      if (fin) {
        const full = Buffer.concat(this._fragChunks)
        const origOpcode = this._fragOpcode
        this._fragOpcode = null
        this._fragChunks = []
        this.emit("message", {
          data: origOpcode === 0x01 ? full.toString("utf8") : full,
        })
      }
      return
    }

    if (!fin) {
      this._fragOpcode = opcode
      this._fragChunks = [payload]
      return
    }

    this.emit("message", {
      data: opcode === 0x01 ? payload.toString("utf8") : payload,
    })
  }
}
