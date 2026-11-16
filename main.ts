// main.ts — EMBERLINE Foundry 7 (threejs-fps-01 entrypoint)
//
// Design header: this file is the entry's hand-in. It does three things
// and nothing else: copy game/ and screenshots/ from beside this file
// into /output, then write /output/dossier.json with the kit's vendored
// buildDossier. The game itself is static ES modules under game/; the
// dossier is the summary the house judge reads (screenshots first, then
// source text capped at 163,840 bytes). Nothing here is random and
// nothing reads the clock, so two runs write byte-identical output —
// the determinism check depends on that.
//
// Run it: MAKEFUN_OUTPUT_DIR=out node main.ts  (node 22, stdlib only)
// Serve it: node serve.ts, then open http://localhost:8080

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Copy the playable game and the screenshots into the output directory.
mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// Write the judge's dossier under the scorer's caps: at most 4 screenshots
// of 256 KiB, at most 993 game files / 48 MiB, source text at most
// 163,840 bytes, output at most 1000 entries / 64 MiB.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
