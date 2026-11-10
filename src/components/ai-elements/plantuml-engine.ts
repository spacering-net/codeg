/**
 * PlantUML rendering for ```plantuml fences (drawn by `./mermaid-block.tsx`).
 *
 * The engine is PlantUML's own browser build, `@plantuml/core`: PlantUML
 * compiled to JavaScript, which draws the diagram right here — no PlantUML
 * server, no Java, no Graphviz binary — so a diagram's source never leaves the
 * machine, the same as with Mermaid. It is several MB, so it is imported the
 * first time a fence is rendered, never with the page, and kept for every fence
 * after that.
 *
 * Wired the way the package's integration guide (`GITHUB_INTEGRATION.md`)
 * describes, with one difference for Graphviz:
 *  - the engine lays out class, component, state, … diagrams with Graphviz,
 *    which it looks up as a global `Viz`. The package ships it as
 *    `viz-global.js`, a UMD script that only sets that global when the page
 *    has no AMD loader — and Monaco's loader (any code editor opened before)
 *    defines one, after which the bundled script fails with "exports is not
 *    defined". So the same Viz.js release is taken from its own ES module
 *    (`@viz-js/viz`, the version `viz-global.js` was built from) and handed
 *    over as that global.
 *  - diagrams are rendered one at a time. The engine keeps the diagram in
 *    progress in module state, so a call made while another is still running
 *    takes that state over, and one of the two callbacks never fires.
 *  - the support files it loads on first use (themes, emoji, OpenIconic) come
 *    in through its loader hook — see {@link loadSupportFile}.
 */

type SupportFileLoader = (
  file: string,
  ok: () => void,
  fail: (message: string) => void
) => boolean

const SUPPORT_FILES = new Map<string, () => Promise<unknown>>([
  ["themes.js", () => import("@plantuml/core/themes.js")],
  ["emoji.js", () => import("@plantuml/core/emoji.js")],
  ["openiconic.js", () => import("@plantuml/core/openiconic.js")],
])

/**
 * The engine's `PLANTUML_STDLIB_LOADER` hook, asked for a support file the
 * first time a diagram needs one (`!theme`, `<:emoji:>`, `<&icon>`).
 *
 * Left to itself, the engine appends `<script src="themes.js">` resolved
 * against the page, and this app has no such file next to its pages. Importing
 * the package's own copy runs the same script as part of this build, which
 * registers the global the engine then reads (`PLANTUML_THEMES`, …).
 *
 * The rest of the PlantUML standard library (`!include <C4/…>`, AWS, …) is not
 * in the npm package, and its hosted copy would mean running a remote script
 * inside the app, so such an include fails and PlantUML reports it in the
 * diagram it draws.
 */
export const loadSupportFile: SupportFileLoader = (file, ok, fail) => {
  const load = SUPPORT_FILES.get(file)
  if (!load) {
    fail(`${file} is not available`)
    return true
  }
  load().then(
    () => ok(),
    (err: unknown) => fail(err instanceof Error ? err.message : String(err))
  )
  return true
}

type PlantUmlEngine = typeof import("@plantuml/core")

let engine: Promise<PlantUmlEngine> | null = null

function loadEngine(): Promise<PlantUmlEngine> {
  if (!engine) {
    const host = globalThis as {
      PLANTUML_STDLIB_LOADER?: SupportFileLoader
      Viz?: unknown
    }
    host.PLANTUML_STDLIB_LOADER = loadSupportFile
    const loading = import("@viz-js/viz").then((viz) => {
      host.Viz = viz
      return import("@plantuml/core")
    })
    engine = loading
    // Forget a failed load, so the next render (a Retry, another fence) can
    // try again instead of failing forever.
    loading.catch(() => {
      if (engine === loading) engine = null
    })
  }
  return engine
}

/**
 * The source the way the engine wants it: inside `@start…` / `@end…` lines.
 *
 * Markdown fences often leave those out, and the PlantUML server takes such
 * text as a UML diagram by wrapping it in `@startuml` / `@enduml`. Do the
 * same, or the engine answers "Diagram not supported" for it.
 */
export function withDiagramMarkers(source: string): string {
  return source.trimStart().startsWith("@start")
    ? source
    : `@startuml\n${source}\n@enduml`
}

function abortError(): Error {
  return new DOMException("The render was cancelled", "AbortError")
}

/** The render last queued; the next one starts once it has settled. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Draw a ```plantuml fence as SVG markup.
 *
 * Calls run one at a time, in order (see the module comment). A call whose
 * `signal` has aborted by the time its turn comes is skipped: a fence that is
 * still streaming asks again for every chunk, and only its latest text is
 * worth drawing.
 *
 * PlantUML draws its own syntax errors as a diagram, so those resolve too; this
 * rejects only when the engine itself fails.
 */
export function renderPlantUml(
  source: string,
  options: { dark: boolean; signal?: AbortSignal }
): Promise<string> {
  const { dark, signal } = options
  const run = async (): Promise<string> => {
    if (signal?.aborted) throw abortError()
    const { renderToString } = await loadEngine()
    if (signal?.aborted) throw abortError()
    return new Promise<string>((resolve, reject) => {
      renderToString(
        withDiagramMarkers(source).split(/\r\n|\r|\n/),
        resolve,
        (message) => reject(new Error(message)),
        { dark }
      )
    })
  }
  const result = queue.then(run)
  queue = result.catch(() => {})
  return result
}
