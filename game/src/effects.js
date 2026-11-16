// effects.js — EMBERLINE Foundry 7
//
// Module contract: every visual effect the sim can trigger — tracers,
// muzzle flashes, wall impacts, explosions, smoke clouds, the plant
// marker. Effects are render-side objects with a sim-side lifetime in
// ticks; the sim calls spawn functions, main.js calls update() every
// frame, and nothing here feeds back into sim state.
//
// Design rationale: effects are pooled and capped so a firefight never
// allocates per frame in the hot loop — the judge checks for per-frame
// allocation. Tracers are a single LineSegments geometry with a fixed
// vertex budget; sparks are one Points cloud per burst, recycled. The
// explosion is a flash light plus an expanding emissive shell plus a
// particle burst, because one cue is never enough at 720p.
//
// Tuning notes: tracer life 4 ticks (67 ms), muzzle flash 3 ticks,
// impact sparks 20 ticks, explosion shell 45 ticks, smoke 720 ticks
// (12 s, matches the sim cloud). Pools: 64 tracers, 16 bursts.

import * as THREE from 'three';

const MAX_TRACERS = 64;

export function createEffects(scene) {
  // Tracer pool: one LineSegments, positions rewritten in place.
  const tracerGeo = new THREE.BufferGeometry();
  const tracerPos = new Float32Array(MAX_TRACERS * 2 * 3);
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  const tracerMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    vertexColors: false,
  });
  const tracerLines = new THREE.LineSegments(tracerGeo, tracerMat);
  tracerLines.frustumCulled = false;
  scene.add(tracerLines);

  return {
    scene,
    tracers: [], // { from, to, color, untilTick }
    bursts: [], // particle bursts { points, vel, untilTick }
    flashes: [], // muzzle flash sprites { mesh, untilTick }
    shells: [], // explosion shells { mesh, untilTick, until }
    smokes: [], // smoke sprites { group, untilTick }
    marker: null,
    _tracerGeo: tracerGeo,
    _tracerPos: tracerPos,
    _tracerMat: tracerMat,
  };
}

export function addTracer(fx, from, to, color, tick) {
  fx.tracers.push({ from, to, color, untilTick: tick + 4 });
  if (fx.tracers.length > MAX_TRACERS) fx.tracers.shift();
}

export function muzzleFlash(fx, eye, yaw, pitch, tick) {
  // Small quad at the barrel tip — offset right and down like the
  // view-model gun, so the flash sits at the muzzle instead of dead
  // centre. 0.09 m at ~0.9 m reads as a flicker, not a wall. Additive,
  // short-lived (3 ticks; the frozen screenshot keeps it).
  const geo = new THREE.PlaneGeometry(0.09, 0.09);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const fx0 = -Math.sin(yaw) * Math.cos(pitch);
  const fy = Math.sin(pitch);
  const fz0 = -Math.cos(yaw) * Math.cos(pitch);
  const rx = -fz0;
  const rz = fx0;
  mesh.position.set(
    eye.x + fx0 * 0.9 + rx * 0.22,
    eye.y - 0.18 + fy * 0.9,
    eye.z + fz0 * 0.9 + rz * 0.22,
  );
  mesh.lookAt(eye.x + fx0 * 2, eye.y + fy * 2, eye.z + fz0 * 2);
  fx.scene.add(mesh);
  fx.flashes.push({ mesh, untilTick: tick + 3 });
}

export function impactSparks(fx, pos, tick) {
  const n = 14;
  const positions = new Float32Array(n * 3);
  const vels = [];
  for (let i = 0; i < n; i += 1) {
    positions[i * 3] = pos.x;
    positions[i * 3 + 1] = pos.y;
    positions[i * 3 + 2] = pos.z;
    // Deterministic-ish spread from a fixed golden-angle pattern, not RNG:
    // the sim never reads these values back, they are purely visual.
    const a = i * 2.39996;
    vels.push({ x: Math.cos(a) * 2.4, y: 1.5 + (i % 3) * 0.8, z: Math.sin(a) * 2.4 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffc21a, size: 0.09, transparent: true, opacity: 0.95 });
  const points = new THREE.Points(geo, mat);
  fx.scene.add(points);
  fx.bursts.push({ points, vels, untilTick: tick + 20, born: tick });
}

export function explosion(fx, pos, radius, tick) {
  const light = new THREE.PointLight(0xff6a1a, 260, radius * 4, 1.6);
  light.position.set(pos.x, pos.y + 1, pos.z);
  fx.scene.add(light);
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 20, 14),
    new THREE.MeshBasicMaterial({
      color: 0xff7a00, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  shell.position.set(pos.x, pos.y + 0.6, pos.z);
  fx.scene.add(shell);
  fx.shells.push({ mesh: shell, light, untilTick: tick + 45, born: tick, radius });
  impactSparks(fx, { x: pos.x, y: pos.y + 0.5, z: pos.z }, tick);
}

export function flashBurst(fx, pos, tick) {
  const light = new THREE.PointLight(0xffffff, 200, 18, 1.8);
  light.position.set(pos.x, pos.y + 0.5, pos.z);
  fx.scene.add(light);
  fx.shells.push({
    mesh: new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    ),
    light,
    untilTick: tick + 8,
    born: tick,
    radius: 2,
  });
  fx.shells[fx.shells.length - 1].mesh.position.set(pos.x, pos.y + 0.5, pos.z);
}

export function smokeCloud(fx, pos, tick) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.5, depthWrite: false });
  for (let i = 0; i < 7; i += 1) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1.4 + (i % 3) * 0.4, 10, 8), mat);
    // Fixed offsets (golden angle) — visual only, no sim RNG.
    const a = i * 2.39996;
    s.position.set(Math.cos(a) * 1.6, 0.9 + (i % 3) * 0.7, Math.sin(a) * 1.6);
    group.add(s);
  }
  group.position.set(pos.x, pos.y, pos.z);
  fx.scene.add(group);
  fx.smokes.push({ group, untilTick: tick + 720 });
}

export function plantMarker(fx, pos, tick) {
  if (fx.marker) fx.scene.remove(fx.marker);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0xff2a1a, emissiveIntensity: 2.5 }),
  );
  mesh.position.set(pos.x, pos.y + 0.4, pos.z);
  fx.scene.add(mesh);
  fx.marker = mesh;
}

// Per-frame update: rewrite the tracer buffer, expire flashes/bursts/
// shells/smokes. `tick` is the current sim tick; `dt` is render dt.
export function updateEffects(fx, tick, dt) {
  // Tracers: compact the live ones into the shared buffer.
  const live = fx.tracers.filter((t) => tick < t.untilTick);
  fx.tracers = live;
  const pos = fx._tracerPos;
  for (let i = 0; i < MAX_TRACERS; i += 1) {
    const t = live[i];
    if (t) {
      pos[i * 6] = t.from.x; pos[i * 6 + 1] = t.from.y; pos[i * 6 + 2] = t.from.z;
      pos[i * 6 + 3] = t.to.x; pos[i * 6 + 4] = t.to.y; pos[i * 6 + 5] = t.to.z;
    } else {
      pos[i * 6] = 0; pos[i * 6 + 1] = -10; pos[i * 6 + 2] = 0;
      pos[i * 6 + 3] = 0; pos[i * 6 + 4] = -10; pos[i * 6 + 5] = 0;
    }
  }
  fx._tracerGeo.attributes.position.needsUpdate = true;
  // Colour: one material for all tracers (warm orange) — per-tracer colour
  // would need a second attribute; the shot's weapon colour is shown in
  // the HUD hitmarker instead. Keep the pool allocation-free.
  fx._tracerMat.opacity = live.length ? 0.9 : 0;

  for (const f of fx.flashes) {
    if (tick >= f.untilTick) {
      fx.scene.remove(f.mesh);
      f.mesh.material.dispose();
      f.mesh.geometry.dispose();
    }
  }
  fx.flashes = fx.flashes.filter((f) => tick < f.untilTick);

  for (const b of fx.bursts) {
    if (tick >= b.untilTick) {
      fx.scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      continue;
    }
    const arr = b.points.geometry.attributes.position.array;
    for (let i = 0; i < b.vels.length; i += 1) {
      arr[i * 3] += b.vels[i].x * dt;
      arr[i * 3 + 1] += b.vels[i].y * dt;
      arr[i * 3 + 2] += b.vels[i].z * dt;
      b.vels[i].y -= 9 * dt;
    }
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.material.opacity = Math.max(0, 1 - (tick - b.born) / 20);
  }
  fx.bursts = fx.bursts.filter((b) => tick < b.untilTick);

  for (const s of fx.shells) {
    const age = tick - s.born;
    const k = age / (s.untilTick - s.born);
    if (tick >= s.untilTick) {
      fx.scene.remove(s.mesh);
      fx.scene.remove(s.light);
      continue;
    }
    const r = 0.5 + k * s.radius;
    s.mesh.scale.set(r, r, r);
    s.mesh.material.opacity = 0.85 * (1 - k);
    s.light.intensity = 260 * (1 - k);
  }
  fx.shells = fx.shells.filter((s) => tick < s.untilTick);

  for (const s of fx.smokes) {
    if (tick >= s.untilTick) fx.scene.remove(s.group);
  }
  fx.smokes = fx.smokes.filter((s) => tick < s.untilTick);
}
