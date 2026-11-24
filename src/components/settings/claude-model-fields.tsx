"use client"

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import {
  ModelIdInputWithFetch,
  ModelIdListField,
} from "@/components/settings/provider-models"
import type { ProviderModelsState } from "@/hooks/use-provider-models"
import type { ClaudeProviderModel } from "@/lib/types"

/** The extra rows codeg adds to Claude Code's /model picker, for codeg's own
 *  sessions. */
export function ClaudePickerModelsField({
  ids,
  onChange,
  state,
  readOnly = false,
}: {
  ids: string[]
  onChange: (ids: string[]) => void
  /** The provider's models; `null` where they cannot be fetched. */
  state: ProviderModelsState | null
  /** The ids come from a bound provider and are edited there. */
  readOnly?: boolean
}) {
  const t = useTranslations("ProviderModels.claudePicker")
  return (
    <ModelIdListField
      ids={ids}
      onChange={onChange}
      state={state}
      readOnly={readOnly}
      title={t("title")}
      hint={readOnly ? t("managedByProvider") : t("hint")}
    />
  )
}

type ClaudeModelKey =
  | "main"
  | "reasoning"
  | "haiku"
  | "sonnet"
  | "opus"
  | "fable"
  | "customOption"

/** The model fields of a Claude provider, each with its label key in
 *  `ModelProviderSettings` and a placeholder. */
const CLAUDE_MODEL_FIELDS: ReadonlyArray<{
  key: ClaudeModelKey
  label:
    | "claudeMainModel"
    | "claudeReasoningModel"
    | "claudeHaikuDefaultModel"
    | "claudeSonnetDefaultModel"
    | "claudeOpusDefaultModel"
    | "claudeFableDefaultModel"
    | "claudeCustomModelOption"
  placeholder: string
  wide?: boolean
}> = [
  { key: "main", label: "claudeMainModel", placeholder: "claude-sonnet-5-5" },
  {
    key: "reasoning",
    label: "claudeReasoningModel",
    placeholder: "claude-opus-5-5",
  },
  {
    key: "haiku",
    label: "claudeHaikuDefaultModel",
    placeholder: "claude-haiku-5-5",
  },
  {
    key: "sonnet",
    label: "claudeSonnetDefaultModel",
    placeholder: "claude-sonnet-5-5",
  },
  {
    key: "opus",
    label: "claudeOpusDefaultModel",
    placeholder: "claude-opus-5-5",
  },
  {
    key: "fable",
    label: "claudeFableDefaultModel",
    placeholder: "claude-fable-5-2",
  },
  {
    key: "customOption",
    label: "claudeCustomModelOption",
    placeholder: "my-gateway/claude-opus-5-5",
    wide: true,
  },
]

/** A Claude provider's model JSON, edited in a provider dialog: the model
 *  fields (each listing the provider's models from its chevron), the custom
 *  option's name and description, and the extra picker rows. */
export function ClaudeProviderModelFields({
  value,
  onChange,
  state,
}: {
  value: ClaudeProviderModel
  onChange: (next: ClaudeProviderModel) => void
  state: ProviderModelsState
}) {
  const t = useTranslations("ModelProviderSettings")
  const set = (patch: Partial<ClaudeProviderModel>) =>
    onChange({ ...value, ...patch })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {CLAUDE_MODEL_FIELDS.map((field) => (
          <div
            key={field.key}
            className={field.wide ? "space-y-1.5 md:col-span-2" : "space-y-1.5"}
          >
            <label className="text-xs font-medium">{t(field.label)}</label>
            <ModelIdInputWithFetch
              aria-label={t(field.label)}
              value={value[field.key] ?? ""}
              onChange={(next) => set({ [field.key]: next })}
              state={state}
              placeholder={field.placeholder}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <label className="text-xs font-medium">
            {t("claudeCustomModelOptionName")}
          </label>
          <Input
            value={value.customOptionName ?? ""}
            onChange={(e) => set({ customOptionName: e.target.value })}
            placeholder="Gateway Opus"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">
            {t("claudeCustomModelOptionDescription")}
          </label>
          <Input
            value={value.customOptionDescription ?? ""}
            onChange={(e) => set({ customOptionDescription: e.target.value })}
            placeholder="Routed via custom gateway"
          />
        </div>
        <p className="text-2xs text-muted-foreground md:col-span-2">
          {t("claudeCustomModelOptionHint")}
        </p>
      </div>
      <ClaudePickerModelsField
        ids={value.pickerModels ?? []}
        onChange={(ids) => set({ pickerModels: ids })}
        state={state}
      />
    </div>
  )
}
