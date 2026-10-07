import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import type { ReactNode } from "react"
import type {
  AgentType,
  ConnectionStatus,
  PendingPlanApprovalState,
  PendingQuestionState,
  PlanApprovalAnswer,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
  QuestionAnswer,
  SessionConfigOptionInfo,
  AsyncTaskRecord,
  SessionFailureRecord,
  SessionModeInfo,
  AvailableCommandInfo,
} from "@/lib/types"
import { ComposerStatusStrips } from "@/components/chat/composer-status-strips"
import { AsyncTaskStrip } from "@/components/chat/async-task-strip"
import type {
  PendingPermission,
  PendingQuestion,
  ClaudeApiRetryState,
} from "@/contexts/acp-connections-context"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import { ChatInput } from "@/components/chat/chat-input"
import type { ComposerInjectContent } from "@/components/chat/message-input"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { QuestionDialog } from "@/components/chat/question-dialog"
import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"

interface ConversationShellProps {
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  agentName?: string
  /** The in-flight retry line under the composer (see
   *  `ComposerStatusStrips`). The session's errors are notifications, raised by
   *  the connections provider — none is drawn here. */
  claudeApiRetry: ClaudeApiRetryState | null
  /** AIR typed session failures for this connection (active + resolved); the
   *  dock draws only the in-flight retry incidents. Omit/empty renders
   *  nothing. */
  sessionFailures?: SessionFailureRecord[]
  /** Closes an incident strip, taking every record it stands for. Passed for
   *  every surface with a live store — dismissing is client-local, so viewers
   *  get it too. */
  onSessionFailureDismiss?: (ids: string[]) => void
  /** AIR async tasks for this connection. The strip filters to the live ones
   *  itself; omit/empty renders nothing. */
  asyncTasks?: AsyncTaskRecord[]
  /** Stops one async task. Omitted for read-only surfaces — the stop buttons
   *  are then hidden, which is right: a viewer has no connection to ask. */
  onStopAsyncTask?: (taskId: string) => Promise<boolean>
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  /** Awaiting-answer multiple-choice `ask_user_question`. */
  pendingAskQuestion: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval. */
  pendingPlanApproval: PendingPlanApprovalState | null
  onFocus: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  onRespondPermission: (requestId: string, optionId: string) => void
  onAnswerQuestion: (answer: string) => void
  onAnswerAskQuestion: (
    questionId: string,
    answer: QuestionAnswer
  ) => void | Promise<void>
  onAnswerPlanApproval: (
    approvalId: string,
    answer: PlanApprovalAnswer
  ) => void | Promise<void>
  children: ReactNode
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
  hideInput?: boolean
  /** Optional banner rendered in the composer dock, where the input sits.
   *  Used with `hideInput` to explain WHY the composer is unavailable (e.g.
   *  the agent failed to load this session) without hijacking the message
   *  area above. Renders nothing when omitted. */
  composerBanner?: ReactNode
  /** Optional read-only live-feedback notes list rendered just above the
   *  composer (see `FeedbackNotesDisplay`). Renders nothing when there are no
   *  notes for the current turn. */
  feedbackList?: ReactNode
  /** Open the live-feedback dialog from the composer "+" menu (hidden when
   *  omitted / feature off). */
  onAddFeedback?: () => void
  /** Grey out the live-feedback "+" entry when a note can't be sent right now. */
  feedbackAddDisabled?: boolean
  isActive?: boolean
  /** Show the composer's flowing active-session border (tiled multi-session
   *  active tab only). Threaded straight through to the composer. */
  showActiveFlow?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (draft: PromptDraft, modeId: string | null) => void
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  /** Insert one queued item into the RUNNING turn over the session's
   *  live-feedback channel; threaded straight through to the composer's
   *  queue list. See `ChatInputProps.onQueueSteer`. */
  onQueueSteer?: (id: string) => Promise<void> | void
  editingItemId?: string | null
  editingDraftText?: string | null
  editingDraftBlocks?: PromptInputBlock[] | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
  /** Send the draft into the RUNNING turn over the session's live-feedback
   *  channel. Present only for sessions with a working delivery channel;
   *  threaded straight through to the composer. `blocks` carries the full
   *  draft when it holds more than plain text (image attachments, file
   *  badges); `text` stays the recorded/display form. Must stay in sync with
   *  `MessageInputProps.onSteer` — the optional second parameter makes a
   *  stale one-arg declaration here assignable, so tsc would NOT catch a
   *  wrapper that silently drops the blocks. */
  onSteer?: (text: string, blocks?: PromptInputBlock[]) => Promise<void>
  /** Which channel `onSteer` rides (picks the composer's honest copy);
   *  threaded straight through. See `MessageInput`. */
  steerChannel?: "native" | "pull"
  /** Optional banner pinned to the top of the panel, above the message area
   *  (e.g. the "restart to apply" config-stale banner). Renders nothing when
   *  omitted. */
  topBanner?: ReactNode
  /** Content pushed into the docked composer from outside it — currently a
   *  quoted transcript selection. Cleared by the host via `onInjectConsumed`
   *  once the composer has taken it. */
  injectContent?: ComposerInjectContent | null
  onInjectConsumed?: () => void
}

export function ConversationShell({
  status,
  promptCapabilities,
  defaultPath,
  agentName,
  claudeApiRetry,
  sessionFailures,
  onSessionFailureDismiss,
  asyncTasks,
  onStopAsyncTask,
  pendingPermission,
  pendingQuestion,
  pendingAskQuestion,
  pendingPlanApproval,
  onFocus,
  onSend,
  onCancel,
  onRespondPermission,
  onAnswerQuestion,
  onAnswerAskQuestion,
  onAnswerPlanApproval,
  children,
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
  hideInput = false,
  composerBanner,
  feedbackList,
  onAddFeedback,
  feedbackAddDisabled,
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
  topBanner,
  injectContent,
  onInjectConsumed,
}: ConversationShellProps) {
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {topBanner}

      {/* Above the transcript, not down in the composer dock: this is the state
          of work running RIGHT NOW, and pinning it here keeps it still while the
          messages scroll under it — the stop button doesn't move out from under
          the pointer. The dock below is for things that come and go with the
          turn or the connection (`ComposerStatusStrips`). */}
      {asyncTasks && asyncTasks.length > 0 && (
        <AsyncTaskStrip tasks={asyncTasks} onStop={onStopAsyncTask} />
      )}

      <div className="flex-1 min-h-0">{children}</div>

      <PermissionDialog
        permission={pendingPermission}
        onRespond={onRespondPermission}
        agentType={agentType}
      />

      <QuestionDialog question={pendingQuestion} onAnswer={onAnswerQuestion} />

      {/* Composer dock. The ask-question card sits in normal flow just above the
          feedback list and input — like the permission/question dialogs — so it
          shrinks the message list instead of covering it, while staying aligned
          to the input width. */}
      <div>
        {pendingAskQuestion && pendingAskQuestion.questions.length > 0 && (
          <div className="mx-auto w-full max-w-3xl px-4">
            <AskQuestionCard
              question={pendingAskQuestion}
              onAnswer={onAnswerAskQuestion}
            />
          </div>
        )}
        {pendingPlanApproval && (
          <div className="mx-auto w-full max-w-3xl px-4">
            {/* key on approval_id so the card always remounts (fresh in-flight /
                feedback state) if the slot is ever reused for a new approval. */}
            <PlanApprovalCard
              key={pendingPlanApproval.approval_id}
              approval={pendingPlanApproval}
              onAnswer={onAnswerPlanApproval}
            />
          </div>
        )}

        {composerBanner && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            {composerBanner}
          </div>
        )}

        {!hideInput && feedbackList && (
          <div className="mx-auto w-full max-w-3xl px-4">{feedbackList}</div>
        )}

        {!hideInput && (
          <div className="mx-auto w-full max-w-3xl">
            <ChatInput
              status={status}
              promptCapabilities={promptCapabilities}
              defaultPath={defaultPath}
              agentName={agentName}
              onFocus={onFocus}
              onSend={onSend}
              onCancel={onCancel}
              modes={modes}
              configOptions={configOptions}
              modeLoading={modeLoading}
              configOptionsLoading={configOptionsLoading}
              selectorsLoading={selectorsLoading}
              selectedModeId={selectedModeId}
              onModeChange={onModeChange}
              onConfigOptionChange={onConfigOptionChange}
              agentType={agentType}
              availableCommands={availableCommands}
              attachmentTabId={attachmentTabId}
              folderPickerOverride={folderPickerOverride}
              draftStorageKey={draftStorageKey}
              getSentHistory={getSentHistory}
              isActive={isActive}
              showActiveFlow={showActiveFlow}
              queue={queue}
              onEnqueue={onEnqueue}
              onQueueReorder={onQueueReorder}
              onQueueEdit={onQueueEdit}
              onQueueDelete={onQueueDelete}
              onQueueSteer={onQueueSteer}
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
            />
          </div>
        )}
      </div>

      <ComposerStatusStrips
        status={status}
        claudeApiRetry={claudeApiRetry}
        sessionFailures={sessionFailures}
        onSessionFailureDismiss={onSessionFailureDismiss}
      />
    </div>
  )
}
