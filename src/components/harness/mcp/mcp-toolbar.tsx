"use client"

import {
  ChevronDown,
  ClipboardPaste,
  Compass,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  DEFAULT_DISCOVER_FILTERS,
  DISCOVER_DETAIL,
  DISCOVER_FILTERS,
  type DiscoverFilters,
} from "@/lib/harness/discover-state"
import type { McpHarnessSeam } from "@/lib/harness/mcp-marks"
import {
  MCP_FILTERS,
  MCP_INVENTORY,
  MCP_VIEW,
  openCreateEditor,
  openPasteDialog,
  reloadMcpInventory,
  type McpShow,
  type McpView,
} from "@/lib/harness/mcp-state"
import { cn } from "@/lib/utils"

const SEGMENT_CLASS = cn(
  "h-8 flex-1 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap",
  "max-md:h-9 text-muted-foreground outline-none transition-colors hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
  "@3xl/mcp:h-7"
)

/** The filters a list can be narrowed with. "From Harness" and "Update
 *  available" only once the Harness seam has something they could match. */
export function showOptions(harness: McpHarnessSeam | undefined): McpShow[] {
  const options: McpShow[] = ["all", "problems"]
  if (harness && harness.marks.size > 0) options.push("harness")
  if (
    harness &&
    [...harness.marks.values()].some((mark) => mark.updateAvailable)
  ) {
    options.push("updates")
  }
  return options
}

/**
 * The section's controls: which view, the search box and the filter, a
 * refresh, and the ways to add a server. Applied as they change — the list is
 * local, so nothing waits for a pause in typing.
 */
export function McpToolbar({
  harness,
}: {
  harness: McpHarnessSeam | undefined
}) {
  const t = useTranslations("Harness.mcp")
  const { slots, discoverEnabled, setSection } = useHarnessView()
  const [view, setView] = useHarnessSlot(MCP_VIEW)
  const [filters, setFilters] = useHarnessSlot(MCP_FILTERS)
  const [inventory] = useHarnessSlot(MCP_INVENTORY)
  const loading = inventory.phase === "loading"
  const options = showOptions(harness)
  // A filter whose source went away falls back to all, rather than leaving a
  // list that can never match anything.
  const show = options.includes(filters.show) ? filters.show : "all"

  const findOnHarness = () => {
    // Discover opens on its list of MCP servers: a fresh question, keeping
    // only how the user likes it sorted, and no item left open over it.
    slots.set(
      DISCOVER_FILTERS,
      (prev): DiscoverFilters => ({
        ...DEFAULT_DISCOVER_FILTERS,
        sort: prev.sort,
        kind: "mcp",
      })
    )
    slots.set(DISCOVER_DETAIL, null)
    setSection("discover")
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ToggleGroup.Root
        type="single"
        value={view}
        aria-label={t("views.label")}
        onValueChange={(value) => {
          if (value === "servers" || value === "agents")
            setView(value as McpView)
        }}
        className="no-scrollbar order-1 flex h-9 min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10 @3xl/mcp:h-8"
      >
        <ToggleGroup.Item value="servers" className={SEGMENT_CLASS}>
          {t("views.servers")}
        </ToggleGroup.Item>
        <ToggleGroup.Item value="agents" className={SEGMENT_CLASS}>
          {t("views.agents")}
        </ToggleGroup.Item>
      </ToggleGroup.Root>

      <div className="order-2 ms-auto flex shrink-0 items-center gap-1 @3xl/mcp:order-4 @3xl/mcp:ms-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("refresh")}
          title={t("refresh")}
          aria-busy={loading}
          onClick={() => void reloadMcpInventory(slots)}
          className="text-muted-foreground max-md:size-10"
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(loading && "animate-spin")}
          />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              aria-label={t("add.label")}
              className="max-md:h-10"
            >
              <Plus aria-hidden="true" />
              {/* On the narrowest phones the plus says it, and the button
                  keeps its name for whoever cannot see it. */}
              <span className="hidden @sm/mcp:inline">{t("add.label")}</span>
              <ChevronDown aria-hidden="true" className="-me-1 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-72 max-w-[calc(100vw-2rem)]"
          >
            <DropdownMenuItem
              onSelect={() => openCreateEditor(slots)}
              className="items-start"
            >
              <PencilLine aria-hidden="true" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block">{t("add.manual")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("add.manualHint")}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => openPasteDialog(slots)}
              className="items-start"
            >
              <ClipboardPaste aria-hidden="true" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block">{t("add.paste")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("add.pasteHint")}
                </span>
              </span>
            </DropdownMenuItem>
            {discoverEnabled && (
              <DropdownMenuItem
                onSelect={findOnHarness}
                className="items-start"
              >
                <Compass aria-hidden="true" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block">{t("add.harness")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("add.harnessHint")}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        role="search"
        className="order-3 flex w-full min-w-0 items-center gap-2 @3xl/mcp:order-2 @3xl/mcp:w-auto @3xl/mcp:flex-1"
      >
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={filters.text}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
            className={cn(
              "h-10 ps-9 md:h-9 @3xl/mcp:h-8",
              // Room for the clear button only when there is one.
              filters.text !== "" ? "pe-10" : "pe-3"
            )}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, text: event.target.value }))
            }
          />
          {filters.text !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("search.clear")}
              title={t("search.clear")}
              className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground md:size-7 @3xl/mcp:size-6"
              onClick={() => setFilters((prev) => ({ ...prev, text: "" }))}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        <Select
          value={show}
          onValueChange={(value) => {
            const next = options.find((option) => option === value)
            if (next) setFilters((prev) => ({ ...prev, show: next }))
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("show.label")}
            className="max-w-[45%] shrink-0 max-md:h-10 @3xl/mcp:max-w-48"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`show.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
