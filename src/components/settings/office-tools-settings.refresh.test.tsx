import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AcpAgentInfo, OfficecliInfo, OfficecliSkill } from "@/lib/types"

const listSkills = vi.fn<() => Promise<OfficecliSkill[]>>()
const detect = vi.fn<() => Promise<OfficecliInfo>>()
const toastError = vi.fn()

vi.mock("@/lib/api", () => ({
  acpListAgents: async () =>
    [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        skills_capable: true,
        env: {},
      },
    ] as unknown as AcpAgentInfo[],
  officecliDetect: () => detect(),
  officecliListSkills: () => listSkills(),
  officecliSkillListAllInstallStatuses: async () => [],
  officecliSkillApplyLinks: async () => [],
  officecliSkillReadContent: async () => "",
  officecliInstall: vi.fn(),
  officecliSyncSkills: vi.fn(),
  officecliUninstall: vi.fn(),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (message: string) => toastError(message),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

import { OfficeToolsBody } from "./office-tools-settings"

const skill = (name: string): OfficecliSkill => ({
  id: name.toLowerCase(),
  category: "documents",
  icon: "FileText",
  sortOrder: 0,
  displayName: { en: name },
  description: { en: "" },
  installedCentrally: true,
})

const info = (version: string): OfficecliInfo => ({
  installed: true,
  version,
  path: "/usr/local/bin/officecli",
  runtimeError: null,
})

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (err: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderOffice() {
  let refresh: (() => void) | undefined
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OfficeToolsBody
        onRegisterRefresh={(fn) => {
          refresh = fn
        }}
      />
    </NextIntlClientProvider>
  )
  await screen.findByText("Original")
  return () => act(async () => refresh?.())
}

beforeEach(() => {
  listSkills.mockReset()
  detect.mockReset()
  toastError.mockReset()
  listSkills.mockResolvedValue([skill("Original")])
  detect.mockResolvedValue(info("1.0.0"))
})

describe("the Office tab", () => {
  it("keeps the newer skill list when an earlier load answers late", async () => {
    const refresh = await renderOffice()
    const first = deferred<OfficecliSkill[]>()
    listSkills.mockImplementationOnce(() => first.promise)
    await refresh()
    listSkills.mockResolvedValue([skill("Newer")])
    await refresh()
    expect(await screen.findByText("Newer")).toBeInTheDocument()

    await act(async () => first.resolve([skill("Stale")]))
    expect(screen.queryByText("Stale")).toBeNull()
    expect(screen.getByText("Newer")).toBeInTheDocument()
  })

  it("says nothing about an earlier load that fails late", async () => {
    const refresh = await renderOffice()
    const first = deferred<OfficecliSkill[]>()
    listSkills.mockImplementationOnce(() => first.promise)
    await refresh()
    await refresh()

    await act(async () => first.reject(new Error("stale failure")))
    expect(toastError).not.toHaveBeenCalled()
  })

  it("keeps the newer detection when an earlier one answers late", async () => {
    const refresh = await renderOffice()
    expect(await screen.findByText(/1\.0\.0/)).toBeInTheDocument()
    const first = deferred<OfficecliInfo>()
    detect.mockImplementationOnce(() => first.promise)
    await refresh()
    detect.mockResolvedValue(info("3.0.0"))
    await refresh()
    expect(await screen.findByText(/3\.0\.0/)).toBeInTheDocument()

    await act(async () => first.resolve(info("2.0.0")))
    expect(screen.queryByText(/2\.0\.0/)).toBeNull()
    expect(screen.getByText(/3\.0\.0/)).toBeInTheDocument()
  })
})
