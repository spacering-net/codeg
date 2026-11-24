import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
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
import type { HarnessReason } from "@/lib/harness/mcp-install-types"
import { PLUGIN_MODES } from "@/lib/harness/plugin-install"
import {
  AUTORUN_TYPES,
  PLUGIN_HOST_STEP_STATUSES,
  PLUGIN_INSTALL_REASON_CODES,
  usePluginInstallLabels,
} from "./use-plugin-install-labels"

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

/** Every parameter any code takes, filled in. */
const PARAMS: Record<string, string> = {
  kind: "skill",
  name: "superpowers",
  expected: "7",
  ref: "obra/superpowers",
  agent: "codex",
  agents: "codex,claude_code",
  why: "plugin_adapter_off",
  revision: "8",
  mode: "native",
  reason: "pending_review",
  servers: "context7",
  step: "install",
  variable: "CODEX_HOME",
  path: ".codex",
  version: "0.1.0",
  command: "plugin install",
  status: "1",
  seconds: "60",
  plugin: "other",
  from: "superpowers",
  to: "superpowers-2",
  found: "./superpowers/7",
  names: "brainstorming",
}

const reason = (code: string, params = PARAMS): HarnessReason => ({
  code,
  params,
  detail: null,
})

function flatKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, entry]) =>
    flatKeys(entry, prefix ? `${prefix}.${key}` : key)
  )
}

function Everything() {
  const labels = usePluginInstallLabels()
  return (
    <ul>
      {PLUGIN_INSTALL_REASON_CODES.map((code) => (
        <li key={code}>{labels.reason(reason(code))}</li>
      ))}
      {/* The variants a code's parameters choose between. */}
      <li>
        {labels.reason(
          reason("plugin_revision_not_target", {
            revision: "8",
            mode: "skills",
            expected: "9",
          })
        )}
      </li>
      <li>
        {labels.reason(reason("plugin_revision_not_target", { revision: "8" }))}
      </li>
      <li>
        {labels.reason(reason("plugin_no_full", { reason: "mcp_unpinned" }))}
      </li>
      <li>{labels.reason(reason("plugin_marketplace_elsewhere", {}))}</li>
      <li>
        {labels.reason(reason("plugin_native_unavailable", { agent: "codex" }))}
      </li>
      {/* The skills engine's and the other steps' codes. */}
      <li>{labels.reason(reason("copy_modified", { agents: "codex" }))}</li>
      <li>{labels.reason(reason("name_taken"))}</li>
      <li>{labels.reason(reason("lock_busy"))}</li>
      <li>{labels.reason(reason("item_unavailable"))}</li>
      <li>{labels.reason(reason("not_a_code_yet"))}</li>
      {PLUGIN_MODES.map((mode) => (
        <li key={mode}>{labels.mode(mode)}</li>
      ))}
      <li>{labels.mode("whole")}</li>
      {AUTORUN_TYPES.map((type) => (
        <li key={type}>{labels.autorunType(type)}</li>
      ))}
      <li>{labels.autorunType("daemon")}</li>
      {PLUGIN_HOST_STEP_STATUSES.map((status) => (
        <li key={status}>{labels.stepStatus(status)}</li>
      ))}
      <li>{labels.stepStatus("frozen")}</li>
      <li>{labels.host("claude")}</li>
      <li>{labels.host("somewhere-new")}</li>
    </ul>
  )
}

describe("the plugin install's codes in words", () => {
  it.each(LOCALES)(
    "%s words every code, and never shows a raw key",
    (locale, messages) => {
      const errors: string[] = []
      const { container } = render(
        <NextIntlClientProvider
          locale={locale}
          messages={messages as unknown as typeof en}
          onError={(error) => errors.push(error.message)}
        >
          <Everything />
        </NextIntlClientProvider>
      )
      expect(errors).toEqual([])
      const text = container.textContent ?? ""
      expect(text).not.toMatch(
        /Harness\.(pluginInstall|skillInstall|install|skills)\./
      )
      for (const item of container.querySelectorAll("li")) {
        expect(item.textContent?.trim()).not.toBe("")
      }
    }
  )

  it.each(LOCALES)("%s has every message the dialog uses", (_, messages) => {
    const harness = (messages as unknown as typeof en).Harness
    expect(flatKeys(harness.pluginInstall)).toEqual(
      flatKeys(en.Harness.pluginInstall)
    )
    expect(flatKeys(harness.discover.plugin)).toEqual(
      flatKeys(en.Harness.discover.plugin)
    )
  })
})
