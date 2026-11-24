import { downloadImage } from "@/lib/image-download"
import { saveTextFile, type SaveFileResult } from "@/lib/save-file"

/** The two image formats, plus the fence source as a Mermaid or PlantUML file. */
export type DiagramFormat = "svg" | "png" | "mmd" | "puml"

const SOURCE_FILTER_NAMES: Partial<Record<DiagramFormat, string>> = {
  mmd: "Mermaid",
  puml: "PlantUML",
}

/** Multiplier applied to the diagram's own size when rasterizing to PNG. */
const PNG_SCALE = 3

export class DiagramRasterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiagramRasterError"
  }
}

/** A `width`/`height` attribute in absolute pixels, or `NaN` for any other unit. */
function pixelAttr(raw: string | null): number {
  const match = /^\s*(-?[\d.]+)(px)?\s*$/i.exec(raw ?? "")
  return match ? Number.parseFloat(match[1]) : Number.NaN
}

/**
 * Give a rendered Mermaid SVG an explicit pixel size so it can be rasterized.
 *
 * Mermaid's `useMaxWidth` default emits `width="100%"` on the root `<svg>`,
 * which has no meaning to an `<img>` decoding a standalone SVG document: the
 * image comes back with `naturalWidth` 0 in WebKit and the 300×150 default
 * replaced-element size in Chromium, so the export silently crops. Rewriting
 * width/height from the viewBox — the only place the real size lives — is what
 * makes the PNG match what the user is looking at.
 *
 * Returns the serialized SVG plus the pixel size to draw it at.
 */
export function sizeSvgForRaster(
  svg: string,
  scale: number
): { svg: string; width: number; height: number } | null {
  if (typeof DOMParser === "undefined") return null
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== "svg") return null

  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
  let width = Number(viewBox?.[2])
  let height = Number(viewBox?.[3])
  if (!(width > 0) || !(height > 0)) {
    // Not `parseFloat`: it reads Mermaid's own `width="100%"` as 100 and would
    // silently export a 100px-wide crop.
    width = pixelAttr(root.getAttribute("width"))
    height = pixelAttr(root.getAttribute("height"))
  }
  if (!(width > 0) || !(height > 0)) return null

  const scaledWidth = Math.round(width * scale)
  const scaledHeight = Math.round(height * scale)
  root.setAttribute("width", String(scaledWidth))
  root.setAttribute("height", String(scaledHeight))
  // Mermaid's inline `max-width` would cap the raster back down to 1x.
  const style = root.getAttribute("style")
  if (style)
    root.setAttribute("style", style.replace(/max-width\s*:[^;]*;?/gi, ""))

  return {
    svg: new XMLSerializer().serializeToString(root),
    width: scaledWidth,
    height: scaledHeight,
  }
}

/**
 * Rasterize a rendered Mermaid SVG to base64 PNG bytes (no data-URL prefix,
 * matching what {@link downloadImage} expects).
 *
 * The object URL is released on every exit path — a failed export must not pin
 * the decoded image for the lifetime of the document. Same discipline as
 * `rasterToPngBlob` in `@/lib/copy-image`.
 */
export function svgToPngBase64(
  svg: string,
  scale: number = PNG_SCALE
): Promise<string> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return Promise.reject(new DiagramRasterError("No DOM to rasterize with"))
  }
  const sized = sizeSvgForRaster(svg, scale)
  if (!sized) {
    return Promise.reject(new DiagramRasterError("Diagram has no usable size"))
  }

  return new Promise((resolve, reject) => {
    const blob = new Blob([sized.svg], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const fail = (err: unknown) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = sized.width
        canvas.height = sized.height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          fail(new DiagramRasterError("Failed to get a 2D canvas context"))
          return
        }
        ctx.drawImage(img, 0, 0, sized.width, sized.height)
        const dataUrl = canvas.toDataURL("image/png")
        URL.revokeObjectURL(url)
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1))
      } catch (err) {
        fail(err)
      }
    }
    img.onerror = () => fail(new DiagramRasterError("Failed to decode the SVG"))
    img.src = url
  })
}

/**
 * Save a diagram in one of the formats offered by its toolbar: SVG, PNG, or
 * its source in the fence's own language.
 *
 * Goes through the shared save helpers rather than a bare `<a download>` (what
 * Streamdown's own toolbar does): on desktop that means a real system Save As
 * dialog and a Rust-side write, which is the only path that actually works in
 * the Tauri webview.
 */
export async function saveDiagram(opts: {
  format: DiagramFormat
  /** Rendered SVG markup. Not needed for `"mmd"` / `"puml"`. */
  svg: string | null
  /** Original ```mermaid / ```plantuml fence body. */
  source: string
  /** File name without extension. */
  baseName?: string
}): Promise<SaveFileResult> {
  const { format, svg, source, baseName = "diagram" } = opts

  const sourceFilterName = SOURCE_FILTER_NAMES[format]
  if (sourceFilterName) {
    return saveTextFile({
      content: source,
      suggestedName: `${baseName}.${format}`,
      mimeType: "text/plain",
      filterName: sourceFilterName,
      ext: format,
    })
  }

  if (!svg) throw new DiagramRasterError("Diagram is not rendered yet")

  if (format === "svg") {
    return saveTextFile({
      content: svg,
      suggestedName: `${baseName}.svg`,
      mimeType: "image/svg+xml",
      filterName: "SVG",
      ext: "svg",
    })
  }

  const data = await svgToPngBase64(svg)
  const saved = await downloadImage({
    data,
    mime_type: "image/png",
    suggestedName: `${baseName}.png`,
  })
  return saved ? "saved" : "cancelled"
}
