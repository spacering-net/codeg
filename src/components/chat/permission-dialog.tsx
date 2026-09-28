"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  ShieldAlert,
  Terminal,
  ListTodo,
  Compass,
  FileText,
  Globe,
  Search,
  KeyRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "@/components/ai-elements/message"
import type { PendingPermission } from "@/contexts/acp-connections-context"
import {
  parsePermissionOptionChanges,
  parsePermissionToolCall,
  type PermissionChangeScope,
  type PermissionOptionChange,
} from "@/lib/permission-request"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import type { AgentType } from "@/lib/types"

interface PermissionDialogProps {
  permission: PendingPermission | null
  onRespond: (requestId: string, optionId: string) => void
  /**
   * Which agent asked. Only used to localise option labels an agent hardcodes
   * in one language (`deepseek-acp` ships Simplified Chinese with no locale
   * switch); optional so a caller with no agent in scope keeps today's verbatim
   * rendering.
   */
  agentType?: AgentType | null
}

function formatKindLabel(kind: string, fallbackLabel: string): string {
  const normalized = kind.replace(/_/g, " ").trim()
  return normalized.length > 0 ? normalized : fallbackLabel
}

/**
 * i18n key naming how long a change lasts (see `PermissionChangeScope`).
 * `as const` keeps the literal key types `t()` requires; `satisfies` keeps the
 * map exhaustive as scopes are added.
 */
const CHANGE_SCOPE_LABEL_KEYS = {
  session: "changeScopeSession",
  process: "changeScopeProcess",
  user: "changeScopeUser",
  project: "changeScopeProject",
  project_local: "changeScopeProjectLocal",
  persistent: "changeScopePersistent",
} as const satisfies Record<PermissionChangeScope, string>

export function PermissionDialog({
  permission,
  onRespond,
  agentType,
}: PermissionDialogProps) {
  const t = useTranslations("Folder.chat.permissionDialog")
  const vocabulary = useAgentVocabulary(agentType)
  const parsed = useMemo(
    () => parsePermissionToolCall(permission?.tool_call),
    [permission?.tool_call]
  )
  // Both the grant list and the buttons below read this, so the two never
  // disagree about what an option is called.
  const options = useMemo(
    () => vocabulary.permissionOptions(permission?.options ?? []),
    [permission?.options, vocabulary]
  )
  // What each option would actually grant, keyed by option id. Empty for every
  // agent that ships no option-level `_meta.permission` — which, on the pinned
  // adapter versions, is ALL of them: codex dropped `changes[]` in 1.7.0 and
  // claude in 0.73.0, both moving the grant text into the option name and the
  // reason into a request-level block (hoisted onto the tool call by the
  // backend, and read as `_meta.permission.title` below). Non-empty only for a
  // user-pinned codex 1.1.8–1.6.2 or claude 0.64.1–0.72.0.
  const optionChanges = useMemo(() => {
    const out: Record<string, PermissionOptionChange[]> = {}
    for (const opt of permission?.options ?? []) {
      const changes = parsePermissionOptionChanges(opt.meta)
      if (changes.length > 0) out[opt.option_id] = changes
    }
    return out
  }, [permission?.options])
  if (!permission) return null

  // Approvals are surfaced one at a time (backend FIFO), so the count of the
  // ones still behind this card has to be visible or they read as a hang.
  const queued = permission.queued ?? 0
  const hasOptionChanges = Object.keys(optionChanges).length > 0

  const hasFileChanges = parsed.fileChanges.length > 0
  const hasPlan =
    parsed.planEntries.length > 0 || Boolean(parsed.planExplanation)
  const hasPlanMarkdown = Boolean(parsed.planMarkdown)
  const hasAllowedPrompts = parsed.allowedPrompts.length > 0
  const hasWeb = Boolean(parsed.url) || Boolean(parsed.query)
  const hasOtherStructured =
    Boolean(parsed.command) ||
    hasFileChanges ||
    hasPlan ||
    hasPlanMarkdown ||
    hasAllowedPrompts ||
    Boolean(parsed.modeTarget) ||
    hasWeb
  // Agent-provided description (ACP `content` text). Shown only when no richer
  // structured view exists, so it replaces the raw-JSON fallback for agents
  // like Kimi Code that carry the request text in `content` rather than
  // `rawInput`, while leaving command/diff/plan dialogs untouched.
  const hasContentText = Boolean(parsed.contentText)
  const hasStructured = hasOtherStructured || hasContentText

  return (
    <div className="mx-4 mb-3 rounded-xl border border-border/70 bg-card/95 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
            {/* Prefer the human-readable description (claude-agent-acp
                0.63–0.72 `_meta.claudeCode.title`, else `_meta.permission.title`
                — codex ≥1.7.0 and claude ≥0.73.0, whose permission tool calls
                carry no `claudeCode` block at all) over the raw title (the
                shell command, which the command block below already shows).
                `parsePermissionToolCall` also drops a description that IS that
                command, which is what claude-agent-acp ≥0.79.0 puts there. */}
            <span className="truncate">
              {parsed.description ?? parsed.title}
            </span>
          </div>
          {/* The agent's own reason for asking, when it gave one — strictly
              more informative than the boilerplate subtitle it replaces, and
              the only place codex-acp ≥1.7.0 still carries it. Wraps rather
              than truncating: this is the sentence the decision rests on. */}
          <p className="text-xs text-muted-foreground">
            {parsed.reason ?? t("subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Only one card shows at a time, so without this the remaining
              approvals look like the agent has stopped responding. */}
          {queued > 0 ? (
            <Badge variant="secondary" className="text-3xs tabular-nums">
              {t("queuedCount", { count: queued })}
            </Badge>
          ) : null}
          <Badge variant="outline" className="text-3xs">
            {formatKindLabel(parsed.normalizedKind, t("kindFallbackTool"))}
          </Badge>
        </div>
      </div>

      <div className="mt-3 max-h-[min(36vh,18rem)] space-y-2 overflow-y-auto pr-1">
        {parsed.command && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              <span>{t("command")}</span>
            </div>
            <CodeBlock code={parsed.command} language="bash" />
            {parsed.cwd && (
              <div className="break-all text-xs text-muted-foreground">
                {t("cwd", { cwd: parsed.cwd })}
              </div>
            )}
          </div>
        )}

        {hasFileChanges && parsed.diffPreview && (
          <UnifiedDiffPreview diffText={parsed.diffPreview} />
        )}

        {hasPlan && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ListTodo className="h-3.5 w-3.5" />
              <span>{t("plan")}</span>
            </div>
            {parsed.planExplanation && (
              <p className="text-xs text-foreground/90">
                {parsed.planExplanation}
              </p>
            )}
            {parsed.planEntries.length > 0 && (
              <div className="space-y-1 rounded-md bg-muted/40 p-2">
                {parsed.planEntries.map((entry, index) => (
                  <div key={`${entry.text}-${index}`} className="text-xs">
                    <span className="text-foreground/90">{entry.text}</span>
                    {entry.status && (
                      <span className="ml-2 text-muted-foreground">
                        ({entry.status})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {hasPlanMarkdown && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              <span>{t("plan")}</span>
            </div>
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{parsed.planMarkdown!}</MessageResponse>
            </div>
          </div>
        )}

        {hasAllowedPrompts && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              <span>{t("allowedActions")}</span>
            </div>
            <div className="space-y-1 rounded-md bg-muted/40 p-2">
              {parsed.allowedPrompts.map((item, index) => (
                <div
                  key={`${item.prompt}-${index}`}
                  className="flex items-center gap-2 text-xs"
                >
                  {item.tool && (
                    <Badge variant="outline" className="shrink-0 text-3xs">
                      {item.tool}
                    </Badge>
                  )}
                  <span className="text-foreground/90">{item.prompt}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {parsed.modeTarget && (
          <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
            <div className="flex items-center gap-1 text-muted-foreground">
              <Compass className="h-3.5 w-3.5" />
              <span>{t("targetMode", { mode: parsed.modeTarget })}</span>
            </div>
          </div>
        )}

        {hasWeb && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            {parsed.url && (
              <div className="flex items-center gap-2 text-xs">
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="break-all font-mono text-foreground/90">
                  {parsed.url}
                </span>
              </div>
            )}
            {parsed.query && (
              <div className="flex items-center gap-2 text-xs">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="break-all text-foreground/90">
                  {parsed.query}
                </span>
              </div>
            )}
            {parsed.prompt && (
              <div className="mt-1 text-xs text-muted-foreground">
                <MessageResponse>{parsed.prompt}</MessageResponse>
              </div>
            )}
          </div>
        )}

        {/* What the buttons below would actually grant (codex-acp ≥1.1.8 /
            claude-agent-acp ≥0.64.1 `_meta.permission.changes`). Kept OUT of the
            buttons: a grant list inside a filled button turns every option into
            a full-width block of small text on the accent colour, and claude
            attaches one to every request. As the last body section it sits
            directly above the options it describes, and a pathological list
            scrolls with the rest instead of pushing the buttons off screen. */}
        {hasOptionChanges && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" />
              <span>{t("optionGrants")}</span>
            </div>
            <div className="space-y-2 rounded-md bg-muted/40 p-2">
              {options.map((opt) => {
                const changes = optionChanges[opt.option_id] ?? []
                if (changes.length === 0) return null
                return (
                  <div key={opt.option_id} className="space-y-1">
                    {/* Names the button, since only some options carry a list
                        (claude tags the always-allow one alone). */}
                    <div className="text-xs font-medium text-foreground/90">
                      {opt.name}
                    </div>
                    {changes.map((change, index) => (
                      <div
                        key={index}
                        className="flex items-start gap-2 text-xs"
                      >
                        {/* Duration first, so it reads as a scannable column —
                            only codex states it in its own sentences, and
                            "Always Allow" alone never says whether the rule
                            dies with the session or lands in committed
                            settings. */}
                        {change.scope && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-3xs"
                          >
                            {t(CHANGE_SCOPE_LABEL_KEYS[change.scope])}
                          </Badge>
                        )}
                        <span className="min-w-0 break-words text-foreground/90">
                          {change.description}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!hasOtherStructured && parsed.contentText && (
          <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs text-foreground/90">
            <MessageResponse>{parsed.contentText}</MessageResponse>
          </div>
        )}

        {!hasStructured && (
          <pre className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs whitespace-pre-wrap break-all text-foreground/90">
            {parsed.jsonPreview}
          </pre>
        )}
      </div>

      {/* `_meta.permission.defaultToNo` (claude-agent-acp ≥0.77.0) marks an ask
          that "must not be approvable by a stray keystroke". codeg pre-selects
          nothing and binds no key, and the adapter already sends the reject
          options first — so all that is left is the emphasis, which today puts
          the single filled button on "Allow". Inverting it keeps every option
          one click away while making the decline the one the eye lands on. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((opt) => {
          const isReject = opt.kind.startsWith("reject")
          const emphasized = parsed.defaultToNo ? isReject : !isReject
          return (
            <Button
              key={opt.option_id}
              variant={emphasized ? "default" : "outline"}
              className="h-auto min-h-9 whitespace-normal break-words text-left"
              onClick={() => onRespond(permission.request_id, opt.option_id)}
            >
              {opt.name}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
