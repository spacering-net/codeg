import { render } from "@testing-library/react"
import { NextIntlClientProvider, useTranslations } from "next-intl"
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
import type { HarnessSkillNameTaken } from "@/lib/harness/skill-install-types"
import { useSkillsLabels } from "../skills/use-skills-labels"
import {
  NAME_TAKEN_BY,
  SKILL_INSTALL_PHASES,
  SKILL_INSTALL_REASON_CODES,
  SKILL_PHASE_STATUSES,
  useSkillInstallLabels,
} from "./use-skill-install-labels"

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
  kind: "mcp",
  path: "scripts/fill.py",
  count: "3",
  limit: "500",
  size: "20971520",
  expected: "4096",
  actual: "5000",
  field: "commit",
  name: "pdf",
  pack: "experts",
  by: "custom",
  item_ref: "acme/pdf",
  agent: "codex",
  tools: "Read, Bash(git:*)",
  repository: "anthropics/skills",
  commit: "0123456789abcdef0123456789abcdef01234567",
  code: "remove_failed",
}

const reason = (code: string, params = PARAMS): HarnessReason => ({
  code,
  params,
  detail: null,
})

const taken = (by: string, agents: string[] = []): HarnessSkillNameTaken => ({
  name: "pdf",
  by,
  pack: "science",
  item_id: "item-x",
  item_ref: "acme/pdf",
  path: "/home/u/.codex/skills/pdf",
  agents,
})

/** Every message of the two namespaces, by key: each must have words. */
function flatKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, entry]) =>
    flatKeys(entry, prefix ? `${prefix}.${key}` : key)
  )
}

function Everything() {
  const labels = useSkillInstallLabels()
  const skills = useSkillsLabels()
  const tRecord = useTranslations("Harness.record")
  return (
    <ul>
      {SKILL_INSTALL_REASON_CODES.map((code) => (
        <li key={code}>{labels.reason(reason(code))}</li>
      ))}
      {/* The variants a code's parameters choose between. */}
      <li>{labels.reason(reason("hash_invalid", { path: "" }))}</li>
      <li>{labels.reason(reason("name_taken", { name: "pdf" }))}</li>
      <li>{labels.reason(reason("source_invalid", { field: "other" }))}</li>
      {/* Codes the MCP step words too. */}
      <li>{labels.reason(reason("version_blocked"))}</li>
      <li>{labels.reason(reason("yanked_not_accepted"))}</li>
      <li>{labels.reason(reason("not_a_code_yet"))}</li>
      {NAME_TAKEN_BY.map((by) => (
        <li key={by}>{labels.taken(taken(by, ["codex"]))}</li>
      ))}
      <li>{labels.taken(taken("codeg_link"))}</li>
      <li>{labels.taken(taken("agent_dir"))}</li>
      <li>{labels.taken(taken("something_new"))}</li>
      {SKILL_INSTALL_PHASES.map((phase) => (
        <li key={phase}>{labels.phase(phase)}</li>
      ))}
      <li>{labels.phase("teleport")}</li>
      {SKILL_PHASE_STATUSES.map((status) => (
        <li key={status}>{labels.phaseStatus(status)}</li>
      ))}
      <li>{labels.phaseStatus("frozen")}</li>
      <li>{tRecord("mcp")}</li>
      <li>{tRecord("skills")}</li>
      <li>
        {skills.issue({ code: "ownership_unresolved", detail: "harness" })}
      </li>
    </ul>
  )
}

describe("the skill install's codes in words", () => {
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
      expect(text).not.toMatch(/Harness\.(skillInstall|install|record)\./)
      for (const item of container.querySelectorAll("li")) {
        expect(item.textContent?.trim()).not.toBe("")
      }
    }
  )

  it.each(LOCALES)("%s has every message the dialogs use", (_, messages) => {
    const harness = (messages as unknown as typeof en).Harness
    expect(flatKeys(harness.skillInstall)).toEqual(
      flatKeys(en.Harness.skillInstall)
    )
    expect(flatKeys(harness.record)).toEqual(flatKeys(en.Harness.record))
  })
})
