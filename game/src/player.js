// player.js — EMBERLINE Foundry 7
//
// Module contract: one combatant's mutable state — health, armour, money,
// weapons, grenades, score — plus the per-tick player update (read input,
// build a wish velocity, fire/reload, plant/defuse channels). Bots reuse
// the same state shape (see bots.js) but drive it with AI instead of keys.
//
// Design rationale: health 100 + armour that absorbs 50% of damage until
// it breaks; money follows the CS-style economy in rounds.js. The player
// carries a primary, a sidearm and up to three grenade types; slot keys
// switch, R reloads, B opens the buy menu (freeze only), E plants/defuses.
// Recoil is a real mechanic: every shot kicks the pitch up and blooms the
// spread, and the bloom only settles when you stop firing — spraying while
// moving is supposed to miss.
//
// Tuning notes: base spread is per-weapon radians; moving adds up to
// +0.02, airborne +0.03, ADS multiplies by 0.45. Headshots deal x4.
// Armour: 50% absorption, armour takes the absorbed half. Kill +$300,
// plant +$300 (rounds.js). Respawn each round at full health with the
// weapons bought in the freeze.

import { WEAPONS, createWeaponInstance } from './weapons.js';
import { createBody, moveBody, eyeHeight } from './mover.js';

export function createCombatant(id, name, team, x, z, yaw, isPlayer = false) {
  return {
    id,
    name,
    team, // 'ember' (attackers) or 'ash' (defenders)
    isPlayer,
    body: createBody(x, z),
    yaw,
    pitch: 0,
    hp: 100,
    armour: 0,
    alive: true,
    money: 800,
    kills: 0,
    deaths: 0,
    // Loadout: primary slot, sidearm slot, grenade counts.
    weapons: [createWeaponInstance(WEAPONS['ar7']), createWeaponInstance(WEAPONS['p9'])],
    slot: 0,
    grenades: { frag: 0, flash: 0, smoke: 0 },
    grenadeSel: 'frag',
    hasKit: false,
    hasBomb: false,
    // Channels: plant/defuse progress in ticks (0 = idle).
    channel: null, // { kind: 'plant'|'defuse', ticks: 0, need: 180|300 }
    spreadBloom: 0,
    recoilPitch: 0,
    lastShotTick: -999,
    flashUntilTick: -1,
    flashStrength: 0,
    // Bot-only fields (ignored for the player).
    ai: null,
    // View-model bob (visual, derived from movement, not sim state).
    bobPhase: 0,
  };
}

export function currentWeapon(c) {
  return c.weapons[c.slot];
}

export function eyePos(c) {
  return {
    x: c.body.pos.x,
    y: c.body.pos.y + eyeHeight(c.body),
    z: c.body.pos.z,
  };
}

// Damage with armour absorption. Returns true if the hit killed.
export function applyDamage(target, amount) {
  if (!target.alive) return false;
  let remaining = amount;
  if (target.armour > 0) {
    const absorbed = Math.min(target.armour, remaining * 0.5);
    target.armour -= absorbed;
    remaining -= absorbed;
  }
  target.hp -= remaining;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.channel = null;
    return true;
  }
  return false;
}

export function healRound(c) {
  c.hp = 100;
  c.alive = true;
  c.channel = null;
  c.spreadBloom = 0;
  c.recoilPitch = 0;
  c.flashUntilTick = -1;
  c.flashStrength = 0;
}

// Per-tick player update. `input` is the frame's key/mouse state, `game`
// carries the world, the round and the fire/grenade callbacks.
export function updatePlayer(c, input, game, tick) {
  if (!c.alive) return;
  const body = c.body;
  body.crouched = input.crouch;
  const w = currentWeapon(c);
  const ads = input.ads && w.def.ads;
  // Wish velocity from WASD, rotated by yaw. Forward is -Z in view space.
  const speed = ads ? 3.0 : body.crouched ? 2.6 : 5.2;
  const sin = Math.sin(c.yaw);
  const cos = Math.cos(c.yaw);
  let fx = 0;
  let fz = 0;
  if (input.forward) { fx -= sin; fz -= cos; }
  if (input.back) { fx += sin; fz += cos; }
  if (input.left) { fx -= cos; fz += sin; }
  if (input.right) { fx += cos; fz -= sin; }
  const len = Math.hypot(fx, fz);
  const wish = len > 0
    ? { x: (fx / len) * speed, z: (fz / len) * speed }
    : { x: 0, z: 0 };
  moveBody(body, game.map.colliders, wish, input.jump, 1 / 60);

  // Mouse look. Sensitivity 0.0023; pitch clamped so you cannot flip.
  c.yaw -= input.lookDX * 0.0023;
  c.pitch -= input.lookDY * 0.0023;
  c.pitch = Math.max(-1.55, Math.min(1.55, c.pitch));
  // Recoil recovery: the pitch kick decays back toward the aim point.
  if (c.recoilPitch > 0) {
    const rec = Math.min(c.recoilPitch, 0.12);
    c.recoilPitch -= rec;
    c.pitch -= rec * 0.25;
  }
  // Spread bloom decays when not firing.
  if (tick - c.lastShotTick > 12) c.spreadBloom = Math.max(0, c.spreadBloom - 0.004);

  // Fire / reload / slot switching, gated by the round state.
  const canAct = game.round.phase === 'live' || game.round.phase === 'planted';
  if (canAct && input.fire) game.fireWeapon(c, tick);
  if (input.reloadPressed) game.startReload(c, tick);
  if (input.slotPressed !== -1) game.switchSlot(c, input.slotPressed);
  if (input.grenadePressed) game.throwGrenade(c, tick);
  if (input.cyclePressed) {
    const order = ['frag', 'flash', 'smoke'];
    c.grenadeSel = order[(order.indexOf(c.grenadeSel) + 1) % order.length];
  }
  if (input.buyPressed) game.toggleBuy(c);
  if (input.useHeld) game.useChannel(c, tick);

  // View bob: purely cosmetic, driven by horizontal speed.
  const hSpeed = Math.hypot(body.vel.x, body.vel.z);
  c.bobPhase += hSpeed * 0.09;
}
