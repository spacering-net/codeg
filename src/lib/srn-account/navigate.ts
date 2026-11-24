/**
 * Where Codeg Web's sign-in sends the browser. On their own so that tests can
 * stand in for them: jsdom navigates nowhere.
 */

/** This tab to `url`: SpaceRing's page, and back to `/workspace?srn=…`. */
export function sendTabTo(url: string): void {
  window.location.assign(url)
}

/** `url` in a new tab. `noreferrer` (which implies `noopener`) keeps the page
 *  from reaching back into this one — as `openUrl` in `lib/platform.ts`. */
export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noreferrer")
}
