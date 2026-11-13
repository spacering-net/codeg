import {
  firstLeafId,
  isLayoutNode,
  leafIds,
  normalizeTree,
  parentSplitOf,
  singleGroupLayout,
  splitGroup,
  type LayoutNode,
} from "@/lib/tab-group-layout"

export interface ConversationPane {
  id: string
  name: string
  layout: LayoutNode
  assignments: Record<string, string>
  selection: Record<string, string>
  tileByGroup: Record<string, boolean>
  active: string | null
}

export interface ConversationPaneState {
  schemaVersion: 1
  activePaneId: string
  nextOrdinal: number
  panes: ConversationPane[]
}

interface PaneTab {
  id: string
  folderId: number
  agentType: string
  conversationId: number | null
}

export function canonicalPaneTabId(tab: PaneTab) {
  return tab.conversationId == null
    ? tab.id
    : `conv-${tab.folderId}-${tab.agentType}-${tab.conversationId}`
}

export function paneForTab(state: ConversationPaneState, tabId: string) {
  return state.panes.find((pane) =>
    Object.prototype.hasOwnProperty.call(pane.assignments, tabId)
  )
}

export function emptyConversationPane(
  id: string,
  name: string,
  groupId = `${id}-main`
): ConversationPane {
  return {
    id,
    name,
    layout: singleGroupLayout(groupId),
    assignments: {},
    selection: {},
    tileByGroup: {},
    active: null,
  }
}

export function initialConversationPanes(): ConversationPaneState {
  return {
    schemaVersion: 1,
    activePaneId: "pane-main",
    nextOrdinal: 2,
    panes: [emptyConversationPane("pane-main", "Pane 1", "g-main")],
  }
}

export function isConversationPaneState(
  value: unknown
): value is ConversationPaneState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<ConversationPaneState>
  return (
    state.schemaVersion === 1 &&
    typeof state.activePaneId === "string" &&
    typeof state.nextOrdinal === "number" &&
    Number.isSafeInteger(state.nextOrdinal) &&
    state.nextOrdinal > 0 &&
    Array.isArray(state.panes) &&
    state.panes.length > 0 &&
    state.panes.every(
      (pane) =>
        typeof pane.id === "string" &&
        typeof pane.name === "string" &&
        isLayoutNode(pane.layout) &&
        pane.assignments != null &&
        typeof pane.assignments === "object" &&
        pane.selection != null &&
        typeof pane.selection === "object" &&
        pane.tileByGroup != null &&
        typeof pane.tileByGroup === "object"
    ) &&
    state.panes.some((pane) => pane.id === state.activePaneId)
  )
}

/** 先修复成员关系再收拢分屏，空 Pane 仍保留一个可继续打开会话的组。 */
export function normalizeConversationPanes(
  state: ConversationPaneState,
  tabs: PaneTab[]
): ConversationPaneState {
  const openIds = new Set(tabs.map((tab) => tab.id))
  const claimed = new Set<string>()
  const panes = state.panes.map((pane) => {
    const groups = new Set(leafIds(pane.layout))
    const assignments: Record<string, string> = {}
    for (const [tabId, groupId] of Object.entries(pane.assignments)) {
      if (!openIds.has(tabId) || claimed.has(tabId)) continue
      assignments[tabId] = groups.has(groupId)
        ? groupId
        : firstLeafId(pane.layout)
      claimed.add(tabId)
    }
    return { ...pane, assignments }
  })
  const target =
    panes.find((pane) => pane.id === state.activePaneId) ?? panes[0]
  for (const tab of tabs) {
    if (claimed.has(tab.id)) continue
    const rememberedGroup = target.active
      ? target.assignments[target.active]
      : undefined
    target.assignments[tab.id] = rememberedGroup ?? firstLeafId(target.layout)
  }
  for (const pane of panes) {
    const previous = state.panes.find((item) => item.id === pane.id)!
    const previouslyOccupied = new Set(Object.values(previous.assignments))
    pane.layout = normalizeTree(
      pane.layout,
      new Set([
        ...Object.values(pane.assignments),
        // 共享布局可以包含另一端的本机草稿组；未收到成员不能当作主动关闭分屏。
        ...leafIds(pane.layout).filter(
          (groupId) => !previouslyOccupied.has(groupId)
        ),
      ])
    )
    pane.selection = {}
    const members = Object.keys(pane.assignments)
    if (!pane.active || !members.includes(pane.active)) {
      pane.active = members[0] ?? null
    }
    for (const groupId of leafIds(pane.layout)) {
      const groupMembers = members.filter(
        (tabId) => pane.assignments[tabId] === groupId
      )
      const active =
        pane.active && pane.assignments[pane.active] === groupId
          ? pane.active
          : previous.selection[groupId]
      const selected =
        active && groupMembers.includes(active) ? active : groupMembers[0]
      if (selected) pane.selection[groupId] = selected
    }
    pane.tileByGroup = Object.fromEntries(
      Object.entries(pane.tileByGroup).filter(([groupId]) =>
        leafIds(pane.layout).includes(groupId)
      )
    )
  }
  return { ...state, activePaneId: target.id, panes }
}

/** 草稿只留本机；服务端使用稳定会话标识，避免草稿绑定后标签 id 改变导致丢归属。 */
export function persistedConversationPanes(
  state: ConversationPaneState,
  tabs: PaneTab[]
): ConversationPaneState {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const remap = (tabId: string) => {
    const tab = byId.get(tabId)
    return tab?.conversationId != null ? canonicalPaneTabId(tab) : null
  }
  return {
    ...state,
    panes: state.panes.map((pane) => ({
      ...pane,
      assignments: Object.fromEntries(
        Object.entries(pane.assignments).flatMap(([tabId, groupId]) => {
          const canonical = remap(tabId)
          return canonical ? [[canonical, groupId]] : []
        })
      ),
      selection: Object.fromEntries(
        Object.entries(pane.selection).flatMap(([groupId, tabId]) => {
          const canonical = remap(tabId)
          return canonical ? [[groupId, canonical]] : []
        })
      ),
      active: pane.active ? remap(pane.active) : null,
    })),
  }
}

export function restoreConversationPanes(
  shared: ConversationPaneState,
  tabs: PaneTab[],
  local: ConversationPaneState | null
): ConversationPaneState {
  const localId = new Map(tabs.map((tab) => [canonicalPaneTabId(tab), tab.id]))
  const panes = shared.panes.map((pane) => {
    const assignments: Record<string, string> = {}
    for (const [canonical, groupId] of Object.entries(pane.assignments)) {
      const tabId = localId.get(canonical)
      if (tabId) assignments[tabId] = groupId
    }
    const selection = Object.fromEntries(
      Object.entries(pane.selection).flatMap(([groupId, canonical]) => {
        const tabId = localId.get(canonical)
        return tabId ? [[groupId, tabId]] : []
      })
    )
    return {
      ...pane,
      assignments,
      selection,
      active: pane.active ? (localId.get(pane.active) ?? null) : null,
    }
  })
  // 远端快照不含本机草稿；保留其归属和分屏，不把未发送内容当成远端删除。
  for (const tab of tabs) {
    if (tab.conversationId != null) continue
    const old = local ? paneForTab(local, tab.id) : undefined
    const target =
      panes.find((pane) => pane.id === old?.id) ??
      panes.find((pane) => pane.id === shared.activePaneId) ??
      panes[0]
    const oldGroup = old?.assignments[tab.id]
    if (old && oldGroup && old.id === target.id) {
      const sharedGroups = new Set(leafIds(target.layout))
      if (!sharedGroups.has(oldGroup)) {
        // 只补回草稿缺少的组，不能把整棵旧树盖回去而丢掉另一端的新分屏。
        const oldGroups = leafIds(old.layout)
        const anchor =
          oldGroups
            .slice(0, oldGroups.indexOf(oldGroup))
            .reverse()
            .find((groupId) => sharedGroups.has(groupId)) ??
          firstLeafId(target.layout)
        const direction =
          parentSplitOf(old.layout, oldGroup)?.orientation === "vertical"
            ? "down"
            : "right"
        target.layout = splitGroup(target.layout, anchor, direction, oldGroup)
      }
      target.assignments[tab.id] = oldGroup
    } else {
      target.assignments[tab.id] = firstLeafId(target.layout)
    }
  }
  return normalizeConversationPanes({ ...shared, panes }, tabs)
}
