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
import {
  INSTALL_CHANGE_CODES,
  INSTALL_REASON_CODES,
  RECORD_CODES,
  UNINSTALL_ACTIONS,
  useInstallLabels,
} from "./use-install-labels"

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
  status: "retired",
  revision: "7",
  field: "risk",
  registry_type: "npm",
  runtime: "docker",
  identifier: "@acme/notes-mcp",
  argument: "--package",
  name: "NOTES_TOKEN",
  version: "1.2.0",
  verified: "pending",
  host: "10.0.0.5",
  key: "notes",
  agent: "codex",
  option: "official:package:9:stdio",
  item_id: "item-notes",
  from: "low",
  to: "medium",
  profile: "declared",
  value: "api.acme.example",
  severity: "high",
}

const reason = (code: string, params = PARAMS): HarnessReason => ({
  code,
  params,
  detail: null,
})

function Everything() {
  const labels = useInstallLabels()
  return (
    <ul>
      {INSTALL_REASON_CODES.map((code) => (
        <li key={code}>{labels.reason(reason(code))}</li>
      ))}
      {/* The variants a code's parameters choose between. */}
      <li>
        {labels.reason(reason("item_unavailable", { status: "removed" }))}
      </li>
      <li>
        {labels.reason(reason("item_unavailable", { status: "unknown" }))}
      </li>
      <li>{labels.reason(reason("remote_not_public", { host: "" }))}</li>
      <li>
        {labels.reason(
          reason("package_version_inexact", { identifier: "x", version: "" })
        )}
      </li>
      <li>{labels.reason(reason("not_a_code_yet"))}</li>
      {INSTALL_CHANGE_CODES.map((code) => (
        <li key={code}>{labels.change(reason(code))}</li>
      ))}
      <li>{labels.change(reason("reviewed_changed", { to: "true" }))}</li>
      <li>
        {labels.change(
          reason("permission_removed", {
            profile: "detected",
            field: "tools",
            value: "*",
          })
        )}
      </li>
      <li>{labels.change(reason("not_a_change_yet"))}</li>
      {RECORD_CODES.map((code) => (
        <li key={code}>{labels.record(code)}</li>
      ))}
      <li>{labels.record(null)}</li>
      {UNINSTALL_ACTIONS.map((action) => (
        <li key={action}>{labels.uninstallAction(action)}</li>
      ))}
      <li>{labels.uninstallAction("something_new")}</li>
      {["ok", "yanked", "blocked", "frozen"].map((status) => (
        <li key={status}>{labels.status(status)}</li>
      ))}
    </ul>
  )
}

describe("the install's codes in words", () => {
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
      expect(text).not.toMatch(/Harness\.install\./)
      // Every line has words of its own.
      for (const item of container.querySelectorAll("li")) {
        expect(item.textContent?.trim()).not.toBe("")
      }
    }
  )
})
