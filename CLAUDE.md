# island — a frontier rendering R&D playground

This repository exists to **invent** rendering technology, not to assemble it. Whatever
survives here gets lifted into a separate game. Nothing here is a demo for its own sake:
every system is a prototype of something that has to hold up at shipping scale.

## The standard

We are building AAA-grade graphics technology **and beyond**. That is the actual bar, and
it is not negotiable downward.

- **Technical excellence over expedience.** If there is a correct way and a fast way, we
  build the correct way. A quick fix that "works for now" is a debt with compounding
  interest, and this repo does not take on that debt.
- **No bandaids.** Clamping a symptom, special-casing an input, hiding an artefact behind
  a magic epsilon, or padding a threshold until the bug stops showing are all forbidden.
  Find the actual cause. Fix the actual cause.
- **"Proven approach" is not an argument.** The proven approach is the floor, not the
  ceiling. It tells you what everyone already has. We are here for what they don't. Reach
  for the state of the art, then push past it.
- **Pain is the price of the good stuff.** The hard version — the one that takes real
  derivation, real profiling, real rewrites — is the one worth doing. Cost, effort and
  time are inputs, not excuses. If a task looks painful, that is usually a signal that it
  is the right task.
- **Correct by construction beats correct by testing.** Prefer designs where the failure
  mode is impossible rather than merely unlikely.

When a shortcut is genuinely the right call — a stub behind a clean seam, a placeholder
asset — say so explicitly and mark it. Silent compromise is the thing we refuse.

## Engineering rules that follow from that

These are not style preferences. They are consequences of the standard above.

1. **WebGPU only.** No WebGL fallback path is built, ever. A fallback splits every shader
   into two implementations and drags the ceiling down to whatever the weaker backend can
   do. `WebGPUOnlyRenderer` in `src/app.ts` exists specifically to make the fallback
   unreachable, so failures are loud and honest.
2. **Shaders are written, not configured.** Effects live as real WGSL in
   `src/effects/*.wgsl`, bound into the TSL node graph through `shader()`. Reach for hand-
   written WGSL when the node graph would obscure the maths.
3. **Effects must be scale-independent.** No threshold may silently depend on the camera's
   near/far, the world's size, the framerate, or the display resolution. Linearise,
   normalise, or make it relative — then it survives contact with a real level.
4. **Simulation is fixed-step; presentation is interpolated.** Physics never runs on the
   frame delta. Anything read for rendering is interpolated between the last two
   simulation states. Rendering never mutates simulation state.
5. **What you see is what you collide with.** Render geometry and collision geometry come
   from one source of truth. Terrain render meshes are extracted from the Jolt shape
   itself; brushes emit their collider and their mesh from the same description. An
   invisible wall is a bug in the pipeline, not a level-design quirk.
6. **No per-frame allocation on hot paths.** Scratch pools, preallocated temporaries,
   reused typed arrays. The GC is not a budget line we spend casually.
7. **WASM memory is owned, not garbage collected.** Every `new Jolt.X()` has an explicit
   owner and an explicit destruction. Reference-counted Jolt types (`Shape`,
   `*Settings`, `CharacterBase`, …) are `AddRef`'d when we take ownership and `Release`'d
   when we drop it. Values returned *by value* from Jolt (`Vec3`, `Quat`, `ShapeResult`,
   matrices) point at a static scratch inside the module — read them immediately, never
   store them, never destroy them.
8. **Measure, don't assume.** GPU timestamps and draw/triangle counters are on screen.
   A performance claim without a number in front of it is a guess.
9. **Determinism where it is free.** Procedural content is seeded and hash-based, never
   `Math.random()`, so a world can be reproduced exactly from its seed.

## Architecture

```
src/
  main.ts              bootstrap + fatal-error surface
  app.ts               orchestrator: renderer, render pipeline, frame loop, UI
  styles.ts            render styles (vertex programs + post chains) selectable at runtime
  effects/             raw WGSL + the TSL nodes that feed it
  lens/                the camera as a function: projection family, tile fit, resample
  physics/             Jolt ownership: module load, layers, fixed-step world, character
  player/              input capture and the first-person controller/camera rig
  world/               the level: procedural terrain, static brushes, dynamic props
```

- `lens/` is the camera. `projection.ts` is the map from canvas pixels to world
  directions — rectilinear, an isotropic radial family, and a world-axis
  cylindrical family whose vertical map is `F(ε) = ∫secᵅ`. Pitch is an *exact*
  image translation at every setting — verified at 3e-13 px against a
  rectilinear frame's 2441 px — which is the whole reason it exists. Two dials
  buy back straightness with yaw rigidity, and only yaw's: `straighten` bends
  the azimuth map from linear towards tangent, which unbows lines running away
  from the viewer, and `upright` moves the vertical map from absolute elevation
  towards the vertical-plane one, which is the only thing that unbows a level
  line running *across* the view. The readout prices both live, in pixels of
  departure from a rigid slide per 10 degrees turned.
- `lens/tiles.ts` is a stub behind a clean seam, and marked as one. A fixed-
  function rasterizer cannot be handed a nonlinear camera, so the frame is cut
  into a grid, each cell gets a per-frame fitted frustum, and a resample pass
  puts them back through the real lens. A ray or micro-polygon pipeline pays
  none of that; the fitting maths is what transfers, since the Jacobian it
  computes is the pixel-density term a cluster LOD metric needs.
- A render style never sees the scene. It consumes the lens's resolved colour
  and its world-normal/radial-distance buffer, which is what lets the camera
  stop being linear without every effect having to be rewritten.
- `lens.anchor(weld)` is what the rigidity is *for*. Because the cylindrical map
  is shift-invariant there is one metric image plane wrapped around the eye, and
  a mark indexed by a fragment's address on it is welded to the world while
  keeping a constant size in pixels — the third option between screen-space
  marks that swim and world-space marks that swell. Measured: at 720.9 px/rad,
  turning 0.08 rad slides the ruling 58 px against a predicted 57.7, and 0 px
  with the anchor wound off. The "Engraved plate" style is the demonstration.
- `physics/world.ts` owns the fixed-step accumulator and hands back an interpolation alpha.
- `player/player.ts` splits per-frame work (look, at render rate, zero added latency) from
  per-tick work (locomotion, at simulation rate).
- `world/world.ts` is the scene composition root; it is the only file that knows what is
  actually in the level.
- A render style may graft a `vertexNode` onto every scene material, so any new material
  must go through the world's material registry to stay stylable.

## Working in this repo

- `npm run dev` to iterate, `npm run build` to typecheck + bundle.
- **Physics changes are verifiable without a GPU.** `jolt-physics` runs under
  plain Node, so a throwaway `.mjs` probe can assert the things that actually
  matter — that a staircase is climbed by exactly its total rise, that a 55°
  ramp is refused, that extracted terrain vertices land on the lattice — before
  anything is rendered. Write the probe, read the numbers, then delete it.
- `npx tsc --noEmit` must be clean. `strict`, `noUnusedLocals`, and
  `exactOptionalPropertyTypes` are on deliberately — do not loosen `tsconfig.json` to make
  an error go away.
- **A WGSL entry point's parameter list must carry no `//` comments.** three
  re-emits it as `fn name ( <params> )` on one line, so a comment on the last
  parameter eats the closing bracket and the compiler then blames the first line
  of the body. Document parameters above the function.
- Comments explain **why**, especially the non-obvious physical or numerical reasoning.
  Do not narrate what the code already says.
- Prefer deleting a mediocre system over extending it.
- **Ship the mechanism, not the garnish.** Cosmetic layers nobody asked for — head bob,
  view lean, telemetry panels — are weight that hides the system underneath. Build the
  thing that is hard and load-bearing; leave the seasoning to whoever asks for it.
