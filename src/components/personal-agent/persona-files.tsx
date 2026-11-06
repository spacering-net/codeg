"use client"

/**
 * The personal agent's persona and memory files, in the settings dialog: a
 * list on one side, the file open on the other. On top the files that say
 * who it is — its persona and rules, the owner's to write — and what it
 * knows about the owner; then its memory, an index the agent keeps, one line
 * per entry, with the entries it lists under it — facts, references and the
 * lessons about its own way of working, by the `type` in their frontmatter,
 * the lessons first. A line under the file's name says who writes it and
 * how much of it the agent starts each session with. Each file is saved on
 * its own; an entry can be deleted, its index line with it.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  BookOpen,
  FileText,
  Loader2,
  ScrollText,
  UserRound,
  type LucideIcon,
} from "lucide-react"

import { SettingNote } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  personalAgentFileDelete,
  personalAgentFileSave,
  personalAgentFiles,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentFile } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A fixed file: its group in the list, its icon, who writes it. */
interface FixedFile {
  name: string
  group: "persona" | "rules" | "owner" | "memory"
  icon: LucideIcon
  /** It is the index of the entries. */
  index?: true
}

export const FIXED_FILES: readonly FixedFile[] = [
  { name: "SOUL.md", group: "persona", icon: ScrollText },
  { name: "AGENTS.md", group: "rules", icon: FileText },
  { name: "USER.md", group: "owner", icon: UserRound },
  { name: "MEMORY.md", group: "memory", icon: BookOpen, index: true },
]

/** The index the entries are listed in, and their folder. */
const INDEX_FILE = "MEMORY.md"
const ENTRY_FOLDER = "memory/"

/** The kinds of entry, in the order the list shows them: the lessons about
 *  the agent's own way of working first. */
export const ENTRY_TYPES = ["lesson", "fact", "reference"] as const
export type EntryType = (typeof ENTRY_TYPES)[number]

/** The fields of an entry's frontmatter, if it has one. */
function frontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim()
  }
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * What the list calls an entry, the line under it and its kind: the title
 * its index line links it by (`- [Release days](memory/release-days.md) —
 * …`), else its frontmatter `name`, its first heading, or its file name; its
 * frontmatter `description`; and its frontmatter `type`, when it is one of
 * the kinds (in any case).
 */
export function entryMeta(
  path: string,
  content: string,
  index: string
): { title: string; description: string | null; type: EntryType | null } {
  const link = new RegExp(
    `\\[([^\\]\\n]+)\\]\\((?:\\./)?${escapeRegExp(path)}\\)`
  ).exec(index)
  const fm = frontmatter(content)
  const heading = content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim()
  const file = path.slice(path.indexOf("/") + 1).replace(/\.md$/, "")
  const type = fm.type?.toLowerCase()
  return {
    title: link?.[1]?.trim() || fm.name || heading || file,
    description: fm.description || null,
    type: ENTRY_TYPES.find((k) => k === type) ?? null,
  }
}

/** Where an entry of `type` goes in the list: by kind, an untyped one last. */
function typeRank(type: EntryType | null): number {
  return type == null ? ENTRY_TYPES.length : ENTRY_TYPES.indexOf(type)
}

/** An index without the lines that link to `entry` — what the server takes
 *  out of the file when the entry is deleted (`[…](memory/x.md)`, also as
 *  `./memory/x.md`). */
export function withoutEntryLine(index: string, entry: string): string {
  const link = `${entry})`
  return index
    .split("\n")
    .filter((line) => !line.includes(link))
    .join("\n")
}

export function PersonaFiles() {
  const t = useTranslations("PersonalAgent.settings")
  const [files, setFiles] = useState<PersonalAgentFile[] | null>(null)
  const [active, setActive] = useState("SOUL.md")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    let cancelled = false
    personalAgentFiles()
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        setDrafts(Object.fromEntries(list.map((f) => [f.name, f.content])))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])
  // The entries, titled by the index's (saved) lines: by kind, then title.
  const entries = useMemo(() => {
    if (!files) return []
    const index = files.find((f) => f.name === INDEX_FILE)?.content ?? ""
    return files
      .filter((f) => f.name.startsWith(ENTRY_FOLDER))
      .map((f) => ({ name: f.name, ...entryMeta(f.name, f.content, index) }))
      .sort(
        (a, b) =>
          typeRank(a.type) - typeRank(b.type) || a.title.localeCompare(b.title)
      )
  }, [files])
  // Another file drops a delete that was waiting to be confirmed.
  const pick = (name: string) => {
    setActive(name)
    setConfirming(false)
  }
  if (!files) {
    return (
      <Loader2 className="mx-auto my-8 size-4 animate-spin text-muted-foreground" />
    )
  }
  const current = files.find((f) => f.name === active) ?? null
  const fixed = FIXED_FILES.find((f) => f.name === active) ?? null
  const isEntry = current != null && fixed == null
  const entry = isEntry ? entries.find((e) => e.name === active) : undefined
  const dirty = current != null && drafts[active] !== current.content
  const isDirty = (name: string) => {
    const f = files.find((x) => x.name === name)
    return f != null && drafts[name] !== f.content
  }

  const save = () => {
    if (!current) return
    const content = drafts[active] ?? ""
    setSaving(true)
    personalAgentFileSave(active, content)
      .then(() => {
        setFiles((list) =>
          (list ?? []).map((f) =>
            f.name === active ? { ...f, content, exists: true } : f
          )
        )
        toast.message(t("fileSaved", { name: active }))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setSaving(false))
  }

  const remove = () => {
    if (!isEntry) return
    const name = active
    setSaving(true)
    personalAgentFileDelete(name)
      .then(() => personalAgentFiles())
      .then((list) => {
        // Take the files as they are now, keeping what is still being
        // written in any of them. The index lost the entry's line on disk:
        // an edit of it in progress loses that line too, and nothing else.
        setFiles(list)
        setDrafts((d) => {
          const next: Record<string, string> = {}
          for (const f of list) {
            const was = files.find((x) => x.name === f.name)
            const editing = was != null && d[f.name] !== was.content
            next[f.name] = !editing
              ? f.content
              : f.name === INDEX_FILE
                ? withoutEntryLine(d[f.name], name)
                : d[f.name]
          }
          return next
        })
        pick(INDEX_FILE)
        toast.message(t("entryDeleted", { name }))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setSaving(false))
  }

  const hint = (() => {
    if (isEntry) return t("entryHint")
    switch (fixed?.group) {
      case "persona":
        return t("soulHint")
      case "rules":
        return t("rulesHint")
      case "owner":
        return t("userHint")
      case "memory":
        return t("memoryHint")
      default:
        return null
    }
  })()
  const writer =
    fixed?.group === "persona" || fixed?.group === "rules"
      ? t("byOwner")
      : t("byAgent")

  return (
    <div className="flex flex-col gap-3">
      <SettingNote icon={FileText}>{t("filesNote")}</SettingNote>
      <div className="flex min-h-[24rem] flex-col gap-3 sm:flex-row">
        {/* The list: on a phone, a short scrolled strip over the file. */}
        <nav
          aria-label={t("tabPersona")}
          className="field-scrollbar flex max-h-44 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-xl bg-muted/40 p-1.5 sm:max-h-[28rem] sm:w-44"
        >
          {FIXED_FILES.map((f) => {
            const Icon = f.icon
            const list = f.index ? entries : null
            return (
              <div key={f.name} className="flex flex-col gap-0.5">
                <FileButton
                  selected={active === f.name}
                  dirty={isDirty(f.name)}
                  onClick={() => pick(f.name)}
                  icon={<Icon className="size-3.5 shrink-0" aria-hidden />}
                  label={t(`fileGroups.${f.group}`)}
                  count={list ? list.length : undefined}
                  title={f.name}
                />
                {list && list.length > 0 ? (
                  <div className="ms-3.5 flex flex-col gap-0.5 border-s border-border/70 ps-1.5">
                    {list.map((e) => (
                      <FileButton
                        key={e.name}
                        selected={active === e.name}
                        dirty={isDirty(e.name)}
                        onClick={() => pick(e.name)}
                        label={e.title}
                        tag={e.type ? t(`entryType.${e.type}`) : undefined}
                        title={e.description ?? e.name}
                        entry
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {isEntry
                  ? (entry?.title ?? active)
                  : fixed
                    ? t(`fileGroups.${fixed.group}`)
                    : active}
              </span>
              <span className="shrink-0 truncate font-mono text-[0.6875rem] text-muted-foreground">
                {active}
              </span>
              {fixed || entry?.type ? (
                <span className="ms-auto shrink-0 rounded-full bg-foreground/[0.06] px-2 text-[0.6875rem] leading-5 text-muted-foreground">
                  {fixed ? writer : t(`entryType.${entry!.type!}`)}
                </span>
              ) : null}
            </div>
            {hint ? (
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {hint}
              </p>
            ) : null}
          </div>
          <Textarea
            dir="auto"
            aria-label={active}
            value={drafts[active] ?? ""}
            onChange={(e) =>
              setDrafts((d) => ({ ...d, [active]: e.target.value }))
            }
            className="field-scrollbar min-h-64 flex-1 bg-background font-mono text-xs"
          />
          <div className="flex items-center justify-end gap-2">
            {isEntry ? (
              confirming ? (
                <>
                  <span className="me-auto text-xs text-muted-foreground">
                    {t("confirmDeleteHint")}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setConfirming(false)}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={saving}
                    onClick={remove}
                  >
                    {t("confirmDelete")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="me-auto text-muted-foreground hover:text-destructive"
                  disabled={saving}
                  onClick={() => setConfirming(true)}
                >
                  {t("deleteEntry")}
                </Button>
              )
            ) : null}
            {confirming ? null : (
              <Button
                type="button"
                size="sm"
                disabled={!dirty || saving}
                onClick={save}
              >
                {saving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : null}
                {t("saveFile")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function FileButton({
  selected,
  dirty,
  onClick,
  icon,
  label,
  count,
  tag,
  title,
  entry = false,
}: {
  selected: boolean
  dirty: boolean
  onClick: () => void
  icon?: React.ReactNode
  label: string
  count?: number
  /** An entry's kind, at the end of its row. */
  tag?: string
  title?: string
  entry?: boolean
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        entry ? "text-xs" : "text-[0.8125rem]",
        selected
          ? "bg-background font-medium text-foreground shadow-xs"
          : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dirty ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      {count != null && count > 0 ? (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70 tabular-nums">
          {count}
        </span>
      ) : null}
      {/* The kind is said again, as text, over the open entry: the row's
          name stays its title. */}
      {tag ? (
        <span
          aria-hidden
          className="shrink-0 text-[0.625rem] text-muted-foreground/70"
        >
          {tag}
        </span>
      ) : null}
    </button>
  )
}
