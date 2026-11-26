import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { ATTACH_REFERENCE_TO_SESSION_EVENT } from "@/lib/session-attachment-events"
import { ProjectKnowledgeTab } from "./aux-panel-project-knowledge-tab"

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

const { entries } = vi.hoisted(() => ({
  entries: new Map<
    string,
    { id: string; title: string; body: string; updatedAt: string }[]
  >(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: async (
      _command: string,
      {
        folderId,
        request,
      }: {
        folderId: number
        request: {
          kind: string
          action: string
          id?: string
          body?: string
          query?: string
        }
      }
    ) => {
      const key = folderId + request.kind
      const items = entries.get(key) ?? []
      if (request.action === "list")
        return {
          entries: items.filter((item) =>
            item.body.includes(request.query ?? "")
          ),
          nextOffset: null,
        }
      if (request.action === "read")
        return items.find((item) => item.id === request.id)
      if (request.action === "delete") {
        entries.set(
          key,
          items.filter((item) => item.id !== request.id)
        )
        return { deleted: true }
      }
      const body = request.body ?? ""
      const entry = {
        id: request.id ?? "335dcbfe-278d-4ffd-affa-5ddc68fd6148",
        body,
        title: (body.split("\n")[0] ?? "").replace(/^# /, ""),
        updatedAt: new Date().toISOString(),
      }
      entries.set(key, [entry, ...items.filter((item) => item.id !== entry.id)])
      return entry
    },
  }),
}))

function panel(projectKey = "1", sessionTabId?: string) {
  return (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ProjectKnowledgeTab
        projectKey={projectKey}
        sessionTabId={sessionTabId}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => entries.clear())

it("adds a saved note to the selected session draft", async () => {
  const user = userEvent.setup()
  const append = vi.fn()
  window.addEventListener(ATTACH_REFERENCE_TO_SESSION_EVENT, append, {
    once: true,
  })
  render(panel("1", "session-a"))
  await user.click(screen.getByRole("button", { name: "New note" }))
  await user.type(
    screen.getByRole("textbox", { name: "Write a note" }),
    "Check recovery"
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  await user.click(screen.getByRole("button", { name: "Add to Chat" }))
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: {
        tabId: "session-a",
        label: "Check recovery",
        uri: "codeg://knowledge/note/335dcbfe-278d-4ffd-affa-5ddc68fd6148",
      },
    })
  )
})

it("creates, searches, edits and deletes one note at a time", async () => {
  const user = userEvent.setup()
  render(panel())
  await user.click(screen.getByRole("button", { name: "New note" }))
  await user.type(
    screen.getByRole("textbox", { name: "Write a note" }),
    "Check offline recovery"
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await user.type(
    screen.getByRole("textbox", { name: "Write a note" }),
    " before release"
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  await user.click(screen.getByRole("button", { name: "Back" }))
  await user.type(screen.getByRole("searchbox"), "before release")
  await user.click(
    await screen.findByRole("button", {
      name: /check offline recovery before release/i,
    })
  )
  await user.click(screen.getByRole("button", { name: "Delete" }))
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    })
  )
  expect(
    screen.queryByRole("button", { name: /check offline recovery/i })
  ).not.toBeInTheDocument()
})

it("previews a Markdown plan, retains it on remount, and isolates projects", async () => {
  const user = userEvent.setup()
  const { rerender } = render(panel())
  await user.click(screen.getByRole("tab", { name: "Plans" }))
  await user.click(screen.getByRole("button", { name: "New plan" }))
  await user.type(
    screen.getByRole("textbox", { name: "Write your plan in Markdown" }),
    "# Release plan{enter}{enter}Check offline recovery"
  )
  await user.click(screen.getByRole("tab", { name: "Preview" }))
  expect(screen.getByRole("tabpanel", { name: "Preview" })).toHaveTextContent(
    "Check offline recovery"
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(
    await screen.findByRole("heading", { name: "Release plan" })
  ).toBeInTheDocument()

  rerender(panel("2"))
  await user.click(screen.getByRole("tab", { name: "Plans" }))
  expect(screen.getByText("No plans yet")).toBeInTheDocument()
  rerender(panel())
  await user.click(screen.getByRole("tab", { name: "Plans" }))
  expect(
    await screen.findByRole("button", { name: /release plan/i })
  ).toBeInTheDocument()
})
