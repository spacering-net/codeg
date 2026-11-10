// Built-in browser element picker. Injected by the Rust host into the
// ISOLATED world of one tab, ON DEMAND — when a person asks to point at
// something on the page and hand it to a conversation. Unlike `helper.js`
// this is not a document-start script: a page nobody picks on never pays for
// it, and it dies with the document, which is also how a navigation ends a
// pick nobody finished.
//
// While it is armed it draws a highlight over whatever the pointer is on and,
// on a click, reports that element to the host as one `pick` message. The
// press that chooses an element is swallowed in the capture phase, so
// choosing the page's "Delete" button does not also press it.
//
// The overlay is the one mark this leaves on the page: a fixed `div` with a
// CLOSED shadow root holding the highlight, so the page can see that a node
// exists but not read what is drawn in it. A plain `div` on
// purpose — a custom-element name the page has defined would be UPGRADED by
// its own constructor on `createElement`, and `ElementInternals.shadowRoot`
// hands a closed root to the element's own definition. There is no way to
// paint over a native webview from outside it — the host's own window is
// behind the page, not in front — so the overlay has to live in the document
// it describes.
//
// The overlay covers the WHOLE viewport and takes pointer events, and the
// element under the pointer is found by hit testing through it. That is what
// makes "choosing something does not press it" a property of the shape rather
// than a promise: the press is dispatched on the overlay, so the page's own
// element handlers never run, and events inside an `<iframe>` — which are
// dispatched in its window and never reach a listener here — cannot happen at
// all, because the pointer never reaches the frame.
//
// An earlier version covered only the frames, found by walking the page.
// Review took it apart four times over (ordering, budgets, shadow roots,
// `visibility: hidden`, ancestor clipping): any bounded enumeration can be
// filled with decoys by the page it is enumerating. Covering everything has
// no such surface.
//
// The cost is that the page does not scroll by itself while a pick is armed,
// so `wheel` is forwarded by hand to whatever the pointer is over.
//
// What is NOT closed, and cannot be from in here: a page that registered its
// own capture listener on `window` before this script was injected runs
// first, and may act on the press or stop it reaching this one. Nothing
// evaluated into a page after its scripts have run can get in front of them;
// closing it would need the press to be intercepted by the engine, which is
// where a browser's own inspector does it and where we have no hook. Since
// the press lands on the overlay, what such a listener sees is a press on an
// element that is not the page's own.
//
// Everything it reports is page-controlled and goes on to a model as DATA:
// every field is capped here and again in the host (`browser/handoff.rs`),
// and the host's renderer marks the whole thing as page content rather than
// instruction.
;(function codegBrowserPicker() {
  "use strict"
  if (typeof globalThis.__codegSend !== "function") return
  if (globalThis.__codegPicker) return

  var send = globalThis.__codegSend
  var stringify = JSON.stringify
  // Caps. The channel drops any message over 64 KiB, and what a page can put
  // in these fields is unbounded, so each is cut here — the host cuts them
  // again, because this side runs in a world a compromised page cannot reach
  // but a wrong number here would still cost a whole pick.
  var MAX_HTML = 4096
  var MAX_TEXT = 400
  var MAX_ATTRS = 24
  var MAX_ATTR_VALUE = 256
  var MAX_PATH = 8
  var MAX_NEARBY = 4
  var MAX_NEARBY_TEXT = 160
  var MAX_LABEL = 120
  var MAX_TAG = 64
  var MAX_SELECTOR = 512
  var MAX_HREF = 2048
  var MAX_TITLE = 300
  // Under the channel's 64 KiB, with room for the envelope. Every field above
  // is capped in CHARACTERS, and a character can cost six bytes once JSON has
  // escaped it, so the sum of the caps is not a bound on the message — this
  // is, measured on the bytes that actually go.
  var MAX_MESSAGE_BYTES = 60000
  // Reported for the element the person pointed at. Enough to say how it is
  // laid out and how it looks, and short enough to read.
  var STYLE_PROPS = [
    "display",
    "position",
    "width",
    "height",
    "padding",
    "margin",
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "border",
    "border-radius",
    "opacity",
    "z-index",
  ]

  var active = false
  // A pick ends on the FIRST click, and a person who double-clicks has
  // already sent the second one. For a moment after finishing, presses are
  // still swallowed and nothing is reported — otherwise the second half of a
  // double-click lands on the page and presses what was only being pointed
  // at.
  var DRAIN_MS = 700
  var draining = false
  var drainTimer = null
  var guardTimer = null
  var token = ""
  var host = null
  var root = null
  var box = null
  var tagLabel = null
  var current = null
  var frame = 0
  // How many consecutive checks have found the overlay is NOT what the
  // viewport hands a press to. One is not enough to act on — a page mid-layout
  // can lose a hit test for a frame — but a second means the press would go
  // somewhere this world cannot see, and a picker that stays armed then is
  // lying about what the next press does.
  var lostCoverage = 0
  // How many checks in a row found `inert` back on the host after the last one
  // took it off. Taking it off is not enough on its own: the repair and the
  // check happen in the same task, so the overlay always looks healthy by the
  // time it is examined, while a page re-applying the attribute from a
  // `MutationObserver` gets it back before the next press. Having to repair
  // the same thing twice running is the only visible trace of that race.
  var inertStrikes = 0

  function envelope(payload) {
    return stringify({ kind: "pick", payload: payload, top: true })
  }

  function byteLength(text) {
    try {
      return new TextEncoder().encode(text).length
    } catch {
      // No encoder: assume the worst a UTF-16 unit can cost once escaped.
      return text.length * 6
    }
  }

  // Report a pick, whatever the page put in it.
  //
  // A message over the channel's limit is dropped by the host, which would
  // leave the person waiting on a pick that was made — so the parts a page
  // can inflate are shed, largest first, until the message fits, and the
  // report says that it was cut. The last resort still names the element.
  function report(payload) {
    var message = envelope(payload)
    if (byteLength(message) <= MAX_MESSAGE_BYTES) return post(message)
    var shed = [
      "html",
      "styles",
      "attributes",
      "nearby",
      "text",
      "name",
      "path",
    ]
    for (var i = 0; i < shed.length; i++) {
      var key = shed[i]
      payload[key] = typeof payload[key] === "string" ? "" : []
      payload.trimmed = true
      message = envelope(payload)
      if (byteLength(message) <= MAX_MESSAGE_BYTES) return post(message)
    }
    post(
      envelope({
        id: token,
        href: clip(payload.href, 512),
        tag: payload.tag,
        label: payload.label,
        selector: "",
        rect: payload.rect,
        viewport: payload.viewport,
        trimmed: true,
      })
    )
  }

  function post(message) {
    try {
      send(message)
    } catch {
      /* the channel is best effort; never throw into page event dispatch */
    }
  }

  function clip(value, limit) {
    var text = typeof value === "string" ? value : ""
    if (text.length <= limit) return text
    var end = limit
    // Never cut between the halves of a surrogate pair. `JSON.stringify`
    // would emit an escape for half a character, and the host's parser
    // refuses the whole message — so one emoji in the wrong place would cost
    // the entire report rather than one character of it.
    var last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
    return text.slice(0, end) + "…"
  }

  function squash(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
  }

  function attr(element, name) {
    try {
      var value = element.getAttribute(name)
      return typeof value === "string" ? value : null
    } catch {
      return null
    }
  }

  function tagOf(element) {
    return String(element.tagName || element.nodeName || "").toLowerCase()
  }

  // `tag#id.a.b`, the way a person reads an element in DevTools. Classes are
  // capped so a utility-CSS page (thirty class names on a div) does not turn
  // every label into a paragraph.
  function describeShort(element) {
    var text = tagOf(element)
    // Squashed like every other string here: an `id` is the page's to write,
    // line breaks included, and this label is one line of the block.
    var id = squash(attr(element, "id"))
    if (id) text += "#" + id
    var classes = classListOf(element)
    for (var i = 0; i < classes.length && i < 3; i++) text += "." + classes[i]
    if (classes.length > 3) text += "…"
    return clip(text, MAX_LABEL)
  }

  function classListOf(element) {
    var raw = attr(element, "class")
    if (!raw) return []
    var out = []
    var parts = raw.split(/\s+/)
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i])
    }
    return out
  }

  // A selector that would find this element again: an id when the document
  // agrees it is unique, otherwise a path of tag + class + position, walked up
  // until it matches one element. Not guaranteed — a page can rebuild its DOM
  // between the pick and the agent reading it — so the host presents it as the
  // element's description, never as a promise.
  function selectorFor(element) {
    var id = attr(element, "id")
    if (id && cssUnique("#" + cssEscape(id))) return "#" + cssEscape(id)
    var parts = []
    var node = element
    var depth = 0
    while (node && node.nodeType === 1 && depth < MAX_PATH) {
      var part = tagOf(node)
      var ownId = attr(node, "id")
      if (ownId) {
        parts.unshift("#" + cssEscape(ownId))
        break
      }
      var classes = classListOf(node)
      for (var i = 0; i < classes.length && i < 2; i++) {
        part += "." + cssEscape(classes[i])
      }
      var index = positionAmongSiblings(node)
      if (index > 0) part += ":nth-of-type(" + (index + 1) + ")"
      parts.unshift(part)
      var candidate = parts.join(" > ")
      if (cssUnique(candidate)) return candidate
      node = node.parentElement
      depth += 1
    }
    return parts.join(" > ")
  }

  function positionAmongSiblings(element) {
    var parent = element.parentElement
    if (!parent) return 0
    var tag = tagOf(element)
    var index = 0
    var children = parent.children
    for (var i = 0; i < children.length; i++) {
      var child = children[i]
      if (child === element) return index
      if (tagOf(child) === tag) index += 1
    }
    return index
  }

  function cssUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1
    } catch {
      return false
    }
  }

  function cssEscape(value) {
    var text = String(value)
    try {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(text)
      }
    } catch {
      /* fall through to the conservative form below */
    }
    return text.replace(/[^\w-]/g, "\\$&")
  }

  function pathOf(element) {
    var parts = []
    var node = element
    while (node && node.nodeType === 1 && parts.length < MAX_PATH) {
      parts.unshift(describeShort(node))
      node = node.parentElement
    }
    return parts
  }

  // What a screen reader would call this, by the cheap rules: an explicit
  // label wins, then the usual per-element attributes, then the text. Not an
  // accessible-name computation — the host says as much when it renders it.
  function accessibleName(element) {
    var label = attr(element, "aria-label")
    if (label) return clip(squash(label), MAX_TEXT)
    var labelledBy = attr(element, "aria-labelledby")
    if (labelledBy) {
      var names = []
      var ids = labelledBy.split(/\s+/)
      for (var i = 0; i < ids.length && i < 4; i++) {
        if (!ids[i]) continue
        var target = null
        try {
          target = document.getElementById(ids[i])
        } catch {
          target = null
        }
        if (target) names.push(squash(target.textContent))
      }
      var joined = squash(names.join(" "))
      if (joined) return clip(joined, MAX_TEXT)
    }
    var candidates = ["alt", "title", "placeholder", "value", "name"]
    for (var j = 0; j < candidates.length; j++) {
      var value = attr(element, candidates[j])
      if (value) return clip(squash(value), MAX_TEXT)
    }
    return clip(squash(element.textContent), MAX_TEXT)
  }

  function attributesOf(element) {
    var out = []
    var list
    try {
      list = element.attributes
    } catch {
      return out
    }
    if (!list) return out
    for (var i = 0; i < list.length && out.length < MAX_ATTRS; i++) {
      var item = list[i]
      if (!item) continue
      var name = String(item.name || "")
      if (!name) continue
      out.push({
        name: clip(name, 64),
        value: clip(squash(item.value), MAX_ATTR_VALUE),
      })
    }
    return out
  }

  function stylesOf(element) {
    var out = []
    var computed
    try {
      computed = window.getComputedStyle(element)
    } catch {
      return out
    }
    if (!computed) return out
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      var name = STYLE_PROPS[i]
      var value = ""
      try {
        value = String(computed.getPropertyValue(name) || "")
      } catch {
        value = ""
      }
      if (value) out.push({ name: name, value: clip(value, 120) })
    }
    return out
  }

  // The text immediately around the element, which is often what a person
  // means by "this one" — the previous and next siblings, and the heading
  // above it.
  function nearbyText(element) {
    var out = []
    var push = function (value) {
      var text = clip(squash(value), MAX_NEARBY_TEXT)
      if (text && out.length < MAX_NEARBY) out.push(text)
    }
    try {
      var previous = element.previousElementSibling
      if (previous) push(previous.textContent)
      var next = element.nextElementSibling
      if (next) push(next.textContent)
      var heading = null
      var node = element
      while (node && !heading) {
        var scan = node.previousElementSibling
        while (scan && !heading) {
          if (/^h[1-6]$/.test(tagOf(scan))) heading = scan
          scan = scan.previousElementSibling
        }
        node = node.parentElement
      }
      if (heading) push(heading.textContent)
    } catch {
      /* a page that throws from a DOM getter simply gets fewer hints */
    }
    return out
  }

  function rectOf(element) {
    var rect
    try {
      rect = element.getBoundingClientRect()
    } catch {
      return null
    }
    if (!rect) return null
    var width = Math.max(
      0,
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
    )
    var height = Math.max(
      0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    )
    return {
      x: Math.max(rect.left, 0),
      y: Math.max(rect.top, 0),
      width: width,
      height: height,
    }
  }

  function describe(element) {
    var html = ""
    try {
      html = String(element.outerHTML || "")
    } catch {
      html = ""
    }
    return {
      id: token,
      href: clip(String(location.href), MAX_HREF),
      title: clip(String(document.title || ""), MAX_TITLE),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      rect: rectOf(element),
      // A tag name is the page's to choose (a custom element can be named
      // anything) and a `role` is a raw attribute; neither is short by nature.
      tag: clip(tagOf(element), MAX_TAG),
      label: describeShort(element),
      selector: clip(selectorFor(element), MAX_SELECTOR),
      path: pathOf(element),
      role: clip(attr(element, "role") || "", MAX_TAG),
      name: accessibleName(element),
      text: clip(squash(element.textContent), MAX_TEXT),
      html: clip(html, MAX_HTML),
      attributes: attributesOf(element),
      styles: stylesOf(element),
      nearby: nearbyText(element),
    }
  }

  // ---- overlay -------------------------------------------------------------

  // `!important` throughout: the host is a node in the page's DOM, so page CSS
  // can match it (`html > div`), and a rule that hid it or made it hit-testable
  // would change what a press means. Re-asserted on every paint.
  var HOST_STYLE =
    "all: initial !important; position: fixed !important; left: 0 !important;" +
    "top: 0 !important; right: 0 !important; bottom: 0 !important;" +
    "width: auto !important; height: auto !important;" +
    "margin: 0 !important; padding: 0 !important; border: 0 !important;" +
    "display: block !important; visibility: visible !important;" +
    "opacity: 1 !important; pointer-events: auto !important;" +
    "z-index: 2147483647 !important;"

  // What the host's style should be, corrections included. Starts as
  // `HOST_STYLE` and is re-read after `fitOverlay` adjusts it, so the tamper
  // check compares against what we last wrote rather than against the ideal.
  var baseStyle = HOST_STYLE

  function ensureOverlay() {
    if (host && host.isConnected) {
      if (host.getAttribute("style") !== baseStyle)
        host.style.cssText = baseStyle
      // The attributes are re-asserted for the same reason the style is: the
      // host is in the page's DOM and the page can strip them. Without
      // `popover` the overlay cannot join the top layer, and without
      // `tabindex` it cannot hold the keyboard.
      //
      // `inert` is the dangerous one, and it is ADDED rather than removed: an
      // inert overlay is handed no press at all, while staying connected,
      // styled, the right size, and — measured, not assumed — still the answer
      // `elementFromPoint` gives for every point it covers. So the press
      // reaches the page and `owns()` sees nothing wrong, which is the one
      // combination that lets a pick look like it worked while the page's own
      // button was pressed.
      try {
        if (host.getAttribute("popover") !== "manual")
          host.setAttribute("popover", "manual")
        if (host.getAttribute("tabindex") !== "-1")
          host.setAttribute("tabindex", "-1")
        if (host.hasAttribute("inert")) {
          host.removeAttribute("inert")
          inertStrikes++
        } else {
          inertStrikes = 0
        }
      } catch {
        /* nothing else to do */
      }
      // Where it lives, and last among its siblings. The z-index is already
      // the maximum, so what decides between two elements that both claim it
      // is tree order — a page that appends its own element after ours would
      // paint over the overlay and take the press, which for an `<iframe>`
      // means the press lands inside it.
      //
      // The parent is checked too, not just the position, because being
      // connected says nothing about being visible: a page can MOVE the host
      // into a `display: none` wrapper, or into a zero-sized
      // `overflow: hidden` one, and it is then still connected and still the
      // only child, so both of the old checks passed while the overlay
      // covered nothing. `fitOverlay` cannot see that either — a rect
      // describes layout, and clipping is not layout.
      var anchor = document.documentElement || document.body
      if (
        anchor &&
        (host.parentNode !== anchor || anchor.lastElementChild !== host)
      ) {
        anchor.appendChild(host)
      }
      enterTopLayer(false)
      fitOverlay()
      return true
    }
    try {
      // A `div`, never a custom-element name: `document.createElement` upgrades
      // a name the page has defined, running the page's constructor on our
      // node — and an element whose definition called `attachInternals()` can
      // read its own CLOSED shadow root through `ElementInternals.shadowRoot`.
      baseStyle = HOST_STYLE
      host = document.createElement("div")
      // Named so a person (or a harness) looking at a page with the highlight
      // stuck on can see what it is. Not a secret: the node is in the page's
      // DOM either way, and what keeps it honest is the inline `!important`
      // above, not being hard to find.
      host.setAttribute("data-codeg-picker", "")
      // A manual popover so the overlay can join the top layer, which is
      // painted above every ordinary child of the document no matter what
      // z-index they claim. Without it a page needs only to open a popover of
      // its own to paint over the overlay. `manual` because an `auto` popover
      // would close the page's. Engines without the top layer ignore the
      // attribute and keep the ordinary overlay, which is what this was.
      host.setAttribute("popover", "manual")
      // Focusable, so `start` can take the keyboard off a child frame. Not
      // reachable by Tab.
      host.setAttribute("tabindex", "-1")
      host.style.cssText = baseStyle
      root = host.attachShadow({ mode: "closed" })
      var style = document.createElement("style")
      style.textContent =
        ".box{position:fixed;box-sizing:border-box;pointer-events:none;" +
        "border:1px solid rgba(139,92,246,.95);background:rgba(139,92,246,.16);border-radius:2px}" +
        ".tag{position:fixed;pointer-events:none;max-width:60vw;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;border-radius:3px;padding:1px 6px;" +
        "background:rgb(109,40,217);color:#fff;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}"
      box = document.createElement("div")
      box.className = "box"
      tagLabel = document.createElement("div")
      tagLabel.className = "tag"
      root.appendChild(style)
      root.appendChild(box)
      root.appendChild(tagLabel)
      var anchor = document.documentElement || document.body
      if (!anchor) return false
      anchor.appendChild(host)
      if (!active) hideHighlight()
      enterTopLayer(false)
      return true
    } catch {
      host = null
      root = null
      return false
    }
  }

  /**
   * Put the overlay in the top layer, which is painted above every ordinary
   * child of the document — a modal `<dialog>` or an open popover is up there,
   * and `z-index: 2147483647` does not reach it.
   *
   * `force` re-enters: within the top layer the order is the order elements
   * joined it, so a page that opens a popover after us paints over us until we
   * leave and come back.
   *
   * This does not beat `showModal()`. A modal dialog makes everything outside
   * it inert, popovers included, and an inert overlay is handed nothing. That
   * case is caught by `owns()` instead, and the pick ends rather than pretend.
   */
  function enterTopLayer(force) {
    if (!host || typeof host.showPopover !== "function") return
    try {
      var open = false
      try {
        open = host.matches(":popover-open")
      } catch {
        open = false
      }
      if (open) {
        if (!force) return
        try {
          host.hidePopover()
        } catch {
          return
        }
      }
      host.showPopover()
    } catch {
      /* an engine without the top layer keeps the ordinary overlay */
    }
  }

  /**
   * Is the overlay what a press would actually land on?
   *
   * Everything else here reasons about the overlay — its style, its parent,
   * its rect — and a page has repeatedly found a way to make all three look
   * right while the press went somewhere else. This asks the question the
   * press asks, at the corners and the middle of the viewport, and is the one
   * check that does not have to anticipate the mechanism.
   */
  function owns() {
    if (!host) return false
    var width = 0
    var height = 0
    try {
      var doc = document.documentElement
      width = (doc && doc.clientWidth) || window.innerWidth || 0
      height = (doc && doc.clientHeight) || window.innerHeight || 0
    } catch {
      return false
    }
    // Nothing worth covering, and nothing a press could reach either.
    if (width < 8 || height < 8) return true
    var points = [
      [width / 2, height / 2],
      [3, 3],
      [width - 3, 3],
      [3, height - 3],
      [width - 3, height - 3],
    ]
    for (var i = 0; i < points.length; i++) {
      var at = null
      try {
        at = document.elementFromPoint(points[i][0], points[i][1])
      } catch {
        return false
      }
      if (at !== host) return false
    }
    // Last, the thing hit testing cannot answer: being inert. An inert overlay
    // is handed no press at all, yet stays connected, styled, the right size
    // and — measured, not assumed — still what `elementFromPoint` names at
    // every point it covers. `:inert` would say so directly but is not in
    // every engine (Chrome: `CSS.supports("selector(:inert)")` is false and
    // `matches` throws), so ask the question inertness actually answers: an
    // inert element cannot take focus. The picker wants the focus anyway while
    // it is armed, so asking costs nothing it was not already doing.
    try {
      if (document.activeElement !== host) host.focus({ preventScroll: true })
      if (document.activeElement !== host) return false
    } catch {
      /* an engine that refused the call has told us nothing either way */
    }
    return true
  }

  /**
   * Called when a check found the overlay is not what the viewport would hand
   * a press to. Tries to take the top layer back, and gives up on the pick if
   * that was not it — the press cannot be stopped from here, so the honest
   * thing is to stop claiming a pick is armed.
   */
  function coverageLost() {
    if (!active) return
    enterTopLayer(true)
    if (owns()) {
      lostCoverage = 0
      return
    }
    lostCoverage++
    if (lostCoverage < 2) return
    finish({ id: token, cancelled: true })
  }

  function hideHighlight() {
    try {
      if (box) box.style.display = "none"
      if (tagLabel) tagLabel.style.display = "none"
    } catch {
      /* nothing else to do */
    }
  }

  function stopGuard() {
    if (guardTimer === null) return
    try {
      clearInterval(guardTimer)
    } catch {
      /* nothing else to do */
    }
    guardTimer = null
  }

  /**
   * The dead-man switch. Runs whether or not the pointer moves, because the
   * ways a page takes the overlay away — `pointer-events: none` on it, moving
   * it, opening something in the top layer — also take away the events that
   * would otherwise be the chance to notice.
   */
  function guardTick() {
    if (!active && !draining) return
    ensureOverlay()
    // Re-enter the top layer every tick, whether or not anything looks wrong.
    // Order in there is order of entry, and the only other defence — `owns()`
    // — samples five points: a SMALL popover the page opens after us can sit
    // above the overlay and miss every one of them, which is the same lesson
    // as the frame walk, one layer up. Any bounded set of samples can be
    // stepped between. Being the last to enter does not depend on where the
    // other thing is.
    enterTopLayer(true)
    // Repairing `inert` twice running means the page is putting it back
    // between ticks, so the press in between was handed to the page and not to
    // the overlay. Nothing in this world can win that race — an inert element
    // is given no events at all — so end the pick rather than keep drawing a
    // highlight over a page that is quietly taking the clicks.
    if (active && inertStrikes >= 2) {
      finish({ id: token, cancelled: true })
      return
    }
    // The keyboard belongs to the picker while it is armed, and a key event
    // dispatched inside a child frame never reaches this window: if focus has
    // gone in there, Enter presses whatever that frame has focused, with no
    // event here to cancel.
    if (active && host) {
      try {
        var at = document.activeElement
        if (at && at !== host && at.tagName === "IFRAME") {
          host.focus({ preventScroll: true })
        }
      } catch {
        /* a page that refuses focus keeps it */
      }
    }
    if (!active) return
    if (owns()) {
      lostCoverage = 0
      return
    }
    coverageLost()
  }

  /**
   * What is under a point, with the overlay taken out of the way.
   *
   * The overlay covers the viewport and takes the pointer events, so the
   * event itself never names a page element — this is how the page element is
   * found. Over an `<iframe>` it answers with the frame, which is the only
   * thing this side can honestly describe about one.
   */
  function under(x, y) {
    if (host) host.style.setProperty("pointer-events", "none", "important")
    var node = null
    try {
      node = document.elementFromPoint(x, y)
      // `elementFromPoint` stops at a shadow boundary and answers with the
      // host, so descend the same way an occlusion check does — otherwise a
      // page built out of web components reports one outer element for
      // everything in it.
      // Deep enough that no page nests this far by design. Stopping early is
      // safe rather than wrong — the answer is then a host that really is
      // above the pointer, just less specific than it could be — but 32 was
      // shallow enough to reach by accident in a component tree.
      for (var depth = 0; node && depth < 128; depth++) {
        var shadow = node.shadowRoot
        if (!shadow) break
        var inner = shadow.elementFromPoint(x, y)
        if (!inner || inner === node) break
        node = inner
      }
    } catch {
      node = null
    }
    if (host) host.style.setProperty("pointer-events", "auto", "important")
    return node
  }

  /**
   * Put the overlay back over the viewport, whatever the page has done to the
   * coordinate space it lives in.
   *
   * `position: fixed` means "relative to the viewport" only while no ancestor
   * has a transform, a filter or a perspective — with one, it means relative
   * to THAT, and a page with `transform: translate(200px, 100px)` on its root
   * element would slide the overlay off and leave a strip of the viewport
   * uncovered, where a press would reach the page. Measured rather than
   * reasoned about: where the box actually landed says how far to push it
   * back, and its rendered width over its layout width says at what scale.
   */
  function fitOverlay() {
    if (!host) return
    var rect
    try {
      rect = host.getBoundingClientRect()
    } catch {
      return
    }
    if (!rect) return
    var width = window.innerWidth
    var height = window.innerHeight
    if (
      Math.abs(rect.left) < 0.5 &&
      Math.abs(rect.top) < 0.5 &&
      Math.abs(rect.width - width) < 1 &&
      Math.abs(rect.height - height) < 1
    ) {
      return
    }
    var scaleX = host.offsetWidth > 0 ? rect.width / host.offsetWidth : 1
    var scaleY = host.offsetHeight > 0 ? rect.height / host.offsetHeight : 1
    if (!isFinite(scaleX) || scaleX <= 0) scaleX = 1
    if (!isFinite(scaleY) || scaleY <= 0) scaleY = 1
    var left = parseFloat(host.style.left) || 0
    var top = parseFloat(host.style.top) || 0
    var fix = function (name, value) {
      host.style.setProperty(name, value, "important")
    }
    fix("right", "auto")
    fix("bottom", "auto")
    fix("left", left - rect.left / scaleX + "px")
    fix("top", top - rect.top / scaleY + "px")
    fix("width", width / scaleX + "px")
    fix("height", height / scaleY + "px")
    // Whatever it now says is the base: the style check above must not read
    // this correction as the page having tampered with it.
    baseStyle = host.getAttribute("style") || baseStyle
  }

  function paint() {
    frame = 0
    if (!active) return
    if (!ensureOverlay()) return
    // One hit test a frame, at the middle of the viewport: the full check
    // belongs to the guard, but a pointer that is moving should not have to
    // wait up to 400 ms to find out the press it is about to make would go to
    // the page.
    var covered = true
    try {
      covered =
        document.elementFromPoint(
          (document.documentElement.clientWidth || window.innerWidth) / 2,
          (document.documentElement.clientHeight || window.innerHeight) / 2
        ) === host
    } catch {
      covered = true
    }
    if (!covered) {
      coverageLost()
      if (!active) return
    }
    if (!current) return
    var rect
    try {
      rect = current.getBoundingClientRect()
    } catch {
      return
    }
    if (!rect) return
    box.style.display = "block"
    tagLabel.style.display = "block"
    box.style.left = rect.left + "px"
    box.style.top = rect.top + "px"
    box.style.width = Math.max(rect.width, 1) + "px"
    box.style.height = Math.max(rect.height, 1) + "px"
    tagLabel.textContent =
      describeShort(current) +
      "  " +
      Math.round(rect.width) +
      "×" +
      Math.round(rect.height)
    // Above the box when there is room for it, otherwise just inside the top.
    var above = rect.top >= 20
    tagLabel.style.left =
      Math.max(0, Math.min(rect.left, window.innerWidth - 40)) + "px"
    tagLabel.style.top =
      (above ? rect.top - 19 : Math.max(rect.top + 2, 2)) + "px"
  }

  function schedulePaint() {
    if (frame) return
    try {
      frame = requestAnimationFrame(paint)
    } catch {
      frame = 0
      paint()
    }
  }

  function removeOverlay() {
    try {
      if (host && host.parentNode) host.parentNode.removeChild(host)
    } catch {
      /* the page may have moved it; nothing else to do */
    }
    host = null
    root = null
    box = null
    tagLabel = null
  }

  // ---- events --------------------------------------------------------------

  // Only real input chooses. A page that dispatched its own click while a
  // pick is armed would otherwise decide WHICH of its elements gets handed to
  // a conversation — the person armed the pick, so something is going to be
  // sent, and the page must not be the one choosing what. Same rule and same
  // escape hatch as `helper.js`: the flag lives in this world, which page
  // scripts cannot reach, and only the host's own harness sets it.
  function trusted(event) {
    return !!event.isTrusted || globalThis.__codegAcceptUntrusted === true
  }

  /**
   * The element the pointer is over — asked of the document, never taken from
   * the event.
   *
   * The overlay takes the events, so an event's own target is the host and
   * says nothing. Asking is also the only answer that survives a page that
   * called `setPointerCapture` before the pick started: every pointer event
   * then names the element it captured to, wherever the pointer actually is,
   * and a picker that believed the event would report that element for every
   * press.
   */
  function targetOf(event) {
    var node = null
    if (event.isTrusted) {
      node = under(event.clientX, event.clientY)
    } else {
      // Only the host's own harness gets an untrusted event this far (see
      // `trusted`), and a synthetic `el.click()` carries no coordinates —
      // hit testing one would answer with whatever is at the origin. Such an
      // event is taken at its word instead.
      try {
        var path =
          typeof event.composedPath === "function" ? event.composedPath() : null
        node = path && path.length ? path[0] : event.target
      } catch {
        node = event.target
      }
    }
    while (node && node.nodeType !== 1) node = node.parentNode
    if (!node || ours(node)) return null
    return node
  }

  function ours(node) {
    if (!node || !host) return false
    return node === host || (host.contains && host.contains(node))
  }

  function onMove(event) {
    if (!active || !trusted(event)) return
    var element = targetOf(event)
    if (!element || element === current) return
    current = element
    schedulePaint()
  }

  function onScroll() {
    if (!active) return
    schedulePaint()
  }

  // The overlay takes the pointer events, so the page would not scroll at all
  // while a pick is armed — and a person cannot always see the thing they
  // want before they scroll to it. Hand the scroll to whatever is under the
  // pointer: its nearest scrollable ancestor, or the page.
  function onWheel(event) {
    if (!active || !trusted(event)) return
    try {
      event.preventDefault()
      event.stopImmediatePropagation()
    } catch {
      /* nothing to do if the engine refuses */
    }
    var step = 1
    if (event.deltaMode === 1) step = 16
    else if (event.deltaMode === 2) step = window.innerHeight
    var dx = (event.deltaX || 0) * step
    var dy = (event.deltaY || 0) * step
    var target = scrollableFrom(under(event.clientX, event.clientY))
    try {
      if (target) target.scrollBy(dx, dy)
      else window.scrollBy(dx, dy)
    } catch {
      /* a page that refuses to scroll simply does not */
    }
    schedulePaint()
  }

  /** The nearest ancestor of `node` that actually scrolls, or null. */
  function scrollableFrom(node) {
    for (var depth = 0; node && node.nodeType === 1 && depth < 32; depth++) {
      var style = null
      try {
        style = window.getComputedStyle(node)
      } catch {
        style = null
      }
      if (style) {
        var down = style.overflowY
        var across = style.overflowX
        var scrolls =
          (node.scrollHeight > node.clientHeight &&
            (down === "auto" || down === "scroll")) ||
          (node.scrollWidth > node.clientWidth &&
            (across === "auto" || across === "scroll"))
        if (scrolls) return node
      }
      var parent = node.parentElement
      if (!parent) {
        var root = null
        try {
          root = node.getRootNode ? node.getRootNode() : null
        } catch {
          root = null
        }
        parent = root && root.host ? root.host : null
      }
      node = parent
    }
    return null
  }

  // Every button press while armed belongs to the picker, not to the page.
  // Cancelled AND cut short in the capture phase: a page listener downstream
  // of this one never runs, so choosing a link does not follow it and
  // choosing a button does not press it.
  function swallow(event) {
    if (!(active || draining) || !trusted(event)) return
    try {
      event.preventDefault()
      event.stopImmediatePropagation()
    } catch {
      /* nothing to do if the engine refuses */
    }
  }

  function onPress(event) {
    if (draining) return swallow(event)
    if (!active || !trusted(event)) return
    var element = targetOf(event)
    if (element) {
      current = element
      schedulePaint()
    }
    swallow(event)
  }

  function onClick(event) {
    if (draining) return swallow(event)
    if (!active || !trusted(event)) return
    swallow(event)
    // Whatever the press landed on, and nothing else. Deliberately NOT the
    // last element the pointer hovered: a page that makes the overlay
    // hit-testable could then have a press over one element report a
    // different one, which is the one thing a picker must never do.
    var element = targetOf(event)
    finish(element ? describe(element) : { id: token, cancelled: true }, true)
  }

  // Every key belongs to the picker while it is armed. Escape ends it; the
  // rest are eaten, because a keystroke that reaches the page can act on it
  // — Enter in a text field submits its form with no click for the picker to
  // cancel, and a page's own key handler runs whether or not anything is
  // activated. Modified keys are left alone: ⌘R and ⌘F belong to the app, not
  // to the page.
  function onKey(event) {
    if (!active || !trusted(event)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    var key = String(event.key || "")
    var escape = key === "Escape" || key === "Esc"
    swallow(event)
    if (escape && event.type === "keydown") {
      finish({ id: token, cancelled: true })
    }
  }

  // A tap is a press too. `touchstart` is cancelled so the page's own touch
  // handler cannot act on it — which also suppresses the compatibility click
  // the engine would otherwise synthesise, so the pick is made from
  // `touchend` instead, at the point the finger left. Cancelling the start
  // also ends touch scrolling for that gesture: while a pick is armed a
  // touchscreen cannot scroll, and Escape is the way out.
  function onTouchEnd(event) {
    if (draining) return swallow(event)
    if (!active || !trusted(event)) return
    swallow(event)
    var touch = null
    try {
      touch =
        event.changedTouches && event.changedTouches.length
          ? event.changedTouches[0]
          : null
    } catch {
      touch = null
    }
    if (!touch) {
      finish({ id: token, cancelled: true }, true)
      return
    }
    var element = under(touch.clientX, touch.clientY)
    while (element && element.nodeType !== 1) element = element.parentNode
    if (!element || ours(element)) {
      finish({ id: token, cancelled: true }, true)
      return
    }
    finish(describe(element), true)
  }

  var LISTENERS = [
    ["pointermove", onMove],
    ["pointerover", onMove],
    ["pointerdown", onPress],
    ["mousedown", onPress],
    ["pointerup", swallow],
    ["mouseup", swallow],
    ["auxclick", swallow],
    ["contextmenu", swallow],
    ["click", onClick],
    ["keydown", onKey],
    ["keypress", onKey],
    ["keyup", onKey],
  ]

  // `wheel` and the touch events are listened for separately: engines make
  // them passive by default on the window, and a passive listener may not
  // cancel — which for these is the whole point.
  var ACTIVE_OPTIONS = { capture: true, passive: false }
  var ACTIVE_LISTENERS = [
    ["wheel", onWheel],
    ["touchstart", swallow],
    ["touchend", onTouchEnd],
    ["touchcancel", swallow],
  ]

  function bind(on) {
    for (var i = 0; i < LISTENERS.length; i++) {
      var name = LISTENERS[i][0]
      var handler = LISTENERS[i][1]
      if (on) window.addEventListener(name, handler, true)
      else window.removeEventListener(name, handler, true)
    }
    for (var k = 0; k < ACTIVE_LISTENERS.length; k++) {
      var active_name = ACTIVE_LISTENERS[k][0]
      var active_handler = ACTIVE_LISTENERS[k][1]
      if (on)
        window.addEventListener(active_name, active_handler, ACTIVE_OPTIONS)
      else
        window.removeEventListener(active_name, active_handler, ACTIVE_OPTIONS)
    }
    if (on) {
      window.addEventListener("scroll", onScroll, true)
      window.addEventListener("resize", onScroll, true)
      window.addEventListener("pagehide", onPageHide, true)
    } else {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll, true)
      window.removeEventListener("pagehide", onPageHide, true)
    }
  }

  function onPageHide(event) {
    if (!active || !trusted(event)) return
    // A page can dispatch its own `pagehide`, and this was the one handler
    // here that took an event at its word. Ending the pick takes the overlay
    // down, so the press the person was lining up lands on the page — the
    // same outcome as every other way a page has tried to get the overlay out
    // of the way, reached by simply asking for it.
    finish({ id: token, cancelled: true })
  }

  // `drain` says a gesture is still in flight and its remainder must not land
  // on the page. True for a press or a tap — the second half of a double-click
  // is already on its way. False for everything else: Escape, the page going
  // away, or the overlay having lost the viewport. Nothing is coming after
  // those, and an overlay that lingered would eat the person's next click.
  function finish(payload, drain) {
    teardown(drain === true)
    report(payload)
  }

  /** Put the picker away. `drain` keeps swallowing presses for a moment. */
  function teardown(drain) {
    if (drainTimer !== null) {
      try {
        clearTimeout(drainTimer)
      } catch {
        /* nothing else to do */
      }
      drainTimer = null
    }
    if (!active) {
      // Not armed, but possibly still draining a gesture from the last pick.
      if (draining && !drain) {
        draining = false
        stopGuard()
        removeOverlay()
        bind(false)
      }
      return
    }
    active = false
    current = null
    lostCoverage = 0
    inertStrikes = 0
    if (frame) {
      try {
        cancelAnimationFrame(frame)
      } catch {
        /* the frame will simply run and find nothing to do */
      }
      frame = 0
    }
    if (!drain) {
      stopGuard()
      removeOverlay()
      draining = false
      bind(false)
      return
    }
    // The overlay stays up for the drain, without its highlight. Listeners on
    // this window are not enough to swallow the second half of a double-click:
    // if the first press picked an `<iframe>`, the second one is dispatched
    // inside that frame and is never seen here. The only thing that can be in
    // its way is the overlay itself — so it stays, and the guard keeps
    // re-asserting it, until the drain is over.
    draining = true
    hideHighlight()
    var done = function () {
      drainTimer = null
      draining = false
      stopGuard()
      removeOverlay()
      bind(false)
    }
    try {
      drainTimer = setTimeout(done, DRAIN_MS)
    } catch {
      done()
    }
  }

  globalThis.__codegPicker = {
    // Arm the picker for one element. A second call replaces the first: the
    // host only ever waits for the pick it asked for last, and an id it does
    // not recognise is dropped there.
    start: function (id) {
      teardown(false)
      token = String(id || "")
      active = true
      lostCoverage = 0
      inertStrikes = 0
      ensureOverlay()
      // Take the keyboard. Focus may be sitting in a child frame — the page
      // can put it there — and key events raised in one never reach this
      // window, so Enter would press whatever that frame has focused with no
      // event here to cancel.
      if (host) {
        try {
          host.focus({ preventScroll: true })
        } catch {
          try {
            host.focus()
          } catch {
            /* a page that refuses focus keeps it */
          }
        }
      }
      // A dead-man switch for the overlay itself. The paint path re-asserts
      // its style on every pointer event — but a page that sets
      // `pointer-events: none` on it takes those events back, and with them
      // the chance to notice. This does not depend on the pointer.
      try {
        guardTimer = setInterval(guardTick, 400)
      } catch {
        guardTimer = null
      }
      bind(true)
      return "started"
    },
    // Put it away without reporting anything — the host asked, or the person
    // pressed the button again.
    //
    // `id` names the pick the caller meant. Telling the page to stop is a
    // round trip, and by the time it lands another pick may have armed: a
    // stop that named the earlier one must leave that alone. No id means
    // "whatever is there", which is what the host says when it knows nothing
    // is waiting on this tab.
    stop: function (id) {
      if (id !== undefined && id !== null && active && String(id) !== token) {
        return "other"
      }
      teardown(false)
      return "stopped"
    },
  }
})()
