// `monaco-editor/base/common/uri.js` (the package's `./*.js` export, which maps
// onto `esm/vs/base/common/uri.js`) is a leaf module that ships no type
// declarations, so importing it directly (tests use it to exercise Monaco's URI
// normalization without loading the full DOM-bound editor) would otherwise be an
// implicit `any` (TS7016). It re-exports the same class as Monaco's public
// `Uri`, so borrow that type.
declare module "monaco-editor/base/common/uri.js" {
  export const URI: typeof import("monaco-editor").Uri
}
