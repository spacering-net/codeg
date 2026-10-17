"use client"

import type { DynamicToolUIPart, ToolUIPart } from "ai"
import type { ComponentProps, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { isValidElement } from "react"

import { CodeBlock } from "./code-block"
import { JsonTreeView, parseJsonForTree } from "./json-tree"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "./message"
import { unwrapWholeFence } from "@/lib/fenced-text"

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group w-full rounded-md border border-border/60", className)}
    {...props}
  />
)

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolHeaderProps = {
  title?: ReactNode
  titleSuffix?: ReactNode
  icon?: ReactNode
  className?: string
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"]
      state: DynamicToolUIPart["state"]
      toolName: string
    }
)

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
}

export const getStatusBadge = (status: ToolPart["state"], label: string) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {label}
  </Badge>
)

export const ToolHeader = ({
  className,
  title,
  titleSuffix,
  icon,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const t = useTranslations("Folder.chat.tool")
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-")
  const statusLabel =
    state === "approval-requested"
      ? t("status.approvalRequested")
      : state === "approval-responded"
        ? t("status.approvalResponded")
        : state === "input-available"
          ? t("status.inputAvailable")
          : state === "input-streaming"
            ? t("status.inputStreaming")
            : state === "output-available"
              ? t("status.outputAvailable")
              : state === "output-denied"
                ? t("status.outputDenied")
                : t("status.outputError")

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-4 px-3 py-2",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0">
          {icon ?? <WrenchIcon className="size-4 text-muted-foreground" />}
        </span>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap font-medium text-sm">
          {title ?? derivedName}
        </span>
        {titleSuffix ? <span className="shrink-0">{titleSuffix}</span> : null}
        <span className="shrink-0">{getStatusBadge(state, statusLabel)}</span>
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({
  className,
  children,
  ...props
}: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "tool-collapsible-content overflow-hidden text-popover-foreground outline-none",
      className
    )}
    {...props}
  >
    <div className="space-y-4 p-4">{children}</div>
  </CollapsibleContent>
)

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"]
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const t = useTranslations("Folder.chat.tool")
  const formattedCode = (() => {
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input)
        return JSON.stringify(parsed, null, 2)
      } catch {
        return input
      }
    }
    return JSON.stringify(input, null, 2)
  })()

  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t("parameters")}
      </h4>
      <div className="rounded-md bg-muted/50">
        <CodeBlock code={formattedCode} language="json" />
      </div>
    </div>
  )
}

function detectOutputLanguage(text: string) {
  const trimmed = text.trimStart()
  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (() => {
      try {
        JSON.parse(trimmed)
        return true
      } catch {
        return false
      }
    })()
  ) {
    return "json" as const
  }
  if (trimmed.includes("diff --git") || trimmed.includes("@@")) {
    return "diff" as const
  }
  if (trimmed.startsWith("<")) {
    return "xml" as const
  }
  return "log" as const
}

const ERROR_LIKE_KEYS = [
  "error",
  "message",
  "stderr",
  "detail",
  "details",
  "reason",
  "text",
  "output",
  "formatted_output",
  "aggregated_output",
  "result",
]

function stripErrorPrefix(text: string): string {
  return text
    .trim()
    .replace(/^error:\s*/i, "")
    .trim()
}

function normalizeErrorForCompare(text: string): string {
  return stripErrorPrefix(text).replace(/\s+/g, " ")
}

function collectErrorCandidates(value: unknown): string[] {
  if (!value) {
    return []
  }

  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorCandidates(item))
  }

  if (typeof value !== "object") {
    return []
  }

  const obj = value as Record<string, unknown>
  const candidates: string[] = []

  for (const key of ERROR_LIKE_KEYS) {
    if (!(key in obj)) continue
    candidates.push(...collectErrorCandidates(obj[key]))
  }

  return candidates
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function formatErrorFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderErrorText(errorText: string): ReactNode {
  const text = unwrapWholeFence(errorText)
  const parsed = parseJson(text.trim())

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length > 0) {
      return (
        <div className="space-y-2 p-3">
          {entries.map(([key, value]) => (
            <div key={key} className="space-y-1">
              <div className="text-2xs font-medium uppercase tracking-wide text-destructive/80">
                {key}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-destructive">
                {formatErrorFieldValue(value)}
              </pre>
            </div>
          ))}
        </div>
      )
    }
  }

  return (
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-destructive">
      {text}
    </pre>
  )
}

function isDuplicateErrorOutput(
  output: ToolPart["output"],
  normalizedErrorText: string | null
): boolean {
  if (!normalizedErrorText || !output) {
    return false
  }

  const rawCandidates: string[] = []
  if (typeof output === "string") {
    rawCandidates.push(output)
    const parsed = parseJson(output)
    if (parsed) {
      rawCandidates.push(...collectErrorCandidates(parsed))
    }
  } else if (typeof output === "object" && !isValidElement(output)) {
    rawCandidates.push(...collectErrorCandidates(output))
  }

  return rawCandidates.some((candidate) => {
    const normalizedCandidate = normalizeErrorForCompare(candidate)
    return (
      normalizedCandidate.length > 0 &&
      normalizedCandidate === normalizedErrorText
    )
  })
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]
  errorText: ToolPart["errorText"]
  renderAsMarkdown?: boolean
}

const MD_INDICATORS = [
  /^#{1,6}\s/m,
  /^\s*[-*+]\s/m,
  /^\s*\d+\.\s/m,
  /\*\*[^*]+\*\*/,
  /\[.+\]\(.+\)/,
  /```[\s\S]*?```/,
  /^\s*>/m,
  /^\|.+\|$/m,
]

function looksLikeMarkdown(text: string): boolean {
  let count = 0
  for (const re of MD_INDICATORS) {
    if (re.test(text)) count++
    if (count >= 2) return true
  }
  return false
}

export const ToolOutput = ({
  className,
  output,
  errorText,
  renderAsMarkdown,
  ...props
}: ToolOutputProps) => {
  const t = useTranslations("Folder.chat.tool")
  if (!(output || errorText)) {
    return null
  }

  const normalizedErrorText =
    typeof errorText === "string" ? normalizeErrorForCompare(errorText) : null
  const hasDuplicateErrorOutput = isDuplicateErrorOutput(
    output,
    normalizedErrorText
  )

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === "object" && !isValidElement(output)) {
    // Unadapted structured result: a collapsible tree instead of a wall of
    // pretty-printed JSON (`JsonTreeView` falls back to the code block itself
    // for scalars and oversized payloads).
    Output = <JsonTreeView value={output} />
  } else if (typeof output === "string") {
    const lang = detectOutputLanguage(output)
    const jsonValue = lang === "json" ? parseJsonForTree(output) : undefined
    const shouldRenderMd =
      renderAsMarkdown ?? (lang === "log" && looksLikeMarkdown(output))
    if (jsonValue !== undefined) {
      Output = <JsonTreeView value={jsonValue} rawText={output} />
    } else if (shouldRenderMd) {
      Output = (
        <div className="prose prose-sm dark:prose-invert max-w-none p-3 text-sm [&_ul]:list-inside [&_ol]:list-inside">
          <MessageResponse>{output}</MessageResponse>
        </div>
      )
    } else if (lang === "diff") {
      Output = <UnifiedDiffPreview diffText={output} clickableFilePath />
    } else {
      Output = <CodeBlock code={output} language={lang} />
    }
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? t("error") : t("result")}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {typeof errorText === "string" && renderErrorText(errorText)}
        {!hasDuplicateErrorOutput && Output}
      </div>
    </div>
  )
}
