// Built-in browser console shim. Injected by the Rust host into the PAGE
// world — not the isolated one the helper lives in — at document start, in
// every frame, on the engines that report a page's console to nobody: WebKit
// on macOS and Linux. WebView2 reports it over CDP and never runs this script,
// or every line would arrive twice.
//
// It wraps the console methods a page uses to say something and hands each
// call to the isolated-world helper as a DOM event on the document whose
// `detail` is one JSON string. A string is the one kind of value that crosses
// a world boundary unchanged in every engine; nothing else is shared, and this
// script never talks to the host. The helper (`helper.js`) reads the string
// with its own pristine JSON, adds the address it came from, and forwards it.
//
// Two rules keep it out of the page's way. The page's own call happens FIRST,
// exactly as it would have, and nothing that goes wrong in taking the copy
// afterwards reaches the caller. And formatting runs no page code: values are
// read through property descriptors (a data property's value; an accessor is
// shown as `(…)`, the way a developer console shows one until it is clicked),
// what a value is comes from the engine's own brand checks rather than from
// `Object.prototype.toString` (a `Symbol.toStringTag` read the page can put a
// getter behind), collections are walked through captured iterators a bounded
// number of steps, numeric substitutions coerce only primitives, and every
// string goes through a cap. So a getter with side effects, a `toString` that
// throws, a `toJSON` on `Object.prototype` or a Map with a million entries
// changes nothing about the page's behaviour. What cannot be avoided is a
// Proxy's own traps (`ownKeys`, `getPrototypeOf`) firing when the page logs
// the proxy: that is the page running its own code on its own object.
//
// Everything about it is untrusted by construction. It runs in the page's own
// world, so the page can replace the wrapped methods, dispatch the same event
// with whatever it likes, or override the primitives captured below before
// this runs (it cannot: user scripts at document start run before any page
// script, which is why the captures are taken here and not on each call).
// That is what the host tells an agent about these lines: what the page
// printed, and only ever data.
;(function codegConsoleShim() {
  "use strict"
  var console = globalThis.console
  if (!console || typeof console.log !== "function") return
  var mark = "__codegConsoleShim"
  if (console[mark]) return
  try {
    Object.defineProperty(console, mark, { value: true })
  } catch {
    return
  }

  // Everything used at call time, taken now while it is still the engine's.
  var stringify = JSON.stringify
  var apply = Function.prototype.apply
  var defineProperty = Object.defineProperty
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  var hasOwnProperty = Object.prototype.hasOwnProperty
  var getPrototypeOf = Object.getPrototypeOf
  var keys = Object.keys
  var isArray = Array.isArray
  var StringOf = String
  var parseIntOf = parseInt
  var parseFloatOf = parseFloat
  var floorOf = Math.floor
  var dateGetTime = Date.prototype.getTime
  var dateToISOString = Date.prototype.toISOString
  var now = Date.now
  var CustomEventCtor = globalThis.CustomEvent
  var dispatchEvent = EventTarget.prototype.dispatchEvent
  var doc = document
  if (typeof CustomEventCtor !== "function") return
  // Collections are read through their iterators, one step at a time, so a
  // huge Map costs a bounded number of steps and no method the page could
  // have replaced is called.
  var mapEntries = typeof Map === "function" ? Map.prototype.entries : null
  var setValues = typeof Set === "function" ? Set.prototype.values : null
  var mapSize = accessor(
    typeof Map === "function" ? Map.prototype : null,
    "size"
  )
  var setSize = accessor(
    typeof Set === "function" ? Set.prototype : null,
    "size"
  )
  var mapNext = mapEntries ? nextOf(mapEntries.call(new Map())) : null
  var setNext = setValues ? nextOf(setValues.call(new Set())) : null
  // DOM nodes are described through the engine's own getters, not through
  // properties a page may have shadowed on the node.
  var nodeType = accessor(
    typeof Node === "function" ? Node.prototype : null,
    "nodeType"
  )
  var nodeName = accessor(
    typeof Node === "function" ? Node.prototype : null,
    "nodeName"
  )
  var elementId = accessor(
    typeof Element === "function" ? Element.prototype : null,
    "id"
  )
  var elementClass = accessor(
    typeof Element === "function" ? Element.prototype : null,
    "className"
  )
  // A regular expression's source through the prototype's own getter (an
  // internal-slot read), rather than `toString`, which reads `source` and
  // `flags` through properties the page may have shadowed on the instance.
  var regExpSource = accessor(RegExp.prototype, "source")

  function accessor(proto, name) {
    if (!proto) return null
    try {
      var d = getOwnPropertyDescriptor(proto, name)
      return d && typeof d.get === "function" ? d.get : null
    } catch {
      return null
    }
  }
  function nextOf(iterator) {
    try {
      var next = getPrototypeOf(iterator).next
      return typeof next === "function" ? next : null
    } catch {
      return null
    }
  }
  function get(getter, value) {
    try {
      return getter.call(value)
    } catch {
      return undefined
    }
  }
  // What a value IS is decided by the engine's own brand checks — a Map's
  // `size` getter throws on anything that is not a Map.
  function brand(method, value) {
    if (!method) return false
    try {
      method.call(value)
      return true
    } catch {
      return false
    }
  }

  var EVENT = "codeg:console"
  var MAX_TEXT = 4000
  var MAX_STRING = 2000
  var MAX_ARGS = 32
  var MAX_ITEMS = 20
  var MAX_DEPTH = 2

  // ---- formatting -------------------------------------------------------
  // A property's value read without running anything: a data property's
  // value, or this marker for an accessor. Whether the descriptor has a
  // `value` is asked as an OWN property: the descriptor object inherits the
  // page's `Object.prototype`, and a getter the page put there under `value`
  // would otherwise answer for every accessor property.
  var ACCESSOR = {}
  function own(value, name) {
    try {
      var d = getOwnPropertyDescriptor(value, name)
      if (!d) return undefined
      return hasOwnProperty.call(d, "value") ? d.value : ACCESSOR
    } catch {
      return undefined
    }
  }
  function protoOf(value) {
    try {
      return getPrototypeOf(value)
    } catch {
      return null
    }
  }
  function capString(text, limit) {
    return text.length > limit ? text.slice(0, cutAt(text, limit)) + "…" : text
  }
  // Never cut between the halves of a surrogate pair: `JSON.stringify` would
  // emit an escape for half a character and the host's parser refuses the
  // whole message, so one emoji in the wrong place would cost the line rather
  // than one character of it.
  function cutAt(text, limit) {
    var last = text.charCodeAt(limit - 1)
    return last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
  }
  function isNode(value) {
    return (
      nodeType !== null &&
      typeof get(nodeType, value) === "number" &&
      typeof get(nodeName, value) === "string"
    )
  }
  function describeNode(node) {
    var name = StringOf(get(nodeName, node)).toLowerCase()
    if (get(nodeType, node) !== 1) return "#" + name
    var out = "<" + name
    var id = elementId ? get(elementId, node) : ""
    if (typeof id === "string" && id) out += "#" + capString(id, 200)
    var cls = elementClass ? get(elementClass, node) : ""
    if (typeof cls === "string" && cls)
      out += "." + capString(cls, 200).trim().split(/\s+/).slice(0, 3).join(".")
    return out + ">"
  }
  // An error is recognised by its own data properties, which every engine
  // gives one: a string `stack`, or a string `message` under a prototype
  // that names itself. Name, message and stack are then read the same way,
  // without running a getter.
  function isErrorLike(value) {
    if (typeof own(value, "stack") === "string") return true
    if (typeof own(value, "message") !== "string") return false
    var name = own(value, "name")
    if (typeof name !== "string") name = own(protoOf(value), "name")
    return typeof name === "string"
  }
  function errorText(value) {
    var message = own(value, "message")
    var name = own(value, "name")
    if (typeof name !== "string") name = own(protoOf(value), "name")
    var head =
      typeof message === "string"
        ? (typeof name === "string" && name ? name : "Error") +
          ": " +
          capString(message, MAX_STRING)
        : ""
    var stack = own(value, "stack")
    if (typeof stack === "string" && stack) {
      // The first lines of a stack are what an agent can use; a framework's
      // forty internal frames are not. V8 begins the stack with the message
      // line; JavaScriptCore's is frames only, so the message goes in front.
      var lines = capString(stack, MAX_STRING)
        .split("\n")
        .slice(0, 8)
        .join("\n")
      return head && lines.indexOf(head) !== 0 ? head + "\n" + lines : lines
    }
    return head || "Error"
  }
  function constructorName(value) {
    var ctor = own(protoOf(value), "constructor")
    if (typeof ctor !== "function") return ""
    var name = own(ctor, "name")
    return typeof name === "string" ? name : ""
  }
  function format(value, depth) {
    var t = typeof value
    if (t === "string") return capString(value, MAX_STRING)
    if (t === "undefined") return "undefined"
    if (value === null) return "null"
    if (t === "number" || t === "boolean" || t === "bigint")
      return StringOf(value)
    if (t === "symbol") {
      try {
        return StringOf(value)
      } catch {
        return "Symbol()"
      }
    }
    if (value === ACCESSOR) return "(…)"
    if (t === "function") {
      var fname = own(value, "name")
      return (
        "[Function" +
        (typeof fname === "string" && fname ? ": " + fname : "") +
        "]"
      )
    }
    if (isErrorLike(value)) return errorText(value)
    if (isNode(value)) return describeNode(value)
    if (brand(dateGetTime, value)) {
      try {
        return dateToISOString.call(value)
      } catch {
        return "Invalid Date"
      }
    }
    if (regExpSource && brand(regExpSource, value))
      return (
        "/" + capString(StringOf(get(regExpSource, value)), MAX_STRING) + "/"
      )
    if (depth >= MAX_DEPTH) return isArray(value) ? "[…]" : "{…}"
    var parts = []
    var more = false
    if (isArray(value)) {
      var length = own(value, "length")
      if (typeof length !== "number") length = 0
      for (var i = 0; i < length && i < MAX_ITEMS; i++)
        parts.push(format(own(value, StringOf(i)), depth + 1))
      more = length > MAX_ITEMS
      return "[" + parts.join(", ") + (more ? ", …" : "") + "]"
    }
    if (mapEntries && mapNext && brand(mapSize, value)) {
      var mi = mapEntries.call(value)
      for (var m = 0; m < MAX_ITEMS; m++) {
        var ms = mapNext.call(mi)
        if (ms.done) break
        parts.push(
          format(ms.value[0], depth + 1) +
            " => " +
            format(ms.value[1], depth + 1)
        )
      }
      more = !mapNext.call(mi).done
      return (
        "Map(" +
        StringOf(get(mapSize, value)) +
        ") {" +
        parts.join(", ") +
        (more ? ", …" : "") +
        "}"
      )
    }
    if (setValues && setNext && brand(setSize, value)) {
      var si = setValues.call(value)
      for (var s = 0; s < MAX_ITEMS; s++) {
        var ss = setNext.call(si)
        if (ss.done) break
        parts.push(format(ss.value, depth + 1))
      }
      more = !setNext.call(si).done
      return (
        "Set(" +
        StringOf(get(setSize, value)) +
        ") {" +
        parts.join(", ") +
        (more ? ", …" : "") +
        "}"
      )
    }
    var names
    try {
      names = keys(value)
    } catch {
      return "{…}"
    }
    for (var j = 0; j < names.length && j < MAX_ITEMS; j++)
      parts.push(names[j] + ": " + format(own(value, names[j]), depth + 1))
    more = names.length > MAX_ITEMS
    var ctorName = constructorName(value)
    var prefix = ctorName && ctorName !== "Object" ? ctorName + " " : ""
    return prefix + "{" + parts.join(", ") + (more ? ", …" : "") + "}"
  }
  // `console.log("%s: %d", name, n)` — the substitutions every engine
  // honours. `%c` styles nothing here and eats its argument, as in a
  // browser. Numeric substitutions coerce only primitives: coercing an object
  // would run its `toString` / `valueOf`.
  function integer(arg) {
    if (typeof arg === "number")
      return StringOf(arg < 0 ? -floorOf(-arg) : floorOf(arg))
    if (typeof arg === "string" || typeof arg === "boolean")
      return StringOf(parseIntOf(arg, 10))
    return "NaN"
  }
  function decimal(arg) {
    if (typeof arg === "number") return StringOf(arg)
    if (typeof arg === "string") return StringOf(parseFloatOf(arg))
    return "NaN"
  }
  function formatArgs(args) {
    var out = []
    var start = 0
    var count = args.length < MAX_ARGS ? args.length : MAX_ARGS
    if (count > 1 && typeof args[0] === "string" && args[0].indexOf("%") >= 0) {
      var index = 1
      var text = capString(args[0], MAX_STRING).replace(
        /%([sdifoOjc%])/g,
        function (m, spec) {
          if (spec === "%") return "%"
          if (index >= count) return m
          var arg = args[index++]
          if (spec === "c") return ""
          if (spec === "d" || spec === "i") return integer(arg)
          if (spec === "f") return decimal(arg)
          return format(arg, 0)
        }
      )
      out.push(text)
      start = index
    }
    for (var i = start; i < count; i++) out.push(format(args[i], 0))
    if (args.length > MAX_ARGS)
      out.push("…(+" + (args.length - MAX_ARGS) + " more)")
    return out.join(" ")
  }
  function cap(text) {
    return text.length > MAX_TEXT
      ? text.slice(0, cutAt(text, MAX_TEXT)) + "…"
      : text
  }

  // ---- forwarding -------------------------------------------------------
  var inside = false
  function emit(level, args) {
    // A page listener on the same event that itself logs would recurse.
    if (inside) return
    inside = true
    try {
      // Built by hand rather than from an object literal: a literal
      // inherits the page's `Object.prototype`, and a `toJSON` the page put
      // there would be run by `stringify`. A string primitive is not asked.
      var payload =
        '{"level":' +
        stringify(level) +
        ',"text":' +
        stringify(cap(formatArgs(args))) +
        ',"ts":' +
        StringOf(now()) +
        "}"
      dispatchEvent.call(doc, new CustomEventCtor(EVENT, { detail: payload }))
    } catch {
      /* best effort: the page's own call has already happened */
    } finally {
      inside = false
    }
  }
  function wrap(name, level, transform) {
    var original = console[name]
    if (typeof original !== "function") return
    var wrapped = function () {
      // The page's own call first, exactly as it would have been; only
      // then the copy for the agent — and nothing that goes wrong in
      // taking the copy reaches the caller.
      var result = apply.call(original, this, arguments)
      try {
        var args = transform ? transform(arguments) : arguments
        if (args) emit(level, args)
      } catch {
        /* the copy is best effort */
      }
      return result
    }
    try {
      defineProperty(wrapped, "name", { value: name, configurable: true })
      defineProperty(console, name, {
        value: wrapped,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    } catch {
      /* a frozen console keeps its own methods */
    }
  }
  wrap("log", "log")
  wrap("info", "info")
  wrap("warn", "warn")
  wrap("error", "error")
  wrap("debug", "debug")
  wrap("trace", "log", function (args) {
    var out = ["Trace:"]
    for (var i = 0; i < args.length && i < MAX_ARGS; i++) out.push(args[i])
    return out
  })
  wrap("assert", "error", function (args) {
    if (args.length && args[0]) return null
    var out = ["Assertion failed:"]
    for (var i = 1; i < args.length && i < MAX_ARGS; i++) out.push(args[i])
    if (out.length === 1) out.push("console.assert")
    return out
  })
})()
