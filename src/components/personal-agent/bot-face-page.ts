/**
 * What the page keeps once for all the faces on it (`bot-avatar.tsx`): the
 * stylesheet they are painted with (`faceToneCss`), and the drawing of each
 * shape at rest in each look and size it shows (`restBody`), which every
 * face at rest uses — so a face in a long list is a `<use>` and its eyes,
 * not a drawing of its own.
 */

import type { BotLook } from "@/lib/types"

import { faceToneCss, restBody, restId } from "./bot-shapes"

const SVG_NS = "http://www.w3.org/2000/svg"
const TONES_ID = "pa-face-tones"
const DEFS_ID = "pa-face-defs"

/** Add the faces' stylesheet to the page, once. */
export function addFaceTones(): void {
  if (typeof document === "undefined") return
  if (document.getElementById(TONES_ID)) return
  const style = document.createElement("style")
  style.id = TONES_ID
  style.textContent = faceToneCss()
  document.head.appendChild(style)
}

/** Where the drawings at rest are kept: an SVG of no size, out of the way
 *  (not `display: none`, which would leave what it holds undrawn). */
function defs(): SVGDefsElement {
  const kept = document.getElementById(DEFS_ID)
  if (kept?.firstElementChild) return kept.firstElementChild as SVGDefsElement
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.id = DEFS_ID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  svg.setAttribute(
    "style",
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"
  )
  const d = document.createElementNS(SVG_NS, "defs")
  svg.appendChild(d)
  document.body.appendChild(svg)
  return d
}

/** Put a shape's drawing at rest in a look and size on the page, if it is
 *  not there yet. */
export function defineFace(shape: string, look: BotLook, small: boolean): void {
  if (typeof document === "undefined") return
  const id = restId(shape, look, small)
  if (document.getElementById(id)) return
  const g = document.createElementNS(SVG_NS, "g")
  g.id = id
  g.innerHTML = restBody(shape, look, small)
  defs().appendChild(g)
}
