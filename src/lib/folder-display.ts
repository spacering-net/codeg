import type { FolderDetail } from "@/lib/types"

/**
 * The name to show for a folder in the branch selector and the input-box folder
 * chip. For a worktree folder (`parent_id != null`) we surface the *root repo*
 * folder's name instead of the worktree directory's own name — the worktree dir
 * is typically named after its branch (e.g. `myproject-feature-x`), so showing
 * the repo name (`myproject`) alongside the branch label reads cleaner.
 *
 * Display-only: callers keep using the folder's real `path`/`id` for every
 * filesystem and git operation. Falls back to the folder's own name when the
 * parent is not present in `folders` (e.g. closed/removed), so the label never
 * blanks out.
 */
export function resolveFolderDisplayName(
  folder: Pick<FolderDetail, "name" | "parent_id">,
  folders: readonly Pick<FolderDetail, "id" | "name">[]
): string {
  if (folder.parent_id == null) return folder.name
  const parent = folders.find((f) => f.id === folder.parent_id)
  return parent?.name ?? folder.name
}

/**
 * Plain-string folder label for `title` tooltips and other string-only contexts:
 * `alias [ name ]` (e.g. `My Project [ codeg ]`) when an alias is set, else the
 * bare `name`. The rendered (color-distinguished) equivalent is the
 * `FolderAliasLabel` component — keep the `alias [ name ]` spacing in sync.
 */
export function formatFolderLabelWithAlias(
  folder: Pick<FolderDetail, "name" | "alias">
): string {
  const alias = folder.alias?.trim()
  return alias ? `${alias} [ ${folder.name} ]` : folder.name
}

/**
 * The folders the input-box folder picker should list: top-level repos only.
 * Worktree folders (`parent_id != null`) are reached via the branch picker, so
 * listing them here too would be redundant and confusing. Display-only — the
 * full folder list still backs every actual switch/lookup.
 */
export function filterTopLevelFolders<
  T extends Pick<FolderDetail, "parent_id">,
>(folders: readonly T[]): T[] {
  return folders.filter((f) => f.parent_id == null)
}

/**
 * Drop hidden folders from a folder list: chat-mode folders (`kind ===
 * "chat"`), which back folderless "chat mode" conversations, and the personal
 * agent's working directory (`kind === "personal"`). Neither may appear in
 * user-facing folder surfaces (the sidebar "文件夹" group, the input-box folder
 * picker). They stay in the full `allFolders` set so by-id lookups (cwd,
 * active-folder, theme color) keep resolving — only list rendering excludes
 * them.
 */
export function excludeChatFolders<T extends Pick<FolderDetail, "kind">>(
  folders: readonly T[]
): T[] {
  return folders.filter((f) => f.kind !== "chat" && f.kind !== "personal")
}

/**
 * The folder id the input-box picker highlights for a conversation's folder:
 * the parent repo for a worktree (since the worktree itself isn't listed), or
 * the folder itself for a top-level repo. Display-only — never used for the
 * conversation's real working directory.
 */
export function resolvePickerSelectedFolderId(
  folder: Pick<FolderDetail, "id" | "parent_id">
): number {
  return folder.parent_id ?? folder.id
}
