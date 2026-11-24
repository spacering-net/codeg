// Injected by the server-mode office preview proxy at the top of officecli's
// watch page, ahead of officecli's own scripts (see office_watch_proxy.rs for
// why). The proxy prefix and the capability below are filled in per request.
//
// 1. Routes the page's root-absolute requests back through the proxy, carrying
//    the watch's capability.
// 2. Lets go of the page's event stream while the app keeps the preview out
//    of sight, and takes it up again, catching up, when it is shown.
;(function () {
  const P = "__PFX__"
  const C = "__CAP__"
  function rw(u) {
    if (typeof u !== "string" || u.charAt(0) !== "/") return u
    if (u === P || u.indexOf(P + "/") === 0) return u
    return P + u + (u.indexOf("?") >= 0 ? "&" : "?") + "cap=" + C
  }
  const of = window.fetch
  if (of)
    window.fetch = function (i, init) {
      try {
        if (typeof i === "string") i = rw(i)
        else if (i && typeof i.url === "string") i = new Request(rw(i.url), i)
      } catch {}
      return of.call(this, i, init)
    }
  const xo = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (m, u) {
    try {
      arguments[1] = rw(u)
    } catch {}
    return xo.apply(this, arguments)
  }

  const OE = window.EventSource
  if (!OE || typeof EventTarget !== "function") return

  // The page's streams, and whether the app shows the page. Until it says
  // otherwise (it answers "ready"), the page is shown: a host that never says
  // anything gets the stream officecli opens, as before.
  const streams = []
  let shown = true
  // The newest document version the page is known to show: what the update
  // events it was sent say, and before any, the version the proxy read just
  // before fetching the page, which the page shows at least (-1: unknown). A
  // mark-update carries a version of its own (the marks'), not the document's.
  const loaded = Number("__VER__")
  let seen = Number.isFinite(loaded) ? loaded : -1
  function note(version) {
    if (typeof version === "number" && version > seen) seen = version
  }
  function status() {
    return of
      .call(window, rw("/api/status"), { cache: "no-store" })
      .then((r) => r.json())
  }

  // An event stream that can let go of its connection and take it up again
  // while the page keeps holding the one object: officecli keeps it in a
  // closure and in `window._watchEs`, listens on it, and dispatches on it.
  function held(url, init) {
    const target = new EventTarget()
    const kinds = new Set()
    let es = null
    let closed = false
    function relay(e) {
      if (e.type === "update") {
        try {
          const msg = JSON.parse(e.data)
          if (msg && msg.action !== "mark-update") note(msg.version)
        } catch {}
      }
      target.dispatchEvent(
        typeof e.data === "string"
          ? new MessageEvent(e.type, {
              data: e.data,
              lastEventId: e.lastEventId,
              origin: e.origin,
            })
          : new Event(e.type)
      )
    }
    // Back after letting go, at version `from`: if the document moved on
    // meanwhile, hand the page a full update, which officecli turns into a
    // diff of the document (Word) or a fresh body (Excel, PowerPoint), the
    // scroll kept either way. A document nothing changed in is left alone;
    // one whose version the watch won't tell is caught up anyway.
    function catchUp(from) {
      const full = (version) => {
        if (closed) return
        const msg =
          version === undefined
            ? { action: "full" }
            : { action: "full", version }
        target.dispatchEvent(
          new MessageEvent("update", { data: JSON.stringify(msg) })
        )
      }
      status().then(
        (s) => {
          if (!s || typeof s.version !== "number") return full()
          if (s.version <= from) return
          note(s.version)
          full(seen)
        },
        () => full()
      )
    }
    function connect(from) {
      if (es || closed) return
      const source = new OE(url, init)
      es = source
      kinds.forEach((kind) => source.addEventListener(kind, relay))
      if (from === undefined || !of) return
      // Asked once the stream is open: whatever changes after that arrives
      // as events, so nothing falls between the answer and the stream.
      source.addEventListener("open", function opened() {
        source.removeEventListener("open", opened)
        if (es === source) catchUp(from)
      })
    }
    function disconnect() {
      if (es) es.close()
      es = null
    }

    const add = target.addEventListener
    target.addEventListener = function (kind, listener, options) {
      if (!kinds.has(kind)) {
        kinds.add(kind)
        if (es) es.addEventListener(kind, relay)
      }
      return add.call(target, kind, listener, options)
    }
    ;["open", "message", "error"].forEach((kind) => {
      let handler = null
      Object.defineProperty(target, "on" + kind, {
        get: () => handler,
        set: (fn) => {
          if (handler) target.removeEventListener(kind, handler)
          handler = typeof fn === "function" ? fn : null
          if (handler) target.addEventListener(kind, handler)
        },
      })
    })
    Object.defineProperty(target, "readyState", {
      // Let go of, it is waiting to connect again, not closed.
      get: () => (es ? es.readyState : closed ? 2 : 0),
    })
    target.url = url
    target.withCredentials = !!(init && init.withCredentials)
    target.close = () => {
      closed = true
      disconnect()
    }

    streams.push({ pause: disconnect, resume: () => connect(seen) })
    if (shown) connect()
    return target
  }
  window.EventSource = function (url, init) {
    return held(rw(url), init)
  }
  window.EventSource.CONNECTING = 0
  window.EventSource.OPEN = 1
  window.EventSource.CLOSED = 2

  window.addEventListener("message", (e) => {
    const say =
      e.source === window.parent && e.data && e.data.codegOfficePreview
    if (say !== "shown" && say !== "hidden") return
    if ((say === "shown") === shown) return
    shown = say === "shown"
    streams.forEach((stream) => (shown ? stream.resume() : stream.pause()))
  })
  try {
    window.parent.postMessage({ codegOfficePreview: "ready" }, "*")
  } catch {}
})()
