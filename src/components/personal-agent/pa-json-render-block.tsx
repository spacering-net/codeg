"use client"

/**
 * A card in an assistant's own reply (9.2): the session's card — the same
 * components, compiler and guards (`message/json-render-block.tsx`) — whose
 * buttons can act for the owner with the assistant's three actions:
 *
 * - `pa.reply` says the button's label to the assistant as the owner's
 *   message, quoting this reply; a different `text` (a form's fields) is
 *   shown in full first, to send, put in the composer or drop;
 * - `pa.item` closes or snoozes one of its open matters — until a time
 *   when it carries one (`until`) — without a turn of its own (`drop` asks
 *   first);
 * - `pa.open` opens a place in codeg.
 *
 * What makes a click count: the spec is sanitized on every compile
 * (`lib/json-render/pa-spec.ts`), so an action can only be a Button's or a
 * Link's lone press; the button records a one-use credential on the
 * owner's own click (`isOwnerGesture`) — which card, which element, which
 * action, its label and parameters as rendered — and the handler runs only
 * when it takes a fresh, unused credential for its own action and element.
 * Nothing else (a watch, a chain, a script's click) can make it speak.
 *
 * What the owner did stays on the reply row (`data.card_acts`): a picked
 * option shows as picked and the others in its container grey out, a
 * closed matter shows as done, in every window and after a reload. Buttons
 * wait while the reply is still written and on a read-only page.
 *
 * json-render's ActionProvider takes its handlers once, at mount: they read
 * the page through refs. They catch their own errors (a toast), and dedupe
 * a click still in flight — the library does not disable a button while its
 * action runs.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { Check, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import {
  ActionProvider,
  Renderer,
  StateProvider,
  ValidationProvider,
  VisibilityProvider,
  defineRegistry,
  useActions,
  useRepeatScope,
  type BaseComponentProps,
} from "@json-render/react"
import type { Spec } from "@json-render/core"
import type { ShadcnProps } from "@json-render/shadcn"
import type { LinkSafetyModalProps } from "streamdown"
import { StreamdownContext } from "streamdown"

import {
  openExternalTab,
  openLinkWithSafety,
  useStreamdownLinkSafety,
} from "@/components/ai-elements/link-safety"
import {
  jsonRenderComponents,
  renderableSpec,
} from "@/components/message/json-render-block"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  personalAgentCardAct,
  personalAgentDispatches,
  personalAgentItemAct,
  personalAgentItems,
  personalAgentSend,
  personalAgentThread,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  PA_ITEM,
  PA_ITEM_OPS,
  PA_OPEN,
  PA_OPEN_TARGETS,
  PA_REPLY,
  isAssistantAction,
  type AssistantActionName,
  type PaItemOp,
  type PaOpenTarget,
} from "@/lib/json-render/assistant-actions"
import { jsonRenderCatalog } from "@/lib/json-render/catalog"
import {
  cardIdOf,
  elementIdOf,
  parseElementId,
  sanitizeAssistantSpec,
  type PaMarks,
} from "@/lib/json-render/pa-spec"
import type { CardAct, ItemInfo, TimelineRow } from "@/lib/types"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { ExchangeSheet } from "./exchange-sheet"
import { usePaCardScope } from "./pa-card-scope"
import { isOwnerGesture } from "./pa-gesture"
import { useSessionLinkOpener } from "./session-link"
import { usePageScope, useOpenWork, workTargetOf } from "./shared"

/** How long a click's credential waits for its handler. */
const CREDENTIAL_MS = 1500

/** One click of the owner's, for the one handler it is for. */
interface Credential {
  cardId: string
  key: string
  elementId: string
  action: AssistantActionName
  label: string
  /** The binding's parameters as the button rendered them. */
  params: Record<string, unknown>
  at: number
}

interface CardRuntime {
  cardId: string
  /** Every button waits: the reply is still written, the page reads only. */
  waiting: boolean
  /** Elements whose action is in flight. */
  busy: ReadonlySet<string>
  /** What the owner did, by element id, on this card. */
  acts: Readonly<Record<string, CardAct>>
  /** The picked `pa.reply` of each container (parent and repeat item). */
  picked: ReadonlyMap<string, string>
  usable: (
    action: AssistantActionName,
    params: Record<string, unknown>
  ) => boolean
  record: (credential: Credential) => void
}

const RuntimeContext = createContext<CardRuntime | null>(null)

/** A button's container: its parent element, and — inside a repeat —
 *  which item. */
function groupOf(parent: unknown, repeat: string | null | undefined): string {
  return `${typeof parent === "string" ? parent : ""}|${repeat ?? ""}`
}

function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0
}

function isWebUrl(v: unknown): v is string {
  return typeof v === "string" && /^(https?:|mailto:)/i.test(v.trim())
}

/** What a marked button knows about itself, or `null` for a plain one. */
function useMarked(props: Record<string, unknown>) {
  const runtime = useContext(RuntimeContext)
  const repeat = useRepeatScope()
  const marks = props as PaMarks
  const action = marks.__paAction
  const key = marks.__paKey
  if (!runtime || !isAssistantAction(action) || typeof key !== "string") {
    return null
  }
  const params =
    marks.__paParams && typeof marks.__paParams === "object"
      ? (marks.__paParams as Record<string, unknown>)
      : {}
  const elementId = elementIdOf(runtime.cardId, key, repeat?.basePath)
  const label = typeof props.label === "string" ? props.label : ""
  const act = action === PA_OPEN ? undefined : runtime.acts[elementId]
  const pickedHere =
    action === PA_REPLY
      ? runtime.picked.get(groupOf(marks.__paParent, repeat?.basePath))
      : undefined
  const done = act != null
  const greyed = !done && pickedHere != null && pickedHere !== elementId
  const busy = runtime.busy.has(elementId)
  const disabled =
    runtime.waiting ||
    props.disabled === true ||
    done ||
    greyed ||
    busy ||
    !label.trim() ||
    !runtime.usable(action, params)
  return {
    done,
    busy,
    disabled,
    press: (event: React.MouseEvent, emit: () => void) => {
      // A script's click is not the owner's: it does nothing at all.
      if (!isOwnerGesture(event)) return
      runtime.record({
        cardId: runtime.cardId,
        key,
        elementId,
        action,
        label: label.trim(),
        params,
        at: Date.now(),
      })
      emit()
    },
  }
}

const PlainButton = jsonRenderComponents.Button
const PlainLink = jsonRenderComponents.Link

function PaButton(ctx: BaseComponentProps<ShadcnProps<"Button">>) {
  const { props, emit } = ctx
  const marked = useMarked(props as Record<string, unknown>)
  if (!marked) return <PlainButton {...ctx} />
  const variant =
    props.variant === "danger"
      ? "destructive"
      : props.variant === "secondary"
        ? "secondary"
        : "default"
  return (
    <Button
      type="button"
      variant={variant}
      disabled={marked.disabled}
      data-pa-card-button={marked.done ? "done" : ""}
      aria-pressed={marked.done || undefined}
      onClick={(event) => marked.press(event, () => emit("press"))}
    >
      {marked.busy ? (
        <SyncedSpinner small />
      ) : marked.done ? (
        <Check aria-hidden />
      ) : null}
      {props.label}
    </Button>
  )
}

function PaLink(ctx: BaseComponentProps<ShadcnProps<"Link">>) {
  const { props, emit } = ctx
  const marked = useMarked(props as Record<string, unknown>)
  if (!marked) return <PlainLink {...ctx} />
  return (
    <button
      type="button"
      disabled={marked.disabled}
      data-pa-card-button={marked.done ? "done" : ""}
      onClick={(event) => marked.press(event, () => emit("press"))}
      className="inline-flex appearance-none items-center gap-1 text-left text-sm font-medium text-primary underline disabled:cursor-default disabled:no-underline disabled:opacity-50"
    >
      {marked.done ? <Check className="size-3.5" aria-hidden /> : null}
      {props.label}
    </button>
  )
}

const { registry } = defineRegistry(jsonRenderCatalog, {
  components: { ...jsonRenderComponents, Button: PaButton, Link: PaLink },
})

/** json-render's own confirmation (an action bound with `confirm`), drawn
 *  as codeg draws one: the library's dialog has no theme. */
function LibraryConfirmation() {
  const t = useTranslations("PersonalAgent.card")
  const { pendingConfirmation, confirm, cancel } = useActions()
  const asked = pendingConfirmation?.action.confirm
  return (
    <AlertDialog
      open={asked != null}
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{asked?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>
            {asked?.message ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {asked?.cancelLabel ?? t("cancel")}
          </AlertDialogCancel>
          <Button
            variant={asked?.variant === "danger" ? "destructive" : "default"}
            onClick={confirm}
          >
            {asked?.confirmLabel ?? t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The longest `until` a snooze button may carry. */
const MAX_UNTIL_CHARS = 64

/** A `pa.item` button's `until`: undefined when it has none (or for an op
 *  other than snooze, which ignores it), false when it is not a short
 *  string — such a button is not offered. The backend reads what it says
 *  (`15m`, `1h`, `tomorrow`, an ISO 8601 time) and refuses what it cannot. */
function untilOf(params: Record<string, unknown>): string | undefined | false {
  if (params.op !== "snooze" || params.until == null) return undefined
  const until = params.until
  if (typeof until !== "string") return false
  const trimmed = until.trim()
  if (!trimmed || trimmed.length > MAX_UNTIL_CHARS) return false
  return trimmed
}

type Pending =
  | { kind: "reply"; text: string; label: string; elementId: string }
  | {
      kind: "drop"
      item: ItemInfo
      label: string
      elementId: string
    }

export default function PaJsonRenderBlock({
  source,
  fallback,
}: {
  source: string
  fallback: ReactNode
}) {
  const scope = usePaCardScope()
  const { mode } = useContext(StreamdownContext)
  const compiled = useMemo(() => {
    const spec = renderableSpec(source)
    return spec ? sanitizeAssistantSpec(spec) : null
  }, [source])
  if (!compiled || !scope) return <>{fallback}</>
  return (
    <PaCard
      spec={compiled.spec}
      stripped={compiled.stripped}
      source={source}
      streaming={mode === "streaming"}
    />
  )
}

function PaCard({
  spec,
  stripped,
  source,
  streaming,
}: {
  spec: Spec
  stripped: boolean
  source: string
  streaming: boolean
}) {
  const t = useTranslations("PersonalAgent.card")
  const scope = usePaCardScope()!
  const page = usePageScope()
  const { botId, itemVersion, dispatchById, snapshot } = usePersonalAgent()
  const roster = usePersonalAgentRoster((s) => s.entries)
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const showAux = usePersonalAgentUi((s) => s.showAux)
  const openWork = useOpenWork()
  const openSession = useSessionLinkOpener()
  const linkSafety = useStreamdownLinkSafety()
  const cardId = useMemo(() => cardIdOf(source), [source])

  // What the owner already did with this card's buttons.
  const acts = useMemo(() => {
    const out: Record<string, CardAct> = {}
    for (const [id, act] of Object.entries(scope.cardActs)) {
      if (parseElementId(id)?.cardId === cardId) out[id] = act
    }
    return out
  }, [scope.cardActs, cardId])
  const picked = useMemo(() => {
    const out = new Map<string, string>()
    for (const [id, act] of Object.entries(acts)) {
      if (act.action !== PA_REPLY) continue
      const parsed = parseElementId(id)
      if (!parsed) continue
      const parent = (spec.elements[parsed.key]?.props as PaMarks | undefined)
        ?.__paParent
      out.set(groupOf(parent, parsed.repeat), id)
    }
    return out
  }, [acts, spec])

  // The assistant's open matters, for a card that closes one.
  const needsItems = useMemo(
    () =>
      Object.values(spec.elements).some(
        (el) => (el?.props as PaMarks | undefined)?.__paAction === PA_ITEM
      ),
    [spec]
  )
  const [items, setItems] = useState<ReadonlyMap<number, ItemInfo> | null>(null)
  useEffect(() => {
    if (!needsItems) return
    let live = true
    personalAgentItems("active", botId)
      .then((list) => {
        if (live) setItems(new Map(list.map((i) => [i.id, i])))
      })
      .catch(() => {
        if (live) setItems(new Map())
      })
    return () => {
      live = false
    }
  }, [needsItems, botId, itemVersion])

  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState<Pending | null>(null)
  const [exchange, setExchange] = useState<TimelineRow | null>(null)
  const [linkUrl, setLinkUrl] = useState<string | null>(null)

  const waiting = scope.running || streaming || page.readOnly

  const usable = (
    action: AssistantActionName,
    params: Record<string, unknown>
  ): boolean => {
    switch (action) {
      case PA_REPLY:
        return true
      case PA_ITEM:
        return (
          isId(params.id) &&
          PA_ITEM_OPS.includes(params.op as PaItemOp) &&
          untilOf(params) !== false &&
          items != null &&
          items.has(params.id)
        )
      case PA_OPEN: {
        const target = params.target as PaOpenTarget
        if (!PA_OPEN_TARGETS.includes(target)) return false
        if (target === "url") return isWebUrl(params.url)
        if (!isId(params.id)) return false
        if (target === "bot" && roster != null) {
          return roster.some((e) => e.id === params.id)
        }
        return true
      }
    }
  }

  // The page as it is now, for the handlers json-render took at mount.
  const latest = useRef({
    scope,
    page,
    botId,
    items,
    dispatchById,
    roster,
    snapshot,
    waiting,
  })
  useEffect(() => {
    latest.current = {
      scope,
      page,
      botId,
      items,
      dispatchById,
      roster,
      snapshot,
      waiting,
    }
  })
  const cardIdRef = useRef(cardId)
  useEffect(() => {
    cardIdRef.current = cardId
  }, [cardId])
  const credential = useRef<Credential | null>(null)
  const inFlight = useRef(new Set<string>())
  const navigation = useRef({
    setViewBot,
    showAux,
    openWork,
    openSession,
    linkSafety,
  })
  useEffect(() => {
    navigation.current = {
      setViewBot,
      showAux,
      openWork,
      openSession,
      linkSafety,
    }
  })

  const runtime = useMemo<CardRuntime>(
    () => ({
      cardId,
      waiting,
      busy,
      acts,
      picked,
      usable,
      record: (c) => {
        credential.current = c
      },
    }),
    // `usable` reads items and the roster, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardId, waiting, busy, acts, picked, items, roster]
  )

  /** Start an action's work, at most once per element at a time. */
  const track = (elementId: string, work: () => Promise<unknown>) => {
    if (inFlight.current.has(elementId)) return
    inFlight.current.add(elementId)
    setBusy(new Set(inFlight.current))
    work()
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => {
        inFlight.current.delete(elementId)
        setBusy(new Set(inFlight.current))
      })
  }

  const sendReply = (text: string, label: string, elementId: string) => {
    const { scope: s, botId: bot } = latest.current
    track(elementId, () =>
      personalAgentSend(text, null, s.rowId, bot, { element: elementId, label })
    )
  }

  const actOnItem = (
    item: ItemInfo,
    op: PaItemOp,
    label: string,
    elementId: string,
    until?: string
  ) => {
    const { scope: s, botId: bot } = latest.current
    track(elementId, async () => {
      if (op === "snooze" && until) {
        await personalAgentItemAct(bot, item.id, "snooze", until)
      } else {
        await personalAgentItemAct(bot, item.id, op)
      }
      await personalAgentCardAct(bot, s.rowId, elementId, {
        action: PA_ITEM,
        label,
        op,
      })
    })
  }

  const open = (params: Record<string, unknown>) => {
    const nav = navigation.current
    const {
      dispatchById: byId,
      botId: bot,
      roster: bots,
      page: p,
      snapshot: snap,
    } = latest.current
    const target = params.target as PaOpenTarget
    const id = params.id
    switch (target) {
      case "url": {
        if (!isWebUrl(params.url)) return
        const url = params.url.trim()
        openLinkWithSafety(url, nav.linkSafety, () => setLinkUrl(url))
        return
      }
      case "session":
        if (isId(id)) nav.openSession(id)
        return
      case "item":
        nav.showAux("details")
        return
      case "task":
        if (isId(id)) {
          nav.openWork({
            ...workTargetOf(undefined, null),
            mode: "task",
            workTaskId: id,
          })
        }
        return
      case "dispatch": {
        if (!isId(id)) return
        const held = byId.get(id)
        if (held) {
          nav.openWork(workTargetOf(held))
          return
        }
        personalAgentDispatches(null, null, [id], bot)
          .then((list) => {
            const info = list.find((d) => d.id === id)
            if (!info) throw new Error(t("notFound"))
            nav.openWork(workTargetOf(info))
          })
          .catch((e) => toast.error(toErrorMessage(e)))
        return
      }
      case "bot": {
        const entry = bots?.find((e) => e.id === id)
        if (!entry) {
          toast.error(t("notFound"))
          return
        }
        nav.setViewBot(entry.kind === "primary" ? null : entry.id)
        return
      }
      case "exchange": {
        if (!isId(id)) return
        for (const row of p.rowsById.values()) {
          if (row.kind === "exchange" && row.data?.thread_id === id) {
            setExchange(row)
            return
          }
        }
        const me = snap?.agent?.id ?? null
        personalAgentThread(id, bot)
          .then((view) => {
            const m = view.messages.find(
              (x) => x.from_bot_id === me || x.to_bot_id === me
            )
            if (!m || me == null) throw new Error(t("notFound"))
            const peer = m.from_bot_id === me ? m.to_bot_id : m.from_bot_id
            setExchange({
              id: -id,
              segment_id: null,
              batch_id: null,
              kind: "exchange",
              status: null,
              body: "",
              data: {
                thread_id: id,
                direction: "out",
                from_bot_id: me,
                to_bot_id: peer,
              },
              dispatch_id: null,
              ref_id: null,
              reply_to: null,
              read_at: null,
              event_id: null,
              seen_at: null,
              created_at: m.created_at,
              updated_at: m.created_at,
            })
          })
          .catch((e) => toast.error(toErrorMessage(e)))
        return
      }
    }
  }

  /** The one place an assistant action runs: only with the owner's click
   *  for this very action and element. Never throws. */
  const run = (
    action: AssistantActionName,
    params: Record<string, unknown>
  ) => {
    try {
      const c = credential.current
      credential.current = null
      if (
        !c ||
        c.action !== action ||
        c.key !== params.__el ||
        c.cardId !== cardIdRef.current ||
        Date.now() - c.at > CREDENTIAL_MS ||
        latest.current.waiting ||
        inFlight.current.has(c.elementId)
      ) {
        return
      }
      const p = c.params
      switch (action) {
        case PA_REPLY: {
          const text = typeof p.text === "string" ? p.text.trim() : ""
          if (text && text !== c.label) {
            setPending({
              kind: "reply",
              text,
              label: c.label,
              elementId: c.elementId,
            })
            return
          }
          if (c.label) sendReply(c.label, c.label, c.elementId)
          return
        }
        case PA_ITEM: {
          const item = isId(p.id) ? latest.current.items?.get(p.id) : undefined
          const op = p.op as PaItemOp
          if (!item || !PA_ITEM_OPS.includes(op)) return
          if (op === "drop") {
            setPending({
              kind: "drop",
              item,
              label: c.label,
              elementId: c.elementId,
            })
            return
          }
          const until = untilOf(p)
          if (until === false) return
          actOnItem(item, op, c.label, c.elementId, until)
          return
        }
        case PA_OPEN:
          open(p)
          return
      }
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  const handlers = useMemo(
    () => ({
      [PA_REPLY]: (params: Record<string, unknown>) =>
        runRef.current(PA_REPLY, params ?? {}),
      [PA_ITEM]: (params: Record<string, unknown>) =>
        runRef.current(PA_ITEM, params ?? {}),
      [PA_OPEN]: (params: Record<string, unknown>) =>
        runRef.current(PA_OPEN, params ?? {}),
    }),
    []
  )

  const linkModal: LinkSafetyModalProps | null = linkUrl
    ? {
        url: linkUrl,
        isOpen: true,
        onClose: () => setLinkUrl(null),
        onConfirm: () => openExternalTab(linkUrl),
      }
    : null

  return (
    <div
      className="relative my-3 w-full min-w-0"
      data-json-render=""
      data-pa-card
    >
      <RuntimeContext.Provider value={runtime}>
        <StateProvider initialState={spec.state ?? {}}>
          <VisibilityProvider>
            <ValidationProvider>
              <ActionProvider handlers={handlers}>
                <Renderer spec={spec} registry={registry} loading={streaming} />
                <LibraryConfirmation />
              </ActionProvider>
            </ValidationProvider>
          </VisibilityProvider>
        </StateProvider>
      </RuntimeContext.Provider>
      {stripped ? (
        <p
          className="mt-1 flex items-center justify-end gap-1 text-[0.6875rem] text-muted-foreground"
          data-pa-card-stripped
        >
          <ShieldOff className="size-3" aria-hidden />
          {t("stripped")}
        </p>
      ) : null}
      <AlertDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) setPending(null)
        }}
      >
        <AlertDialogContent data-pa-card-confirm={pending?.kind}>
          {pending?.kind === "reply" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("reply.title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("reply.description", { label: pending.label })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <pre
                className="max-h-[50vh] overflow-auto rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words"
                data-pa-card-confirm-text
              >
                {pending.text}
              </pre>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                {page.onDraft ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      page.onDraft?.(scope.rowId, pending.text)
                      setPending(null)
                    }}
                    data-pa-card-to-composer
                  >
                    {t("reply.toComposer")}
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    sendReply(pending.text, pending.label, pending.elementId)
                    setPending(null)
                  }}
                  data-pa-card-send
                >
                  {t("reply.send")}
                </Button>
              </AlertDialogFooter>
            </>
          ) : pending?.kind === "drop" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("drop.title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("drop.description", { summary: pending.item.summary })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={() => {
                    actOnItem(
                      pending.item,
                      "drop",
                      pending.label,
                      pending.elementId
                    )
                    setPending(null)
                  }}
                  data-pa-card-drop
                >
                  {t("drop.confirm")}
                </Button>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
      <ExchangeSheet row={exchange} onClose={() => setExchange(null)} />
      {linkModal && linkSafety.renderModal
        ? linkSafety.renderModal(linkModal)
        : null}
    </div>
  )
}
