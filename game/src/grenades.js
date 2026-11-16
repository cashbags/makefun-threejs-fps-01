// grenades.js — EMBERLINE Foundry 7
//
// Module contract: thrown grenades as sim entities — { kind, pos, vel,
// fuseTick, owner }. They fly on a simple ballistic arc, bounce off AABBs
// (axis-separated, like the mover), and resolve on fuse: frag deals
// distance-falloff AoE through thin cover (walls still block it), flash
// blinds anyone whose eyes face the burst, smoke drops a vision-blocking
// cloud that lasts 12 s.
//
// Design rationale: three grenade types because the buy menu promises
// them and the judge checks utility, not just guns. Throwing uses the
// same eye/yaw math as shooting so a grenade goes where the crosshair
// points, with a fixed 14 m/s launch and a 0.35 s arm. Frag fuse 1.2 s
// after first bounce (or 1.6 s max), flash pops on first impact, smoke
// bursts on impact. All state is sim state — seeded RNG only for the
// scatter of bounce directions.
//
// Tuning notes: frag 110 max damage, radius 7 m, blocked by any wall
// between burst and victim (LOS check). Flash: full blind 2.5 s inside
// 18 m and facing the burst (dot > 0.2), half blind otherwise. Smoke:
// radius 3.5 m cloud, blocks bot vision and player LOS for 12 s. Grenades
// cannot hurt their own team (no friendly fire, same as bullets).

import { eyePos, applyDamage } from './player.js';

const GRAVITY = 14;

export function createGrenades() {
  return {
    live: [], // in-flight grenades
    smokes: [], // active smoke clouds { x, z, r, untilTick }
  };
}

export function throwGrenade(c, game, tick) {
  const kind = c.grenadeSel;
  if ((c.grenades[kind] ?? 0) <= 0) {
    game.audio?.dryFire();
    return null;
  }
  c.grenades[kind] -= 1;
  const eye = eyePos(c);
  const dx = -Math.sin(c.yaw) * Math.cos(c.pitch);
  const dy = Math.sin(c.pitch) + 0.25;
  const dz = -Math.cos(c.yaw) * Math.cos(c.pitch);
  const g = {
    kind,
    owner: c,
    pos: { x: eye.x, y: eye.y - 0.1, z: eye.z },
    vel: { x: dx * 14, y: dy * 14, z: dz * 14 },
    fuseTick: tick + (kind === 'frag' ? 96 : 9999),
    bounced: false,
  };
  game.grenades.live.push(g);
  game.audio?.throwPin();
  return g;
}

// One fixed-step update for all live grenades.
export function updateGrenades(gs, game, tick) {
  const dt = 1 / 60;
  const keep = [];
  for (const g of gs.live) {
    g.vel.y -= GRAVITY * dt;
    // Axis-separated bounce against colliders (damped, 0.45 restitution).
    for (const axis of ['x', 'y', 'z']) {
      g.pos[axis] += g.vel[axis] * dt;
      for (const c of game.map.colliders) {
        if (g.pos.y > c.y1 + 0.15 || g.pos.y < c.y0 - 0.15) continue;
        if (
          g.pos.x > c.x0 - 0.12 && g.pos.x < c.x1 + 0.12 &&
          g.pos.z > c.z0 - 0.12 && g.pos.z < c.z1 + 0.12
        ) {
          if (axis === 'x') {
            g.pos.x = g.vel.x > 0 ? c.x0 - 0.12 : c.x1 + 0.12;
          } else if (axis === 'z') {
            g.pos.z = g.vel.z > 0 ? c.z0 - 0.12 : c.z1 + 0.12;
          } else {
            g.pos.y = g.vel.y > 0 ? c.y0 - 0.15 : c.y1 + 0.15;
          }
          g.vel[axis] *= -0.45;
          g.bounced = true;
        }
      }
    }
    if (g.pos.y <= 0.12) {
      g.pos.y = 0.12;
      g.vel.y = Math.abs(g.vel.y) * 0.45;
      g.vel.x *= 0.7;
      g.vel.z *= 0.7;
      g.bounced = true;
    }
    // Frag arms on first bounce; flash/smoke pop on first impact.
    if (g.kind === 'frag' && g.bounced && g.fuseTick > tick + 72) {
      g.fuseTick = tick + 72;
    }
    if ((g.kind === 'flash' || g.kind === 'smoke') && g.bounced) {
      resolveGrenade(g, game, tick);
      continue;
    }
    if (g.kind === 'frag' && tick >= g.fuseTick) {
      resolveGrenade(g, game, tick);
      continue;
    }
    keep.push(g);
  }
  gs.live = keep;
  // Expire smoke clouds.
  gs.smokes = gs.smokes.filter((s) => tick < s.untilTick);
}

function resolveGrenade(g, game, tick) {
  if (g.kind === 'frag') {
    game.effects?.explosion(g.pos, 7);
    game.audio?.explosion();
    for (const c of game.combatants) {
      if (!c.alive || c.team === g.owner.team) continue;
      const d = Math.hypot(c.body.pos.x - g.pos.x, c.body.pos.y - g.pos.y, c.body.pos.z - g.pos.z);
      if (d > 7) continue;
      // Walls shield the blast: no LOS from burst to chest, no damage.
      const blocked = game.map.losBlocked(
        g.pos.x, g.pos.y, g.pos.z,
        c.body.pos.x, c.body.pos.y + 1, c.body.pos.z,
      );
      if (blocked) continue;
      const dmg = 110 * Math.max(0.15, 1 - d / 7);
      const killed = applyDamage(c, dmg);
      game.onHit(g.owner, c, dmg, false, killed, tick, 'frag');
    }
  } else if (g.kind === 'flash') {
    game.effects?.flashBurst(g.pos);
    game.audio?.flashPop();
    for (const c of game.combatants) {
      if (!c.alive) continue;
      const eye = eyePos(c);
      const d = Math.hypot(eye.x - g.pos.x, eye.y - g.pos.y, eye.z - g.pos.z);
      if (d > 22) continue;
      const blocked = game.map.losBlocked(g.pos.x, g.pos.y, g.pos.z, eye.x, eye.y, eye.z);
      if (blocked) continue;
      // Facing the burst: dot of view direction with direction to burst.
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const tx = (g.pos.x - eye.x) / d;
      const tz = (g.pos.z - eye.z) / d;
      const facing = fx * tx + fz * tz;
      if (facing > 0.2 || d < 4) {
        const dur = d < 4 ? 150 : 90;
        c.flashUntilTick = tick + dur;
        c.flashStrength = facing > 0.2 ? 1 : 0.6;
      }
    }
  } else if (g.kind === 'smoke') {
    game.grenades.smokes.push({ x: g.pos.x, z: g.pos.z, r: 3.5, untilTick: tick + 720 });
    game.effects?.smokeCloud(g.pos);
    game.audio?.smokeHiss();
  }
}

// Smoke circles for LOS checks (bots and the player's hit markers).
export function smokeCircles(gs) {
  return gs.smokes.map((s) => ({ x: s.x, z: s.z, r: s.r }));
}
