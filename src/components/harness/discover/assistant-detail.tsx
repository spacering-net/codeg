"use client"

import {
  Fragment,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  Check,
  ChevronDown,
  Copy,
  FilePen,
  FileSearch,
  Globe,
  Loader2,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { harnessBlob } from "@/lib/harness/api"
import {
  assistantColor,
  definitionFile,
  groupTools,
  repeatedHeadings,
  settingEntries,
  startersOf,
  TOOL_GROUPS,
  type AssistantColor,
  type ToolGroup,
} from "@/lib/harness/assistant"
import { copyPendingText } from "@/lib/harness/clipboard"
import { openDiscoverItem } from "@/lib/harness/discover-state"
import { itemTitle, modelName } from "@/lib/harness/display"
import { harnessFailureOf, type HarnessFailure } from "@/lib/harness/errors"
import type {
  HarnessAssistantExample,
  HarnessAssistantInfo,
} from "@/lib/harness/types"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { useHarnessHost } from "../harness-host-label"
import { MachineText } from "../machine-text"
import type {
  DiscoverDetailActionsProps,
  DiscoverDetailBodyProps,
  DiscoverDetailPartProps,
} from "./detail-kinds"
import {
  ChecksSection,
  DescriptionSection,
  DetailSection,
  PermissionsSection,
  useExpanded,
  VersionsSection,
} from "./detail-sections"
import { ActionAlert, refocus } from "./detail-actions"
import { useHarnessFailureMessage } from "./discover-failure"
import { useDiscoverLabels } from "./use-discover-labels"

/**
 * An assistant's detail: its instructions, what to say to it, and what it may
 * use — tools, model, the skills and MCP servers it needs — before the
 * permissions, checks and versions every item has.
 *
 * Assistants are shown, not installed, in this release (plan decision D2):
 * the one thing to do with one is copy its definition. Nothing here offers to
 * install it, and nothing pretends to.
 *
 * The catalog's text is shown as text — the examples carry markup such as
 * `<Task tool invocation…>`, and it stays words on the page. The instructions
 * are the one HTML part, and go through `ReadmeContent`'s allowlist.
 */

/** About twenty-four lines of instructions before "Show all". */
const INSTRUCTIONS_FOLD_REM = 34

/** A part's title inside a section: "Try saying", "When it is called". */
const SUBHEADING_CLASS = "pb-1.5 text-xs font-medium text-muted-foreground"

// ─── Heading ──────────────────────────────────────────────────────────

/** Its word about itself, above the summary — a quotation, in its own
 *  language's direction. */
export function AssistantLead({ item }: DiscoverDetailPartProps) {
  const vibe = item.install.assistant?.vibe?.trim()
  if (!vibe) return null
  return (
    <p
      dir="auto"
      className="border-s-2 border-border ps-2.5 text-sm leading-relaxed text-foreground/80"
    >
      {vibe}
    </p>
  )
}

/** The plugin of its repository it comes in, and the others that carry a
 *  copy of it. */
export function AssistantByline({ item }: DiscoverDetailPartProps) {
  const t = useTranslations("Harness.discover.assistant")
  const info = item.install.assistant
  if (!info?.plugin) return null
  return (
    // The spaces are for reading it out and copying it: the gaps alone
    // would run the words together.
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="shrink-0">{t("plugin")}</span>{" "}
      <Token>{info.plugin}</Token>
      {info.alsoIn.length > 0 && (
        <>
          {" "}
          <span className="shrink-0">{t("alsoIn")}</span>{" "}
          <Codes values={info.alsoIn} />
        </>
      )}
    </span>
  )
}

// ─── Body ─────────────────────────────────────────────────────────────

export function AssistantBody({
  item,
  versions,
  readme,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  const t = useTranslations("Harness.discover.assistant")
  const { lang } = useDiscoverLabels()
  const info = item.install.assistant
  const title = itemTitle(item, lang)
  const name = info?.name || item.name
  // Instructions that open by naming the assistant say what the page's
  // heading already does.
  const omitHeading = useMemo(
    () => repeatedHeadings(title, name),
    [title, name]
  )

  return (
    <>
      <DescriptionSection
        item={item}
        readme={readme}
        onRetry={() => onRetryPart("readme")}
        title={t("instructions")}
        omitHeading={omitHeading}
        foldRem={INSTRUCTIONS_FOLD_REM}
      />
      {info && <ExamplesSection info={info} />}
      {info && <CapabilitiesSection info={info} />}
      <PermissionsSection item={item} />
      <ChecksSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

// ─── Examples ─────────────────────────────────────────────────────────

/** What to say to it, and the exchanges its definition gives for when the
 *  main session should hand it work. Shown only when there are any. */
function ExamplesSection({ info }: { info: HarnessAssistantInfo }) {
  const t = useTranslations("Harness.discover.assistant")
  const starters = startersOf(info)
  const examples = info.examples
  if (starters.length === 0 && examples.length === 0) return null

  return (
    <DetailSection title={t("examples")}>
      <div className="space-y-4">
        {starters.length > 0 && (
          <div>
            <h4 className={SUBHEADING_CLASS}>{t("starters")}</h4>
            <ul className="divide-y rounded-lg border">
              {starters.map((starter, index) => (
                <StarterRow key={index} text={starter} />
              ))}
            </ul>
          </div>
        )}
        {examples.length > 0 && (
          <div>
            <h4 className={SUBHEADING_CLASS}>{t("dialogues")}</h4>
            <ol className="space-y-2">
              {examples.map((example, index) => (
                <ExampleCard key={index} example={example} index={index} />
              ))}
            </ol>
          </div>
        )}
      </div>
    </DetailSection>
  )
}

function StarterRow({ text }: { text: string }) {
  const t = useTranslations("Harness.discover.assistant")
  const textId = useId()
  const [copied, markCopied] = useCopiedFlag()

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget
    void copyTextToClipboard(text).then((ok) => {
      refocus(button)
      if (ok) markCopied()
    })
  }

  return (
    <li className="flex min-w-0 items-start gap-2 py-1 ps-3 pe-1">
      <p
        id={textId}
        dir="auto"
        className="min-w-0 flex-1 py-1.5 text-sm [overflow-wrap:anywhere] whitespace-pre-line"
      >
        {text}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? t("lineCopied") : t("copyLine")}
        aria-describedby={textId}
        title={copied ? t("lineCopied") : t("copyLine")}
        onClick={copy}
        className="shrink-0 text-muted-foreground max-md:size-10"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("lineCopied") : ""}
      </span>
    </li>
  )
}

/** One exchange: the situation on a line, then what the user says and how
 *  the main session answers, as a dialogue; why it is handed over, folded. */
function ExampleCard({
  example,
  index,
}: {
  example: HarnessAssistantExample
  index: number
}) {
  const t = useTranslations("Harness.discover.assistant")
  const [open, setOpen] = useExpanded(`why-${index}`)
  const whyId = useId()

  return (
    <li className="min-w-0 space-y-2 rounded-lg border px-3 py-2.5">
      {example.context && (
        <p
          dir="auto"
          className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
        >
          {example.context}
        </p>
      )}
      <div className="space-y-1.5">
        {example.user.trim() && (
          <Turn who={t("user")} text={example.user} speaker="user" />
        )}
        {example.assistant?.trim() && (
          <Turn who={t("reply")} text={example.assistant} speaker="main" />
        )}
      </div>
      {example.commentary && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-controls={whyId}
            onClick={() => setOpen(!open)}
            className="-ms-1.5 text-muted-foreground max-md:h-9"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "transition-transform",
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
            {t("why")}
          </Button>
          <p
            id={whyId}
            hidden={!open}
            dir="auto"
            className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
          >
            {example.commentary}
          </p>
        </div>
      )}
    </li>
  )
}

function Turn({
  who,
  text,
  speaker,
}: {
  who: string
  text: string
  speaker: "user" | "main"
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md px-2.5 py-1.5",
        speaker === "user"
          ? "bg-muted/70"
          : "rounded-s-none border-s-2 border-primary/30 bg-background"
      )}
    >
      <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {who}
      </p>
      <p
        dir="auto"
        className="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-line"
      >
        {text}
      </p>
    </div>
  )
}

// ─── Capabilities ─────────────────────────────────────────────────────

const GROUP_ICONS: Record<ToolGroup, LucideIcon> = {
  read: FileSearch,
  edit: FilePen,
  run: SquareTerminal,
  web: Globe,
}

/** Claude Code's eight subagent colours, as a swatch. The author's choice,
 *  shown small beside the name it colours, and nowhere else. */
const SWATCHES: Record<AssistantColor, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  yellow: "bg-yellow-400",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
}

function CapabilityRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-x-3 gap-y-1 px-3 py-2 @xl/discover:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="font-medium">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** A line that warns: what runs commands. */
function Caution({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-3.5 shrink-0 text-tone-warning"
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/**
 * A name or a value as a definition writes it: `Code`'s look, broken between
 * its parts (see `MachineText`) or, a setting's value often being a sentence,
 * between its words.
 */
function Token({ children }: { children: ReactNode }) {
  return (
    <code
      dir="ltr"
      className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
    >
      <MachineText>{children}</MachineText>
    </code>
  )
}

/** Machine names in a row. Spaced as well as gapped, so that they are read
 *  out and copied as separate words. */
function Codes({ values }: { values: readonly string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {values.map((value, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          <Token>{value}</Token>
        </Fragment>
      ))}
    </span>
  )
}

/**
 * What it may use: its tools, by what they let it touch; the model it runs
 * on; the skills and MCP servers it needs; what of it runs commands; and the
 * rest of its settings as written. A part it says nothing about is not shown.
 */
function CapabilitiesSection({ info }: { info: HarnessAssistantInfo }) {
  const t = useTranslations("Harness.discover.assistant")
  const color = assistantColor(info.color)
  const settings = settingEntries(info.settings)
  const name = info.name.trim()

  return (
    <DetailSection title={t("capabilities")}>
      <dl className="divide-y rounded-lg border text-xs">
        {name && (
          <CapabilityRow label={t("name")}>
            <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
              {color && (
                <span
                  role="img"
                  aria-label={t("colour", { colour: t(`colours.${color}`) })}
                  title={t("colour", { colour: t(`colours.${color}`) })}
                  className={cn(
                    "inline-block size-2.5 shrink-0 rounded-full ring-1 ring-foreground/15",
                    SWATCHES[color]
                  )}
                />
              )}
              <Token>{name}</Token>
            </span>
          </CapabilityRow>
        )}
        <CapabilityRow label={t("tools")}>
          <ToolsValue info={info} />
        </CapabilityRow>
        <CapabilityRow label={t("model")}>
          {modelName(info.model) ? (
            <bdi>{modelName(info.model)}</bdi>
          ) : (
            <span className="text-muted-foreground">{t("inherit")}</span>
          )}
        </CapabilityRow>
        {info.skills.length > 0 && (
          <CapabilityRow label={t("skills")}>
            <SkillsValue skills={info.skills} />
          </CapabilityRow>
        )}
        {info.mcpServers.length > 0 && (
          <CapabilityRow label={t("mcpServers")}>
            <div className="space-y-1">
              <Codes values={info.mcpServers} />
              <p className="text-muted-foreground">{t("mcpServersNote")}</p>
            </div>
          </CapabilityRow>
        )}
        {info.mcpLaunches.length > 0 && (
          <CapabilityRow label={t("mcpLaunches")}>
            <div className="space-y-1">
              <Codes values={info.mcpLaunches} />
              <Caution>{t("mcpLaunchesNote")}</Caution>
            </div>
          </CapabilityRow>
        )}
        {info.hooks && (
          <CapabilityRow label={t("hooks")}>
            <Caution>{t("hooksNote")}</Caution>
          </CapabilityRow>
        )}
        {info.permissionMode && (
          <CapabilityRow label={t("permissionMode")}>
            <Token>{info.permissionMode}</Token>
          </CapabilityRow>
        )}
        {settings.length > 0 && (
          <CapabilityRow label={t("settings")}>
            <Codes
              values={settings.map(
                (setting) => `${setting.key}: ${setting.value}`
              )}
            />
          </CapabilityRow>
        )}
      </dl>
    </DetailSection>
  )
}

/**
 * Its tools, in the four groups — read files, change them, run commands,
 * reach the web — each saying whether it may, and with which tools; then any
 * others, and those it is denied. One whose tools are not limited may use
 * every tool of its session, MCP tools included, and says so.
 */
function ToolsValue({ info }: { info: HarnessAssistantInfo }) {
  const t = useTranslations("Harness.discover.assistant")
  const grouped = info.tools === null ? null : groupTools(info.tools)

  return (
    <div className="space-y-1.5">
      {info.tools === null && <p>{t("allTools")}</p>}
      <ul className="space-y-1">
        {TOOL_GROUPS.map((group) => {
          const allowed = info.access[group]
          const tools = grouped?.[group] ?? []
          const Icon = GROUP_ICONS[group]
          return (
            <li
              key={group}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5",
                  !allowed && "text-muted-foreground"
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-3.5", !allowed && "opacity-50")}
                />
                {t(`groups.${group}`)}
              </span>{" "}
              {allowed && tools.length > 0 ? (
                <>
                  <span className="sr-only">{t("allowed")}</span>{" "}
                  <Codes values={tools} />
                </>
              ) : (
                <span className="text-muted-foreground">
                  {t(allowed ? "allowed" : "notAllowed")}
                </span>
              )}
            </li>
          )
        })}
        {grouped && grouped.other.length > 0 && (
          <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Wrench aria-hidden="true" className="size-3.5" />
              {t("groups.other")}
            </span>{" "}
            <Codes values={grouped.other} />
          </li>
        )}
      </ul>
      {info.disallowedTools.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 text-muted-foreground">{t("denied")}</span>{" "}
          <Codes values={info.disallowedTools} />
        </div>
      )}
    </div>
  )
}

/**
 * The skills it has loaded when it starts. One the catalog has (by the same
 * publisher) opens in Discover, and Back comes here again; one it does not
 * have is named, and said to be outside Harness.
 */
function SkillsValue({ skills }: { skills: HarnessAssistantInfo["skills"] }) {
  const t = useTranslations("Harness.discover.assistant")
  const { slots } = useHarnessView()
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5">
      {skills.map(({ name, ref }, index) => (
        <li key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {ref ? (
            <button
              type="button"
              // Back from that skill gives the focus to this link again.
              data-harness-item={ref}
              title={ref}
              onClick={() =>
                void openDiscoverItem(slots, ref, null, { trail: "push" })
              }
              // One short word: its hit area is padded out to the row.
              className="-my-2 rounded-sm py-2 font-mono text-primary underline decoration-primary/40 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <bdi dir="ltr">
                <MachineText>{name}</MachineText>
              </bdi>
            </button>
          ) : (
            <>
              <Token>{name}</Token>{" "}
              <span className="text-muted-foreground">{t("notInHarness")}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

// ─── Actions ──────────────────────────────────────────────────────────

/** What went wrong fetching a definition, in words for that: the catalog's
 *  general messages speak of items and addresses, not of one file. */
function useDefinitionFailureMessage(): (failure: HarnessFailure) => string {
  const t = useTranslations("Harness.discover.assistant.copyErrors")
  const general = useHarnessFailureMessage()
  const host = useHarnessHost()
  return (failure) => {
    switch (failure.kind) {
      case "notFound":
      case "tooLarge":
      case "invalidResponse":
      case "invalidRef":
        return t(failure.kind)
      case "unsupported":
        return t(
          host.kind === "remote"
            ? "unsupportedRemote"
            : host.kind === "web"
              ? "unsupportedWeb"
              : "unsupported"
        )
      default:
        return general(failure)
    }
  }
}

type CopyState =
  | { phase: "idle" | "copying" | "copied" | "clipboard" }
  | { phase: "failed"; failure: HarnessFailure }

/**
 * "Copy definition": the definition file's text, fetched by its hash from
 * the version's file list (`harness_blob`) — the file as written, ready for
 * `~/.claude/agents/`. Offered only when Harness keeps that file to hand out.
 * Then a line saying that assistants are shown here and installed later; no
 * control of any kind installs one.
 */
export function AssistantActions({ item }: DiscoverDetailActionsProps) {
  const t = useTranslations("Harness.discover.assistant")
  const failureMessage = useDefinitionFailureMessage()
  const file = definitionFile(item)
  const [state, setState] = useState<CopyState>({ phase: "idle" })
  const [copied, markCopied] = useCopiedFlag(2000)
  // One copy at a time: a second press while the file is on its way would
  // only fetch it again.
  const copying = useRef(false)

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    if (!file || copying.current) return
    const button = event.currentTarget
    copying.current = true
    setState({ phase: "copying" })
    // Issued now, inside the click: see `copyPendingText`.
    copyPendingText(harnessBlob(file.sha256))
      .then(
        (ok) => {
          setState({ phase: ok ? "copied" : "clipboard" })
          if (ok) markCopied()
        },
        (error: unknown) =>
          setState({ phase: "failed", failure: harnessFailureOf(error) })
      )
      .finally(() => {
        copying.current = false
        refocus(button)
      })
  }

  return (
    <>
      {file && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          // Not `disabled` while copying: a button that disables itself under
          // the focus drops it on the page.
          aria-disabled={state.phase === "copying" || undefined}
          onClick={copy}
          className="max-md:h-10"
        >
          {state.phase === "copying" ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : copied ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {state.phase === "copying"
            ? t("copying")
            : copied
              ? t("copied")
              : t("copy")}
        </Button>
      )}
      {state.phase === "copied" && (
        <p className="basis-full text-xs text-muted-foreground">
          {t("copiedNote")}
        </p>
      )}
      {state.phase === "failed" && (
        <ActionAlert>
          {failureMessage(state.failure)}
          {state.failure.detail && (
            <bdi className="block break-words text-muted-foreground">
              {state.failure.detail}
            </bdi>
          )}
        </ActionAlert>
      )}
      {state.phase === "clipboard" && (
        <ActionAlert>{t("copyFailed")}</ActionAlert>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("copiedNote") : ""}
      </span>
    </>
  )
}
