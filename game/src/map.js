// map.js — EMBERLINE Foundry 7
//
// Module contract: builds the whole foundry once (geometry, lights, cover)
// and owns the two queries the sim needs — AABB colliders for movement and
// hits, and a 2D line-of-sight test for bot vision and shooting. Nothing in
// here is random: the layout is fixed, so the waypoint graph is identical
// every run and the sim never sees a different map.
//
// Design rationale: a 52x44 m three-lane foundry. West "Slag Lane" is a
// crate maze with a catwalk gantry overhead; Mid "Furnace Hall" is open
// around a molten crucible with long sightlines; East "Mold Tunnel" is a
// tight corridor of pillars and mould racks. Two bomb sites sit north — A
// "Crucible" west, B "Casting Bay" east — so attackers must commit to a
// lane and defenders must split. Lane dividers are partial walls with two
// gaps each, so rotations are possible but never free.
//
// Tuning notes: cover is 1–2 m tall (crouch-able or full block) and every
// crate is also a collider, so the minimap and the physics agree. The
// waypoint graph is generated from a fixed grid filtered against colliders
// (0.6 m margin) and linked only where a straight walk is clear — bots
// therefore never path through a furnace. The furnace light flicker is
// visual only (render clock), never sim state.

import * as THREE from 'three';
import { PALETTE, buildMaterials } from './palette.js';

export const MAP = {
  halfW: 26, // x in [-26, 26]
  halfD: 22, // z in [-22, 22]
  wallH: 6,
};

// --- geometry helpers (kept local: this module owns the foundry's shapes) ---
function box(scene, mat, x, y, z, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  m.receiveShadow = false;
  scene.add(m);
  return m;
}

function cylinder(scene, mat, x, y, z, rTop, rBottom, h, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat);
  m.position.set(x, y, z);
  scene.add(m);
  return m;
}

// 2D segment vs AABB test (XZ plane). Used for LOS and waypoint linking.
export function segHitsBox(ax, az, bx, bz, b) {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  // Slab test on x then z.
  for (const [p, d, lo, hi] of [
    [ax, dx, b.x0, b.x1],
    [az, dz, b.z0, b.z1],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
    } else {
      let ta = (lo - p) / d;
      let tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function pointInBox(x, z, b, margin = 0) {
  return x > b.x0 - margin && x < b.x1 + margin && z > b.z0 - margin && z < b.z1 + margin;
}

export function buildMap(scene) {
  const mats = buildMaterials();
  const colliders = [];
  const addCollider = (x0, z0, x1, z1, y0 = 0, y1 = 6) => {
    colliders.push({ x0, z0, x1, z1, y0, y1 });
  };

  scene.background = new THREE.Color(PALETTE.background);
  scene.fog = new THREE.Fog(PALETTE.fog, 18, 70);

  // --- lights: cold ambient + warm furnace glow (the foundry's two moods) ---
  scene.add(new THREE.HemisphereLight(0x8fa3b8, 0x1a120c, 0.9));
  const sun = new THREE.DirectionalLight(0xbfd9ff, 1.1);
  sun.position.set(18, 30, 12);
  scene.add(sun);
  const furnaceLight = new THREE.PointLight(0xff6a1a, 90, 26, 1.8);
  furnaceLight.position.set(0, 4.5, -6);
  scene.add(furnaceLight);
  const siteALight = new THREE.PointLight(0xff6a1a, 22, 12, 1.8);
  siteALight.position.set(-19, 3, -12);
  scene.add(siteALight);
  const siteBLight = new THREE.PointLight(0x2ec4b6, 22, 12, 1.8);
  siteBLight.position.set(19, 3, -12);
  scene.add(siteBLight);

  // --- floor: dark steel plates with a darker mid strip ---
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(52, 44), mats.floor);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const midStrip = new THREE.Mesh(new THREE.PlaneGeometry(18, 44), mats.floorDark);
  midStrip.rotation.x = -Math.PI / 2;
  midStrip.position.y = 0.01;
  scene.add(midStrip);

  // --- outer walls (all colliders) ---
  const W = MAP.halfW;
  const D = MAP.halfD;
  const H = MAP.wallH;
  box(scene, mats.wall, 0, H / 2, -D - 0.5, 54, H, 1);
  addCollider(-27, -23.5, 27, -22);
  box(scene, mats.wall, 0, H / 2, D + 0.5, 54, H, 1);
  addCollider(-27, 22, 27, 23.5);
  box(scene, mats.wall, -W - 0.5, H / 2, 0, 1, H, 46);
  addCollider(-27, -23, -26, 23);
  box(scene, mats.wall, W + 0.5, H / 2, 0, 1, H, 46);
  addCollider(26, -23, 27, 23);

  // --- lane dividers (partial walls, two gaps each so rotations cost time) ---
  // West divider x = -9 (wall thickness 1, spans z -22..22 with gaps).
  const divider = (x, gaps) => {
    let z = -D;
    for (const [g0, g1] of [...gaps, [D, D]]) {
      if (g0 > z) {
        const len = g0 - z;
        box(scene, mats.wallDark, x, H / 2, z + len / 2, 1, H, len);
        addCollider(x - 0.5, z, x + 0.5, g0);
      }
      z = g1;
    }
  };
  divider(-9, [[-14, -8], [2, 8]]);
  divider(9, [[-16, -10], [0, 6]]);

  // --- the furnace: crucible at mid-north, the map's hot heart ---
  cylinder(scene, mats.steelDark, 0, 2, -6, 3.4, 3.8, 4);
  addCollider(-3.4, -9.4, 3.4, -2.6, 0, 4);
  cylinder(scene, mats.molten, 0, 4.05, -6, 3.0, 3.0, 0.3);
  cylinder(scene, mats.moltenCore, 0, 4.2, -6, 1.6, 1.6, 0.2);
  // Furnace chimney stack rising through the roof gap.
  cylinder(scene, mats.pipe, 0, 8, -6, 1.2, 1.6, 5, 12);
  // Ember strip ringing the crucible base.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.1, 0.09, 8, 48), mats.emberStrip);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.12, -6);
  scene.add(ring);

  // --- pillars: furnace hall colonnade + mold tunnel supports ---
  const pillar = (x, z) => {
    box(scene, mats.steel, x, 2.5, z, 1.2, 5, 1.2);
    addCollider(x - 0.6, z - 0.6, x + 0.6, z + 0.6, 0, 5);
  };
  pillar(-5.5, -13);
  pillar(5.5, -13);
  pillar(-5.5, 1);
  pillar(5.5, 1);
  pillar(13, -17);
  pillar(13, -5);
  pillar(13, 7);
  pillar(21, -17);
  pillar(21, 7);
  pillar(-13, -17);
  pillar(-13, -5);
  pillar(-13, 7);
  pillar(-21, 1);

  // --- crates: the cover game. 1 m cubes and 2 m long blocks. ---
  const crate = (x, z, w = 1, d = 1, h = 1) => {
    box(scene, mats.crate, x, h / 2, z, w, h, d);
    addCollider(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 0, h);
  };
  const crateTall = (x, z) => {
    box(scene, mats.crateDark, x, 1, z, 1, 2, 1);
    addCollider(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0, 2);
  };
  // West lane (Slag Lane) crate maze.
  crate(-19, -4, 2, 1, 1);
  crate(-16, -2, 1, 1, 1);
  crateTall(-22, -8);
  crate(-15, -15, 1, 2, 1);
  crate(-21, -18, 2, 1, 1);
  crateTall(-17, 6);
  crate(-23, 10, 1, 2, 1);
  crate(-14, 12, 2, 1, 1);
  crate(-19, 15, 1, 1, 1);
  // Mid (Furnace Hall) low cover, sightlines stay long.
  crate(-4, -14, 2, 1, 1);
  crate(4, -14, 2, 1, 1);
  crateTall(-3, 6);
  crateTall(3, 6);
  crate(0, 12, 2, 1, 1);
  crate(-6, 14, 1, 1, 1);
  crate(6, 14, 1, 1, 1);
  // East lane (Mold Tunnel) tight blocks.
  crate(16, -4, 1, 2, 1);
  crate(19, -2, 2, 1, 1);
  crateTall(23, -8);
  crate(15, -15, 1, 1, 1);
  crate(21, -18, 1, 2, 1);
  crateTall(17, 6);
  crate(23, 10, 2, 1, 1);
  crate(14, 12, 1, 2, 1);
  crate(19, 15, 1, 1, 1);

  // --- overhead pipes + catwalk gantry (visual; pillars already collide) ---
  const pipeRun = (x, z0, z1) => {
    const len = z1 - z0;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, len, 10), mats.pipe);
    p.rotation.x = Math.PI / 2;
    p.position.set(x, 5.2, (z0 + z1) / 2);
    scene.add(p);
  };
  pipeRun(-24, -20, 20);
  pipeRun(24, -20, 20);
  pipeRun(-12, -20, 20);
  // Catwalk deck over the west lane (visual only, y = 4.2, no walking on it).
  box(scene, mats.catwalk, -21, 4.2, 2, 3, 0.25, 26);

  // --- bomb sites: glowing floor rings + marker posts ---
  const siteRing = (x, z, mat) => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.12, 8, 48), mat);
    r.rotation.x = Math.PI / 2;
    r.position.set(x, 0.1, z);
    scene.add(r);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3.5, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.06, z);
    scene.add(disc);
  };
  siteRing(-19, -12, mats.siteA);
  siteRing(19, -12, mats.siteB);
  // Site marker posts.
  box(scene, mats.siteA, -19, 1.1, -15.8, 0.3, 2.2, 0.3);
  box(scene, mats.siteB, 19, 1.1, -15.8, 0.3, 2.2, 0.3);

  // --- waypoint graph: fixed grid, filtered against colliders, linked by clear walks ---
  const gridX = [-21, -15, -12, -6, -4, 0, 4, 6, 12, 15, 21];
  const gridZ = [-17, -12, -7, -2, 3, 8, 13, 17];
  const nodes = [];
  for (const gx of gridX) {
    for (const gz of gridZ) {
      if (colliders.some((b) => pointInBox(gx, gz, b, 0.7))) continue;
      nodes.push({ x: gx, z: gz, links: [] });
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 7.6) continue;
      // Straight-line walk must clear every collider (with a 0.5 m margin).
      const fat = colliders.map((c) => ({
        x0: c.x0 - 0.5, z0: c.z0 - 0.5, x1: c.x1 + 0.5, z1: c.z1 + 0.5,
      }));
      if (fat.some((c) => segHitsBox(a.x, a.z, b.x, b.z, c))) continue;
      a.links.push(j);
      b.links.push(i);
    }
  }

  const sites = {
    A: { name: 'Crucible', x: -19, z: -12, r: 3.5 },
    B: { name: 'Casting Bay', x: 19, z: -12, r: 3.5 },
  };
  const spawns = {
    attack: [
      { x: -12, z: 18, yaw: 0 },
      { x: -6, z: 19, yaw: 0 },
      { x: 0, z: 18, yaw: 0 },
      { x: 6, z: 19, yaw: 0 },
      { x: 12, z: 18, yaw: 0 },
    ],
    defend: [
      { x: -19, z: -17, yaw: Math.PI },
      { x: -8, z: -18, yaw: Math.PI },
      { x: 0, z: -17, yaw: Math.PI },
      { x: 8, z: -18, yaw: Math.PI },
      { x: 19, z: -17, yaw: Math.PI },
    ],
  };

  // Line of sight between two eye points: blocked only by a collider whose
  // top is above BOTH eyes and whose 2D footprint the segment crosses.
  // Smoke clouds add temporary blockers (circles) checked by the caller.
  function losBlocked(ax, ay, az, bx, by, bz, extraCircles = null) {
    const top = Math.min(ay, by);
    for (const c of colliders) {
      if (c.y1 <= top) continue;
      if (segHitsBox(ax, az, bx, bz, c)) return true;
    }
    if (extraCircles) {
      for (const s of extraCircles) {
        if (segHitsCircle(ax, az, bx, bz, s.x, s.z, s.r)) return true;
      }
    }
    return false;
  }

  return {
    colliders,
    waypoints: nodes,
    sites,
    spawns,
    losBlocked,
    // Visual-only furnace flicker; driven by render time, never sim state.
    animateVisuals(t) {
      furnaceLight.intensity = 90 + Math.sin(t * 7.3) * 8 + Math.sin(t * 13.7) * 5;
    },
  };
}

function segHitsCircle(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return Math.hypot(ax - cx, az - cz) < r;
  let t = ((cx - ax) * dx + (cz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const pz = az + t * dz;
  return Math.hypot(px - cx, pz - cz) < r;
}

// Breadth-first shortest path over the waypoint graph. Returns node indices.
export function findPath(nodes, fromIdx, toIdx) {
  if (fromIdx === toIdx) return [fromIdx];
  const prev = new Array(nodes.length).fill(-1);
  const queue = [fromIdx];
  prev[fromIdx] = fromIdx;
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of nodes[cur].links) {
      if (prev[nb] !== -1) continue;
      prev[nb] = cur;
      if (nb === toIdx) {
        const path = [nb];
        let at = cur;
        while (at !== fromIdx) {
          path.unshift(at);
          at = prev[at];
        }
        path.unshift(fromIdx);
        return path;
      }
      queue.push(nb);
    }
  }
  return [fromIdx];
}

export function nearestNode(nodes, x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const d = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
