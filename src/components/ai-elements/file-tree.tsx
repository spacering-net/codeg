"use client"

import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from "react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronRightIcon, FileIcon } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react"

interface FileTreeContextType {
  expandedPaths: Set<string>
  togglePath: (path: string) => void
  selectedPath?: string
  onSelect?: (path: string) => void
  /** Per-instance id namespace so row element ids stay unique across trees. */
  treeId: string
  /**
   * When true the tree is a single roving-focus widget: the container is the
   * focus host (arrow keys handled by the consumer's `onKeyDown`) and rows drop
   * out of the tab order. Off by default, so every other consumer of these
   * primitives keeps its previous per-row `tabIndex={0}` behavior unchanged.
   */
  keyboardNavigation: boolean
}

/**
 * Stable DOM id for a row, used both as the row element's `id` and as the
 * container's `aria-activedescendant` target. `encodeURIComponent` keeps
 * arbitrary paths id-safe (no spaces) and identical on both sides.
 */
export function fileTreeRowElementId(treeId: string, path: string): string {
  return `${treeId}-row-${encodeURIComponent(path)}`
}

// Row indentation is driven by an explicit `depth` passed from the tree renderer
// (a pure-CSS accumulating variable would have to reference itself, which CSS
// treats as a cycle → invalid → zero padding). When a caller provides `depth`,
// the row stays FULL-WIDTH and indents only its CONTENT via padding-left, so the
// hover / selection / drop highlight spans the whole row at any depth. When
// `depth` is omitted (callers that nest purely via <FileTreeFolder> children),
// the classic margin/border/padding wrapper indentation is used.
//
// One step == one leading-glyph width (the chevron / file icon column), which
// keeps a deep tree readable inside a narrow panel. The wrapper path below is
// built to match: `ml-2` + `pl-2` around its 1px guide border, i.e. 17px — a
// hair wider than this 1rem, and uniform within any one tree.
const FILE_TREE_INDENT_STEP_REM = 1
function rowPaddingLeftStyle(
  depth: number | undefined,
  base: CSSProperties | undefined
): CSSProperties | undefined {
  if (depth == null) return base
  return {
    paddingLeft: `calc(${depth} * ${FILE_TREE_INDENT_STEP_REM}rem + 0.5rem)`,
    ...base,
  }
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {}

const FileTreeContext = createContext<FileTreeContextType>({
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
  expandedPaths: new Set(),
  togglePath: noop,
  treeId: "",
  keyboardNavigation: false,
})

/**
 * True when the enclosing tree runs in roving-focus mode, i.e. the container is
 * the single tab stop and rows are driven by `aria-activedescendant`.
 *
 * Trailing row widgets (see {@link FileTreeFolderProps.actions}) must read this
 * and take themselves out of the tab order: a natively focusable widget on every
 * row would put the tree's whole row count back into the tab sequence, and the
 * arrow keys would land on the widget instead of the container that owns them.
 */
export function useFileTreeRovingFocus(): boolean {
  return useContext(FileTreeContext).keyboardNavigation
}

export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  expanded?: Set<string>
  defaultExpanded?: Set<string>
  selectedPath?: string
  onSelect?: (path: string) => void
  onExpandedChange?: (expanded: Set<string>) => void
  /** Opt into single-widget roving keyboard focus (see {@link FileTreeContextType.keyboardNavigation}). */
  keyboardNavigation?: boolean
  ref?: Ref<HTMLDivElement>
}

export const FileTree = ({
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onExpandedChange,
  keyboardNavigation = false,
  className,
  children,
  ref,
  ...props
}: FileTreeProps) => {
  const treeId = useId()
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const expandedPaths = controlledExpanded ?? internalExpanded

  const togglePath = useCallback(
    (path: string) => {
      const newExpanded = new Set(expandedPaths)
      if (newExpanded.has(path)) {
        newExpanded.delete(path)
      } else {
        newExpanded.add(path)
      }
      setInternalExpanded(newExpanded)
      onExpandedChange?.(newExpanded)
    },
    [expandedPaths, onExpandedChange]
  )

  const contextValue = useMemo(
    () => ({
      expandedPaths,
      onSelect,
      selectedPath,
      togglePath,
      treeId,
      keyboardNavigation,
    }),
    [
      expandedPaths,
      onSelect,
      selectedPath,
      togglePath,
      treeId,
      keyboardNavigation,
    ]
  )

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div
        className={cn(
          "rounded-lg border bg-background font-mono text-sm",
          className
        )}
        {...props}
        role="tree"
        ref={ref}
        // In roving mode the container is the single tab stop and points at the
        // active row via aria-activedescendant; otherwise honor any caller
        // tabIndex verbatim (unchanged from before).
        tabIndex={keyboardNavigation ? (props.tabIndex ?? 0) : props.tabIndex}
        aria-activedescendant={
          keyboardNavigation && selectedPath != null
            ? fileTreeRowElementId(treeId, selectedPath)
            : undefined
        }
      >
        <div className="w-max min-w-full">{children}</div>
      </div>
    </FileTreeContext.Provider>
  )
}

interface FileTreeFolderContextType {
  path: string
  name: string
  isExpanded: boolean
}

const FileTreeFolderContext = createContext<FileTreeFolderContextType>({
  isExpanded: false,
  name: "",
  path: "",
})

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  path: string
  name: string
  nameClassName?: string
  /** Extra classes for the row's leading chevron (the folder's only glyph). */
  iconClassName?: string
  suffix?: ReactNode
  suffixClassName?: string
  /**
   * Right-aligned trailing widget (e.g. a "more" menu button). Rendered as a
   * SIBLING of the header button — HTML forbids a button inside a button, and
   * React reports the nesting as a hydration error — inside a `FileTreeActions`
   * wrapper so click/keydown don't bubble up to the row's own handlers (e.g.
   * the expand/collapse click). Clicks on the widget are the caller's
   * responsibility. Passing this switches the header to a wrapped layout; rows
   * without actions render exactly as before.
   *
   * Both row kinds carry the `file-tree-row` Tailwind group, so a widget can
   * reveal itself on row hover with `group-hover/file-tree-row:…`.
   */
  actions?: ReactNode
  /**
   * Props applied to the folder's header row — e.g. `draggable` and drag/drop
   * handlers for file-tree DnD. Placed on the header (not the outer wrapper,
   * which also contains the child rows) so a drop targets THIS folder rather
   * than its whole subtree. `onClick`/`type` are owned by the folder and are
   * not overridable here.
   *
   * The header row is the `<button>` itself, or — when {@link actions} is
   * given — the wrapper that holds the button and the action side by side, so
   * that the drop zone still covers the action. Typed against `HTMLElement`
   * for that reason.
   */
  rowProps?: HTMLAttributes<HTMLElement>
  /** Render a drop-target highlight on the header row (a valid DnD drop is
   *  hovering this folder). */
  dropActive?: boolean
  /**
   * Marks this folder's header row as a directory drop zone for file-tree DnD,
   * tagging it with `data-tree-drop-dir` set to this value (the destination
   * path relative to the workspace root; `""` for the root row). The desktop
   * drop path hit-tests the drop coordinates against these markers because
   * Tauri's webview swallows the HTML5 `drop` event. Omit on non-DnD trees.
   */
  dropTargetDir?: string
  /**
   * Nesting depth (0 = top level). When provided, the row is rendered
   * full-width and its content is indented via padding-left instead of an
   * inset children wrapper, so the row highlight spans the whole tree at any
   * depth. When omitted, the classic wrapper indentation is used unchanged.
   */
  depth?: number
}

export const FileTreeFolder = ({
  path,
  name,
  nameClassName,
  iconClassName,
  suffix,
  suffixClassName,
  actions,
  rowProps,
  dropActive,
  dropTargetDir,
  depth,
  className,
  children,
  ...props
}: FileTreeFolderProps) => {
  const {
    className: rowClassName,
    style: rowStyle,
    tabIndex: rowTabIndex,
    ...rowRest
  } = rowProps ?? {}
  const {
    expandedPaths,
    togglePath,
    selectedPath,
    onSelect,
    treeId,
    keyboardNavigation,
  } = useContext(FileTreeContext)
  const isExpanded = expandedPaths.has(path)
  const isSelected = selectedPath === path

  const handleOpenChange = useCallback(() => {
    togglePath(path)
  }, [togglePath, path])

  const handleSelect = useCallback(() => {
    onSelect?.(path)
  }, [onSelect, path])

  const folderContextValue = useMemo(
    () => ({ isExpanded, name, path }),
    [isExpanded, name, path]
  )

  // A selected row — or a directory being hovered as a drop target — gets the
  // same static tint with NO hover change; only idle rows show the hover
  // affordance.
  const highlightClassName =
    dropActive || isSelected ? "bg-muted-foreground/20" : "hover:bg-muted/50"

  // Without an action the header IS the row: it spans the full width and owns
  // the highlight, the drop marker, and everything in `rowProps`. With one, all
  // of that moves to the wrapper below — the action has to be a SIBLING of the
  // header (HTML forbids a button inside a button), and a sibling is outside
  // both the header's `:hover` chain and its `data-tree-drop-dir` subtree, so
  // leaving them on the header would switch the row tint off and swallow drops
  // whenever the pointer sat on the action.
  const header = (
    <CollapsibleTrigger asChild>
      <button
        className={cn(
          "flex w-max items-center gap-1 rounded py-1 text-left transition-colors",
          depth == null ? "pl-2" : null,
          // `grow` keeps the click target covering the row's empty right side —
          // without it the header shrinks to its name and clicking beside a
          // folder stops expanding it. `flex-grow` alone (not `flex-1`, whose
          // zero basis would drop the name out of the row's intrinsic width) so
          // the horizontally scrolling tree still sizes to its longest row.
          actions
            ? "grow"
            : cn("min-w-full pr-2", highlightClassName, rowClassName)
        )}
        style={rowPaddingLeftStyle(depth, rowStyle)}
        onClick={handleSelect}
        type="button"
        // Scroll target for keyboard navigation: the header button (not the
        // outer treeitem, whose box spans the whole expanded subtree and
        // would scroll past the header).
        data-tree-row-path={path}
        data-tree-drop-dir={actions ? undefined : dropTargetDir}
        {...(actions ? {} : rowRest)}
        // The header is a native <button> (default tab stop). In roving
        // mode force it out of the tab order so the container stays the
        // single focus host and Enter/Space can't fire on a folder whose
        // DOM focus differs from the active row; otherwise keep any
        // caller-provided tabIndex unchanged.
        tabIndex={keyboardNavigation ? -1 : rowTabIndex}
      >
        {/* The chevron is the folder's ONLY glyph: it states both "directory"
            and expanded/collapsed, so a folder icon beside it would be a second
            copy of the same information — and it occupies the same leading
            column as a file row's type icon, which keeps sibling names aligned. */}
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
            iconClassName
          )}
        />
        <FileTreeName className={nameClassName}>{name}</FileTreeName>
        {suffix ? (
          <span
            className={cn(
              "ml-1 shrink-0 whitespace-nowrap text-muted-foreground/60",
              suffixClassName
            )}
          >
            {suffix}
          </span>
        ) : null}
      </button>
    </CollapsibleTrigger>
  )

  return (
    <FileTreeFolderContext.Provider value={folderContextValue}>
      <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
        <div
          className={cn("", className)}
          id={fileTreeRowElementId(treeId, path)}
          aria-selected={isSelected}
          aria-expanded={isExpanded}
          role="treeitem"
          tabIndex={keyboardNavigation ? -1 : 0}
          {...props}
        >
          {actions ? (
            <div
              className={cn(
                "group/file-tree-row flex w-max min-w-full items-center gap-1 rounded pr-2 transition-colors",
                highlightClassName,
                rowClassName
              )}
              data-tree-drop-dir={dropTargetDir}
              {...rowRest}
            >
              {header}
              <FileTreeActions>{actions}</FileTreeActions>
            </div>
          ) : (
            header
          )}
          <CollapsibleContent>
            {/* With explicit `depth`, descendants indent themselves via
                padding, so this wrapper adds NO left inset (keeping their
                highlights full-width). Without it, fall back to the classic
                margin/border/padding inset. */}
            <div className={depth == null ? "ml-2 border-l pl-2" : undefined}>
              {children}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </FileTreeFolderContext.Provider>
  )
}

interface FileTreeFileContextType {
  path: string
  name: string
}

const FileTreeFileContext = createContext<FileTreeFileContextType>({
  name: "",
  path: "",
})

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  path: string
  name: string
  icon?: ReactNode
  /** Nesting depth (0 = top level). See {@link FileTreeFolderProps.depth}: when
   *  provided the row is full-width and indents its content via padding. */
  depth?: number
  /**
   * Right-aligned trailing widget (e.g. a "more" menu button). Rendered
   * inside a `FileTreeActions` wrapper so click/keydown don't bubble up to
   * the row's own handlers (e.g. opening a file preview). Clicks on the
   * widget are the caller's responsibility. See
   * {@link FileTreeFolderProps.actions} for the row-hover group name.
   */
  actions?: ReactNode
}

export const FileTreeFile = ({
  path,
  name,
  icon,
  depth,
  className,
  style,
  actions,
  children,
  ...props
}: FileTreeFileProps) => {
  const { selectedPath, onSelect, treeId, keyboardNavigation } =
    useContext(FileTreeContext)
  const isSelected = selectedPath === path

  const handleClick = useCallback(() => {
    onSelect?.(path)
  }, [onSelect, path])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        onSelect?.(path)
      }
    },
    [onSelect, path]
  )

  const fileContextValue = useMemo(() => ({ name, path }), [name, path])

  return (
    <FileTreeFileContext.Provider value={fileContextValue}>
      <div
        className={cn(
          "group/file-tree-row flex w-max min-w-full cursor-pointer items-center gap-1 rounded py-1 transition-colors",
          depth == null ? "px-2" : "pr-2",
          // Selected rows keep a static tint (no hover change); idle rows show
          // the hover affordance.
          isSelected ? "bg-muted-foreground/20" : "hover:bg-muted/50",
          className
        )}
        style={rowPaddingLeftStyle(depth, style)}
        id={fileTreeRowElementId(treeId, path)}
        data-tree-row-path={path}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-selected={isSelected}
        role="treeitem"
        tabIndex={keyboardNavigation ? -1 : 0}
        {...props}
      >
        {children ?? (
          <>
            {/* The type icon sits in the SAME leading column as a folder row's
                chevron (no extra spacer in front of it), so a file and its
                sibling directory line their names up at every depth. */}
            <FileTreeIcon>
              {icon ?? <FileIcon className="size-4 text-muted-foreground" />}
            </FileTreeIcon>
            <FileTreeName>{name}</FileTreeName>
          </>
        )}
        {actions ? <FileTreeActions>{actions}</FileTreeActions> : null}
      </div>
    </FileTreeFileContext.Provider>
  )
}

export type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>

export const FileTreeIcon = ({
  className,
  children,
  ...props
}: FileTreeIconProps) => (
  <span className={cn("shrink-0", className)} {...props}>
    {children}
  </span>
)

export type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>

export const FileTreeName = ({
  className,
  children,
  ...props
}: FileTreeNameProps) => (
  <span className={cn("shrink-0 whitespace-nowrap", className)} {...props}>
    {children}
  </span>
)

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation()

export const FileTreeActions = ({
  className,
  children,
  ...props
}: FileTreeActionsProps) => (
  // biome-ignore lint/a11y/noNoninteractiveElementInteractions: stopPropagation required for nested interactions
  // biome-ignore lint/a11y/useSemanticElements: fieldset doesn't fit this UI pattern
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    role="group"
    {...props}
  >
    {children}
  </div>
)
