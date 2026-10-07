/**
 * "Open the child's own session" — the one affordance that reaches a sub-agent's
 * actual work.
 *
 * It matters more than its size suggests. Grok and codex both run a sub-agent as
 * a full session that streams to disk while forwarding none of it over ACP, so
 * for the live card this button is the ONLY record of what the child did: the
 * result text only ever materialises when the rollout is re-parsed on reload.
 * That is why it lives in the capsule header (`AgentCapsule.headerAction`) and
 * not in the body — a body is exactly what a live sub-agent capsule does not
 * have.
 *
 * Styled as the quieter sibling of the capsule's own pill: same chip family
 * (`ws-msg-chip`, so it stays legible over a workspace background image),
 * muted until hover. The label collapses to icon-only on narrow capsules via the
 * `@container/agentcap` the header row declares — the same trick
 * `DelegationCardRow` uses for the delegation cards' identical action.
 */

import { MessagesSquare } from "lucide-react"
import { useTranslations } from "next-intl"

export function SubagentSessionButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("Folder.chat.contentParts")
  const label = t("agentSessionAction")

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="ws-msg-chip inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <MessagesSquare aria-hidden className="size-3.5 shrink-0" />
      <span className="hidden @[22rem]/agentcap:inline">{label}</span>
    </button>
  )
}
