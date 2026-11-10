# Streamdown 2.7.0 highlighting lifecycle

The `HighlightedCodeBlockBody` effect now supplies an optional `AbortSignal`
to its highlighter plugin and aborts it on a code/language/theme change or
unmount. Plugins that ignore the extra option continue to work unchanged.
Both the executable ESM chunk and the exported TypeScript interface are patched.
Streamdown has no CommonJS entrypoint.

Codeg uses this lifecycle to remove a superseded Markdown request from the shared
highlighter's callbacks and retry waiters. Work is capped at 16 distinct requests;
there is at most one waiter per live code view, removed at the next streaming
update or unmount. Waiters do not retain token trees or a second cache key. This
avoids accumulating all historical prefixes while still eventually highlighting
every mounted block after a cold-engine burst. Callback-only consumers without
an abort signal have a separate 128-waiter safety limit and fall back to plaintext
beyond it. Codeg's Markdown and file/tool views supply a lifecycle.

`src/lib/code-highlighter-streamdown.test.tsx` renders the installed Streamdown
package with the real Shiki service, including 24 concurrent blocks. It also
checks that actual component replacement and unmount abort every plugin request.
Service tests exercise saturation, cancelled streaming prefixes, unmounts,
coalescing, and the cache budgets. Remove or revisit this patch when upgrading
Streamdown or after upstream provides an equivalent cancellation lifecycle.
