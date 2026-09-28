"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, GitBranch, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { gitListAllBranches } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { GitBranchList } from "@/lib/types"

interface BranchPickerProps {
  /** Folder whose branches are listed; null disables the picker. */
  folderPath: string | null
  /** Currently selected branch name ("" = the caller's own default). */
  value: string
  /** `isRemote` is true only when the pick came from the remote group, so the
   *  caller can record it as a remote branch (the name itself is the stripped
   *  leaf either way). */
  onChange: (branch: string, isRemote: boolean) => void
  /** Trigger label while nothing is picked. */
  placeholder: string
  /** The list's "no branch chosen" entry. What that means is the caller's
   *  (an automation falls back to the folder's default branch, a task to the
   *  project folder's checkout), so the wording comes from the caller too. */
  defaultLabel: string
  /** Native tooltip / accessible name of the trigger. */
  title?: string
  disabled?: boolean
  /** When false the remote-branch group is hidden. Used wherever a remote-only
   *  branch cannot be the answer — shared_in_root isolation can't check one out
   *  in the root tree (the backend rejects the combination), and a task's base
   *  branch has to be a local branch the merge can land onto — so offering one
   *  would only let the user build a config that fails later. */
  allowRemote?: boolean
}

const EMPTY_LIST: GitBranchList = {
  local: [],
  remote: [],
  worktree_branches: [],
  main_worktree_branch: null,
}

/** Strip the remote prefix (`origin/main` → `main`) so a remote pick stores a
 *  plain branch name — matching the conversation picker's checkout semantics and
 *  the old free-form input that only ever held local names. */
function stripRemote(branch: string): string {
  return branch.replace(/^[^/]+\//, "")
}

/**
 * A select-only branch dropdown, styled after the conversation composer's
 * branch picker but with no checkout side effect — it only sets a branch
 * string. Lists local + remote branches for the chosen folder, offers a reset
 * to the caller's default, and a free-form fallback so a not-yet-created
 * branch name can still be entered (preserving the old text input's
 * flexibility).
 */
export function BranchPicker({
  folderPath,
  value,
  onChange,
  placeholder,
  defaultLabel,
  title,
  disabled,
  allowRemote = true,
}: BranchPickerProps) {
  const t = useTranslations("BranchPicker")
  const [open, setOpen] = useState(false)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const reqRef = useRef(0)

  const loadBranches = useCallback(async () => {
    if (!folderPath) {
      setBranchList(EMPTY_LIST)
      return
    }
    const id = ++reqRef.current
    setLoading(true)
    try {
      const list = await gitListAllBranches(folderPath)
      if (id === reqRef.current) setBranchList(list)
    } catch {
      if (id === reqRef.current) setBranchList(EMPTY_LIST)
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [folderPath])

  useEffect(() => {
    if (open) void loadBranches()
  }, [open, loadBranches])

  // Drop the cached list when the folder changes so the next open refetches.
  useEffect(() => {
    setBranchList(null)
    setQuery("")
  }, [folderPath])

  // Clear the (controlled) search on every close — mirrors the conversation
  // picker; onSelect closes via setOpen(false) without firing onOpenChange, so
  // reset off the open transition at render time rather than in an effect.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setQuery("")
  }

  const select = (branch: string, isRemote: boolean) => {
    onChange(branch, isRemote)
    setOpen(false)
  }

  const local = branchList?.local ?? []
  const remote = allowRemote ? (branchList?.remote ?? []) : []
  const q = query.trim()
  // Derive from branchList (stable) rather than the per-render `local`/`remote`
  // arrays so the memo doesn't recompute every render.
  const known = useMemo(
    () =>
      new Set([
        ...(branchList?.local ?? []),
        ...(branchList?.remote ?? []).map(stripRemote),
      ]),
    [branchList]
  )
  const showUseCustom = q.length > 0 && !known.has(q)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!disabled) setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          title={title}
          aria-label={title}
          className="h-7 max-w-[16rem] gap-1.5 text-xs font-normal"
        >
          <GitBranch
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            className={cn(
              "min-w-0 truncate",
              !value && "text-muted-foreground"
            )}
          >
            {value || placeholder}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground/60"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-0">
        <Command className="rounded-2xl">
          <CommandInput
            placeholder={t("searchPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center">
                <Loader2
                  className="mx-auto size-3.5 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            ) : (
              <>
                <CommandEmpty>{t("none")}</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="__default__"
                    onSelect={() => select("", false)}
                  >
                    <GitBranch
                      className="size-4 shrink-0 opacity-60"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {defaultLabel}
                    </span>
                    {!value ? (
                      <Check className="size-4 shrink-0" aria-hidden="true" />
                    ) : null}
                  </CommandItem>
                </CommandGroup>
                {showUseCustom ? (
                  <CommandGroup>
                    <CommandItem
                      value={`use ${q}`}
                      onSelect={() => select(q, false)}
                    >
                      <GitBranch
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {t("useCustom", { query: q })}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {local.length > 0 ? (
                  <CommandGroup heading={t("local")}>
                    {local.map((b) => (
                      <CommandItem
                        key={`local-${b}`}
                        value={`local ${b}`}
                        onSelect={() => select(b, false)}
                      >
                        <GitBranch
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{b}</span>
                        {b === value ? (
                          <Check
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {remote.length > 0 ? (
                  <CommandGroup heading={t("remote")}>
                    {remote.map((b) => {
                      const name = stripRemote(b)
                      return (
                        <CommandItem
                          key={`remote-${b}`}
                          value={`remote ${b}`}
                          onSelect={() => select(name, true)}
                        >
                          <GitBranch
                            className="size-4 shrink-0 opacity-60"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {b}
                          </span>
                          {name === value ? (
                            <Check
                              className="size-4 shrink-0"
                              aria-hidden="true"
                            />
                          ) : null}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
