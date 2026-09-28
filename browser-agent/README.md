# browser-agent

The script a browser tab's **isolated world** runs when an agent needs to read
the page, or act on it. Built by esbuild into
`src-tauri/src/browser/js/agent.bundle.js`, which is committed.

```
pnpm browser:agent          # build the bundle
pnpm browser:agent:check    # is the committed bundle the one this source makes?
pnpm browser:agent:types    # typecheck (esbuild does not)
pnpm browser:agent:probe    # drive the bundle in real Chrome
```

## What it is

`vendor/playwright/` is Playwright's aria tree, copied byte-for-byte at v1.63.0
(see `vendor/playwright/VENDOR.md`). `src/index.ts` calls it in **`ai` mode** —
the mode Playwright MCP uses — and puts `snapshot`, `elementForRef`, `act` and
`locate` on `globalThis.__codegAgent` for Rust to call through world-scoped
eval. `src/act.ts` is the acting half: given an element, it clicks, hovers,
types, presses or selects by dispatching events at it.

`ai` mode is why there is no second pass over the DOM here. It gives a ref to
every element that is _visible and receives pointer events_, so a `<div>` with
`cursor: pointer` and a click handler and no ARIA role is namable, and carries
`[cursor=pointer]` to say why. An earlier plan for this package described
writing that promotion ourselves; upstream had already made it unnecessary.

## Two things it does that upstream does not

**Refs are answerable across a navigation.** Playwright's ref counter lives in
the module, so a fresh document starts again at `e1` — two pages use the same
names for different elements. Each world here draws a random `generation` and
reports it with every snapshot; `elementForRef` refuses a ref that quotes an
older one. A new document destroys the world, so the next snapshot is a new
generation and every ref an agent still holds is refused rather than resolved
onto whatever now happens to be `e1`.

A new document is not the only kind of navigation, and the other kind is the
common one here: `pushState`, `replaceState` and hash changes leave the
document, the world and the generation exactly as they were while the page
becomes a different page. That is a route change in a single-page app — which
is most of what a dev server serves — and the elements a framework keeps
across one, the header and its buttons, are exactly the ones that would still
resolve. So a snapshot also records the address it was taken at, and a ref is
refused once the page has moved. The error runs in the safe direction: a
caller told to snapshot again loses a round trip, a caller handed the wrong
element loses the user's page.

**Where that stops, and who takes over.** An address is not an identity. A
route that goes A → B → A arrives back at a string that matches, on a page
whose framework may have kept the DOM node and given it new meaning, and this
world cannot see that it happened: the page's own `history.pushState` is
invisible from an isolated world, because patching `History.prototype` here
patches _this_ world's prototype while the page calls a different function
object — the same isolation that keeps `__codegAgent` out of the page's reach.

So the world enforces three floors it can check by looking — a new document, a
moved address, a departed element — and `snapshot({ epoch })` mixes a host
token into the generation an agent echoes back. Deciding _when_ refs die is
the host's, because the host is the only party that sees the navigation.

The probe measures the world's side of that, including the A → B → A case that
the floors do not catch, and the premise underneath it: it patches
`History.prototype.pushState` in the world, has the _page_ navigate, and
checks that the patch never fired while the address moved anyway. It cannot
measure the host's side, because there is no host here yet.

**The tree can be capped.** `maxChars` cuts on a line boundary, so an agent
never reads half a node, and the result says `truncated` so it knows to narrow
the question rather than believe the page ended. A cap that lands inside the
very first line has no boundary to use; the cap wins there and the line is cut
where it falls.

## Acting

`act(generation, ref, request)` resolves the ref under the same rules and, in
the same evaluation, does one of `click`, `hover`, `type`, `press`, `select`
to the element. Same evaluation is the point: nothing can happen to the page
between deciding the element is still the one and touching it.

Everything is dispatched JavaScript — what the host reports as **`synthetic`**
fidelity. A dispatched `click` still carries the element's activation
behaviour (a link is followed, a submit button submits, a checkbox toggles),
and the parts a dispatched event does *not* do that a real one would are
emulated where they are what the key is for: focus moves on mousedown, Enter
in a field submits its form through the default button, Space activates a
button, Tab moves focus, PageUp/PageDown/Home/End scroll, a printable key
types. What cannot be emulated — a popup needs user activation, `:hover` needs
a real pointer — is why the fidelity field exists.

Scrolling is on that list for a reason that is worth stating plainly: there is
no scroll tool, so the scroll keys are the only way an agent moves a page, and
a dispatched key event carries no default action whatsoever. Without the
emulation a PageDown dispatches, no handler objects, and the press is reported
*done* over a page that has not moved — a false success, which is worse than a
refusal, because the next snapshot reads as a page that would not scroll
rather than as a key that never landed. The key scrolls the nearest scrollable
ancestor of wherever it was pressed — the pane for a ref inside one, and for a
press with no ref whatever has focus sits in, which on a page nobody has
clicked is the document. Home and End are left to a focused
text field, where they belong to the caret; PageUp and PageDown are not, since
a single-line field has no pages of its own and the engine scrolls the
document from there too — which is the state an agent is in every time it has
just typed into something.

All four move one axis. That is not the guess their names invite, and it is
the engine's own behaviour rather than a simplification: a trusted Home leaves
`scrollLeft` exactly where it was — in a box scrolled both down and across, in
the document's scroller, and even in a box that can *only* scroll across,
where the axis it moves has nowhere to go and it still declines the other one.
Measured in the probe with trusted keys, and pinned there, because "Home means
go to the start" is the kind of guess that gets acted on later.

Where the walk ends at the document's scroller and *that* cannot move either,
one more question is asked: what is under the middle of the screen? The layout
most applications ship is `html, body { overflow: hidden }` with a full-height
box inside doing the scrolling, and a ref-less key lands on `document.body`,
whose walk ends at a scroller with nothing in it. Answering "no more content
than fits" there is the same false success one step along, about a page with
thousands of pixels left in it. The middle of the screen is the box a wheel
resting there would turn, and the box a person would have clicked into first.
Asked only when the page itself cannot move, so it can never take a key away
from a document that wanted it.

The press answers with how far the box actually moved and how far it can still
go, read back off the scroller rather than computed from what was asked for.
Without that the false success returns in a quieter form: the tree an agent
reads back is the whole document, not the part on screen, so a page already at
its end looks exactly like one that just scrolled, and the only thing to do
with an answer of "done" is press the key again.

Typing goes through `execCommand("insertText")` first, so the page sees the
engine's own `beforeinput` / `input`, and falls back to setting the value
through the prototype's setter (past any instance property a framework put on
the node) plus a dispatched `input`.

A click is refused when something else is on top at the point a pointer would
land — the user could not click it either, and a dialog's backdrop is the
usual case. The refusal names what is in the way, and where that turns out to
be the target's own ancestor it says so in those words. It has to: `describe`
names an element by its own text, and a container's text is whatever its
contents say, so the card in the stretched-link pattern and the link inside it
come out with the same name and the plain wording reads "X is on top of X" —
which names nothing to act on, and naming the thing to act on is the only job
that message has.

It is a *different* refusal when the element has been erased rather than
covered: the screen-reader-only heading a framework puts inside every article,
written as `width: 1px; clip: rect(0 0 0 0)`, as a `clip-path` that closes the
box, or as a full-sized box parked at `left: -9999px`. `ai` mode's own
visibility rule does not catch those — a 1px box is a box — so this is where
they stop. They are `not-visible` rather than `obscured` because the two ask
opposite things of the caller: an `obscured` is worth another look once the
page settles, while this one no retry and no fresh snapshot can turn into a
success, and an accessibility tree offers them a row at a time.

Those shapes do not describe themselves alike, because only one of them is
invisible. A box a pixel across, or one clipped to nothing, *paints nothing on
screen*; a box parked off-canvas is *parked outside the page*, since it paints
perfectly well at a coordinate no scroll reaches, and saying otherwise asserts
something the caller can go and check — a refusal caught out being wrong is one
worth retrying past, which is the single thing the message exists to prevent.
What they share word for word is the verdict, `no snapshot will change that`.
That sentence, not either description, is what `browser_click`'s tool
description points a model at, so the three move together.

`not-visible` covers recoverable shapes too, and the detail is what tells them
apart — the code cannot, because whether a page can reach an element is not a
property of the refusal. An element that is not being *rendered* at the moment
(it, or an ancestor, is `display: none` — the accordion shut since the
snapshot, the tab not selected) reads as erased from its measurements alone,
since an unrendered box is the same zeroes a one-pixel recipe leaves. It is
asked about first, and answered with what to do: open what hides it, snapshot
again. So is an element merely outside the viewport, which is a page that
could not be scrolled to it *this time*.

Which one it is, is decided by the element itself and by nothing else: its
computed style, or where its box sits. The tempting shortcut is to infer it
from the hit test — if a pointer at the element's centre lands on one of its
*ancestors*, surely the element draws nothing there — and that inference is
wrong often enough to matter, because the verdict it feeds is the one a caller
must not retry. An ancestor is what a pointer finds whenever an ancestor
paints over its own descendant: a card whose `::after` covers a perfectly
visible link (a pseudo-element hit is attributed to its host), the contents of
an accordion shut with `height: 0`. Both are recoverable — click the card,
open the accordion — and an `obscured` that names the ancestor says exactly
that.

The `left: -9999px` recipe is the one place geometry rather than style decides
it, and it is a hard fact rather than a heuristic: scroll offsets clamp at
zero, so a box whose far edge is still in negative document coordinates cannot
be reached by any scroll. Read only where the element's frame of reference is
the document's — a box that scrolls or transforms in between makes the
arithmetic mean something else, and both of those can change in a moment.

For the third floor the snapshot section leaves open — the A → B → A route —
the world records `history.length` and counts `popstate` / `hashchange`, which
between them see what a page's own `pushState` leaves behind even though the
call itself is invisible from here. A `replaceState` away and back is still
uncaught; it changes nothing observable.

`locate(generation, ref)` is for a host with a trusted-input channel (WebView2's
CDP `Input.*`): it scrolls the element into view, checks nothing covers it, and
answers with the viewport point for the host to deliver a real pointer to.

`rectOf(generation, ref)` is for a host cropping a screenshot to an element: it
brings the element into view under the same rules and answers with its visible
box in viewport CSS pixels plus the viewport's size, which is what the host
needs to turn the engine's pixels into that box. The console is not this
bundle's business — the page-world shim (`src/browser-injected/console.js`) and
the helper carry it — but the probe measures the channel between them here,
where there is an engine with real world isolation to measure it in.

## What is not here

Authorization. The Rust seam decides whether an agent may read or act on a tab
at all — `none / read / control`, per tab and origin, with no automatic grants —
and evaluates nothing here until it has.

## Where it runs

The world is separate from the page: `__codegAgent` is not reachable from page
script, and page code cannot forge a ref or observe a snapshot. The probe
asserts this. What the probe cannot assert is the engine — it drives Chrome,
while the three platforms ship WKWebView, WebView2 and WebKitGTK.
