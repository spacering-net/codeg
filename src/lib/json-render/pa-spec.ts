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
export type PaItemCardProps = {
  actions: string[]
  lead?: { target: unknown; id: unknown } | null
}

/** The parameters of the first `pa.open` button under `key`, as marked. */
function openParams(
  elements: Record<string, UIElement>,
  key: string,
  seen: Set<string>
): Record<string, unknown> | null {
  const el = elements[key]
  if (!el || typeof el !== "object" || seen.has(key)) return null
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
 * whose children have not all arrived yet.
 */
export function itemizeRepeats(spec: Spec): Spec {
  const source = spec.elements ?? {}
  let elements: Record<string, UIElement> | null = null
  for (const [key, el] of Object.entries(source)) {
    if (!el || typeof el !== "object" || !el.repeat) continue
    const kids = Array.isArray(el.children) ? el.children : []
    if (kids.length < 2) continue
    const actions: string[] = []
    let known = true
    for (const kid of kids) {
      const a =
        typeof kid === "string" ? acts(source, kid, new Set([key])) : null
      if (a == null) {
        known = false
        break
      }
      if (a) actions.push(kid)
    }
    if (!known || actions.length === 0 || actions.length === kids.length) {
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
    const props: PaItemCardProps = { actions, lead }
    elements[wrap] = { type: PA_ITEM_CARD, props, children: [...kids] }
    const own = (el.props ?? {}) as Record<string, unknown>
    elements[key] = {
      ...el,
      ...(el.type === "Stack"
        ? {
            props: {
              ...own,
              className:
                typeof own.className === "string"
                  ? `${own.className} gap-0`
                  : "gap-0",
            },
          }
        : {}),
      children: [wrap],
    }
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
