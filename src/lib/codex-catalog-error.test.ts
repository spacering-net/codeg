import { describe, expect, it } from "vitest"

import {
  codexCatalogErrorText,
  describeCodexSaveError,
  parseCodexCatalogError,
  type CodexCatalogTranslator,
} from "@/lib/codex-catalog-error"

/** A translator knowing one message, the way next-intl's scoped one acts. */
function translator(messages: Record<string, string>): CodexCatalogTranslator {
  const t = ((key: string, values?: Record<string, string | number>) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
      String(values?.[name] ?? `{${name}}`)
    )) as CodexCatalogTranslator
  t.has = (key: string) => key in messages
  return t
}

const T = translator({
  "codexCatalog.unauthorized": "Key rejected (HTTP {status}).",
})

describe("codex catalog errors", () => {
  it("reads the marker line a save command's error text ends with", () => {
    const text =
      'the key was rejected (HTTP 401): nope\n[codexCatalog] {"code":"unauthorized","params":{"status":"401"}}'
    const parsed = parseCodexCatalogError(new Error(text))
    expect(parsed.message).toBe("the key was rejected (HTTP 401): nope")
    expect(parsed.catalog).toEqual({
      code: "unauthorized",
      message: "the key was rejected (HTTP 401): nope",
      params: { status: "401" },
    })
    expect(describeCodexSaveError(new Error(text), T)).toBe(
      "Key rejected (HTTP 401)."
    )
  })

  it("reads the structured hint a provider-list command returns", () => {
    const error = {
      code: "authentication_failed",
      message: "the key was rejected",
      i18n_key: "codexCatalog.unauthorized",
      i18n_params: { status: "403" },
    }
    expect(describeCodexSaveError(error, T)).toBe("Key rejected (HTTP 403).")
  })

  it("falls back to the English message for a code it cannot localize", () => {
    expect(
      codexCatalogErrorText({ code: "brand_new", message: "Something new" }, T)
    ).toBe("Something new")
    // Not a catalog error at all, or a broken marker: the text as it is.
    expect(describeCodexSaveError(new Error("disk full"), T)).toBe("disk full")
    expect(
      describeCodexSaveError(new Error("bad\n[codexCatalog] {oops"), T)
    ).toBe("bad")
  })
})
