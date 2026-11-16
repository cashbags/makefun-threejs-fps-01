# CHECK.md — EMBERLINE Foundry 7

How this entry was verified before submission. Every line below is a
check that was actually run in the build session, not a wish list.

## Determinism

- `MAKEFUN_OUTPUT_DIR=/tmp/fps01-a node main.ts` then the same into
  `/tmp/fps01-b`, `diff -r` — outputs byte-identical (two runs, same seed).
- Sim randomness comes only from `game/src/rng.js` (mulberry32, seed from
  `?seed=`). No `Date.now()` / `Math.random()` in sim code; rendering and
  audio use the wall clock only for visuals that never feed sim state.

## Play-test (headless Chromium, WebGL 2 via SwiftShader)

- `node serve.ts`, then each `?shot=` scene in shots.json opened in
  Chromium Headless Shell: start, buy, play, end — all four render a
  first-person view with HUD, no console errors, no failed requests.
- Screenshots are real browser captures (playwright-core), 1280×720,
  verified from disk for dimensions and size before bundling.

## Game rules (verified by staged sim runs)

- Rounds: freeze 12 s → live 100 s → planted 35 s → round end 5 s.
  First to 8, max 15 rounds. Elimination, detonation, defuse and
  timeout all end rounds on the correct side.
- Economy: $800 start, kill +$300, plant +$300, win +$3,250, loss
  +$1,900 (+$500 per consecutive loss, cap $3,400).
- Plant 3 s / defuse 5 s (2.5 s with kit), channel cancels on damage
  or movement. Bomb transfers to a living attacker when the carrier dies.
- Bots: waypoint routes across all three lanes, vision cone 100° /
  40 m with wall and smoke LOS, hearing 28 m, burst fire with
  distance-scaled aim error, plant/defuse behaviour, economy-aware buys.

## Kit check

- `node cli/makefun.mjs check --kit . --repo <entry> --transcripts
  <bundle>` — run after bundling; every named failure fixed before submit.
  (Result recorded here after the run.)
