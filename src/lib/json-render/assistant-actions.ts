import { z } from "zod"

/**
 * The three actions only an assistant's cards have (9.2): a button that
 * says something to the assistant in the owner's name, one that closes or
 * snoozes one of its open matters, one that opens a place in codeg. Session
 * cards have none of them.
 *
 * These are only the definitions — what the assistant's `ui-render.md`
 * tells its brain (`./skill.ts`). The renderer that runs them is the
 * assistants page's own card (`components/personal-agent/pa-json-render`).
 * json-render's prompt lists an action's name and description, never its
 * parameters, so each description spells its parameters out.
 */

export const PA_REPLY = "pa.reply"
export const PA_ITEM = "pa.item"
export const PA_OPEN = "pa.open"

export const ASSISTANT_ACTION_NAMES = [PA_REPLY, PA_ITEM, PA_OPEN] as const
export type AssistantActionName = (typeof ASSISTANT_ACTION_NAMES)[number]

export function isAssistantAction(name: unknown): name is AssistantActionName {
  return (
    typeof name === "string" &&
    (ASSISTANT_ACTION_NAMES as readonly string[]).includes(name)
  )
}

/** Where `pa.open` can go. */
export const PA_OPEN_TARGETS = [
  "dispatch",
  "task",
  "session",
  "item",
  "bot",
  "exchange",
  "routine",
  "url",
] as const
export type PaOpenTarget = (typeof PA_OPEN_TARGETS)[number]

export const PA_ITEM_OPS = ["done", "drop", "snooze"] as const
export type PaItemOp = (typeof PA_ITEM_OPS)[number]

export const assistantActionDefinitions = {
  [PA_REPLY]: {
    params: z.object({ text: z.string().nullable() }),
    description:
      'The owner says the button\'s label to you, as their message quoting this card — write the label as they would say it ("Go with plan A"). Params: { text?: string } — a message to send instead of the label, built from the card\'s state with {"$template": …} or {"$state": …} (a form\'s fields); the owner sees it in full and confirms before it is sent.',
  },
  [PA_ITEM]: {
    params: z.object({
      id: z.number(),
      op: z.enum(PA_ITEM_OPS),
      until: z.string().nullable(),
    }),
    description:
      'Close or put off one of your open matters, without a turn of yours. Params: { id: number — the matter\'s id from item_list, op: "done" | "drop" | "snooze", until?: "15m" | "1h" | "tomorrow" | an ISO 8601 time with its offset — snooze only: when it comes due again ("tomorrow" is tomorrow morning); without it the matter waits on time with no due } — done on a repeating matter finishes this time and schedules the next; drop asks the owner first.',
  },
  [PA_OPEN]: {
    params: z.object({
      target: z.enum(PA_OPEN_TARGETS),
      id: z.number().nullable(),
      url: z.string().nullable(),
    }),
    description:
      'Open a place in codeg. Params: { target: "dispatch" | "task" | "session" | "item" | "bot" | "exchange" | "routine" | "url", id?: number, url?: string } — id is the dispatch, board task, session (conversation), open matter, assistant, message thread or routine number; url is a web address, for target "url".',
  },
}
