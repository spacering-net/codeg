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
 * its own; an entry can be deleted, its index line with it. Last, its process
 * skills (7.8), the ways of doing things it wrote down: each can be edited —
 * what the owner writes is installed as written — turned off and on, or
 * deleted.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  BookOpen,
  FileText,
  ScrollText,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  personalAgentFileDelete,
  personalAgentFileSave,
  personalAgentFiles,
  personalAgentSkillSwitch,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentFile } from "@/lib/types"
import { cn } from "@/lib/utils"
import { reloadRoster } from "@/stores/personal-agent-roster-store"

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
/** Where the process skills are, `process-skills/<name>/SKILL.md` (7.8). */
const SKILL_FOLDER = "process-skills/"

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

/** What the list calls a process skill and when it is for: its first
 *  heading (else its front matter's `name`, else its folder) and its front
 *  matter's `description`. */
export function skillMeta(
  path: string,
  content: string
): { title: string; description: string | null } {
  const fm = frontmatter(content)
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const folder = path.slice(SKILL_FOLDER.length).split("/")[0] ?? path
  return {
    title: heading || fm.name || folder,
    description: fm.description || null,
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

export function PersonaFiles({
  botId: forBot,
  initial = null,
}: {
  /** Whose files: left out, the page's own assistant's. */
  botId?: number | null
  /** The file to open on — a memory entry a card or a reply names (7.7);
   *  one that is not there opens the persona. */
  initial?: string | null
} = {}) {
  const t = useTranslations("PersonalAgent.settings")
  const [files, setFiles] = useState<PersonalAgentFile[] | null>(null)
  const [active, setActive] = useState(initial ?? "SOUL.md")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const pageBot = useBotId()
  const botId = forBot ?? pageBot
  useEffect(() => {
    let cancelled = false
    personalAgentFiles(botId)
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        setDrafts(Object.fromEntries(list.map((f) => [f.name, f.content])))
        setActive((a) => (list.some((f) => f.name === a) ? a : "SOUL.md"))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [botId])
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
  // The process skills, by name (their folders').
  const skills = useMemo(
    () =>
      (files ?? [])
        .filter((f) => f.name.startsWith(SKILL_FOLDER))
        .map((f) => ({
          name: f.name,
          off: f.off === true,
          ...skillMeta(f.name, f.content),
        })),
    [files]
  )
  // Another file drops a delete that was waiting to be confirmed.
  const pick = (name: string) => {
    setActive(name)
    setConfirming(false)
  }
  if (!files) {
    return (
      <SyncedSpinner
        small
        className="mx-auto my-8 size-4 text-muted-foreground"
      />
    )
  }
  const current = files.find((f) => f.name === active) ?? null
  const fixed = FIXED_FILES.find((f) => f.name === active) ?? null
  const skill = skills.find((k) => k.name === active)
  const isEntry = current != null && fixed == null && skill == null
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
    personalAgentFileSave(active, content, botId)
      .then(() => {
        setFiles((list) =>
          (list ?? []).map((f) =>
            f.name === active ? { ...f, content, exists: true } : f
          )
        )
        toast.message(t("fileSaved", { name: active }))
        // The persona's head the roster shows is read from it.
        if (active === "SOUL.md") reloadRoster()
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setSaving(false))
  }

  const remove = () => {
    if (skill) {
      const name = active
      setSaving(true)
      personalAgentFileDelete(name, botId)
        .then(() => personalAgentFiles(botId))
        .then((list) => {
          setFiles(list)
          setDrafts((d) => {
            const next: Record<string, string> = {}
            for (const f of list) next[f.name] = d[f.name] ?? f.content
            return next
          })
          pick("SOUL.md")
          toast.message(t("skillDeleted", { name: skill.title }))
        })
        .catch((e) => toast.error(toErrorMessage(e)))
        .finally(() => setSaving(false))
      return
    }
    if (!isEntry) return
    const name = active
    setSaving(true)
    personalAgentFileDelete(name, botId)
      .then(() => personalAgentFiles(botId))
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

  const switchSkill = () => {
    if (!skill) return
    const on = skill.off
    const name = active
    const folder = name.slice(SKILL_FOLDER.length).split("/")[0] ?? ""
    setSaving(true)
    personalAgentSkillSwitch(folder, on, botId)
      .then(() => {
        setFiles((list) =>
          (list ?? []).map((f) => (f.name === name ? { ...f, off: !on } : f))
        )
        toast.message(
          on
            ? t("skillTurnedOn", { name: skill.title })
            : t("skillTurnedOff", { name: skill.title })
        )
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setSaving(false))
  }

  const hint = (() => {
    if (skill) return t("processSkillHint")
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* The list, as the settings' navigation is drawn: on a phone, a
            short scrolled strip over the file. */}
        <nav
          aria-label={t("tabPersona")}
          className="field-scrollbar -mx-1 flex max-h-44 shrink-0 flex-col gap-0.5 overflow-y-auto px-1 sm:max-h-none sm:w-48"
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
                  icon={
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active === f.name
                          ? "text-foreground"
                          : "text-muted-foreground"
                      )}
                      aria-hidden
                    />
                  }
                  label={t(`fileGroups.${f.group}`)}
                  count={list ? list.length : undefined}
                  title={f.name}
                />
                {list && list.length > 0 ? (
                  <div className="ms-[1.0625rem] flex flex-col gap-0.5 border-s border-border/70 ps-1.5">
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
          {skills.length > 0 ? (
            <div className="mt-3 flex flex-col gap-0.5" data-pa-persona-skills>
              <p className="flex h-8 min-w-0 items-center gap-2.5 px-2 text-sm text-muted-foreground">
                <Workflow className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {t("fileGroups.skills")}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
                  {skills.length}
                </span>
              </p>
              <div className="ms-[1.0625rem] flex flex-col gap-0.5 border-s border-border/70 ps-1.5">
                {skills.map((k) => (
                  <FileButton
                    key={k.name}
                    selected={active === k.name}
                    dirty={isDirty(k.name)}
                    onClick={() => pick(k.name)}
                    label={k.title}
                    tag={k.off ? t("skillOff") : undefined}
                    title={k.description ?? k.name}
                    entry
                  />
                ))}
              </div>
            </div>
          ) : null}
        </nav>
        {/* The file open: one card, its name and who writes it over it,
            its buttons under it. */}
        <div className="flex min-h-[26rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <div className="flex min-w-0 items-start gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {skill
                    ? skill.title
                    : isEntry
                      ? (entry?.title ?? active)
                      : fixed
                        ? t(`fileGroups.${fixed.group}`)
                        : active}
                </span>
                <span
                  dir="ltr"
                  className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground"
                >
                  {active}
                </span>
              </div>
              {hint ? (
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {hint}
                </p>
              ) : null}
            </div>
            {fixed || entry?.type || skill ? (
              <Badge variant="secondary" className="mt-px font-normal">
                {skill
                  ? skill.off
                    ? t("skillOff")
                    : t("byAgent")
                  : fixed
                    ? writer
                    : t(`entryType.${entry!.type!}`)}
              </Badge>
            ) : null}
          </div>
          <Textarea
            dir="auto"
            aria-label={active}
            value={drafts[active] ?? ""}
            onChange={(e) =>
              setDrafts((d) => ({ ...d, [active]: e.target.value }))
            }
            className="field-scrollbar min-h-72 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-xs leading-5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex min-h-12 items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
            {skill && !confirming ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={switchSkill}
                data-pa-persona-skill-switch={skill.off ? "on" : "off"}
              >
                {skill.off ? t("skillTurnOn") : t("skillTurnOff")}
              </Button>
            ) : null}
            {isEntry || skill ? (
              confirming ? (
                <>
                  <span className="me-auto text-xs text-muted-foreground">
                    {skill
                      ? t("confirmDeleteSkillHint")
                      : t("confirmDeleteHint")}
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
                  {skill ? t("deleteSkill") : t("deleteEntry")}
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
                {saving ? <SyncedSpinner small /> : null}
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
        "flex w-full min-w-0 shrink-0 items-center rounded-lg px-2 text-start transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        entry ? "h-7 gap-1.5 text-[0.8125rem]" : "h-8 gap-2.5 text-sm",
        selected
          ? "bg-accent font-medium text-accent-foreground"
          : "text-foreground/80 hover:bg-muted hover:text-foreground"
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
        <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
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
