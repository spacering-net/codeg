/**
 * The aux panel's Issues / Pull requests tab follows the active project ONLY
 * while it is on screen — every follow is a forge request, and the active
 * folder changes on each conversation-tab switch — and reloads the page it
 * holds when it comes back into view.
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ForgePageEmbed } from "@/components/forge/forge-page"

const scene = vi.hoisted(() => ({
  active: true,
  projectFolderId: 1 as number | null,
  setRoute: vi.fn(),
  /** Every `embed` the page was rendered with, and how many times it mounted. */
  embeds: [] as ForgePageEmbed[],
  mounts: 0,
}))

vi.mock("@/hooks/use-aux-tab-active", () => ({
  useAuxTabActive: () => scene.active,
}))
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.projectFolderId,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: scene.setRoute }),
}))
vi.mock("@/components/forge/forge-page", async () => {
  const { useEffect } = await import("react")
  return {
    ForgePage: ({ embed }: { embed: ForgePageEmbed }) => {
      scene.embeds.push(embed)
      useEffect(() => {
        scene.mounts += 1
      }, [])
      return (
        <button type="button" onClick={embed.onOpenFullPage}>
          {`page:${embed.folderId}:${embed.tab}:${embed.active ? "on" : "off"}`}
        </button>
      )
    },
  }
})

import { ForgeAuxTab } from "./aux-panel-forge-tab"

function Tab() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeAuxTab auxTab="pull_requests" forgeTab="prs" />
    </NextIntlClientProvider>
  )
}

const last = () => scene.embeds[scene.embeds.length - 1]

beforeEach(() => {
  localStorage.clear()
  Object.assign(scene, {
    active: true,
    projectFolderId: 1,
    embeds: [],
    mounts: 0,
  })
  scene.setRoute.mockClear()
})

describe("ForgeAuxTab", () => {
  it("lists the active project's change requests", () => {
    render(<Tab />)
    expect(last()).toMatchObject({ folderId: 1, tab: "prs", active: true })
  })

  it("follows the conversation to another project while on screen", () => {
    const { rerender } = render(<Tab />)
    scene.projectFolderId = 2
    rerender(<Tab />)
    expect(last()).toMatchObject({ folderId: 2, active: true })
    // Another repository is another list: a fresh one, not this one's state.
    expect(scene.mounts).toBe(2)
  })

  it("stays put while hidden, then catches up on the way back", () => {
    const { rerender } = render(<Tab />)
    scene.active = false
    rerender(<Tab />)
    scene.projectFolderId = 2
    rerender(<Tab />)
    scene.projectFolderId = 3
    rerender(<Tab />)
    // Nothing followed behind the hidden tab, and the page knows it is hidden.
    expect(last()).toMatchObject({ folderId: 1, active: false })
    expect(scene.mounts).toBe(1)

    scene.active = true
    rerender(<Tab />)
    expect(last()).toMatchObject({ folderId: 3, active: true })
    expect(scene.mounts).toBe(2)
  })

  it("shows the same list again when the project did not move", () => {
    const { rerender } = render(<Tab />)
    scene.active = false
    rerender(<Tab />)
    scene.active = true
    rerender(<Tab />)
    // The page reloads on its own `active` flag; no remount is needed for it.
    expect(last()).toMatchObject({ folderId: 1, active: true })
    expect(scene.mounts).toBe(1)
  })

  it("opens the full repository panel on this project and tab", () => {
    render(<Tab />)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "page:1:prs:on" }))
    })
    expect(localStorage.getItem("forge:folderId")).toBe("1")
    expect(localStorage.getItem("workspace:forge-tab")).toBe("prs")
    expect(scene.setRoute).toHaveBeenCalledWith("forge")
  })

  it("explains itself when there is no project", () => {
    scene.projectFolderId = null
    render(<Tab />)
    expect(scene.embeds).toHaveLength(0)
    expect(
      screen.getByText(enMessages.Folder.auxPanel.noFolderTitle)
    ).toBeInTheDocument()
  })
})
