"use client"

import type { ReactNode } from "react"
import { Search, X } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

export function AuxPanelSearchToolbar({
  query,
  onQueryChange,
  placeholder,
  type = "text",
  children,
}: {
  query: string
  onQueryChange: (query: string) => void
  placeholder: string
  type?: "text" | "search"
  children: ReactNode
}) {
  const t = useTranslations("Tasks")

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
      <InputGroup className="h-7 min-w-0 flex-1 rounded-full">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type={type}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault()
              onQueryChange("")
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-7 text-xs [&::-webkit-search-cancel-button]:hidden"
        />
        {query !== "" && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={t("clearSearch")}
              title={t("clearSearch")}
              onClick={() => onQueryChange("")}
            >
              <X className="size-3" aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      {children}
    </div>
  )
}
