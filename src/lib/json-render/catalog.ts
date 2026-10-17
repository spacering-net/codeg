import { defineCatalog } from "@json-render/core"
import { schema } from "@json-render/react/schema"
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog"

import { chartComponentDefinitions } from "./charts"

/**
 * What an agent may put in a json-render card: json-render's own shadcn
 * component definitions, all of them, the charts of `./charts.ts`, and no
 * actions beyond the built-in ones.
 *
 * One catalog for both halves of the feature — the renderer
 * (`components/message/json-render-block.tsx`) and the skill that teaches an
 * agent the format (`./skill.ts`) — so the two cannot disagree about what
 * exists. Importing it pulls in zod and every component definition, so only
 * the lazily loaded card and the skill test may import it.
 */
export const jsonRenderCatalog = defineCatalog(schema, {
  components: { ...shadcnComponentDefinitions, ...chartComponentDefinitions },
  actions: {},
})
