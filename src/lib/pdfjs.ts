// PDF.js, the renderer behind PDF file tabs: a lazy loader plus the settings
// every document is opened with.
//
// Nothing here imports PDF.js statically. The library and its viewer
// components weigh several hundred KB, so the first PDF tab pays for them and
// the workspace's first paint never does.
//
// The files PDF.js fetches by URL at run time are served from `public/pdfjs/`,
// copied out of `node_modules/pdfjs-dist` by the `postinstall` script the way
// Monaco's are into `public/vs/`. No bundler can follow those fetches:
//   pdf.worker.min.mjs  the worker each document is parsed in;
//   cmaps/              Adobe CMaps. Text in a predefined CJK encoding (what
//                       reportlab's STSong-Light writes, say) renders blank
//                       without them;
//   standard_fonts/     stand-ins with the right metrics for the 14 standard
//                       fonts PDFs name without embedding (Helvetica, Times…);
//   wasm/               the JPEG 2000 and JBIG2 decoders scans need, and the
//                       ICC color engine;
//   iccs/               the CMYK profile that engine converts with.
//
// It is PDF.js's LEGACY build throughout (library, viewer, stylesheet,
// worker). The default build targets only the newest engines: it calls
// `Promise.try`, `Math.sumPrecise`, `RegExp.escape` and the like without
// feature detection, and on an engine that lacks one, a document never
// finishes loading. The desktop app renders in the system webview (whatever
// WebKit the OS has), and the web build in whatever browser connects. The
// legacy build polyfills all of that.

export type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs")
export type PdfjsViewerComponents =
  typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs")

export interface PdfjsModules {
  lib: PdfjsLib
  components: PdfjsViewerComponents
}

/** Where `postinstall` puts the runtime files (see `package.json`). */
export const PDFJS_ASSET_BASE = "/pdfjs/"

let loading: Promise<PdfjsModules> | null = null

/** PDF.js and its viewer components, loaded once and shared. */
export function loadPdfjs(): Promise<PdfjsModules> {
  if (!loading) {
    const attempt = (async () => {
      // Order matters: the viewer components read the library off
      // `globalThis.pdfjsLib`, which only evaluating the library sets.
      const lib = await import("pdfjs-dist/legacy/build/pdf.mjs")
      // The version rides in the query so that no HTTP cache can pair an
      // earlier release's worker with this library, a pair PDF.js refuses
      // to run. Every server the app is served from ignores the query.
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}pdf.worker.min.mjs?v=${lib.version}`
      const components = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs")
      return { lib, components }
    })()
    loading = attempt
    // A chunk that failed to load (a dropped connection) must not fail every
    // later PDF tab as well: the next one tries again.
    attempt.catch(() => {
      if (loading === attempt) loading = null
    })
  }
  return loading
}

/**
 * The `getDocument` parameters for a PDF's bytes.
 *
 * The asset URLs are made absolute. PDF.js hands them to its worker, and a
 * worker started from a `blob:` URL (PDF.js's own fallback when it judges the
 * page and the worker to be on different origins) cannot resolve a
 * root-relative one.
 */
export function pdfDocumentParams(data: Uint8Array) {
  const asset = (dir: string) =>
    new URL(`${PDFJS_ASSET_BASE}${dir}/`, document.baseURI).href
  return {
    data,
    cMapUrl: asset("cmaps"),
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
  }
}

const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,"

/**
 * Whether a PDF tab's content is the document: the `data:` URL the loader
 * writes. Anything else is no document yet (empty while it loads) or a load
 * failure's message, which the loader leaves there instead.
 */
export function isPdfDataUrl(content: string): boolean {
  return content.startsWith(PDF_DATA_URL_PREFIX)
}

/**
 * The bytes of a PDF tab's `data:` URL, or null when the content is not one
 * (see `isPdfDataUrl`). Throws on base64 that does not decode.
 */
export function decodePdfDataUrl(content: string): Uint8Array | null {
  if (!isPdfDataUrl(content)) return null
  const base64 = content.slice(PDF_DATA_URL_PREFIX.length)
  // Native where the engine has it: a document can run to 100 MB, and the
  // `atob` route below holds a second full copy as a string while it works.
  const native = Uint8Array as unknown as {
    fromBase64?: (encoded: string) => Uint8Array
  }
  if (typeof native.fromBase64 === "function") {
    return native.fromBase64(base64)
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
