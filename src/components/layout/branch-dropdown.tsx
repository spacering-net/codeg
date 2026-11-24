"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  gitInit,
  gitNewBranch,
  gitWorktreeAdd,
  gitListAllBranches,
  gitMerge,
  gitRebase,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitRemoveWorktree,
} from "@/lib/api"
import { subscribe } from "@/lib/platform"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"
import { useSwitchToBranch } from "@/hooks/use-switch-to-branch"
import {
  buildBranchTree,
  buildRemoteBranchSections,
  localBranchItems,
  worktreeBranchNodes,
} from "@/lib/branch-tree"
import { BranchSelectorList } from "@/components/layout/branch-selector-list"
import type {
  BranchLeafAction,
  BranchOperationMeta,
} from "@/lib/branch-selector-rows"
import { useScrollbarSafeDismiss } from "@/hooks/use-scrollbar-safe-dismiss"
import { useGitQuickActions } from "@/hooks/use-git-quick-actions"
import { useImeGuard } from "@/hooks/use-ime-guard"
import type { FolderDetail, GitBranchList } from "@/lib/types"
import { fsBaseName, siblingFsPath } from "@/lib/path-utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useGitCredential } from "@/contexts/git-credential-context"

type ConfirmAction = {
  type:
    | "merge"
    | "rebase"
    | "delete"
    | "forceDelete"
    | "deleteRemote"
    | "deleteWorktree"
    | "forceDeleteWorktree"
    | "deleteWorktreeAndBranch"
    | "forceDeleteWorktreeAndBranch"
  branchName: string
}

// Confirmations whose action can't be undone — their confirm button goes red.
const DESTRUCTIVE_CONFIRMS: ReadonlySet<ConfirmAction["type"]> = new Set([
  "delete",
  "forceDelete",
  "deleteRemote",
  "deleteWorktree",
  "forceDeleteWorktree",
  "deleteWorktreeAndBranch",
  "forceDeleteWorktreeAndBranch",
])

// Git's way of saying "this would throw work away — ask again with --force":
// a worktree with uncommitted or untracked files, or a branch whose commits
// aren't merged anywhere. Both escalate to the matching force confirm rather
// than surfacing a raw git error the user can do nothing about.
const FORCE_REQUIRED_RE = /--force|not fully merged/i

// The four worktree-removal confirmations, decoded into the two flags the one
// backend call takes: whether the branch (and the worktree's workspace folder)
// goes with the directory, and whether to discard work standing in the way.
const WORKTREE_REMOVALS = {
  deleteWorktree: { withBranch: false, force: false },
  deleteWorktreeAndBranch: { withBranch: true, force: false },
  forceDeleteWorktree: { withBranch: false, force: true },
  forceDeleteWorktreeAndBranch: { withBranch: true, force: true },
} as const

interface GitCommitSucceededEventPayload {
  folder_id: number
  committed_files: number
}

interface GitPushSucceededEventPayload {
  folder_id: number
  pushed_commits: number
  upstream_set: boolean
}

interface BranchDropdownProps {
  /** The row's OWN folder (each conversation tile passes its own), not the
   *  active one — so a tiled view keeps every tile's branch chip live. */
  folder: FolderDetail | null
  /** Whether this tile is folderless "chat mode" (self-hides the chip). */
  isChatMode: boolean
}

// The branch chip in the below-composer folder/branch row. It's mounted once per
// conversation tile with that tile's own `folder`, and carries per-instance
// machinery (git event subscriptions + dialogs).
export function BranchDropdown({ folder, isChatMode }: BranchDropdownProps) {
  const t = useTranslations("Folder.branchDropdown")
  const ime = useImeGuard()
  const tCommon = useTranslations("Folder.common")
  const activeFolder = folder
  const refreshFolder = useAppWorkspaceStore((s) => s.refreshFolder)
  const openWorktreeFolder = useAppWorkspaceStore((s) => s.openWorktreeFolder)
  const { openNewConversationTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { withCredentialRetry } = useGitCredential()
  const switchToBranch = useSwitchToBranch()
  // Grabbing the popover's inner scrollbar blurs focus, which WebKit bounces to
  // an outside element that Radix reads as a dismiss — keep it open (see hook).
  const { contentRef, onPointerDownOutside, onFocusOutside } =
    useScrollbarSafeDismiss()

  const folderPath = activeFolder?.path ?? ""
  const folderId = activeFolder?.id ?? 0
  // Per-folder selections (primitive / equality-guarded object): unrelated
  // folders' branch updates never re-render this dropdown.
  const branch = useAppWorkspaceStore((s) =>
    activeFolder
      ? (s.branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null)
      : null
  )
  const head = useAppWorkspaceStore((s) =>
    activeFolder ? (s.gitHeads.get(activeFolder.id) ?? null) : null
  )
  // The gate is "is this a git repo?" — not "is there a branch?". A detached
  // HEAD has no branch name yet is still a repo whose git operations must
  // remain available (issue #279). Until the first poll resolves `head`, fall
  // back to branch presence so the first-frame behavior is unchanged.
  const isRepo = head ? head.is_repo : branch !== null
  const isDetached = !branch && !!head?.detached

  // Resolve this folder's HEAD ourselves when nothing else has. The workspace
  // polls exactly ONE folder (the active tab's), and the folder row's
  // `git_branch` column is always null — so every chip mounted for some other
  // folder used to read `isRepo === false` and render "no branch" forever. That
  // is what a canvas board is: many folders on screen at once, none of them the
  // active tab. Idempotent + in-flight-deduped in the store, so N chips over M
  // folders make M requests; the active folder's poll keeps owning freshness.
  const ensureGitHead = useAppWorkspaceStore((s) => s.ensureGitHead)
  useEffect(() => {
    if (isChatMode || head || !folderId || !folderPath) return
    ensureGitHead(folderId, folderPath)
  }, [isChatMode, head, folderId, folderPath, ensureGitHead])

  const [branchList, setBranchList] = useState<GitBranchList>({
    local: [],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [branchLoading, setBranchLoading] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  const [worktreeBranchName, setWorktreeBranchName] = useState("")
  const [worktreePath, setWorktreePath] = useState("")

  // Task running, credential retry, pull/fetch/window openers and the
  // conflict/stash dialogs all live in the shared hook, so the aux-panel git
  // tabs drive the exact same machinery from their own toolbars.
  const {
    running: loading,
    runGitTask,
    pull: handlePull,
    fetchAll,
    updateBranch,
    openCommitWindow: openCommit,
    openPushWindow: openPush,
    reportConflict,
    dialogs: gitDialogs,
  } = useGitQuickActions({ folderId, folderPath })

  const worktreeBranchSet = useMemo(
    () => new Set(branchList.worktree_branches),
    [branchList.worktree_branches]
  )
  // The worktree shortcut section: the branches this repo has checked out
  // elsewhere, listed above Local so switching to a worktree is one place to
  // look instead of a hunt through every local branch. They stay in the local
  // tree too — `local` is still the full `git branch` list.
  const worktreeNodes = useMemo(
    () =>
      worktreeBranchNodes(
        branchList.worktree_branches,
        branchList.main_worktree_branch
      ),
    [branchList.worktree_branches, branchList.main_worktree_branch]
  )
  const localNodes = useMemo(
    () => buildBranchTree(localBranchItems(branchList.local), "local"),
    [branchList.local]
  )
  const remoteSections = useMemo(
    () => buildRemoteBranchSections(branchList.remote),
    [branchList.remote]
  )
  // Operations shown as a searchable block at the top of the popup; the list
  // resolves each id to an icon and dispatches back through `runOperation`.
  // `groupEnd` inserts a separator after that op (non-search) to restore the old
  // menu's pull/fetch | commit/push | new blocking. Deliberately short: this chip
  // sits under the composer and is first of all a BRANCH picker, so the
  // long-tail operations (stash, unstash, manage remotes) live in the aux
  // panel's git tabs — the changes tab owns the working-tree ones, the commits
  // tab owns the remotes. The last entry carries no `groupEnd`: the row builder
  // already separates the operation block from the branch tree.
  const operations = useMemo<BranchOperationMeta[]>(
    () => [
      { id: "pull", label: t("pullCode") },
      { id: "fetch", label: t("fetchRemoteBranches"), groupEnd: true },
      { id: "commit", label: t("openCommitWindow") },
      { id: "push", label: t("pushCode"), groupEnd: true },
      { id: "newBranch", label: t("newBranch") },
      { id: "newWorktree", label: t("newWorktree") },
    ],
    [t]
  )

  const refresh = useCallback(() => {
    if (folderId) void refreshFolder(folderId)
  }, [folderId, refreshFolder])

  useEffect(() => {
    if (!folderId) return
    let unlisten: (() => void) | null = null
    subscribe<GitCommitSucceededEventPayload>(
      "folder://git-commit-succeeded",
      (payload) => {
        if (payload.folder_id !== folderId) return
        // Folder-scoped toast id: this component is mounted once per
        // conversation tile, and the changes tab raises the same toast locally
        // after a quick commit. Sharing one id makes sonner update a single
        // toast instead of stacking one per listener.
        toast.success(t("toasts.commitCodeCompleted"), {
          id: `git-commit-succeeded:${folderId}`,
          description: t("toasts.committedFiles", {
            count: payload.committed_files,
          }),
        })
        refresh()
      }
    )
      .then((fn) => {
        unlisten = fn
      })
      .catch((err) => {
        console.error("[BranchDropdown] failed to listen commit event:", err)
      })
    return () => {
      unlisten?.()
    }
  }, [folderId, refresh, t])

  useEffect(() => {
    if (!folderId) return
    let unlisten: (() => void) | null = null
    subscribe<GitPushSucceededEventPayload>(
      "folder://git-push-succeeded",
      (payload) => {
        if (payload.folder_id !== folderId) return
        const { pushed_commits, upstream_set } = payload
        let description: string
        if (upstream_set) {
          description =
            pushed_commits === 0
              ? t("toasts.upstreamSet")
              : t("toasts.upstreamSetAndPushed", { count: pushed_commits })
        } else if (pushed_commits === 0) {
          description = t("toasts.noCommitsToPush")
        } else {
          description = t("toasts.pushedCommits", { count: pushed_commits })
        }
        toast.success(t("toasts.pushCodeCompleted"), { description })
        refresh()
      }
    )
      .then((fn) => {
        unlisten = fn
      })
      .catch((err) => {
        console.error("[BranchDropdown] failed to listen push event:", err)
      })
    return () => {
      unlisten?.()
    }
  }, [folderId, refresh, t])

  const loadAllBranches = useCallback(async () => {
    if (!folderPath) return
    setBranchLoading(true)
    try {
      const list = await gitListAllBranches(folderPath)
      setBranchList(list)
    } catch {
      setBranchList({
        local: [],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    } finally {
      setBranchLoading(false)
    }
  }, [folderPath])

  function handleDropdownOpenChange(open: boolean) {
    setDropdownOpen(open)
    if (open && isRepo) {
      void loadAllBranches()
    }
  }

  async function handleCheckout(branchName: string) {
    if (!activeFolder) return
    setDropdownOpen(false)
    await switchToBranch({ activeFolder, branchName, currentBranch: branch })
  }

  async function handleCheckoutRemote(remoteBranch: string) {
    if (!activeFolder) return
    const localName = remoteBranch.replace(/^[^/]+\//, "")
    setDropdownOpen(false)
    await switchToBranch({
      activeFolder,
      branchName: localName,
      currentBranch: branch,
      isRemote: true,
    })
  }

  async function handleNewBranch() {
    const name = newBranchName.trim()
    if (!name) return
    setNewBranchOpen(false)
    setNewBranchName("")
    await runGitTask(t("tasks.newBranch", { name }), () =>
      gitNewBranch(folderPath, name)
    )
  }

  function handleOpenWorktreeDialog() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    let random = ""
    for (let i = 0; i < 6; i++) {
      random += chars[Math.floor(Math.random() * chars.length)]
    }
    // `folderPath` is a native OS path. Splitting it on "/" alone left every
    // Windows repo with no name and no parent — `lastIndexOf("/")` returns -1
    // there, so the prefilled worktree path came out as the bare relative
    // "/C:\work\repo-main-abc123" instead of a sibling directory.
    const folderName = fsBaseName(folderPath) || "project"
    const currentBranch = branch ?? "main"
    const defaultBranch = `cv-${currentBranch}-${random}`
    setWorktreeBranchName(defaultBranch)
    setWorktreePath(
      siblingFsPath(folderPath, `${folderName}-${currentBranch}-${random}`)
    )
    setWorktreeOpen(true)
  }

  async function handleNewWorktree() {
    const name = worktreeBranchName.trim()
    const wtPath = worktreePath.trim()
    if (!name || !wtPath) return
    setWorktreeOpen(false)
    await runGitTask(t("tasks.newWorktree", { name }), async () => {
      await gitWorktreeAdd(folderPath, name, wtPath)
      // Register the worktree as a folder parented to this repo (flattened to
      // the root), then open a draft conversation in it. Once child folders are
      // merged under their parent in the sidebar, a worktree with no
      // conversations would otherwise be unreachable; this also lands the new
      // session with its cwd set to the worktree directory (detail.path).
      const detail = await openWorktreeFolder(wtPath, folderId)
      // Return to the conversation workspace if a route (e.g. Automations)
      // was covering the content region, else the new tab opens unseen.
      openConversations()
      openNewConversationTab(detail.id, detail.path)
    })
  }

  async function handleConfirm() {
    if (!confirmAction) return
    const { type, branchName } = confirmAction
    setConfirmAction(null)

    switch (type) {
      case "merge":
        await runGitTask(
          t("tasks.mergeBranch", { branchName }),
          () => gitMerge(folderPath, branchName),
          (result) => {
            if (result.conflict?.has_conflicts) {
              reportConflict(result.conflict)
              return false
            }
            if (result.merged_commits === 0) {
              return t("toasts.mergeNoNewCommits", { branchName })
            }
            return t("toasts.mergedCommits", { count: result.merged_commits })
          }
        )
        break
      case "rebase":
        await runGitTask(
          t("tasks.rebaseTo", { branchName }),
          () => gitRebase(folderPath, branchName),
          (result) => {
            if (result.conflict?.has_conflicts) {
              reportConflict(result.conflict)
              return false
            }
            return undefined
          }
        )
        break
      case "delete":
        await runGitTask(
          t("tasks.deleteBranch", { branchName }),
          () => gitDeleteBranch(folderPath, branchName),
          undefined,
          (errorMsg) => {
            if (/not fully merged/i.test(errorMsg)) {
              setConfirmAction({ type: "forceDelete", branchName })
              return true
            }
            return false
          }
        )
        break
      case "forceDelete":
        await runGitTask(t("tasks.deleteBranch", { branchName }), () =>
          gitDeleteBranch(folderPath, branchName, true)
        )
        break
      // All four worktree removals are the same backend call under different
      // flags. Without --force it re-asks rather than failing, the same way
      // `delete` escalates to `forceDelete`.
      case "deleteWorktree":
      case "deleteWorktreeAndBranch":
      case "forceDeleteWorktree":
      case "forceDeleteWorktreeAndBranch": {
        const { withBranch, force } = WORKTREE_REMOVALS[type]
        await runGitTask(
          withBranch
            ? t("tasks.removeWorktreeAndBranch", { branchName })
            : t("tasks.removeWorktree", { branchName }),
          () =>
            gitRemoveWorktree(
              folderPath,
              branchName,
              folderId,
              withBranch,
              force
            ),
          undefined,
          (errorMsg) => {
            if (force || !FORCE_REQUIRED_RE.test(errorMsg)) return false
            setConfirmAction({
              type: withBranch
                ? "forceDeleteWorktreeAndBranch"
                : "forceDeleteWorktree",
              branchName,
            })
            return true
          }
        )
        break
      }
      case "deleteRemote": {
        const idx = branchName.indexOf("/")
        const remote = branchName.substring(0, idx)
        const rb = branchName.substring(idx + 1)
        await runGitTask(t("tasks.deleteRemoteBranch", { branchName }), () =>
          withCredentialRetry(
            (creds) => gitDeleteRemoteBranch(folderPath, remote, rb, creds),
            { folderPath }
          )
        )
        break
      }
    }
  }

  function getConfirmTitle() {
    if (!confirmAction) return ""
    switch (confirmAction.type) {
      case "merge":
        return t("confirm.mergeTitle")
      case "rebase":
        return t("confirm.rebaseTitle")
      case "delete":
        return t("confirm.deleteTitle")
      case "forceDelete":
        return t("confirm.forceDeleteTitle")
      case "deleteRemote":
        return t("confirm.deleteRemoteTitle")
      case "deleteWorktree":
        return t("confirm.deleteWorktreeTitle")
      case "forceDeleteWorktree":
        return t("confirm.forceDeleteWorktreeTitle")
      case "deleteWorktreeAndBranch":
        return t("confirm.deleteWorktreeAndBranchTitle")
      case "forceDeleteWorktreeAndBranch":
        return t("confirm.forceDeleteWorktreeAndBranchTitle")
    }
  }

  function getConfirmDescription() {
    if (!confirmAction) return ""
    switch (confirmAction.type) {
      case "merge":
        return t("confirm.mergeDescription", {
          branchName: confirmAction.branchName,
          currentBranch: branch ?? "-",
        })
      case "rebase":
        return t("confirm.rebaseDescription", {
          currentBranch: branch ?? "-",
          branchName: confirmAction.branchName,
        })
      case "delete":
        return t("confirm.deleteDescription", {
          branchName: confirmAction.branchName,
        })
      case "forceDelete":
        return t("confirm.forceDeleteDescription", {
          branchName: confirmAction.branchName,
        })
      case "deleteRemote":
        return t("confirm.deleteRemoteDescription", {
          branchName: confirmAction.branchName,
        })
      case "deleteWorktree":
        return t("confirm.deleteWorktreeDescription", {
          branchName: confirmAction.branchName,
        })
      case "forceDeleteWorktree":
        return t("confirm.forceDeleteWorktreeDescription", {
          branchName: confirmAction.branchName,
        })
      case "deleteWorktreeAndBranch":
        return t("confirm.deleteWorktreeAndBranchDescription", {
          branchName: confirmAction.branchName,
        })
      case "forceDeleteWorktreeAndBranch":
        return t("confirm.forceDeleteWorktreeAndBranchDescription", {
          branchName: confirmAction.branchName,
        })
    }
  }

  // Dispatch a top-of-list operation back to its handler. Every op closes the
  // popover (some then open a dialog/window).
  function runOperation(opId: string) {
    setDropdownOpen(false)
    switch (opId) {
      case "pull":
        handlePull()
        break
      case "fetch":
        fetchAll()
        break
      case "commit":
        openCommit()
        break
      case "push":
        openPush()
        break
      case "newBranch":
        setNewBranchName("")
        setNewBranchOpen(true)
        break
      case "newWorktree":
        handleOpenWorktreeDialog()
        break
    }
  }

  // Dispatch an inline branch action: switch checks out directly (that handler
  // closes the popover itself), update runs straight away (it never touches the
  // working tree), the rest open the shared confirm dialog.
  function runLeafAction(
    action: BranchLeafAction,
    fullName: string,
    isRemote: boolean
  ) {
    if (action === "switch") {
      if (isRemote) void handleCheckoutRemote(fullName)
      else void handleCheckout(fullName)
      return
    }
    setDropdownOpen(false)
    if (action === "pull") {
      updateBranch(fullName, isRemote)
      return
    }
    // Push opens the push window preselected for this branch, so the commits
    // about to be published are reviewable before anything leaves the machine.
    if (action === "push") {
      openPush(fullName)
      return
    }
    setConfirmAction({ type: action, branchName: fullName })
  }

  // Folderless chat conversations have no git branch — hide the branch chip
  // entirely (the below-composer row still shows the folder chip beside it).
  if (!activeFolder || isChatMode) return null

  if (!isRepo) {
    // Non-git folder: no branch and nothing to pull, so a single chip (no split
    // pull half) opening a one-item popover that offers to init a repo.
    return (
      <Popover open={dropdownOpen} onOpenChange={handleDropdownOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t("noBranch")}
            className="flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <GitFork className="size-3 shrink-0" />
            <span className="max-w-[10rem] truncate">{t("noBranch")}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-64 p-1">
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setDropdownOpen(false)
              void runGitTask(t("tasks.initGitRepo"), () => gitInit(folderPath))
            }}
            className="flex w-full select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <GitBranch className="size-3.5 shrink-0" />
            {t("initGitRepo")}
          </button>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      {/* Single chip: the branch name + chevron opens the searchable popup (pull
          lives inside it now). Matches the sibling folder chip's ghost xs feel. */}
      <Popover open={dropdownOpen} onOpenChange={handleDropdownOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            title={
              isDetached
                ? t("detachedHead", { sha: head?.short_sha ?? "" })
                : (branch ?? undefined)
            }
            className="min-w-0 gap-0.5 px-1.5"
          >
            {isDetached ? (
              <GitCommitHorizontal className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <GitBranch className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="max-w-[10rem] truncate">
              {branch ?? head?.branch ?? head?.short_sha ?? t("noBranch")}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
          </Button>
        </PopoverTrigger>
        {/* No `overflow-hidden`: the list's inner shell clips to the rounding so
            the right-side action bubble can overflow past this edge.
            `max-h-(--radix-popover-content-available-height)` is the vertical twin
            of the `max-w` guard: the trigger sits in the status bar, so the popup
            opens upward and its own cap (`MAX_LIST_HEIGHT_REM`, 30rem) is a rem —
            at 250% zoom that is 1200px, taller than the space above the trigger,
            and the top of the list ran off the window. Radix publishes the room it
            actually has on that side; the list below is flex-shrinkable so it
            gives way to this cap instead of overflowing it. */}
        <PopoverContent
          ref={contentRef}
          side="top"
          align="start"
          onPointerDownOutside={onPointerDownOutside}
          onFocusOutside={onFocusOutside}
          className="max-h-(--radix-popover-content-available-height) w-[22rem] max-w-[calc(100vw-1rem)] p-0"
        >
          <BranchSelectorList
            operations={operations}
            worktreeNodes={worktreeNodes}
            localNodes={localNodes}
            remoteSections={remoteSections}
            localCount={branchList.local.length}
            remoteCount={branchList.remote.length}
            branch={branch}
            worktreeBranchSet={worktreeBranchSet}
            mainWorktreeBranch={branchList.main_worktree_branch}
            branchLoading={branchLoading}
            loading={loading}
            onRunOperation={runOperation}
            onLeafAction={runLeafAction}
          />
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{getConfirmTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              {getConfirmDescription()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={
                confirmAction && DESTRUCTIVE_CONFIRMS.has(confirmAction.type)
                  ? "destructive"
                  : "default"
              }
              onClick={handleConfirm}
            >
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogs.newBranchTitle")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.newBranchDescription", { branch: branch ?? "-" })}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t("dialogs.branchNamePlaceholder")}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            {...ime.props}
            onKeyDown={(e) => {
              if (ime.isComposing(e)) return
              if (e.key === "Enter") handleNewBranch()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewBranchOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={!newBranchName.trim() || loading}
              onClick={handleNewBranch}
            >
              {tCommon("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={worktreeOpen} onOpenChange={setWorktreeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogs.newWorktreeTitle")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.newWorktreeDescription", { branch: branch ?? "-" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="wt-branch">{t("dialogs.branchNameLabel")}</Label>
              <Input
                id="wt-branch"
                placeholder={t("dialogs.branchNamePlaceholder")}
                value={worktreeBranchName}
                onChange={(e) => setWorktreeBranchName(e.target.value)}
                {...ime.props}
                onKeyDown={(e) => {
                  if (ime.isComposing(e)) return
                  if (e.key === "Enter") handleNewWorktree()
                }}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wt-path">{t("dialogs.worktreePathLabel")}</Label>
              <DirectoryPathInput
                id="wt-path"
                placeholder={t("dialogs.worktreePathPlaceholder")}
                value={worktreePath}
                onValueChange={setWorktreePath}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorktreeOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={
                !worktreeBranchName.trim() || !worktreePath.trim() || loading
              }
              onClick={handleNewWorktree}
            >
              {tCommon("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {gitDialogs}
    </>
  )
}
