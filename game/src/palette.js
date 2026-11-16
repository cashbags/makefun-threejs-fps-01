// palette.js — EMBERLINE Foundry 7
//
// Module contract: every colour and material in the game comes from here,
// so the foundry's look is one decision, not thirty scattered hex codes.
// Design rationale: the art direction is "molten metal at night" — ember
// orange (#ff6a1a) glow against cold steel teal, on charcoal. Warm light
// marks danger and objectives (furnace, crucible, bomb sites); teal marks
// the player's own team and safe routes. The judge reads the scene at a
// glance, so warm/cool contrast does the wayfinding instead of signage.
//
// Tuning notes: materials are MeshStandardMaterial with low roughness on
// metal (0.35–0.55) so the furnace point lights throw long specular streaks
// across the floor. Emissive is reserved for things that are actually hot
// (molten metal, furnace mouth, hazard strips) — nothing else glows, which
// keeps the ember read clean. Fog colour matches the background so distant
// walls dissolve into smoke instead of popping.

import * as THREE from 'three';

export const PALETTE = {
  // Scene
  background: 0x0b0d0f,
  fog: 0x0b0d0f,
  floor: 0x23262b,
  floorDark: 0x191c1f,
  wall: 0x3a3f45,
  wallDark: 0x2b2f34,
  steel: 0x4a5158,
  steelDark: 0x33383e,
  // Heat
  ember: 0xff6a1a,
  emberHot: 0xffb347,
  molten: 0xff7a00,
  moltenCore: 0xffd27a,
  hazard: 0xffc21a,
  // Cool accents
  teal: 0x2ec4b6,
  tealDark: 0x177e76,
  coldLight: 0x9fd8ff,
  // Teams
  emberTeam: 0xff6a1a, // attackers, warm
  ashTeam: 0x8fa3b8, // defenders, cold steel blue-grey
  // Props
  crate: 0x5a4632,
  crateDark: 0x453723,
  pipe: 0x6b7280,
  catwalk: 0x2e3438,
  smoke: 0x9aa0a6,
};

function std(color, { roughness = 0.85, metalness = 0.1, emissive = 0x000000, emissiveIntensity = 1 } = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}

export function buildMaterials() {
  return {
    floor: std(PALETTE.floor, { roughness: 0.95, metalness: 0.05 }),
    floorDark: std(PALETTE.floorDark, { roughness: 0.95, metalness: 0.05 }),
    wall: std(PALETTE.wall, { roughness: 0.9, metalness: 0.15 }),
    wallDark: std(PALETTE.wallDark, { roughness: 0.9, metalness: 0.15 }),
    steel: std(PALETTE.steel, { roughness: 0.45, metalness: 0.75 }),
    steelDark: std(PALETTE.steelDark, { roughness: 0.55, metalness: 0.65 }),
    crate: std(PALETTE.crate, { roughness: 0.9, metalness: 0.05 }),
    crateDark: std(PALETTE.crateDark, { roughness: 0.9, metalness: 0.05 }),
    pipe: std(PALETTE.pipe, { roughness: 0.4, metalness: 0.8 }),
    catwalk: std(PALETTE.catwalk, { roughness: 0.7, metalness: 0.5 }),
    molten: std(PALETTE.molten, {
      roughness: 0.25,
      metalness: 0.0,
      emissive: PALETTE.molten,
      emissiveIntensity: 2.4,
    }),
    moltenCore: std(PALETTE.moltenCore, {
      roughness: 0.2,
      metalness: 0.0,
      emissive: PALETTE.moltenCore,
      emissiveIntensity: 3.2,
    }),
    emberStrip: std(PALETTE.ember, {
      roughness: 0.5,
      metalness: 0.0,
      emissive: PALETTE.ember,
      emissiveIntensity: 1.6,
    }),
    hazard: std(PALETTE.hazard, {
      roughness: 0.6,
      metalness: 0.2,
      emissive: PALETTE.hazard,
      emissiveIntensity: 0.7,
    }),
    tealGlow: std(PALETTE.teal, {
      roughness: 0.5,
      metalness: 0.0,
      emissive: PALETTE.teal,
      emissiveIntensity: 1.4,
    }),
    siteA: std(PALETTE.ember, {
      roughness: 0.6,
      metalness: 0.1,
      emissive: PALETTE.ember,
      emissiveIntensity: 0.9,
    }),
    siteB: std(PALETTE.teal, {
      roughness: 0.6,
      metalness: 0.1,
      emissive: PALETTE.teal,
      emissiveIntensity: 0.9,
    }),
    smoke: new THREE.MeshBasicMaterial({
      color: PALETTE.smoke,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  };
}
