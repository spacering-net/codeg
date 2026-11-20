"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ModelEntryDraft } from "@/lib/model-provider-types"
import { cn } from "@/lib/utils"

export type ModelTestState = "idle" | "loading" | "ok" | "err"

interface ModelProviderModelRowProps {
  entry: ModelEntryDraft
  testState: ModelTestState
  testDetail?: string
  canTest: boolean
  onPatch: (patch: Partial<ModelEntryDraft>) => void
  onRemove: () => void
  onTest: () => void
}

/** One model row inside the provider editor: model id + metadata + per-model
 *  probe ("test") and removal, mirroring pios's model-row layout. */
export function ModelProviderModelRow({
  entry,
  testState,
  testDetail,
  canTest,
  onPatch,
  onRemove,
  onTest,
}: ModelProviderModelRowProps) {
  const t = useTranslations("ModelProviderSettings")
  const [expanded, setExpanded] = useState(false)

  const setNumber = (key: "contextWindow" | "maxTokens", raw: string) =>
    onPatch({ [key]: raw.trim() })

  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md border px-2 py-2",
        testState === "err" && "border-destructive/40"
      )}
    >
      <div className="flex items-start gap-1.5">
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-[1.2fr_6rem_6rem_6rem_auto]">
          <div className="space-y-0.5">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("modelId")}
            </Label>
            <Input
              value={entry.id}
              placeholder="gpt-5.1"
              className="h-7 text-xs"
              onChange={(e) => onPatch({ id: e.target.value })}
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("contextWindow")}
            </Label>
            <Input
              type="number"
              value={entry.contextWindow ?? ""}
              placeholder="128000"
              className="h-7 text-xs"
              onChange={(e) => setNumber("contextWindow", e.target.value)}
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("maxOutput")}
            </Label>
            <Input
              type="number"
              value={entry.maxTokens ?? ""}
              placeholder="8192"
              className="h-7 text-xs"
              onChange={(e) => setNumber("maxTokens", e.target.value)}
            />
          </div>
          <div className="space-y-0.5">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("inputKind")}
            </Label>
            <Select
              value={entry.input}
              onValueChange={(v) =>
                onPatch({ input: v as ModelEntryDraft["input"] })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text" className="text-xs">
                  {t("text")}
                </SelectItem>
                <SelectItem value="text-image" className="text-xs">
                  {t("textImage")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-1">
            <label className="flex h-7 items-center gap-1.5 pb-0.5">
              <Switch
                checked={entry.reasoning}
                onCheckedChange={(v) => onPatch({ reasoning: v })}
                aria-label={t("reasoning")}
              />
              <span className="text-2xs text-muted-foreground">
                {t("reasoning")}
              </span>
            </label>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground",
              testState === "ok" && "text-emerald-500",
              testState === "err" && "text-destructive"
            )}
            disabled={!canTest || testState === "loading"}
            onClick={onTest}
            title={testDetail ?? t("testModel")}
            aria-label={t("testModel")}
          >
            {testState === "loading" ? (
              <Play className="h-3.5 w-3.5 animate-pulse" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={t("removeModel")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {testDetail && testState !== "idle" && (
        <p
          className={cn(
            "truncate text-2xs",
            testState === "ok" ? "text-emerald-500" : "text-destructive"
          )}
          title={testDetail}
        >
          {testDetail}
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {t("advanced")}
      </button>

      {expanded && (
        <div className="space-y-1 border-t pt-1.5">
          <Label className="text-2xs font-medium text-muted-foreground">
            {t("baseInstructions")}
          </Label>
          <Textarea
            value={entry.baseInstructions ?? ""}
            rows={3}
            className="max-h-24 resize-y font-mono text-2xs"
            placeholder={t("baseInstructionsPlaceholder")}
            onChange={(e) =>
              onPatch({
                baseInstructions: e.target.value || undefined,
              })
            }
          />
        </div>
      )}
    </div>
  )
}
