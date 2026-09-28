# Vendored from Playwright

Nine files, copied byte-for-byte from
[microsoft/playwright](https://github.com/microsoft/playwright) at tag
**v1.63.0**, under the Apache License 2.0 (see `LICENSE`).

They are the complete import closure of `injected/ariaSnapshot.ts` — the tree
Playwright itself builds for `page.ariaSnapshot()` and Playwright MCP. We call
it in `ai` mode, so the shape an agent reads from a codeg tab is the shape it
already knows from Playwright MCP.

| upstream path | bytes |
| --- | --- |
| `packages/injected/src/ariaSnapshot.ts` | 20123 |
| `packages/injected/src/ariaSnapshotDistiller.ts` | 11941 |
| `packages/injected/src/domUtils.ts` | 7572 |
| `packages/injected/src/roleUtils.ts` | 60719 |
| `packages/isomorphic/ariaSnapshot.ts` | 19236 |
| `packages/isomorphic/ariaSnapshotRenderer.ts` | 6693 |
| `packages/isomorphic/cssTokenizer.ts` | 26165 |
| `packages/isomorphic/stringUtils.ts` | 8431 |
| `packages/isomorphic/yaml.ts` | 2631 |

## Why unmodified

Not one line is edited, so updating is a copy and a diff rather than a merge.
Two things make that possible:

- **esbuild does not typecheck.** These files are written against Playwright's
  tsconfig, not ours; ours would reject them. The bundler only transpiles, and
  `browser-agent/` is excluded from the repo's `tsconfig.json` and eslint.
- **The `@isomorphic/…` alias is resolved by the bundler**, not by an edit to
  the import lines (`scripts/build-browser-agent.mjs`).

`import type * as yamlTypes from 'yaml'` in `isomorphic/ariaSnapshot.ts` is a
type-only import, erased before it reaches the bundle. There is no runtime
dependency on the `yaml` package.

## Updating

Follow major versions only; there is no reason to track patches of a tree
format that changes slowly.

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/playwright /tmp/pw
cd /tmp/pw
git sparse-checkout set packages/injected packages/isomorphic
git fetch --depth 1 origin tag vX.Y.0 && git checkout vX.Y.0
```

Copy the nine files back over this directory, then check that the closure has
not grown — a new `import` in any of them may pull in a tenth file:

```
pnpm browser:agent          # esbuild fails loudly on an unresolved import
pnpm browser:agent:probe    # drives the rebuilt bundle in real Chrome
```

Watch for changes to `mode: 'ai'` in `injected/ariaSnapshot.ts`
(`toInternalOptions`). That mode is the whole contract: `refs: 'interactable'`
is what decides which elements an agent can name, and `renderCursorPointer` is
what marks a roleless `<div>` that behaves like a button.
