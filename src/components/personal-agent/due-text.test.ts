import { createTranslator } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

import type { Translate } from "./activity-text"
import { dueWhen, humanDuration, repeatText } from "./due-text"

const en = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "PersonalAgent",
}) as unknown as Translate
const zh = createTranslator({
  locale: "zh-CN",
  messages: zhMessages,
  namespace: "PersonalAgent",
}) as unknown as Translate

// Local times, so the words hold in any zone the tests run in.
const NOW = new Date(2026, 10, 11, 10, 0).getTime() // Wed Nov 11 2026
const at = (d: number, h: number, m = 0) =>
  new Date(2026, 10, d, h, m).toISOString()
const clock = (iso: string, locale = "en") =>
  new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })

describe("when a matter is due", () => {
  it("is a clock time today, and tomorrow or yesterday next door", () => {
    expect(dueWhen(en, at(11, 15), NOW, "en")).toBe(clock(at(11, 15)))
    expect(dueWhen(en, at(12, 15), NOW, "en")).toBe(
      `Tomorrow ${clock(at(12, 15))}`
    )
    expect(dueWhen(en, at(10, 9), NOW, "en")).toBe(
      `Yesterday ${clock(at(10, 9))}`
    )
    expect(dueWhen(zh, at(12, 15), NOW, "zh-CN")).toBe(
      `明天 ${clock(at(12, 15), "zh-CN")}`
    )
  })

  it("names the weekday within a week and the date beyond", () => {
    const fri = dueWhen(en, at(13, 9), NOW, "en")
    expect(fri).toContain("Fri")
    expect(fri).toContain(clock(at(13, 9)))
    const later = dueWhen(en, at(25, 9), NOW, "en")
    expect(later).toContain("Nov")
    expect(later).toContain("25")
    // Another year says which.
    const next = dueWhen(en, new Date(2027, 1, 3, 9).toISOString(), NOW, "en")
    expect(next).toContain("2027")
  })

  it("says nothing for a time that does not parse", () => {
    expect(dueWhen(en, "soon", NOW, "en")).toBe("")
  })
})

describe("how late", () => {
  it("is minutes, hours and minutes, hours, days", () => {
    expect(humanDuration(en, 30)).toBe("1 min")
    expect(humanDuration(en, 5 * 60)).toBe("5 min")
    expect(humanDuration(en, 2 * 3600)).toBe("2 h")
    expect(humanDuration(en, 2 * 3600 + 30 * 60)).toBe("2 h 30 min")
    expect(humanDuration(en, 12 * 3600 + 30 * 60)).toBe("12 h")
    expect(humanDuration(en, 3 * 86400)).toBe("3 days")
    expect(humanDuration(en, 86400)).toBe("1 day")
    expect(humanDuration(zh, 2 * 3600)).toBe("2 小时")
  })
})

describe("how it comes back", () => {
  it("reads each rule", () => {
    expect(repeatText(en, { every: "daily", at: "09:00" }, NOW, "en")).toBe(
      "Every day 09:00"
    )
    expect(
      repeatText(zh, { every: "weekdays", at: "09:00" }, NOW, "zh-CN")
    ).toBe("每个工作日 09:00")
    expect(
      repeatText(
        en,
        { every: "weekly", days: ["wed", "mon"], at: "08:30" },
        NOW,
        "en"
      )
    ).toBe("Every Mon, Wed 08:30")
    expect(
      repeatText(
        zh,
        { every: "weekly", days: ["mon", "wed"], at: "08:30" },
        NOW,
        "zh-CN"
      )
    ).toBe("每周一、周三 08:30")
    expect(
      repeatText(zh, { every: "monthly", day: 15, at: "09:00" }, NOW, "zh-CN")
    ).toBe("每月 15 日 09:00")
  })

  it("says its last day", () => {
    const text = repeatText(
      en,
      { every: "daily", at: "09:00", until: "2026-12-31" },
      NOW,
      "en"
    )
    expect(text).toMatch(/^Every day 09:00, until Dec 31$/)
    expect(
      repeatText(
        en,
        { every: "daily", at: "09:00", until: "2027-01-05" },
        NOW,
        "en"
      )
    ).toContain("2027")
  })

  it("says nothing for a rule it cannot read", () => {
    expect(
      repeatText(en, { every: "weekly", days: [], at: "09:00" }, NOW, "en")
    ).toBe("")
    expect(repeatText(en, { every: "monthly", at: "09:00" }, NOW, "en")).toBe(
      ""
    )
  })
})
