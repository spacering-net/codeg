// Built-in browser helper. Injected by the Rust host into the ISOLATED world
// of every browser tab (WKContentWorld "codeg" on macOS, a CDP isolated world
// on Windows, a WebKitGTK script world on Linux) at document start, for every
// frame. The page cannot see this script, its globals, or the native message
// channel it talks over — an isolated world shares the DOM but has its own
// JavaScript globals, so `JSON`, `addEventListener` and friends here are
// pristine even when the page overrides its own copies.
//
// It does three things:
//   1. Reports navigation state the host cannot observe natively (SPA
//      `pushState` / `replaceState` / hash changes, document title changes)
//      as `nav-state` messages.
//   2. Records user gestures — click / auxclick / keydown in the capture
//      phase — as `gesture` messages, including the anchor under the
//      pointer, so the host can decide how to present a resulting new-window
//      request (adopt as a tab vs. popup) and can turn a modifier-click on a
//      plain anchor into a background tab from `on_navigation`. It never
//      cancels, rewrites or re-dispatches anything: the engine navigates, the
//      host only decides presentation.
//   3. Forwards what the page prints — console lines relayed by the
//      page-world shim (`console.js`), uncaught exceptions, unhandled
//      rejections, failed resource loads — as `console` messages, on the
//      engines that report none of it to the host themselves.
//
// The host defines `__codegSend(string)` before this script runs. Messages
// are `{ kind, payload }` JSON strings; the host treats every field as
// untrusted input.
;(function codegBrowserHelper() {
  "use strict"
  if (typeof globalThis.__codegSend !== "function") return
  if (globalThis.__codegHelperInstalled) return
  globalThis.__codegHelperInstalled = true

  var send = globalThis.__codegSend
  var stringify = JSON.stringify
  var now = function () {
    return Date.now()
  }
  var isTop = (function () {
    try {
      return window.top === window
    } catch {
      return false
    }
  })()

  function post(kind, payload) {
    try {
      send(stringify({ kind: kind, payload: payload, top: isTop }))
    } catch {
      /* the channel is best-effort; never throw into page event dispatch */
    }
  }

  // ---- navigation state -------------------------------------------------
  var lastHref = ""
  var lastTitle = ""
  function reportNav(reason) {
    var href = String(location.href)
    var title = String(document.title || "")
    if (href === lastHref && title === lastTitle) return
    lastHref = href
    lastTitle = title
    post("nav-state", { href: href, title: title, reason: reason })
  }
  // history.pushState / replaceState are the only SPA transitions with no
  // native signal at all; wrapping them in this world affects only calls made
  // from this world, so we observe the page's calls through the events they
  // produce instead: none. Poll cheaply on user-visible ticks plus the events
  // that do fire.
  window.addEventListener(
    "popstate",
    function () {
      reportNav("popstate")
    },
    true
  )
  window.addEventListener(
    "hashchange",
    function () {
      reportNav("hashchange")
    },
    true
  )
  document.addEventListener(
    "DOMContentLoaded",
    function () {
      reportNav("dom-ready")
    },
    true
  )
  window.addEventListener(
    "load",
    function () {
      reportNav("load")
    },
    true
  )
  if (isTop) {
    var titleObserver = null
    function observeTitle() {
      if (titleObserver || !document.documentElement) return
      try {
        titleObserver = new MutationObserver(function () {
          reportNav("mutation")
        })
        // <title> lives in <head>; observing the document element catches it
        // being created, replaced or edited without walking the whole body.
        titleObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      } catch {
        titleObserver = null
      }
    }
    observeTitle()
    document.addEventListener("DOMContentLoaded", observeTitle, true)
    // pushState has no event: a light poll on animation frames only while
    // the document is visible costs nothing measurable and catches SPA
    // route changes within a frame.
    var rafHref = ""
    function tick() {
      if (document.visibilityState === "visible") {
        var href = String(location.href)
        if (href !== rafHref) {
          rafHref = href
          reportNav("poll")
        }
      }
      setTimeout(function () {
        requestAnimationFrame(tick)
      }, 250)
    }
    requestAnimationFrame(tick)
  }

  // ---- gestures ----------------------------------------------------------
  var gestureSeq = 0
  function primaryModifier(event) {
    // ⌘ on macOS, Ctrl elsewhere; the host knows the platform, so send both.
    return {
      meta: !!event.metaKey,
      ctrl: !!event.ctrlKey,
      shift: !!event.shiftKey,
      alt: !!event.altKey,
    }
  }
  function anchorFrom(event) {
    var path
    try {
      path =
        typeof event.composedPath === "function" ? event.composedPath() : []
    } catch {
      path = []
    }
    for (var i = 0; i < path.length; i++) {
      var node = path[i]
      if (!node || node.nodeType !== 1) continue
      var tag = String(node.tagName || "").toLowerCase()
      if (tag !== "a" && tag !== "area") continue
      if (!node.hasAttribute || !node.hasAttribute("href")) continue
      var href
      try {
        href = String(node.href || "")
      } catch {
        href = ""
      }
      var rel = String(node.getAttribute("rel") || "").toLowerCase()
      return {
        href: href,
        target: String(node.getAttribute("target") || ""),
        download: node.hasAttribute("download"),
        relNoOpener: /(^|\s)noopener(\s|$)/.test(rel),
        relNoReferrer: /(^|\s)noreferrer(\s|$)/.test(rel),
      }
    }
    return null
  }
  // Synthetic events are ignored: a page can dispatch a fake click, but the
  // host must only ever treat real input as a gesture. The isolated-world
  // flag below is the one exception, set by the host's own test harness
  // through a world-scoped eval (page scripts cannot reach this global).
  function trusted(event) {
    return !!event.isTrusted || globalThis.__codegAcceptUntrusted === true
  }
  function recordGesture(type, event, extra) {
    gestureSeq += 1
    var payload = {
      id: gestureSeq,
      type: type,
      ts: now(),
      button: typeof event.button === "number" ? event.button : -1,
      modifiers: primaryModifier(event),
      anchor: anchorFrom(event),
      isTrusted: !!event.isTrusted,
    }
    if (extra) {
      for (var k in extra) payload[k] = extra[k]
    }
    post("gesture", payload)
    return payload
  }
  window.addEventListener(
    "click",
    function (event) {
      if (!trusted(event)) return
      recordGesture("click", event)
    },
    true
  )
  window.addEventListener(
    "keydown",
    function (event) {
      if (!trusted(event)) return
      if (event.key !== "Enter" && event.key !== " ") return
      recordGesture("keydown", event, { key: event.key })
    },
    true
  )
  window.addEventListener(
    "auxclick",
    function (event) {
      if (!trusted(event)) return
      // Recorded only. Both engines already treat a middle-button auxclick
      // on an anchor as "open in a new tab" (WebKit's HTMLAnchorElement counts
      // it as a link click, WebView2 raises NewWindowRequested), so the
      // request reaches the host's new-window handler on its own; opening it
      // from here as well produced two tabs per middle-click.
      recordGesture("auxclick", event)
    },
    true
  )

  // ---- browser shortcuts -------------------------------------------------
  // ⌘F / Ctrl-F belongs to the browser, not to the page: while the webview
  // has keyboard focus the app's own DOM never sees the keystroke, so the
  // find bar could not be opened at all. This is the ONE place the helper
  // cancels an event — matching what every browser does with its own
  // shortcut. Propagation is left alone, so a page listener that wants to
  // know still hears it.
  window.addEventListener(
    "keydown",
    function (event) {
      if (!trusted(event)) return
      if (event.repeat) return
      var key = String(event.key || "").toLowerCase()
      if (key !== "f") return
      if (event.altKey) return
      // ⌘ on macOS, Ctrl elsewhere; the host is the one that knows which, so
      // report either and let it decide nothing — both are "find" here.
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      post("shortcut", { name: "find" })
    },
    true
  )

  // ---- console -----------------------------------------------------------
  // What the page prints, for an agent that has been given the page. WebKit
  // reports a page's console to nobody, so a shim in the PAGE world
  // (`console.js`) wraps `console.*` and dispatches each line on the document
  // as a `codeg:console` event whose detail is one JSON string — the one kind
  // of value that crosses a world boundary unchanged. This side reads the
  // string with this world's own JSON, adds the address it came from (which
  // the page cannot forge here) and forwards it. Uncaught exceptions,
  // unhandled rejections and failed resource loads are heard directly: those
  // events reach a listener in this world like `popstate` does.
  //
  // Where the engine does report the console to the host (WebView2, over
  // CDP), the host sets `__codegEngineConsole` before this script runs and
  // none of this is wired — or every line would arrive twice, once from the
  // engine and once from here.
  //
  // Everything below is page-controlled: the page can dispatch the event
  // itself, and a page in a logging loop could flood the channel, so lines
  // are budgeted per second and the overflow is counted rather than sent.
  var engineConsole = globalThis.__codegEngineConsole === true
  var parse = JSON.parse
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  var CONSOLE_BUDGET_PER_SECOND = 200
  var CONSOLE_MAX_TEXT = 4096
  var CONSOLE_MAX_URL = 1024
  var CONSOLE_MAX_HREF = 2048
  var consoleWindowStart = 0
  var consoleSent = 0
  var consoleDropped = 0
  var consoleFlushTimer = null
  function clip(value, limit) {
    if (typeof value !== "string" || value.length <= limit) return value
    var end = limit
    // Never cut between the halves of a surrogate pair: `JSON.stringify`
    // would emit an escape for half a character and the host's parser
    // refuses the whole message, so one emoji in the wrong place would cost
    // the line rather than one character of it.
    var last = value.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
    return value.slice(0, end) + "…"
  }
  function hereHref() {
    // Long enough to keep scheme, host and port whole for the origin the
    // host derives from it, short enough that a `data:` document's address
    // cannot carry the message past the channel's size cap.
    return clip(String(location.href), CONSOLE_MAX_HREF)
  }
  // Lines dropped over the budget are reported on the next line that goes
  // through — or, when nothing follows, by a flush a second later, so a
  // burst that ends in silence is not counted as a quiet page.
  function noteDropped() {
    consoleDropped += 1
    if (consoleFlushTimer === null)
      consoleFlushTimer = setTimeout(flushDropped, 1100)
  }
  function flushDropped() {
    consoleFlushTimer = null
    if (consoleDropped <= 0) return
    var n = consoleDropped
    consoleDropped = 0
    post("console", { dropped: n, href: hereHref() })
  }
  function forwardConsole(entry) {
    var t = now()
    if (t - consoleWindowStart >= 1000) {
      consoleWindowStart = t
      consoleSent = 0
    }
    if (consoleSent >= CONSOLE_BUDGET_PER_SECOND) {
      noteDropped()
      return
    }
    consoleSent += 1
    if (consoleDropped > 0) {
      entry.dropped = consoleDropped
      consoleDropped = 0
    }
    entry.href = hereHref()
    entry.text = clip(entry.text, CONSOLE_MAX_TEXT)
    if (entry.url !== undefined) entry.url = clip(entry.url, CONSOLE_MAX_URL)
    post("console", entry)
  }
  window.addEventListener("pagehide", flushDropped, true)
  // A property of a value from the page's world, read without running any
  // page code: a data property's value, or nothing. An accessor the page
  // installed is not invoked.
  function ownData(value, name) {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return undefined
    try {
      var d = getOwnPropertyDescriptor(value, name)
      return d && "value" in d ? d.value : undefined
    } catch {
      return undefined
    }
  }
  function describeThrown(value) {
    var t = typeof value
    if (t === "string") return value
    if (
      value === null ||
      t === "undefined" ||
      t === "number" ||
      t === "boolean"
    )
      return String(value)
    var message = ownData(value, "message")
    var name = ownData(value, "name")
    var head =
      typeof message === "string"
        ? (typeof name === "string" && name ? name : "Error") + ": " + message
        : ""
    var stack = ownData(value, "stack")
    if (typeof stack === "string" && stack) {
      // V8 begins a stack with the message line; JavaScriptCore's is frames
      // only, so the message goes in front of it.
      var lines = clip(stack, 8192).split("\n").slice(0, 8).join("\n")
      return head && lines.indexOf(head) !== 0 ? head + "\n" + lines : lines
    }
    return head || "[object]"
  }
  // Where the engine reports the console itself (WebView2), only the relay
  // and the two listeners it duplicates are left out. A resource that failed
  // to load is reported by no CDP console event, so that listener stays.
  if (!engineConsole) {
    document.addEventListener(
      "codeg:console",
      function (event) {
        var detail = event && event.detail
        if (typeof detail !== "string" || detail.length > 16384) return
        var parsed
        try {
          parsed = parse(detail)
        } catch {
          return
        }
        if (!parsed || typeof parsed !== "object") return
        var level = parsed.level
        if (
          level !== "log" &&
          level !== "info" &&
          level !== "warn" &&
          level !== "error" &&
          level !== "debug"
        )
          return
        forwardConsole({
          source: "console",
          level: level,
          text: typeof parsed.text === "string" ? parsed.text : "",
          ts: typeof parsed.ts === "number" ? parsed.ts : now(),
        })
      },
      true
    )
  }
  window.addEventListener(
    "error",
    function (event) {
      if (!event) return
      var target = event.target
      if (target && target !== window && typeof event.message !== "string") {
        // A resource that failed to load fires `error` on its element and
        // does not bubble, but the capture phase passes through here.
        var el = target
        var tag = String(el.tagName || el.nodeName || "").toLowerCase()
        if (!tag) return
        var src = ""
        try {
          src = String(el.currentSrc || el.src || el.href || "")
        } catch {
          src = ""
        }
        forwardConsole({
          source: "resource",
          level: "error",
          text:
            "Failed to load <" +
            tag +
            ">" +
            (src ? " " + clip(src, CONSOLE_MAX_URL) : ""),
          url: src || undefined,
          ts: now(),
        })
        return
      }
      // An uncaught exception: the engine reports these itself where it
      // reports the console at all.
      if (engineConsole) return
      if (typeof event.message !== "string") return
      var text = event.message
      var stack = ownData(event.error, "stack")
      if (typeof stack === "string" && stack) {
        var lines = clip(stack, 8192).split("\n").slice(0, 8).join("\n")
        if (lines.indexOf(text) < 0) text = text + "\n" + lines
        else text = lines
      }
      forwardConsole({
        source: "exception",
        level: "error",
        text: text,
        url: typeof event.filename === "string" ? event.filename : undefined,
        line: typeof event.lineno === "number" ? event.lineno : undefined,
        column: typeof event.colno === "number" ? event.colno : undefined,
        ts: now(),
      })
    },
    true
  )
  if (!engineConsole) {
    window.addEventListener(
      "unhandledrejection",
      function (event) {
        var reason
        try {
          reason = event ? event.reason : undefined
        } catch {
          reason = undefined
        }
        forwardConsole({
          source: "rejection",
          level: "error",
          text: "Unhandled promise rejection: " + describeThrown(reason),
          ts: now(),
        })
      },
      true
    )
  }

  post("hello", {
    href: String(location.href),
    readyState: String(document.readyState),
  })
  reportNav("start")
})()
