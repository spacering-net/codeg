import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getFeedbackSettings: vi.fn(),
  setFeedbackSettings: vi.fn(),
  getQuestionSettings: vi.fn(),
  setQuestionSettings: vi.fn(),
  getSessionInfoSettings: vi.fn(),
  setSessionInfoSettings: vi.fn(),
  getBrowserToolsSettings: vi.fn(),
  setBrowserToolsSettings: vi.fn(),
  getChatAuthoringSettings: vi.fn(),
  setChatAuthoringSettings: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Capture the change-event handlers so a test can play a remote write back.
// Keyed by event: the panel listens for two broadcasts (create-from-chat and
// browser tools), and a single slot would quietly hand one test's payload to
// the other one's handler.
const handlers = new Map<string, (p: unknown) => void>()
const unsubscribeSpy = vi.fn()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(unsubscribeSpy)
  }),
}))
const authoringHandler = () => handlers.get("chat-authoring-settings://changed")
const browserToolsHandler = () =>
  handlers.get("browser-tools-settings://changed")

// Avoid mutating the shared module cache across tests.
vi.mock("@/hooks/use-feedback-enabled", () => ({
  primeFeedbackEnabled: vi.fn(),
}))

import { AgentToolsSettingsSection } from "./agent-tools-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getBrowserToolsSettings,
  getChatAuthoringSettings,
  getFeedbackSettings,
  getQuestionSettings,
  getSessionInfoSettings,
  setBrowserToolsSettings,
  setChatAuthoringSettings,
  setFeedbackSettings,
  setQuestionSettings,
  setSessionInfoSettings,
} from "@/lib/api"
import { primeFeedbackEnabled } from "@/hooks/use-feedback-enabled"

const mockGetFeedback = vi.mocked(getFeedbackSettings)
const mockSetFeedback = vi.mocked(setFeedbackSettings)
const mockGetQuestion = vi.mocked(getQuestionSettings)
const mockSetQuestion = vi.mocked(setQuestionSettings)
const mockGetSessionInfo = vi.mocked(getSessionInfoSettings)
const mockSetSessionInfo = vi.mocked(setSessionInfoSettings)
const mockGetBrowser = vi.mocked(getBrowserToolsSettings)
const mockSetBrowser = vi.mocked(setBrowserToolsSettings)
const mockGetChat = vi.mocked(getChatAuthoringSettings)
const mockSetChat = vi.mocked(setChatAuthoringSettings)
const mockPrime = vi.mocked(primeFeedbackEnabled)

const LABELS = {
  feedback: "Live Feedback",
  question: "Ask user question",
  sessionInfo: "Get session info",
  browserTools: "Read and drive the built-in browser",
  browserEval: "Run code in the built-in browser",
  automations: "Create automations",
  workTasks: "Create to-do tasks",
} as const

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentToolsSettingsSection />
    </NextIntlClientProvider>
  )
}

/** Every endpoint resolves; each `set*` echoes what it was handed. */
function primeBackend(
  overrides: {
    feedback?: boolean
    question?: boolean
    sessionInfo?: boolean
    browserTools?: boolean
    browserEval?: boolean
    automations?: boolean
    workTasks?: boolean
  } = {}
) {
  const {
    feedback = false,
    question = true,
    sessionInfo = true,
    browserTools = false,
    browserEval = false,
    automations = false,
    workTasks = false,
  } = overrides
  mockGetFeedback.mockResolvedValue({ enabled: feedback })
  mockGetQuestion.mockResolvedValue({ enabled: question })
  mockGetSessionInfo.mockResolvedValue({ enabled: sessionInfo })
  mockGetBrowser.mockResolvedValue({
    enabled: browserTools,
    eval: browserEval,
  })
  mockGetChat.mockResolvedValue({
    automations_enabled: automations,
    work_tasks_enabled: workTasks,
  })
  mockSetFeedback.mockImplementation(async (next) => next)
  mockSetQuestion.mockImplementation(async (next) => next)
  mockSetSessionInfo.mockImplementation(async (next) => next)
  mockSetBrowser.mockImplementation(async (next) => next)
  mockSetChat.mockImplementation(async (next) => next)
}

beforeEach(() => {
  vi.clearAllMocks()
  // The handlers belong to the unmounted render, not to the next one.
  handlers.clear()
})

describe("AgentToolsSettingsSection", () => {
  it("shows one switch per tool, each reflecting its own endpoint", async () => {
    primeBackend({ feedback: true, sessionInfo: false, workTasks: true })

    renderWithIntl()

    expect(await screen.findByLabelText(LABELS.feedback)).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByLabelText(LABELS.question)).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByLabelText(LABELS.sessionInfo)).toHaveAttribute(
      "data-state",
      "unchecked"
    )
    expect(screen.getByLabelText(LABELS.automations)).toHaveAttribute(
      "data-state",
      "unchecked"
    )
    expect(screen.getByLabelText(LABELS.workTasks)).toHaveAttribute(
      "data-state",
      "checked"
    )
  })

  it("saves only the group the user changed", async () => {
    primeBackend()

    renderWithIntl()

    fireEvent.click(await screen.findByLabelText(LABELS.question))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetQuestion).toHaveBeenCalledWith({ enabled: false })
    })
    // The other three endpoints hold values this panel never touched; writing
    // them back would republish state the user didn't ask to change.
    expect(mockSetFeedback).not.toHaveBeenCalled()
    expect(mockSetSessionInfo).not.toHaveBeenCalled()
    expect(mockSetChat).not.toHaveBeenCalled()
  })

  /** The browser group is the one switch here that is off out of the box, and
   * the one whose endpoint is new — so pin both ends: it reads its own value,
   * and saving it writes nothing else. */
  it("carries the built-in browser switch on its own endpoint", async () => {
    primeBackend({ browserTools: true })

    renderWithIntl()

    expect(await screen.findByLabelText(LABELS.browserTools)).toHaveAttribute(
      "data-state",
      "checked"
    )
    fireEvent.click(screen.getByLabelText(LABELS.browserTools))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetBrowser).toHaveBeenCalledWith({
        enabled: false,
        eval: false,
      })
    )
    expect(mockSetSessionInfo).not.toHaveBeenCalled()
    expect(mockSetChat).not.toHaveBeenCalled()
  })

  /** Running code is the one switch on this panel that is not "may an agent
   * see X", and it hangs off the browser switch above it: not touchable until
   * that one is on, gone when it goes off again, and it rides the same
   * endpoint. */
  it("keeps the run-code switch behind the browser switch", async () => {
    primeBackend()

    renderWithIntl()

    const evalSwitch = await screen.findByLabelText(LABELS.browserEval)
    expect(evalSwitch).toBeDisabled()
    expect(evalSwitch).toHaveAttribute("data-state", "unchecked")

    fireEvent.click(screen.getByLabelText(LABELS.browserTools))
    expect(screen.getByLabelText(LABELS.browserEval)).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText(LABELS.browserEval))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetBrowser).toHaveBeenCalledWith({
        enabled: true,
        eval: true,
      })
    )
  })

  /** Turning the group off takes the run-code switch with it — shown off
   * straight away, and sent off, so it cannot spring back the next time the
   * group is turned on. */
  it("drops the run-code switch when the browser switch goes off", async () => {
    primeBackend({ browserTools: true, browserEval: true })

    renderWithIntl()

    expect(await screen.findByLabelText(LABELS.browserEval)).toHaveAttribute(
      "data-state",
      "checked"
    )
    fireEvent.click(screen.getByLabelText(LABELS.browserTools))
    expect(screen.getByLabelText(LABELS.browserEval)).toHaveAttribute(
      "data-state",
      "unchecked"
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetBrowser).toHaveBeenCalledWith({
        enabled: false,
        eval: false,
      })
    )
  })

  it("writes both create-from-chat flags together and primes the feedback cache", async () => {
    primeBackend()

    renderWithIntl()

    fireEvent.click(await screen.findByLabelText(LABELS.feedback))
    fireEvent.click(screen.getByLabelText(LABELS.automations))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetChat).toHaveBeenCalledWith({
        automations_enabled: true,
        work_tasks_enabled: false,
      })
    })
    expect(mockSetFeedback).toHaveBeenCalledWith({ enabled: true })
    // Open conversations show/hide the feedback bar off this cached flag.
    expect(mockPrime).toHaveBeenCalledWith(true)
  })

  /** The status-bar codeg-mcp popover writes these same two flags one key at a
   * time. Save here writes the PAIR whenever either is dirty, so a form left
   * open across such a write must adopt the new value for the switch the user
   * never touched — otherwise saving the other one reverts it. */
  it("adopts a remote create-from-chat write instead of reverting it on save", async () => {
    primeBackend({ feedback: true })
    renderWithIntl()
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.feedback)).toBeChecked()
    )

    // Elsewhere (the popover), automations is switched on.
    act(() =>
      authoringHandler()?.({
        automations_enabled: true,
        work_tasks_enabled: false,
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.automations)).toBeChecked()
    )

    // The user now flips the OTHER switch here and saves.
    fireEvent.click(screen.getByLabelText(LABELS.workTasks))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetChat).toHaveBeenCalledWith({
        automations_enabled: true,
        work_tasks_enabled: true,
      })
    )
  })

  /** A switch the user already moved must not be yanked out from under them by
   * a remote write; their pending edit still wins on save. */
  it("keeps a pending local edit when a remote write lands", async () => {
    // `feedback: true` differs from the render-time default, so its switch
    // flipping on is the signal that the initial load has settled.
    primeBackend({ feedback: true })
    renderWithIntl()
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.feedback)).toBeChecked()
    )

    fireEvent.click(screen.getByLabelText(LABELS.automations))
    expect(screen.getByLabelText(LABELS.automations)).toBeChecked()

    act(() =>
      authoringHandler()?.({
        automations_enabled: false,
        work_tasks_enabled: false,
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.automations)).toBeChecked()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockSetChat).toHaveBeenCalledWith({
        automations_enabled: true,
        work_tasks_enabled: false,
      })
    )
    // Let the save settle before unmount, so its trailing state updates land
    // inside the test rather than after it.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    )
  })

  /** The same problem for the two browser switches, which the popover now
   * carries as two adjacent rows: a form left open across a popover toggle
   * must adopt it, or saving the other switch reverts it. */
  it("adopts a remote browser-tools write instead of reverting it on save", async () => {
    primeBackend({ browserTools: true })
    renderWithIntl()
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.browserTools)).toBeChecked()
    )

    // Elsewhere (the popover), running code is switched on.
    act(() => browserToolsHandler()?.({ enabled: true, eval: true }))
    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.browserEval)).toBeChecked()
    )

    // The user now flips the OTHER switch here and saves. The pair goes, so
    // the remote value has to be the one that rides along.
    fireEvent.click(screen.getByLabelText(LABELS.browserTools))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetBrowser).toHaveBeenCalledWith({
        enabled: false,
        // Clamped by the panel exactly as the backend clamps it: the row
        // shows off while the group is off, and sends what it shows.
        eval: false,
      })
    )
  })

  /** A broadcast that lands while the initial reads are still in flight is the
   * newer fact — the load must not restore what it sampled before it. */
  it("does not let a slow initial load overwrite a broadcast", async () => {
    let releaseChat: (v: {
      automations_enabled: boolean
      work_tasks_enabled: boolean
    }) => void = () => {}
    primeBackend()
    mockGetChat.mockReturnValue(
      new Promise((resolve) => {
        releaseChat = resolve
      })
    )

    renderWithIntl()
    await waitFor(() => expect(authoringHandler()).toBeDefined())

    // The popover writes while the form's own reads are still pending.
    act(() =>
      authoringHandler()?.({
        automations_enabled: true,
        work_tasks_enabled: false,
      })
    )
    // ...and only now does the (older) read land.
    await act(async () => {
      releaseChat({ automations_enabled: false, work_tasks_enabled: false })
    })

    await waitFor(() =>
      expect(screen.getByLabelText(LABELS.automations)).toBeChecked()
    )
    fireEvent.click(screen.getByLabelText(LABELS.workTasks))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockSetChat).toHaveBeenCalledWith({
        automations_enabled: true,
        work_tasks_enabled: true,
      })
    )
  })

  it("keeps Save inert until something actually changes", async () => {
    primeBackend()

    renderWithIntl()

    const save = await screen.findByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByLabelText(LABELS.sessionInfo))
    expect(save).toBeEnabled()
  })

  it("reports a failed group without blanking the rest, and won't write it back", async () => {
    primeBackend({ feedback: true })
    mockGetQuestion.mockRejectedValue(new Error("boom"))

    renderWithIntl()

    expect(await screen.findByRole("alert")).toHaveTextContent("boom")
    // Loaded groups still show what is stored…
    expect(screen.getByLabelText(LABELS.feedback)).toHaveAttribute(
      "data-state",
      "checked"
    )

    fireEvent.click(screen.getByLabelText(LABELS.sessionInfo))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetSessionInfo).toHaveBeenCalledWith({ enabled: false })
    })
    // …and the group whose load failed is showing a default, not stored state,
    // so an untouched switch must not overwrite the backend with it.
    expect(mockSetQuestion).not.toHaveBeenCalled()
  })
})
