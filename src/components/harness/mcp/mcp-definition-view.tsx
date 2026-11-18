"use client"

import { createContext, useContext, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useCopiedFlag } from "@/hooks/use-copied-flag"

import {
  isSecretArg,
  isSecretEntry,
  maskArg,
  maskUrl,
  urlHasSecret,
} from "@/lib/mcp/secrets"
import type { McpDefinition } from "@/lib/mcp/types"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { RevealButton, SecretText } from "./mcp-bits"

/** One argument as a shell would need it written to be read back as one. */
function quoted(arg: string): string {
  if (arg !== "" && !/[\s"'\\]/.test(arg)) return arg
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`
}

/** How a definition is laid out: compact lines (a dialog's), or the rows of
 *  a detail's card — a label and its value per row, a rule between them. */
type Layout = "plain" | "rows"
const LayoutContext = createContext<Layout>("plain")

/**
 * A detail card's rows, as one grid: every label in one column, as wide as
 * the widest of them and no wider, every value beside it — so the values
 * start together, close to their labels, in any language. A rule runs
 * between two rows; a group's head (`data-rows-head`) spans the card and
 * takes the rule from the row under it. On a narrow pane a label goes
 * above its value.
 */
export function McpDefinitionRows({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <LayoutContext.Provider value="rows">
      <dl
        className={cn(
          "grid min-w-0 grid-cols-1 text-sm @md/mcp:grid-cols-[max-content_minmax(0,1fr)]",
          className
        )}
      >
        {children}
      </dl>
    </LayoutContext.Provider>
  )
}

/** A group's head inside {@link McpDefinitionRows}: across the card, over
 *  the rows that are the group's. */
export function McpDefinitionRowsHead({ children }: { children: ReactNode }) {
  return (
    <div
      data-rows-head=""
      className="col-span-full border-t px-4 pt-2.5 text-xs font-semibold text-foreground first:border-t-0"
    >
      {children}
    </div>
  )
}

/** One labelled line of a definition — and, in a detail's card, any other
 *  row the card adds beside it ("Status"). `align`: a value of several
 *  lines starts level with its label, rather than centred on it. */
export function McpDefinitionRow({
  label,
  align = "center",
  children,
}: {
  label: string
  align?: "center" | "start"
  children: ReactNode
}) {
  const layout = useContext(LayoutContext)
  if (layout === "rows") {
    const cell = cn(
      "flex flex-col",
      align === "start" ? "justify-start" : "justify-center"
    )
    return (
      // The row's two cells sit straight in the card's grid, so its
      // columns are the card's; each cell draws its half of the rule.
      <div className="contents [&:not(:first-child)>dt]:border-t @md/mcp:[&:not(:first-child)>dd]:border-t [[data-rows-head]+&>*]:border-t-0! [[data-rows-head]+&>*]:pt-2!">
        <dt
          className={cn(
            cell,
            "px-4 pt-2.5 pb-1 text-muted-foreground @md/mcp:pe-0 @md/mcp:pb-2.5"
          )}
        >
          {label}
        </dt>
        <dd
          className={cn(
            cell,
            "min-w-0 px-4 pb-2.5 @md/mcp:ps-6 @md/mcp:pt-2.5"
          )}
        >
          {children}
        </dd>
      </div>
    )
  }
  return (
    <div className="grid min-w-0 gap-1 @md/mcp:grid-cols-[7rem_minmax(0,1fr)] @md/mcp:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
const Row = McpDefinitionRow

/** Environment variables or headers: names as they are, secret values
 *  masked, each revealed on its own. */
function Pairs({
  record,
  label,
  isSecret,
}: {
  record: Record<string, string>
  label: string
  isSecret: (name: string, value: string) => boolean
}) {
  const entries = Object.entries(record)
  return (
    <ul aria-label={label} className="min-w-0 space-y-1">
      {entries.map(([name, value]) => (
        <li
          key={name}
          className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5"
        >
          <bdi dir="ltr" className="font-mono text-foreground">
            <MachineText>{name}</MachineText>
          </bdi>
          <span className="min-w-0 text-muted-foreground">
            <SecretText
              value={value}
              secret={isSecret(name, value)}
              label={name}
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The command and its arguments, as one line. Secret arguments are masked
 *  until revealed — together: they are one line. */
function CommandLine({ command, args }: { command: string; args: string[] }) {
  const t = useTranslations("Harness.mcp.definition")
  const [revealed, setRevealed] = useState(false)
  const secret = args.some((_, index) => isSecretArg(args, index))
  const shown = args.map((arg, index) =>
    secret && !revealed && isSecretArg(args, index) ? maskArg(args, index) : arg
  )
  const line = [command, ...shown].map(quoted).join(" ")
  const layout = useContext(LayoutContext)
  const tMcp = useTranslations("Harness.mcp")
  const [copied, markCopied] = useCopiedFlag()
  if (layout === "rows") {
    // A shell line in its own box, to be read — and copied as it is shown:
    // masked parts stay masked until revealed.
    const copyName = copied ? tMcp("agent.copied") : t("copyCommand")
    return (
      <div className="flex min-w-0 items-start gap-1 rounded-lg bg-muted/70 py-1 ps-3 pe-1">
        <code
          dir="ltr"
          data-mcp-secret={secret ? (revealed ? "shown" : "masked") : undefined}
          className="min-w-0 flex-1 py-1 font-mono text-[0.8125rem] leading-5 text-foreground"
        >
          <span aria-hidden="true" className="me-2 text-muted-foreground">
            $
          </span>
          <MachineText>{line}</MachineText>
        </code>
        {secret && (
          <RevealButton
            revealed={revealed}
            onToggle={() => setRevealed((prev) => !prev)}
            label={t("secretArgs")}
            className="size-7"
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copyName}
          title={copyName}
          onClick={() => {
            void copyTextToClipboard(line).then((ok) => {
              if (ok) markCopied()
            })
          }}
          className="size-7 shrink-0 text-muted-foreground max-md:size-9"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
    )
  }
  return (
    <span className="inline-flex min-w-0 max-w-full items-start gap-1">
      <code
        dir="ltr"
        data-mcp-secret={secret ? (revealed ? "shown" : "masked") : undefined}
        className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground"
      >
        <MachineText>{line}</MachineText>
      </code>
      {secret && (
        <RevealButton
          revealed={revealed}
          onToggle={() => setRevealed((prev) => !prev)}
          label={t("secretArgs")}
        />
      )}
    </span>
  )
}

/**
 * A server's definition, read-only, with every secret masked: the values of
 * secret-sounding variables and headers (`Authorization` among them), the
 * secret parts of the command line and of the address.
 */
export function McpDefinitionView({
  definition,
  className,
  secretNames,
  maskAllValues = false,
  layout = "plain",
  bare = false,
  children,
}: {
  definition: McpDefinition
  className?: string
  /** Only the lines, for a {@link McpDefinitionRows} grid the card holds
   *  with rows of its own. */
  bare?: boolean
  /** A dialog's compact lines, or a detail card's rows. */
  layout?: Layout
  /** Rows the card adds under the definition's own. */
  children?: ReactNode
  /** Variables and headers that are secret whatever they are called — the
   *  ones a source marked so. */
  secretNames?: ReadonlySet<string>
  /** Mask every variable's and header's value: for a definition whose
   *  source says nothing about which of its values are secret. */
  maskAllValues?: boolean
}) {
  const t = useTranslations("Harness.mcp.definition")
  const isSecret = (name: string, value: string) =>
    maskAllValues ||
    secretNames?.has(name) === true ||
    isSecretEntry(name, value)
  const lines = (
    <>
      {definition.type === "stdio" ? (
        <>
          <Row label={t("command")}>
            <CommandLine
              command={definition.command}
              args={definition.args ?? []}
            />
          </Row>
          {definition.env && Object.keys(definition.env).length > 0 && (
            <Row label={t("env")}>
              <Pairs
                record={definition.env}
                label={t("env")}
                isSecret={isSecret}
              />
            </Row>
          )}
        </>
      ) : (
        <>
          <Row label={t("url")}>
            <span className="text-foreground">
              <SecretText
                value={definition.url}
                masked={maskUrl(definition.url)}
                secret={urlHasSecret(definition.url)}
                label={t("url")}
              />
            </span>
          </Row>
          {definition.headers && Object.keys(definition.headers).length > 0 && (
            <Row label={t("headers")}>
              <Pairs
                record={definition.headers}
                label={t("headers")}
                isSecret={isSecret}
              />
            </Row>
          )}
        </>
      )}
      {children}
    </>
  )
  if (bare) return lines
  if (layout === "rows") {
    return <McpDefinitionRows className={className}>{lines}</McpDefinitionRows>
  }
  return (
    <LayoutContext.Provider value={layout}>
      <dl className={cn("min-w-0 space-y-2 text-xs", className)}>{lines}</dl>
    </LayoutContext.Provider>
  )
}
