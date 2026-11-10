/**
 * "Open this workbench page on what I was looking at" — the hand-off from the
 * aux panel's work tabs to the full Automations / Tasks pages.
 *
 * The route pages are not kept mounted (WorkbenchRoutePage renders only the
 * active route), so the request is parked here for the page to pick up as it
 * mounts, then the caller switches routes. The page READS it in its state
 * initializers — so its first paint is already focused, with no frame of the
 * unfocused page — and CLEARS it from an effect: under StrictMode an initializer
 * runs twice, and consuming there would hand the second run nothing.
 */

export interface AutomationsFocus {
  /** Project folder to filter the list by. */
  folderId: number | null
  /** Automation to select (and, with `intent: "edit"`, to open the editor on). */
  automationId?: number | null
  /** `create` opens the template gallery, its drafts defaulting to `folderId`. */
  intent?: "edit" | "create"
}

export interface TasksFocus {
  /** Project folder to filter the board by. */
  folderId: number | null
}

let automationsFocus: AutomationsFocus | null = null
let tasksFocus: TasksFocus | null = null

/** Park a focus for the Automations page (the caller then switches routes). */
export function requestAutomationsFocus(focus: AutomationsFocus): void {
  automationsFocus = focus
}

/** The parked focus, left in place — see the module comment. */
export function peekAutomationsFocus(): AutomationsFocus | null {
  return automationsFocus
}

/** Drop the focus a page has applied — only that one, so a newer request
 *  parked meanwhile survives for the page that is about to mount. */
export function clearAutomationsFocus(focus: AutomationsFocus | null): void {
  if (focus != null && automationsFocus === focus) automationsFocus = null
}

/** Park a focus for the Tasks page (the caller then switches routes). */
export function requestTasksFocus(focus: TasksFocus): void {
  tasksFocus = focus
}

export function peekTasksFocus(): TasksFocus | null {
  return tasksFocus
}

export function clearTasksFocus(focus: TasksFocus | null): void {
  if (focus != null && tasksFocus === focus) tasksFocus = null
}
