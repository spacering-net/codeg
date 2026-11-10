import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import type { CodexCatalogError } from "@/lib/types"

/** Mirrors `ERROR_MARKER` in src-tauri/src/acp/codex_endpoint_catalog.rs:
 *  the save commands' errors travel as text, so a catalog error rides on
 *  their last line as `[codexCatalog] {"code":…,"params":{…}}`. */
const MARKER = "[codexCatalog] "

function stringParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") out[key] = value
    }
  }
  return out
}

/** The catalog error an error carries — from a provider-list command (a
 *  structured `codexCatalog.<code>` hint) or a save command (the marker
 *  line) — or `null`. `message` is the English text without the marker. */
export function parseCodexCatalogError(error: unknown): {
  message: string
  catalog: CodexCatalogError | null
} {
  const appError = extractAppCommandError(error)
  const hint = appError?.i18n_key?.startsWith("codexCatalog.")
    ? appError.i18n_key.slice("codexCatalog.".length)
    : null
  const text = toErrorMessage(error)
  if (hint) {
    return {
      message: appError?.message ?? text,
      catalog: {
        code: hint,
        message: appError?.message ?? text,
        params: appError?.i18n_params ?? {},
      },
    }
  }
  const at = text.lastIndexOf(MARKER)
  if (at < 0) return { message: text, catalog: null }
  const message = text.slice(0, at).trim()
  try {
    const tag = JSON.parse(text.slice(at + MARKER.length)) as {
      code?: unknown
      params?: unknown
    }
    if (typeof tag.code !== "string") return { message, catalog: null }
    return {
      message,
      catalog: { code: tag.code, message, params: stringParams(tag.params) },
    }
  } catch {
    return { message, catalog: null }
  }
}

/** A translator scoped to `CodexModelEditor.catalogSource`. */
export interface CodexCatalogTranslator {
  (key: string, values?: Record<string, string | number>): string
  has: (key: string) => boolean
}

/** The localized text of a catalog error, falling back to its English
 *  message for a code without a translation. */
export function codexCatalogErrorText(
  error: CodexCatalogError,
  t: CodexCatalogTranslator
): string {
  const key = `codexCatalog.${error.code}`
  if (!t.has(key)) return error.message
  return t(key, { ...(error.params ?? {}), message: error.message })
}

/** Any error, localized when it is a catalog error. */
export function describeCodexSaveError(
  error: unknown,
  t: CodexCatalogTranslator
): string {
  const { message, catalog } = parseCodexCatalogError(error)
  return catalog ? codexCatalogErrorText(catalog, t) : message
}
