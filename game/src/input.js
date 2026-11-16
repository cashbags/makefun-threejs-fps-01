// input.js — EMBERLINE Foundry 7
//
// Module contract: translates raw DOM keyboard/mouse events into one
// per-frame input snapshot the sim reads: { forward, back, left, right,
// crouch, jump, ads, fire, lookDX, lookDY, reloadPressed, slotPressed,
// grenadePressed, cyclePressed, buyPressed, useHeld }. Edge-triggered
// fields (reloadPressed, slotPressed, ...) are consumed by the sim tick
// and cleared each frame, so a single keypress is exactly one action.
//
// Design rationale: pointer lock is the only way mouse-look feels right,
// but the game must still render (and screenshot) without it — headless
// captures never lock. So look deltas accumulate only while locked, and
// everything else works from keys alone. The start overlay asks for a
// click to lock; Escape unlocks (browser behaviour) and pauses the sim's
// shooting, not the render.
//
// Key map (also shown on the start overlay): WASD move, Space jump, Ctrl
// crouch, Shift is not sprint (tactical), mouse look, LMB fire, RMB aim,
// R reload, 1 primary / 2 sidearm / 3 grenade, Q cycle grenade, E use
// (plant/defuse), B buy menu, M mute.

export function createInput() {
  return {
    forward: false,
    back: false,
    left: false,
    right: false,
    crouch: false,
    jump: false,
    ads: false,
    fire: false,
    lookDX: 0,
    lookDY: 0,
    reloadPressed: false,
    slotPressed: -1,
    grenadePressed: false,
    cyclePressed: false,
    buyPressed: false,
    useHeld: false,
    locked: false,
  };
}

export function attachInput(input, canvas, onLockChange) {
  const keymap = {
    KeyW: 'forward',
    ArrowUp: 'forward',
    KeyS: 'back',
    ArrowDown: 'back',
    KeyA: 'left',
    ArrowLeft: 'left',
    KeyD: 'right',
    ArrowRight: 'right',
    ControlLeft: 'crouch',
    ControlRight: 'crouch',
    Space: 'jump',
    KeyE: 'useHeld',
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    const field = keymap[e.code];
    if (field) input[field] = true;
    if (e.repeat) return;
    if (e.code === 'KeyR') input.reloadPressed = true;
    if (e.code === 'Digit1') input.slotPressed = 0;
    if (e.code === 'Digit2') input.slotPressed = 1;
    if (e.code === 'Digit3') input.grenadePressed = true;
    if (e.code === 'KeyQ') input.cyclePressed = true;
    if (e.code === 'KeyB') input.buyPressed = true;
  });
  window.addEventListener('keyup', (e) => {
    const field = keymap[e.code];
    if (field) input[field] = false;
  });
  window.addEventListener('blur', () => {
    for (const k of ['forward', 'back', 'left', 'right', 'crouch', 'jump', 'fire', 'ads', 'useHeld']) {
      input[k] = false;
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!input.locked) {
      canvas.requestPointerLock?.();
      return;
    }
    if (e.button === 0) input.fire = true;
    if (e.button === 2) input.ads = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.fire = false;
    if (e.button === 2) input.ads = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.lookDX += e.movementX || 0;
    input.lookDY += e.movementY || 0;
  });
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    onLockChange?.(input.locked);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Called by the sim after each tick: clear edge-triggered fields so a
// keypress fires exactly once.
export function clearEdgeInput(input) {
  input.lookDX = 0;
  input.lookDY = 0;
  input.reloadPressed = false;
  input.slotPressed = -1;
  input.grenadePressed = false;
  input.cyclePressed = false;
  input.buyPressed = false;
  input.jump = false;
}
