import { describe, expect, it } from "vitest"

import { settingsNavItemsFor } from "./settings-shell"

describe("settingsNavItemsFor", () => {
  it("drops the Web service page in a browser session and nothing else", () => {
    const labels = settingsNavItemsFor("web").map((item) => item.labelKey)
    // There is no second server to configure from inside the one you are
    // already talking to.
    expect(labels).not.toContain("web_service")
    // The Browser page is mostly a desktop browser engine, but site rules,
    // what a server starting in a terminal does and the terminal's link menu
    // all still decide something here — and this page is the only place they
    // can be set, so the entry has to lead there.
    expect(labels).toContain("browser")
    expect(labels).toEqual(
      settingsNavItemsFor("tauri")
        .map((item) => item.labelKey)
        .filter((label) => label !== "web_service")
    )
  })

  it("keeps collaboration under General and the two Use pages together", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    const after = (label: (typeof labels)[number]) =>
      labels[labels.indexOf(label) + 1]
    expect(after("general")).toBe("collaboration")
    expect(after("quick_messages")).toBe("browser")
    expect(after("browser")).toBe("computer_use")
  })

  it("leaves MCP, Skills and Skill packs to the Harness page", () => {
    // They are sections of the workspace's Harness page now; the Settings
    // window has no page for them, nor for the addresses that led there.
    for (const env of ["tauri", "web"] as const) {
      const hrefs = settingsNavItemsFor(env).map((item) => item.href)
      for (const gone of [
        "/settings/mcp",
        "/settings/skills",
        "/settings/skill-packs",
        "/settings/experts",
        "/settings/science",
        "/settings/office-tools",
      ]) {
        expect(hrefs).not.toContain(gone)
      }
    }
  })

  it("keeps every page on the desktop", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    expect(labels).toContain("web_service")
    expect(labels).toContain("browser")
  })
})
