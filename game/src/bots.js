// bots.js — EMBERLINE Foundry 7
//
// Module contract: the AI for the nine non-player combatants. Each bot is a
// combatant with an `ai` block: { role, state, path, pathI, target,
// lastThinkTick, burstLeft, aimErr, objective }. Bots think every 6 ticks
// (0.1 s) and act every tick: follow a waypoint path, scan for visible
// enemies, burst-fire with distance-scaled aim error, plant/defuse the
// bomb, rotate on round events.
//
// Design rationale: bots must be readable opponents, not aimbots. Vision
// is a 100-degree cone, 40 m range, blocked by walls and smoke; hearing
// is a 28 m radius on any shot. Aim error grows with distance and target
// speed, and fire comes in 3–5 round bursts with pauses, so a player who
// peeks, shoots and repositions wins duels. Roles split the team: two
// attackers rush a site, two lurk mid, one (the carrier) walks the bomb
// in; defenders hold sites, rotate on sound, and defuse when the bomb is
// down. Economy-aware buys: bots buy what they can afford in freeze.
//
// Tuning notes: bot walk speed 4.6 m/s (slightly slower than the player),
// reaction delay 12–24 ticks after first seeing a target, burst 3–5,
// pause 18–30 ticks, aim error 0.008–0.05 rad scaled by distance. Plant
// takes 180 ticks, defuse 300 (150 with a kit). A bot that loses its
// target for 5 s returns to its route.

import { nearestNode, findPath } from './map.js';
import { eyePos, currentWeapon, createCombatant } from './player.js';
import { WEAPONS, createWeaponInstance, fireWeapon, startReload, finishReload } from './weapons.js';
import { moveBody } from './mover.js';

const BOT_NAMES_EMBER = ['Slag', 'Crucible', 'Tongs', 'Soot'];
const BOT_NAMES_ASH = ['Anvil', 'Quench', 'Mould', 'Ingot', 'Bellows'];

export function createBots(game) {
  const bots = [];
  const rng = game.rng;
  // Ember teammates (attackers): spawn south, rush north.
  for (let i = 0; i < 4; i += 1) {
    const s = game.map.spawns.attack[i + 1] ?? game.map.spawns.attack[0];
    bots.push(makeBot(game, `bot-e${i}`, BOT_NAMES_EMBER[i], 'ember', s.x, s.z, s.yaw, rng));
  }
  // Ash defenders: hold the north, two near the sites.
  for (let i = 0; i < 5; i += 1) {
    const s = game.map.spawns.defend[i];
    bots.push(makeBot(game, `bot-a${i}`, BOT_NAMES_ASH[i], 'ash', s.x, s.z, s.yaw, rng));
  }
  return bots;
}

function makeBot(game, id, name, team, x, z, yaw, rng) {
  const c = createCombatant(id, name, team, x, z, yaw, false);
  c.ai = {
    role: team === 'ember' ? (rng.chance(0.4) ? 'rusher' : 'lurker') : 'holder',
    state: 'roam',
    path: [],
    pathI: 0,
    target: null,
    targetSeenTick: -999,
    lastThinkTick: -999,
    burstLeft: 0,
    burstPauseUntil: 0,
    aimErr: 0.02,
    reactUntil: 0,
    objective: null, // waypoint index
    hearPos: null,
    strafeDir: 1,
    strafeUntil: 0,
  };
  return c;
}

// Can `a` see `b` right now? Cone + range + LOS (walls and smoke).
export function canSee(game, a, b) {
  if (!b.alive) return false;
  const ae = eyePos(a);
  const be = eyePos(b);
  const dx = be.x - ae.x;
  const dz = be.z - ae.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 40) return false;
  // Vision cone: 100 degrees around the bot's yaw (or 360 while flashed? no).
  const fx = -Math.sin(a.yaw);
  const fz = -Math.cos(a.yaw);
  if (dist > 1 && (fx * dx + fz * dz) / dist < Math.cos(0.87)) return false;
  const smokes = game.grenades ? game.grenades.smokes.map((s) => ({ x: s.x, z: s.z, r: s.r })) : [];
  return !game.map.losBlocked(ae.x, ae.y, ae.z, be.x, be.y, be.z, smokes);
}

// Pick the nearest visible enemy for a bot.
function acquireTarget(game, bot) {
  let best = null;
  let bestD = Infinity;
  for (const other of game.combatants) {
    if (other.team === bot.team || !other.alive) continue;
    const d = Math.hypot(other.body.pos.x - bot.body.pos.x, other.body.pos.z - bot.body.pos.z);
    if (d < bestD && canSee(game, bot, other)) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

function setPathTo(game, bot, x, z) {
  const nodes = game.map.waypoints;
  const from = nearestNode(nodes, bot.body.pos.x, bot.body.pos.z);
  const to = nearestNode(nodes, x, z);
  bot.ai.path = findPath(nodes, from, to);
  bot.ai.pathI = 0;
  bot.ai.objective = to;
}

function followPath(game, bot, tick) {
  const ai = bot.ai;
  if (!ai.path.length || ai.pathI >= ai.path.length) return { x: 0, z: 0 };
  const node = game.map.waypoints[ai.path[ai.pathI]];
  const dx = node.x - bot.body.pos.x;
  const dz = node.z - bot.body.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.9) {
    ai.pathI += 1;
    return followPath(game, bot, tick);
  }
  const speed = 4.6;
  // Face the walk direction.
  bot.yaw = Math.atan2(-dx, -dz);
  return { x: (dx / dist) * speed, z: (dz / dist) * speed };
}

function botBuy(bot, game) {
  // Economy-aware: buy the best primary the bot can actually afford,
  // paying the difference from its current primary (sidearm is free).
  const rng = game.rng;
  const primary = currentWeapon(bot);
  const currentPrice = primary.def.kind === 'primary' ? primary.def.price : 0;
  const budget = bot.money + currentPrice;
  let pick = null;
  if (budget >= 4750 && rng.chance(0.25)) pick = WEAPONS.lr50;
  else if (budget >= 2700) pick = WEAPONS.ar7;
  else if (budget >= 1250) pick = WEAPONS.vk9;
  if (pick && pick.id !== primary.def.id) {
    bot.weapons[0] = createWeaponInstance(pick);
    bot.money = budget - pick.price;
  }
  if (bot.team === 'ash' && bot.money >= 650 && rng.chance(0.6)) {
    bot.armour = 100;
    bot.money -= 650;
  }
  if (bot.team === 'ash' && bot.money >= 400 && rng.chance(0.4)) {
    bot.hasKit = true;
    bot.money -= 400;
  }
  if (rng.chance(0.5)) bot.grenades.frag = 1;
  bot.slot = 0;
}

// One think step (every 6 ticks) + one action step (every tick).
export function updateBot(bot, game, tick) {
  if (!bot.alive) return;
  const ai = bot.ai;
  const rng = game.rng;
  const round = game.round;

  // --- think (0.1 s cadence) ---
  if (tick - ai.lastThinkTick >= 6) {
    ai.lastThinkTick = tick;
    const seen = acquireTarget(game, bot);
    if (seen) {
      ai.target = seen;
      ai.targetSeenTick = tick;
      if (tick >= ai.reactUntil) ai.reactUntil = tick + rng.int(12, 24);
    } else if (ai.target && tick - ai.targetSeenTick > 300) {
      ai.target = null;
    }
    // Objective: attackers push a site; defenders hold or rotate.
    // A heard shot overrides the route: investigate it first.
    if (!ai.target && round.phase === 'live' && !ai.path.length) {
      if (ai.hearPos) {
        setPathTo(game, bot, ai.hearPos.x, ai.hearPos.z);
        ai.hearPos = null;
        ai.state = 'investigate';
      } else if (bot.team === 'ember') {
        const site = bot.hasBomb ? game.round.targetSite : (rng.chance(0.5) ? game.map.sites.A : game.map.sites.B);
        const jx = site.x + rng.range(-2, 2);
        const jz = site.z + rng.range(-2, 2);
        setPathTo(game, bot, jx, jz);
        ai.state = 'rush';
      } else {
        // Defenders: hold near a site or mid, re-pick every so often.
        const hold = rng.pick([
          game.map.sites.A, game.map.sites.B,
          { x: 0, z: -4 }, { x: -9, z: -2 }, { x: 9, z: -2 },
        ]);
        setPathTo(game, bot, hold.x + rng.range(-2, 2), hold.z + rng.range(-2, 2));
        ai.state = 'hold';
      }
    }
    // Bomb logic: carrier plants when alone at a site; defenders defuse.
    // Guard on !bot.channel: re-setting the channel every think would
    // reset its progress to zero and the plant would never complete.
    if (round.phase === 'live' && bot.hasBomb && bot.team === 'ember' && !bot.channel) {
      const site = game.round.targetSite;
      const d = Math.hypot(bot.body.pos.x - site.x, bot.body.pos.z - site.z);
      if (d < site.r && !ai.target) {
        bot.channel = { kind: 'plant', ticks: 0, need: 180 };
        ai.state = 'plant';
      }
    }
    if (round.phase === 'planted' && bot.team === 'ash' && !ai.target && !bot.channel) {
      const bp = game.round.bombPos;
      const d = Math.hypot(bot.body.pos.x - bp.x, bot.body.pos.z - bp.z);
      if (d < 2.2) {
        bot.channel = { kind: 'defuse', ticks: 0, need: bot.hasKit ? 150 : 300 };
        ai.state = 'defuse';
      } else if (!ai.path.length) {
        setPathTo(game, bot, bp.x, bp.z);
        ai.state = 'rotate';
      }
    }
  }

  // --- act (every tick) ---
  const body = bot.body;
  let wish = { x: 0, z: 0 };
  if (bot.channel) {
    // Channelling: stand still, progress handled in rounds.js.
    wish = { x: 0, z: 0 };
  } else if (ai.target && tick >= ai.reactUntil) {
    // Combat: face the target, strafe, burst fire.
    const t = ai.target;
    const dx = t.body.pos.x - bot.body.pos.x;
    const dz = t.body.pos.z - bot.body.pos.z;
    const dist = Math.hypot(dx, dz);
    bot.yaw = Math.atan2(-dx, -dz);
    bot.pitch = 0;
    if (tick >= ai.strafeUntil) {
      ai.strafeDir = rng.chance(0.5) ? 1 : -1;
      ai.strafeUntil = tick + rng.int(30, 70);
    }
    const strafe = ai.strafeDir * 2.2;
    const approach = dist > 14 ? 3.2 : dist < 6 ? -1.5 : 0;
    const fx = -Math.sin(bot.yaw);
    const fz = -Math.cos(bot.yaw);
    const rx = -fz;
    const rz = fx;
    wish = {
      x: fx * approach + rx * strafe,
      z: fz * approach + rz * strafe,
    };
    // Burst fire with distance-scaled aim error.
    const w = currentWeapon(bot);
    if (ai.burstLeft <= 0 && tick >= ai.burstPauseUntil) {
      ai.burstLeft = rng.int(3, 5);
      ai.aimErr = 0.008 + dist * 0.0009 + rng.range(0, 0.012);
    }
    if (ai.burstLeft > 0 && tick >= w.nextFireTick && !w.reloading) {
      // Aim error: temporarily perturb the bot's yaw/pitch for this shot.
      const savedYaw = bot.yaw;
      const savedPitch = bot.pitch;
      bot.yaw += rng.gauss() * ai.aimErr;
      bot.pitch += rng.gauss() * ai.aimErr * 0.6;
      const res = fireWeapon(bot, game, tick);
      bot.yaw = savedYaw;
      bot.pitch = savedPitch;
      if (res && !res.dry) {
        ai.burstLeft -= 1;
        if (ai.burstLeft <= 0) ai.burstPauseUntil = tick + rng.int(18, 30);
        game.audio?.shot(w.def.id, dist);
      }
    }
    if (w.mag === 0 && !w.reloading) startReload(bot, game, tick);
  } else {
    // No target: walk the route.
    wish = followPath(game, bot, tick);
    if (ai.hearPos && !ai.path.length) {
      setPathTo(game, bot, ai.hearPos.x, ai.hearPos.z);
      ai.hearPos = null;
    }
  }

  moveBody(body, game.map.colliders, wish, false, 1 / 60);
  if (bot.channel) {
    // Channel progress lives in rounds.js; a hit cancels it there.
  }
  const w = currentWeapon(bot);
  if (w.reloading && tick >= w.reloadEndTick) finishReload(bot);
}

// Called when a shot rings out: bots within range investigate the sound.
export function alertBotsNear(game, shooter, radius) {
  for (const c of game.combatants) {
    if (c.isPlayer || !c.alive || c === shooter || !c.ai) continue;
    const d = Math.hypot(c.body.pos.x - shooter.body.pos.x, c.body.pos.z - shooter.body.pos.z);
    if (d <= radius && !c.ai.target) {
      c.ai.hearPos = { x: shooter.body.pos.x, z: shooter.body.pos.z };
      if (!c.ai.path.length) {
        // Investigate on the next think; store the position now.
      }
    }
  }
}

export { botBuy };
