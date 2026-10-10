import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { act, render, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AgentSkillItem,
  AgentType,
  AvailableCommandInfo,
} from "@/lib/types"

// Codex's on-disk skills for the folder; every other agent scans none.
const CODEX_SKILLS: AgentSkillItem[] = [
  {
    id: "ship",
    name: "ship",
    scope: "project",
    layout: "skill_directory",
    path: "/ws/.codex/skills/ship",
    description: null,
    read_only: false,
  },
]
const NO_SKILLS: AgentSkillItem[] = []

const defaultSkills = (agentType: AgentType | null) =>
  agentType === "codex" ? CODEX_SKILLS : NO_SKILLS
const mockUseAgentSkills =
  vi.fn<
    (
      agentType: AgentType | null,
      workspacePath?: string | null
    ) => AgentSkillItem[]
  >(defaultSkills)
vi.mock("@/hooks/use-agent-skills", () => ({
  useAgentSkills: (
    agentType: AgentType | null,
    workspacePath?: string | null
  ) => mockUseAgentSkills(agentType, workspacePath),
}))

// What each agent last advertised in each folder, as the real store answers it:
// one stable list per pair until a write replaces it and wakes its readers.
const remembered = vi.hoisted(() => ({
  lists: new Map<string, { name: string }[]>(),
  listeners: new Set<() => void>(),
}))
const pairKey = (agentType: string, folder: string | null | undefined) =>
  `${agentType}|${folder}`
vi.mock("@/lib/advertised-commands-store", () => ({
  getLastAdvertisedCommands: (
    agentType: string,
    folder: string | null | undefined
  ) => remembered.lists.get(pairKey(agentType, folder)) ?? null,
  subscribeLastAdvertisedCommands: (listener: () => void) => {
    remembered.listeners.add(listener)
    return () => {
      remembered.listeners.delete(listener)
    }
  },
}))

function remember(agentType: string, folder: string, names: string[]) {
  act(() => {
    remembered.lists.set(
      pairKey(agentType, folder),
      names.map((name) => ({ name }))
    )
    for (const listener of remembered.listeners) listener()
  })
}

import { KnownInvocationsProvider } from "./known-invocations-context"
import { PlainTextWithBadges } from "./plain-text-with-badges"
import { useTranscriptKnownInvocations } from "./use-transcript-known-invocations"

const command = (name: string): AvailableCommandInfo => ({
  name,
  description: "",
})

const sorted = (known: ReadonlySet<string>) => [...known].sort()

beforeEach(() => {
  mockUseAgentSkills.mockClear()
  mockUseAgentSkills.mockImplementation(defaultSkills)
  remembered.lists.clear()
})

describe("useTranscriptKnownInvocations", () => {
  it("knows an agent's advertised commands without scanning skills from disk", () => {
    const commands = [command("review"), command("init")]
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("claude_code", commands, "/ws")
    )
    expect(sorted(result.current)).toEqual(["/init", "/review"])
    // Every agent but Codex advertises its skills as commands already.
    expect(mockUseAgentSkills).toHaveBeenCalledWith(null, "/ws")
  })

  it("adds Codex's on-disk skills under `$`, read from the transcript's folder", () => {
    // `$deploy` is a skill Codex advertises as a command named `$deploy`.
    const commands = [command("review"), command("$deploy")]
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("codex", commands, "/ws")
    )
    expect(sorted(result.current)).toEqual(["$deploy", "$ship", "/review"])
    expect(mockUseAgentSkills).toHaveBeenCalledWith("codex", "/ws")
  })

  it("knows nothing before the agent advertises in a new folder, beyond Codex's disk skills", () => {
    const none = (agentType: AgentType, list: null | undefined) =>
      renderHook(() => useTranscriptKnownInvocations(agentType, list, "/ws"))
        .result.current
    expect(none("claude_code", null).size).toBe(0)
    expect(none("claude_code", undefined).size).toBe(0)
    expect(sorted(none("codex", null))).toEqual(["$ship"])
  })

  it("badges what the agent last advertised in this folder until it advertises", () => {
    // No connection yet (null), or a host with none at all (undefined): the
    // record for this agent and folder stands in, and nobody else's.
    remember("claude_code", "/ws", ["review"])
    remember("claude_code", "/elsewhere", ["deploy"])
    remember("codex", "/ws", ["init"])
    const before = (list: null | undefined) =>
      renderHook(() =>
        useTranscriptKnownInvocations("claude_code", list, "/ws")
      ).result.current
    expect(sorted(before(null))).toEqual(["/review"])
    expect(sorted(before(undefined))).toEqual(["/review"])

    // Codex's record adds to its disk skills, `$` names and all.
    remember("codex", "/ws", ["init", "$deploy"])
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("codex", null, "/ws")
    )
    expect(sorted(result.current)).toEqual(["$deploy", "$ship", "/init"])
  })

  it("lets the connection's own list win, even an empty one", () => {
    remember("claude_code", "/ws", ["review", "deploy"])
    const { result, rerender } = renderHook(
      ({ list }) => useTranscriptKnownInvocations("claude_code", list, "/ws"),
      {
        initialProps: {
          list: null as readonly AvailableCommandInfo[] | null,
        },
      }
    )
    expect(sorted(result.current)).toEqual(["/deploy", "/review"])

    rerender({ list: [command("review")] })
    expect(sorted(result.current)).toEqual(["/review"])
    // `[]` is an answer, not a gap: the agent offers nothing here.
    rerender({ list: [] })
    expect(result.current.size).toBe(0)
  })

  it("follows a newer record while the list is unknown, and ignores it once known", () => {
    let renders = 0
    const { result, rerender } = renderHook(
      ({ list }) => {
        renders += 1
        return useTranscriptKnownInvocations("claude_code", list, "/ws")
      },
      {
        initialProps: {
          list: null as readonly AvailableCommandInfo[] | null,
        },
      }
    )
    expect(result.current.size).toBe(0)
    // Another tab on this folder connects and the agent advertises there.
    remember("claude_code", "/ws", ["review"])
    expect(sorted(result.current)).toEqual(["/review"])

    const commands = [command("init")]
    rerender({ list: commands })
    const live = result.current
    const rendersWithLiveList = renders
    // A newer record no longer concerns this transcript: it does not even
    // re-render, let alone change what it badges.
    remember("claude_code", "/ws", ["review", "deploy"])
    expect(renders).toBe(rendersWithLiveList)
    expect(result.current).toBe(live)
    expect(sorted(result.current)).toEqual(["/init"])
  })

  it("keeps its reference until one of its lists changes", () => {
    // A new value re-renders every user message on screen, so a render that
    // changed neither list (a streaming tick) must hand back the same one.
    const commands = [command("review")]
    const { result, rerender } = renderHook(
      ({ list }) => useTranscriptKnownInvocations("claude_code", list, "/ws"),
      { initialProps: { list: commands } }
    )
    const first = result.current
    rerender({ list: commands })
    expect(result.current).toBe(first)

    rerender({ list: [command("review"), command("init")] })
    expect(result.current).not.toBe(first)
    expect(sorted(result.current)).toEqual(["/init", "/review"])
  })

  it("rebuilds when Codex's disk skills change under the same commands", () => {
    const commands = [command("review")]
    const { result, rerender } = renderHook(() =>
      useTranscriptKnownInvocations("codex", commands, "/ws")
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    // A focus refresh found a new skill in the folder: a new list arrives.
    const refreshed: AgentSkillItem[] = [
      ...CODEX_SKILLS,
      { ...CODEX_SKILLS[0], id: "deploy", name: "deploy" },
    ]
    mockUseAgentSkills.mockImplementation((agentType) =>
      agentType === "codex" ? refreshed : NO_SKILLS
    )
    rerender()
    expect(result.current).not.toBe(first)
    expect(sorted(result.current)).toEqual(["$deploy", "$ship", "/review"])
    // …and then holds still again while nothing changes.
    const refreshedSet = result.current
    rerender()
    expect(result.current).toBe(refreshedSet)
  })

  it("badges in a sent message exactly the tokens it knows", () => {
    function Bubble({ text }: { text: string }) {
      const known = useTranscriptKnownInvocations(
        "codex",
        [command("review")],
        "/ws"
      )
      return (
        <KnownInvocationsProvider value={known}>
          <PlainTextWithBadges text={text} />
        </KnownInvocationsProvider>
      )
    }
    const { container } = render(
      <Bubble text="run /review, then $ship; not /tmp or /ship" />
    )
    const badges = [...container.querySelectorAll("[data-reference-badge]")]
    expect(badges.map((badge) => badge.textContent)).toEqual(["review", "ship"])
    // A path, and a Codex skill written with the wrong prefix, stay text.
    expect(container.textContent).toContain("not /tmp or /ship")
  })
})

describe("MessageListView", () => {
  it("provides this list, for its own agent and folder, around its whole thread", () => {
    // The bubbles read it through context, so dropping the provider (or moving
    // it inside part of the thread) would silently stop every badge there. The
    // folder is the one its images resolve against, the composer's own folder.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/message/message-list-view.tsx"),
      "utf8"
    )
    // Exactly one call, so the match below is the call in use rather than a
    // stray second one beside it.
    expect(source.match(/useTranscriptKnownInvocations\(/g)).toHaveLength(1)
    expect(source).toMatch(
      /const knownInvocations = useTranscriptKnownInvocations\(\s*agentType,\s*availableCommands,\s*resolvedImageRoot\s*\)/
    )
    expect(source).toMatch(
      /<KnownInvocationsProvider value=\{knownInvocations\}>\s*\{thread\}\s*<\/KnownInvocationsProvider>/
    )
  })

  it("is told the list is unknown, not empty, until the agent advertises", () => {
    // The remembered list stands in only for a list that is not known yet. A
    // surface that turned "not yet" into `[]` would claim the agent offers
    // nothing, and its transcript would lose every badge until the handshake.
    const read = (path: string) =>
      readFileSync(resolve(process.cwd(), path), "utf8")
    const commandsPassedBy = (path: string) => {
      const source = read(path)
      const start = source.indexOf("<MessageListView")
      const tag = source.slice(start, source.indexOf("/>", start))
      return /\bavailableCommands=\{([^}]*)\}/.exec(tag)?.[1].trim()
    }
    expect(
      commandsPassedBy("src/components/canvas/canvas-conversation-surface.tsx")
    ).toBe("conn.availableCommands")
    // Except with no agent known at all: then nothing it remembered applies,
    // and `[]` is the deliberate answer.
    expect(
      commandsPassedBy("src/components/message/live-transcript-view.tsx")
    ).toBe("transcriptAgent ? conn?.availableCommands : []")
    const detailPanel =
      "src/components/conversations/conversation-detail-panel.tsx"
    expect(commandsPassedBy(detailPanel)).toBe("connectionCommands")
    expect(read(detailPanel)).toMatch(
      /const connectionCommands = connIsForOtherAgent \? null : conn\.availableCommands\n/
    )
  })
})
