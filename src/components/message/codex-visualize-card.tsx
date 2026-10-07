"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  RotateCw,
  ShieldCheck,
  ShieldOff,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import { useTranscriptRoot } from "@/components/ai-elements/markdown-local-image"
import {
  getHomeDirectory,
  listDirectoryEntries,
  readFileBase64,
  readWorkspaceFileBase64,
} from "@/lib/api"
import {
  expandHomePath,
  isHomeRelativePath,
  joinRootRel,
} from "@/lib/file-open-target"
import { isAbsoluteFilePath } from "@/lib/file-path-display"
import {
  extractHtmlTitle,
  inlineHtmlResources,
  withSandboxCsp,
} from "@/lib/html-preview-inline"
import {
  isCompleteHtmlDocument,
  type CodexVisualizeMode,
} from "@/lib/codex-visualize"
import { cn } from "@/lib/utils"

/**
 * One inline visualization from Codex's `visualize` skill: the referenced
 * HTML *fragment*, wrapped in the same kind of document the Codex app builds
 * around it, in a sandboxed `srcdoc` iframe that sizes itself to its content.
 *
 * The wrapper mirrors the skill's own `render.py`:
 *   - the skill's `visualize.css` (theme-variable contract + `.card`, `.btn`,
 *     `.nav-pills`… utilities) and `visualize.html` (the fragment slot plus the
 *     tooltip runtime) are read from the locally installed Codex plugin, so the
 *     fragment renders exactly as Codex intended. When the plugin is not
 *     installed a small built-in stylesheet supplies the variable contract so
 *     the fragment still has sensible colours.
 *   - the frame CSP is the skill's: inline scripts may run (interactivity is
 *     the point of these visuals) but the frame cannot reach the network
 *     except for the handful of CDNs the skill itself allows, and cannot open
 *     sub-frames or submit forms.
 *   - `window.openai` is stubbed the way the skill's standalone bridge does
 *     it, since fragments are told to read and save their state through it.
 *
 * A *complete* document (anything an agent wrote as a page) is not a Codex
 * fragment and gets codeg's file-preview treatment instead — including its
 * rule that no script runs until the user enables scripts for it.
 *
 * The theme-variable contract (`--background`, `--foreground`, `--card`…) uses
 * the same names codeg's own shadcn tokens use, so the current codeg theme is
 * copied into the frame and the visual matches the transcript around it.
 */

const CODEX_PLUGIN_VISUALIZE_DIR =
  ".codex/plugins/cache/openai-bundled/visualize"
const FRAGMENT_PLACEHOLDER = "<!--__INLINE_VISUALIZATION_FRAGMENT__-->"
/** The skill refuses fragments over 1 MB; leave headroom for exports. */
const MAX_FRAGMENT_BYTES = 4 * 1024 * 1024
const MIN_FRAME_HEIGHT = 96
const DEFAULT_FRAME_HEIGHT = 320
/** A document shown without scripts cannot report its height; give it a
 *  reading-sized window that scrolls. */
const STATIC_DOCUMENT_HEIGHT = 480
const COLLAPSED_MAX_HEIGHT = 640
/** Backstop for "Show all": past this the frame scrolls instead of growing. */
const MAX_FRAME_HEIGHT = 12000
const SIZE_MESSAGE_TYPE = "codeg-visualize:size"

const RESOURCE_SOURCES = [
  "blob:",
  "data:",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://fonts.bunny.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
].join(" ")

const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  // The skill's own policy says `'none'`; codeg pins the base to the frame's
  // `about:srcdoc` instead (see FRAME_BASE), which no external origin can use.
  "base-uri about:",
  "form-action 'none'",
].join("; ")

/**
 * A `srcdoc` document without a `<base>` resolves URLs against the PARENT's
 * base URL, so an in-page `#anchor` link would navigate the frame to codeg
 * itself. Same pin as the file preview's (`html-preview-inline.ts`).
 */
const FRAME_BASE = `<base href="about:srcdoc">`

/** Names shared by the skill's contract and codeg's theme tokens. */
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
 * Used only when the Codex plugin's own stylesheet cannot be found. Supplies
 * the variable contract and the few utilities fragments lean on most; it does
 * not try to reproduce the skill's full design system.
 */
const FALLBACK_VISUALIZE_CSS = `
:root{color-scheme:light dark;
--background:light-dark(rgb(255 255 255),rgb(24 24 24));
--foreground:light-dark(rgb(26 28 31),rgb(255 255 255));
--card:color-mix(in oklab,var(--foreground) 5%,var(--background));
--card-foreground:var(--foreground);
--popover:light-dark(rgb(255 255 255),rgb(45 45 45));
--popover-foreground:var(--foreground);
--primary:light-dark(rgb(51 156 255),rgb(131 195 255));
--primary-foreground:light-dark(rgb(255 255 255),rgb(13 13 13));
--secondary:light-dark(rgb(255 255 255 / 96%),rgb(54 54 54 / 96%));
--secondary-foreground:var(--foreground);
--muted:color-mix(in srgb,var(--foreground) 10%,transparent);
--muted-foreground:light-dark(rgb(26 28 31 / 49.4%),rgb(255 255 255 / 49.8%));
--accent:color-mix(in srgb,var(--primary) 12%,transparent);
--accent-foreground:var(--foreground);
--destructive:light-dark(rgb(220 38 38),rgb(248 113 113));
--border:color-mix(in srgb,var(--foreground) 15%,transparent);
--input:var(--border);--ring:var(--primary);
--blue:light-dark(rgb(51 156 255),rgb(131 195 255));
--orange:light-dark(rgb(255 140 0),rgb(255 170 70));
--green:light-dark(rgb(34 160 90),rgb(90 210 140));
--red:light-dark(rgb(220 60 60),rgb(255 120 120));
--purple:light-dark(rgb(140 90 230),rgb(180 150 255));
--yellow:light-dark(rgb(220 170 0),rgb(255 210 80));
--viz-series-1:var(--blue);--viz-series-2:var(--orange);--viz-series-3:var(--green);
--viz-series-4:var(--red);--viz-series-5:var(--purple);--viz-series-6:var(--yellow);
--font-size-base:14px}
html,body{margin:0;background:var(--background);color:var(--foreground);
font:var(--font-size-base)/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
body{padding:1rem;box-sizing:border-box}
*,*::before,*::after{box-sizing:border-box}
.card{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:12px;padding:12px}
.btn{display:inline-flex;align-items:center;gap:.4em;padding:.4em .8em;border:1px solid var(--border);border-radius:8px;background:var(--secondary);color:var(--foreground);font:inherit;cursor:pointer}
.btn:hover{background:var(--accent)}
.btn[aria-pressed="true"],.btn[aria-selected="true"],.btn.is-selected,.btn-primary{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
.btn-ghost{background:transparent;border-color:transparent}
.btn-block{width:100%;justify-content:center}
.nav.nav-pills{display:flex;gap:4px;flex-wrap:wrap}
.nav-link{padding:.35em .8em;border-radius:999px;border:0;background:transparent;color:var(--muted-foreground);font:inherit;cursor:pointer}
.nav-link.active{background:var(--muted);color:var(--foreground)}
.progress{height:8px;border-radius:999px;background:var(--muted);overflow:hidden}
.progress-bar{height:100%;background:var(--primary)}
.tooltip{position:absolute;pointer-events:none;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px}
.form-check{display:flex;align-items:center;gap:.5em}
a{color:var(--primary)}
svg text{fill:var(--foreground)}
`

/**
 * Breathing room between the fragment and the card edge. In the Codex app the
 * outer shell supplies this (`body{padding:1rem}` around the inner frame); this
 * card has no shell, so the inner document carries it instead of the skill's
 * flush `padding:0`.
 */
const FRAME_PADDING = "1rem 1.25rem"

/**
 * The skill's stylesheet paints `:root` with `--background` (`!important`), which
 * is right for a standalone page but wrong inside a transcript: the card sits on
 * whatever the window shows — a plain surface, or the user's workspace background
 * image — and an opaque cream slab in the middle of it reads as a foreign object.
 * Painting nothing lets the card's own (translucent-when-backgrounded) surface
 * show through; the fragment's cards/buttons keep their `--card` / `--muted` fills.
 * The selector has to be `:root` too: the skill's rule is `:root{…!important}`,
 * which an `html{…!important}` rule loses to on specificity.
 */
const TRANSPARENT_CANVAS_CSS =
  ":root,body{background:transparent !important;background-color:transparent !important}"

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
const SIZE_REPORTER = `<script>(()=>{
const type=${JSON.stringify(SIZE_MESSAGE_TYPE)};
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

/**
 * The skill tells fragments to keep their state through `window.openai`
 * (`widgetState` / `setWidgetState`, `sendFollowUpMessage`…), so a fragment
 * that reads `window.openai.widgetState` while it renders throws — and draws
 * nothing — in a frame without it. Stubbed the way the skill's standalone
 * bridge (what `render.py` exports) does, minus the host channel: state lives
 * as long as the frame, and nothing is persisted or sent anywhere.
 */
function openaiStub(theme: "light" | "dark"): string {
  return `<script>(()=>{
let state=null;
const openai={theme:${JSON.stringify(theme)},visualizationTheme:${JSON.stringify(theme)},visualizationStyleVariables:{},statePersistence:"none",stateModelContext:"none",widgetState:null,
setWidgetState:async(next)=>{const value=typeof next==="function"?next(state):next;if(value===null||typeof value!=="object"||Array.isArray(value))throw new TypeError("Widget state must be a JSON object");state=value;openai.widgetState=value;dispatchEvent(new CustomEvent("openai:set_globals",{detail:{globals:{widgetState:value}}}))},
sendFollowUpMessage:async()=>{},
openExternal:()=>{}};
window.openai=openai;
})();</script>`
}

interface VisualizeAssets {
  css: string
  /** `visualize.html`: the fragment slot plus the tooltip runtime. */
  kit: string | null
  calendar: string | null
}

const FALLBACK_ASSETS: VisualizeAssets = {
  css: FALLBACK_VISUALIZE_CSS,
  kit: null,
  calendar: null,
}

let assetsPromise: Promise<VisualizeAssets> | null = null

function decodeBase64Utf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder("utf-8").decode(bytes)
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return decodeBase64Utf8(await readFileBase64(path, MAX_FRAGMENT_BYTES))
  } catch {
    return null
  }
}

/**
 * Locate the newest installed version of the Codex `visualize` plugin and read
 * its stylesheet and inner kit. Resolved once per page; a miss falls back to
 * the built-in stylesheet rather than failing the card.
 */
async function loadVisualizeAssets(): Promise<VisualizeAssets> {
  try {
    const home = (await getHomeDirectory()).replace(/[\\/]+$/, "")
    const pluginDir = `${home}/${CODEX_PLUGIN_VISUALIZE_DIR}`
    const versions = (await listDirectoryEntries(pluginDir))
      .map((e) => e.name)
      .filter((name) => /^\d+(\.\d+)*$/.test(name))
      .sort(compareVersionsDesc)
    for (const version of versions) {
      const assets = `${pluginDir}/${version}/skills/visualize/assets`
      const css = await readOptionalText(`${assets}/visualize.css`)
      if (css === null) continue
      const [kit, calendar] = await Promise.all([
        readOptionalText(`${assets}/visualize.html`),
        readOptionalText(`${assets}/calendar.js`),
      ])
      return { css, kit, calendar }
    }
  } catch {
    // Not installed, remote host without the plugin, or unreadable: fall back.
  }
  return FALLBACK_ASSETS
}

function getVisualizeAssets(): Promise<VisualizeAssets> {
  if (assetsPromise === null) assetsPromise = loadVisualizeAssets()
  return assetsPromise
}

/** Tests only. */
export function resetCodexVisualizeAssetsForTests(): void {
  assetsPromise = null
}

/** Copy codeg's current theme tokens into the frame's variable contract. */
function readThemeOverrides(): string {
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

function escapeClosingScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script")
}

function isRelativePath(path: string): boolean {
  return !isHomeRelativePath(path) && !isAbsoluteFilePath(path)
}

/**
 * The file a reference names, as an absolute path: `~/…` against the
 * (remote-aware) home directory, and a relative path — Hermes writes
 * `::preview{file="chart.html"}` against the session's working directory —
 * against the transcript's working directory. `null` when it is relative and
 * the transcript has none.
 */
async function resolvePreviewPath(
  path: string,
  baseDir: string | null
): Promise<string | null> {
  if (!isRelativePath(path)) {
    return isHomeRelativePath(path) ? expandHomePath(path) : path
  }
  return baseDir ? joinRootRel(baseDir, path) : null
}

/**
 * A complete HTML document an agent wrote to disk (a report, a dashboard, a
 * mockup): shown as-is, the way codeg's own file preview shows it — sibling
 * local resources (css / js / images next to it) inlined, the file preview's
 * sandbox CSP applied (strict with scripts off, open-web with scripts on) —
 * plus, when scripts run, the size reporter so the card can fit its height.
 */
export async function buildCompleteDocument(
  html: string,
  absPath: string,
  scripts: boolean
): Promise<string> {
  const fileDir = absPath.replace(/[\\/][^\\/]*$/, "") || "/"
  const inlined = await inlineHtmlResources(html, {
    fileDir,
    folderPath: fileDir,
    // The inliner hands over absolute, slash-normalized paths inside
    // `fileDir`; the confined backend read wants them relative to it.
    readFileBase64: (resource) => {
      const root = fileDir.replace(/\\/g, "/").replace(/\/+$/, "")
      const abs = resource.replace(/\\/g, "/")
      const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs
      return readWorkspaceFileBase64(fileDir, rel)
    },
  })
  const withCsp = withSandboxCsp(inlined, { trusted: scripts })
  // Without scripts the reporter could not run anyway.
  if (!scripts) return withCsp
  const bodyEnd = withCsp.toLowerCase().lastIndexOf("</body>")
  return bodyEnd === -1
    ? withCsp + SIZE_REPORTER
    : withCsp.slice(0, bodyEnd) + SIZE_REPORTER + withCsp.slice(bodyEnd)
}

export function buildVisualizeDocument({
  fragment,
  assets,
  title,
  dark,
  themeOverrides,
}: {
  fragment: string
  assets: VisualizeAssets
  title: string
  dark: boolean
  themeOverrides: string
}): string {
  const calendar =
    assets.calendar && /\bviz-calendar\b/i.test(fragment)
      ? `<script>${escapeClosingScript(assets.calendar)}</script>`
      : ""
  const body = assets.kit
    ? assets.kit.replace(FRAGMENT_PLACEHOLDER, calendar + fragment)
    : calendar + fragment
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<!doctype html>
<html lang="en" style="color-scheme:${dark ? "dark" : "light"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
${FRAME_BASE}
<title>${escapedTitle}</title>
<style>${assets.css}
html>body{padding:${FRAME_PADDING}}</style>
<style>${themeOverrides}</style>
<style>${TRANSPARENT_CANVAS_CSS}</style>
${openaiStub(dark ? "dark" : "light")}
</head>
<body>
${body}
${SIZE_REPORTER}
</body>
</html>`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function titleFromPath(path: string): string {
  const stem = fileName(path).replace(/\.html?$/i, "")
  return stem
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

interface LoadResult {
  key: string
  srcDoc: string | null
  error: string | null
  /** The document's own `<title>`, when it is a complete document. */
  title: string | null
  /** A complete document rather than a Codex fragment. */
  complete: boolean
  /** Whether `srcDoc` was built for, and must be framed with, scripts on. */
  scripts: boolean
}

interface CodexVisualizeCardProps {
  /** The HTML fragment or document: absolute, `~/…`, or relative to the
   *  transcript's working directory. */
  path: string
  mode: CodexVisualizeMode
  className?: string
  /** When set, the header offers a "Hide" button that calls it — used by the
   *  on-demand previews of files a reply merely mentions. */
  onCollapse?: () => void
}

export const CodexVisualizeCard = memo(function CodexVisualizeCard({
  path,
  mode,
  className,
  onCollapse,
}: CodexVisualizeCardProps) {
  const t = useTranslations("Folder.chat.contentParts")
  const tFiles = useTranslations("Folder.fileWorkspacePanel")
  const tLinks = useTranslations("Folder.chat.linkSafety")
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const transcriptRoot = useTranscriptRoot()
  // Only a relative path depends on the root (and reloads when it changes).
  const baseDir = isRelativePath(path) ? transcriptRoot : null
  // Which file a scripts choice was made for: the same name under another
  // root is another file, and starts in the default (safe) state again.
  const target = `${path}\u0000${baseDir ?? ""}`

  // The user's scripts choice; until they make one for this target, the
  // default for what the file turns out to be (see the load).
  const [scriptsChoice, setScriptsChoice] = useState<{
    target: string
    on: boolean
  } | null>(null)
  const choice = scriptsChoice?.target === target ? scriptsChoice.on : null
  const [expanded, setExpanded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Both results are tagged with the load they belong to, so switching path /
  // theme / reload shows the loading state without a synchronous reset.
  const [loaded, setLoaded] = useState<LoadResult | null>(null)
  const [measured, setMeasured] = useState<{
    key: string
    height: number
  } | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const pathTitle = titleFromPath(path)
  const noFolderMessage = tLinks("errorNoWorkspace")
  // The scripts choice is part of the key: a complete document's CSP follows it.
  const loadKey = `${target}\u0000${dark ? "dark" : "light"}\u0000${choice ?? "default"}\u0000${reloadKey}`

  useEffect(() => {
    let cancelled = false
    ;(async (): Promise<Omit<LoadResult, "key" | "error">> => {
      const absPath = await resolvePreviewPath(path, baseDir)
      if (absPath === null) throw new Error(noFolderMessage)
      const b64 = await readFileBase64(absPath, MAX_FRAGMENT_BYTES)
      const html = decodeBase64Utf8(b64)
      if (isCompleteHtmlDocument(html)) {
        // An arbitrary page, not a Codex fragment: as in codeg's file preview,
        // none of its scripts run — and it gets no network — until the user
        // enables them for it.
        const scripts = choice ?? false
        return {
          srcDoc: await buildCompleteDocument(html, absPath, scripts),
          title: extractHtmlTitle(html) || null,
          complete: true,
          scripts,
        }
      }
      const assets = await getVisualizeAssets()
      return {
        srcDoc: buildVisualizeDocument({
          fragment: html,
          assets,
          title: pathTitle,
          dark,
          themeOverrides: readThemeOverrides(),
        }),
        title: null,
        complete: false,
        // Interactivity is the point of a fragment, and its CSP keeps it off
        // the network (bar the skill's CDNs) with no local files inlined.
        scripts: choice ?? true,
      }
    })()
      .then((result) => {
        if (!cancelled) setLoaded({ key: loadKey, error: null, ...result })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoaded({
            key: loadKey,
            srcDoc: null,
            error: err instanceof Error ? err.message : String(err),
            title: null,
            complete: false,
            scripts: false,
          })
      })
    return () => {
      cancelled = true
    }
  }, [path, baseDir, dark, pathTitle, choice, noFolderMessage, loadKey])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (!data || data.type !== SIZE_MESSAGE_TYPE) return
      if (typeof data.height !== "number" || !Number.isFinite(data.height))
        return
      const height = Math.min(
        MAX_FRAME_HEIGHT,
        Math.max(MIN_FRAME_HEIGHT, Math.ceil(data.height))
      )
      setMeasured((prev) =>
        prev?.key === loadKey && prev.height === height
          ? prev
          : { key: loadKey, height }
      )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [loadKey])

  const current = loaded?.key === loadKey ? loaded : null
  // Before the file is read its kind is unknown, so show the safe state.
  const scripts = current ? current.scripts : (choice ?? false)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const toggleScripts = useCallback(
    () => setScriptsChoice({ target, on: !scripts }),
    [target, scripts]
  )
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), [])

  // What "Open file" opens, resolved the way the load resolves it — before the
  // read finishes and after it fails too — and never handed to the opener as
  // a relative name, which it would resolve against the active folder. (A
  // `~/` path is self-locating for the opener.)
  const openPath = isRelativePath(path)
    ? baseDir
      ? joinRootRel(baseDir, path)
      : null
    : path

  const title = current?.title || pathTitle
  const srcDoc = current?.srcDoc ?? null
  const error = current?.error ?? null
  const loading = current === null
  const contentHeight =
    measured?.key === loadKey
      ? measured.height
      : current?.complete && !current.scripts
        ? STATIC_DOCUMENT_HEIGHT
        : DEFAULT_FRAME_HEIGHT
  const overflows = contentHeight > COLLAPSED_MAX_HEIGHT
  const frameHeight =
    expanded || !overflows ? contentHeight : COLLAPSED_MAX_HEIGHT

  return (
    <section
      data-testid="codex-visualize-card"
      data-mode={mode}
      className={cn(
        // `ws-msg-card`: with a workspace background image on, the card goes
        // translucent like every other message-stream card (see globals.css).
        "not-prose ws-msg-card my-2 flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
        className
      )}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-xs font-medium text-foreground/80"
            title={path}
          >
            {title || t("visualizeTitle")}
          </span>
          {mode === "wide" && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
              {t("visualizeWide")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={toggleScripts}
            aria-pressed={scripts}
            title={
              current?.complete
                ? tFiles("htmlPreviewTrustHint")
                : t("visualizeScriptsHint")
            }
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs transition-colors",
              scripts
                ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
                : "text-muted-foreground hover:bg-primary/8"
            )}
          >
            {scripts ? (
              <ShieldOff className="h-3.5 w-3.5" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {scripts ? t("visualizeScriptsOn") : t("visualizeScriptsOff")}
          </button>
          <button
            type="button"
            onClick={reload}
            title={t("visualizeReload")}
            aria-label={t("visualizeReload")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/8"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          {openPath !== null ? (
            <FilePathLink
              filePath={openPath}
              title={t("visualizeOpenFile")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/8"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="sr-only">{t("visualizeOpenFile")}</span>
            </FilePathLink>
          ) : null}
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              title={t("htmlPreviewHide")}
              aria-label={t("htmlPreviewHide")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/8"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="relative min-h-0 w-full">
        {loading && (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            {t("visualizeLoading")}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 px-3 py-3 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <div className="text-foreground/80">{t("visualizeError")}</div>
              <div className="break-all font-mono text-2xs">{error}</div>
            </div>
          </div>
        )}
        {srcDoc !== null && (
          <iframe
            key={`${reloadKey}-${scripts ? "scripts" : "static"}`}
            ref={frameRef}
            title={t("visualizeFrameTitle")}
            sandbox={scripts ? "allow-scripts" : ""}
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            style={{ height: frameHeight }}
            className="block w-full border-0 bg-transparent transition-[height] duration-150"
          />
        )}
      </div>

      {srcDoc !== null && overflows && (
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex h-8 w-full items-center justify-center gap-1.5 border-t border-border text-xs text-muted-foreground hover:bg-primary/8"
        >
          {expanded ? (
            <ChevronsDownUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5" />
          )}
          {expanded ? t("visualizeCollapse") : t("visualizeExpand")}
        </button>
      )}
    </section>
  )
})
