"use client"

/**
 * Per-conversation banner + dialog for pi's PROJECT TRUST decision.
 *
 * pi loads a repo's own `.pi/*` — settings, skills, prompts, themes, system-prompt
 * overrides, and `.pi/extensions`, which are JS/TS modules whose top level runs at
 * pi startup with the user's permissions — but only once the workspace is trusted
 * in pi's `~/.pi/agent/trust.json`. Because pi-acp spawns `pi --mode rpc` (no UI),
 * pi cannot ask, and its own default is to skip those resources.
 *
 * codeg used to write that trust automatically on every pi launch, which silently
 * answered "yes" on the user's behalf — so merely opening a conversation on a
 * cloned repo executed whatever it shipped in `.pi/extensions`. That is gone; the
 * decision now surfaces here instead.
 *
 * Two cases reach the user, because removing the auto-seeding does not undo what
 * it already wrote:
 * - UNDECIDED — nothing covers this folder, so pi is skipping the resources.
 *   Asks for a decision.
 * - ALREADY TRUSTED, not yet acknowledged — a grant is in force, possibly one an
 *   older codeg wrote without asking, and possibly inherited from an ancestor it
 *   seeded (which covers repos cloned into that ancestor long afterwards). Those
 *   entries can't be told apart from the user's own pi decisions, so they aren't
 *   pruned; instead this discloses the grant, names the deciding folder, and
 *   offers to revoke. Because pi runs extensions at startup, a warning shown
 *   after connecting would come too late — so the backend REFUSES to launch pi
 *   while such a grant stands (`pi_project_trust_launch_block`), and answering
 *   here is what releases it. The answer is recorded on the backend, which is
 *   what enforces the gate; pi's own file is untouched by "keep trusted".
 *
 * Behaviour:
 * - Only for pi, and only when the repo actually ships trust-gated resources.
 * - Owners only — viewers and delegation children don't own the backend process,
 *   so neither the decision nor the restart is theirs to make. Same rule as
 *   `SessionConfigStaleBanner`, whose layout and restart mechanics this mirrors.
 * - Renders with or without a live connection, since the gate's whole job is to
 *   stop the connection from existing until this is answered.
 * - Every answer restarts pi, because it resolves trust once at process startup:
 *   granting so the resources load, revoking so they stop being loaded, and
 *   acknowledging so the launch the gate refused can finally happen.
 * - The X dismisses for this session only, and never implies a decision: an
 *   undecided project stays undecided, which is the safe state. Dismissing the
 *   disclosure does NOT acknowledge it, so it returns next session.
 *
 * Returns null (no layout impact) when there's nothing to decide.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Loader2, ShieldCheck, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useConnection } from "@/hooks/use-connection"
import type { AgentType } from "@/lib/types"
import {
  acpPiAcknowledgeProjectTrust,
  acpPiProjectTrustState,
  acpPiSetProjectTrust,
  type PiProjectTrustState,
} from "@/lib/api"
import { cn } from "@/lib/utils"

/** Trust state plus the directory whose probe produced it. */
type Probed = {
  /** The `workingDir` this was fetched for — NOT the canonical path the backend
   *  resolved, which can differ (`/tmp` vs `/private/tmp`). Compared against the
   *  tab's current directory so a decision can never be written for a folder the
   *  user is no longer looking at. */
  requestedFor: string
  state: PiProjectTrustState
}

export function PiProjectTrustBanner({
  contextKey,
  agentType,
  workingDir,
}: {
  contextKey: string
  /** The tab's selected agent. Taken from the tab rather than the connection:
   *  when the trust gate blocks the launch there is no connection to read it
   *  from, and that is exactly when this notice must appear. */
  agentType: AgentType | null
  /** The tab's working directory, for the same reason. */
  workingDir: string | undefined
}) {
  const t = useTranslations("Folder.chat.piProjectTrust")
  const { status, isViewer, isDelegationChild, reapplyConfig, connect } =
    useConnection(contextKey)

  const [probed, setProbed] = useState<Probed | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [applying, setApplying] = useState(false)

  // Owners only. Deliberately does NOT require a live connection: the launch
  // gate refuses to start pi in a folder whose grant nobody confirmed, so the
  // notice has to be reachable while disconnected in order to resolve it.
  const eligible =
    agentType === "pi" && !!workingDir && !isViewer && !isDelegationChild

  // Every probe carries the generation it was issued in. Switching folders (or
  // disconnecting) bumps it, so a slow reply for the PREVIOUS workspace can't
  // land on top of the current one — which would otherwise show one project's
  // files while connected to another, and write the decision to the wrong folder.
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!eligible || !workingDir) return
    const issuedAt = generation.current
    const requestedFor = workingDir
    try {
      const state = await acpPiProjectTrustState(requestedFor)
      if (generation.current !== issuedAt) return
      setProbed({ requestedFor, state })
    } catch {
      // Read-only probe: if it fails we simply don't prompt. Never surface a
      // toast here — it would fire on every reconnect for a transient error.
      if (generation.current !== issuedAt) return
      setProbed(null)
    }
  }, [eligible, workingDir])

  useEffect(() => {
    // Invalidate anything in flight for the previous workspace before deciding
    // what to do about this one.
    generation.current += 1
    setProbed(null)
    if (!eligible) return
    void refresh()
    setDismissed(false)
  }, [eligible, refresh])

  // Only act on a probe that still matches the live connection. Re-checking here
  // (not just at fetch time) closes the window where the folder changed while the
  // dialog sat open.
  const current =
    probed && eligible && probed.requestedFor === workingDir
      ? probed.state
      : null

  const hasResources = !!current && current.resources.length > 0
  const undecided = hasResources && current.decision === null
  // A grant already in force that the user has not been shown yet.
  const undisclosedGrant =
    hasResources && current.decision === true && !current.acknowledged
  const visible = undecided || undisclosedGrant

  const turnInFlight = status === "prompting"
  const busy = applying || status === "connecting"
  const actionDisabled = turnInFlight || busy

  /**
   * Bring pi in line with a decision just made. pi reads trust once, at startup,
   * so nothing takes effect until the process restarts.
   *
   * Two shapes, because the launch gate means there may be no process at all:
   * restart a live one, or start the one the gate refused. Reports whether pi is
   * actually running the new decision, so the toast can't overstate it.
   */
  const applyToPi = async (): Promise<boolean> => {
    if (status && status !== "disconnected" && status !== "error") {
      return await reapplyConfig()
    }
    if (!agentType || !workingDir) return false
    try {
      await connect(agentType, workingDir)
      return true
    } catch {
      // The gate may still refuse (another unacknowledged grant, e.g. from an
      // ancestor) or the agent may fail to start. Either way the decision is
      // saved; the connection error surfaces through the normal path.
      return false
    }
  }

  /** `true` grants, `false` declines, `null` revokes an existing grant. */
  const decide = async (trusted: boolean | null) => {
    if (!current || actionDisabled) return
    setApplying(true)
    try {
      // The backend keeps codeg's acknowledgement in step with the verdict: a
      // grant counts as answered, a decline or revoke clears the record so a
      // later grant is disclosed again instead of riding on a stale "seen".
      await acpPiSetProjectTrust(current.workspace, trusted)
      setDialogOpen(false)

      if (trusted === false) {
        // Declining changes nothing about the running process — it was already
        // skipping these resources — so there is nothing to restart.
        toast.success(t("declinedToast"))
      } else {
        const applied = await applyToPi()
        if (applied) {
          toast.success(trusted ? t("trustedToast") : t("revokedToast"))
        } else {
          // Saved, but pi isn't running it yet. Claiming otherwise would be a
          // lie — it stays on its old trust state until it next starts.
          toast.success(
            trusted ? t("trustedNoReconnect") : t("revokedNoReconnect")
          )
        }
      }
      await refresh()
    } catch (error) {
      toast.error(t("saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApplying(false)
    }
  }

  /**
   * Keep an existing grant. pi's trust store is untouched — only codeg's record
   * that the user has now answered for it, which is what releases the launch
   * gate, so this also has to get pi running.
   */
  const keepGrant = async () => {
    if (!current || actionDisabled) return
    setApplying(true)
    try {
      await acpPiAcknowledgeProjectTrust(current.workspace)
      setDialogOpen(false)
      await applyToPi()
      await refresh()
    } catch (error) {
      toast.error(t("saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApplying(false)
    }
  }

  if (!visible || dismissed || !current) return null

  const executes = current.resources.some((r) => r.executesCode)
  const inherited =
    !!current.decidedAt && current.decidedAt !== current.workspace

  const bannerBody = undisclosedGrant
    ? inherited
      ? t("grantInheritedDescription")
      : t("grantDescription")
    : executes
      ? t("descriptionExecutable")
      : t("description")

  return (
    <>
      <div className="@container border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <div className="mx-auto flex w-full chat-content-w flex-col gap-1.5 @lg:flex-row @lg:items-center @lg:gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 @lg:mt-0" />
            <div className="min-w-0 leading-snug">
              <span className="font-medium">
                {undisclosedGrant ? t("grantTitle") : t("title")}
              </span>{" "}
              <span className="text-amber-700/80 dark:text-amber-300/80">
                {bannerBody}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 self-end @lg:self-auto">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
              onClick={() => setDialogOpen(true)}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("review")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0 text-amber-700/70 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300/70 dark:hover:text-amber-200"
              onClick={() => setDismissed(true)}
              aria-label={t("dismiss")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {undisclosedGrant ? t("grantDialogTitle") : t("dialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {undisclosedGrant
                ? t("grantDialogDescription")
                : t("dialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
              {current.workspace}
            </div>

            {/* Naming the deciding ancestor is the point of the disclosure: a
                single seeded parent silently covers everything beneath it. */}
            {undisclosedGrant && inherited && (
              <p className="text-xs text-muted-foreground">
                {t("inheritedFrom")}{" "}
                <span className="font-mono break-all">{current.decidedAt}</span>
              </p>
            )}

            <ul className="space-y-1.5">
              {current.resources.map((resource) => (
                <li key={resource.path} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium",
                      resource.executesCode
                        ? "bg-red-500/15 text-red-700 dark:text-red-300"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {resource.kind}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
                    {resource.path}
                  </span>
                </li>
              ))}
            </ul>

            {executes && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {undisclosedGrant
                  ? t("grantExecutionWarning")
                  : t("executionWarning")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("scopeNote")}</p>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            {undisclosedGrant ? (
              <>
                <Button
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => void decide(null)}
                >
                  {busy && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  {t("revoke")}
                </Button>
                <Button
                  disabled={actionDisabled}
                  onClick={() => void keepGrant()}
                >
                  {t("keepTrusted")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => void decide(false)}
                >
                  {t("decline")}
                </Button>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Wrapper span so the tooltip still fires while disabled
                          (disabled elements don't emit pointer events). */}
                      <span>
                        <Button
                          disabled={actionDisabled}
                          onClick={() => void decide(true)}
                        >
                          {busy && (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          )}
                          {t("trust")}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {turnInFlight && (
                      <TooltipContent>{t("disabledDuringTurn")}</TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
