import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SystemLanguageSettings } from "@/lib/types"

const api = vi.hoisted(() => ({
  getSystemLanguageSettings: vi.fn<() => Promise<SystemLanguageSettings>>(),
}))
vi.mock("@/lib/api", () => api)

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppI18nProvider } from "./i18n-provider"

function renderTabs() {
  render(
    <AppI18nProvider>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Body</TabsContent>
      </Tabs>
    </AppI18nProvider>
  )
}

const tabsRoot = () => screen.getByText("Body").closest('[data-slot="tabs"]')

describe("AppI18nProvider direction", () => {
  afterEach(() => {
    document.documentElement.dir = ""
    window.localStorage.clear()
  })

  // Radix components read their direction from context, not from the page:
  // without a provider a Tabs root stamps `dir="ltr"` on itself, and
  // everything inside it — switches, rows, menus — stays left-to-right in an
  // Arabic window whose page is right-to-left.
  it("hands Radix components the page's right-to-left direction", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "ar",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "rtl"))
    expect(document.documentElement.dir).toBe("rtl")
  })

  it("keeps them left-to-right otherwise", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "en",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "ltr"))
    expect(document.documentElement.dir).toBe("ltr")
  })
})
