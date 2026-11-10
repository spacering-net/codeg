export const HTML_PREVIEW_SIZE_MESSAGE_TYPE = "codeg-visualize:size"

/** Theme tokens codeg shares with the Codex visualize skill's contract. */
const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
] as const

/**
 * Reports the content's height to the parent whenever it changes.
 *
 * Measured off the content boxes — the root's box (which holds `<body>`'s
 * margins, collapsed ones included) and `<body>`'s own overflow — never off
 * the root's `scrollHeight`, which does not drop below the frame's current
 * height and so could only ever grow the card. Nothing is reported before
 * there is a layout to measure. Content whose height follows the viewport
 * (`100vh` layouts) grows by exactly as much as the frame does; once a resize
 * shows that, the reporter falls silent and the frame keeps the height it last
 * asked for (the content scrolls), or every step of "Show all" would ask for
 * another — and chasing a mid-transition viewport would never settle either.
 */
export const HTML_PREVIEW_SIZE_REPORTER = `<script>(()=>{
const type=${JSON.stringify(HTML_PREVIEW_SIZE_MESSAGE_TYPE)};
let lastHeight=0,lastViewport=innerHeight,sent=0,coupled=false,queued=false;
const measure=()=>{const d=document.documentElement,b=document.body;if(!b)return 0;const root=d.getBoundingClientRect().height,box=b.getBoundingClientRect().height;if(root===0&&box===0)return 0;const s=getComputedStyle(b);return Math.ceil(Math.max(root,Math.max(b.scrollHeight,box)+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0)))};
const send=(h)=>{if(!coupled&&h>0&&h!==sent){sent=h;parent.postMessage({type,height:h},"*")}};
const update=()=>{queued=false;lastHeight=measure();lastViewport=innerHeight;send(lastHeight)};
const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(update)}};
addEventListener("resize",()=>{const h=measure(),v=innerHeight;if(lastHeight>0&&lastViewport>0&&v>lastViewport&&h>v&&Math.abs(h-lastHeight-(v-lastViewport))<=1)coupled=true;lastHeight=h;lastViewport=v;send(h)});
const ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);
new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
addEventListener("load",update);
})();</script>`

/** Copy codeg's current theme tokens into the frame's variable contract. */
export function readHtmlPreviewTheme(): string {
  if (typeof document === "undefined") return ""
  const style = getComputedStyle(document.documentElement)
  const decls: string[] = []
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(`--${token}`).trim()
    if (value) decls.push(`--${token}:${value}`)
  }
  // The skill aliases its first chart series to `--primary`. codeg's primary
  // is near-black on the neutral presets, which turned every series-1 bar
  // and line black; keep the skill's own blue for charts while controls
  // still follow codeg's primary.
  decls.push("--viz-series-1:var(--blue)")
  return `:root{${decls.join(";")}}`
}

/** The reporter for a frame whose CSP admits only scripts carrying `nonce`. */
export function htmlPreviewSizeReporter(nonce: string): string {
  return HTML_PREVIEW_SIZE_REPORTER.replace(
    "<script>",
    `<script nonce="${nonce}">`
  )
}
