#!/usr/bin/env node
// Prints the springs of the motion tokens (10.8) as CSS `linear()` curves,
// ready to paste into `src/app/globals.css`. The solver is
// `src/lib/motion/spring.ts` (Node strips its types); its test checks the
// stylesheet matches.
//
//   node --no-warnings scripts/gen-spring-linear.mjs
//
// (`--no-warnings` quiets Node reparsing the `.ts` file as a module.)

import {
  SPRING_TOKENS,
  overshoot,
  settleTime,
  springLinear,
} from "../src/lib/motion/spring.ts"

for (const [name, params] of SPRING_TOKENS) {
  const settle = Math.round(settleTime(params) * 1000)
  const over = (overshoot(params) * 100).toFixed(1)
  console.log(
    `  /* mass ${params.mass}, stiffness ${params.stiffness}, damping ${params.damping}: settles in ${settle} ms, ${over}% overshoot */`
  )
  console.log(`  ${name}: ${springLinear(params)};`)
}
