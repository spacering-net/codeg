import type { Spec, UIElement } from "@json-render/core"

import {
  isAssistantAction,
  PA_OPEN,
  type AssistantActionName,
} from "./assistant-actions"

/**
 * An assistant's card before it renders (9.2): the three assistant actions
 * act for the owner, so they may only run from the owner's own click on the
 * one button or link they are bound to. A spec cannot be trusted to bind
 * them that way, so this strips every other binding of them — run on every
 * compile, as the spec streams — and marks what is left so the card's
 * button knows what it does:
 *
 * - out of `watch` (it fires on a state change, the streamed initial state
 *   included);
 * - out of every `onSuccess` / `onError` chain, however deep;
 * - out of any event but a Button's or a Link's `press`, and out of a press
 *   that binds anything else as well;
 * - a `confirm` on one goes (codeg asks itself, when it asks).
 *
 * A binding that stays gets `params.__el` — the element's key, which its
 * handler matches against the click that fired it — and its element gets
 * `props.__paAction` / `__paKey` / `__paParent` and `__paParams` (the
 * binding's own parameters: json-render resolves props against the state
 * and the repeat item as the button renders, so the button holds them as
 * values — an action's own `$item` resolves to a state path instead).
 */

/** What a card's button reads off its props. */
export interface PaMarks {
  __paAction?: AssistantActionName
  __paKey?: string
  __paParent?: string | null
  __paParams?: Record<string, unknown>
}

export interface SanitizedSpec {
  spec: Spec
  /** Something that could fire an assistant action without a click of the
   *  owner's was removed: the card says so. */
  stripped: boolean
}

type Binding = Record<string, unknown>

function isBinding(v: unknown): v is Binding {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function bindingsOf(v: unknown): Binding[] {
  if (Array.isArray(v)) return v.filter(isBinding)
  return isBinding(v) ? [v] : []
}

function isPa(b: Binding): boolean {
  return isAssistantAction(b.action)
}

/** A binding with no assistant action left in its `onSuccess` / `onError`
 *  chains. `out.stripped` is set when one went. */
function cleanChains(b: Binding, out: { stripped: boolean }): Binding {
  let next = b
  for (const key of ["onSuccess", "onError"] as const) {
    const chained = b[key]
    if (!isBinding(chained) || !("action" in chained)) continue
    if (next === b) next = { ...b }
    if (isPa(chained)) {
      delete next[key]
      out.stripped = true
    } else {
      next[key] = cleanChains(chained, out)
    }
  }
  return next
}

const PRESSABLE = new Set(["Button", "Link"])

const MARK_KEYS = ["__paAction", "__paKey", "__paParent", "__paParams"]

function unmarked(
  props: Record<string, unknown> | undefined
): Record<string, unknown> {
  const next = { ...(props ?? {}) }
  for (const k of MARK_KEYS) delete next[k]
  return next
}

/** Each element's parent: the first element that lists it as a child or in
 *  a slot. */
function parentsOf(elements: Record<string, UIElement>): Map<string, string> {
  const parents = new Map<string, string>()
  for (const [key, el] of Object.entries(elements)) {
    if (!el || typeof el !== "object") continue
    const kids: unknown[] = Array.isArray(el.children) ? [...el.children] : []
    const slots: unknown = (el as { slots?: unknown }).slots
    if (slots && typeof slots === "object") {
      for (const slot of Object.values(slots)) {
        if (Array.isArray(slot)) kids.push(...slot)
      }
    }
    for (const kid of kids) {
      if (typeof kid === "string" && !parents.has(kid)) parents.set(kid, key)
    }
  }
  return parents
}

export function sanitizeAssistantSpec(spec: Spec): SanitizedSpec {
  const out = { stripped: false }
  const source = spec.elements ?? {}
  const parents = parentsOf(source)
  const elements: Record<string, UIElement> = {}
  for (const [key, original] of Object.entries(source)) {
    if (!original || typeof original !== "object") {
      elements[key] = original
      continue
    }
    let el = original as UIElement & Record<string, unknown>
    const copy = () => {
      if (el === original) el = { ...el }
      return el
    }

    // watch: never an assistant action.
    const watch = el.watch
    if (watch && typeof watch === "object" && !Array.isArray(watch)) {
      const kept: Record<string, unknown> = {}
      let changed = false
      for (const [path, raw] of Object.entries(watch)) {
        const list = bindingsOf(raw)
        const left = list
          .filter((b) => {
            if (isPa(b)) {
              out.stripped = true
              return false
            }
            return true
          })
          .map((b) => cleanChains(b, out))
        if (left.length !== list.length || left.some((b, i) => b !== list[i]))
          changed = true
        if (left.length === 0) {
          changed = true
          continue
        }
        kept[path] = Array.isArray(raw) ? left : left[0]
      }
      if (changed) copy().watch = kept as UIElement["watch"]
    }

    // on: an assistant action only as a Button's or Link's lone press.
    let marks: PaMarks | null = null
    const on = el.on
    if (on && typeof on === "object" && !Array.isArray(on)) {
      const kept: Record<string, unknown> = {}
      let changed = false
      for (const [event, raw] of Object.entries(on)) {
        const list = bindingsOf(raw)
        const pa = list.filter(isPa)
        if (
          pa.length === 1 &&
          list.length === 1 &&
          event === "press" &&
          PRESSABLE.has(String(el.type))
        ) {
          const only = cleanChains(pa[0], out)
          const own: Record<string, unknown> = isBinding(only.params)
            ? { ...only.params }
            : {}
          delete own.__el
          const bound: Binding = { ...only, params: { ...own, __el: key } }
          delete bound.confirm
          kept[event] = bound
          changed = true
          marks = {
            __paAction: only.action as AssistantActionName,
            __paKey: key,
            __paParent: parents.get(key) ?? null,
            __paParams: own,
          }
          continue
        }
        if (pa.length > 0) out.stripped = true
        const left = list
          .filter((b) => !isPa(b))
          .map((b) => cleanChains(b, out))
        if (left.length !== list.length || left.some((b, i) => b !== list[i]))
          changed = true
        if (left.length === 0) {
          changed = true
          continue
        }
        kept[event] = Array.isArray(raw) ? left : left[0]
      }
      if (changed) copy().on = kept as UIElement["on"]
    }
    // Only this marks a button: a spec cannot mark one itself.
    const props = el.props as Record<string, unknown> | undefined
    if (marks) {
      copy().props = { ...unmarked(props), ...marks }
    } else if (props && MARK_KEYS.some((k) => k in props)) {
      copy().props = unmarked(props)
    }
    elements[key] = el
  }
  return { spec: { ...spec, elements }, stripped: out.stripped }
}

/** The type of the card codeg draws round a list's item (`itemizeRepeats`):
 *  no component of the catalog's, and none a spec is taught. */
export const PA_ITEM_CARD = "__paItemCard"

/** What `PA_ITEM_CARD` takes: its children's keys that act — buttons,
 *  links, a row of them — drawn at its end; and where its first `pa.open`
 *  goes (`target`, `id`, as the button's own parameters — resolved against
 *  the item as it renders), to lead it with that assistant's face or that
 *  kind's icon. */
/** The prop that marks an item's lone line (`itemizeRepeats`): set over
 *  what about it, its subject (`splitLine`). */
export const PA_LINE = "__paLine"

export type PaItemCardProps = {
  actions: string[]
  lead?: { target: unknown; id: unknown } | null
  /** Its one action is a lone `pa.open` button: what it opens is the
   *  row's own, so a number in its words only repeats the row's line. */
  sole?: boolean
}

/** The parameters of the first `pa.open` button under `key`, as marked. */
function openParams(
  elements: Record<string, UIElement>,
  key: string,
  seen: Set<string>
): Record<string, unknown> | null {
  const el = elements[key]
  if (!el || typeof el !== "object" || seen.has(key)) return null
  // One shown only now and then cannot say what the row is about.
  if (el.visible != null) return null
  seen.add(key)
  const marks = el.props as PaMarks | undefined
  if (marks?.__paAction === PA_OPEN && marks.__paParams) {
    return marks.__paParams
  }
  for (const kid of Array.isArray(el.children) ? el.children : []) {
    const found =
      typeof kid === "string" ? openParams(elements, kid, seen) : null
    if (found) return found
  }
  return null
}

/** A child that acts: a button or link, or a container of nothing else. */
function acts(
  elements: Record<string, UIElement>,
  key: string,
  seen: Set<string>
): boolean | null {
  const el = elements[key]
  if (!el || typeof el !== "object") return null
  if (PRESSABLE.has(String(el.type))) return true
  const kids = Array.isArray(el.children) ? el.children : []
  if (kids.length === 0 || seen.has(key)) return false
  seen.add(key)
  let all = true
  for (const kid of kids) {
    const a = typeof kid === "string" ? acts(elements, kid, seen) : false
    if (a == null) return null
    if (!a) all = false
  }
  return all
}

/**
 * An assistant's list drawn as one: an element that repeats over a state
 * array, whose item is something to read and something to do about it —
 * its line and its button, as a morning brief lists what needs the owner —
 * gets each item as a row of its own, led by whom or what it opens, the
 * button at its end, a hairline between the rows (a Stack's own gap goes:
 * the rows are spaced by themselves). Its children
 * move under one `PA_ITEM_CARD` element, still repeated: their keys, the
 * repeat's scope and so every button's id (`elementIdOf`) and container
 * (`__paParent`, read before this) stay as they were. An item that only
 * reads, or only acts (a row of choices), stays as written; so does one
 * whose children have not all arrived yet. An item written as a row of
 * its own — one Stack holding its line and its button — is that row: the
 * Stack's children are the item's (laid out by it, a row was as wide as
 * its words). An item whose words are one Text has it marked (`PA_LINE`):
 * its line, split into subject and what. The list takes the width it is
 * in, and its rows with it.
 */
/** What a Stack says of how it lays its children out, and nothing else. */
const STACK_LAYOUT = new Set(["direction", "gap", "align", "justify"])

export function itemizeRepeats(spec: Spec): Spec {
  const source = spec.elements ?? {}
  let elements: Record<string, UIElement> | null = null
  for (const [key, el] of Object.entries(source)) {
    if (!el || typeof el !== "object" || !el.repeat) continue
    let kids = Array.isArray(el.children) ? el.children : []
    const seen = new Set([key])
    const row =
      kids.length === 1 && typeof kids[0] === "string"
        ? source[kids[0]]
        : undefined
    const through =
      row != null &&
      typeof row === "object" &&
      row.type === "Stack" &&
      !row.repeat &&
      row.visible == null &&
      row.on == null &&
      row.watch == null &&
      // Laid out only, and as written: one styled, set apart, or laid out
      // by state is the spec's own.
      Object.entries(row.props ?? {}).every(
        ([k, v]) => STACK_LAYOUT.has(k) && (v == null || typeof v !== "object")
      )
    if (through) {
      seen.add(kids[0] as string)
      kids = Array.isArray(row.children) ? row.children : []
    }
    if (kids.length < 2) continue
    const actions: string[] = []
    let known = true
    for (const kid of kids) {
      const a =
        typeof kid === "string" ? acts(source, kid, new Set(seen)) : null
      if (a == null) {
        known = false
        break
      }
      if (a) actions.push(kid)
    }
    if (!known || actions.length === 0 || actions.length === kids.length) {
      continue
    }
    // Looked through, it is one row only as its words and then what to do
    // about them: one with a line and its button, and another after, is
    // lines with their buttons (`itemizeOpeners`).
    if (
      through &&
      actions.some((a, i) => a !== kids[kids.length - actions.length + i])
    ) {
      continue
    }
    elements ??= { ...source }
    let wrap = `${key}~item`
    while (wrap in elements) wrap += "~"
    let lead: PaItemCardProps["lead"] = null
    for (const a of actions) {
      const params = openParams(source, a, new Set())
      if (params) {
        lead = { target: params.target, id: params.id }
        break
      }
    }
    const props: PaItemCardProps = {
      actions,
      lead,
      sole: soleOpener(source, actions),
    }
    elements[wrap] = { type: PA_ITEM_CARD, props, children: [...kids] }
    // An item whose words are one Text: that line, marked as the item's.
    const reads = kids.filter((k) => !actions.includes(k))
    const only = reads.length === 1 ? elements[reads[0]] : undefined
    if (only && only.type === "Text") {
      elements[reads[0]] = {
        ...only,
        props: { ...(only.props ?? {}), [PA_LINE]: true },
      }
    }
    // The rows space themselves: the list's own gap goes (a Card's is its
    // content's).
    const own = (el.props ?? {}) as Record<string, unknown>
    // A list is as wide as what it is in unless the spec says how wide
    // (classes merge, the later winning: its own width over ours, our gap
    // over its own).
    const authored = typeof own.className === "string" ? own.className : ""
    const className =
      el.type === "Stack"
        ? `w-full ${authored} gap-0`.replace(/\s+/g, " ").trim()
        : el.type === "Card"
          ? `${authored} [&>[data-slot=card-content]]:gap-0`.trim()
          : null
    elements[key] = {
      ...el,
      // A class bound to state is the spec's to keep.
      ...(className &&
      (own.className == null || typeof own.className === "string")
        ? { props: { ...own, className } }
        : {}),
      children: [wrap],
    }
  }
  return elements ? { ...spec, elements } : spec
}

/** A row's actions one lone button that opens a place. */
function soleOpener(
  elements: Record<string, UIElement>,
  actions: string[]
): boolean {
  return actions.length === 1 && opens(elements, actions[0])
}

/** A line of body text — not a heading's, not a muted aside. */
function isLine(el: UIElement | undefined): boolean {
  if (!el || typeof el !== "object" || el.type !== "Text") return false
  const variant = (el.props as Record<string, unknown> | undefined)?.variant
  return variant == null || variant === "body"
}

/** A button or link that takes the owner somewhere (`pa.open`), as marked. */
function opens(elements: Record<string, UIElement>, key: unknown): boolean {
  if (typeof key !== "string") return false
  const el = elements[key]
  if (!el || typeof el !== "object" || !PRESSABLE.has(String(el.type))) {
    return false
  }
  // One shown only now and then is no part of a row that is always there.
  if (el.visible != null) return false
  return (el.props as PaMarks | undefined)?.__paAction === PA_OPEN
}

/**
 * What a card says of one thing and the button that opens it, written one
 * after the other outside a list — a brief's "Done yesterday: dispatch #13
 * …" and its [See the result] — drawn as a list's item is
 * (`itemizeRepeats`): a row led by what the button opens, the button at its
 * end, a hairline over and under it. Written loose, the button sat under
 * the line as far from it as from the next heading, and whose it was could
 * not be told. A line and the `pa.open` buttons right after it become one
 * row; such rows one after another one list (a `Stack` with no gap of its
 * own, so the first has its line over it and the last its line under it).
 * Their keys stay, so every button's id and container do; a list's item
 * (already a row) and a repeated element are left as they are.
 */
export function itemizeOpeners(spec: Spec): Spec {
  const source = spec.elements ?? {}
  let elements: Record<string, UIElement> | null = null
  const fresh = (base: string) => {
    let k = base
    while (k in source || (elements && k in elements)) k += "~"
    return k
  }
  for (const [key, el] of Object.entries(source)) {
    if (!el || typeof el !== "object" || el.repeat) continue
    if (el.type === PA_ITEM_CARD) continue
    const kids = Array.isArray(el.children) ? el.children : []
    if (kids.length < 2) continue
    let out: string[] | null = null
    let list: string[] | null = null
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]
      const line = typeof kid === "string" ? source[kid] : undefined
      let j = i + 1
      if (typeof kid === "string" && isLine(line)) {
        while (j < kids.length && opens(source, kids[j])) j++
      }
      if (j === i + 1 || typeof kid !== "string" || !line) {
        list = null
        out?.push(kid)
        continue
      }
      elements ??= { ...source }
      out ??= kids.slice(0, i) as string[]
      const actions = kids.slice(i + 1, j) as string[]
      const params = (elements[actions[0]].props as PaMarks).__paParams
      const row = fresh(`${kid}~row`)
      const props: PaItemCardProps = {
        actions,
        lead: params ? { target: params.target, id: params.id } : null,
        sole: actions.length === 1,
      }
      elements[row] = { type: PA_ITEM_CARD, props, children: [kid, ...actions] }
      elements[kid] = {
        ...line,
        props: { ...(line.props ?? {}), [PA_LINE]: true },
      }
      if (!list) {
        const wrap = fresh(`${kid}~rows`)
        list = []
        // As wide as what it is in, whatever lays that out: in a row of
        // its own (a horizontal Stack), or a Stack that keeps its children
        // to their width, it was as wide as its words.
        elements[wrap] = {
          type: "Stack",
          props: { gap: "none", className: "w-full" },
          children: list,
        }
        out.push(wrap)
      }
      list.push(row)
      i = j - 1
    }
    if (out) elements![key] = { ...(elements![key] ?? el), children: out }
  }
  return elements ? { ...spec, elements } : spec
}

/** A card's id among its reply's cards: the FNV-1a hash of its source, as
 *  eight hex digits. */
export function cardIdOf(source: string): string {
  let h = 0x811c9dc5
  const text = source.trim()
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** An element's id on the reply's row (`data.card_acts`): the card, the
 *  element, and — inside a repeat — which item. */
export function elementIdOf(
  cardId: string,
  key: string,
  repeatBasePath?: string | null
): string {
  return repeatBasePath
    ? `${cardId}/${key}#${repeatBasePath}`
    : `${cardId}/${key}`
}

/** An element id's parts, or `null` for one of another shape. */
export function parseElementId(
  id: string
): { cardId: string; key: string; repeat: string | null } | null {
  const slash = id.indexOf("/")
  if (slash <= 0) return null
  const cardId = id.slice(0, slash)
  const rest = id.slice(slash + 1)
  const hash = rest.indexOf("#")
  return hash < 0
    ? { cardId, key: rest, repeat: null }
    : { cardId, key: rest.slice(0, hash), repeat: rest.slice(hash + 1) }
}
