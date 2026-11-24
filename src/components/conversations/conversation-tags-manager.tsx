"use client"

/**
 * The tag manager: conversation tags created, edited, reordered and deleted in
 * a dialog over whatever page it was opened from. The branch tag on top (one
 * switch and a colour for every conversation's git branch), then the global
 * tags (offered on every conversation, chat mode included), then one folder's
 * own, the folder picked in place.
 *
 * Any surface opens it through `openConversationTagsManager` — a
 * conversation's tag picker and its Tags submenu, a folder's menu, the
 * sidebar's tag filter — and the workspace mounts the one host that draws it.
 * Those openers are popovers and menus, which unmount their content as they
 * close, so none of them could keep a dialog of its own alive.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { FolderTree, GitBranch, Globe, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { tagScopeFolderId } from "@/lib/conversation-tags"
import { excludeChatFolders, filterTopLevelFolders } from "@/lib/folder-display"
import type { ConversationBranchTag } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  FolderSelect,
  type FolderSelectOption,
} from "@/components/shared/folder-select"
import { ConversationBranchChip } from "./conversation-tag-chip"
import { TagColorPicker } from "./conversation-tag-form-dialog"
import { ConversationTagListEditor } from "./conversation-tag-list-editor"

interface ManagerRequest {
  id: number
  /** The folder the opener was about, as it knows it (a worktree's own id,
   *  say), or null for none. */
  folderId: number | null
}

let current: ManagerRequest | null = null
let lastId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Open the tag manager. `folderId` is the folder whose own tags to show under
 * the global ones: the folder of the conversation or folder row it was opened
 * from — any folder will do, a worktree's tags are its repo's. Without one it
 * shows the folder of the conversation on screen.
 *
 * Ignored while the manager is already open: it is modal, so a second request
 * can only come from code, and replacing the dialog would throw away an edit
 * in progress.
 */
export function openConversationTagsManager(
  options: { folderId?: number | null } = {}
): void {
  if (current) return
  lastId += 1
  current = { id: lastId, folderId: options.folderId ?? null }
  notify()
}

/** Named by id, so a close from a dialog already gone is a no-op. */
function closeConversationTagsManager(id: number): void {
  if (current?.id !== id) return
  current = null
  notify()
}

export function resetConversationTagsManagerForTests(): void {
  current = null
  notify()
}

/** Mounted once in the workspace; draws the manager while it is open. */
export function ConversationTagsManagerHost() {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
  if (!request) return null
  return (
    <ConversationTagsManagerDialog
      // Each opening lands on its own folder, never the last one's pick.
      key={request.id}
      folderId={request.folderId}
      onClose={() => closeConversationTagsManager(request.id)}
    />
  )
}

function ManagerSection({
  icon: Icon,
  title,
  description,
  control,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  control?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3
          id={headingId}
          className="flex min-w-0 items-center gap-2 text-sm font-medium"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{title}</span>
        </h3>
        {control}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children}
    </section>
  )
}

/** The branch the colour preview is drawn with: branch names are never
 *  translated, and nearly every repo has this one. */
const PREVIEW_BRANCH = "main"

/** How long a colour has to stay picked before it is saved. The custom well's
 *  native picker reports every colour the pointer drags across, and saving
 *  each would send every window a stream of writes. */
const BRANCH_COLOR_SAVE_DELAY_MS = 300

/**
 * The branch tag: one switch for every conversation's git branch, and the
 * colour it is drawn in. Saved as it changes — there is nothing to submit —
 * the colour after a short pause, and when the manager closes at the latest.
 */
function BranchTagSection() {
  const t = useTranslations("ConversationTags")
  const branchTag = useConversationTagsStore((s) => s.branchTag)
  const loaded = useConversationTagsStore((s) => s.branchTagLoaded)
  const loadError = useConversationTagsStore((s) => s.branchTagLoadError)
  // The colour being picked, drawn at once while its save waits.
  const [draftColor, setDraftColor] = useState<string | null>(null)
  const pendingColor = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(
    (patch: Partial<ConversationBranchTag>) => {
      // From the store as it is NOW, not as this render saw it: another
      // window may have changed the other half since.
      const store = useConversationTagsStore.getState()
      store.setBranchTag({ ...store.branchTag, ...patch }).catch((err) => {
        toast.error(t("toasts.branchTagFailed"), {
          description: toLocalizedErrorMessage(
            err,
            t as unknown as AppErrorTranslator
          ),
        })
      })
    },
    [t]
  )

  /** Take the colour still waiting to be saved, if any, off the timer. */
  const takePendingColor = useCallback(() => {
    if (saveTimer.current != null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const color = pendingColor.current
    pendingColor.current = null
    return color
  }, [])

  // Closing the manager right after a pick must not drop it. (Also run when
  // `save` changes — a locale switch — so the draft is let go of too: left
  // behind, it would hide whatever the store says next.)
  useEffect(
    () => () => {
      const color = takePendingColor()
      if (color != null) save({ color })
      setDraftColor(null)
    },
    [takePendingColor, save]
  )

  const pickColor = (color: string) => {
    takePendingColor()
    pendingColor.current = color
    setDraftColor(color)
    saveTimer.current = setTimeout(() => {
      const pending = takePendingColor()
      if (pending != null) save({ color: pending })
      setDraftColor(null)
    }, BRANCH_COLOR_SAVE_DELAY_MS)
  }

  const toggle = (enabled: boolean) => {
    // One write carrying both, rather than a colour save racing behind it.
    const color = takePendingColor()
    setDraftColor(null)
    save(color == null ? { enabled } : { enabled, color })
  }

  const color = draftColor ?? branchTag.color

  return (
    <ManagerSection
      icon={GitBranch}
      title={t("manager.branchTitle")}
      description={t("manager.branchDescription")}
      control={
        <Label className="shrink-0 text-sm font-normal">
          <Checkbox
            checked={branchTag.enabled}
            disabled={!loaded}
            onCheckedChange={(value) => toggle(value === true)}
          />
          {t("manager.branchShow")}
        </Label>
      }
    >
      {/* Shown switched off too, only dimmed: the section keeps its height,
          so the dialog (centred on screen) does not shift the checkbox out
          from under the pointer that just clicked it. */}
      {loaded ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <TagColorPicker
            value={color}
            onChange={pickColor}
            disabled={!branchTag.enabled}
          />
          {/* What the chip will look like, in the current theme. */}
          <ConversationBranchChip
            branch={{ name: PREVIEW_BRANCH, color }}
            className={cn(!branchTag.enabled && "opacity-50")}
          />
        </div>
      ) : loadError ? (
        <p role="alert" className="text-xs text-destructive">
          {t("manager.branchLoadFailed")}
        </p>
      ) : null}
    </ManagerSection>
  )
}

function ConversationTagsManagerDialog({
  folderId,
  onClose,
}: {
  folderId: number | null
  onClose: () => void
}) {
  const t = useTranslations("ConversationTags.manager")
  const tags = useConversationTagsStore((s) => s.tags)
  const tagsHydrated = useConversationTagsStore((s) => s.hydrated)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const [pickedFolderId, setPickedFolderId] = useState<number | null>(null)

  // A tag list (or branch tag setting) that failed to load gets another try
  // here: opening the manager is asking to see it, and every section below
  // waits on it.
  useEffect(() => {
    const store = useConversationTagsStore.getState()
    if (!store.hydrated) void store.fetchTags()
    if (!store.branchTagLoaded) void store.fetchBranchTag()
  }, [])

  // Only folders that can own tags: top-level, user-facing ones. A worktree's
  // conversations use its repo's tags, and chat folders have none of their own.
  const folderOptions = useMemo<FolderSelectOption[]>(
    () =>
      excludeChatFolders(filterTopLevelFolders(allFolders))
        .map((f) => ({ id: f.id, name: f.name, alias: f.alias, path: f.path }))
        .sort((a, b) => (a.alias ?? a.name).localeCompare(b.alias ?? b.name)),
    [allFolders]
  )

  // Where to land: the folder the manager was opened about, else the folder of
  // the conversation on screen — each as the root that owns its tags — else the
  // first folder that already has tags, else the first folder. `undefined`
  // while that last rule still waits on the tag list: landing on the first
  // folder and being held there would miss the one that does have tags.
  const defaultFolderId = useMemo(() => {
    const listedScope = (id: number | null) => {
      if (id == null) return null
      const scope = tagScopeFolderId(allFolders.find((f) => f.id === id))
      return scope != null && folderOptions.some((f) => f.id === scope)
        ? scope
        : null
    }
    const preferred = listedScope(folderId) ?? listedScope(activeFolderId)
    if (preferred != null) return preferred
    if (!tagsHydrated) return undefined
    const owners = new Set(
      tags.map((tag) => tag.folder_id).filter((id) => id != null)
    )
    return (
      folderOptions.find((f) => owners.has(f.id))?.id ??
      folderOptions[0]?.id ??
      null
    )
  }, [folderId, activeFolderId, allFolders, folderOptions, tags, tagsHydrated])

  // The landing spot is chosen ONCE, then held: re-deriving it from live data
  // would switch folders under the user — and remount the editor, discarding
  // an open edit — the moment another window gave some other folder its first
  // tag. It only moves again if the folder it names leaves the list. Adjusted
  // during render rather than in an effect, so there is no frame showing none.
  const pickedIsListed =
    pickedFolderId != null && folderOptions.some((f) => f.id === pickedFolderId)
  if (
    !pickedIsListed &&
    foldersHydrated &&
    defaultFolderId !== undefined &&
    pickedFolderId !== defaultFolderId
  ) {
    setPickedFolderId(defaultFolderId)
  }
  const selectedFolderId = pickedIsListed ? pickedFolderId : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <BranchTagSection />

        <ManagerSection
          icon={Globe}
          title={t("globalTitle")}
          description={t("globalDescription")}
        >
          <ConversationTagListEditor scopeFolderId={null} />
        </ManagerSection>

        <ManagerSection
          icon={FolderTree}
          title={t("folderTitle")}
          description={t("folderDescription")}
          control={
            folderOptions.length > 0 ? (
              <FolderSelect
                variant="field"
                folders={folderOptions}
                value={selectedFolderId}
                onChange={setPickedFolderId}
                placeholder={t("folderPlaceholder")}
              />
            ) : null
          }
        >
          {foldersHydrated && folderOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noFolders")}</p>
          ) : null}
          {selectedFolderId != null ? (
            <ConversationTagListEditor
              key={selectedFolderId}
              scopeFolderId={selectedFolderId}
            />
          ) : null}
        </ManagerSection>
      </DialogContent>
    </Dialog>
  )
}
