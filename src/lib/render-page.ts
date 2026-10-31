/**
 * `render_page` — the page an agent draws inline in the chat. The page IS the
 * tool call's own `html` input; codeg renders it in a sandboxed iframe without
 * `allow-same-origin`, so its scripts run in an opaque origin with no access to
 * the app's storage, credentials or DOM.
 *
 * A small bootstrap goes into the page's head ahead of its own styles. It sets
 * the app theme as CSS variables (and swaps them when the host posts a new
 * theme), reports the page's content height so the frame fits it, and hands
 * http(s) link clicks to the host, which opens them in the user's browser. A
 * page that waits for an answer gets `codeg.render.submit(data, summary)`,
 * whose promise settles when the host accepts (or refuses) the submission.
 *
 * Ported from openchamber's `openchamber_render` (its htmlRender.ts); the
 * key-chord, scroll-intent and tooltip-clamp machinery is cut for v1 — the
 * theme kit, height bridge, submit protocol and the selection report behind
 * the host's quote bubble are not. The in-page quotation marks (openchamber's
 * custom-highlight marks over an anchor-relocated selection) are deferred:
 * codeg quotes into the composer instead of annotating the page.
 */

import type { RenderPageAnswer } from "@/lib/types"

export const RENDER_PAGE_MIN_HEIGHT = 48
/** A page takes its full height in the chat and never scrolls inside its
 *  frame; this ceiling only stops a page whose height grows with its frame
 *  from growing without end. */
export const RENDER_PAGE_MAX_HEIGHT = 20_000

const MESSAGE_PREFIX = "codeg:render-page:"
export const RENDER_PAGE_THEME_MESSAGE = `${MESSAGE_PREFIX}theme`
export const RENDER_PAGE_SIZE_MESSAGE = `${MESSAGE_PREFIX}size`
export const RENDER_PAGE_OPEN_LINK_MESSAGE = `${MESSAGE_PREFIX}open-link`
export const RENDER_PAGE_SUBMIT_MESSAGE = `${MESSAGE_PREFIX}submit`
export const RENDER_PAGE_SUBMIT_REPLY_MESSAGE = `${MESSAGE_PREFIX}submit-reply`
export const RENDER_PAGE_ANSWER_STATE_MESSAGE = `${MESSAGE_PREFIX}answer-state`
export const RENDER_PAGE_SELECTION_MESSAGE = `${MESSAGE_PREFIX}selection`
export const RENDER_PAGE_SELECTION_ESCAPE_MESSAGE = `${MESSAGE_PREFIX}selection-escape`
export const RENDER_PAGE_CLEAR_SELECTION_MESSAGE = `${MESSAGE_PREFIX}clear-selection`
/** Host → page: open or close the in-page annotation overlay (element /
 *  region / draw), with the overlay's localized chrome labels. */
export const RENDER_PAGE_ANNOTATE_MESSAGE = `${MESSAGE_PREFIX}annotate`
/** Page → host: one annotation session's payload, or a null payload when the
 *  user cancelled. The page posts exactly one of these per start message. */
export const RENDER_PAGE_ANNOTATION_MESSAGE = `${MESSAGE_PREFIX}annotation`

/** The longest text a page may report as selected; the bootstrap cuts at it.
 *  A quote into the composer needs no more than a long paragraph. */
export const RENDER_PAGE_SELECTION_MAX = 8000

/** The JSON a page may still submit — its own `data` argument to
 *  `codeg.render.submit`, capped server-side at 16000 chars. */
export type RenderPageAnswerData = unknown

/** What the page knows about its answer when it loads: whether it may still
 *  send one, and what it sent. A page reloaded after the answer reads the
 *  second as `codeg.render.answer` to show the choice. */
export interface RenderPageAnswerState {
  waiting: boolean
  answer: RenderPageAnswerData | null
}

export interface RenderPageTheme {
  appearance: "light" | "dark"
  variables: Record<string, string>
}

/** The tokens a page styles against — the names the tool schema promises. */
const VARIABLE_NAMES = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--destructive",
  "--warning",
  "--success",
  "--info",
  "--radius",
] as const

/** Fixed stand-ins for tokens the host theme may not define, so the schema's
 *  promised variable set is always complete inside the page. */
const FALLBACKS_LIGHT: Record<string, string> = {
  "--warning": "oklch(0.769 0.153 71.129)",
  "--success": "oklch(0.697 0.174 162.48)",
  "--info": "oklch(0.623 0.214 259.815)",
  "--radius": "0.6rem",
}
const FALLBACKS_DARK: Record<string, string> = {
  "--warning": "oklch(0.828 0.189 84.429)",
  "--success": "oklch(0.793 0.179 172.263)",
  "--info": "oklch(0.707 0.165 254.624)",
  "--radius": "0.6rem",
}

/** Chart series after the first, the same fixed set openchamber uses: a
 *  theme's syntax palette made near-twins in its own checks, and every chart's
 *  first two series blurred together. */
const CHART_SERIES = {
  dark: ["#60a5fa", "#2dd4bf", "#a78bfa", "#f472b6", "#a3e635"],
  light: ["#2563eb", "#0d9488", "#7c3aed", "#db2777", "#65a30d"],
} as const

/**
 * The host's own theme, read off the document root. `--chart-1` and the font
 * stacks come from the live app (they are what the chat itself uses); series
 * after the first and any missing token take the fixed stand-ins.
 */
export function collectRenderPageTheme(): RenderPageTheme {
  const cs = getComputedStyle(document.documentElement)
  const dark = document.documentElement.classList.contains("dark")
  const fallbacks = dark ? FALLBACKS_DARK : FALLBACKS_LIGHT
  const variables: Record<string, string> = {}
  for (const name of VARIABLE_NAMES) {
    const value = cs.getPropertyValue(name).trim()
    if (value) variables[name] = value
    else if (fallbacks[name]) variables[name] = fallbacks[name]
  }
  // The chat's own text size doubles as the page's root font size, and the
  // host's rem as the kit's sizing unit, so a page follows the user's
  // interface size the way the chat does.
  const text = `${parseFloat(cs.fontSize) || 14}px`
  variables["--oc-text"] = text
  variables["--oc-rem"] = text
  const hostChart1 = cs.getPropertyValue("--chart-1").trim()
  variables["--chart-1"] = hostChart1 || (dark ? "#60a5fa" : "#2563eb")
  CHART_SERIES[dark ? "dark" : "light"].forEach((color, index) => {
    variables[`--chart-${index + 2}`] = color
  })
  const codeBackground = cs.getPropertyValue("--code-background").trim()
  variables["--code-background"] =
    codeBackground || variables["--muted"] || "rgba(127,127,127,.12)"
  const codeForeground = cs.getPropertyValue("--code-foreground").trim()
  variables["--code-foreground"] =
    codeForeground || variables["--foreground"] || "currentColor"
  const sans = cs.getPropertyValue("--font-sans").trim()
  variables["--font-sans"] =
    sans || "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
  const mono = cs.getPropertyValue("--font-mono").trim()
  variables["--font-mono"] =
    mono || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  return { appearance: dark ? "dark" : "light", variables }
}

// The kit: ready classes so a page's recurring parts look like the app without
// the agent spending output on CSS. Mirrors the class list the tool schema
// promises (html + awaitAnswer descriptions); change both together.
const KIT_CSS =
  ".oc-box{box-sizing:border-box;padding:16px;border-radius:var(--radius);background-color:color-mix(in srgb,var(--foreground) 4%,transparent)}" +
  ".oc-box .oc-box{background-color:color-mix(in srgb,var(--foreground) 6%,transparent)}" +
  ".oc-muted{color:var(--muted-foreground)}" +
  ".oc-num{font-variant-numeric:tabular-nums;text-align:end}" +
  ".oc-table{overflow-x:auto;overscroll-behavior-x:none;border:1px solid color-mix(in srgb,var(--border) 80%,transparent);border-radius:calc(var(--oc-rem) * .5);background-color:var(--card)}" +
  ".oc-table table{width:100%;border-collapse:collapse}" +
  ".oc-table th,.oc-table td{padding:.625em 1em;text-align:start;vertical-align:middle;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent)}" +
  ".oc-table th{font-weight:600}.oc-table td{color:color-mix(in srgb,var(--foreground) 90%,transparent)}" +
  ".oc-table tr:last-child>td{border-bottom:0}.oc-table .oc-num{text-align:end}" +
  ".oc-badge{display:inline-flex;align-items:center;padding:.0625em .5em;border-radius:999px;background-color:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--muted-foreground);font-size:.8125em;font-weight:500;line-height:1.45;white-space:nowrap}" +
  ".oc-badge[data-tone]{background-color:color-mix(in srgb,var(--oc-tone) 15%,transparent);color:var(--oc-tone-text)}" +
  ".oc-badge[data-tone=success]{--oc-tone:var(--success);--oc-tone-text:var(--success)}" +
  ".oc-badge[data-tone=warning]{--oc-tone:var(--warning);--oc-tone-text:var(--warning)}" +
  ".oc-badge[data-tone=error]{--oc-tone:var(--destructive);--oc-tone-text:var(--destructive)}" +
  ".oc-badge[data-tone=info]{--oc-tone:var(--info);--oc-tone-text:var(--info)}" +
  ".oc-dot{display:inline-block;width:.5em;height:.5em;border-radius:50%;background-color:var(--color,var(--chart-1));vertical-align:.1em}" +
  ".oc-bar{display:block;height:8px;border-radius:999px;overflow:hidden;background-color:color-mix(in srgb,var(--foreground) 8%,transparent)}" +
  '.oc-bar::before{content:"";display:block;width:var(--value,0%);max-width:100%;height:100%;border-radius:inherit;background-color:var(--color,var(--chart-1))}' +
  ".oc-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:calc(var(--oc-rem) * .8125);font-weight:500}" +
  ".oc-field .oc-muted{font-weight:400}" +
  ".oc-input{box-sizing:border-box;width:100%;min-width:0;height:calc(var(--oc-rem) * 2);margin:0;padding:0 calc(var(--oc-rem) * .625);border:1px solid color-mix(in srgb,var(--foreground) 12%,transparent);border-radius:calc(var(--oc-rem) * .4375);background-color:var(--card);color:var(--card-foreground);font:inherit;font-size:calc(var(--oc-rem) * .84375);font-weight:400;line-height:1.45;outline:none;transition:border-color .15s}" +
  ".oc-input::placeholder{color:var(--muted-foreground)}" +
  ".oc-input:focus{border-color:color-mix(in srgb,var(--foreground) 30%,transparent)}" +
  ".oc-input[aria-invalid=true]{border-color:var(--destructive)}" +
  ".oc-input:disabled{opacity:.5;cursor:default}" +
  "textarea.oc-input{height:auto;min-height:calc(var(--oc-rem) * 4);padding:calc(var(--oc-rem) * .5) calc(var(--oc-rem) * .625);resize:vertical}" +
  "select.oc-input{appearance:none;-webkit-appearance:none;padding-inline-end:calc(var(--oc-rem) * 1.75);cursor:pointer}" +
  ".oc-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;margin:0;border:2px solid transparent;border-radius:999px;background-color:var(--border);vertical-align:middle;cursor:pointer;transition:background-color .15s}" +
  '.oc-switch::before{content:"";position:absolute;top:0;inset-inline-start:0;width:16px;height:16px;border-radius:50%;background-color:var(--muted-foreground);transition:transform .15s}' +
  ".oc-switch:checked{background-color:var(--primary)}" +
  ".oc-switch:checked::before{background-color:var(--primary-foreground);transform:translateX(16px)}" +
  ".oc-switch:checked:dir(rtl)::before{transform:translateX(-16px)}" +
  ".oc-switch:disabled{opacity:.5;cursor:default}.oc-switch:focus-visible{outline:none}" +
  ".oc-segmented{display:inline-flex;width:fit-content;max-width:100%;gap:2px;padding:2px;box-sizing:border-box;overflow-x:auto;border-radius:calc(var(--oc-rem) * .625);background-color:color-mix(in srgb,var(--foreground) 4%,transparent)}" +
  ".oc-segmented>button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:calc(var(--oc-rem) * 1.75);padding:0 calc(var(--oc-rem) * .625);border:0;border-radius:calc(var(--oc-rem) * .5);background:transparent;color:var(--muted-foreground);font:inherit;font-size:calc(var(--oc-rem) * .8125);font-weight:500;white-space:nowrap;cursor:pointer;transition:color .15s}" +
  ".oc-segmented>button:hover,.oc-segmented>button:focus-visible{color:var(--foreground);outline:none}" +
  ".oc-segmented>button[aria-pressed=true]{background-color:var(--card);color:var(--card-foreground);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--foreground) 12%,transparent)}"
const OPTION_CSS =
  ".oc-options{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}" +
  ".oc-option{display:flex;flex-direction:column;justify-content:flex-start;align-items:flex-start;gap:4px;box-sizing:border-box;width:100%;padding:16px;border:0;border-radius:var(--radius);background-color:color-mix(in srgb,var(--foreground) 4%,transparent);color:var(--foreground);font:inherit;text-align:start;cursor:pointer;transition:background-color .15s,color .15s}" +
  ".oc-option:hover,.oc-option:focus-visible{background-color:color-mix(in srgb,var(--foreground) 7%,transparent)}" +
  ".oc-option[aria-pressed=true]{background-color:color-mix(in srgb,var(--primary) 20%,transparent);color:var(--foreground)}" +
  ".oc-option:focus-visible,.oc-button:focus-visible{outline:none}" +
  ".oc-button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:calc(var(--oc-rem) * 2);padding:0 calc(var(--oc-rem) * .75);border:1px solid color-mix(in srgb,var(--primary) 25%,transparent);border-radius:calc(var(--oc-rem) * .4375);background-color:color-mix(in srgb,var(--primary) 12%,var(--background));color:color-mix(in srgb,var(--primary) 90%,var(--foreground));font:inherit;font-size:calc(var(--oc-rem) * .84375);line-height:1.45;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s}" +
  ".oc-button:hover,.oc-button:focus-visible{background-color:color-mix(in srgb,var(--primary) 18%,var(--background))}" +
  ".oc-button:active{background-color:color-mix(in srgb,var(--primary) 24%,var(--background))}" +
  ".oc-button:disabled{opacity:.5;cursor:default;pointer-events:none}" +
  ".oc-button[data-variant=outline]{border-color:color-mix(in srgb,var(--foreground) 20%,transparent);background-color:transparent;color:var(--foreground)}" +
  ".oc-button[data-variant=outline]:hover,.oc-button[data-variant=outline]:focus-visible{background-color:color-mix(in srgb,var(--foreground) 5%,transparent)}" +
  ".oc-button[data-variant=destructive]{border-color:color-mix(in srgb,var(--destructive) 25%,transparent);background-color:color-mix(in srgb,var(--destructive) 12%,var(--background));color:color-mix(in srgb,var(--destructive) 90%,var(--foreground))}" +
  ".oc-button[data-variant=destructive]:hover,.oc-button[data-variant=destructive]:focus-visible{background-color:color-mix(in srgb,var(--destructive) 18%,var(--background))}"

// The page sits on the chat's own background. Media shrinks to the column;
// what is still wider (a wide table) scrolls sideways without the elastic
// bounce; text is the chat's own size (--oc-text), so a page that sizes its
// text in rem or em scales with the interface size as the chat does. The page
// never scrolls vertically while it fits its frame, so a vertical swipe still
// scrolls the chat.
const BASE_CSS =
  "html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:var(--oc-text,14px);line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;overflow-x:auto;overscroll-behavior-x:none}" +
  "body{margin:0}a{color:var(--primary)}code,kbd,pre,samp{font-family:var(--font-mono)}img,svg,video,canvas{max-width:100%}" +
  OPTION_CSS +
  KIT_CSS

const CSS_VARIABLE_NAME = /^--[a-z0-9-]+$/
const sanitizeCssValue = (value: string): string =>
  value.replace(/[;{}<>]/g, "")

export function renderPageThemeCss(theme: RenderPageTheme): string {
  const declarations = Object.entries(theme.variables)
    .filter(([name]) => CSS_VARIABLE_NAME.test(name))
    .map(([name, value]) => `${name}:${sanitizeCssValue(value)};`)
    .join("")
  return `:root{color-scheme:${theme.appearance};${declarations}}${BASE_CSS}`
}

// The annotation overlay lives inside the bootstrap's IIFE; kept as its own
// constant so the message names stay injectable and the block reads as one
// unit. Plain ES5: it runs inside the page before anything of the page has
// loaded, and its chrome is built per session in a closed shadow root.
const ANNOT_SCRIPT =
  `var AR=null,NS="http://www.w3.org/2000/svg",AKEYS=["id","class","name","type","href","src","alt","title","role","placeholder","aria-label","data-testid"],SKEYS=["display","position","color","backgroundColor","fontSize","fontWeight","fontFamily","lineHeight","padding","margin","border","borderRadius","width","height","opacity","zIndex","flexDirection","justifyContent","alignItems","gap","textAlign"],ABLK=["click","auxclick","dblclick","mousedown","mouseup","contextmenu"];` +
  `function arRect(x,y,w,h){return{x:Math.round(x),y:Math.round(y),width:Math.round(Math.max(0,w)),height:Math.round(Math.max(0,h))}}` +
  `function arCss(el){var p=el.tagName.toLowerCase(),n=el.parentElement,i,c,s=0,k=0;if(n){for(i=0;i<n.children.length;i++)if(n.children[i].tagName===el.tagName)s++;if(s>1)for(i=0;i<n.children.length;i++){if(n.children[i].tagName===el.tagName){k++;if(n.children[i]===el){p+=":nth-of-type("+k+")";break}}}}c=el.classList;if(c&&c.length){p+=".";var a=[];for(i=0;i<c.length&&a.length<2;i++)a.push(c[i]);p+=a.join(".")}return p}` +
  `function arSel(el){var x=el.id?(window.CSS&&CSS.escape?CSS.escape(el.id):el.id):"";if(x)return"#"+x;var p=[],n=el,d=0;while(n&&n.nodeType===1&&d<5){if(n.id&&n!==el){p.unshift("#"+(window.CSS&&CSS.escape?CSS.escape(n.id):n.id));break}p.unshift(arCss(n));n=n.parentElement;d++}return p.join(" > ")}` +
  `function arDesc(el){var a={},s={},i,v;for(i=0;i<AKEYS.length;i++){v=el.getAttribute(AKEYS[i]);if(v!=null)a[AKEYS[i]]=String(v).slice(0,200)}var cs=window.getComputedStyle(el);for(i=0;i<SKEYS.length;i++){v=cs[SKEYS[i]];s[SKEYS[i]]=v==null?"":String(v).slice(0,200)}var b=el.getBoundingClientRect();return{node:el,selector:arSel(el),html:String(el.outerHTML).slice(0,600),text:(el.innerText||"").replace(/\s+/g," ").trim().slice(0,400),attributes:a,styles:s,bounds:arRect(b.left,b.top,b.width,b.height)}}` +
  `function arPB(ps){var x1=1e9,y1=1e9,x2=-1e9,y2=-1e9,i,p;for(i=0;i<ps.length;i++){p=ps[i];if(p.x<x1)x1=p.x;if(p.y<y1)y1=p.y;if(p.x>x2)x2=p.x;if(p.y>y2)y2=p.y}return arRect(x1,y1,x2-x1,y2-y1)}` +
  `function arD(ps){var s="",i;for(i=0;i<ps.length;i++)s+=(i?"L":"M")+ps[i].x+" "+ps[i].y;return s}` +
  `function arEnd(p){if(!AR)return;var h=AR.host,cur=AR.cur,ac=AR.ac;AR=null;ac.abort();try{h.remove()}catch(x){}try{cur.remove()}catch(x){}window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_ANNOTATION_MESSAGE)},payload:p||null},"*")}` +
  `function arLive(){if(AR&&AR.desc){try{var b=AR.desc.node.getBoundingClientRect();AR.desc.bounds=arRect(b.left,b.top,b.width,b.height)}catch(x){AR.desc=null}}}` +
  `function arEd(){if(!AR)return;var ed=AR.ed,ew=ed.offsetWidth,eh=ed.offsetHeight,vw=window.innerWidth,vh=window.innerHeight,t=AR.desc?AR.desc.bounds:AR.regions.length?AR.regions[AR.regions.length-1].rect:AR.strokes.length?AR.strokes[AR.strokes.length-1].bounds:null,x,y;if(t){x=t.x+t.width/2;y=t.y+t.height+10;if(y+eh>vh-8&&t.y-10-eh>56)y=t.y-10-eh;if(y+eh>vh-8)y=Math.max(56,vh-8-eh)}else{x=vw/2;y=vh-16}x=Math.max(8+ew/2,Math.min(vw-8-ew/2,x));ed.style.left=Math.round(x-ew/2)+"px";ed.style.top=Math.round(Math.max(56,y))+"px"}` +
  `function arPaint(){if(!AR)return;arLive();var L=AR.lyr,i;while(L.firstChild)L.removeChild(L.firstChild);for(i=0;i<AR.strokes.length;i++){var p=document.createElementNS(NS,"path");p.setAttribute("d",arD(AR.strokes[i].points));p.setAttribute("class","stk");L.appendChild(p)}for(i=0;i<AR.regions.length;i++){var r=document.createElementNS(NS,"rect"),q=AR.regions[i].rect;r.setAttribute("x",q.x);r.setAttribute("y",q.y);r.setAttribute("width",q.width);r.setAttribute("height",q.height);r.setAttribute("class","rgn");L.appendChild(r)}if(AR.pts){var cp=document.createElementNS(NS,"path");cp.setAttribute("d",arD(AR.pts));cp.setAttribute("class","stk");L.appendChild(cp)}if(AR.mq){var a=Math.min(AR.mq.x1,AR.mq.x2),b0=Math.min(AR.mq.y1,AR.mq.y2);AR.mb.style.display="block";AR.mb.style.left=Math.round(a)+"px";AR.mb.style.top=Math.round(b0)+"px";AR.mb.style.width=Math.round(Math.abs(AR.mq.x2-AR.mq.x1))+"px";AR.mb.style.height=Math.round(Math.abs(AR.mq.y2-AR.mq.y1))+"px"}else AR.mb.style.display="none";if(AR.desc){var t=AR.desc.bounds;AR.hb.style.display="block";AR.hb.style.left=Math.round(t.x)+"px";AR.hb.style.top=Math.round(t.y)+"px";AR.hb.style.width=Math.round(t.width)+"px";AR.hb.style.height=Math.round(t.height)+"px";AR.hl.textContent=AR.desc.selector;AR.hl.style.display="block";AR.hl.style.left=Math.round(t.x)+"px";AR.hl.style.top=Math.round(Math.max(4,t.y-22))+"px"}else{AR.hb.style.display="none";AR.hl.style.display="none"}var has=!!AR.desc||AR.regions.length>0||AR.strokes.length>0;if(has){var vis=AR.ed.style.display==="flex";AR.ed.style.display="flex";if(!vis){try{AR.ta.focus({preventScroll:true})}catch(x){}}arEd()}else AR.ed.style.display="none"}` +
  `function arUndo(){if(!AR||!AR.ops.length)return;var op=AR.ops.pop();if(op.k==="r")AR.regions.pop();else if(op.k==="s")AR.strokes.pop();else AR.desc=op.prev;arPaint()}` +
  `function arSend(){if(!AR)return;var out=[];if(AR.desc)out.push({selector:AR.desc.selector,html:AR.desc.html,text:AR.desc.text,attributes:AR.desc.attributes,styles:AR.desc.styles,bounds:AR.desc.bounds});arEnd({viewport:{width:window.innerWidth,height:window.innerHeight},comment:AR.ta.value.trim().slice(0,4000),elements:out,regions:AR.regions.slice(0,24),strokes:AR.strokes.slice(0,32)})}` +
  `function arHit(e){var el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===document.documentElement||el===document.body)return null;if(el.getRootNode&&el.getRootNode()!==document)return null;return el}` +
  `function arStart(lb){arEnd(null);var ac=new AbortController(),sig={signal:ac.signal};var host=document.createElement("div");host.setAttribute("data-codeg-annotation","");var sr=host.attachShadow({mode:"closed"});` +
  `sr.innerHTML='<style>:host{all:initial;position:fixed;inset:0;display:block;z-index:2147483000;pointer-events:none}:where(button,textarea){all:unset;box-sizing:border-box;font:inherit}.lyr{position:absolute;inset:0;width:100%;height:100%}.lyr .stk{fill:none;stroke:#ea580c;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.lyr .rgn{fill:color-mix(in srgb,#ea580c 10%,transparent);stroke:#ea580c;stroke-width:1.5;stroke-dasharray:4 3}.box{position:absolute;border:1.5px solid #ea580c;background:color-mix(in srgb,#ea580c 12%,transparent);display:none}.lbl{position:absolute;background:#ea580c;color:#fff;font:500 11px/1.4 var(--font-sans,system-ui);padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden}.tools{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--card);border:1px solid var(--border);box-shadow:0 4px 14px rgba(0,0,0,.28);pointer-events:auto}.tools button{padding:4px 12px;border-radius:999px;color:var(--muted-foreground);font:500 12px/1.4 var(--font-sans,system-ui);cursor:pointer}.tools button:hover{color:var(--foreground)}.tools button[aria-pressed=true]{background:#ea580c;color:#fff}.edit{position:absolute;display:none;gap:6px;align-items:flex-end;background:var(--card);border:2px solid #ea580c;border-radius:8px;padding:6px;pointer-events:auto;max-width:calc(100vw - 16px);box-shadow:0 6px 24px rgba(0,0,0,.3);animation:arPop .18s ease-out}.edit textarea{display:block;min-width:260px;max-width:min(400px,60vw);width:340px;height:38px;max-height:104px;overflow:auto;color:var(--card-foreground);font:400 13px/1.5 var(--font-sans,system-ui);cursor:text}@keyframes arPop{from{transform:scale(.94);opacity:0}}.edit textarea::placeholder{color:var(--muted-foreground)}.edit .snd{align-self:stretch;padding:0 12px;border-radius:6px;background:#ea580c;color:#fff;font:600 12px/1.4 var(--font-sans,system-ui);cursor:pointer}</style>'+'<svg class="lyr" xmlns="'+NS+'"></svg><div class="box"></div><div class="lbl"></div><div class="box" style="border-style:dashed"></div><div class="tools"><button type="button" aria-pressed="true"></button><button type="button"></button><button type="button"></button><button type="button"></button></div><div class="edit"><textarea rows="1"></textarea><button type="button" class="snd"></button></div>';` +
  `document.body.appendChild(host);var q=function(s){return sr.querySelector(s)};var cur=document.createElement("style");cur.textContent="";document.head.appendChild(cur);` +
  `AR={ac:ac,host:host,cur:cur,lyr:q(".lyr"),hb:q(".box"),hl:q(".lbl"),mb:sr.querySelectorAll(".box")[1],ed:q(".edit"),ta:q("textarea"),desc:null,hov:null,mode:"element",regions:[],strokes:[],ops:[],mq:null,pts:null};` +
  `var bs=sr.querySelectorAll(".tools button");bs[0].textContent=lb.element||"Element";bs[1].textContent=lb.region||"Region";bs[2].textContent=lb.draw||"Draw";bs[3].textContent=lb.cancel||"Cancel";AR.ta.placeholder=lb.placeholder||"Note (optional)";q(".snd").textContent=lb.send||"Send";` +
  `function setMode(m){AR.mode=m;bs[0].setAttribute("aria-pressed",String(m==="element"));bs[1].setAttribute("aria-pressed",String(m==="region"));bs[2].setAttribute("aria-pressed",String(m==="draw"));cur.textContent=m==="element"?"":"html{cursor:crosshair!important}";AR.hb.style.display="none";arPaint()}` +
  `bs[0].addEventListener("click",function(){setMode("element")});bs[1].addEventListener("click",function(){setMode("region")});bs[2].addEventListener("click",function(){setMode("draw")});bs[3].addEventListener("click",function(){arEnd(null)});q(".snd").addEventListener("click",arSend);` +
  `AR.ta.addEventListener("keydown",function(e){var z=e.key==="z"||e.key==="Z";if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&z&&AR.ops.length){e.preventDefault();arUndo();return}if(e.key==="Escape"){arEnd(null);return}if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.stopPropagation();arSend()}else e.stopPropagation()});` +
  `AR.ta.addEventListener("input",function(){AR.ta.style.height="auto";AR.ta.style.height=Math.min(104,AR.ta.scrollHeight)+"px";arEd()});` +
  `document.addEventListener("pointerdown",function(e){if(e.button!==0||e.target===host)return;e.preventDefault();e.stopPropagation();if(AR.mode==="element"){var el=arHit(e),pv=AR.desc;if(el){if(pv&&pv.node===el)AR.desc=null;else AR.desc=arDesc(el)}else AR.desc=null;if(AR.desc!==pv)AR.ops.push({k:"e",prev:pv});arPaint()}else if(AR.mode==="region"){AR.mq={x1:e.clientX,y1:e.clientY,x2:e.clientX,y2:e.clientY}}else{AR.pts=[{x:e.clientX,y:e.clientY}];arPaint()}},sig);` +
  `document.addEventListener("pointermove",function(e){if(AR.mode==="region"&&AR.mq){AR.mq.x2=e.clientX;AR.mq.y2=e.clientY;arPaint()}else if(AR.mode==="draw"&&AR.pts){if(AR.pts.length<2000)AR.pts.push({x:e.clientX,y:e.clientY});arPaint()}else if(AR.mode==="element"&&!AR.desc){var el=arHit(e);if(el){var b=el.getBoundingClientRect();AR.hb.style.display="block";AR.hb.style.left=Math.round(b.left)+"px";AR.hb.style.top=Math.round(b.top)+"px";AR.hb.style.width=Math.round(b.width)+"px";AR.hb.style.height=Math.round(b.height)+"px"}else AR.hb.style.display="none"}},sig);` +
  `document.addEventListener("pointerup",function(){if(AR.mode==="region"&&AR.mq){var m=AR.mq,x=Math.min(m.x1,m.x2),y=Math.min(m.y1,m.y2),w=Math.abs(m.x2-m.x1),h=Math.abs(m.y2-m.y1);if(w>=3&&h>=3){AR.regions.push({id:"region-"+(AR.regions.length+1),rect:arRect(x,y,w,h)});AR.ops.push({k:"r"})}AR.mq=null;arPaint()}else if(AR.mode==="draw"&&AR.pts){if(AR.pts.length>=2){AR.strokes.push({id:"stroke-"+(AR.strokes.length+1),points:AR.pts,bounds:arPB(AR.pts)});AR.ops.push({k:"s"})}AR.pts=null;arPaint()}},sig);` +
  `ABLK.forEach(function(t){window.addEventListener(t,function(e){if(e.target!==host){e.preventDefault();e.stopPropagation()}},sig)});` +
  `window.addEventListener("keydown",function(e){if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229&&(e.key==="z"||e.key==="Z")&&AR&&AR.ops.length){e.preventDefault();arUndo()}},sig);` +
  `window.addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.isComposing&&e.keyCode!==229){e.stopPropagation();arEnd(null)}},sig);` +
  `window.addEventListener("scroll",function(){arPaint()},sig);window.addEventListener("resize",function(){arPaint()},sig)}`

// Runs in the page's head, before its own styles and scripts. It rewrites its
// own <style> element rather than setting inline properties, so the page's own
// :root rules still win. The reported height is the content height (root or
// body scroll height, whichever is lower on the page), so the frame always
// fits the page and the chat scrolls around it.
const BOOTSTRAP_SCRIPT =
  `(function(){var s=document.getElementById("codeg-render-theme");if(!s||window.parent===window)return;var B=${JSON.stringify(BASE_CSS)};` +
  `window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(RENDER_PAGE_THEME_MESSAGE)}||!d.variables||typeof d.variables!=="object")return;var c=":root{color-scheme:"+(d.appearance==="light"?"light":"dark")+";";for(var k in d.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(d.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+B;});` +
  `document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null,u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_OPEN_LINK_MESSAGE)},url:u.href},"*");},true);` +
  `var h=0,r=function(){var el=document.documentElement,b=document.body,v=el.scrollHeight;if(b){v=Math.max(v,b.scrollHeight,b.getBoundingClientRect().bottom+window.scrollY);}v=Math.ceil(v);if(!v||v===h)return;h=v;window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_SIZE_MESSAGE)},height:v},"*");};window.addEventListener("resize",r);` +
  `if(window.ResizeObserver){new ResizeObserver(r).observe(document.documentElement);}` +
  `document.addEventListener("DOMContentLoaded",r);window.addEventListener("load",r);` +
  // Selection reporting, for the host's quote bubble: the selected text and
  // its viewport rect go up debounced (200ms), forced on pointerup (a same-text
  // re-report refreshes the rect after the caret stopped moving) and on any
  // scroll. An empty text means the selection went away. A host-sent
  // clear-selection resets the memo first, so the removal is never echoed
  // back up. Escape reaches the host only while a selection was reported —
  // the page decides whether it consumed the key.
  `var L="",LE=true,TT=0;function ss(f){var s=window.getSelection?window.getSelection():null,t=s?s.toString():"";if(!t){if(!LE){LE=true;L="";window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_SELECTION_MESSAGE)},text:"",rect:null},"*");}return;}if(t===L&&!f)return;L=t;LE=false;var b=null;if(s.rangeCount){try{b=s.getRangeAt(0).getBoundingClientRect();}catch(x){}}if(!b)return;window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_SELECTION_MESSAGE)},text:t.slice(0,${RENDER_PAGE_SELECTION_MAX}),rect:{x:b.left,y:b.top,width:b.width,height:b.height}},"*");}` +
  `document.addEventListener("selectionchange",function(){clearTimeout(TT);TT=setTimeout(function(){ss(false);},200);});` +
  `document.addEventListener("pointerup",function(){ss(true);});` +
  `window.addEventListener("scroll",function(){ss(true);},true);` +
  `document.addEventListener("keydown",function(e){if(!LE&&e.key==="Escape"&&e.isTrusted&&!e.isComposing){setTimeout(function(){if(!e.defaultPrevented)window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_SELECTION_ESCAPE_MESSAGE)}},"*");},0);}});` +
  // The annotation overlay (element / region / draw), the counterpart of
  // openchamber's injected overlay script. One session at a time, opened by a
  // start message from the host: it builds its own chrome in a closed shadow
  // root (the page's CSS can neither reach it nor break it), swallows the
  // page's own pointer sequence while it's up, and posts exactly one
  // annotation message back — the payload, or null for cancelled. Colors ride
  // the theme's CSS variables, which inherit into the shadow root.
  ANNOT_SCRIPT +
  `window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(RENDER_PAGE_ANNOTATE_MESSAGE)})return;if(d.action==="start"){arStart(d.labels||{});}else if(AR){arEnd(null);}});` +
  `window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(RENDER_PAGE_CLEAR_SELECTION_MESSAGE)})return;L="";LE=true;if(window.getSelection){try{window.getSelection().removeAllRanges();}catch(x){}}});})();`

// `codeg.render.submit` checks what it can in the page (the host re-checks the
// waiting state, since a page can replace this script) and posts the
// submission; the host's reply settles the promise. A state message from the
// host ends the wait when it ended elsewhere (another window answered, or the
// user dismissed the card).
const ANSWER_SCRIPT =
  `(function(){if(window.parent===window)return;var S=JSON.parse(document.getElementById("codeg-render-answer").textContent),I=0,R={};` +
  `var g=window.codeg=window.codeg||{};var o=g.render={answer:S.answer===null?undefined:S.answer,submit:function(data,summary){return new Promise(function(res,rej){` +
  `if(!S.waiting)return rej(new Error("This page is not waiting for an answer"));` +
  `if(navigator.userActivation&&!navigator.userActivation.isActive)return rej(new Error("codeg.render.submit works only from a click"));` +
  `if(typeof summary!=="string"||!summary.trim())return rej(new Error("summary is required: the choice in a few words"));` +
  `var id=++I,v=data===undefined?null:data;try{var t=JSON.stringify(v);if(t&&t.length>16000)return rej(new Error("data must stay under 16000 characters as JSON"));}catch(x){return rej(new Error("data must be JSON-serializable"));}` +
  `R[id]={res:res,rej:rej,data:v};try{window.parent.postMessage({type:${JSON.stringify(RENDER_PAGE_SUBMIT_MESSAGE)},id:id,summary:summary,data:v},"*");}catch(x){delete R[id];rej(x);}});}};` +
  `window.addEventListener("message",function(e){var d=e.data,r;if(e.source!==window.parent||!d)return;` +
  `if(d.type===${JSON.stringify(RENDER_PAGE_ANSWER_STATE_MESSAGE)}){S={waiting:d.waiting===true,answer:d.answer===undefined?null:d.answer};o.answer=S.answer===null?undefined:S.answer;return;}` +
  `if(d.type===${JSON.stringify(RENDER_PAGE_SUBMIT_REPLY_MESSAGE)}&&R[d.id]){r=R[d.id];delete R[d.id];if(d.ok===false)r.rej(new Error(String(d.message||"The answer was not sent")));else{S={waiting:false,answer:r.data};o.answer=r.data;r.res();}}});})();`

// JSON inside a script element: "<" is escaped so no "</script>" in the data
// can close it.
const scriptJson = (value: RenderPageAnswerState): string =>
  JSON.stringify(value).replace(/</g, "\\u003c")

// Comments and raw-text elements are blanked to the same length before the
// head is located, so a "<head>" written inside a script or comment is never
// where the bootstrap lands.
const blankNonMarkup = (html: string): string =>
  html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => " ".repeat(match.length)
  )

/** The document the frame loads: the agent's page with the bootstrap first in
 *  its head. `answerState` is where the page stands on its answer when it
 *  loads; later changes reach it as messages. */
export function buildRenderPageDocument(
  html: string,
  theme: RenderPageTheme,
  answerState: RenderPageAnswerState = { waiting: false, answer: null }
): string {
  const scan = blankNonMarkup(html)
  const bootstrap = [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096))
      ? ""
      : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="codeg-render-theme">${renderPageThemeCss(theme)}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
    `<script type="application/json" id="codeg-render-answer">${scriptJson(answerState)}</script>`,
    `<script>${ANSWER_SCRIPT}</script>`,
  ].join("")
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + bootstrap + html.slice(at)
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${bootstrap}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(scan)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${bootstrap}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${bootstrap}</head>${html}`
}

export const renderPageThemeMessage = (theme: RenderPageTheme) => ({
  type: RENDER_PAGE_THEME_MESSAGE,
  ...theme,
})

export const renderPageAnswerStateMessage = (state: RenderPageAnswerState) => ({
  type: RENDER_PAGE_ANSWER_STATE_MESSAGE,
  ...state,
})

/** The host's reply to a page's submit; `message` set = the promise rejects
 *  with it. */
export const renderPageSubmitReply = (id: number, message?: string) =>
  message === undefined
    ? { type: RENDER_PAGE_SUBMIT_REPLY_MESSAGE, id, ok: true }
    : { type: RENDER_PAGE_SUBMIT_REPLY_MESSAGE, id, ok: false, message }

/** Tell the page to drop its selection (and not echo the removal back). */
export const renderPageClearSelectionMessage = () => ({
  type: RENDER_PAGE_CLEAR_SELECTION_MESSAGE,
})

export type RenderPageSubmit = {
  kind: "submit"
  id: number
  summary: string
  data: RenderPageAnswerData
}

export type RenderPageSelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

// ── in-page annotations (element / region / draw) ─────────────────────
//
// Mirrors openchamber's annotation payload (its contract.ts), cut to what a
// chat page can carry without a desktop capture path: no screenshot — the
// prompt the host formats says so, exactly like openchamber's own web build.

export interface RenderPageAnnotationElement {
  /** A CSS selector good enough for the agent to find the node again (id
   *  shortcut, then a ≤5-level path with nth-of-type disambiguation). */
  selector: string
  /** A snapshot of the node's own markup, capped — the agent's pages are
   *  generated, so showing the tag is what stops a "make THIS bigger" note
   *  from being applied to the whole document. */
  html: string
  /** The element's own visible text, whitespace-collapsed, capped. */
  text: string
  /** The whitelisted attributes the page saw (id/class/href/… each capped). */
  attributes: Record<string, string>
  /** The element's computed styles at pick time (openchamber's
   *  BrowserElementTarget.computedStyle): the font/color/box evidence that
   *  tells the agent what to change on THIS node instead of everywhere. */
  styles: Record<string, string>
  /** Viewport px, rounded at report time. */
  bounds: RenderPageSelectionRect
}

export interface RenderPageAnnotationRegion {
  id: string
  rect: RenderPageSelectionRect
}

export interface RenderPageAnnotationStroke {
  id: string
  points: { x: number; y: number }[]
  bounds: RenderPageSelectionRect
}

export interface RenderPageAnnotationPayload {
  viewport: { width: number; height: number }
  comment: string
  elements: RenderPageAnnotationElement[]
  regions: RenderPageAnnotationRegion[]
  strokes: RenderPageAnnotationStroke[]
}

/** The chrome labels the overlay shows — the host localizes them, the page
 *  only echoes them back (i18n keys: Folder.chat.renderPage.annotate.*). */
export interface RenderPageAnnotationLabels {
  element: string
  region: string
  draw: string
  placeholder: string
  send: string
  cancel: string
}

/** Bounds the page may not exceed; a report that overshoots is dropped whole
 *  rather than trusted, same posture as every other page message. A page built
 *  by {@link buildRenderPageDocument} never trips them — its send clips
 *  regions and strokes to these same bounds — so this only fires on a page
 *  that replaced its own script. */
const ANNOTATION_MAX_COMMENT = 4000
const ANNOTATION_MAX_ELEMENTS = 8
const ANNOTATION_MAX_REGIONS = 24
const ANNOTATION_MAX_STROKES = 32
const ANNOTATION_MAX_POINTS = 2000
const ANNOTATION_MAX_SELECTOR = 300
const ANNOTATION_MAX_HTML = 600
const ANNOTATION_MAX_TEXT = 400
const ANNOTATION_MAX_ATTRS = 16
const ANNOTATION_MAX_STYLES = 22

const fin = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

const readAnnotationRect = (v: unknown): RenderPageSelectionRect | null => {
  if (!v || typeof v !== "object") return null
  const r = v as Record<string, unknown>
  if (!fin(r.x) || !fin(r.y) || !fin(r.width) || !fin(r.height)) return null
  if (r.width < 0 || r.height < 0) return null
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/** Validate one annotation report field by field (the payload crosses the
 *  page boundary; a page can replace its own bootstrap). */
export function readRenderPageAnnotationPayload(
  v: unknown
): RenderPageAnnotationPayload | null {
  if (!v || typeof v !== "object") return null
  const d = v as Record<string, unknown>
  const vp = d.viewport as Record<string, unknown> | null
  if (!vp || typeof vp !== "object" || !fin(vp.width) || !fin(vp.height))
    return null
  if (
    typeof d.comment !== "string" ||
    d.comment.length > ANNOTATION_MAX_COMMENT
  )
    return null
  const elements = d.elements,
    regions = d.regions,
    strokes = d.strokes
  if (
    !Array.isArray(elements) ||
    !Array.isArray(regions) ||
    !Array.isArray(strokes) ||
    elements.length > ANNOTATION_MAX_ELEMENTS ||
    regions.length > ANNOTATION_MAX_REGIONS ||
    strokes.length > ANNOTATION_MAX_STROKES
  )
    return null
  const outElements: RenderPageAnnotationElement[] = []
  for (const e of elements as unknown[]) {
    if (!e || typeof e !== "object") return null
    const eRec = e as Record<string, unknown>
    if (
      typeof eRec.selector !== "string" ||
      eRec.selector.length > ANNOTATION_MAX_SELECTOR ||
      typeof eRec.html !== "string" ||
      eRec.html.length > ANNOTATION_MAX_HTML ||
      typeof eRec.text !== "string" ||
      eRec.text.length > ANNOTATION_MAX_TEXT
    )
      return null
    const attrs: Record<string, string> = {}
    if (eRec.attributes && typeof eRec.attributes === "object") {
      for (const [k, val] of Object.entries(
        eRec.attributes as Record<string, unknown>
      )) {
        if (Object.keys(attrs).length >= ANNOTATION_MAX_ATTRS) return null
        if (typeof val !== "string" || val.length > 200) return null
        attrs[k] = val
      }
    }
    const styles: Record<string, string> = {}
    if (eRec.styles && typeof eRec.styles === "object") {
      for (const [k, val] of Object.entries(
        eRec.styles as Record<string, unknown>
      )) {
        if (Object.keys(styles).length >= ANNOTATION_MAX_STYLES) return null
        if (typeof val !== "string" || val.length > 200) return null
        styles[k] = val
      }
    }
    const bounds = readAnnotationRect(eRec.bounds)
    if (!bounds) return null
    outElements.push({
      selector: eRec.selector,
      html: eRec.html,
      text: eRec.text,
      attributes: attrs,
      styles,
      bounds,
    })
  }
  const outRegions: RenderPageAnnotationRegion[] = []
  for (const rg of regions as unknown[]) {
    if (!rg || typeof rg !== "object") return null
    const rRec = rg as Record<string, unknown>
    if (typeof rRec.id !== "string" || rRec.id.length > 40) return null
    const rect = readAnnotationRect(rRec.rect)
    if (!rect) return null
    outRegions.push({ id: rRec.id, rect })
  }
  const outStrokes: RenderPageAnnotationStroke[] = []
  for (const st of strokes as unknown[]) {
    if (!st || typeof st !== "object") return null
    const sRec = st as Record<string, unknown>
    if (typeof sRec.id !== "string" || sRec.id.length > 40) return null
    if (!Array.isArray(sRec.points) || sRec.points.length < 2) return null
    const points: { x: number; y: number }[] = []
    for (const p of sRec.points as unknown[]) {
      if (points.length >= ANNOTATION_MAX_POINTS) return null
      if (!p || typeof p !== "object") return null
      const pRec = p as Record<string, unknown>
      if (!fin(pRec.x) || !fin(pRec.y)) return null
      points.push({ x: pRec.x, y: pRec.y })
    }
    const bounds = readAnnotationRect(sRec.bounds)
    if (!bounds) return null
    outStrokes.push({ id: sRec.id, points, bounds })
  }
  return {
    viewport: { width: vp.width, height: vp.height },
    comment: d.comment,
    elements: outElements,
    regions: outRegions,
    strokes: outStrokes,
  }
}

/** The text an annotation session places in the composer — the same English
 *  body openchamber's prompt builder writes, so the agent's reading skill
 *  transfers. Geometry is rounded; each kind numbers independently. */
export function formatRenderPageAnnotation(
  payload: RenderPageAnnotationPayload,
  pageTitle: string
): string {
  const lines: string[] = [
    "The user annotated the page below your request. Apply each note ONLY to the element, region, or drawing it marks — never to the whole page — in your next step.",
  ]
  const title = pageTitle.trim()
  if (title) lines.push(`Page: ${title}`)
  lines.push(
    `Viewport: ${Math.round(payload.viewport.width)}x${Math.round(payload.viewport.height)}`,
    "Screenshot: not attached"
  )
  const comment = payload.comment.trim()
  if (comment) lines.push(`Comment: ${comment}`)
  payload.elements.forEach((e, i) => {
    lines.push(`Element ${i + 1}: ${e.selector}`)
    if (e.html) lines.push(`- HTML: ${e.html}`)
    if (e.text) lines.push(`- Text: ${e.text}`)
    const attrs = Object.entries(e.attributes)
    if (attrs.length)
      lines.push(
        `- Attributes: ${attrs.map(([k, val]) => `${k}="${val}"`).join(" ")}`
      )
    const b = e.bounds
    lines.push(
      `- Bounds: x=${Math.round(b.x)}, y=${Math.round(b.y)}, width=${Math.round(b.width)}, height=${Math.round(b.height)}`
    )
    const st = e.styles
    if (Object.keys(st).length) {
      lines.push(
        `- Styles: display=${st.display ?? ""}; position=${st.position ?? ""}; font=${st.fontWeight ?? ""} ${st.fontSize ?? ""} / ${st.lineHeight ?? ""} ${st.fontFamily ?? ""}; color=${st.color ?? ""}; background=${st.backgroundColor ?? ""}`
      )
    }
  })
  payload.regions.forEach((rg, i) => {
    const r = rg.rect
    lines.push(
      `Region ${i + 1}: x=${Math.round(r.x)}, y=${Math.round(r.y)}, width=${Math.round(r.width)}, height=${Math.round(r.height)}`
    )
  })
  payload.strokes.forEach((st, i) => {
    const b = st.bounds
    lines.push(
      `Drawing ${i + 1}: ${st.points.length} points over x=${Math.round(b.x)}, y=${Math.round(b.y)}, width=${Math.round(b.width)}, height=${Math.round(b.height)}`
    )
  })
  return lines.join("\n")
}

/** Host → page: open the overlay with these chrome labels, or close it. */
export const renderPageAnnotateMessage = (
  action: "start" | "stop",
  labels?: RenderPageAnnotationLabels
) =>
  labels
    ? { type: RENDER_PAGE_ANNOTATE_MESSAGE, action, labels }
    : { type: RENDER_PAGE_ANNOTATE_MESSAGE, action }

export type RenderPageFrameMessage =
  | { kind: "size"; height: number }
  | { kind: "open-link"; url: string }
  | RenderPageSubmit
  /** The page's selection changed; empty `text` = it went away. `rect` is in
   *  the page's own viewport coordinates — the frame fits the page without
   *  vertical scroll, so they read directly against the frame box. */
  | { kind: "selection"; text: string; rect: RenderPageSelectionRect | null }
  /** Escape was pressed while a selection was up and nothing in the page
   *  consumed it; the host closes its quote bubble. */
  | { kind: "selection-escape" }
  /** One annotation session ended: a payload to place in the composer, or a
   *  null payload when the user cancelled. */
  | { kind: "annotation"; payload: RenderPageAnnotationPayload | null }

/** The message a page's bootstrap posted, or null for anything else. Hand-
 *  checked rather than zod-typed: the payloads are three fixed shapes written
 *  by our own bootstrap. */
export function readRenderPageFrameMessage(
  data: unknown
): RenderPageFrameMessage | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  switch (d.type) {
    case RENDER_PAGE_SIZE_MESSAGE:
      return typeof d.height === "number" &&
        Number.isFinite(d.height) &&
        d.height > 0
        ? { kind: "size", height: d.height }
        : null
    case RENDER_PAGE_OPEN_LINK_MESSAGE:
      return typeof d.url === "string" && /^https?:\/\//i.test(d.url)
        ? { kind: "open-link", url: d.url }
        : null
    case RENDER_PAGE_SUBMIT_MESSAGE:
      return typeof d.id === "number" && Number.isInteger(d.id) && d.id > 0
        ? {
            kind: "submit",
            id: d.id,
            summary: typeof d.summary === "string" ? d.summary : "",
            data: d.data === undefined ? null : d.data,
          }
        : null
    case RENDER_PAGE_SELECTION_MESSAGE: {
      if (
        typeof d.text !== "string" ||
        d.text.length > RENDER_PAGE_SELECTION_MAX
      )
        return null
      if (!d.text) return { kind: "selection", text: "", rect: null }
      const r = d.rect as Record<string, unknown> | null
      if (!r || typeof r !== "object") return null
      const x = r.x,
        y = r.y,
        width = r.width,
        height = r.height
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 0 ||
        height < 0
      )
        return null
      return {
        kind: "selection",
        text: d.text,
        rect: { x, y, width, height },
      }
    }
    case RENDER_PAGE_SELECTION_ESCAPE_MESSAGE:
      return { kind: "selection-escape" }
    case RENDER_PAGE_ANNOTATION_MESSAGE: {
      // A null payload is the cancel; a malformed one is not a report at all.
      if (d.payload === null) return { kind: "annotation", payload: null }
      const payload = readRenderPageAnnotationPayload(d.payload)
      return payload ? { kind: "annotation", payload } : null
    }
    default:
      return null
  }
}

export const clampRenderPageHeight = (height: number): number =>
  Math.min(
    RENDER_PAGE_MAX_HEIGHT,
    Math.max(RENDER_PAGE_MIN_HEIGHT, Math.ceil(height))
  )

/** The answer submission to `acp_answer_render_page` from a page submit. */
export const renderPageAnswerFromSubmit = (
  submit: RenderPageSubmit
): RenderPageAnswer => ({
  summary: submit.summary,
  data: submit.data,
  declined: false,
})

// ── persisted tool-call payloads (in-stream record card) ──────────────

/** The parsed `render_page` tool input, as persisted on the tool call. */
export interface RenderPageToolInput {
  html: string
  title: string
  awaitAnswer: boolean
}

/** Lenient parse of the tool input. The only hard requirement is `html` —
 *  a call whose input hasn't finished streaming, or that a truncated
 *  transcript cut, reads as "nothing to draw" (null) rather than a broken
 *  card. `title`/`awaitAnswer` collapse to the tool's own defaults. */
export function parseRenderPageInput(
  input: string | null | undefined
): RenderPageToolInput | null {
  if (!input) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const d = parsed as Record<string, unknown>
  const html = typeof d.html === "string" ? d.html : ""
  if (!html.trim()) return null
  return {
    html,
    title: typeof d.title === "string" ? d.title.trim() : "",
    awaitAnswer: d.awaitAnswer === true,
  }
}

/** What a settled `render_page` call ended as, read back from its output. */
export type RenderPageToolOutcome =
  | { kind: "shown" }
  | { kind: "answered"; summary: string }
  | { kind: "declined" }

function outcomeFromEnvelope(
  d: Record<string, unknown>
): RenderPageToolOutcome | null {
  if (d.shown === true) return { kind: "shown" }
  if (d.answered === true) {
    return {
      kind: "answered",
      summary: typeof d.summary === "string" ? d.summary : "",
    }
  }
  if (d.answered === false || d.declined === true) return { kind: "declined" }
  return null
}

function outcomeFromText(text: string): RenderPageToolOutcome | null {
  if (/The user answered on the page/i.test(text)) {
    // The companion's note line: "summary: <the choice in a few words>".
    const m = text.match(/^summary:[ \t](.*)$/m)
    return { kind: "answered", summary: (m?.[1] ?? "").trim() }
  }
  if (/did not answer on the page/i.test(text)) return { kind: "declined" }
  if (/Shown to the user in the chat/i.test(text)) return { kind: "shown" }
  return null
}

/**
 * Reconstruct the settled outcome from the persisted tool result.
 *
 * Primary shape — the `structuredContent` envelope the companion returns
 * (`{shown:true,…}` for a show-only call; `{answered,summary,data,note}` for
 * an awaited one). Fallback — the `content[0].text` note itself, for any CLI
 * that stores the text rather than the structured payload (see
 * `render_page_answer_result` / `render_shown_result`). Returns `null` while
 * the call is still in flight (no output).
 */
export function parseRenderPageOutcome(
  output: string | null | undefined
): RenderPageToolOutcome | null {
  if (!output || !output.trim()) return null
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === "object") {
      const d = parsed as Record<string, unknown>
      const direct = outcomeFromEnvelope(d)
      if (direct) return direct
      const inner = d.structuredContent
      if (inner && typeof inner === "object") {
        const fromInner = outcomeFromEnvelope(inner as Record<string, unknown>)
        if (fromInner) return fromInner
      }
      // MCP result wrapper: pull the text parts out and read the notes.
      const parts = Array.isArray(d.content) ? d.content : null
      if (parts) {
        const text = parts
          .map((p) =>
            p &&
            typeof p === "object" &&
            typeof (p as Record<string, unknown>).text === "string"
              ? ((p as Record<string, unknown>).text as string)
              : ""
          )
          .join("\n")
        const fromText = outcomeFromText(text)
        if (fromText) return fromText
      }
    }
  } catch {
    // Not JSON — a plain-text output; fall through to the note matchers.
  }
  return outcomeFromText(output)
}
