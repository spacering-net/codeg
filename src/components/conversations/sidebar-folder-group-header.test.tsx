import { type ComponentProps, type ReactElement } from "react"
import { fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SidebarFolderGroupHeader } from "./sidebar-folder-group-header"
import enMessages from "@/i18n/messages/en.json"

// The trailing actions are icon-only, so their aria-labels address them. CSS
// hides them until the row is hovered, but fireEvent dispatches straight to the
// node, so the wiring is testable without a real pointer.
const onToggle = vi.fn()
const onOpenFolder = vi.fn()
const onCloneRepository = vi.fn()

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function header(
  props: Partial<ComponentProps<typeof SidebarFolderGroupHeader>> = {}
) {
  return (
    <SidebarFolderGroupHeader
      groupId={7}
      name="Work"
      runningCount={0}
      awaitingCount={0}
      expanded
      onToggle={onToggle}
      themeColor="inherit"
      appThemeColor="blue"
      {...props}
    />
  )
}

beforeEach(() => {
  onToggle.mockClear()
  onOpenFolder.mockClear()
  onCloneRepository.mockClear()
})

describe("SidebarFolderGroupHeader add-a-folder actions", () => {
  it("offers Clone Repository and Open Folder after the ⋯ menu", () => {
    const { container } = renderWithIntl(
      header({ onOpenFolder, onCloneRepository })
    )

    // The Folders heading's own order, so the same glyphs stack in one column
    // under it, with ⋯ leading the cluster as it does on a folder row.
    const trailing = Array.from(
      container.querySelectorAll("button[aria-label]")
    ).map((el) => el.getAttribute("aria-label"))
    expect(trailing).toEqual([
      "More options",
      "Clone Repository",
      "Open Folder",
    ])
  })

  it("passes the group id and never toggles the group", () => {
    const { getByLabelText } = renderWithIntl(
      header({ onOpenFolder, onCloneRepository })
    )

    fireEvent.click(getByLabelText("Open Folder"))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(onOpenFolder).toHaveBeenCalledWith(7)

    fireEvent.click(getByLabelText("Clone Repository"))
    expect(onCloneRepository).toHaveBeenCalledTimes(1)
    expect(onCloneRepository).toHaveBeenCalledWith(7)

    // Siblings of the toggle, never nested in it.
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("renders only the actions whose callbacks are provided", () => {
    const { getByLabelText, queryByLabelText } = renderWithIntl(
      header({ onOpenFolder })
    )

    expect(getByLabelText("Open Folder")).not.toBeNull()
    expect(queryByLabelText("Clone Repository")).toBeNull()
    expect(getByLabelText("More options")).not.toBeNull()
  })

  it("keeps the presentation copy free of every trailing action", () => {
    // The drag surface's rows are drop-target visuals: nothing there may open
    // a dialog or a menu mid-gesture.
    const { queryByLabelText } = renderWithIntl(
      header({ presentation: true, onOpenFolder, onCloneRepository })
    )

    expect(queryByLabelText("Open Folder")).toBeNull()
    expect(queryByLabelText("Clone Repository")).toBeNull()
    expect(queryByLabelText("More options")).toBeNull()
  })
})

describe("SidebarFolderGroupHeader live-activity badge", () => {
  it("counts the running sessions when nothing is waiting on the user", () => {
    const { container } = renderWithIntl(header({ runningCount: 2 }))

    expect(
      container.querySelector('[title="2 sessions running"]')
    ).not.toBeNull()
    expect(container.textContent).toContain("2")
  })

  it("lets the waiting count stand in for the running one", () => {
    // 收起的组里这个徽标是唯一能看出"里面有东西在等你"的地方；两个数字并排
    // 会被读成两件无关的事，所以等待计数顶替运行计数。
    const { container } = renderWithIntl(
      header({ runningCount: 3, awaitingCount: 1 })
    )

    const waiting = container.querySelector(
      '[title="1 session waiting on you"]'
    )
    expect(waiting).not.toBeNull()
    expect(waiting?.textContent).toContain("1")
    expect(container.querySelector('[title="3 sessions running"]')).toBeNull()
  })
})
