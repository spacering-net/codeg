import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The same alias esbuild resolves for the bundle: Playwright's sources
      // import each other through it, and honouring it here is what lets them
      // stay byte-identical to upstream.
      "@isomorphic": path.resolve(
        __dirname,
        "./browser-agent/vendor/playwright/isomorphic"
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // `browser-agent/` is the isolated-world bundle's source. It is outside
    // `src/` because it is built by esbuild, not Next, and its vendored half
    // is held to Playwright's compiler settings rather than ours.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "browser-agent/**/*.{test,spec}.ts",
    ],
    exclude: ["node_modules", "out", ".next", "src-tauri"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "browser-agent/vendor/**",
        "node_modules/",
        ".next/**",
        "out/**",
        "src/test-setup.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/*.config.*",
        "**/*.d.ts",
        "src-tauri/**",
      ],
    },
  },
})
