/**
 * Lucide's `user-round-star`, which the pinned lucide-react (0.564) predates
 * — it ships `user-star`, the square-shouldered figure, but not the round
 * one. Built with lucide's own factory from the upstream path data, so it
 * draws and sizes like every other lucide icon (and carries the same
 * `lucide-user-round-star` class). Swap for the library's export once
 * lucide-react is upgraded past it.
 */

import { createLucideIcon } from "lucide-react"

export const UserRoundStar = createLucideIcon("user-round-star", [
  [
    "path",
    {
      d: "M16.051 12.616a1 1 0 0 1 1.909.024l.737 1.452a1 1 0 0 0 .737.535l1.634.256a1 1 0 0 1 .588 1.806l-1.172 1.168a1 1 0 0 0-.282.866l.259 1.613a1 1 0 0 1-1.541 1.134l-1.465-.75a1 1 0 0 0-.912 0l-1.465.75a1 1 0 0 1-1.539-1.133l.258-1.613a1 1 0 0 0-.282-.867l-1.156-1.152a1 1 0 0 1 .572-1.822l1.633-.256a1 1 0 0 0 .737-.535z",
      key: "zk5tfr",
    },
  ],
  ["path", { d: "M2 21a8 8 0 0 1 6.778-7.905", key: "5a3ycp" }],
  ["path", { d: "M8.927 12.885a5 5 0 1 1 6.061-4.535", key: "x2wh3b" }],
])
