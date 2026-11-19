"use client"

import { useTranslations } from "next-intl"
import { Clock } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TASKS_TIME_RANGES, type TasksTimeRange } from "@/lib/tasks-time-filter"
import { cn } from "@/lib/utils"

const TIME_LABEL_KEYS = {
  "24h": "timeFilter24h",
  "7d": "timeFilter7d",
  "30d": "timeFilter30d",
  all: "timeFilterAll",
} as const satisfies Record<TasksTimeRange, string>

interface TaskTimeFilterProps {
  value: TasksTimeRange
  onValueChange: (range: TasksTimeRange) => void
  compact?: boolean
}

export function TaskTimeFilter({
  value,
  onValueChange,
  compact = false,
}: TaskTimeFilterProps) {
  const t = useTranslations("Tasks")
  return (
    <Select
      value={value}
      onValueChange={(range) => onValueChange(range as TasksTimeRange)}
    >
      <SelectTrigger
        size="sm"
        aria-label={`${t("timeFilter")}: ${t(TIME_LABEL_KEYS[value])}`}
        title={t("timeFilter")}
        className={cn(
          "h-8 w-auto min-w-0 shrink-0 gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted",
          compact && "h-7 gap-1 px-2 text-xs data-[size=sm]:h-7"
        )}
      >
        {!compact ? (
          <Clock
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TASKS_TIME_RANGES.map((range) => (
          <SelectItem key={range} value={range}>
            {t(TIME_LABEL_KEYS[range])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
