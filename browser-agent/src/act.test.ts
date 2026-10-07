import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clickAt,
  isDisabledControl,
  keyDescription,
  pointerReach,
  pressOn,
  scrollerFor,
  selectIn,
  typeInto,
} from "./act"

/**
 * What can be proved under jsdom: the event sequences, the key table, the
 * default actions that are emulated, and the direct-set fallback for text
 * (jsdom has no `execCommand`, which is exactly the path an engine takes for
 * an input type with no selection). Where a box on screen matters —
 * `pointAt`, `obstructionAt`, the trusted path's `locate` — jsdom reports
 * every element as zero-sized, and the Chrome probe covers it instead.
 */

function mount(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("clickAt", () => {
  it("delivers the sequence a page expects of a click, and focuses like a mousedown would", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    const seen: string[] = []
    for (const type of [
      "mouseover",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
    ])
      button.addEventListener(type, () => seen.push(type))
    clickAt(button, { x: 10, y: 10 }, "left", 1)
    expect(seen).toEqual(["mouseover", "mousedown", "mouseup", "click"])
    expect(document.activeElement).toBe(button)
  })

  it("does not move focus when the page cancelled the mousedown", () => {
    const root = mount(`<input id="keep"><button id="b">Go</button>`)
    const keep = root.querySelector<HTMLInputElement>("#keep")!
    const button = root.querySelector("button")!
    keep.focus()
    button.addEventListener("mousedown", (e) => e.preventDefault())
    clickAt(button, { x: 10, y: 10 }, "left", 1)
    expect(document.activeElement).toBe(keep)
  })

  it("adds a dblclick after two clicks and a contextmenu for the right button", () => {
    const root = mount(`<div id="d" tabindex="0">x</div>`)
    const div = root.querySelector("div")!
    const seen: string[] = []
    for (const type of ["click", "dblclick", "contextmenu"])
      div.addEventListener(type, () => seen.push(type))
    clickAt(div, { x: 1, y: 1 }, "left", 2)
    expect(seen).toEqual(["click", "click", "dblclick"])
    seen.length = 0
    clickAt(div, { x: 1, y: 1 }, "right", 1)
    expect(seen).toEqual(["contextmenu"])
  })

  // A dispatched click still carries the element's activation behaviour:
  // that is the difference between clicking a checkbox and telling it about
  // a click.
  // The Pointer Events rule: a cancelled pointerdown suppresses the
  // compatibility mouse events and the focus change, and click still comes.
  it("suppresses mousedown, mouseup and focus when pointerdown was cancelled", () => {
    const root = mount(`<input id="keep"><button id="b">Go</button>`)
    const keep = root.querySelector<HTMLInputElement>("#keep")!
    const button = root.querySelector("button")!
    keep.focus()
    const seen: string[] = []
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"])
      button.addEventListener(type, (e) => {
        seen.push(type)
        if (type === "pointerdown") e.preventDefault()
      })
    clickAt(button, { x: 1, y: 1 }, "left", 1)
    // jsdom has no PointerEvent, so the pointer events arrive as MouseEvents
    // under the pointer type names; the ordering is what is asserted.
    expect(seen).toEqual(["pointerdown", "click"])
    expect(document.activeElement).toBe(keep)
  })

  it("stops a multi-click once the page is no longer the one the ref came from", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    let clicks = 0
    let doubles = 0
    button.addEventListener("click", () => clicks++)
    button.addEventListener("dblclick", () => doubles++)
    let current = true
    const delivered = clickAt(button, { x: 1, y: 1 }, "left", 3, () => {
      const answer = current
      current = false
      return answer
    })
    expect(delivered).toBe(2)
    expect(clicks).toBe(2)
    // A run that was stopped short sends nothing further to the element.
    expect(doubles).toBe(0)
  })

  it("activates the element: a checkbox toggles", () => {
    const root = mount(`<input type="checkbox" id="c">`)
    const box = root.querySelector<HTMLInputElement>("input")!
    clickAt(box, { x: 1, y: 1 }, "left", 1)
    expect(box.checked).toBe(true)
  })
})

describe("typeInto", () => {
  it("replaces the value and tells the page in the order a keyboard would", () => {
    const root = mount(`<input id="q" value="old">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const seen: string[] = []
    input.addEventListener("input", (e) =>
      seen.push(`input:${(e.target as HTMLInputElement).value}`)
    )
    input.addEventListener("change", () => seen.push("change"))
    expect(typeInto(input, "new")).toBeNull()
    expect(input.value).toBe("new")
    expect(seen).toEqual(["input:new", "change"])
    expect(document.activeElement).toBe(input)
  })

  // The value is set through the prototype's setter, not the instance: a
  // page that put a tracking property on the node (React's value tracker) has
  // to see the new value when the `input` event arrives, or it decides
  // nothing changed and drops the event.
  it("sets the value on the element, past an instance property a page defined", () => {
    const root = mount(`<input id="q">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!
    let tracked = ""
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => setter.get!.call(input),
      set: (v: string) => {
        tracked = v
        setter.set!.call(input, v)
      },
    })
    typeInto(input, "typed")
    // The instance setter never ran — the prototype's did — so the page's
    // tracker still holds the old value, which is the state in which React
    // notices a change.
    expect(tracked).toBe("")
    expect(setter.get!.call(input)).toBe("typed")
  })

  it("follows a label to its control and reaches into a wrapper", () => {
    const root = mount(
      `<label for="n">Name</label><input id="n"><div id="wrap"><textarea></textarea></div>`
    )
    expect(typeInto(root.querySelector("label")!, "Ada")).toBeNull()
    expect(root.querySelector<HTMLInputElement>("#n")!.value).toBe("Ada")
    expect(typeInto(root.querySelector("#wrap")!, "notes")).toBeNull()
    expect(root.querySelector("textarea")!.value).toBe("notes")
  })

  it("refuses what takes no text, and says so", () => {
    const root = mount(
      `<button id="b">Go</button><input id="ro" readonly><input id="dis" disabled><input id="cb" type="checkbox">`
    )
    expect(typeInto(root.querySelector("#b")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(typeInto(root.querySelector("#ro")!, "x")?.detail).toContain(
      "read-only"
    )
    expect(typeInto(root.querySelector("#dis")!, "x")).toMatchObject({
      error: "disabled",
    })
    // Disabled through the fieldset, with nothing on the field itself.
    const fenced = mount(`<fieldset disabled><input id="f"></fieldset>`)
    expect(typeInto(fenced.querySelector("#f")!, "x")).toMatchObject({
      error: "disabled",
    })
    expect(typeInto(root.querySelector("#cb")!, "x")).toMatchObject({
      error: "not-editable",
    })
  })

  // A label may lead to its control, but only to one a person could reach:
  // a hidden input behind a visible label is not typed into.
  it("does not follow a label or a wrapper to a hidden control", () => {
    const root = mount(
      `<label for="h">Public</label><input id="h" style="display:none"><div id="w"><textarea style="visibility:hidden"></textarea></div>
       <label for="deep">Deep</label><div style="display:none"><div><input id="deep"></div></div>`
    )
    expect(typeInto(root.querySelector("label")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(typeInto(root.querySelector("#w")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(root.querySelector<HTMLInputElement>("#h")!.value).toBe("")
    // Hidden by an ancestor: the control's own display is still "inline-block".
    expect(
      typeInto(root.querySelector('label[for="deep"]')!, "x")
    ).toMatchObject({ error: "not-editable" })
    expect(root.querySelector<HTMLInputElement>("#deep")!.value).toBe("")
  })

  // The fallback walk (engines without `checkVisibility`) treats a
  // `content-visibility: hidden` ancestor like `display: none`.
  it("does not reach a control under a content-visibility: hidden ancestor", () => {
    const root = mount(
      `<label for="cv">Folded</label><section id="fold"><input id="cv"></section>`
    )
    const fold = root.querySelector("#fold")!
    const original = window.getComputedStyle.bind(window)
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((el: Element) => {
        const style = original(el)
        if (el === fold)
          Object.defineProperty(style, "contentVisibility", {
            value: "hidden",
            configurable: true,
          })
        return style
      })
    try {
      expect(typeInto(root.querySelector("label")!, "x")).toMatchObject({
        error: "not-editable",
      })
      expect(root.querySelector<HTMLInputElement>("#cv")!.value).toBe("")
    } finally {
      spy.mockRestore()
    }
  })

  it("clears a field when given nothing", () => {
    const root = mount(`<input id="q" value="old">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    expect(typeInto(input, "")).toBeNull()
    expect(input.value).toBe("")
  })
})

describe("keyDescription", () => {
  it("knows the named keys, single characters and modifier chords", () => {
    expect(keyDescription("Enter")).toMatchObject({
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      printable: false,
    })
    expect(keyDescription("a")).toMatchObject({
      key: "a",
      code: "KeyA",
      keyCode: 65,
      printable: true,
    })
    expect(keyDescription("7")).toMatchObject({ code: "Digit7", keyCode: 55 })
    expect(keyDescription("Control+Shift+k")).toMatchObject({
      key: "k",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    })
    expect(keyDescription("Meta+Enter")).toMatchObject({
      key: "Enter",
      meta: true,
    })
    expect(keyDescription("Cmd+a")).toMatchObject({ key: "a", meta: true })
  })

  it("accepts the aliases people type and a literal plus", () => {
    expect(keyDescription("Esc")?.key).toBe("Escape")
    expect(keyDescription("Return")?.key).toBe("Enter")
    expect(keyDescription(" ")).toMatchObject({ key: " ", code: "Space" })
    expect(keyDescription("Space")).toMatchObject({ key: " ", code: "Space" })
    expect(keyDescription("Shift++")).toMatchObject({ key: "+", shift: true })
  })

  it("refuses a name it does not know rather than inventing a key", () => {
    expect(keyDescription("Foo")).toBeNull()
    expect(keyDescription("Hyper+a")).toBeNull()
    expect(keyDescription("")).toBeNull()
  })
})

describe("pressOn", () => {
  it("dispatches keydown and keyup on the element, focusing it first", () => {
    const root = mount(`<input id="q">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const seen: string[] = []
    input.addEventListener("keydown", (e) =>
      seen.push(`down:${e.key}:${e.code}`)
    )
    input.addEventListener("keyup", (e) => seen.push(`up:${e.key}`))
    expect(pressOn(input, "Escape")).toEqual({ scrolled: null })
    expect(seen).toEqual(["down:Escape:Escape", "up:Escape"])
    expect(document.activeElement).toBe(input)
  })

  it("goes to whatever has focus when given no element", () => {
    const root = mount(`<input id="a"><input id="b">`)
    const b = root.querySelector<HTMLInputElement>("#b")!
    b.focus()
    const seen: string[] = []
    b.addEventListener("keydown", (e) => seen.push(e.key))
    pressOn(null, "ArrowDown")
    expect(seen).toEqual(["ArrowDown"])
  })

  // The default action an agent presses Enter *for*. Through the default
  // button when there is one, so that button's own handler runs the way it
  // would for a person.
  it("submits a text field's form on Enter through its default button", () => {
    const root = mount(
      `<form id="f"><input id="q"><button type="submit" id="go">Go</button></form>`
    )
    const form = root.querySelector("form")!
    const seen: string[] = []
    root
      .querySelector("#go")!
      .addEventListener("click", () => seen.push("button"))
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      seen.push("submit")
    })
    pressOn(root.querySelector("#q")!, "Enter")
    expect(seen).toEqual(["button", "submit"])
  })

  it("does not submit when a keydown handler cancelled Enter", () => {
    const root = mount(
      `<form><input id="q"><button type="submit">Go</button></form>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    const input = root.querySelector<HTMLInputElement>("#q")!
    input.addEventListener("keydown", (e) => e.preventDefault())
    pressOn(input, "Enter")
    expect(submitted).not.toHaveBeenCalled()
  })

  it("does not submit a buttonless form with two text fields, as the spec says", () => {
    const root = mount(`<form><input id="a"><input id="b"></form>`)
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    pressOn(root.querySelector("#a")!, "Enter")
    expect(submitted).not.toHaveBeenCalled()
  })

  it("activates a button on Enter and on Space", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    const clicked = vi.fn()
    button.addEventListener("click", clicked)
    pressOn(button, "Enter")
    pressOn(button, "Space")
    expect(clicked).toHaveBeenCalledTimes(2)
  })

  it("types a printable key into the field, after a keypress the page may cancel", () => {
    const root = mount(`<input id="q" value="ab">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    input.focus()
    input.setSelectionRange(2, 2)
    pressOn(input, "c")
    expect(input.value).toBe("abc")
    input.addEventListener("keypress", (e) => e.preventDefault())
    pressOn(input, "d")
    expect(input.value).toBe("abc")
  })

  it("moves focus on Tab, and back on Shift+Tab", () => {
    const root = mount(`<input id="a"><input id="b"><input id="c">`)
    // jsdom has no layout; make the tabbable check see boxes.
    for (const el of root.querySelectorAll("input"))
      vi.spyOn(el, "getClientRects").mockReturnValue([
        new DOMRect(0, 0, 10, 10),
      ] as unknown as DOMRectList)
    const a = root.querySelector<HTMLInputElement>("#a")!
    pressOn(a, "Tab")
    expect(document.activeElement?.id).toBe("b")
    pressOn(null, "Tab")
    expect(document.activeElement?.id).toBe("c")
    pressOn(null, "Shift+Tab")
    expect(document.activeElement?.id).toBe("b")
  })

  it("does not submit on Alt+Enter, and does submit on Meta+Enter", () => {
    const root = mount(
      `<form><input id="q"><button type="submit">Go</button></form>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    const input = root.querySelector<HTMLInputElement>("#q")!
    pressOn(input, "Alt+Enter")
    expect(submitted).not.toHaveBeenCalled()
    pressOn(input, "Meta+Enter")
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it("refuses a disabled control, and never submits from one", () => {
    const root = mount(
      `<form><input id="d" disabled><button type="submit">Go</button></form><fieldset disabled><button id="in">In</button></fieldset>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    expect(pressOn(root.querySelector("#d")!, "Enter")).toMatchObject({
      error: "disabled",
    })
    expect(submitted).not.toHaveBeenCalled()
    expect(isDisabledControl(root.querySelector("#in")!)).toBe(true)
    expect(isDisabledControl(root.querySelector("button[type=submit]")!)).toBe(
      false
    )
  })

  it("names an unknown key instead of pressing something else", () => {
    const root = mount(`<input>`)
    expect(pressOn(root.querySelector("input")!, "Bogus")).toMatchObject({
      error: "unsupported",
    })
  })

  // A dispatched key has no default action at all, so without this a PageDown
  // reports "done" over a page that never moved — a false success, which
  // leaves an agent reading the next snapshot as a page that refused to
  // scroll rather than as a key that never landed.
  it("scrolls on the page keys, which a dispatched key does not do by itself", () => {
    mount(`<p>text</p>`)
    const scroller = pageScroller()
    givenScrollRoom(scroller, 3000, 800)
    const to = watchScrolling(scroller)
    pressOn(null, "PageDown")
    expect(tops(to)).toEqual([700])
    pressOn(null, "End")
    pressOn(null, "Home")
    expect(tops(to)).toEqual([700, 3000, 0])
  })

  it("pages up from wherever the scroller is", () => {
    mount(`<p>text</p>`)
    const scroller = pageScroller()
    givenScrollRoom(scroller, 3000, 800, 1000)
    const to = watchScrolling(scroller)
    pressOn(null, "PageUp")
    expect(tops(to)).toEqual([300])
  })

  it("leaves the page alone when a handler cancelled the key", () => {
    mount(`<p>text</p>`)
    const to = watchScrolling(pageScroller())
    const stop = (e: Event) => e.preventDefault()
    addEventListener("keydown", stop)
    pressOn(null, "PageDown")
    removeEventListener("keydown", stop)
    expect(to).not.toHaveBeenCalled()
  })

  // Home and End are the field's own — they put the caret at the ends of a
  // line. PageUp and PageDown are not: a single-line field has no pages to
  // move through, and an engine pages the document from there, which is the
  // state an agent is in every time it has just typed into something.
  it("holds back only the caret keys in a text field", () => {
    const root = mount(`<input id="q">`)
    const to = watchScrolling(pageScroller())
    const input = root.querySelector<HTMLInputElement>("#q")!
    pressOn(input, "End")
    pressOn(input, "Home")
    expect(to).not.toHaveBeenCalled()
    pressOn(input, "PageDown")
    expect(to).toHaveBeenCalledTimes(1)
  })

  it("leaves a listbox's own keys to it", () => {
    const root = mount(
      `<select id="s"><option>a</option><option>b</option></select>`
    )
    const to = watchScrolling(pageScroller())
    pressOn(root.querySelector("#s")!, "PageDown")
    pressOn(root.querySelector("#s")!, "End")
    expect(to).not.toHaveBeenCalled()
  })

  // Ctrl+Home is the chord people actually press to get to the top of a long
  // page. Alt is nobody's scroll modifier — on some platforms it is back and
  // forward — and a modified page key is not a scroll anywhere.
  it("takes Control and Meta on the ends, and no modifier on the page keys", () => {
    mount(`<p>text</p>`)
    const scroller = pageScroller()
    givenScrollRoom(scroller, 3000, 800, 1500)
    const to = watchScrolling(scroller)
    pressOn(null, "Control+Home")
    expect(tops(to)).toEqual([0])
    pressOn(null, "Meta+End")
    expect(tops(to)).toEqual([0, 3000])
    pressOn(null, "Control+PageDown")
    pressOn(null, "Alt+Home")
    expect(tops(to)).toEqual([0, 3000])
  })

  // The numbers are the whole point: an agent cannot see the page, and the
  // tree it reads back is the document rather than the view of it, so this is
  // the only way to tell a scroll that moved from one with nowhere to go.
  it("reports how far it went, and says so when it went nowhere", () => {
    mount(`<p>text</p>`)
    const scroller = pageScroller()
    givenScrollRoom(scroller, 3000, 800)
    watchScrolling(scroller)
    expect(pressOn(null, "PageDown")).toEqual({
      scrolled: { by: 700, top: 700, max: 2200 },
    })
    expect(pressOn(null, "End")).toEqual({
      scrolled: { by: 1500, top: 2200, max: 2200 },
    })
    // At the end, and honest about it rather than reporting another success.
    expect(pressOn(null, "PageDown")).toEqual({
      scrolled: { by: 0, top: 2200, max: 2200 },
    })
    // A key that is not a scroll key says nothing about scrolling at all.
    expect(pressOn(null, "Escape")).toEqual({ scrolled: null })
  })
})

describe("scrollerFor", () => {
  it("takes the nearest ancestor that scrolls, and the document when none does", () => {
    const root = mount(
      `<div id="pane" style="overflow-y:auto"><p id="inside">text</p></div><p id="loose">text</p>`
    )
    const pane = root.querySelector<HTMLElement>("#pane")!
    givenScrollRoom(pane, 800, 80)
    expect(scrollerFor(root.querySelector("#inside")!)).toBe(pane)
    expect(scrollerFor(root.querySelector("#loose")!)).toBe(pageScroller())
  })

  it("passes over room without overflow, and overflow without room", () => {
    const root = mount(
      `<div id="tall"><div id="clipped" style="overflow-y:auto"><p id="leaf">text</p></div></div>`
    )
    // Content past its box, but the box shows all of it rather than scrolling.
    givenScrollRoom(root.querySelector<HTMLElement>("#tall")!, 800, 80)
    // Set to scroll, with nothing to scroll.
    givenScrollRoom(root.querySelector<HTMLElement>("#clipped")!, 80, 80)
    expect(scrollerFor(root.querySelector("#leaf")!)).toBe(pageScroller())
  })

  // `height: 0; overflow: auto` is how an accordion is animated shut. It
  // satisfies "content past its box" while having nowhere to put a page key,
  // and taking it would swallow the key the document should have had.
  it("passes over a box collapsed to no height", () => {
    const root = mount(
      `<div id="shut" style="overflow-y:auto"><p id="leaf">text</p></div>`
    )
    givenScrollRoom(root.querySelector<HTMLElement>("#shut")!, 800, 0)
    expect(scrollerFor(root.querySelector("#leaf")!)).toBe(pageScroller())
  })

  // The layout most applications ship: `html, body { overflow: hidden }` with
  // a full-height box inside doing the scrolling. A ref-less key lands on
  // `document.body`, whose walk ends at a scroller with nothing in it, and
  // answering "no more content than fits" there would be a false success
  // about a page with thousands of pixels left.
  it("takes the box under the middle of the screen when the page cannot move", () => {
    const root = mount(
      `<div id="shell" style="overflow-y:auto"><p id="leaf">text</p></div>`
    )
    const shell = root.querySelector<HTMLElement>("#shell")!
    givenScrollRoom(shell, 4000, 800)
    const asked = whereItLooked(root.querySelector("#leaf")!)
    expect(scrollerFor(document.body, false)).toBe(shell)
    // The middle of the screen and not some other point: the justification
    // for taking this box at all is that a wheel resting there would turn it.
    expect(asked.mock.calls).toEqual([
      [Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)],
    ])
  })

  // …and only then, so nothing here can take a key away from a document that
  // wanted it.
  it("leaves the page's own scroller alone while the page can still move", () => {
    const root = mount(
      `<div id="shell" style="overflow-y:auto"><p id="leaf">text</p></div>`
    )
    givenScrollRoom(root.querySelector<HTMLElement>("#shell")!, 4000, 800)
    givenScrollRoom(pageScroller(), 6000, 800)
    whereItLooked(root.querySelector("#leaf")!)
    expect(scrollerFor(document.body, false)).toBe(pageScroller())
  })

  // A caller that gave a `ref` pointed at a box and is owed an answer about
  // that box; moving a different one and reporting the pixels would read as
  // the named box having scrolled.
  it("does not re-route a press that named an element", () => {
    const root = mount(
      `<div id="shell" style="overflow-y:auto"><p id="leaf">text</p></div>` +
        `<button id="aside">aside</button>`
    )
    givenScrollRoom(root.querySelector<HTMLElement>("#shell")!, 4000, 800)
    whereItLooked(root.querySelector("#leaf")!)
    expect(scrollerFor(root.querySelector("#aside")!)).toBe(pageScroller())
  })
})

describe("pointerReach", () => {
  // `describe` names an element by its own text, and a container's text is
  // its contents'. In the stretched-link pattern the card and the link have
  // the same words, so the plain wording reads "X is on top of X" — which
  // names nothing to act on, and that is the message's only job.
  it("says an overlay is the target's own ancestor, once", () => {
    const root = mount(`<div id="card"><a id="link" href="/go">Go</a></div>`)
    const card = root.querySelector<HTMLElement>("#card")!
    stub(document, "elementFromPoint", () => card)
    const blocked = pointerReach(root.querySelector("#link")!, { x: 5, y: 5 })
    expect(blocked?.error).toBe("obscured")
    expect(blocked?.detail).toContain("div#card is an ancestor of a#link")
    expect(blocked?.detail.match(/"Go"/g)).toHaveLength(1)
  })

  // The commoner card has words of its own — a title and a description — and
  // those are worth keeping: they are how a caller finds the card in the
  // tree. Only the repetition is dropped.
  it("keeps an ancestor's own words when they are not the target's", () => {
    const root = mount(
      `<div id="card">Weekly report <a id="link" href="/go">Go</a></div>`
    )
    stub(document, "elementFromPoint", () => root.querySelector("#card"))
    const detail = pointerReach(root.querySelector("#link")!, {
      x: 5,
      y: 5,
    })?.detail
    expect(detail).toContain(`div#card "Weekly report Go" is an ancestor`)
  })

  it("keeps the plain wording for an overlay that is not an ancestor", () => {
    const root = mount(
      `<a id="link" href="/go">Go</a><div id="veil">Veil</div>`
    )
    stub(document, "elementFromPoint", () => root.querySelector("#veil"))
    expect(
      pointerReach(root.querySelector("#link")!, { x: 5, y: 5 })?.detail
    ).toBe(
      `div#veil "Veil" is on top of a#link "Go" where a pointer would land`
    )
  })

  // `obstructionAt` answers `documentElement` when the hit test finds nothing,
  // and every element descends from that — so the ancestor sentence would end
  // in "act on the ancestor" about `<html>`, which is advice with nothing
  // behind it.
  it("does not tell the caller to act on the page itself", () => {
    const root = mount(`<a id="link" href="/go">Go</a>`)
    stub(document, "elementFromPoint", () => null)
    const detail = pointerReach(root.querySelector("#link")!, {
      x: 5,
      y: 5,
    })?.detail
    expect(detail).toContain("is on top of")
    expect(detail).not.toContain("act on the ancestor")
  })

  // An engine with no hit testing is not an engine where everything is
  // covered. jsdom is that engine, which is why this can be asked here at
  // all: refusing every click with the retryable `obscured`, naming an
  // obstruction that does not exist, sends a caller hunting for an overlay
  // for ever. A point that genuinely hit nothing — the case above — is a
  // different thing and keeps its refusal.
  it("lets the click through where the engine cannot hit test at all", () => {
    const root = mount(`<a id="link" href="/go">Go</a>`)
    expect("elementFromPoint" in document).toBe(false)
    expect(
      pointerReach(root.querySelector("#link")!, { x: 5, y: 5 })
    ).toBeNull()
  })
})

/** jsdom has no `document.scrollingElement`; the fallback the walk ends on is
 *  what it reaches there, and what these assert against. */
function pageScroller(): Element {
  return document.scrollingElement ?? document.documentElement
}

/** jsdom lays nothing out, so every box is zero and nothing would ever
 *  qualify as a scroller. These are the numbers the walk reads. */
function givenScrollRoom(
  el: Element,
  scrollHeight: number,
  clientHeight: number,
  scrollTop = 0
): void {
  stub(el, "scrollHeight", scrollHeight)
  stub(el, "clientHeight", clientHeight)
  stub(el, "scrollTop", scrollTop)
}

/**
 * The page's scroller is one object for the whole file, so what a test puts
 * on it outlives the test unless it is taken off again. Every stub goes on
 * through here and comes off in `afterEach`, which leaves the prototype's own
 * accessor uncovered for the next one.
 */
const stubbed: Array<[object, string]> = []

function stub(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  })
  stubbed.push([target, name])
}

afterEach(() => {
  for (const [target, name] of stubbed.splice(0))
    delete (target as Record<string, unknown>)[name]
})

/**
 * jsdom ships no CSSOM-View methods either, so there is nothing to spy on
 * until one is put there.
 *
 * The stand-in clamps and stores the way an engine does, because the report a
 * press comes back with is read off the box *after* the scroll — a spy that
 * only recorded the request would let a scroll that went nowhere look like one
 * that moved.
 */
function watchScrolling(el: Element) {
  const spy = vi.fn((options: ScrollToOptions) => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    stub(el, "scrollTop", Math.min(Math.max(options.top ?? 0, 0), max))
  })
  stub(el, "scrollTo", spy)
  return spy
}

/** The `top` of every scroll asked for, in order. */
function tops(spy: ReturnType<typeof vi.fn>): number[] {
  return spy.mock.calls.map((call) => (call[0] as ScrollToOptions).top!)
}

/** jsdom has no hit testing at all — `document.elementFromPoint` is not even
 *  defined — so the stand-in both supplies the answer and records the point
 *  it was asked about, which is half of what the walk claims to do. */
function whereItLooked(answer: Element | null) {
  // Declares no parameters and still records the ones it was called with,
  // which is the point: the coordinates are the assertion.
  const spy = vi.fn(() => answer)
  stub(document, "elementFromPoint", spy)
  return spy
}

describe("selectIn", () => {
  const html = `<label for="s">Size</label><select id="s">
      <option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option>
    </select><select id="multi" multiple><option value="1">One</option><option value="2">Two</option></select>`

  it("picks by value or by label and tells the page", () => {
    const root = mount(html)
    const select = root.querySelector<HTMLSelectElement>("#s")!
    const seen: string[] = []
    select.addEventListener("input", () => seen.push("input"))
    select.addEventListener("change", () => seen.push(`change:${select.value}`))
    expect(selectIn(select, ["l"])).toBeNull()
    expect(seen).toEqual(["input", "change:l"])
    expect(selectIn(root.querySelector("label")!, ["Small"])).toBeNull()
    expect(select.value).toBe("s")
  })

  it("selects several in a multiple select, and only one in a single", () => {
    const root = mount(html)
    const multi = root.querySelector<HTMLSelectElement>("#multi")!
    expect(selectIn(multi, ["1", "Two"])).toBeNull()
    expect(Array.from(multi.selectedOptions).map((o) => o.value)).toEqual([
      "1",
      "2",
    ])
    expect(selectIn(root.querySelector("#s")!, ["s", "m"])).toMatchObject({
      error: "unsupported",
    })
  })

  it("lists the options when one does not exist", () => {
    const root = mount(html)
    const failure = selectIn(root.querySelector("#s")!, ["xl"])
    expect(failure).toMatchObject({ error: "no-option" })
    expect(failure?.detail).toContain('"xl"')
    expect(failure?.detail).toContain('"m"')
  })

  it("never picks a disabled option, and says that is why", () => {
    const root = mount(
      `<select id="s"><option value="a">A</option><option value="b" disabled>B</option><optgroup disabled><option value="c">C</option></optgroup></select>`
    )
    const failure = selectIn(root.querySelector("#s")!, ["b"])
    expect(failure).toMatchObject({ error: "disabled" })
    expect(root.querySelector<HTMLSelectElement>("#s")!.value).toBe("a")
    // Disabled through its group, with nothing on the option itself.
    expect(selectIn(root.querySelector("#s")!, ["c"])).toMatchObject({
      error: "disabled",
    })
    expect(root.querySelector<HTMLSelectElement>("#s")!.value).toBe("a")
  })

  it("refuses what is not a select", () => {
    const root = mount(`<input id="i">`)
    expect(selectIn(root.querySelector("#i")!, ["a"])).toMatchObject({
      error: "not-editable",
    })
  })
})
