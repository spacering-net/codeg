"use client"

import { useState } from "react"
import { CloudUpload, DatabaseBackup, Download, Upload } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  BackupSettings,
  type DataSyncPane,
} from "@/components/settings/backup-settings"
import { ConfigSyncSettings } from "@/components/settings/config-sync-settings"
import { SettingsSection } from "@/components/shared/settings-section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * Everything that moves codeg data in or out of this machine, in one card:
 * configuration sync between machines, a whole-machine backup, and restoring
 * from one. They used to be three stacked cards — two of them titled, the third
 * ("pre-restore snapshots") a top-level card for what is really the undo button
 * of the restore flow — which read as three walls rather than one subject.
 *
 * One tab strip, three destinations. The strip lives here rather than inside
 * `BackupSettings` so there is a single level of tabs: `BackupSettings` emits
 * its two `TabsContent` panels straight into this root, and its snapshot list
 * sits at the bottom of the restore panel.
 *
 * Every panel is `forceMount`ed, which keeps the previous behaviour exactly:
 * all three blocks used to be mounted at once, so their loads (snapshot list,
 * sync settings, rollback list) still run when the page opens, and switching
 * tabs never drops an export in flight or an archive already picked.
 *
 * That is why the selected pane is state here rather than Radix's own: a
 * `forceMount`ed panel is hidden by `data-[state=inactive]:hidden`, a
 * stylesheet rule, and under jsdom (no Tailwind) only the `hidden` attribute
 * is honoured — without passing it every assertion in the tests would read
 * straight through whichever tab is not on show, and a tab wired to a panel
 * that does not exist would still look green. Same pairing, and the same
 * reason, as the forge detail sheet's `TabPane`.
 */
export function DataSyncSettings() {
  const t = useTranslations("SystemSettings")
  // The tab labels are the sections' own titles, so the strip stays in sync
  // with what each panel calls itself instead of naming them a second time.
  const tSync = useTranslations("ConfigSyncSettings")
  const tBackup = useTranslations("BackupSettings")
  const [pane, setPane] = useState<DataSyncPane>("sync")

  return (
    <SettingsSection
      icon={DatabaseBackup}
      title={t("dataTitle")}
      description={t("dataDescription")}
    >
      <Tabs
        value={pane}
        onValueChange={(next) => setPane(next as DataSyncPane)}
      >
        {/* `min-w-0` + `truncate`: "Konfigurationssynchronisierung" next to two
            more labels overflows a narrow settings pane otherwise. */}
        <TabsList className="w-full">
          <TabsTrigger value="sync" className="min-w-0 flex-1">
            <CloudUpload className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">{tSync("title")}</span>
          </TabsTrigger>
          <TabsTrigger value="backup" className="min-w-0 flex-1">
            <Download className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">{tBackup("tabs.backup")}</span>
          </TabsTrigger>
          <TabsTrigger value="restore" className="min-w-0 flex-1">
            <Upload className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">{tBackup("tabs.restore")}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="sync"
          forceMount
          hidden={pane !== "sync"}
          className="pt-2"
        >
          <ConfigSyncSettings />
        </TabsContent>

        {/* Renders the `backup` and `restore` panels of this same strip. */}
        <BackupSettings pane={pane} />
      </Tabs>
    </SettingsSection>
  )
}
