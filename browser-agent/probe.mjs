/**
 * Drives the committed bundle in a real engine and prints what it produces.
 *
 *     pnpm browser:agent:probe
 *
 * The unit tests cover the part of `src/index.ts` that is pure. They cannot
 * cover the tree: jsdom reports every element as zero-sized, and `ai` mode
 * only names elements that are visible and receive pointer events, so under
 * jsdom the tree comes back with no refs and proves nothing. This asks a
 * browser instead.
 *
 * Chrome, because it is the one engine present on all three of our
 * development machines and it speaks CDP without a driver. It is not the
 * engine any platform actually ships — WKWebView, WebView2 and WebKitGTK are —
 * so a green run here says the bundle is sound, not that it is verified on a
 * platform. Manual, not part of `pnpm test`: it needs a browser on the box.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLE = readFileSync(
  resolve(root, "src-tauri/src/browser/js/agent.bundle.js"),
  "utf8"
)
// The page-world console shim, injected by the host into the PAGE world on
// the WebKit ports. Not part of the bundle; the probe measures the channel
// between it and this world.
const CONSOLE_SHIM = readFileSync(
  resolve(root, "src/browser-injected/console.js"),
  "utf8"
)
// The element picker, which the host evaluates into the isolated world on
// demand when a person asks to hand an element to a conversation. Also not
// part of the bundle.
const PICKER = readFileSync(
  resolve(root, "src/browser-injected/picker.js"),
  "utf8"
)
// What `browser_eval` wraps an agent's snippet in, and the one piece of this
// subsystem's JS that runs in the PAGE's world rather than ours. The file is
// the renderer; the six lines around it are built here the way
// `browser::eval::eval_call` builds them, and a Rust unit test pins that
// shape.
const EVAL_RENDER = readFileSync(
  resolve(root, "src/browser-injected/eval-render.js"),
  "utf8"
)
const evalCall = (code) =>
  `(function(){\n${EVAL_RENDER}\ntry {\nvar __codegEvalValue = (function () {\n${code}\n})();\nreturn __codegEvalRender(__codegEvalValue);\n} catch (e) {\nreturn __codegEvalError(e);\n}\n})()`

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const PORT = 9333

const PAGE = `<!doctype html><html><head><title>Probe</title>
<style>#stretched::after{content:"";position:absolute;inset:0}</style>
</head><body>
<header><a href="/docs">Docs</a></header>
<main>
  <h1>Orders</h1>
  <label>Search <input type="search" name="q"></label>
  <button id="exp" style="cursor:pointer">Export</button>
  <div id="pointer" style="cursor:pointer">Pointer but no handler</div>
  <div id="handler" onclick="void 0">Handler but no pointer</div>
  <div id="focusable" tabindex="0">Focusable but neither</div>
  <div id="hidden" style="display:none"><button>Invisible</button></div>
  <ul><li>alpha</li><li>beta</li></ul>
  <section id="act">
    <button id="count" onclick="this.dataset.n = (Number(this.dataset.n || 0) + 1)">Count</button>
    <form id="f" onsubmit="event.preventDefault(); this.dataset.submitted = document.getElementById('name').value">
      <label>Name <input id="name" name="name"></label>
      <button type="submit" id="save" onclick="this.dataset.clicked = 1">Save</button>
    </form>
    <label>Size <select id="size"><option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option></select></label>
    <div id="note" contenteditable="true">draft</div>
    <div style="position:relative;height:60px">
      <button id="under">Under</button>
      <div id="veil" style="position:absolute;inset:0;background:rgba(0,0,0,.2)"></div>
    </div>
    <a id="anchor" href="#went">Anchor</a>
  </section>
  <section id="picking">
    <div id="hiddenframes" style="position:fixed;left:0;top:0;visibility:hidden"></div>
    <div id="crowd" style="display:none"></div>
    <div id="shadowed"></div>
    <!-- The button FILLS the frame. A small one in the corner would leave the
         middle of the frame bare, and a check that presses the middle and
         finds the button unpressed would prove nothing at all. -->
    <iframe id="frame" style="width:200px;height:60px" srcdoc="&lt;body style=&quot;margin:0&quot;&gt;&lt;button id=&quot;inner&quot; style=&quot;width:200px;height:60px&quot; onclick=&quot;this.textContent='PRESSED'&quot;&gt;inner&lt;/button&gt;"></iframe>
    <div id="fat">fat</div>
    <div id="emoji">emoji</div>
    <div id="panel" style="width:200px;height:80px;overflow:auto;border:1px solid #ccc">
      <div style="height:800px">tall</div>
    </div>
    <div id="trap" style="display:none"></div>
    <div id="deepnest"></div>
    <dialog id="modal" style="padding:0;border:0;margin:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh">
      <iframe id="modalframe" style="width:100%;height:100%;border:0" srcdoc="&lt;button id=modalbtn style=width:100%;height:300px&gt;modal&lt;/button&gt;"></iframe>
    </dialog>
    <div id="pop" popover="manual" style="padding:0;border:0;margin:0;inset:0;width:100vw;height:100vh">
      <iframe id="popframe" style="width:100%;height:100%;border:0" srcdoc="&lt;button id=popbtn style=width:100%;height:300px&gt;popover&lt;/button&gt;"></iframe>
    </div>
    <!-- Small, and placed to sit between every point the overlay samples.
         No backticks in here: this whole page is a template literal. -->
    <div id="smallpop" popover="manual" style="padding:0;border:0;margin:0;left:200px;top:150px;right:auto;bottom:auto;width:140px;height:60px">
      <iframe id="smallframe" style="width:140px;height:60px;border:0" srcdoc="&lt;body style=&quot;margin:0&quot;&gt;&lt;button id=smallbtn style=&quot;width:140px;height:60px&quot;&gt;small&lt;/button&gt;"></iframe>
    </div>
  </section>
  <section id="reach">
    <!-- The screen-reader-only recipe, as the frameworks ship it: a box by the
         geometry, nothing at all to a person, and named by the aria tree like
         any other heading. A pointer sent to its centre lands on whatever
         draws the space it sits in. -->
    <article id="post" style="position:relative;background:#eee;height:40px">
      <h2 id="sronly" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Posted by ada</h2>
      <p>post body</p>
    </article>
    <!-- The same intent written the modern way, and in the older way that
         still ships in every framework's stylesheet: a box of a real size,
         clipped away to nothing. Each is big enough to pass the size check,
         so it is the style that has to catch them. Kept apart from the one
         above, and from each other, because they fail at different checks and
         one regressing must not hide behind another. -->
    <div id="blocker" style="position:relative;background:#eee;height:40px">
      <h2 id="clipped" style="position:absolute;clip-path:inset(50%);width:120px;height:20px">Clipped heading</h2>
    </div>
    <div id="legacy" style="position:relative;background:#eee;height:40px">
      <h2 id="oldclip" style="position:absolute;clip:rect(0,0,0,0);width:120px;height:20px">Legacy clipped</h2>
    </div>
    <!-- And the one that must NOT be called erased: clipped, but not away.
         Its centre is inside what is left, so it is an ordinary click. -->
    <div id="partly" style="position:relative;height:60px">
      <button id="peeking" style="clip-path:inset(0 0 30% 0);width:120px;height:40px">Peeking</button>
    </div>
    <!-- The stretched-link pattern: a card whose ::after covers the whole
         card, over a link that is perfectly visible. A pointer at the link's
         centre lands on the card — an ANCESTOR — and the right answer is
         "click the card", not "this can never be clicked". -->
    <div id="stretched" style="position:relative;height:40px;background:#f6f6f6">
      <a id="inside" href="#stretched-went">Stretched</a>
    </div>
    <!-- The other screen-reader-only recipe, still shipping in plenty of
         themes: a real box of a real size, parked outside the document's
         scrollable origin. Scroll offsets are clamped at zero, so nothing can
         ever bring this into view — a property like the clipped ones, but it
         is geometry rather than computed style that says so. -->
    <div id="offleft" style="position:absolute;left:-9999px;width:200px;height:20px;overflow:hidden">Parked off to the left</div>
    <!-- And the two things that are ALSO outside the document and must NOT be
         called permanent, because a page puts them back: the off-canvas
         drawer a hamburger slides in, offset by exactly its own width, and
         the skip link a focus rule drops into view. Both park flush; the
         recipe above parks nine thousand pixels out.
         No backticks in here: this whole page is a template literal. -->
    <nav id="drawer" style="position:fixed;top:140px;left:-320px;width:320px;height:40px;background:#dde">
      <a id="drawerlink" href="#drawer-went">Drawer link</a>
    </nav>
    <a id="skip" href="#act" style="position:absolute;left:0;top:-40px;width:200px;height:30px">Skip to content</a>
    <label>Notes <input id="notes" name="notes"></label>
    <!-- A scroller of its own, so a key pressed inside it can be shown to
         move the pane and leave the document where it was. -->
    <div id="pane" style="width:200px;height:80px;overflow:auto">
      <button id="deep">Deep</button>
      <div style="height:800px"></div>
    </div>
    <!-- Room on both axes, for measuring what an engine's own Home and End do
         horizontally before deciding what ours should. -->
    <div id="both" style="width:200px;height:80px;overflow:auto">
      <div style="width:1200px;height:800px">wide and tall</div>
    </div>
    <!-- Room on one axis only, to settle whether the ends keys fall back to
         the axis that has somewhere to go. -->
    <div id="wideonly" style="width:200px;height:80px;overflow:auto">
      <div style="width:1200px;height:20px">wide only</div>
    </div>
    <div id="tall" style="height:3000px"></div>
  </section>
<script>
  // Forty frames the picker must look past to reach the visible one, and
  // twenty thousand elements in front of a frame that lives in an open shadow
  // root — the walk's budget has to reach the shadow root all the same.
  const pen = document.getElementById("hiddenframes")
  for (let i = 0; i < 40; i++) {
    // Laid out and inside the viewport, but invisible: a box alone must not
    // be enough to spend a patch.
    const ghost = document.createElement("iframe")
    ghost.style.cssText = "width:10px;height:10px;border:0"
    pen.appendChild(ghost)
  }
  const crowd = document.getElementById("crowd")
  for (let i = 0; i < 20000; i++) crowd.appendChild(document.createElement("span"))
  // …and the shadow host carries a light subtree of its own, larger than the
  // walk's queue, so it buries its own shadow root unless shadow content is
  // queued before light content.
  // Direct children: a wrapper would be one entry in the queue, and the walk
  // would reach the shadow root long before it descended into it.
  const buryer = document.getElementById("shadowed")
  for (let i = 0; i < 60000; i++) buryer.appendChild(document.createElement("span"))
  const shadowed = buryer.attachShadow({ mode: "open" })
  // Not the shadow root's first child, and behind a wrapper: a walk that only
  // has room for one more node would queue these and drop the frame.
  shadowed.appendChild(document.createElement("style"))
  const wrapper = document.createElement("div")
  shadowed.appendChild(wrapper)
  const deepFrame = document.createElement("iframe")
  deepFrame.id = "deep"
  deepFrame.style.cssText = "width:160px;height:40px;border:0"
  // Unquoted attributes, and the handler wired from here: this whole page is
  // a template literal inside a JS file, and a nested quote is one escape
  // away from a syntax error that silently skips the script.
  deepFrame.srcdoc = "<button id=buried style=width:160px;height:40px>buried</button>"
  deepFrame.addEventListener("load", () => {
    const buried = deepFrame.contentDocument.getElementById("buried")
    if (buried) buried.addEventListener("click", () => { buried.textContent = "PRESSED" })
  })
  wrapper.appendChild(deepFrame)
  // A NESTED shadow host, whose own light subtree is large enough to spend a
  // whole allowance: the inner root has to get one of its own.
  const inner = document.createElement("div")
  shadowed.appendChild(inner)
  for (let i = 0; i < 20000; i++) inner.appendChild(document.createElement("span"))
  const innerRoot = inner.attachShadow({ mode: "open" })
  const nestedFrame = document.createElement("iframe")
  nestedFrame.id = "nested"
  nestedFrame.style.cssText = "width:120px;height:30px;border:0"
  nestedFrame.srcdoc = "<button id=nestedbtn style=width:120px;height:30px>nested</button>"
  nestedFrame.addEventListener("load", () => {
    const b = nestedFrame.contentDocument.getElementById("nestedbtn")
    if (b) b.addEventListener("click", () => { b.textContent = "PRESSED" })
  })
  innerRoot.appendChild(nestedFrame)
  // Thirty-three open shadow roots, one inside the next, with a real button at
  // the bottom. A descent that gives up before the end names a host instead of
  // what the pointer is actually over.
  let rung = document.getElementById("deepnest")
  for (let i = 0; i < 33; i++) {
    const next = document.createElement("div")
    rung.attachShadow({ mode: "open" }).appendChild(next)
    rung = next
  }
  const bottom = document.createElement("button")
  bottom.id = "bottom"
  bottom.style.cssText = "width:120px;height:24px"
  bottom.textContent = "bottom"
  bottom.addEventListener("click", () => { bottom.textContent = "PRESSED" })
  rung.appendChild(bottom)
  // The buttons inside the top-layer frames, wired the same way as the others.
  for (const id of ["modalframe", "popframe", "smallframe"]) {
    const f = document.getElementById(id)
    f.addEventListener("load", () => {
      const b = f.contentDocument.querySelector("button")
      if (b) b.addEventListener("click", () => { b.textContent = "PRESSED" })
    })
  }
</script>
</main>
<script>
  // What a React-style page does to a field: track the value on the instance
  // and only treat an input event as a change when the DOM disagrees.
  const name = document.getElementById("name")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
  let tracked = ""
  Object.defineProperty(name, "value", {
    configurable: true,
    get: () => setter.get.call(name),
    set: (v) => { tracked = v; setter.set.call(name, v) },
  })
  name.addEventListener("input", () => {
    if (setter.get.call(name) !== tracked) name.dataset.seen = setter.get.call(name)
  })
  document.getElementById("size").addEventListener("change", (e) => {
    e.target.dataset.changed = e.target.value
  })
  document.getElementById("count").addEventListener("pointerdown", function () {
    this.dataset.pointer = "1"
  })
</script></body></html>`

const dir = mkdtempSync(join(tmpdir(), "codeg-agent-probe-"))
const pageFile = join(dir, "probe.html")
writeFileSync(pageFile, PAGE)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(dir, "profile")}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" }
)

let ws
let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(actual)}`)
}

try {
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json()
      const page = list.find((t) => t.type === "page")
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl)
    } catch {
      await sleep(100)
    }
  }
  if (!ws) throw new Error(`no page target — is Chrome at ${CHROME}?`)
  await new Promise((r) => (ws.onopen = r))

  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  await send("Page.enable")
  await send("Page.navigate", { url: `file://${pageFile}` })
  await sleep(700)

  // An isolated world, created the way the shims create one.
  const { result: frameTree } = await send("Page.getFrameTree")
  const { result: world } = await send("Page.createIsolatedWorld", {
    frameId: frameTree.frameTree.frame.id,
    worldName: "codeg",
    grantUniveralAccess: false,
  })

  const run = async (expression, contextId = world.executionContextId) => {
    const { result } = await send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails, null, 2))
    return result.result.value
  }

  await run(BUNDLE)

  const snap = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({}))")
  )
  console.log("\n=== tree ===\n" + snap.tree + "\n")
  console.log(`url=${snap.url} title=${snap.title} refs=${snap.refsCount}\n`)

  // Roleless divs that behave like controls have to be namable, or an agent
  // cannot act on the many pages that are built out of them. This is the whole
  // reason there is no promotion pass of our own: `ai` mode refs everything
  // visible that receives pointer events, so each of these is already named,
  // whichever single attribute makes it interesting. Kept as three separate
  // elements so that one of them regressing cannot hide behind another.
  const named = (id, text) =>
    check(
      `a roleless div is namable — ${id}`,
      new RegExp(`generic \\[ref=e\\d+\\][^\\n]*: ${text}`).test(snap.tree),
      true
    )
  named("cursor:pointer only", "Pointer but no handler")
  named("onclick only", "Handler but no pointer")
  named("tabindex only", "Focusable but neither")

  // …and `cursor: pointer` is additionally marked, which is how an agent tells
  // "this looks clickable" from "this is merely visible".
  check(
    "cursor:pointer is reported, and only where it applies",
    [
      /\[cursor=pointer\][^\n]*: Pointer but no handler/.test(snap.tree),
      /\[cursor=pointer\][^\n]*: Handler but no pointer/.test(snap.tree),
    ],
    [true, false]
  )

  check(
    "a display:none subtree is left out",
    snap.tree.includes("Invisible"),
    false
  )
  check("the link keeps its href", snap.tree.includes("/url: /docs"), true)

  // The page must not be able to see, call or forge the agent surface.
  const mainWorld = await send("Runtime.evaluate", {
    expression: "typeof globalThis.__codegAgent",
    returnByValue: true,
  })
  check(
    "the page cannot see __codegAgent",
    mainWorld.result.result.value,
    "undefined"
  )

  const cut = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({maxChars: 40}))")
  )
  check("a capped tree reports the cut", cut.truncated, true)
  check("a capped tree ends on a line boundary", cut.tree.endsWith(":"), true)

  // Every snapshot hands out its own token, and the capped one above was a
  // snapshot: the refs used from here on come from a fresh one.
  const live = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({}))")
  )
  const g = JSON.stringify(live.generation)
  // Two refs: one to spend on the removal case, one that must stay in the page
  // so the same-document case cannot pass for the wrong reason.
  const kept = JSON.stringify(
    live.tree.match(/button "Export" \[ref=(e\d+)\]/)[1]
  )
  const spent = JSON.stringify(
    live.tree.match(/listitem \[ref=(e\d+)\]: alpha/)[1]
  )

  check(
    "a live ref resolves",
    await run(`!!__codegAgent.elementForRef(${g}, ${kept})`),
    true
  )
  check(
    "a ref from another document does not",
    await run(`__codegAgent.elementForRef("other", ${kept})`),
    null
  )
  check(
    "a ref for a removed element does not",
    await run(
      `(() => { __codegAgent.elementForRef(${g}, ${spent}).remove();
                return __codegAgent.elementForRef(${g}, ${spent}) })()`
    ),
    null
  )

  // A single-page app's route change: same document, same world, same
  // generation, and the element is still in the page. Only the address moved.
  // Asserting that it is still connected is the point — otherwise a `null`
  // here would prove nothing about the address and everything about the node.
  check(
    "a ref does not survive a pushState, though its element does",
    await run(
      `(() => { const el = __codegAgent.elementForRef(${g}, ${kept});
                history.pushState({}, "", "?routed");
                return [el.isConnected, __codegAgent.elementForRef(${g}, ${kept})] })()`
    ),
    [true, null]
  )
  check(
    "and a snapshot at the new address hands out refs that work again",
    await run(
      `(() => { const s = __codegAgent.snapshot({});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                return !!__codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    true
  )

  // An address is not an identity: a route that leaves and comes back
  // arrives at a string that matches, and a framework may have kept the node
  // and changed what it means. The world cannot see the transition — the
  // page's own `pushState` is invisible from an isolated world — but it can
  // see what the transition leaves behind: two more history entries.
  check(
    "an address that leaves and returns is caught by the history length",
    await run(
      `(() => { const here = location.href;
                const s = __codegAgent.snapshot({});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                history.pushState({}, "", "?elsewhere");
                history.pushState({}, "", here);
                return __codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    null
  )
  // …and a back-and-forward that lands where it started moves neither the
  // address nor the length, and is caught by the events it fires.
  check(
    "a back and forward that return to the same page are caught by popstate",
    await new Promise(async (resolve) => {
      await run(
        `history.pushState({}, "", "?one"); history.pushState({}, "", "?two");
         history.back();`
      )
      await sleep(150)
      await run(
        `globalThis.__s = __codegAgent.snapshot({});
         globalThis.__m = __s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/)[1];
         history.back(); history.forward();`
      )
      await sleep(250)
      resolve(await run(`__codegAgent.elementForRef(__s.generation, __m)`))
    }),
    null
  )

  // ── acting ─────────────────────────────────────────────────────────────

  const fresh = async () => {
    const s = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const ref = (pattern) => {
      const m = s.tree.match(pattern)
      if (!m) throw new Error(`no match for ${pattern} in\n${s.tree}`)
      return m[1]
    }
    return { gen: JSON.stringify(s.generation), ref }
  }
  const actJson = async (gen, ref, request) =>
    JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.act(${gen}, ${JSON.stringify(ref)}, ${JSON.stringify(request)}))`
      )
    )

  {
    const { gen, ref } = await fresh()
    const count = ref(/button "Count" \[ref=(e\d+)\]/)
    const result = await actJson(gen, count, { kind: "click" })
    check(
      "a click lands: handler ran, pointerdown seen, element focused",
      [
        result.ok,
        await run(`document.getElementById("count").dataset.n`),
        await run(`document.getElementById("count").dataset.pointer`),
        await run(`document.activeElement.id`),
      ],
      [true, "1", "1", "count"]
    )
    check(
      "a second click with the same ref still works — the page did not move",
      (await actJson(gen, count, { kind: "click" })).ok &&
        (await run(`document.getElementById("count").dataset.n`)),
      "2"
    )
  }
  {
    const { gen, ref } = await fresh()
    const name = ref(/textbox "Name" \[ref=(e\d+)\]/)
    const result = await actJson(gen, name, { kind: "type", text: "Ada" })
    check(
      "typing replaces the value and a React-style tracker sees the change",
      [
        result.ok,
        await run(`document.getElementById("name").value`),
        await run(`document.getElementById("name").dataset.seen`),
      ],
      [true, "Ada", "Ada"]
    )
    const submit = await actJson(gen, name, {
      kind: "type",
      text: "Grace",
      submit: true,
    })
    check(
      "type with submit goes through the form's default button",
      [
        submit.ok,
        await run(`document.getElementById("save").dataset.clicked`),
        await run(`document.getElementById("f").dataset.submitted`),
      ],
      [true, "1", "Grace"]
    )
  }
  {
    const { gen, ref } = await fresh()
    const size = ref(/combobox "Size" \[ref=(e\d+)\]/)
    check(
      "select by label fires change with the new value",
      [
        (await actJson(gen, size, { kind: "select", values: ["Large"] })).ok,
        await run(`document.getElementById("size").value`),
        await run(`document.getElementById("size").dataset.changed`),
      ],
      [true, "l", "l"]
    )
    const missing = await actJson(gen, size, { kind: "select", values: ["XL"] })
    check(
      "a value that is not an option is refused with the options listed",
      [missing.ok, missing.error, missing.detail.includes('"m"')],
      [false, "no-option", true]
    )
  }
  {
    const { gen, ref } = await fresh()
    const note = ref(/generic \[ref=(e\d+)\]: draft/)
    check(
      "typing into a contenteditable replaces its text",
      [
        (await actJson(gen, note, { kind: "type", text: "final" })).ok,
        await run(`document.getElementById("note").textContent`),
      ],
      [true, "final"]
    )
  }
  {
    const { gen, ref } = await fresh()
    const under = ref(/button "Under" \[ref=(e\d+)\]/)
    const result = await actJson(gen, under, { kind: "click" })
    check(
      "a click on a covered element is refused, naming what covers it",
      [result.ok, result.error, result.detail.includes("div#veil")],
      [false, "obscured", true]
    )
    const located = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.locate(${gen}, ${JSON.stringify(under)}))`
      )
    )
    check("locate refuses on the same grounds", located.error, "obscured")
    const count = ref(/button "Count" \[ref=(e\d+)\]/)
    const point = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.locate(${gen}, ${JSON.stringify(count)}))`
      )
    )
    check(
      "locate answers with the point inside the element's box",
      point.ok &&
        (await run(
          `(() => { const r = document.getElementById("count").getBoundingClientRect();
                  return ${point.x} > r.left && ${point.x} < r.right && ${point.y} > r.top && ${point.y} < r.bottom })()`
        )),
      true
    )
  }
  {
    // "Something is in the way" and "this was never on screen" are both a
    // refusal to click, and an agent has to tell them apart: the first is
    // worth another look after the page settles, the second is worth nothing
    // at all. An accessibility tree is full of the second — every article on
    // a forum carries a screen-reader-only heading — so an agent that reads
    // them as the first works its way down a column of them.
    const { gen, ref } = await fresh()
    const sronly = ref(/heading "Posted by ada" \[level=2\] \[ref=(e\d+)\]/)
    const hidden = await actJson(gen, sronly, { kind: "click" })
    check(
      "a screen-reader-only heading is refused as never-visible, not obscured",
      [
        hidden.ok,
        hidden.error,
        hidden.detail.includes("paints nothing"),
        // The phrase `browser_click`'s description points a model at for
        // permanence. Both shapes of this refusal carry it; only this one
        // also paints nothing, so the two are asserted apart.
        hidden.detail.includes("no snapshot will change that"),
      ],
      [false, "not-visible", true, true]
    )
    const clipped = ref(/heading "Clipped heading" \[level=2\] \[ref=(e\d+)\]/)
    const through = await actJson(gen, clipped, { kind: "click" })
    check(
      "an element clipped away is told from one with something on top of it",
      [through.ok, through.error, through.detail.includes("div#blocker")],
      [false, "not-visible", true]
    )
    const legacy = ref(/heading "Legacy clipped" \[level=2\] \[ref=(e\d+)\]/)
    check(
      "the older `clip: rect(0 0 0 0)` spelling counts as erased too",
      (await actJson(gen, legacy, { kind: "click" })).error,
      "not-visible"
    )
    // Clipped is not erased. A box with most of itself still showing is an
    // ordinary target, and reading "clip-path" as "gone" would refuse it.
    const peeking = ref(/button "Peeking" \[ref=(e\d+)\]/)
    check(
      "a partly clipped element is still an ordinary click",
      (await actJson(gen, peeking, { kind: "click" })).ok,
      true
    )
    const located = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.locate(${gen}, ${JSON.stringify(clipped)}))`
      )
    )
    check(
      "the trusted path tells the two apart the same way",
      located.error,
      "not-visible"
    )
    // The line the verdict must not cross. An ancestor painting over its own
    // descendant is ordinary and recoverable — the stretched-link card, an
    // accordion shut over its contents — and calling that permanent would be
    // worse than the confusing answer it replaced, because it tells an agent
    // to give up on a link that is right there.
    const covered = ref(/link "Stretched" \[ref=(e\d+)\]/)
    const overlaid = await actJson(gen, covered, { kind: "click" })
    check(
      "an ancestor's own overlay is still obscured, not a permanent refusal",
      [
        overlaid.ok,
        overlaid.error,
        overlaid.detail.includes("div#stretched"),
        overlaid.detail.includes("paints nothing"),
      ],
      [false, "obscured", true, false]
    )
    // …and it has to say *which* relation that is. `describe` names an
    // element by its own text, and a card's text is its link's text, so the
    // plain wording comes out as "X is on top of X" — which names nothing to
    // act on, and naming what to act on is this message's whole job.
    check(
      "an ancestor overlay is named as one, without repeating the target's words",
      [
        overlaid.detail.includes("ancestor"),
        (overlaid.detail.match(/"Stretched"/g) ?? []).length,
      ],
      [true, 1]
    )
    // The recipe the style checks do not see: a real box parked where no
    // scroll can reach it. Permanent for a reason of its own — offsets clamp
    // at zero — so it must not come back as "could not be scrolled to *this
    // time*", which is the answer an agent retries.
    const parked = ref(/\[ref=(e\d+)\][^\n]*: Parked off to the left/)
    const offLeft = await actJson(gen, parked, { kind: "click" })
    check(
      "a box parked outside the document's origin is permanent too",
      [offLeft.error, offLeft.detail.includes("no snapshot will change that")],
      ["not-visible", true]
    )
    // …in words its own box does not contradict. This element paints, at a
    // coordinate no scroll reaches; telling it that it "paints nothing on
    // screen" asserts something the caller can go and check and find wrong,
    // and a refusal caught out being wrong is one worth retrying past — the
    // one thing the message exists to prevent. The verdict above is what the
    // two shapes share; this is where they differ.
    check(
      "…and is described as parked rather than as painting nothing",
      [
        offLeft.detail.includes("parked outside the page"),
        offLeft.detail.includes("paints nothing"),
      ],
      [true, false]
    )
    // The line that one must not cross. Outside the document is not by itself
    // permanent: no *scroll* reaches a negative coordinate, but CSS does, and
    // the two commonest things parked out there are things a page puts back.
    // Both park flush — by exactly their own size — which is what separates
    // them from a box left nine thousand pixels out.
    for (const [what, pattern] of [
      ["an off-canvas drawer", /link "Drawer link" \[ref=(e\d+)\]/],
      ["a skip link above the fold", /link "Skip to content" \[ref=(e\d+)\]/],
    ]) {
      const answer = await actJson(gen, ref(pattern), { kind: "click" })
      check(
        `…but ${what} is a state the page can undo, and is not called permanent`,
        [answer.error, answer.detail.includes("no snapshot will change that")],
        ["not-visible", false]
      )
    }
  }
  {
    // `body { transform: translateX(…) }` is the other drawer pattern, and it
    // pushes the whole page aside at once. The walk has to read the page's own
    // style rather than merely stopping at it, or every element the drawer
    // pushed off the left becomes a permanent refusal that closing the drawer
    // undoes.
    const { gen, ref } = await fresh()
    const exported = ref(/button "Export" \[ref=(e\d+)\]/)
    // Both of the page's boxes, because `transform` does not inherit: a walk
    // that stops at the body never sees a root-level page transition, and
    // `html` is as much "between here and the page" as `body` is.
    for (const box of ["body", "documentElement"]) {
      await run(`document.${box}.style.transform = "translateX(-3000px)"`)
      const pushed = await actJson(gen, exported, { kind: "click" })
      await run(`document.${box}.style.transform = ""`)
      check(
        `a page pushed aside by a transform on the ${box} is not permanent either`,
        [pushed.error, pushed.detail.includes("no snapshot will change that")],
        ["not-visible", false]
      )
    }
    // The page's *overflow*, unlike its transform, must not switch the test
    // off: `body { overflow: hidden }` is what every application with its own
    // scroller writes, and the scroll it hides is the one already counted in
    // `window.scrollX` / `scrollY`.
    const parked = ref(/\[ref=(e\d+)\][^\n]*: Parked off to the left/)
    await run(`document.body.style.overflow = "hidden"`)
    const stillGone = await actJson(gen, parked, { kind: "click" })
    await run(`document.body.style.overflow = ""`)
    check(
      "…while the page's own overflow does not switch the test off",
      [
        stillGone.error,
        stillGone.detail.includes("no snapshot will change that"),
      ],
      ["not-visible", true]
    )
  }
  {
    // The line on the other side of `unreachable`. An element that is not
    // being rendered *at this moment* — the accordion shut since the
    // snapshot, the panel a route change collapsed — has no boxes at all, and
    // so arrives at the same place as the one-pixel recipe. But it is a state
    // and not a property: open the thing that hides it, snapshot again, and
    // the ref works. Telling an agent no snapshot will change that is the
    // same lie the off-viewport wording was split off to avoid.
    await run(
      `(() => {
         const w = document.createElement("div")
         w.id = "shutter"
         w.innerHTML = '<button id="in-shutter">In shutter</button>'
         document.getElementById("reach").appendChild(w)
       })()`
    )
    const { gen, ref } = await fresh()
    const inShutter = ref(/button "In shutter" \[ref=(e\d+)\]/)
    await run(`document.getElementById("shutter").style.display = "none"`)
    const shut = await actJson(gen, inShutter, { kind: "click" })
    check(
      "an element hidden since the snapshot is a state, not a permanent refusal",
      [shut.error, shut.detail.includes("no snapshot will change that")],
      ["not-visible", false]
    )
    await run(`document.getElementById("shutter").remove()`)
  }
  {
    // A synthetic key event carries no default action, so a scroll key that
    // only dispatched would report "done" over a page that never moved — the
    // one failure an agent cannot see. These measure the page actually
    // moving, which is the only thing that settles it.
    const { gen, ref } = await fresh()
    const top = () => run("Math.round(document.scrollingElement.scrollTop)")
    const press = (target, key) => actJson(gen, target, { kind: "press", key })
    await run("document.scrollingElement.scrollTop = 0")
    // A ref-less press goes to whatever has focus, and the checks above left
    // focus in a field. Start from the plain case on purpose; the field is its
    // own check further down.
    await run("document.activeElement?.blur()")
    const down = await press(null, "PageDown")
    const afterDown = await top()
    check(
      "PageDown with no ref scrolls the document",
      [down.ok, afterDown > 0],
      [true, true]
    )
    check(
      "a page key moves less than a whole viewport, so the fold overlaps",
      afterDown < (await run("window.innerHeight")),
      true
    )
    await press(null, "PageDown")
    const twice = await top()
    check("a second PageDown goes further", twice > afterDown, true)
    await press(null, "PageUp")
    check("PageUp comes back", (await top()) < twice, true)
    await press(null, "End")
    const bottom = await top()
    check(
      "End reaches the bottom",
      bottom >=
        (await run(
          "document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight - 2"
        )),
      true
    )
    await press(null, "Home")
    check("Home returns to the top", await top(), 0)
    check(
      "Control+Home and Control+End scroll too, and Alt scrolls nothing",
      [
        (await press(null, "Control+End")).ok && (await top()) > 0,
        (await press(null, "Control+Home")).ok && (await top()) === 0,
        (await press(null, "Alt+End")).ok && (await top()) === 0,
      ],
      [true, true, true]
    )

    // The numbers a caller needs to stop. Measured in a real engine, where
    // the clamping and the rounding are the engine's own.
    await run("document.scrollingElement.scrollTop = 0")
    const moved = await press(null, "PageDown")
    const viewport = await run("window.innerHeight")
    const limit = await run(
      "document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight"
    )
    check(
      "a scroll reports how far it went and how much is left",
      [
        moved.scrolled.by > 0,
        moved.scrolled.by < viewport,
        moved.scrolled.top === moved.scrolled.by,
        Math.abs(moved.scrolled.max - Math.round(limit)) <= 1,
      ],
      [true, true, true, true]
    )
    await press(null, "End")
    const stuck = await press(null, "PageDown")
    check(
      "and says plainly when there was nowhere left to go",
      [stuck.ok, stuck.scrolled.by, stuck.scrolled.top === stuck.scrolled.max],
      [true, 0, true]
    )
    check(
      "a key that is not a scroll key reports no scrolling at all",
      (await press(null, "Escape")).scrolled,
      undefined
    )
    await press(null, "Home")

    // The key belongs to the box it was pressed in, the way it does for a
    // person: inside a scrollable pane it scrolls the pane, and the document
    // stays where it was.
    const deep = ref(/button "Deep" \[ref=(e\d+)\]/)
    await run(`document.getElementById("pane").scrollTop = 0`)
    const inPane = await press(deep, "PageDown")
    check(
      "PageDown inside an overflow pane scrolls the pane, not the document",
      [
        inPane.ok,
        (await run(`document.getElementById("pane").scrollTop`)) > 0,
        await top(),
      ],
      [true, true, 0]
    )

    // A field holding focus is the ordinary state after typing into one, and
    // the engine pages the document from there rather than sitting still. The
    // caret keys are the pair that stay the field's own.
    const notes = ref(/textbox "Notes" \[ref=(e\d+)\]/)
    await run(`document.scrollingElement.scrollTop = 0`)
    await press(notes, "PageDown")
    check(
      "PageDown from a focused field still pages the document",
      (await top()) > 0,
      true
    )
    await run(`document.scrollingElement.scrollTop = 0`)
    await press(notes, "End")
    check("a caret key in a text field leaves the page put", await top(), 0)
    await run(
      `globalThis.__stop = (e) => { if (e.key === "PageDown") e.preventDefault() };
       addEventListener("keydown", globalThis.__stop)`
    )
    const stopped = await press(null, "PageDown")
    check(
      "a page that cancels the key keeps its own meaning for it",
      [stopped.ok, await top()],
      [true, 0]
    )
    await run(`removeEventListener("keydown", globalThis.__stop)`)
  }
  {
    // Why the ends keys move one axis and not two, settled by asking the
    // engine rather than by reasoning about what "the beginning" ought to
    // mean. Trusted keys, because a dispatched one has no default action —
    // that is the premise of the whole emulation — so these are the engine's
    // own answer, and the emulation is written to match it.
    //
    // It is flatly not what one would guess: `Home` reads as "go to the
    // start", and in a box scrolled both down and across it goes only up.
    // Kept as a check rather than a comment because the guess is the kind
    // that gets acted on later.
    const trustedKey = async (key, keyCode, settle = 900) => {
      for (const type of ["rawKeyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        })
      // Long enough for Chrome's own smooth keyboard scroll to finish: a
      // short wait reads a frame of the animation and answers neither "it
      // moved" nor "it did not".
      await sleep(settle)
    }
    const offsets = (target) =>
      run(`[${target}.scrollLeft, ${target}.scrollTop].map(Math.round)`)
    const focusOn = async (target, left, top = 0) =>
      run(`${target}.tabIndex = -1; ${target}.focus();
           ${target}.scrollTo({ left: ${left}, top: ${top}, behavior: "instant" })`)
    const release = (target) =>
      run(`${target}.blur(); ${target}.removeAttribute("tabindex");
           ${target}.scrollTo({ left: 0, top: 0, behavior: "instant" })`)

    const both = "document.getElementById('both')"
    await focusOn(both, 400, 300)
    await trustedKey("End", 35)
    const ended = await offsets(both)
    await focusOn(both, 400, 300)
    await trustedKey("Home", 36)
    const homed = await offsets(both)
    await release(both)
    check(
      "the engine's own ends keys move the box down and up, never across",
      [ended[0], ended[1] > 300, homed[0], homed[1]],
      [400, true, 400, 0]
    )

    // Not even when the axis they move has nowhere to go and the other one
    // does: a box that can only scroll across stays where it is.
    const wideOnly = "document.getElementById('wideonly')"
    await focusOn(wideOnly, 400)
    await trustedKey("Home", 36)
    const across = await offsets(wideOnly)
    await release(wideOnly)
    check(
      "…and they do not fall back to the axis that has room",
      across,
      [400, 0]
    )

    // The same of the document's own scroller, which is what a ref-less key
    // lands on almost every time.
    const page = "document.scrollingElement"
    await run(
      `(() => {
         const wide = document.createElement("div")
         wide.id = "wide"
         wide.style.cssText = "width:4000px;height:10px"
         document.body.appendChild(wide)
       })()`
    )
    await run(`${page}.scrollTo({ left: 600, top: 400, behavior: "instant" })`)
    await trustedKey("End", 35)
    const pageEnded = await offsets(page)
    await run(`${page}.scrollTo({ left: 600, top: 400, behavior: "instant" })`)
    await trustedKey("Home", 36)
    const pageHomed = await offsets(page)
    check(
      "the document's scroller answers the same way",
      [pageEnded[0], pageEnded[1] > 400, pageHomed[0], pageHomed[1]],
      [600, true, 600, 0]
    )
    await run(
      `document.getElementById("wide").remove();
       ${page}.scrollTo({ left: 0, top: 0, behavior: "instant" })`
    )
  }
  {
    // The layout most single-page apps ship: the document itself does not
    // scroll, an inner box does. A ref-less key lands on `document.body`,
    // whose walk ends at the document's own scroller — which has nothing to
    // move — so the press reports "no more content than fits" about a page
    // with four thousand pixels left in it.
    //
    // Built here and taken down again: a document that cannot scroll is not a
    // state the rest of this file can run in.
    await run(
      `(() => {
         globalThis.__spa = {
           html: document.documentElement.getAttribute("style"),
           body: document.body.getAttribute("style"),
           // The shell is the body's only laid-out child in a real
           // application, and it has to be here too: the middle of the screen
           // is where the answer comes from, and this page's own three
           // thousand pixels would be sitting in it otherwise.
           hidden: Array.from(document.body.children).map((child) => [
             child,
             child.style.display,
           ]),
         }
         for (const [child] of globalThis.__spa.hidden) child.style.display = "none"
         document.documentElement.style.cssText += ";height:100%;overflow:hidden"
         document.body.style.cssText += ";height:100%;overflow:hidden;margin:0"
         const root = document.createElement("div")
         root.id = "approot"
         root.style.cssText = "height:100%;overflow-y:auto"
         root.innerHTML = '<div style="height:4000px">app</div>'
         document.body.appendChild(root)
         // A control of the application's own that scrolls nothing — the rail
         // down the side, the fixed toolbar. Naming it is how a caller says
         // which box it means.
         const aside = document.createElement("button")
         aside.id = "spa-aside"
         aside.textContent = "Rail"
         aside.style.cssText = "position:fixed;left:0;top:0;z-index:5"
         document.body.appendChild(aside)
       })()`
    )
    await run("document.activeElement?.blur()")
    const { gen, ref } = await fresh()
    const pageRoom = await run(
      "document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight"
    )
    const inner = await actJson(gen, null, { kind: "press", key: "PageDown" })
    check(
      "a page whose own scroller cannot move still scrolls the box that can",
      [
        pageRoom <= 1,
        inner.ok,
        await run(`document.getElementById("approot").scrollTop > 0`),
        inner.scrolled?.by > 0,
      ],
      [true, true, true, true]
    )
    // …but only for a press that named nothing. A caller that gave a `ref`
    // pointed at a box and is owed an answer about that box: moving a
    // different one and reporting the pixels reads as the named box having
    // scrolled, which is the same false success one layer along.
    await run(`document.getElementById("approot").scrollTop = 0`)
    const rail = ref(/button "Rail" \[ref=(e\d+)\]/)
    const named = await actJson(gen, rail, { kind: "press", key: "PageDown" })
    check(
      "…and not for one that named a box of its own that does not scroll",
      [
        named.ok,
        await run(`document.getElementById("approot").scrollTop`),
        named.scrolled?.by,
      ],
      [true, 0, 0]
    )
    await run(
      `(() => {
         document.getElementById("approot").remove()
         document.getElementById("spa-aside").remove()
         const put = (el, was) =>
           was === null ? el.removeAttribute("style") : el.setAttribute("style", was)
         put(document.documentElement, globalThis.__spa.html)
         put(document.body, globalThis.__spa.body)
         for (const [child, was] of globalThis.__spa.hidden) child.style.display = was
         delete globalThis.__spa
       })()`
    )
  }
  {
    const { gen, ref } = await fresh()
    const spent = ref(/listitem \[ref=(e\d+)\]: beta/)
    await run(
      `__codegAgent.elementForRef(${gen}, ${JSON.stringify(spent)}).remove()`
    )
    const result = await actJson(gen, spent, { kind: "click" })
    check(
      "acting on a removed element is stale, not a click on something else",
      [result.ok, result.error],
      [false, "stale"]
    )
    check(
      "a key press to the focused element needs a current snapshot too",
      (
        await actJson(JSON.stringify("other"), null, {
          kind: "press",
          key: "Escape",
        })
      ).error,
      "stale"
    )
  }
  {
    // Two snapshots of one document under one epoch are two snapshots: a
    // token from the first does not resolve refs against the second's map.
    const a = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const b = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const m = b.tree.match(/button "Count" \[ref=(e\d+)\]/)[1]
    check(
      "each snapshot hands out its own token, and an older one is refused",
      [
        a.generation !== b.generation,
        await run(
          `__codegAgent.elementForRef(${JSON.stringify(a.generation)}, ${JSON.stringify(m)})`
        ),
        !!(await run(
          `__codegAgent.elementForRef(${JSON.stringify(b.generation)}, ${JSON.stringify(m)})`
        )),
      ],
      [true, null, true]
    )
    // A capped tree hands out only the refs it showed.
    const cut = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({maxChars: 60}))")
    )
    const shown = [...cut.tree.matchAll(/\[ref=(e\d+)\]/g)].map((x) => x[1])
    const hidden = "e" + (Math.max(...shown.map((r) => Number(r.slice(1)))) + 3)
    check(
      "a ref the cap hid from the agent is not actable",
      [
        cut.truncated,
        shown.length > 0,
        await run(
          `__codegAgent.elementForRef(${JSON.stringify(cut.generation)}, ${JSON.stringify(hidden)})`
        ),
      ],
      [true, true, null]
    )
    // …and the caller is told it did this to itself. A ref unmade by one's
    // own next snapshot is the one stale answer where "the page as it is now"
    // is actively misleading: the page has not changed at all.
    const before = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({}))")
    )
    const far = [...before.tree.matchAll(/\[ref=(e\d+)\]/g)]
      .map((x) => x[1])
      .pop()
    const after = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({maxChars: 60}))")
    )
    const refused = await actJson(JSON.stringify(after.generation), far, {
      kind: "click",
    })
    check(
      "a ref unmade by one's own smaller snapshot says so, not 'the page changed'",
      [
        refused.error,
        refused.detail.includes("maxChars"),
        refused.detail.includes("has not changed"),
      ],
      ["stale", true, true]
    )
    // Quoting the snapshot the ref actually came from — which is what the
    // tool descriptions ask for — reaches the same explanation.
    const quotingOlder = await actJson(JSON.stringify(before.generation), far, {
      kind: "click",
    })
    check(
      "…and so does quoting the snapshot the ref came from",
      quotingOlder.detail.includes("has not changed"),
      true
    )
    // The line that explanation must not cross. Two full snapshots in a row
    // name the same elements by the same refs — `ai` mode caches a ref on the
    // element and reuses it while the role and name hold — so a ref from the
    // one before last is in the current table as well. When the page then
    // takes that element away, the caller is owed "the page moved on", not
    // "your own snapshot dropped this": whether the current table still holds
    // the name is the only thing that tells the two apart.
    await run("JSON.stringify(__codegAgent.snapshot({}))")
    const live = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({}))")
    )
    const doomed = live.tree.match(/button "Peeking" \[ref=(e\d+)\]/)[1]
    await run(
      `__codegAgent.elementForRef(${JSON.stringify(live.generation)}, ${JSON.stringify(doomed)}).remove()`
    )
    const gone = await actJson(JSON.stringify(live.generation), doomed, {
      kind: "click",
    })
    check(
      "a ref whose element the page removed is not blamed on the caller's snapshot",
      [gone.error, gone.detail.includes("has not changed")],
      ["stale", false]
    )
    // The same line, on the side the check above cannot reach — and the one
    // an agent actually meets. When the element leaves *before* the next
    // snapshot, the new table never names it, so "is the name in the current
    // table" says exactly what it says for a cut: no. Only the names the cut
    // itself took tell the two apart, and both ways of quoting have to agree.
    //
    // Run twice: once with uncut snapshots, and once with both of them capped.
    // The capped pair is not a variation, it is the ordinary case — the host
    // caps every snapshot it takes — so a page-wide "was this cut" flag would
    // be permanently true there and hand back the very sentence this removes.
    const vanish = (where) =>
      run(
        `(() => {
           const b = document.createElement("button")
           b.id = "vanishing"
           b.textContent = "Vanishing"
           document.getElementById(${JSON.stringify(where)}).appendChild(b)
         })()`
      )
    const snap = async (maxChars) =>
      JSON.parse(
        await run(
          `JSON.stringify(__codegAgent.snapshot(${JSON.stringify(maxChars ? { maxChars } : {})}))`
        )
      )
    // Near the top of the tree, so a cap that trims the page's tail still
    // shows it — being shown is what makes the ref answerable at all.
    await vanish("act")
    const whole = await snap()
    for (const [how, cap] of [
      ["uncut", 0],
      ["capped", whole.tree.length - 400],
    ]) {
      if (cap) await vanish("act")
      const held = await snap(cap)
      const vanishing = held.tree.match(/button "Vanishing" \[ref=(e\d+)\]/)[1]
      await run(`document.getElementById("vanishing").remove()`)
      const reread = await snap(cap)
      for (const [quoting, token] of [
        ["the newer snapshot", reread.generation],
        ["the snapshot the ref came from", held.generation],
      ]) {
        const answer = await actJson(JSON.stringify(token), vanishing, {
          kind: "click",
        })
        check(
          `an element removed between two ${how} snapshots is not blamed on maxChars — quoting ${quoting}`,
          [
            held.truncated,
            reread.truncated,
            answer.error,
            answer.detail.includes("has not changed"),
            answer.detail.includes("maxChars"),
          ],
          [!!cap, !!cap, "stale", false, false]
        )
      }
    }
  }
  {
    // Where the engine has the Navigation API, even a replaceState away and
    // back — no length change, no event, same address — is caught.
    const has = await run(
      "typeof navigation !== 'undefined' && !!navigation.currentEntry"
    )
    if (has) {
      check(
        "with the Navigation API, replaceState away and back is caught",
        await run(
          `(() => { const here = location.href;
                    const s = __codegAgent.snapshot({});
                    const m = s.tree.match(/button "Count" \\[ref=(e\\d+)\\]/)[1];
                    history.replaceState({}, "", "?away"); history.replaceState({}, "", here);
                    return __codegAgent.elementForRef(s.generation, m) })()`
        ),
        null
      )
    } else console.log("skip  Navigation API not present in this engine")
  }
  {
    // A disabled control is refused before anything is dispatched.
    await run(`document.getElementById("count").disabled = true`)
    const { gen, ref } = await fresh()
    void ref
    const s2 = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({}))")
    )
    const m = (s2.tree.match(/button "Count" \[ref=(e\d+)\]/) || [])[1]
    if (m) {
      const r = await actJson(JSON.stringify(s2.generation), m, {
        kind: "click",
      })
      check("a disabled button is refused as disabled", r.error, "disabled")
    } else
      console.log(
        "skip  disabled button is not named by the tree (as ai mode has it)"
      )
    await run(`document.getElementById("count").disabled = false`)
    void gen
  }
  {
    const { gen, ref } = await fresh()
    const anchor = ref(/link "Anchor" \[ref=(e\d+)\]/)
    void anchor
    const before = await run("location.href")
    const result = await actJson(gen, anchor, { kind: "click" })
    check(
      "a dispatched click on a link follows it",
      [
        result.ok,
        (await run("location.href")) !== before && (await run("location.hash")),
      ],
      [true, "#went"]
    )
  }

  // …which is why the token carries whatever the host puts in it. The host
  // does see the transition, and a ref quoting an epoch it has moved past is
  // refused — by the host on the spot, and by this world from the next
  // snapshot on, which is what these two assert.
  check(
    "a host epoch reaches the token an agent echoes",
    await run(
      `__codegAgent.snapshot({epoch: "nav-7"}).generation.endsWith(".nav-7")`
    ),
    true
  )
  check(
    "and a ref from an earlier epoch dies at the next snapshot",
    await run(
      `(() => { const s = __codegAgent.snapshot({epoch: "nav-7"});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                __codegAgent.snapshot({epoch: "nav-8"});
                return __codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    null
  )

  // ── capturing ──────────────────────────────────────────────────────────
  {
    const { gen, ref } = await fresh()
    const count = ref(/button "Count" \[ref=(e\d+)\]/)
    const rect = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.rectOf(${gen}, ${JSON.stringify(count)}))`
      )
    )
    check(
      "rectOf answers with the element's box and the viewport",
      rect.ok &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.viewport.width > 0 &&
        (await run(
          `(() => { const r = document.getElementById("count").getBoundingClientRect();
                  return Math.abs(r.left - ${rect.x}) < 1 && Math.abs(r.top - ${rect.y}) < 1 })()`
        )),
      true
    )
    const stale = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.rectOf("other", ${JSON.stringify(count)}))`
      )
    )
    check("rectOf refuses a ref from another snapshot", stale.error, "stale")
  }

  // ── console ────────────────────────────────────────────────────────────
  // The page-world shim's lines have to reach this world. The channel is a
  // DOM event whose detail is one string — the kind of value that crosses a
  // world boundary unchanged — and here that claim is measured in an engine
  // with real world isolation, with the shim in the page's world where the
  // host puts it and the listener in this one where the helper has it.
  {
    await run(
      `globalThis.__lines = [];
       document.addEventListener("codeg:console", (e) => {
         __lines.push(typeof e.detail === "string" ? JSON.parse(e.detail) : { bad: typeof e.detail })
       }, true); true`
    )
    await send("Runtime.evaluate", {
      expression: CONSOLE_SHIM,
      returnByValue: true,
    })
    await send("Runtime.evaluate", {
      expression: `console.log("hello", {a: 1, b: [1, 2]});
                   console.error("%s has %d items", "cart", 3);
                   console.warn(new Error("careful"));
                   console.debug(document.body);
                   console.assert(1 === 2, "math");
                   console.assert(true, "not printed")`,
      returnByValue: true,
    })
    const lines = JSON.parse(await run("JSON.stringify(__lines)"))
    check(
      "console lines cross from the page world as strings, formatted",
      [
        lines.length,
        lines[0]?.level,
        lines[0]?.text,
        lines[1]?.text,
        lines[2]?.level,
        lines[2]?.text.startsWith("Error: careful"),
        lines[3]?.text,
        lines[4]?.level,
        lines[4]?.text,
      ],
      [
        5,
        "log",
        "hello {a: 1, b: [1, 2]}",
        "cart has 3 items",
        "warn",
        true,
        "<body>",
        "error",
        "Assertion failed: math",
      ]
    )
    // Formatting runs no page code: an accessor is shown, not invoked, and
    // the page's own call has already happened when the copy is taken.
    await send("Runtime.evaluate", {
      expression: `globalThis.__got = 0;
                   console.log({ get secret() { globalThis.__got++; return 1 }, plain: 2 })`,
      returnByValue: true,
    })
    const quiet = JSON.parse(
      await run("JSON.stringify(__lines[__lines.length - 1])")
    )
    const got = await send("Runtime.evaluate", {
      expression: "globalThis.__got",
      returnByValue: true,
    })
    check(
      "a getter on a logged object is shown, not run",
      [quiet.text, got.result.result.value],
      ["{secret: (…), plain: 2}", 0]
    )
    const pageView = await send("Runtime.evaluate", {
      expression:
        "JSON.stringify([console.log.name, typeof globalThis.__lines, typeof __codegAgent])",
      returnByValue: true,
    })
    check(
      "the wrapped method keeps its name, and the page sees neither world global",
      JSON.parse(pageView.result.result.value),
      ["log", "undefined", "undefined"]
    )
  }

  // ── element picker ─────────────────────────────────────────────────────
  // The other direction: a person pointing at something on the page. Measured
  // with REAL input (CDP's input domain, so the events are trusted and travel
  // the engine's own path), because the two claims that matter are both about
  // the event path — the press that chooses an element must not also reach the
  // page, and the highlight must stay unreadable from it.
  {
    await run(
      `globalThis.__picks = []; globalThis.__sent = [];
       globalThis.__codegSend = (m) => { __sent.push(m); __picks.push(JSON.parse(m)) }; true`
    )
    await run(PICKER)
    const seenByPage = await send("Runtime.evaluate", {
      expression:
        "JSON.stringify([typeof globalThis.__codegPicker, typeof globalThis.__codegSend])",
      returnByValue: true,
    })
    check(
      "the page sees neither the picker nor its channel",
      JSON.parse(seenByPage.result.result.value),
      ["undefined", "undefined"]
    )

    await run('__codegPicker.start("p1")')
    const overlay = await send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector("[data-codeg-picker]");
                            return JSON.stringify([!!el, el ? el.shadowRoot : null]) })()`,
      returnByValue: true,
    })
    check(
      "the highlight is on the page and its shadow root is closed to it",
      JSON.parse(overlay.result.result.value),
      [true, null]
    )

    const at = JSON.parse(
      await run(`(() => { const r = document.getElementById("count").getBoundingClientRect();
                          return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2,
                                                 w: r.width, h: r.height, left: r.left, top: r.top}) })()`)
    )
    const pressedBefore = await run(
      'document.getElementById("count").dataset.n || "0"'
    )
    const mouse = (type, button, buttons) =>
      send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    await mouse("mouseMoved", "none", 0)
    await mouse("mousePressed", "left", 1)
    await mouse("mouseReleased", "left", 0)
    await sleep(120)
    const picks = JSON.parse(await run("JSON.stringify(__picks)"))
    const picked = picks[0]?.payload
    check(
      "a pick reports the element the pointer was on",
      [
        picks.length,
        picks[0]?.kind,
        picks[0]?.top,
        picked?.id,
        picked?.tag,
        picked?.label,
        picked?.selector,
        picked?.text,
        picked?.html?.startsWith('<button id="count"'),
        picked?.path?.slice(-2).join(" > "),
      ],
      [
        1,
        "pick",
        true,
        "p1",
        "button",
        "button#count",
        "#count",
        "Count",
        true,
        "section#act > button#count",
      ]
    )
    check(
      "the pick carries the box a screenshot would be cropped to",
      [
        Math.abs(picked.rect.width - at.w) < 1,
        Math.abs(picked.rect.x - at.left) < 1,
        picked.viewport.width > 0,
        picked.styles.length,
        picked.styles[0].name,
      ],
      [true, true, true, 16, "display"]
    )
    // The whole point of swallowing the press: the page's own handlers for
    // the element being chosen must not run.
    check(
      "choosing an element does not press it",
      await run('document.getElementById("count").dataset.n || "0"'),
      pressedBefore
    )
    // The overlay outlives the pick by the length of the drain — it is the
    // only thing that can swallow the second half of a double-click over a
    // frame — and then it goes. The highlight itself is hidden immediately,
    // inside a shadow root this side cannot look into.
    const stillUp = await run('!!document.querySelector("[data-codeg-picker]")')
    await sleep(800)
    check(
      "the overlay stays for the drain once something is picked, then goes",
      [stillUp, await run('!!document.querySelector("[data-codeg-picker]")')],
      [true, false]
    )

    // The person armed the pick, so something IS going to be handed over —
    // which is exactly why the page must not be the one choosing what. A
    // click the page dispatches itself decides nothing.
    await run('__codegPicker.start("forged")')
    await send("Runtime.evaluate", {
      expression: 'document.getElementById("exp").click()',
      returnByValue: true,
    })
    await sleep(80)
    check(
      "a click the page dispatched itself does not choose",
      [
        JSON.parse(await run("JSON.stringify(__picks)")).length - 1,
        await run('!!document.querySelector("[data-codeg-picker]")'),
      ],
      [0, true]
    )
    await run("__codegPicker.stop()")

    // A frame's events are dispatched in ITS window and never reach a listener
    // here, so the picker covers every visible frame with a patch of overlay.
    // Without it, choosing something over an iframe presses whatever is under
    // the pointer inside it.
    await run('__codegPicker.start("frame")')
    const frameBox = JSON.parse(
      await run(`(() => { const el = document.getElementById("frame");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}) })()`)
    )
    const frameMouse = (type, button, buttons) =>
      send("Input.dispatchMouseEvent", {
        type,
        x: frameBox.x,
        y: frameBox.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    // The patch over a frame is placed on the next paint, which the move
    // schedules; the press has to come after that frame.
    await frameMouse("mouseMoved", "none", 0)
    await sleep(80)
    await frameMouse("mousePressed", "left", 1)
    await frameMouse("mouseReleased", "left", 0)
    await sleep(120)
    const overFrame = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a press over a frame picks the frame, and does not reach into it",
      [
        overFrame[overFrame.length - 1]?.payload.tag,
        overFrame[overFrame.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("frame").contentDocument;
                    const b = d && d.getElementById("inner");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      ["iframe", "iframe#frame", "inner"]
    )
    check(
      "…and forty decoy frames in front of it change nothing, because nothing is enumerated",
      await run('document.querySelectorAll("iframe").length'),
      // Forty decoys, the real one, and the three that live in the top layer.
      44
    )

    // …and one inside an OPEN shadow root whose host carries more light
    // children than the walk's queue holds. Any order that takes light
    // content first never reaches the shadow root, and the frame inside it
    // goes uncovered — measured: inverting the two pushes makes this check
    // report the wrong frame AND press the button inside the buried one.
    await run('__codegPicker.start("deep")')
    const deepBox = JSON.parse(
      await run(`(() => { const host = document.getElementById("shadowed");
                          host.scrollIntoView({block: "center"});
                          const r = host.shadowRoot.querySelector("#deep").getBoundingClientRect();
                          return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}) })()`)
    )
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: deepBox.x,
      y: deepBox.y,
      button: "none",
      buttons: 0,
    })
    await sleep(140)
    for (const [type, button, buttons] of [
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: deepBox.x,
        y: deepBox.y,
        button,
        buttons,
        clickCount: 1,
      })
    }
    await sleep(140)
    const deep = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a frame inside an open shadow root its host tried to bury is covered too",
      [
        deep[deep.length - 1]?.payload.label,
        await run(
          `(() => { const f = document.getElementById("shadowed").shadowRoot.querySelector("#deep");
                    const b = f.contentDocument && f.contentDocument.getElementById("buried");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      ["iframe#deep", "buried"]
    )

    // …and one more boundary down, behind a light subtree of its own. Every
    // scope needs an allowance of its own or this is the one that starves.
    await run('__codegPicker.start("nested")')
    const nestedBox = JSON.parse(
      await run(`(() => { const outer = document.getElementById("shadowed").shadowRoot;
                          const host = outer.querySelector("div:last-of-type");
                          host.scrollIntoView({block: "center"});
                          const r = host.shadowRoot.querySelector("#nested").getBoundingClientRect();
                          return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}) })()`)
    )
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nestedBox.x,
      y: nestedBox.y,
      button: "none",
      buttons: 0,
    })
    await sleep(140)
    for (const [type, button, buttons] of [
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: nestedBox.x,
        y: nestedBox.y,
        button,
        buttons,
        clickCount: 1,
      })
    }
    await sleep(140)
    const nested = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a frame two shadow boundaries down is covered as well",
      [
        nested[nested.length - 1]?.payload.label,
        await run(
          `(() => { const outer = document.getElementById("shadowed").shadowRoot;
                    const f = outer.querySelector("div:last-of-type").shadowRoot.querySelector("#nested");
                    const b = f.contentDocument && f.contentDocument.getElementById("nestedbtn");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      ["iframe#nested", "nested"]
    )

    // The overlay takes the pointer events, so the page can only scroll if the
    // picker hands the scroll on. A person who cannot scroll to the thing they
    // want to pick cannot pick it.
    await run("window.scrollTo(0, 0)")
    await run('__codegPicker.start("wheel")')
    const scrolledFrom = await run("window.scrollY")
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 40,
      y: 120,
      deltaX: 0,
      deltaY: 300,
      button: "none",
      buttons: 0,
    })
    await sleep(160)
    // A scroller UNDER the pointer is the case that needs the forwarding: the
    // overlay is not inside it, so without a hand-off the engine would scroll
    // the page instead of the panel the person is pointing at.
    const panelAt = JSON.parse(
      await run(`(() => { const el = document.getElementById("panel");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          return JSON.stringify({x: r.left + 20, y: r.top + 20}) })()`)
    )
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: panelAt.x,
      y: panelAt.y,
      deltaX: 0,
      deltaY: 200,
      button: "none",
      buttons: 0,
    })
    await sleep(160)
    check(
      "scrolling still works while a pick is armed — the page, and the panel under the pointer",
      [
        (await run("window.scrollY")) > scrolledFrom,
        (await run('document.getElementById("panel").scrollTop')) > 0,
        JSON.parse(await run("JSON.stringify(__picks)")).length - nested.length,
      ],
      [true, true, 0]
    )
    await run("__codegPicker.stop()")

    // `position: fixed` stops meaning "the viewport" the moment an ancestor
    // has a transform. A page that slides its root element would slide the
    // overlay off with it and leave a strip where a press reaches the page.
    await run("window.scrollTo(0, 0)")
    await send("Runtime.evaluate", {
      expression:
        'document.documentElement.style.transform = "translate(200px, 100px)"',
      returnByValue: true,
    })
    await run('__codegPicker.start("moved")')
    await sleep(120)
    const covered = JSON.parse(
      await run(`JSON.stringify((() => {
        const h = document.querySelector("[data-codeg-picker]");
        const r = h.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top),
                Math.abs(r.width - window.innerWidth) < 2,
                Math.abs(r.height - window.innerHeight) < 2]
      })())`)
    )
    check(
      "a transform on the root element cannot slide the overlay off the viewport",
      covered,
      [0, 0, true, true]
    )
    await run("__codegPicker.stop()")
    await send("Runtime.evaluate", {
      expression: 'document.documentElement.style.transform = ""',
      returnByValue: true,
    })

    // A page that took pointer capture before the pick started makes every
    // pointer event name the element it captured to, wherever the pointer
    // really is. Asking the document instead of the event is what keeps the
    // pick honest.
    await run("window.scrollTo(0, 0)")
    const captureAt = JSON.parse(
      await run(`(() => { const el = document.getElementById("exp");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          const c = document.getElementById("count").getBoundingClientRect();
                          return JSON.stringify({x: r.left + 4, y: r.top + 4,
                                                 cx: c.left + 4, cy: c.top + 4}) })()`)
    )
    await run('__codegPicker.start("captured")')
    // The page grabs the pointer for #count while the pointer is over #exp.
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: captureAt.cx,
      y: captureAt.cy,
      button: "none",
      buttons: 0,
    })
    await send("Runtime.evaluate", {
      expression: `(() => { const el = document.getElementById("count");
                            window.addEventListener("pointerdown", (e) => {
                              try { el.setPointerCapture(e.pointerId) } catch { void 0 }
                            }, true); return true })()`,
      returnByValue: true,
    })
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: captureAt.x,
        y: captureAt.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    }
    await sleep(140)
    const captured = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "pointer capture cannot make a press report the captured element",
      captured[captured.length - 1]?.payload.label,
      "button#exp"
    )

    // The overlay claims the maximum z-index, so what decides between it and
    // a page element that claims the same is tree order. A page that appends
    // its own frame after ours would otherwise paint over the overlay and
    // take the press into itself.
    await run("window.scrollTo(0, 0)")
    await run('__codegPicker.start("cover")')
    await send("Runtime.evaluate", {
      expression: `(() => {
        const cover = document.createElement("iframe")
        cover.id = "cover"
        cover.style.cssText = "position:fixed;left:0;top:0;width:200px;height:80px;border:0;z-index:2147483647"
        cover.srcdoc = "<button id=coverbtn style=width:200px;height:80px>cover</button>"
        cover.addEventListener("load", () => {
          const b = cover.contentDocument.getElementById("coverbtn")
          if (b) b.addEventListener("click", () => { b.textContent = "PRESSED" })
        })
        document.documentElement.appendChild(cover)
        return true })()`,
      returnByValue: true,
    })
    await sleep(200)
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: 100,
        y: 40,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    }
    await sleep(160)
    const covering = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a frame the page appends after the overlay cannot take the press",
      [
        covering[covering.length - 1]?.payload.label,
        await run(
          `(() => { const f = document.getElementById("cover");
                    const b = f.contentDocument && f.contentDocument.getElementById("coverbtn");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      ["iframe#cover", "cover"]
    )
    await run('document.getElementById("cover").remove()')

    // A pick ends on the first click, and someone who double-clicks has
    // already sent the second one. It must not land on the page.
    await run(
      'document.getElementById("count").scrollIntoView({block: "center"})'
    )
    const twiceAt = JSON.parse(
      await run(`(() => { const r = document.getElementById("count").getBoundingClientRect();
                          return JSON.stringify({x: r.left + 4, y: r.top + 4}) })()`)
    )
    const pressedTwiceBefore = await run(
      'document.getElementById("count").dataset.n || "0"'
    )
    await run('__codegPicker.start("twice")')
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: twiceAt.x,
      y: twiceAt.y,
      button: "none",
      buttons: 0,
    })
    for (const count of [1, 2]) {
      for (const [type, buttons] of [
        ["mousePressed", 1],
        ["mouseReleased", 0],
      ]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: twiceAt.x,
          y: twiceAt.y,
          button: "left",
          buttons,
          clickCount: count,
        })
      }
    }
    await sleep(160)
    const twice = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "the second half of a double-click neither picks again nor presses",
      [
        twice[twice.length - 1]?.payload.label,
        await run('document.getElementById("count").dataset.n || "0"'),
      ],
      ["button#count", pressedTwiceBefore]
    )
    // Let the drain window close before the next section.
    await sleep(800)

    // Keys belong to the picker while it is armed. Enter in a text field
    // submits its form with no click for the picker to cancel, so the key
    // itself has to be eaten.
    await run('__codegPicker.start("keys")')
    await run('document.getElementById("name").focus()')
    for (const type of ["keyDown", "char", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        text: "\r",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
    await sleep(100)
    check(
      "Enter while armed neither submits the form nor picks anything",
      [
        JSON.parse(await run("JSON.stringify(__picks)")).length - twice.length,
        await run('document.getElementById("f").dataset.submitted ?? "none"'),
      ],
      // Nothing new reported, and the form still shows the submission an
      // EARLIER section made — this one did not add to it.
      [0, "Grace"]
    )
    await run("__codegPicker.stop()")

    // The page can reach the host node (it is in its DOM) and try to make it
    // hit-testable, so that every press lands on the overlay. What it must
    // not be able to do is make a press over one element report another: the
    // element under the pointer is looked up, never carried over from the
    // last thing hovered.
    await run('__codegPicker.start("meddled")')
    const hoverAt = JSON.parse(
      await run(`(() => { const el = document.getElementById("count");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          const e = document.getElementById("exp").getBoundingClientRect();
                          return JSON.stringify({ax: r.left + 4, ay: r.top + 4, bx: e.left + 4, by: e.top + 4}) })()`)
    )
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hoverAt.ax,
      y: hoverAt.ay,
      button: "none",
      buttons: 0,
    })
    await sleep(60)
    await send("Runtime.evaluate", {
      // The page's own world, reaching for our node.
      expression: `(() => { const h = document.querySelector("[data-codeg-picker]");
                            h.style.cssText = "position:fixed;inset:0;pointer-events:auto;z-index:2147483647";
                            return true })()`,
      returnByValue: true,
    })
    for (const [type, button, buttons] of [
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: hoverAt.bx,
        y: hoverAt.by,
        button,
        buttons,
        clickCount: 1,
      })
    }
    await sleep(120)
    const meddled = JSON.parse(await run("JSON.stringify(__picks)"))
    const meddledPick = meddled[meddled.length - 1]?.payload
    check(
      "a page that makes the overlay hit-testable cannot make a press report another element",
      [
        meddledPick?.cancelled === true || meddledPick?.label === "button#exp",
        meddledPick?.label !== "button#count",
      ],
      [true, true]
    )
    await run("__codegPicker.stop()")

    // A field cut between the halves of a surrogate pair would put a lone
    // surrogate escape in the JSON, which the host's parser refuses outright
    // — the whole report, lost to one emoji.
    await run(`(() => { const el = document.getElementById("emoji");
                        el.setAttribute("role", "a".repeat(63) + "\u{1F600}b");
                        el.scrollIntoView({block: "center"}); return true })()`)
    await run('__codegPicker.start("emoji")')
    const emojiAt = JSON.parse(
      await run(`(() => { const r = document.getElementById("emoji").getBoundingClientRect();
                          return JSON.stringify({x: r.left + 2, y: r.top + 2}) })()`)
    )
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: emojiAt.x,
        y: emojiAt.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    }
    await sleep(120)
    check(
      "a field cut mid-emoji still parses as JSON on the other side",
      JSON.parse(
        await run(`JSON.stringify((() => {
          const m = __sent[__sent.length - 1] || "";
          const p = __picks[__picks.length - 1]?.payload || {};
          let ok = true; try { JSON.parse(m) } catch { ok = false }
          const role = String(p.role || "");
          const tail = role.charCodeAt(role.length - 2);
          return [ok, p.label, role.length, tail >= 0xd800 && tail <= 0xdbff]
        })())`)
      ),
      // Parses, names the element, cut to 63 + the ellipsis rather than 64,
      // and does not end on half a character.
      [true, "div#emoji", 64, false]
    )

    const before = JSON.parse(await run("JSON.stringify(__picks)")).length
    // A page can make the report enormous — every field is capped in
    // CHARACTERS, and one character can cost six bytes once JSON escapes it.
    // The channel drops an oversized message, which would leave the person
    // waiting on a pick they made, so the picker sheds and says that it did.
    await run(`(() => { const el = document.getElementById("fat");
                        for (let i = 0; i < 30; i++) el.setAttribute("data-a" + i, "\u0001".repeat(400));
                        el.textContent = "\u0001".repeat(6000); return true })()`)
    await run('__codegPicker.start("fat")')
    const fatBox = JSON.parse(
      await run(`(() => { const el = document.getElementById("fat");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          return JSON.stringify({x: r.left + 2, y: r.top + 2}) })()`)
    )
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: fatBox.x,
        y: fatBox.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
    }
    await sleep(150)
    check(
      "a report the page made enormous still fits the channel, once, and says it was cut",
      JSON.parse(
        await run(`JSON.stringify((() => {
          const m = __sent[__sent.length - 1] || "";
          const p = __picks[__picks.length - 1]?.payload || {};
          return [__picks.length - ${before}, new TextEncoder().encode(m).length <= 65536,
                  p.tag, p.label, p.trimmed === true]
        })())`)
      ),
      [1, true, "div", "div#fat", true]
    )

    await run('__codegPicker.start("p2")')
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await sleep(80)
    const after = JSON.parse(await run("JSON.stringify(__picks)"))
    const last = after[after.length - 1]?.payload
    check(
      "Escape calls the pick off, and says which one",
      [
        last?.cancelled,
        last?.id,
        await run('!!document.querySelector("[data-codeg-picker]")'),
      ],
      [true, "p2", false]
    )

    // The page moves the host somewhere it cannot be seen. Connected, and the
    // only child of its new parent, so every check the overlay makes about
    // itself still passes — and a rect says nothing about being rendered.
    await run('__codegPicker.start("moved")')
    await run(
      'document.getElementById("trap").appendChild(document.querySelector("[data-codeg-picker]"))'
    )
    // Two guard ticks: one to notice, and the overlay is back on the first.
    await sleep(900)
    const movedBox = JSON.parse(
      await run(`(() => { const el = document.getElementById("frame");
                          el.scrollIntoView({block: "center"});
                          const r = el.getBoundingClientRect();
                          return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}) })()`)
    )
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: movedBox.x,
        y: movedBox.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
      if (type === "mouseMoved") await sleep(80)
    }
    await sleep(160)
    const moved = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "moving the overlay into a hidden wrapper does not hand the page the press",
      [
        moved[moved.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("frame").contentDocument;
                    const b = d && d.getElementById("inner");
                    return b ? b.textContent : "no frame document" })()`
        ),
        await run(
          '(document.querySelector("[data-codeg-picker]") || {}).parentElement?.tagName ?? "none"'
        ),
      ],
      // Picked the frame, left its button alone, and the overlay is back on
      // the root element rather than in the page's wrapper.
      ["iframe#frame", "inner", "HTML"]
    )
    await sleep(800)

    // `inert` is the one attribute that takes a press away without changing
    // anything the overlay can see about itself: it is still connected, still
    // styled, still the right size, still the topmost thing at every point.
    const beforeInert = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("inert")')
    await run(
      'document.querySelector("[data-codeg-picker]").setAttribute("inert", "")'
    )
    await sleep(500)
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: movedBox.x,
        y: movedBox.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
      if (type === "mouseMoved") await sleep(80)
    }
    await sleep(160)
    const inerted = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "marking the overlay inert does not hand the page the press",
      [
        // Counted, not just read off the end: with no pick reported at all the
        // last entry is the PREVIOUS check's, which happens to name the same
        // frame — and the check would pass while nothing worked.
        inerted.length - beforeInert.length,
        inerted[inerted.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("frame").contentDocument;
                    const b = d && d.getElementById("inner");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      [1, "iframe#frame", "inner"]
    )
    await sleep(800)

    // …and a page that puts it back faster than the guard takes it off. The
    // overlay cannot win that, so it must not pretend it did: `owns()` asks
    // the engine whether it is inert, and the pick ends.
    const beforeFight = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("inertfight")')
    await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector("[data-codeg-picker]")
        globalThis.__fight = new MutationObserver(() => {
          if (!el.hasAttribute("inert")) el.setAttribute("inert", "")
        })
        globalThis.__fight.observe(el, {attributes: true})
        el.setAttribute("inert", "")
        return true })()`,
      returnByValue: true,
    })
    await sleep(1400)
    const fought = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a page that keeps the overlay inert ends the pick instead of winning quietly",
      [
        fought.length - beforeFight.length,
        fought[fought.length - 1]?.payload.cancelled,
        fought[fought.length - 1]?.payload.id,
      ],
      [1, true, "inertfight"]
    )
    await send("Runtime.evaluate", {
      expression:
        '(() => { globalThis.__fight.disconnect(); document.querySelectorAll("[inert]").forEach((n) => n.removeAttribute("inert")); return true })()',
      returnByValue: true,
    })
    await sleep(300)

    // The second half of a double-click over an IFRAME. The first press ends
    // the pick, and from that moment the only thing between the second press
    // and the frame is the overlay — a drain made of listeners on this window
    // never sees an event dispatched inside one.
    // Counted from here, not from an older snapshot: a baseline taken before
    // the checks in between silently turns "exactly one pick" into "three".
    const beforeTwiceFrame = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("twiceframe")')
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: movedBox.x,
      y: movedBox.y,
      button: "none",
      buttons: 0,
    })
    await sleep(80)
    for (const count of [1, 2]) {
      for (const [type, buttons] of [
        ["mousePressed", 1],
        ["mouseReleased", 0],
      ]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: movedBox.x,
          y: movedBox.y,
          button: "left",
          buttons,
          clickCount: count,
        })
      }
    }
    await sleep(160)
    const twiceFrame = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "the second half of a double-click over a frame does not reach into it",
      [
        twiceFrame.length - beforeTwiceFrame.length,
        twiceFrame[twiceFrame.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("frame").contentDocument;
                    const b = d && d.getElementById("inner");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      [1, "iframe#frame", "inner"]
    )
    await sleep(800)

    // Focus can be sitting inside a child frame when the pick starts — the
    // page can put it there — and a key event raised in one never reaches this
    // window. Enter would press whatever that frame has focused.
    await run(
      `(() => { const f = document.getElementById("frame");
                f.contentWindow.focus();
                f.contentDocument.getElementById("inner").focus();
                return true })()`
    )
    await run('__codegPicker.start("framekeys")')
    await sleep(80)
    for (const type of ["keyDown", "char", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        text: "\r",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
    await sleep(120)
    check(
      "Enter cannot press a button a child frame had focused",
      [
        JSON.parse(await run("JSON.stringify(__picks)")).length -
          twiceFrame.length,
        await run(
          `(() => { const d = document.getElementById("frame").contentDocument;
                    const b = d && d.getElementById("inner");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      [0, "inner"]
    )
    await run("__codegPicker.stop()")

    // The top layer is painted above every ordinary child of the document,
    // whatever z-index they claim. A page that opens a popover of its own
    // would otherwise paint over the overlay — so the overlay joins the top
    // layer too, and being the later arrival puts it back on top.
    const popped = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("popover")')
    // …and the page strips the attribute that lets the overlay in there at
    // all. It is in the page's DOM, so the page can; the guard puts it back.
    await run(
      'document.querySelector("[data-codeg-picker]").removeAttribute("popover")'
    )
    await run('document.getElementById("pop").showPopover()')
    await sleep(500)
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: 120,
        y: 120,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
      if (type === "mouseMoved") await sleep(80)
    }
    await sleep(160)
    const overPop = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a popover the page opens cannot take the press off the overlay",
      [
        overPop.length - popped.length,
        overPop[overPop.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("popframe").contentDocument;
                    const b = d && d.querySelector("button");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      [1, "iframe#popframe", "popover"]
    )
    await run('document.getElementById("pop").hidePopover()')
    await sleep(800)

    // …and a SMALL one, placed between every point `owns()` samples. Sampling
    // is a bounded check and a page can step between the samples, so what
    // keeps the overlay in front cannot be the samples: it re-enters the top
    // layer every tick, and order in there is order of entry.
    const beforeSmall = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("smallpop")')
    await run('document.getElementById("smallpop").showPopover()')
    await sleep(700)
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: 260,
        y: 180,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
      if (type === "mouseMoved") await sleep(80)
    }
    await sleep(160)
    const overSmall = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a small popover between the sampled points cannot take the press either",
      [
        overSmall.length - beforeSmall.length,
        overSmall[overSmall.length - 1]?.payload.label,
        await run(
          `(() => { const d = document.getElementById("smallframe").contentDocument;
                    const b = d && d.querySelector("button");
                    return b ? b.textContent : "no frame document" })()`
        ),
      ],
      [1, "iframe#smallframe", "small"]
    )
    await run('document.getElementById("smallpop").hidePopover()')
    await sleep(800)

    // Every other handler here refuses an event the page made up. This one
    // took `pagehide` at its word, and ending a pick takes the overlay down.
    const beforeFakeHide = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('__codegPicker.start("fakehide")')
    await send("Runtime.evaluate", {
      expression: 'window.dispatchEvent(new Event("pagehide")), true',
      returnByValue: true,
    })
    await sleep(200)
    check(
      "a pagehide the page made up does not put the overlay away",
      [
        JSON.parse(await run("JSON.stringify(__picks)")).length -
          beforeFakeHide.length,
        await run('!!document.querySelector("[data-codeg-picker]")'),
      ],
      [0, true]
    )
    await run("__codegPicker.stop()")
    await sleep(200)

    // A modal dialog is the one the overlay cannot win: it makes everything
    // outside it inert, popovers included, so nothing this world puts on the
    // screen is handed the press. The picker cannot stop that press — what it
    // must not do is stay armed and let a person believe it will.
    const beforeModal = JSON.parse(await run("JSON.stringify(__picks)"))
    await run('document.getElementById("modal").showModal()')
    await run('__codegPicker.start("modal")')
    // Two guard ticks plus room: one failed check is not enough to act on.
    await sleep(1400)
    const blocked = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a modal dialog ends the pick instead of letting a press through unseen",
      [
        blocked.length - beforeModal.length,
        blocked[blocked.length - 1]?.payload.cancelled,
        blocked[blocked.length - 1]?.payload.id,
        await run('!!document.querySelector("[data-codeg-picker]")'),
      ],
      [1, true, "modal", false]
    )
    await run('document.getElementById("modal").close()')

    // Thirty-three shadow boundaries down. Giving up early is safe — the
    // answer is a host that really is above the pointer — but it is not the
    // element the person is pointing at.
    await run('__codegPicker.start("deep33")')
    const deepAt = JSON.parse(
      await run(`(() => { let node = document.getElementById("deepnest");
                          node.scrollIntoView({block: "center"});
                          const r = node.getBoundingClientRect();
                          return JSON.stringify({x: r.left + 8, y: r.top + 8}) })()`)
    )
    for (const [type, button, buttons] of [
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: deepAt.x,
        y: deepAt.y,
        button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      })
      if (type === "mouseMoved") await sleep(80)
    }
    await sleep(160)
    const deep33 = JSON.parse(await run("JSON.stringify(__picks)"))
    check(
      "a button thirty-three shadow roots down is named, not its outermost host",
      [
        deep33[deep33.length - 1]?.payload.label,
        await run(
          `(() => { let node = document.getElementById("deepnest");
                    for (let i = 0; i < 33 && node; i++) node = node.shadowRoot?.firstElementChild;
                    return node ? node.textContent : "not found" })()`
        ),
      ],
      ["button#bottom", "bottom"]
    )
    await sleep(800)
  }

  // ---- browser_eval's renderer, in the page's own world ------------------
  //
  // The one piece of this subsystem that does NOT run in the isolated world,
  // and the reason is the whole design: a snippet is inlined as source text
  // and can do anything, so it must not be anywhere near the intrinsics the
  // other tools' answers are built out of. Everything below runs where a real
  // `browser_eval` runs — `Runtime.evaluate` with no contextId — and reads
  // back the envelope the host parses.
  // NOT `run`: its `contextId` defaults to the isolated world, and passing
  // `undefined` takes the default — which is how the first version of these
  // checks ran the whole thing in codeg's world and still looked green until
  // the two world checks below went red.
  const inPage = async (expression) => {
    const { result } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails, null, 2))
    return result.result.value
  }
  const evalIn = async (code) => {
    // The host gets this as JSON of the expression's value: a JSON string
    // holding the envelope. CDP with returnByValue hands the string straight
    // over, so only the inner parse is here.
    return JSON.parse(await inPage(evalCall(code)))
  }

  check(
    "a returned string comes back as a string",
    await evalIn("return document.title"),
    { ok: true, kind: "string", value: "Probe", truncated: false }
  )
  check(
    "a number keeps its type and reads as text",
    await evalIn("return 6 * 7"),
    { ok: true, kind: "number", value: "42", truncated: false }
  )
  check(
    "a snippet that returns nothing says so rather than answering empty",
    await evalIn("document.title"),
    { ok: true, kind: "undefined", value: "undefined", truncated: false }
  )
  check(
    "an object comes back as JSON, an array as an array",
    [
      await evalIn('return {a: 1, b: "x"}'),
      (await evalIn("return [1, 2, 3]")).kind,
    ],
    [
      { ok: true, kind: "object", value: '{"a":1,"b":"x"}', truncated: false },
      "array",
    ]
  )
  // A node is described, not serialised: `JSON.stringify(element)` is `{}`,
  // which would tell an agent nothing at all.
  check(
    "an element is described by what it is",
    (await evalIn('return document.getElementById("exp")')).value,
    "<button#exp>"
  )
  // Nothing here waits, and a promise that came back as `{}` would look like
  // an empty object rather than like the mistake it is.
  check(
    "a promise is named as one instead of being awaited",
    [
      (await evalIn("return Promise.resolve(1)")).kind,
      (await evalIn("return Promise.resolve(1)")).value.includes(
        "does not wait"
      ),
    ],
    ["promise", true]
  )
  // The name and the message are the part of an exception anyone reads, and
  // on the WebKit ports `error.stack` is frames only — so the renderer puts
  // the head back. Chrome's stack already has it, which is exactly why this
  // check cannot be what proves the rule; a real WKWebView is (see the
  // package notes).
  const threw = await evalIn("return nope.missing")
  check(
    "a throw is an answer, with the exception named in it",
    [
      threw.ok,
      threw.error.startsWith("ReferenceError"),
      threw.error.includes("\n"),
    ],
    [false, true, true]
  )
  // An exception with no stack at all still says what it was.
  check(
    "a throw with no stack still names itself",
    (await evalIn('var e = new TypeError("bare"); delete e.stack; throw e'))
      .error,
    "TypeError: bare"
  )
  // And something that is not an Error at all is still described.
  check(
    "throwing a non-error still answers",
    (await evalIn('throw "just a string"')).error,
    "just a string"
  )
  // A page object that cannot be serialised must not take the whole call with
  // it: the fallback is `String(v)`, and an answer beats an error.
  check(
    "a cyclic object still answers",
    (await evalIn("var a = {}; a.self = a; return a")).ok,
    true
  )
  const long = await evalIn('return "x".repeat(9000)')
  check(
    "a long value stops at the cap and says it was cut",
    [long.value.length, long.truncated],
    [4000, true]
  )
  // The payoff of the surrogate rule: cutting at 4000 lands exactly between
  // the halves of an emoji here, and JSON.stringify would emit an escape for
  // half a character that the host's parser refuses outright — losing the
  // whole answer rather than one character of it.
  check(
    "a cut between the halves of a character does not cost the answer",
    (await evalIn('return "a".repeat(3999) + "🙂".repeat(10)')).value.length,
    3999
  )
  // A snippet is a function body, so a line comment at the end of it would
  // swallow the wrapper if the newline after it were ever dropped.
  check(
    "a snippet ending in a comment still parses",
    (await evalIn("return 1 // done")).value,
    "1"
  )
  // The world choice, measured: the page's own globals ARE visible (which is
  // what makes the tool useful) and the isolated world's are NOT (which is
  // what keeps a snippet away from the machinery every other tool's answer is
  // built from).
  await send("Runtime.evaluate", {
    expression: 'globalThis.__probePageGlobal = "from the page"',
    returnByValue: true,
  })
  check(
    "a snippet sees the page's own globals",
    (await evalIn("return globalThis.__probePageGlobal")).value,
    "from the page"
  )
  check(
    "a snippet cannot see codeg's world",
    (await evalIn("return typeof globalThis.__codegAgent")).value,
    "undefined"
  )
  // And leaves nothing behind in the page that would tell it codeg had run.
  check(
    "an evaluation leaves no names on the page",
    await inPage(
      'typeof globalThis.__codegEvalRender + "," + typeof globalThis.__codegEvalClip'
    ),
    "undefined,undefined"
  )

  // The premise the whole design rests on, measured instead of assumed: this
  // world cannot intercept the page's own history calls, which is why
  // deciding when refs die has to be the host's job. Patch
  // `History.prototype.pushState` here, then have the *page* navigate, and
  // watch the patch not fire. Last, because it leaves the page elsewhere.
  await run(`globalThis.__patchFired = false;
             History.prototype.pushState = new Proxy(History.prototype.pushState, {
               apply(t, self, args) { globalThis.__patchFired = true;
                                      return Reflect.apply(t, self, args) } })`)
  const before = await run("location.href")
  await send("Runtime.evaluate", {
    // No contextId: the page's own world, holding its own History.prototype.
    expression: 'history.pushState({}, "", "?from-the-page")',
    returnByValue: true,
  })
  check(
    "a page's own pushState is invisible to a patch in this world",
    [
      await run("globalThis.__patchFired"),
      (await run("location.href")) !== before,
    ],
    // Did not fire, yet the address did move — so the page really navigated
    // and the patch really did not see it.
    [false, true]
  )

  console.log(failures ? `\n${failures} failed` : "\nall checks passed")
} finally {
  ws?.close()
  chrome.kill()
}

process.exit(failures ? 1 : 0)
