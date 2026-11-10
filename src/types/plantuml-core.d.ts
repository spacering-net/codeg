// `@plantuml/core` (PlantUML's own browser build) ships no type declarations,
// so importing it would otherwise be an implicit `any` (TS7016). Only the call
// `components/ai-elements/plantuml-engine.ts` makes is described here.
declare module "@plantuml/core" {
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: { dark?: boolean }
  ): void
}

// Classic scripts that register the global the engine reads once they have run
// (`PLANTUML_THEMES`, `PLANTUML_EMOJI`, `PLANTUML_OPENICONIC`); they are
// imported for that side effect only.
declare module "@plantuml/core/themes.js"
declare module "@plantuml/core/emoji.js"
declare module "@plantuml/core/openiconic.js"
