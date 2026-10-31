"use client"

import { MessageSquareText } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CHAT_PROCESS_COLLAPSE_MODES,
  setChatProcessCollapse,
  useChatProcessCollapse,
  type ChatProcessCollapseMode,
} from "@/lib/chat-process-collapse"

export function ChatProcessSettingsSection() {
  const t = useTranslations("ChatProcessSettings")
  const mode = useChatProcessCollapse()

  return (
    <SettingsSection
      icon={MessageSquareText}
      title={t("title")}
      description={t("description")}
      htmlFor="chat-process-collapse"
      control={
        <Select
          value={mode}
          onValueChange={(value) =>
            setChatProcessCollapse(value as ChatProcessCollapseMode)
          }
        >
          <SelectTrigger id="chat-process-collapse" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHAT_PROCESS_COLLAPSE_MODES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
