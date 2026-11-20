"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  archivePlugin,
  assetPlugin,
  audioPlugin,
  drawingPlugin,
  emailPlugin,
  epubPlugin,
  fallbackPlugin,
  imagePlugin,
  ofdPlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin,
  xmindPlugin,
  xpsPlugin,
} from "@open-file-viewer/core"
import { FileViewer } from "@open-file-viewer/react"
import "@open-file-viewer/core/style.css"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

// Served from public/pdfjs/ — same local-asset approach as Monaco's public/vs.
// Letting pdfPlugin fall back to its CDN default would break offline desktop
// (Tauri webview) and leak the local file name to a third party.
const PDF_WORKER_SRC = "/pdfjs/pdf.worker.min.mjs"

// Plugins are NOT auto-registered (core only appends fallbackPlugin), so list
// the lean set explicitly: everything whose dependencies ship with core.
// CAD/3D/GIS need extra peer packages and heavy bundles — deliberately out.
const PLUGINS = [
  pdfPlugin({ workerSrc: PDF_WORKER_SRC }),
  // Includes the legacy .doc/.ppt binary parsers and Word 2003 XML.
  officePlugin(),
  archivePlugin(),
  emailPlugin(),
  epubPlugin(),
  xpsPlugin(),
  ofdPlugin(),
  xmindPlugin(),
  drawingPlugin(),
  imagePlugin(),
  videoPlugin(),
  audioPlugin(),
  // Fonts, PSD, AI/EPS, SQLite, WASM, Parquet…
  assetPlugin(),
  textPlugin(),
  fallbackPlugin(),
]

function dataUrlToFile(dataUrl: string, fileName: string): File | null {
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return null
  const meta = dataUrl.slice(0, comma)
  const mime =
    meta.slice(meta.indexOf(":") + 1, meta.indexOf(";")) ||
    "application/octet-stream"
  const base64 = dataUrl.slice(comma + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], fileName, { type: mime })
}

/**
 * Client-side preview for the binary/document formats the other branches don't
 * cover (PDF, legacy .doc/.ppt, archives, email, …), rendered entirely
 * in-process by open-file-viewer — no officecli watch, no server round trip.
 * The tab's bytes arrive as a data: URL (see workspace-context's "ofv" branch),
 * same shape the image branch uses. A matching tab is preview-only.
 */
export function OpenFileViewerPreview({ tab }: { tab: FileWorkspaceTab }) {
  const t = useTranslations("Folder.fileViewer")
  // Identity-stable: the react adapter re-creates the whole viewer whenever
  // `file` changes identity, so this must not re-mint per render.
  const file = useMemo(
    () => (tab.content ? dataUrlToFile(tab.content, tab.title) : null),
    [tab.content, tab.title]
  )

  if (!tab.content || !file) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {tab.loading ? t("loading") : "Preview is not available for this file"}
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0">
      <FileViewer
        file={file}
        fileName={tab.title}
        plugins={PLUGINS}
        width="100%"
        height="100%"
        theme="auto"
      />
      {/* Brand badge — the user asked for visible attribution. Non-interactive
          so it never blocks the viewer's own toolbar/controls beneath it. */}
      <span
        className="pointer-events-none absolute right-2 bottom-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-2xs text-muted-foreground backdrop-blur-sm"
        title="open-file-viewer"
      >
        open-file-viewer
      </span>
    </div>
  )
}
