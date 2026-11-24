"use client"

import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"

function PdfPreviewLoading() {
  const t = useTranslations("Folder.fileWorkspacePanel")
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {t("loading")}
    </div>
  )
}

/**
 * The renderer for a PDF file tab (`language === "pdf"`), shared by the file
 * column, the transcript's file viewer drawer and the canvas file card.
 *
 * Loaded on first use: the viewer brings PDF.js's stylesheet with it, and
 * PDF.js itself follows through `loadPdfjs`. None of it belongs in the
 * workspace's first paint.
 */
export const PdfPreview = dynamic(
  async () => {
    const mod = await import("@/components/files/pdf-viewer")
    return { default: mod.PdfViewer }
  },
  { ssr: false, loading: () => <PdfPreviewLoading /> }
)
