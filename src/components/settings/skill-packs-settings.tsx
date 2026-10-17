"use client"

import { useCallback, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { FolderOpen, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ExpertsBody } from "@/components/settings/experts-settings"
import { ScienceBody } from "@/components/settings/science-settings"
import { OfficeToolsBody } from "@/components/settings/office-tools-settings"
import { CustomSkillsBody } from "@/components/settings/custom-skills-settings"
import { GenerativeUiBody } from "@/components/settings/generative-ui-settings"
import { expertsOpenCentralDir, openFolder } from "@/lib/api"
import { revealItemInDir } from "@/lib/platform"
import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"
import { toErrorMessage } from "@/lib/app-error"

type SkillPackTab = "experts" | "science" | "office" | "ui" | "custom"

function normalizeTab(raw: string | null): SkillPackTab {
  return raw === "science" ||
    raw === "office" ||
    raw === "ui" ||
    raw === "custom"
    ? raw
    : "experts"
}

// The Tabs primitive's built-in active styling uses a bare `data-active:`
// variant that is a no-op with Radix (which emits `data-state="active"`), so
// the visible active pill must be re-declared here per trigger.
const TRIGGER_ACTIVE =
  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"

/**
 * Unified "Skill Packs" settings hub — a shared generic header + a fixed
 * top-right toolbar over a tabbed switcher for the three curated,
 * codeg-managed skill bundles (Experts, Science, Office), the generative-UI
 * skill that teaches agents the chat's cards (UI), and the user's own skills
 * (Custom). Each tab renders the existing per-pack body verbatim.
 */
export function SkillPacksSettings() {
  const t = useTranslations("SkillPacksSettings")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Local state is the visual source of truth so the tab always switches (even
  // on the Windows hard-nav runtime); the `?tab=` param is a best-effort mirror
  // for deep-linking, seeded once from the URL.
  const [tab, setTab] = useState<SkillPackTab>(() =>
    normalizeTab(searchParams.get("tab"))
  )

  // The currently-mounted pack body publishes its reload handler here, so the
  // fixed "Refresh" button drives whichever tab is visible without remounting
  // it (which would tear down Office's in-flight install stream). Exactly one
  // body is mounted at a time, so the last registration always wins.
  const activeRefreshRef = useRef<(() => void) | null>(null)
  const registerRefresh = useCallback((fn: () => void) => {
    activeRefreshRef.current = fn
  }, [])

  const handleTabChange = useCallback(
    (next: string) => {
      const value = normalizeTab(next)
      setTab(value)
      // Preserve every other param (esp. ?remoteConnectionId=N) when mirroring
      // the active tab into the URL.
      const params = new URLSearchParams(searchParams.toString())
      params.set("tab", value)
      router.replace(`${pathname}?${params.toString()}`)
    },
    [router, pathname, searchParams]
  )

  // All three packs link from ONE shared central store (~/.codeg/skills), so a
  // single, tab-independent "open central folder" is correct for every tab.
  const handleOpenCentralDir = useCallback(async () => {
    try {
      const path = await expertsOpenCentralDir()
      if (isDesktop() && getActiveRemoteConnectionId() === null) {
        // Desktop: reveal the folder. `revealItemInDir` (not `openPath`) is
        // deliberate — the opener plugin's scope rejects `openPath` for the
        // hidden `~/.codeg/...` path.
        await revealItemInDir(path)
      } else {
        await openFolder(path)
      }
    } catch (err) {
      toast.error(t("toasts.openFolderFailed"), {
        description: toErrorMessage(err),
      })
    }
  }, [t])

  return (
    <div className="h-full flex flex-col p-3 md:p-4">
      <div className="shrink-0 pb-4">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t("description")}</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="flex flex-col flex-1 min-h-0"
      >
        <div className="flex items-center justify-between gap-3 shrink-0">
          <TabsList className="w-fit">
            <TabsTrigger value="experts" className={TRIGGER_ACTIVE}>
              {t("tabs.experts")}
            </TabsTrigger>
            <TabsTrigger value="science" className={TRIGGER_ACTIVE}>
              {t("tabs.science")}
            </TabsTrigger>
            <TabsTrigger value="office" className={TRIGGER_ACTIVE}>
              {t("tabs.office")}
            </TabsTrigger>
            <TabsTrigger value="ui" className={TRIGGER_ACTIVE}>
              {t("tabs.ui")}
            </TabsTrigger>
            <TabsTrigger value="custom" className={TRIGGER_ACTIVE}>
              {t("tabs.custom")}
            </TabsTrigger>
          </TabsList>

          {/* Fixed toolbar — identical on every tab. */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                handleOpenCentralDir().catch((err) => {
                  console.error(
                    "[SkillPacksSettings] open central dir failed:",
                    err
                  )
                })
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("actions.openCentralDir")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => activeRefreshRef.current?.()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("actions.refresh")}
            </Button>
          </div>
        </div>

        <TabsContent
          value="experts"
          className="mt-0 flex-1 min-h-0 flex flex-col"
        >
          <ExpertsBody onRegisterRefresh={registerRefresh} />
        </TabsContent>
        <TabsContent
          value="science"
          className="mt-0 flex-1 min-h-0 flex flex-col"
        >
          <ScienceBody onRegisterRefresh={registerRefresh} />
        </TabsContent>
        <TabsContent
          value="office"
          className="mt-0 flex-1 min-h-0 flex flex-col"
        >
          <OfficeToolsBody onRegisterRefresh={registerRefresh} />
        </TabsContent>
        <TabsContent value="ui" className="mt-0 flex-1 min-h-0 flex flex-col">
          <GenerativeUiBody onRegisterRefresh={registerRefresh} />
        </TabsContent>
        <TabsContent
          value="custom"
          className="mt-0 flex-1 min-h-0 flex flex-col"
        >
          <CustomSkillsBody onRegisterRefresh={registerRefresh} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
