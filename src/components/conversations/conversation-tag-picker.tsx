"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { Check, Plus, Settings2, Tags } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { changeConversationTags } from "@/lib/conversation-tag-assignment"
import {
  MAX_TAG_NAME_LENGTH,
  compareTags,
  findTagByName,
  pickNextTagColor,
  tagScopeFolderId,
} from "@/lib/conversation-tags"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import type { ConversationTagDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { useBranchChip, useResolvedTags } from "@/hooks/use-conversation-tags"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  ConversationBranchChip,
  ConversationTagChip,
  ConversationTagChips,
} from "./conversation-tag-chip"
import {
  ConversationTagFormDialog,
  type TagFormValues,
} from "./conversation-tag-form-dialog"
import { openConversationTagsManager } from "./conversation-tags-manager"

const NO_IDS: readonly number[] = []

/**
 * Which tags a conversation in `folderId` may carry, split the way every
 * picker lists them: global ones, its folder's own, and — only so they can be
 * taken off — any it already carries from elsewhere (a conversation that moved
 * folders keeps its links).
 */
export function useTagChoices(
  folderId: number,
  assignedIds: readonly number[] | undefined
) {
  const tags = useConversationTagsStore((s) => s.tags)
  const folder = useAppWorkspaceStore((s) =>
    s.allFolders.find((f) => f.id === folderId)
  )
  const scope = tagScopeFolderId(folder)
  const scopeFolder = useAppWorkspaceStore((s) =>
    scope == null ? undefined : s.allFolders.find((f) => f.id === scope)
  )
  const assigned = assignedIds ?? NO_IDS
  return useMemo(() => {
    const global: ConversationTagDetail[] = []
    const own: ConversationTagDetail[] = []
    const foreign: ConversationTagDetail[] = []
    for (const tag of tags) {
      if (tag.folder_id === null) global.push(tag)
      else if (tag.folder_id === scope) own.push(tag)
      else if (assigned.includes(tag.id)) foreign.push(tag)
    }
    foreign.sort(compareTags)
    return {
      scope,
      scopeLabel: scopeFolder
        ? formatFolderLabelWithAlias(scopeFolder)
        : scope != null
          ? `#${scope}`
          : null,
      global,
      own,
      foreign,
      assignedSet: new Set(assigned),
      allTags: tags,
    }
  }, [tags, scope, scopeFolder, assigned])
}

/** Report a failed tag change, in the backend's words when it gave a reason. */
function useTagErrorToast() {
  const t = useTranslations("ConversationTags")
  return useCallback(
    (title: "toasts.assignFailed" | "toasts.createFailed", err: unknown) => {
      toast.error(t(title), {
        description: toLocalizedErrorMessage(
          err,
          t as unknown as AppErrorTranslator
        ),
      })
    },
    [t]
  )
}

/** Toggle one tag on a conversation, with the failure said out loud. */
function useToggleTag(conversationId: number) {
  const reportError = useTagErrorToast()
  return useCallback(
    (tagId: number, on: boolean) => {
      changeConversationTags(
        conversationId,
        on ? { add: [tagId] } : { remove: [tagId] }
      ).catch((err) => reportError("toasts.assignFailed", err))
    },
    [conversationId, reportError]
  )
}

/**
 * Create a tag and put it on the conversation — what "create" means from a
 * conversation. Resolves once the TAG exists (a creation failure rejects, for
 * the caller to report); putting it on runs on afterwards and reports its own
 * failure, so a tag that was created is never presented as "not created".
 */
async function createAndAssign(
  conversationId: number,
  values: TagFormValues,
  onAssignError: (err: unknown) => void
): Promise<void> {
  const tag = await useConversationTagsStore.getState().createTag({
    folderId: values.folderId,
    name: values.name,
    color: values.color,
  })
  changeConversationTags(conversationId, { add: [tag.id] }).catch(onAssignError)
}

function TagCheckRow({
  tag,
  checked,
}: {
  tag: ConversationTagDetail
  checked: boolean
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[0.3125rem] border",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input"
        )}
      >
        {checked ? <Check className="size-3!" /> : null}
      </span>
      <ConversationTagChip tag={tag} className="max-w-[12rem]" />
    </>
  )
}

/**
 * The searchable tag list for one conversation: tick to put a tag on or take
 * it off (the list stays open — tagging is usually several picks), type to
 * narrow it, and when what you typed is not a tag yet, create it right there
 * — globally, or as this folder's own.
 */
function ConversationTagPickerPanel({
  conversationId,
  folderId,
  assignedIds,
  onManage,
}: {
  conversationId: number
  folderId: number
  assignedIds: readonly number[] | undefined
  /** "Manage tags…": the caller closes its popover and opens the manager. */
  onManage: () => void
}) {
  const t = useTranslations("ConversationTags")
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const choices = useTagChoices(folderId, assignedIds)
  const toggle = useToggleTag(conversationId)
  const reportError = useTagErrorToast()

  const q = query.trim()
  const needle = q.toLowerCase()
  const match = (tag: ConversationTagDetail) =>
    !needle || tag.name.toLowerCase().includes(needle)
  const global = choices.global.filter(match)
  const own = choices.own.filter(match)
  const foreign = choices.foreign.filter(match)

  const canCreateGlobal =
    q !== "" && !findTagByName(choices.allTags, null, q) && !creating
  const canCreateOwn =
    q !== "" &&
    choices.scope != null &&
    !findTagByName(choices.allTags, choices.scope, q) &&
    !creating
  const nothing =
    global.length === 0 &&
    own.length === 0 &&
    foreign.length === 0 &&
    !canCreateGlobal &&
    !canCreateOwn

  const create = (folderScope: number | null) => {
    setCreating(true)
    createAndAssign(
      conversationId,
      {
        name: q,
        // Distinct from every tag this conversation could show beside it.
        color: pickNextTagColor([...choices.global, ...choices.own]),
        folderId: folderScope,
      },
      (err) => reportError("toasts.assignFailed", err)
    )
      .then(() => setQuery(""))
      .catch((err) => reportError("toasts.createFailed", err))
      .finally(() => setCreating(false))
  }

  const renderTag = (tag: ConversationTagDetail) => {
    const checked = choices.assignedSet.has(tag.id)
    return (
      <CommandItem
        key={tag.id}
        value={`tag-${tag.id}`}
        onSelect={() => toggle(tag.id, !checked)}
        data-checked={checked || undefined}
      >
        <TagCheckRow tag={tag} checked={checked} />
      </CommandItem>
    )
  }

  return (
    <Command className="rounded-2xl" shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("picker.searchPlaceholder")}
        maxLength={MAX_TAG_NAME_LENGTH}
      />
      <CommandList>
        {nothing ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {q ? t("picker.noResults") : t("picker.empty")}
          </div>
        ) : null}
        {global.length > 0 ? (
          <CommandGroup heading={t("global")}>
            {global.map(renderTag)}
          </CommandGroup>
        ) : null}
        {own.length > 0 ? (
          <CommandGroup heading={choices.scopeLabel ?? undefined}>
            {own.map(renderTag)}
          </CommandGroup>
        ) : null}
        {foreign.length > 0 ? (
          <CommandGroup heading={t("picker.otherFolders")}>
            {foreign.map(renderTag)}
          </CommandGroup>
        ) : null}
        {canCreateGlobal || canCreateOwn ? (
          <>
            {global.length + own.length + foreign.length > 0 ? (
              <CommandSeparator />
            ) : null}
            <CommandGroup>
              {canCreateGlobal ? (
                <CommandItem
                  value="__create_global__"
                  onSelect={() => create(null)}
                >
                  <Plus className="text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    {t("picker.createGlobal", { name: q })}
                  </span>
                </CommandItem>
              ) : null}
              {canCreateOwn && choices.scope != null ? (
                <CommandItem
                  value="__create_own__"
                  onSelect={() => create(choices.scope)}
                >
                  <Plus className="text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    {t("picker.createInFolder", {
                      name: q,
                      folder: choices.scopeLabel ?? "",
                    })}
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
      <div className="border-t p-1">
        <button
          type="button"
          onClick={onManage}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
        >
          <Settings2 className="size-4 shrink-0" />
          {t("manageTags")}
        </button>
      </div>
    </Command>
  )
}

/**
 * The conversation header's tag slot: the conversation's tags as chips (up to
 * `max`, then "+N"), or a quiet tag icon when it has none — either way the
 * trigger for the picker. The branch chip, when shown, comes first and counts
 * toward `max`, but sits outside the trigger: the picker does not edit it.
 */
export const ConversationHeaderTags = memo(function ConversationHeaderTags({
  conversationId,
  folderId,
  tagIds,
  gitBranch,
  max,
}: {
  conversationId: number
  folderId: number
  tagIds: readonly number[] | undefined
  gitBranch: string | null
  max: number
}) {
  const t = useTranslations("ConversationTags")
  const [open, setOpen] = useState(false)
  const tags = useResolvedTags(tagIds)
  const branch = useBranchChip(gitBranch)
  const label = tags.length > 0 ? t("editTags") : t("addTags")

  return (
    <>
      {/* Wider than a tag chip: a branch name is routinely long, and the
          header has the room (its slot is capped at half the row anyway). */}
      {branch ? (
        <ConversationBranchChip
          branch={branch}
          className="mr-0.5 max-w-[12rem]"
        />
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={
              tags.length > 0
                ? `${label}: ${tags.map((tag) => tag.name).join(", ")}`
                : label
            }
            className={cn(
              "flex h-7 min-w-0 shrink items-center rounded-md outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              tags.length > 0
                ? "px-1 hover:bg-accent/60"
                : "w-7 shrink-0 justify-center text-muted-foreground/60 hover:text-foreground"
            )}
          >
            {tags.length > 0 ? (
              <ConversationTagChips tags={tags} max={branch ? max - 1 : max} />
            ) : (
              <Tags className="size-4" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 overflow-hidden p-0">
          <ConversationTagPickerPanel
            conversationId={conversationId}
            folderId={folderId}
            assignedIds={tagIds}
            onManage={() => {
              setOpen(false)
              openConversationTagsManager({ folderId })
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  )
})

/**
 * "Tags" in a conversation's right-click menu: every tag the conversation may
 * carry, ticked if it does (picking one toggles it and keeps the menu open, so
 * several can be set in one visit), then "New tag…" and "Manage tags…".
 *
 * The new-tag dialog belongs to the caller: a context menu unmounts its
 * content on close, which would take a dialog rendered in here with it.
 */
export function ConversationTagContextSubmenu({
  conversationId,
  folderId,
  tagIds,
  onNewTag,
}: {
  conversationId: number
  folderId: number
  tagIds: readonly number[] | undefined
  onNewTag: () => void
}) {
  const t = useTranslations("ConversationTags")
  const choices = useTagChoices(folderId, tagIds)
  const toggle = useToggleTag(conversationId)

  const renderTag = (tag: ConversationTagDetail) => {
    const checked = choices.assignedSet.has(tag.id)
    return (
      <ContextMenuItem
        key={tag.id}
        // Keep the menu open: tagging is usually more than one pick.
        onSelect={(event) => {
          event.preventDefault()
          toggle(tag.id, !checked)
        }}
        className="gap-2"
      >
        <TagCheckRow tag={tag} checked={checked} />
      </ContextMenuItem>
    )
  }

  const sections = [
    { key: "global", label: t("global"), tags: choices.global },
    { key: "own", label: choices.scopeLabel, tags: choices.own },
    { key: "foreign", label: t("picker.otherFolders"), tags: choices.foreign },
  ].filter((section) => section.tags.length > 0)

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Tags className="h-4 w-4" />
        {t("tags")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-[min(24rem,var(--radix-context-menu-content-available-height))] min-w-[12rem] overflow-y-auto">
        {sections.length === 0 ? (
          <ContextMenuItem disabled className="text-muted-foreground">
            {t("noTagsYet")}
          </ContextMenuItem>
        ) : (
          sections.map((section, idx) => (
            <div
              key={section.key}
              role="group"
              aria-label={section.label ?? undefined}
            >
              {idx > 0 ? <ContextMenuSeparator /> : null}
              {/* A heading only once there is more than one section to tell
                  apart — a lone global list needs no "Global" over it. */}
              {sections.length > 1 && section.label ? (
                <div className="truncate px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                  {section.label}
                </div>
              ) : null}
              {section.tags.map(renderTag)}
            </div>
          ))
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onNewTag}>
          <Plus className="h-4 w-4" />
          {t("newTag")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => openConversationTagsManager({ folderId })}
        >
          <Settings2 className="h-4 w-4" />
          {t("manageTags")}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}

/**
 * The "New tag…" dialog opened from a conversation: offers the conversation's
 * folder as the tag's scope when it has one, and puts the new tag on the
 * conversation once created.
 */
export function NewConversationTagDialog({
  open,
  onOpenChange,
  conversationId,
  folderId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: number
  folderId: number
}) {
  const choices = useTagChoices(folderId, NO_IDS)
  const reportError = useTagErrorToast()
  const initialColor = pickNextTagColor([...choices.global, ...choices.own])
  return (
    <ConversationTagFormDialog
      open={open}
      onOpenChange={onOpenChange}
      mode="create"
      initial={{ name: "", color: initialColor, folderId: null }}
      folderOption={
        choices.scope != null && choices.scopeLabel
          ? { id: choices.scope, label: choices.scopeLabel }
          : null
      }
      onSubmit={async (values) => {
        await createAndAssign(conversationId, values, (err) =>
          reportError("toasts.assignFailed", err)
        )
        onOpenChange(false)
      }}
    />
  )
}
