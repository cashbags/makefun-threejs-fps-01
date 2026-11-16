// rounds.js — EMBERLINE Foundry 7
//
// Module contract: the match state machine. Phases: 'freeze' (12 s buy
// time) -> 'live' (100 s) -> 'planted' (35 s bomb timer) -> 'roundEnd'
// (5 s) -> next round, until first to 8 or 15 rounds, then 'matchEnd'.
// It owns the economy (round bonuses, kill/plant rewards, loss streaks),
// the bomb carrier, plant/defuse channels, and round win detection.
//
// Design rationale: the round is the game's heartbeat — every system
// hangs off the phase. Freeze is the only time the buy menu works, which
// makes money meaningful. The bomb is the objective that forces contact:
// attackers must commit to a site, defenders must retake. Win by
// elimination, detonation, defuse, or timeout (defenders take timeouts
// when the bomb is not planted). First to 8, max 15 rounds.
//
// Tuning notes: freeze 720 ticks, round 6000, bomb 2100, round-end 300.
// Plant 180 ticks (3 s), defuse 300 (150 with a kit). Economy: start
// $800, kill +$300, plant +$300, win +$3,250, loss +$1,900 plus $500 per
// consecutive loss, capped at $3,400. The carrier is picked from living
// attackers each round (the player gets it sometimes, so planting is
// playable, not bot-only).

import { healRound } from './player.js';
import { botBuy } from './bots.js';

export const FREEZE_TICKS = 720;
export const ROUND_TICKS = 6000;
export const BOMB_TICKS = 2100;
export const ROUND_END_TICKS = 300;
export const PLANT_TICKS = 180;

export function createRound(game) {
  return {
    phase: 'freeze',
    phaseTick: 0,
    roundNumber: 1,
    score: { ember: 0, ash: 0 },
    lossStreak: { ember: 0, ash: 0 },
    targetSite: game.map.sites.A,
    bombPos: null,
    bombPlantedTick: 0,
    carrier: null,
    winner: null, // { team, reason } of the last finished round
    matchWinner: null,
    banner: null, // { text, sub, untilTick } for the HUD
  };
}

function startRound(game, tick) {
  const r = game.round;
  r.phase = 'freeze';
  r.phaseTick = 0;
  r.bombPos = null;
  r.winner = null;
  // Alternate the target site each round so both lanes see play.
  r.targetSite = r.roundNumber % 2 === 1 ? game.map.sites.A : game.map.sites.B;
  // Respawn everyone at their spawn points, heal, clear channels.
  const attackers = game.combatants.filter((c) => c.team === 'ember');
  const defenders = game.combatants.filter((c) => c.team === 'ash');
  attackers.forEach((c, i) => {
    const s = game.map.spawns.attack[i % game.map.spawns.attack.length];
    c.body.pos.x = s.x;
    c.body.pos.z = s.z;
    c.body.pos.y = 0;
    c.body.vel.x = 0;
    c.body.vel.y = 0;
    c.body.vel.z = 0;
    c.yaw = s.yaw;
    c.pitch = 0;
    healRound(c);
  });
  defenders.forEach((c, i) => {
    const s = game.map.spawns.defend[i % game.map.spawns.defend.length];
    c.body.pos.x = s.x;
    c.body.pos.z = s.z;
    c.body.pos.y = 0;
    c.body.vel.x = 0;
    c.body.vel.y = 0;
    c.body.vel.z = 0;
    c.yaw = s.yaw;
    c.pitch = 0;
    healRound(c);
  });
  // Pick a bomb carrier among the attackers (player included).
  const carrier = attackers[game.rng.int(0, attackers.length - 1)];
  for (const c of attackers) c.hasBomb = false;
  carrier.hasBomb = true;
  r.carrier = carrier;
  // Bots buy during freeze.
  for (const c of game.combatants) {
    if (!c.isPlayer) botBuy(c, game);
  }
  game.hud?.announce(`Round ${r.roundNumber} — plant at ${r.targetSite.name}`, 'Freeze — buy with B');
  game.audio?.roundStart();
}

export function endRound(game, team, reason, tick) {
  const r = game.round;
  if (r.phase === 'roundEnd' || r.phase === 'matchEnd') return;
  r.phase = 'roundEnd';
  r.phaseTick = 0;
  r.winner = { team, reason };
  r.score[team] += 1;
  const loser = team === 'ember' ? 'ash' : 'ember';
  r.lossStreak[loser] += 1;
  r.lossStreak[team] = 0;
  // Economy.
  for (const c of game.combatants) {
    if (c.team === team) {
      c.money += 3250;
    } else {
      c.money += Math.min(3400, 1900 + (r.lossStreak[loser] - 1) * 500);
    }
    c.money = Math.min(c.money, 16000);
  }
  const label = team === 'ember' ? 'EMBER wins the round' : 'ASH wins the round';
  r.banner = { text: label, sub: reason, untilTick: tick + ROUND_END_TICKS };
  game.hud?.announce(label, reason);
  game.audio?.roundEnd(team === 'ember');
  game.events.push({ kind: 'round', text: `${label} — ${reason}`, tick });
  // Bomb detonation visuals at the fuse moment.
  if (reason === 'Bomb detonated' && r.bombPos) {
    game.effects?.explosion(r.bombPos, 12);
    game.audio?.explosion();
  }
  // Match end?
  if (r.score[team] >= 8 || r.roundNumber >= 15) {
    r.phase = 'matchEnd';
    const winner = r.score.ember > r.score.ash ? 'ember'
      : r.score.ash > r.score.ember ? 'ash' : 'draw';
    r.matchWinner = winner;
    r.banner = {
      text: winner === 'draw' ? 'Match drawn' : `${winner === 'ember' ? 'EMBER' : 'ASH'} takes Foundry 7`,
      sub: `Final score ${r.score.ember} — ${r.score.ash}`,
      untilTick: tick + 3600,
    };
    game.hud?.announce(r.banner.text, r.banner.sub);
  }
}

function aliveCount(game, team) {
  return game.combatants.filter((c) => c.team === team && c.alive).length;
}

// Player/bot "use" channel: hold E near a site (plant, if carrier) or
// near the planted bomb (defuse). Progress is in ticks; taking damage or
// moving cancels it (handled by the caller resetting channel).
export function useChannel(c, game, tick) {
  const r = game.round;
  if (!c.alive || c.channel) return;
  if (r.phase === 'live' && c.hasBomb && c.team === 'ember') {
    const site = r.targetSite;
    const d = Math.hypot(c.body.pos.x - site.x, c.body.pos.z - site.z);
    if (d < site.r) {
      c.channel = { kind: 'plant', ticks: 0, need: PLANT_TICKS };
      game.audio?.plantBeep();
    }
  } else if (r.phase === 'planted' && c.team === 'ash' && r.bombPos) {
    const d = Math.hypot(c.body.pos.x - r.bombPos.x, c.body.pos.z - r.bombPos.z);
    if (d < 2.2) {
      c.channel = { kind: 'defuse', ticks: 0, need: c.hasKit ? 150 : 300 };
      game.audio?.defuseBeep();
    }
  }
}

// Advance all channels by one tick. Called from the main sim tick.
export function updateChannels(game, tick) {
  const r = game.round;
  for (const c of game.combatants) {
    if (!c.alive || !c.channel) continue;
    c.channel.ticks += 1;
    if (c.channel.ticks >= c.channel.need) {
      if (c.channel.kind === 'plant') {
        r.phase = 'planted';
        r.phaseTick = 0;
        r.bombPlantedTick = tick;
        r.bombPos = { x: c.body.pos.x, z: c.body.pos.z };
        c.hasBomb = false;
        c.money += 300;
        r.banner = { text: 'Bomb planted', sub: `${c.name} planted at ${r.targetSite.name}`, untilTick: tick + 180 };
        game.hud?.announce('Bomb planted', `${c.name} — 35 seconds`);
        game.audio?.bombPlanted();
        game.events.push({ kind: 'plant', text: `${c.name} planted the bomb`, tick });
        game.effects?.plantMarker(r.bombPos);
      } else {
        endRound(game, 'ash', 'Bomb defused', tick);
      }
      c.channel = null;
    }
  }
}

export function updateRound(game, tick) {
  const r = game.round;
  r.phaseTick += 1;
  if (r.phase === 'freeze' && r.phaseTick >= FREEZE_TICKS) {
    r.phase = 'live';
    r.phaseTick = 0;
    game.hud?.announce('Go — plant the bomb', 'Ember attacks, Ash defends');
  } else if (r.phase === 'live') {
    if (aliveCount(game, 'ash') === 0) endRound(game, 'ember', 'Ash eliminated', tick);
    else if (aliveCount(game, 'ember') === 0) endRound(game, 'ash', 'Ember eliminated', tick);
    else if (r.phaseTick >= ROUND_TICKS) endRound(game, 'ash', 'Time expired — no plant', tick);
  } else if (r.phase === 'planted') {
    if (aliveCount(game, 'ash') === 0) {
      // Defenders dead: the bomb still has to go off.
      if (r.phaseTick >= BOMB_TICKS) endRound(game, 'ember', 'Bomb detonated', tick);
    } else if (aliveCount(game, 'ember') === 0) {
      // Attackers dead but the bomb is live: defenders must defuse in time.
      if (r.phaseTick >= BOMB_TICKS) endRound(game, 'ember', 'Bomb detonated', tick);
    } else if (r.phaseTick >= BOMB_TICKS) {
      endRound(game, 'ember', 'Bomb detonated', tick);
    }
  } else if (r.phase === 'roundEnd' && r.phaseTick >= ROUND_END_TICKS) {
    if (r.matchWinner) {
      r.phase = 'matchEnd';
      return;
    }
    r.roundNumber += 1;
    startRound(game, tick);
  }
}

export { startRound };
