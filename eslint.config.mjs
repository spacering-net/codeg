import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import eslintConfigPrettier from "eslint-config-prettier"
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"

/**
 * `target="_blank"` on a raw anchor is a trap: it opens a tab in the browser
 * (web mode, `next dev`) and does NOTHING in the desktop webview, which
 * registers no new-window handler. The bug is invisible until someone runs the
 * packaged app. `<BrowserLink>` keeps the attribute AND routes the click
 * through the platform opener; it is the only place allowed to write one.
 */
const BLANK_TARGET_MESSAGE =
  'A bare <a target="_blank"> is dead in the desktop webview. Use <BrowserLink> from @/components/ui/browser-link.'

const noRawBlankTarget = {
  selector:
    "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='target'][value.value='_blank']",
  message: BLANK_TARGET_MESSAGE,
}

/** The same attribute written as an expression — `target={"_blank"}`. */
const noRawBlankTargetExpression = {
  selector:
    "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='target'] > JSXExpressionContainer > Literal[value='_blank']",
  message: BLANK_TARGET_MESSAGE,
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/target/**",
    "src-tauri/experts/**",
    "public/vs/**",
    // Gitignored scratch space for planning/review docs and one-off probe
    // scripts. Prettier already skips it — its `--ignore-path` defaults to
    // `.gitignore` — but flat config has no such default, so without this
    // `pnpm eslint .` fails the repo on files that are not in the repo.
    ".docs/**",
    // Playwright's aria tree, vendored byte-for-byte so that updating it is a
    // copy rather than a merge (browser-agent/vendor/playwright/VENDOR.md).
    // It is written against Playwright's lint and compiler settings, not ours.
    "browser-agent/vendor/**",
    // esbuild's output, committed so a cargo build needs no node.
    "src-tauri/src/browser/js/**",
  ]),
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
  {
    rules: {
      "prettier/prettier": "error",
      "no-restricted-syntax": [
        "error",
        noRawBlankTarget,
        noRawBlankTargetExpression,
      ],
    },
  },
  {
    // Conversation render path: the aggregate workspace hook subscribes to
    // the high-frequency fileTabs slice, so any consumer here would
    // re-render on every keystroke / watcher reload in the file editor.
    // Use the narrow slice hooks instead.
    files: [
      "src/components/chat/**",
      "src/components/message/**",
      "src/components/ai-elements/**",
      "src/components/conversations/**",
    ],
    rules: {
      // Flat config REPLACES a rule's options rather than merging them, so
      // this block has to restate every restriction that applies here — drop
      // the blank-target pair and these four directories silently lose it.
      "no-restricted-syntax": [
        "error",
        noRawBlankTarget,
        noRawBlankTargetExpression,
        {
          selector: "CallExpression[callee.name='useWorkspaceContext']",
          message:
            "Hot path: use useWorkspaceActions / useWorkspaceView / useWorkspaceFileTabs instead of the aggregate useWorkspaceContext (it re-renders on every fileTabs change).",
        },
      ],
    },
  },
  {
    // The one anchor that is allowed to ask for a new window — it pairs the
    // attribute with the opener call that actually delivers one.
    files: ["src/components/ui/browser-link.tsx"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
])

export default eslintConfig
