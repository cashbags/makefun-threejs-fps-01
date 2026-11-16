// mover.js — EMBERLINE Foundry 7
//
// Module contract: the only place that moves a body through the foundry.
// A body is { pos (feet, THREE.Vector3-like {x,y,z}), vel, radius, height,
// onGround }. move() applies acceleration, friction, gravity and jump, then
// resolves AABB collision axis by axis, so a body can slide along a wall
// instead of sticking to it.
//
// Design rationale: Counter-Strike-style movement — snappy acceleration,
// strong ground friction, no air control beyond a small nudge — makes
// positioning and peeking a skill instead of a slide. Collision is
// axis-separated (x, then z, then y) with a 0.4 m body radius; that is the
// whole physics model, and it is shared by the player and every bot, so
// bots and the player obey the same map.
//
// Tuning notes: walk 5.2 m/s, crouch 2.6, ADS 3.0, sprint is not a thing
// (tactical FPS). Ground accel 60, air accel 12, friction 14/s. Gravity 22,
// jump 7.6 (clears 1 m crates, not 2 m blocks). Step 1/60 s. Eye heights:
// standing 1.62, crouched 1.05.

export const STEP = 1 / 60;

export function createBody(x, z, radius = 0.4, height = 1.7) {
  return {
    pos: { x, y: 0, z },
    vel: { x: 0, y: 0, z: 0 },
    radius,
    height,
    crouched: false,
    onGround: true,
  };
}

// Move a body for one fixed step. `wish` is the desired horizontal velocity
// {x, z} (already speed-capped by the caller); `jump` requests a jump.
export function moveBody(body, colliders, wish, jump, dt = STEP) {
  const accel = body.onGround ? 60 : 12;
  const fric = body.onGround ? 14 : 0.4;
  // Accelerate toward the wish velocity, then apply friction when idle.
  const dvx = wish.x - body.vel.x;
  const dvz = wish.z - body.vel.z;
  const dvLen = Math.hypot(dvx, dvz);
  if (dvLen > 1e-6) {
    const step = Math.min(accel * dt, dvLen);
    body.vel.x += (dvx / dvLen) * step;
    body.vel.z += (dvz / dvLen) * step;
  } else if (body.onGround) {
    const f = Math.max(0, 1 - fric * dt);
    body.vel.x *= f;
    body.vel.z *= f;
  }
  if (jump && body.onGround) {
    body.vel.y = 7.6;
    body.onGround = false;
  }
  body.vel.y -= 22 * dt;

  // Axis-separated collision: x, then z, then y (ground).
  moveAxis(body, colliders, 'x', body.vel.x * dt);
  moveAxis(body, colliders, 'z', body.vel.z * dt);
  body.pos.y += body.vel.y * dt;
  if (body.pos.y <= 0) {
    body.pos.y = 0;
    body.vel.y = 0;
    body.onGround = true;
  } else {
    body.onGround = false;
  }
  // Clamp inside the arena even if a wall is somehow missed.
  body.pos.x = Math.max(-25.5, Math.min(25.5, body.pos.x));
  body.pos.z = Math.max(-21.5, Math.min(21.5, body.pos.z));
}

function moveAxis(body, colliders, axis, delta) {
  if (delta === 0) return;
  body.pos[axis] += delta;
  const r = body.radius;
  const top = body.pos.y + body.height;
  for (const c of colliders) {
    if (top <= c.y0 || body.pos.y >= c.y1) continue;
    const ox0 = body.pos.x - r;
    const ox1 = body.pos.x + r;
    const oz0 = body.pos.z - r;
    const oz1 = body.pos.z + r;
    if (ox1 <= c.x0 || ox0 >= c.x1 || oz1 <= c.z0 || oz0 >= c.z1) continue;
    if (axis === 'x') {
      body.pos.x = delta > 0 ? c.x0 - r : c.x1 + r;
      body.vel.x = 0;
    } else {
      body.pos.z = delta > 0 ? c.z0 - r : c.z1 + r;
      body.vel.z = 0;
    }
  }
}

// Eye height for a body (used by shooting, vision and the camera).
export function eyeHeight(body) {
  return body.crouched ? 1.05 : 1.62;
}
