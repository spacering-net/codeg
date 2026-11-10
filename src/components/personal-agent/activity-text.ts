/**
 * An assistant's step in words (8.4): what it is doing — a short line with
 * no name in front, the face beside it says whose — and what it did, as
 * "action, object, number". The backend reads the step into a kind, an
 * object and its numbers (`StepLine`); this only says it, in the owner's
 * language.
 *
 * - The vague kinds (thinking, a call of no known kind) rotate through a few
 *   wordings, picked by the turn so one turn keeps one.
 * - A command running past ten seconds is "waiting for the result".
 * - A step waiting on the owner says so, whatever it is.
 * - Work it handed out says which, in front: "#234 Fix the white screen:
 *   editing startup.rs".
 */

import { useTranslations } from "next-intl"

import type { BotActivity, StepLine } from "@/lib/types"

/** The translator of `PersonalAgent` (or a stand-in in tests). */
export type Translate = (
  key: string,
  values?: Record<string, string | number>
) => string

/** The page's translator, as the functions here take it: they build
 *  their keys. */
export function useActivityTranslate(): Translate {
  return useTranslations("PersonalAgent") as unknown as Translate
}

/** A command still running after this long waits for its result. */
export const WAIT_AFTER_MS = 10_000

/** The kinds too vague to show at once (they wait 1.5 s, 8.4). */
export const VAGUE_KINDS: ReadonlySet<string> = new Set(["think", "other"])

const THINK_WORDINGS = 3
const WORK_WORDINGS = 5

function pick(seed: number | undefined, count: number): number {
  const n = Math.abs(Math.trunc(seed ?? 0))
  return n % count
}

/** What the step is doing, as one short line. */
export function doingText(
  t: Translate,
  step: StepLine,
  opts: { turn?: number; now?: number } = {}
): string {
  if (step.awaiting) {
    return step.kind === "question"
      ? t("activity.needsAnswer")
      : t("activity.needsApproval")
  }
  const target = step.target
  switch (step.kind) {
    case "think":
      return t(`activity.think${pick(opts.turn, THINK_WORDINGS)}`)
    case "reply":
      return t("activity.reply")
    case "read":
      return target ? t("activity.read", { target }) : t("activity.readSome")
    case "edit":
      return target ? t("activity.edit", { target }) : t("activity.editSome")
    case "search":
      return target
        ? t("activity.search", { target })
        : t("activity.searchSome")
    case "fetch":
      return t("activity.fetch")
    case "execute":
    case "test": {
      const started = Date.parse(step.started_at)
      const now = opts.now ?? Date.now()
      if (
        step.status === "in_progress" &&
        Number.isFinite(started) &&
        now - started > WAIT_AFTER_MS
      ) {
        return t("activity.wait")
      }
      return step.kind === "test" ? t("activity.test") : t("activity.execute")
    }
    case "commit":
      return t("activity.commit")
    case "plan":
      return t("activity.plan")
    case "compact":
      return t("activity.compact")
    case "dispatch":
      return target
        ? t("activity.dispatch", { target })
        : t("activity.dispatchSome")
    case "followup":
      return step.dispatch_id != null
        ? t("activity.followup", { id: step.dispatch_id })
        : t("activity.followupSome")
    case "message":
      return target
        ? t("activity.message", { target })
        : t("activity.messageSome")
    case "question":
      return t("activity.needsAnswer")
    default:
      return t(`activity.work${pick(opts.turn, WORK_WORDINGS)}`)
  }
}

/** What a finished step did, as "action, object, number". */
export function doneText(t: Translate, step: StepLine): string {
  const target = step.target
  const failed = step.status === "failed"
  switch (step.kind) {
    case "edit":
      if (!target) return t("did.editSome")
      return step.added != null && step.removed != null
        ? t("did.edit", {
            target,
            added: step.added,
            removed: step.removed,
          })
        : t("did.editPlain", { target })
    case "test":
      if (step.passed != null) {
        return step.failed
          ? t("did.testFailed", { passed: step.passed, failed: step.failed })
          : t("did.test", { passed: step.passed })
      }
      if (step.exit_code != null) {
        return t("did.testExit", { code: step.exit_code })
      }
      return failed ? t("did.testBad") : t("did.testPlain")
    case "execute":
      if (!target)
        return failed ? t("did.executeSomeBad") : t("did.executeSome")
      if (step.exit_code != null) {
        return t("did.executeExit", { target, code: step.exit_code })
      }
      return failed
        ? t("did.executeBad", { target })
        : t("did.execute", { target })
    case "read":
      return target ? t("did.read", { target }) : t("did.readSome")
    case "search":
      if (!target) return t("did.searchSome")
      return step.hits != null
        ? t("did.searchHits", { target, hits: step.hits })
        : t("did.search", { target })
    case "commit":
      return target ? t("did.commit", { target }) : t("did.commitPlain")
    case "dispatch":
      if (target && step.dispatch_id != null) {
        return t("did.dispatch", { target, id: step.dispatch_id })
      }
      return step.dispatch_id != null
        ? t("did.dispatchPlain", { id: step.dispatch_id })
        : t("did.dispatchSome")
    case "followup":
      return step.dispatch_id != null
        ? t("did.followup", { id: step.dispatch_id })
        : t("did.followupSome")
    case "message":
      return target ? t("did.message", { target }) : t("did.messageSome")
    case "think":
      return t("did.think")
    case "reply":
      return t("did.reply")
    case "plan":
      return t("did.plan")
    case "compact":
      return t("did.compact")
    case "fetch":
      return t("did.fetch")
    case "question":
      return target ? t("did.question", { target }) : t("did.questionSome")
    default:
      return target ? t("did.other", { target }) : t("did.otherPlain")
  }
}

/** A step in its list: what it did once it ended, else what it is doing. */
export function stepText(t: Translate, step: StepLine, now?: number): string {
  return step.status === "completed" || step.status === "failed"
    ? doneText(t, step)
    : doingText(t, step, { now })
}

/** What an assistant is doing, with the work it is from in front. */
export function activityText(
  t: Translate,
  activity: BotActivity,
  now?: number
): string {
  const doing = doingText(t, activity.step, { turn: activity.turn, now })
  return activity.work
    ? t("activity.workPrefix", {
        id: activity.work.dispatch_id,
        title: activity.work.title,
        activity: doing,
      })
    : doing
}
