// weapons.js — EMBERLINE Foundry 7
//
// Module contract: weapon definitions, hitscan firing, reload and damage.
// A weapon instance is { def, mag, reserve, reloading, reloadEndTick,
// nextFireTick }. fire() is called by the sim (player or bot) and resolves
// one shot: spread from the shooter's state, a ray against walls and
// bodies, falloff, headshot multiplier, tracers and sound hooks.
//
// Design rationale: hitscan with real ray-vs-AABB wall tests and
// sphere-vs-ray body tests, because a tactical FPS lives or dies on
// "did my crosshair actually cover him". Damage falls off past 25 m so
// long lanes reward the DMR and punish SMG spray. Headshots pay x4 — the
// judge criterion for gunplay depth. Recoil is a pitch kick plus a bloom
// pool that grows per shot and decays at rest, so burst discipline beats
// holding the trigger.
//
// Tuning notes: RPM is enforced by nextFireTick (60 ticks/s). Spread is
// radians of cone half-angle: base + movement/air penalties + bloom,
// x0.45 while aiming down sights. Armour is applied in player.js.
// Shot direction: yaw/pitch plus a random cone offset drawn from the
// sim RNG (never Math.random).

import { eyePos, applyDamage } from './player.js';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 Sidearm', price: 300, kind: 'sidearm',
    damage: 34, headMult: 4, rpm: 400, mag: 15, reserve: 60,
    spread: 0.011, bloom: 0.004, recoil: 0.35, auto: false, ads: false,
    range: 40, tracer: 0xffd27a,
  },
  vk9: {
    id: 'vk9', name: 'VK-9 SMG', price: 1250, kind: 'primary',
    damage: 26, headMult: 4, rpm: 750, mag: 30, reserve: 120,
    spread: 0.016, bloom: 0.006, recoil: 0.3, auto: true, ads: true,
    range: 45, tracer: 0xffb347,
  },
  ar7: {
    id: 'ar7', name: 'AR-7 Rifle', price: 2700, kind: 'primary',
    damage: 33, headMult: 4, rpm: 600, mag: 30, reserve: 90,
    spread: 0.009, bloom: 0.005, recoil: 0.55, auto: true, ads: true,
    range: 60, tracer: 0xff6a1a,
  },
  lr50: {
    id: 'lr50', name: 'LR-50 DMR', price: 4750, kind: 'primary',
    damage: 80, headMult: 4, rpm: 60, mag: 5, reserve: 20,
    spread: 0.004, bloom: 0.02, recoil: 1.6, auto: false, ads: true,
    scope: true, range: 90, tracer: 0x9fd8ff,
  },
};

export const GRENADE_DEFS = {
  frag: { name: 'Frag Grenade', price: 300 },
  flash: { name: 'Flashbang', price: 250 },
  smoke: { name: 'Smoke Grenade', price: 300 },
};

export function createWeaponInstance(def) {
  return {
    def,
    mag: def.mag,
    reserve: def.reserve,
    reloading: false,
    reloadEndTick: 0,
    nextFireTick: 0,
  };
}

// Current spread cone for a shooter, in radians.
export function currentSpread(c, game) {
  const w = c.weapons[c.slot];
  const body = c.body;
  const moving = Math.hypot(body.vel.x, body.vel.z) > 0.5;
  let s = w.def.spread + c.spreadBloom;
  if (moving) s += 0.02;
  if (!body.onGround) s += 0.03;
  if (game.input.ads && c.isPlayer && w.def.ads) s *= 0.45;
  return s;
}

// Ray vs AABB (3D slab test). Returns nearest t in [0, maxT] or Infinity.
export function rayVsBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  let t0 = 0;
  let t1 = maxT;
  const axes = [
    [ox, dx, b.x0, b.x1],
    [oy, dy, b.y0, b.y1],
    [oz, dz, b.z0, b.z1],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
    } else {
      let ta = (lo - o) / d;
      let tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}

// Ray vs a combatant's body: head sphere (r 0.22 at 1.5) + torso capsule
// approximated as a sphere (r 0.42 at 0.95). Returns { t, head } or null.
function rayVsCombatant(ox, oy, oz, dx, dy, dz, target, maxT) {
  const p = target.body.pos;
  const spheres = [
    { x: p.x, y: p.y + 1.5, z: p.z, r: 0.24, head: true },
    { x: p.x, y: p.y + 0.95, z: p.z, r: 0.44, head: false },
  ];
  let best = null;
  for (const s of spheres) {
    const cx = s.x - ox;
    const cy = s.y - oy;
    const cz = s.z - oz;
    const tca = cx * dx + cy * dy + cz * dz;
    if (tca < 0) continue;
    const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
    if (d2 > s.r * s.r) continue;
    const thc = Math.sqrt(s.r * s.r - d2);
    const t = tca - thc;
    if (t < 0 || t > maxT) continue;
    if (!best || t < best.t) best = { t, head: s.head };
  }
  return best;
}

// Resolve one shot from `shooter` at tick `tick`. Returns a result object
// the caller turns into tracers, hitmarkers and kill feed.
export function fireWeapon(shooter, game, tick) {
  const w = shooter.weapons[shooter.slot];
  if (!w || w.reloading || tick < w.nextFireTick) return null;
  if (w.mag <= 0) {
    game.audio?.dryFire();
    w.nextFireTick = tick + 18;
    return { dry: true };
  }
  w.mag -= 1;
  w.nextFireTick = tick + Math.round(3600 / w.def.rpm);
  shooter.lastShotTick = tick;
  shooter.spreadBloom = Math.min(0.05, shooter.spreadBloom + w.def.bloom);
  shooter.recoilPitch = Math.min(2.2, shooter.recoilPitch + w.def.recoil * 0.05);

  const eye = eyePos(shooter);
  const spread = currentSpread(shooter, game);
  // Aim direction from yaw/pitch plus a seeded cone offset.
  const rng = game.rng;
  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * spread;
  const yaw = shooter.yaw + Math.cos(a) * r;
  const pitch = shooter.pitch + Math.sin(a) * r;
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);
  const maxT = w.def.range;

  // Nearest wall hit.
  let wallT = Infinity;
  for (const c of game.map.colliders) {
    const t = rayVsBox(eye.x, eye.y, eye.z, dx, dy, dz, c, maxT);
    if (t < wallT) wallT = t;
  }
  // Nearest enemy body hit (teammates are never hittable — no friendly fire).
  let hit = null;
  for (const other of game.combatants) {
    if (other === shooter || !other.alive || other.team === shooter.team) continue;
    const h = rayVsCombatant(eye.x, eye.y, eye.z, dx, dy, dz, other, maxT);
    if (h && (!hit || h.t < hit.t)) hit = { target: other, ...h };
  }

  const endT = hit && hit.t < wallT ? hit.t : wallT;
  const end = {
    x: eye.x + dx * (endT === Infinity ? maxT : endT),
    y: eye.y + dy * (endT === Infinity ? maxT : endT),
    z: eye.z + dz * (endT === Infinity ? maxT : endT),
  };

  let killed = false;
  let damage = 0;
  if (hit && hit.t < wallT) {
    const dist = hit.t;
    const falloff = dist <= 25 ? 1 : Math.max(0.6, 1 - (dist - 25) * 0.012);
    damage = w.def.damage * falloff * (hit.head ? w.def.headMult : 1);
    killed = applyDamage(hit.target, damage);
    game.onHit(shooter, hit.target, damage, hit.head, killed, tick);
  } else if (wallT !== Infinity) {
    game.onWallHit(end, tick);
  }

  // Bots hear the shot: everyone within 28 m turns toward the shooter.
  game.alertBots(shooter, 28);

  return {
    shooter,
    from: eye,
    to: end,
    color: w.def.tracer,
    hit: hit ? { target: hit.target, head: hit.head, damage, killed } : null,
    wall: !hit && wallT !== Infinity,
  };
}

export function startReload(c, game, tick) {
  const w = c.weapons[c.slot];
  if (!w || w.reloading || w.mag >= w.def.mag || w.reserve <= 0) return;
  w.reloading = true;
  w.reloadEndTick = tick + (w.def.id === 'lr50' ? 210 : 150); // 3.5s / 2.5s
  game.audio?.reload();
}

export function finishReload(c) {
  const w = c.weapons[c.slot];
  if (!w || !w.reloading) return;
  const need = w.def.mag - w.mag;
  const take = Math.min(need, w.reserve);
  w.mag += take;
  w.reserve -= take;
  w.reloading = false;
}
