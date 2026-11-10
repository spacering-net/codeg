import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const WEBKIT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko)"
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko)"

// Each case spawns two Node processes that load jsdom; under a full parallel
// test run that can exceed Vitest's default 5 s per-test budget.
const CHILD_TIMEOUT_MS = 20_000

// The dependency captures browser APIs at module evaluation. A fresh process
// per browser also exercises both package entrypoints without Node's external
// module cache making every case reuse the first browser's feature detection.
function probe(userAgent: string, supported = true) {
  return ["esm", "cjs"].map(
    (entrypoint) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
            import { createRequire } from "node:module"
            import { JSDOM } from "jsdom"
            const [userAgent, entrypoint, supported] = process.argv.slice(1)
            const dom = new JSDOM("<!doctype html><body>", {
              pretendToBeVisual: true,
            })
            const { window } = dom
            Object.assign(globalThis, {
              window, document: window.document,
              HTMLElement: window.HTMLElement, Element: window.Element,
            })
            Object.defineProperty(window.navigator, "userAgent", {
              value: userAgent,
            })
            let constructors = 0
            let animations = 0
            if (supported === "true") {
              window.ScrollTimeline = class {
                constructor() { constructors++ }
              }
            }
            window.Element.prototype.animate = () => {
              animations++
              return { cancel() {} }
            }
            const { OverlayScrollbars } = entrypoint === "cjs"
              ? createRequire(import.meta.url)("overlayscrollbars")
              : await import("overlayscrollbars")
            const host = window.document.createElement("div")
            window.document.body.append(host)
            const instance = OverlayScrollbars(host, {})
            const result = {
              native: OverlayScrollbars.env().scrollTimeline,
              constructors, animations,
              handle: instance.elements().scrollbarVertical.handle instanceof window.HTMLElement,
              webkitClass: instance.elements().scrollbarVertical.scrollbar.classList.contains("os-scrollbar-webkit"),
            }
            instance.destroy()
            dom.window.close()
            console.log(JSON.stringify(result))
          `,
            userAgent,
            entrypoint,
            String(supported),
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            // A synchronous child cannot be interrupted by Vitest's timer, so
            // bound it here to fail with a clear error instead of hanging.
            timeout: CHILD_TIMEOUT_MS,
          }
        )
      ) as {
        native: boolean
        constructors: number
        animations: number
        handle: boolean
        webkitClass: boolean
      }
  )
}

describe(
  "OverlayScrollbars native memory workaround",
  { timeout: CHILD_TIMEOUT_MS * 2 + 5_000 },
  () => {
    it.each([
      ["WKWebView", WEBKIT],
      ["Safari", `${WEBKIT} Version/18.0 Safari/605.1.15`],
      ["iOS Chrome (WebKit)", `${IPHONE} CriOS/130.0.0.0 Mobile/15E148`],
      ["iOS Firefox (WebKit)", `${IPHONE} FxiOS/130.0 Mobile/15E148`],
      [
        "WebKitGTK",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/60.5 Safari/605.1.15",
      ],
    ])("uses the scroll-event fallback in %s", (_name, userAgent) => {
      for (const result of probe(userAgent)) {
        expect(result).toEqual({
          native: false,
          constructors: 0,
          animations: 0,
          handle: true,
          webkitClass: true,
        })
      }
    })

    it.each([
      ["Chrome", `${WEBKIT} Chrome/130.0.0.0 Safari/537.36`],
      ["Edge", `${WEBKIT} Chrome/130.0.0.0 Safari/537.36 Edg/130.0`],
      ["Opera", `${WEBKIT} Chrome/130.0.0.0 Safari/537.36 OPR/115.0`],
      ["Chromium", `${WEBKIT} Chromium/130.0.0.0 Safari/537.36`],
    ])("keeps native scroll timelines in %s", (_name, userAgent) => {
      for (const result of probe(userAgent)) {
        expect(result.native).toBe(true)
        expect(result.constructors).toBeGreaterThan(0)
        expect(result.animations).toBeGreaterThan(0)
        expect(result.handle).toBe(true)
        expect(result.webkitClass).toBe(false)
      }
    })

    it("works when the browser has no ScrollTimeline API", () => {
      for (const result of probe(WEBKIT, false)) {
        expect(result.native).toBe(false)
        expect(result.constructors).toBe(0)
        expect(result.animations).toBe(0)
        expect(result.handle).toBe(true)
        expect(result.webkitClass).toBe(true)
      }
    })
  }
)
