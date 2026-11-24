// How `browser_eval` describes what a snippet returned. Injected by the Rust
// host (`browser::eval::eval_call`) into the PAGE's own world — the only
// script in the built-in browser that goes there apart from the console shim,
// and the only one that shares a world with an agent's own code.
//
// It runs there because a snippet must not: an agent's code is inlined as
// source text and can do anything, and codeg's isolated world is where every
// other browser tool's answer is built, out of that world's `JSON.stringify`
// and prototypes. One snippet replacing those would let a later snapshot
// claim the origin a grant covers for a page nobody shared.
//
// The cost is that everything here is the page's: its intrinsics, its
// prototypes, its `JSON.stringify`. A hostile page can make all of it lie,
// which is fine, because nothing the host decides rests on what it says —
// where the page IS comes from a separate evaluation in codeg's own world.
// What this owes is only that an answer comes back at all, bounded, and
// parseable: hence the caps, the surrogate rule, and a `try` around every
// property read.
//
// The names below are called by the wrapper the host appends after this file.
/* eslint-disable @typescript-eslint/no-unused-vars */

var __codegEvalClip = function (text, limit) {
  if (typeof text !== "string") text = String(text)
  if (text.length <= limit) return [text, false]
  var end = limit
  // Never between the halves of a surrogate pair: JSON.stringify would emit
  // an escape for half a character and the host's parser refuses the message.
  var last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return [text.slice(0, end), true]
}
var __codegEvalEnvelope = function (kind, text) {
  var clipped = __codegEvalClip(text, 4000)
  return JSON.stringify({
    ok: true,
    kind: kind,
    value: clipped[0],
    truncated: clipped[1],
  })
}
var __codegEvalError = function (e) {
  var text
  try {
    // V8 begins a stack with the `Name: message` line; JavaScriptCore's is
    // frames only, so on the WebKit ports a bare stack loses the one part of
    // an exception anyone reads. Put it back when it is not already there.
    // Measured on a real WKWebView: Chrome cannot show this up.
    // Each property read exactly once, into a local. These are the page's
    // objects: a getter can throw, and one that answered a string the first
    // time is not obliged to the second — reading twice would drop the head
    // on the floor for an error that has one.
    var head = ""
    try {
      var message = e.message
      if (typeof message === "string") {
        var name = e.name
        head =
          (typeof name === "string" && name ? name : "Error") + ": " + message
      }
    } catch {}
    var stack = ""
    try {
      var raw = e.stack
      if (typeof raw === "string") stack = raw
    } catch {}
    if (stack) {
      text = head && stack.indexOf(head) !== 0 ? head + "\n" + stack : stack
    } else {
      text = head || String(e)
    }
  } catch {
    text = "the page threw something that cannot be described"
  }
  var clipped = __codegEvalClip(text, 4000)
  return JSON.stringify({
    ok: false,
    error: clipped[0],
    truncated: clipped[1],
  })
}
var __codegEvalRender = function (v) {
  if (v === undefined) return __codegEvalEnvelope("undefined", "undefined")
  if (v === null) return __codegEvalEnvelope("null", "null")
  var kind = typeof v
  if (kind === "string") return __codegEvalEnvelope("string", v)
  if (kind === "boolean" || kind === "number" || kind === "bigint") {
    return __codegEvalEnvelope(kind, String(v))
  }
  if (kind === "symbol") return __codegEvalEnvelope("symbol", String(v))
  if (kind === "function") {
    var name = ""
    try {
      name = String(v.name || "")
    } catch {}
    return __codegEvalEnvelope(
      "function",
      "function " + (name || "(anonymous)")
    )
  }
  try {
    if (typeof v.then === "function") {
      return __codegEvalEnvelope(
        "promise",
        "a promise. This evaluates one expression and does not wait: return the " +
          "settled state instead, or read it back with browser_eval once it has settled."
      )
    }
  } catch {}
  try {
    if (typeof v.nodeType === "number" && v.nodeName) {
      var described = String(v.nodeName).toLowerCase()
      try {
        if (v.id) described += "#" + String(v.id)
        var cls = v.className
        if (cls && typeof cls === "string") {
          described += "." + cls.trim().split(/\s+/).slice(0, 3).join(".")
        }
      } catch {}
      return __codegEvalEnvelope("node", "<" + described + ">")
    }
  } catch {}
  var text
  try {
    text = JSON.stringify(v)
    if (typeof text !== "string") text = String(v)
  } catch {
    try {
      text = String(v)
    } catch {
      text = "[a value that cannot be described]"
    }
  }
  var array = false
  try {
    array = Array.isArray(v)
  } catch {}
  return __codegEvalEnvelope(array ? "array" : "object", text)
}
