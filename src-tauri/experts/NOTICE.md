# Third-Party Notice — Expert Skills

The 15 skills under `src-tauri/experts/skills/` are vendored from
[obra/superpowers v7.0.1](https://github.com/obra/superpowers/releases/tag/v7.0.1),
commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`.

The skill files follow the upstream `skills/` tree. Codeg carries three
standalone-runtime adaptations:

- `writing-skills/package.json` contains `{"type":"module"}`. Codeg installs
  each skill as a standalone directory, outside the upstream repository's root
  ESM package scope, so this marker lets `render-graphs.js` run on Node
  versions without automatic ESM detection.
- `executing-plans/scripts/task-brief`, `sdd-workspace`, and `review-package`
  are local copies of
  the matching upstream helpers from `subagent-driven-development`.
- `executing-plans/scripts/task-start` and `task-done` prefer those local
  helpers and retain a sibling fallback for older installations. The skill
  text also points its workspace and review commands at the local copies.

The helper copies make a partial or Windows copy-mode installation safe: an
unrelated skill in the agent directory cannot shadow the intended helper, and
the plan workflow does not require a sibling skill to be installed. All
adaptations are included in the bundle so extraction and on-disk hashes match.

`experts.toml` is Codeg's localized catalog. Upstream plugin manifests and
startup hooks are not installed: Codeg manages skill discovery and links for
each agent itself.

To update, check out the desired upstream release in a separate directory,
replace this bundle's `skills/` with upstream `skills/` (including deletions),
and restore `writing-skills/package.json`. Update the source revision here and
the catalog when the skill set or workflows change. Compare both trees;
the documented standalone adaptations should be the only differences. Run the
`commands::experts::tests` Rust tests and
`scripts/test-superpowers-skill-layouts.sh` to check catalog coverage, the
20,000-byte compaction limit, recursive extraction, stable hashes, executable
permissions, and all supported helper layouts.

## Upstream MIT License

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
