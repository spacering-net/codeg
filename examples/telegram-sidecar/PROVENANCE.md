# Source provenance and licensing

This optional sidecar was originally developed on 2026-11-22 as a standalone
Node.js client of Codeg's HTTP APIs and WebSocket events. The contribution is
based on the repaired 0.1.1 implementation. Its own source is contributed under
Apache-2.0, matching Codeg; see [LICENSE](LICENSE).

The creation record named `ccmux`, `ccgram`, and `takopi` as interaction-design
references for topic-based sessions, inline approval buttons, incremental output,
and desktop synchronization. It did not identify exact forks or revisions. The
records reviewed do not show cloning, downloading, or importing source from
those projects. This records the scope of the available evidence; it does not
assert that the named projects are runtime dependencies or identify an unverified
single source repository.

The following corresponding repositories and license snapshots were checked on
2026-11-25. The two `ccgram` entries make the unresolved repository-name ambiguity
explicit. All original copyright notices and complete license texts are retained
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

| Repository checked                                                  | License    | Copyright holder in the snapshot                     |
| ------------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| [epilande/ccmux](https://github.com/epilande/ccmux)                 | MIT        | 2026 epilande                                        |
| [alexei-led/ccgram](https://github.com/alexei-led/ccgram)           | MIT        | 2026 Alexei Ledenev; 2026 six-ddc (original project) |
| [jsayubi/ccgram](https://github.com/jsayubi/ccgram)                 | MIT        | 2026 JS Ayubi                                        |
| [banteg/takopi](https://github.com/banteg/takopi)                   | MIT        | 2025 banteg                                          |
| [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 | See its upstream license and notices                 |

The sidecar uses Node.js built-in modules and does not have third-party npm
runtime dependencies. This fact is separate from the source-provenance review.
`cloudflared` is an optional executable installed by the operator and is invoked
as a child process; its source and binary are not bundled in this contribution.

MIT permits incorporation into Apache-2.0 projects, but any copied code or
substantial portion must retain the applicable MIT copyright and permission
notice. Future third-party imports must record the exact source files, repository,
revision, license, and modifications. If distributing `cloudflared`, retain its
Apache-2.0 license and applicable third-party notices.

Private creation transcripts, deployment configuration, account identifiers,
tokens, runtime state, logs, and locally installed executables are not part of
this source contribution. Test identities and paths are synthetic fixtures.
