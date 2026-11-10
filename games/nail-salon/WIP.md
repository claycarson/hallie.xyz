# Nail salon: build state (2026-11-10)

Branch `nail-salon`. Spec: ~/Documents/Repositories/tasks/2026-11-10_nail-salon-mockups/PLAN.md

**Not runnable yet.** Written, untested in a browser (no index.html / main.js yet):
- data/: tuning, hand (stand-in frame + fold numbers), camera, themes, catalog (cream only)
- src/hand/outline.js (7 shapes, 96 points, CPU SDF), frame.js, standin.js (procedural finger),
  plate.js (skin heightfield by raycast + plate with sunk edges), sdf.js (GPU SDF), materials.js
- src/engine/gpu.js (render-target helpers), src/paint/targets.js, stamps.js, stroke.js

Still to write for M0.1 + M0.3–M0.5: index.html, src/main.js (boot, HDRI, camera, loop),
src/paint/stats.js (256² readback), src/input/pointer.js, src/debug/overlay.js + `__salon` test
API, tests/shot.mjs + tests/robot.mjs (Playwright WebKit, `npm run serve` on 8813).

Choices made (differ from PLAN wording, same intent):
- The plate conforms to a raycast skin heightfield so `sink` is measured from the real skin.
- Pointer → paint mapping will use that heightfield, not per-sample mesh raycasts.
- Stamps are masked where there is no skin, so a stroke off the tip is not a spill.
- A stand-in finger is used until the hand bake-off (M0.2, Clay picks).
