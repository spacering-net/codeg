import { createTranslator } from "next-intl"
import { describe, expect, it } from "vitest"

import ar from "@/i18n/messages/ar.json"
import de from "@/i18n/messages/de.json"
import en from "@/i18n/messages/en.json"
import es from "@/i18n/messages/es.json"
import fr from "@/i18n/messages/fr.json"
import ja from "@/i18n/messages/ja.json"
import ko from "@/i18n/messages/ko.json"
import pt from "@/i18n/messages/pt.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import zhTW from "@/i18n/messages/zh-TW.json"

const LOCALES = [
  ["en", en],
  ["ar", ar],
  ["de", de],
  ["es", es],
  ["fr", fr],
  ["ja", ja],
  ["ko", ko],
  ["pt", pt],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
] as const

type Node = string | { [key: string]: Node }

function leaves(node: Node, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]]
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, path ? `${path}.${key}` : key)
  )
}

/** The arguments English counts with — a plural's, or a known count. */
function countArguments(message: string): string[] {
  const plural = [...message.matchAll(/\{(\w+), plural/g)].map((m) => m[1])
  const named = ["count", "total", "synced", "seconds"].filter((name) =>
    new RegExp(`\\{${name}[},]`).test(message)
  )
  return [...new Set([...plural, ...named])]
}

const english = new Map(leaves((en as { Harness: Node }).Harness))

describe("counts in Harness messages", () => {
  it.each(LOCALES)(
    "%s groups every count as a number, never as bare text",
    (_locale, messages) => {
      const bare: string[] = []
      for (const [path, message] of leaves(
        (messages as { Harness: Node }).Harness
      )) {
        const source = english.get(path)
        if (!source) continue
        for (const name of countArguments(source)) {
          if (message.includes(`{${name}}`)) bare.push(`${path}: {${name}}`)
        }
      }
      expect(bare).toEqual([])
    }
  )

  it.each([
    ["en", en, "28,587"],
    ["zh-CN", zhCN, "28,587"],
    ["zh-TW", zhTW, "28,587"],
    ["ja", ja, "28,587"],
    ["de", de, "28.587"],
  ] as const)("%s shows a large total grouped", (locale, messages, grouped) => {
    const t = createTranslator({
      locale,
      messages: messages as Record<string, Node>,
      namespace: "Harness.discover.list",
    })
    expect(t("total" as never, { count: 28587 } as never)).toContain(grouped)
  })
})
