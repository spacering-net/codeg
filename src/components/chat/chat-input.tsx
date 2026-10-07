"use client"

import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import { memo } from "react"
import { useTranslations } from "next-intl"
import type {
  AgentType,
  ConnectionStatus,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
  SessionConfigOptionInfo,
  SessionModeInfo,
  AvailableCommandInfo,
} from "@/lib/types"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import {
  MessageInput,
  type ComposerInjectContent,
} from "@/components/chat/message-input"
import { MessageQueueDisplay } from "@/components/chat/message-queue-display"
import { cn } from "@/lib/utils"

interface ChatInputProps {
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  agentName?: string
  onFocus?: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  modes?: SessionModeInfo[]
  configOptions?: SessionConfigOptionInfo[]
  modeLoading?: boolean
  configOptionsLoading?: boolean
  selectorsLoading?: boolean
  selectedModeId?: string | null
  onModeChange?: (modeId: string) => void
  onConfigOptionChange?: (configId: string, valueId: string) => void
  agentType?: AgentType | null
  availableCommands?: AvailableCommandInfo[] | null
  attachmentTabId?: string | null
  /** Pass-through: see `MessageInput`. */
  folderPickerOverride?: ConversationFolderPickerOverride
  draftStorageKey?: string | null
  /** Pass-through: see `MessageInput.getSentHistory`. */
  getSentHistory?: () => string[]
  isActive?: boolean
  /** Show the composer's flowing active-session border. Set only for the active
   *  tab when tiled across multiple sessions; passed through to MessageInput. */
  showActiveFlow?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (draft: PromptDraft, modeId: string | null) => void
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  /** Insert one queued item into the RUNNING turn over the session's
   *  live-feedback channel (see `MessageQueueDisplayProps.onSteerItem`).
   *  Threaded straight through; present only while a turn is in flight and
   *  the session has a working channel. */
  onQueueSteer?: (id: string) => Promise<void> | void
  editingItemId?: string | null
  editingDraftText?: string | null
  editingDraftBlocks?: PromptInputBlock[] | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
  /** Send the draft into the RUNNING turn over the session's live-feedback
   *  channel. Present only when the session has a working delivery channel
   *  (`useSessionFeedback().steerAvailable`); resolves once recorded, rejects
   *  on any failure (incl. the turn-end race) so MessageInput can run its own
   *  enqueue fallback / draft preservation. `blocks` carries the full draft
   *  when it holds more than plain text (image attachments, file badges);
   *  `text` stays the recorded/display form. Must stay in sync with
   *  `MessageInputProps.onSteer` — the optional second parameter makes a
   *  stale one-arg declaration here assignable, so tsc would NOT catch a
   *  wrapper that silently drops the blocks. */
  onSteer?: (text: string, blocks?: PromptInputBlock[]) => Promise<void>
  /** Which channel `onSteer` rides (`useSessionFeedback().channel`); picks
   *  the composer's honest copy. See `MessageInput`. */
  steerChannel?: "native" | "pull"
  onAddFeedback?: () => void
  feedbackAddDisabled?: boolean
  /**
   * Keep the composer usable even while disconnected. Set for a folderless chat
   * draft: it has no working dir yet (so it never auto-connects), and the FIRST
   * send is precisely what lazily creates its conversation + scratch dir and
   * triggers the connection. Without this the composer would be permanently
   * disabled and the chat could never be started.
   */
  allowOfflineCompose?: boolean
  injectContent?: ComposerInjectContent | null
  onInjectConsumed?: () => void
  /** Drop the input's own horizontal padding when an ancestor already supplies
   *  the gutter (the welcome column wraps this in its own `px-4`). */
  flush?: boolean
  /** Use a taller minimum height for the composer. Set for the welcome
   *  (new-conversation) composer, which sits in a roomy empty state; active and
   *  historical conversations keep the compact default. */
  tall?: boolean
}

export const ChatInput = memo(function ChatInput({
  status,
  promptCapabilities,
  defaultPath,
  agentName,
  onFocus,
  onSend,
  onCancel,
  modes,
  configOptions,
  modeLoading = false,
  configOptionsLoading = false,
  selectorsLoading = false,
  selectedModeId,
  onModeChange,
  onConfigOptionChange,
  agentType,
  availableCommands,
  attachmentTabId,
  folderPickerOverride,
  draftStorageKey,
  getSentHistory,
  isActive,
  showActiveFlow,
  queue,
  onEnqueue,
  onQueueReorder,
  onQueueEdit,
  onQueueDelete,
  onQueueSteer,
  editingItemId,
  editingDraftText,
  editingDraftBlocks,
  isEditingQueueItem,
  onSaveQueueEdit,
  onCancelQueueEdit,
  onSteer,
  steerChannel,
  onAddFeedback,
  feedbackAddDisabled,
  allowOfflineCompose = false,
  injectContent,
  onInjectConsumed,
  flush = false,
  tall = false,
}: ChatInputProps) {
  const t = useTranslations("Folder.chat.chatInput")
  const isConnected = status === "connected"
  const isPrompting = status === "prompting"
  const isConnecting = status === "connecting"
  // The agent names its slash commands as part of coming up, so until it has
  // the composer's `/` panel shows a loading row rather than refusing to open.
  //
  // `connecting` alone is not the whole wait: the backend emits `connected`
  // EARLY — before session resume/load/new — and only forwards the agent's
  // buffered command list once `selectors_ready` has fired and the conversation
  // loop is running (see `emit_selectors_ready` in acp/connection.rs). Ending
  // the loading state at `connected` would blank the panel again for the whole
  // (often slow) session-init leg. `selectorsLoading` closes exactly that gap
  // and is bounded: `selectors_ready` fires on every establishment path whether
  // or not the agent has any commands, so this can never hang on a spinner.
  const commandsLoading = isConnecting || selectorsLoading

  // Active/historical conversations dock the composer at the very bottom of the
  // message list. The attached folder/branch selector row now sits at the
  // composer's bottom edge, so the docked composer keeps only a tight bottom gap
  // (pb-1) — matching the row's own `pt-1` top gap, so the selectors read as
  // evenly spaced above and below rather than floating over a wide margin. The
  // welcome/draft composer (`flush`) uses the same pb-1 but supplies its own
  // px-4 gutter.
  return (
    <div
      className={cn("pt-0", flush ? "pb-1" : "px-4 pb-1")}
      onContextMenu={(event) => event.stopPropagation()}
      // Touch and pen open a context menu from a LONG PRESS, which Radix arms on
      // pointerdown — and the whole conversation panel (composer included) sits
      // inside its own context-menu trigger. Without this, a slow tap on any
      // composer control (the agent icon, the send button, …) pops the
      // conversation menu. Mouse presses keep bubbling, so the panel's
      // selection bookkeeping is untouched; the composer's OWN context menu
      // still arms, since its trigger is nested below this wrapper.
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") event.stopPropagation()
      }}
    >
      {queue &&
        queue.length > 0 &&
        onQueueReorder &&
        onQueueEdit &&
        onQueueDelete && (
          <MessageQueueDisplay
            queue={queue}
            onReorder={onQueueReorder}
            onEdit={onQueueEdit}
            onDelete={onQueueDelete}
            editingItemId={editingItemId ?? null}
            onSteerItem={onQueueSteer}
            steerChannel={steerChannel}
          />
        )}
      <MessageInput
        onSend={onSend}
        promptCapabilities={promptCapabilities}
        onFocus={onFocus}
        defaultPath={defaultPath}
        disabled={
          allowOfflineCompose
            ? false
            : (!isConnected && !isPrompting) || selectorsLoading
        }
        isPrompting={isPrompting}
        onCancel={onCancel}
        modes={modes}
        configOptions={configOptions}
        modeLoading={modeLoading}
        configOptionsLoading={configOptionsLoading}
        selectedModeId={selectedModeId}
        onModeChange={onModeChange}
        onConfigOptionChange={onConfigOptionChange}
        agentType={agentType}
        availableCommands={availableCommands}
        commandsLoading={commandsLoading}
        attachmentTabId={attachmentTabId}
        folderPickerOverride={folderPickerOverride}
        draftStorageKey={draftStorageKey}
        getSentHistory={getSentHistory}
        isActive={isActive}
        showActiveFlow={showActiveFlow}
        onEnqueue={onEnqueue}
        editingItemId={editingItemId}
        editingDraftText={editingDraftText}
        editingDraftBlocks={editingDraftBlocks}
        isEditingQueueItem={isEditingQueueItem}
        onSaveQueueEdit={onSaveQueueEdit}
        onCancelQueueEdit={onCancelQueueEdit}
        onSteer={onSteer}
        steerChannel={steerChannel}
        onAddFeedback={onAddFeedback}
        feedbackAddDisabled={feedbackAddDisabled}
        injectContent={injectContent}
        onInjectConsumed={onInjectConsumed}
        placeholder={
          isConnecting
            ? t("connecting")
            : isPrompting
              ? t("agentResponding", { agent: agentName ?? "Agent" })
              : t("sendMessage")
        }
        // The floor goes through `tall`, not through a `min-h-*` here: the box
        // and its editable area carry two halves of the same number, and only
        // MessageInput knows the action row that divides them.
        tall={tall}
        className="max-h-60"
      />
    </div>
  )
})

ChatInput.displayName = "ChatInput"
