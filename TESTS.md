# TESTS.md — EMBERLINE Foundry 7

Test notes for the build session. The game has no test runner dependency;
verification is done with the kit CLI, deterministic replays, and staged
browser runs (see CHECK.md for the checklist).

## Smoke tests run

1. `node main.ts` with `MAKEFUN_OUTPUT_DIR` set — writes dossier.json,
   game/ and screenshots/ to /output; exit 0.
2. Determinism replay — two runs, `diff -r` clean.
3. `node serve.ts` + headless Chromium — all four `?shot=` scenes load,
   render WebGL, and produce 1280×720 captures.
4. Sim soak — 300 staged ticks (5 s of live combat) run without errors;
   bots move, acquire targets, fire, and the round state machine advances.

## Known limits

- Bots do not jump and do not use grenades; grenades are player-only.
- No side swap at half-time: Ember always attacks, Ash always defends.
- Minimap is a 2D top-down render; it does not show heights.
- Audio is synthesised WebAudio only; it needs a user gesture before
  the AudioContext starts (browsers block autoplay).

## Manual play-test (desktop Chrome)

- Open http://localhost:8080 after `node serve.ts`, click to lock the
  pointer. WASD move, mouse look, LMB fire, RMB aim, R reload, B buy
  (freeze only), E plant/defuse, 1/2 weapons, 3 grenade, Q cycle grenade.
- Expected: freeze 12 s with buy menu, round starts, bots advance on
  both sites, kill feed updates, round ends and the next round starts.
