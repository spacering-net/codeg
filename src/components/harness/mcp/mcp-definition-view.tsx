"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import {
  isSecretArg,
  isSecretEntry,
  maskArg,
  maskUrl,
  urlHasSecret,
} from "@/lib/mcp/secrets"
import type { McpDefinition } from "@/lib/mcp/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { RevealButton, SecretText } from "./mcp-bits"

/** One argument as a shell would need it written to be read back as one. */
function quoted(arg: string): string {
  if (arg !== "" && !/[\s"'\\]/.test(arg)) return arg
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 @md/mcp:grid-cols-[7rem_minmax(0,1fr)] @md/mcp:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

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
  return (
    <span className="inline-flex min-w-0 max-w-full items-start gap-1">
      <code
        dir="ltr"
        data-mcp-secret={secret ? (revealed ? "shown" : "masked") : undefined}
        className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground"
      >
        <MachineText>{[command, ...shown].map(quoted).join(" ")}</MachineText>
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
}: {
  definition: McpDefinition
  className?: string
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
  return (
    <dl className={cn("min-w-0 space-y-2 text-xs", className)}>
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
    </dl>
  )
}
