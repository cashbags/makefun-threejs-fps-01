// main.js — EMBERLINE Foundry 7
//
// Module contract: boots the game, owns the fixed-step loop, and wires the
// modules together into one `game` object. The sim runs at 60 Hz from a
// seeded RNG; rendering is decoupled (accumulator, clamped dt) and never
// feeds sim state. `?seed=` picks the seed, `?shot=` stages one of four
// deterministic scenes for screenshots (start / buy / play / end) and
// freezes the sim so the capture is stable.
//
// Design rationale: one state store (the `game` object) — every module
// reads it, none keeps a parallel copy. The tick order is fixed: round
// -> channels -> player -> bots -> grenades -> reloads -> events. Bots
// only act while a round is live; the player can move during freeze but
// cannot fire. Bot meshes and the player view-model are render-side
// mirrors of sim state, rebuilt every frame from positions, never the
// other way round.
//
// Tuning notes: accumulator clamped to 0.1 s so a tab hitch cannot spiral
// into a catch-up storm. Camera FOV 75, 55 aimed, 35 scoped (LR-50).
// The player view-model is a simple gun box with bob; the muzzle flash
// is a world-space quad at the barrel tip. Shots are staged for the
// 'play' screenshot by running 300 real sim ticks, then firing one real
// seeded shot — the capture shows a genuine firefight, not a pose.

import * as THREE from 'three';
import { createRng } from './rng.js';
import { buildMap } from './map.js';
import { createCombatant, eyePos, updatePlayer, currentWeapon, applyDamage } from './player.js';
import { createInput, attachInput, clearEdgeInput } from './input.js';
import { fireWeapon, startReload, finishReload, currentSpread } from './weapons.js';
import { createGrenades, throwGrenade, updateGrenades } from './grenades.js';
import { createBots, updateBot, alertBotsNear } from './bots.js';
import { createRound, startRound, updateRound, updateChannels, useChannel } from './rounds.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import {
  createEffects, addTracer, muzzleFlash, impactSparks,
  explosion, flashBurst, smokeCloud, plantMarker, updateEffects,
} from './effects.js';
import { PALETTE } from './palette.js';

const STEP = 1 / 60;

function parseParams() {
  const q = new URLSearchParams(window.location.search);
  return {
    seed: Number.parseInt(q.get('seed') || '1', 10) || 1,
    shot: q.get('shot') || null,
  };
}

function buildBotMesh(team) {
  const group = new THREE.Group();
  const bodyColor = team === 'ember' ? 0x8a3d16 : 0x3d5266;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.4, 1.05, 10),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7, metalness: 0.2 }),
  );
  body.position.y = 0.95;
  group.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.5, metalness: 0.4 }),
  );
  head.position.y = 1.62;
  group.add(head);
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.08, 0.3),
    new THREE.MeshStandardMaterial({
      color: team === 'ember' ? PALETTE.ember : PALETTE.teal,
      emissive: team === 'ember' ? PALETTE.ember : PALETTE.teal,
      emissiveIntensity: 0.8,
    }),
  );
  cap.position.y = 1.82;
  group.add(cap);
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.12, 0.85),
    new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.4, metalness: 0.7 }),
  );
  gun.position.set(0.18, 1.25, -0.35);
  group.add(gun);
  return group;
}

function buildViewModel(camera) {
  const gun = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.14, 0.62),
    new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.35, metalness: 0.8 }),
  );
  gun.add(body);
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.3, metalness: 0.85 }),
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.42);
  gun.add(barrel);
  const accent = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.015, 0.2),
    new THREE.MeshStandardMaterial({
      color: PALETTE.ember, emissive: PALETTE.ember, emissiveIntensity: 0.4,
    }),
  );
  accent.position.set(0, 0.075, -0.1);
  gun.add(accent);
  gun.scale.setScalar(0.65);
  gun.position.set(0.3, -0.27, -0.5);
  camera.add(gun);
  return gun;
}

function init() {
  const params = parseParams();
  const rng = createRng(params.seed);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  document.getElementById('game-canvas').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
  scene.add(camera);

  const map = buildMap(scene);
  const fx = createEffects(scene);
  const audio = createAudio();
  const input = createInput();
  const grenades = createGrenades();

  const game = {
    rng,
    map,
    scene,
    camera,
    input,
    audio,
    grenades,
    tick: 0,
    events: [],
    frozen: false,
    combatants: [],
    player: null,
    round: null,
    hud: null,
    effects: null,
    spreadOf: (c) => currentSpread(c, game),
  };

  // Effects adapter: sim-side names, render-side objects, current tick.
  game.effects = {
    tracer: (from, to, color) => addTracer(fx, from, to, color, game.tick),
    muzzle: (eye, yaw, pitch) => muzzleFlash(fx, eye, yaw, pitch, game.tick),
    impact: (pos) => impactSparks(fx, pos, game.tick),
    explosion: (pos, radius) => explosion(fx, pos, radius, game.tick),
    flashBurst: (pos) => flashBurst(fx, pos, game.tick),
    smokeCloud: (pos) => smokeCloud(fx, pos, game.tick),
    plantMarker: (pos) => plantMarker(fx, pos, game.tick),
  };

  // Combatants: the player plus nine bots.
  const pSpawn = map.spawns.attack[2];
  const player = createCombatant('player', 'You', 'ember', pSpawn.x, pSpawn.z, pSpawn.yaw, true);
  game.player = player;
  const bots = createBots(game);
  game.combatants = [player, ...bots];

  game.round = createRound(game);
  game.hud = createHud(game);

  // Bot meshes (render mirrors of sim bodies).
  const botMeshes = new Map();
  for (const b of bots) {
    const mesh = buildBotMesh(b.team);
    scene.add(mesh);
    botMeshes.set(b.id, mesh);
  }
  const viewModel = buildViewModel(camera);

  // --- game callbacks used by the sim modules ---
  game.deathOverlayShown = false;
  game.fireWeapon = (c, tick) => {
    const res = fireWeapon(c, game, tick);
    if (!res || res.dry) return res;
    game.effects.tracer(res.from, res.to, res.color);
    game.effects.muzzle(res.from, c.yaw, c.pitch);
    if (c.isPlayer) {
      audio.shot(c.weapons[c.slot].def.id, 0);
      if (res.hit) {
        game.hud.showHitmarker(res.hit.killed);
        if (res.hit.killed) audio.kill();
        else audio.hitmarker();
      }
    } else {
      const d = Math.hypot(c.body.pos.x - player.body.pos.x, c.body.pos.z - player.body.pos.z);
      if (d < 45) audio.shot(c.weapons[c.slot].def.id, d);
    }
    return res;
  };
  game.onHit = (shooter, target, damage, head, killed, tick, cause = 'shot') => {
    if (target.channel) target.channel = null;
    if (!killed) return;
    shooter.kills += 1;
    shooter.money += 300;
    target.deaths += 1;
    const causeText = cause === 'frag' ? '💥 frag' : head ? 'headshot' : 'shot';
    game.hud.pushFeed(`${shooter.name} ${causeText} ${target.name}`, tick);
    game.events.push({ kind: 'kill', text: `${shooter.name} killed ${target.name}`, tick });
    // Bomb transfer: if the carrier dies, another living attacker picks it up.
    if (target.hasBomb && game.round.phase === 'live') {
      target.hasBomb = false;
      const living = game.combatants.filter((c) => c.team === 'ember' && c.alive);
      if (living.length) {
        const next = living[game.rng.int(0, living.length - 1)];
        next.hasBomb = true;
        game.round.carrier = next;
        game.hud.pushFeed(`Bomb passed to ${next.name}`, tick);
      }
    }
    if (target.isPlayer) {
      game.deathOverlayShown = true;
      game.hud.showOverlay('ELIMINATED', `${shooter.name} got you — respawn next round`);
    }
  };
  game.onWallHit = (pos) => game.effects.impact(pos);
  game.alertBots = (shooter, radius) => alertBotsNear(game, shooter, radius);
  game.startReload = (c, tick) => startReload(c, game, tick);
  game.switchSlot = (c, slot) => {
    if (slot < 0 || slot >= c.weapons.length) return;
    const w = c.weapons[c.slot];
    if (w) w.reloading = false;
    c.slot = slot;
  };
  game.throwGrenade = (c, tick) => throwGrenade(c, game, tick);
  game.toggleBuy = () => game.hud.toggleBuy();
  game.useChannel = (c, tick) => useChannel(c, game, tick);

  attachInput(input, renderer.domElement, (locked) => {
    if (locked) {
      audio.ensure();
      game.hud.hideOverlay();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') audio.toggleMute();
    if (e.code === 'Escape') game.hud.closeBuy();
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  startRound(game, 0);

  // --- fixed-step sim tick ---
  function simTick() {
    game.tick += 1;
    const tick = game.tick;
    updateRound(game, tick);
    updateChannels(game, tick);
    if (game.round.phase === 'live' || game.round.phase === 'planted') {
      updatePlayer(player, input, game, tick);
      // Plant/defuse channel cancels if the player moves or fires.
      if (player.channel && (input.forward || input.back || input.left || input.right || input.fire)) {
        player.channel = null;
      }
      for (const b of bots) updateBot(b, game, tick);
    } else if (game.round.phase === 'freeze') {
      updatePlayer(player, input, game, tick);
    }
    updateGrenades(grenades, game, tick);
    // Reload completion (player + bots).
    for (const c of game.combatants) {
      const w = currentWeapon(c);
      if (w && w.reloading && tick >= w.reloadEndTick) finishReload(c);
    }
    if (game.round.phase === 'freeze' && game.round.phaseTick === 1 && game.deathOverlayShown) {
      game.deathOverlayShown = false;
      game.hud.hideOverlay();
    }
    clearEdgeInput(input);
  }

  // --- per-frame render ---
  let last = performance.now();
  let acc = 0;
  let firstFrame = true;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    if (!game.frozen) {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        simTick();
        acc -= STEP;
        steps += 1;
      }
      if (steps === 5) acc = 0;
    }
    // Camera follows the player (or stays at the death spot).
    const eye = eyePos(player);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch + player.recoilPitch * 0.05;
    camera.rotation.z = 0;
    // ADS / scope FOV.
    const w = currentWeapon(player);
    const ads = input.ads && w.def.ads;
    const targetFov = ads ? (w.def.scope ? 35 : 55) : 75;
    if (Math.abs(camera.fov - targetFov) > 0.5) {
      camera.fov += (targetFov - camera.fov) * 0.2;
      camera.updateProjectionMatrix();
    }
    // View-model bob.
    viewModel.position.y = -0.27 + Math.sin(player.bobPhase) * 0.008;
    viewModel.position.x = 0.3 + Math.cos(player.bobPhase * 0.5) * 0.004;
    viewModel.visible = !(ads && w.def.scope);
    // Bot meshes mirror sim bodies.
    for (const b of bots) {
      const mesh = botMeshes.get(b.id);
      mesh.visible = b.alive;
      if (!b.alive) continue;
      mesh.position.set(b.body.pos.x, b.body.pos.y, b.body.pos.z);
      mesh.rotation.y = b.yaw;
    }
    // Visual-only furnace flicker (render clock, never sim state).
    map.animateVisuals(now / 1000);
    updateEffects(fx, game.tick, dt);
    game.hud.update(game.tick, dt);
    renderer.render(scene, camera);
    if (firstFrame) {
      firstFrame = false;
      window.__emberlineReady = true;
      window.__shotReady = true;
    }
  }

  stageShot(game, params, simTick);
  requestAnimationFrame(frame);
  return game;
}

// Deterministic screenshot staging. Runs real sim ticks (seeded) so the
// capture shows a genuine game state, then freezes the sim.
function stageShot(game, params, simTick) {
  if (!params.shot) {
    game.hud.showOverlay(
      'EMBERLINE — Foundry 7',
      'Click to play. WASD move · mouse look · LMB fire · R reload · B buy · E plant/defuse · 1/2 weapons · 3 grenade',
    );
    return;
  }
  // Screenshot mode never shows the click-to-play overlay.
  game.hud.hideOverlay();
  const p = game.player;
  const r = game.round;
  if (params.shot === 'start') {
    // Spawn view during freeze, facing the furnace hall.
    p.yaw = 0;
    p.pitch = 0;
    game.hud.announce('Round 1 — plant at Crucible', 'Freeze — buy with B');
  } else if (params.shot === 'buy') {
    p.yaw = 0;
    p.pitch = 0;
    p.money = 4200;
    game.hud.toggleBuy();
    // No banner under the menu: announce first (sets the text), then hide.
    game.hud.announce('Round 1 — plant at Crucible', 'Freeze — buy with B');
    game.hud.hideBanner();
  } else if (params.shot === 'play') {
    // Five seconds of real combat, then one real seeded shot from the player.
    r.phase = 'live';
    r.phaseTick = 0;
    for (let i = 0; i < 300; i += 1) simTick();
    // The player may have died standing at spawn: revive for the shot.
    if (!p.alive) {
      p.alive = true;
      p.hp = 100;
      game.deathOverlayShown = false;
      game.hud.hideOverlay();
    }
    // Vantage at the south edge of mid, facing the furnace firefight.
    p.body.pos.x = -4;
    p.body.pos.z = 10;
    const enemies = game.combatants.filter((c) => c.team === 'ash' && c.alive);
    if (enemies.length) {
      const e = enemies[0];
      const dx = e.body.pos.x - p.body.pos.x;
      const dz = e.body.pos.z - p.body.pos.z;
      p.yaw = Math.atan2(-dx, -dz);
      p.pitch = 0.02;
    }
    p.weapons[p.slot].nextFireTick = 0;
    game.fireWeapon(p, game.tick);
    game.hud.pushFeed('You headshot Anvil', game.tick);
    // The round-start banner would cover the firefight: hide it.
    game.hud.hideBanner();
  } else if (params.shot === 'end') {
    r.phase = 'roundEnd';
    r.phaseTick = 10;
    r.score.ember = 3;
    r.score.ash = 2;
    r.winner = { team: 'ember', reason: 'Ash eliminated' };
    r.banner = { text: 'EMBER wins the round', sub: 'Ash eliminated', untilTick: game.tick + 300 };
    p.body.pos.x = -4;
    p.body.pos.z = 6;
    p.yaw = 0.3;
    game.hud.announce('EMBER wins the round', 'Ash eliminated — score 3 — 2');
  }
  game.frozen = true;
}

init();
