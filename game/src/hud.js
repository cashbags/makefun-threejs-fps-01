// hud.js — EMBERLINE Foundry 7
//
// Module contract: every DOM element the player sees, updated from sim
// state each frame: health/armour, ammo, money, timer, score, kill feed,
// minimap, buy menu, crosshair spread, hitmarker, damage vignette, round
// banners, bomb status. It never writes sim state — it only reads it.
//
// Design rationale: the HUD is the game's contract with the player —
// everything the sim knows that matters must be visible. Top bar: timer
// and score (the round at a glance). Bottom left: health/armour. Bottom
// right: ammo and money. Top right: kill feed. Top left: minimap with
// walls, sites and dots. Centre: a dynamic crosshair whose gap IS the
// current spread, so accuracy is readable without numbers. The buy menu
// is a real shop (click or number keys) open only during freeze.
//
// Tuning notes: minimap is a 180x180 canvas redrawn each frame from the
// collider list — cheap, and it can never disagree with the map. The
// crosshair gap is set from the sim's spread value in pixels. Kill feed
// keeps the last 5 entries, 6 s each. Banners are the round state in
// words. All colours come from the palette's ember/teal split.

import { WEAPONS, GRENADE_DEFS, createWeaponInstance } from './weapons.js';
import { FREEZE_TICKS, ROUND_TICKS, BOMB_TICKS, ROUND_END_TICKS } from './rounds.js';

const BUY_ITEMS = [
  { id: 'vk9', kind: 'weapon', def: WEAPONS.vk9 },
  { id: 'ar7', kind: 'weapon', def: WEAPONS.ar7 },
  { id: 'lr50', kind: 'weapon', def: WEAPONS.lr50 },
  { id: 'frag', kind: 'grenade', def: GRENADE_DEFS.frag },
  { id: 'flash', kind: 'grenade', def: GRENADE_DEFS.flash },
  { id: 'smoke', kind: 'grenade', def: GRENADE_DEFS.smoke },
  { id: 'kevlar', kind: 'armour', def: { name: 'Kevlar Vest', price: 650 } },
  { id: 'kit', kind: 'kit', def: { name: 'Defuse Kit', price: 400 } },
];

export function createHud(game) {
  const $ = (id) => document.getElementById(id);
  const hud = {
    game,
    buyOpen: false,
    killFeed: [],
    banner: null,
    els: {
      health: $('hud-health'),
      armour: $('hud-armour'),
      ammo: $('hud-ammo'),
      money: $('hud-money'),
      timer: $('hud-timer'),
      score: $('hud-score'),
      round: $('hud-round'),
      feed: $('hud-feed'),
      minimap: $('hud-minimap'),
      crosshair: $('hud-crosshair'),
      hitmarker: $('hud-hitmarker'),
      vignette: $('hud-vignette'),
      flash: $('hud-flash'),
      banner: $('hud-banner'),
      bannerText: $('hud-banner-text'),
      bannerSub: $('hud-banner-sub'),
      bomb: $('hud-bomb'),
      buy: $('hud-buy'),
      buyList: $('hud-buy-list'),
      buyMoney: $('hud-buy-money'),
      prompt: $('hud-prompt'),
      overlay: $('hud-overlay'),
      overlayTitle: $('hud-overlay-title'),
      overlaySub: $('hud-overlay-sub'),
      channel: $('hud-channel'),
      channelFill: $('hud-channel-fill'),
      channelLabel: $('hud-channel-label'),
    },
    announce(text, sub = '') {
      this.banner = { text, sub, until: performance.now() + 3500 };
      this.els.bannerText.textContent = text;
      this.els.bannerSub.textContent = sub;
      this.els.banner.classList.remove('hidden');
    },
    hideBanner() {
      this.banner = null;
      this.els.banner.classList.add('hidden');
    },
    pushFeed(text, tick) {
      this.killFeed.push({ text, until: tick + 360 });
      if (this.killFeed.length > 5) this.killFeed.shift();
    },
    toggleBuy() {
      if (this.game.round.phase !== 'freeze') {
        this.announce('Buy menu is freeze-only', 'Wait for the next round');
        return;
      }
      this.buyOpen = !this.buyOpen;
      this.els.buy.classList.toggle('hidden', !this.buyOpen);
      if (this.buyOpen) this.renderBuy();
    },
    closeBuy() {
      this.buyOpen = false;
      this.els.buy.classList.add('hidden');
    },
    renderBuy() {
      const p = this.game.player;
      const list = this.els.buyList;
      list.innerHTML = '';
      this.els.buyMoney.textContent = `$${p.money}`;
      BUY_ITEMS.forEach((item, i) => {
        const owned = item.kind === 'weapon'
          ? p.weapons.some((w) => w.def.id === item.id)
          : item.kind === 'grenade'
            ? (p.grenades[item.id] ?? 0) > 0
            : item.kind === 'armour' ? p.armour > 0 : p.hasKit;
        const row = document.createElement('button');
        row.className = 'buy-row';
        row.innerHTML = `<span class="buy-key">${i + 1}</span><span class="buy-name">${item.def.name}</span><span class="buy-price">$${item.def.price}</span>${owned ? '<span class="buy-owned">OWNED</span>' : ''}`;
        row.addEventListener('click', () => this.buy(item));
        list.appendChild(row);
      });
    },
    buy(item) {
      const p = this.game.player;
      if (this.game.round.phase !== 'freeze') return;
      if (p.money < item.def.price) {
        this.announce('Not enough money', `${item.def.name} costs $${item.def.price}`);
        return;
      }
      if (item.kind === 'weapon') {
        const inst = createWeaponInstance(item.def);
        const existing = p.weapons.findIndex((w) => w.def.kind === 'primary');
        if (existing !== -1) p.weapons[existing] = inst;
        else p.weapons[0] = inst;
        p.slot = 0;
      } else if (item.kind === 'grenade') {
        p.grenades[item.id] = (p.grenades[item.id] ?? 0) + 1;
      } else if (item.kind === 'armour') {
        p.armour = 100;
      } else if (item.kind === 'kit') {
        p.hasKit = true;
      }
      p.money -= item.def.price;
      this.renderBuy();
    },
    // Per-frame refresh from sim state. `tick` is the sim tick.
    update(tick, dt) {
      const g = this.game;
      const p = g.player;
      const r = g.round;
      const e = this.els;
      e.health.textContent = p.hp;
      e.health.classList.toggle('low', p.hp <= 30);
      e.armour.textContent = p.armour > 0 ? `+${p.armour}` : '—';
      const w = p.weapons[p.slot];
      e.ammo.textContent = w ? `${w.mag} / ${w.reserve}` : '—';
      e.money.textContent = `$${p.money}`;
      const total = r.phase === 'freeze' ? FREEZE_TICKS - r.phaseTick
        : r.phase === 'live' ? ROUND_TICKS - r.phaseTick
        : r.phase === 'planted' ? BOMB_TICKS - r.phaseTick
        : ROUND_END_TICKS - r.phaseTick;
      const secs = Math.max(0, Math.ceil(total / 60));
      e.timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      e.timer.classList.toggle('urgent', secs <= 10 && (r.phase === 'live' || r.phase === 'planted'));
      e.score.textContent = `${r.score.ember} — ${r.score.ash}`;
      e.round.textContent = `ROUND ${r.roundNumber}/15`;
      // Kill feed expiry.
      this.killFeed = this.killFeed.filter((f) => tick < f.until);
      e.feed.innerHTML = this.killFeed.map((f) => `<div>${f.text}</div>`).join('');
      // Bomb status line.
      if (r.phase === 'planted') {
        e.bomb.textContent = `BOMB PLANTED — ${r.targetSite.name} — ${secs}s`;
        e.bomb.classList.remove('hidden');
      } else if (p.hasBomb) {
        e.bomb.textContent = `YOU HAVE THE BOMB — plant at ${r.targetSite.name} (hold E)`;
        e.bomb.classList.remove('hidden');
      } else if (r.phase === 'live' && r.carrier && !r.carrier.isPlayer) {
        e.bomb.textContent = `${r.carrier.name} carries the bomb → ${r.targetSite.name}`;
        e.bomb.classList.remove('hidden');
      } else {
        e.bomb.classList.add('hidden');
      }
      // Channel progress (plant/defuse).
      if (p.channel) {
        const k = p.channel.ticks / p.channel.need;
        e.channel.classList.remove('hidden');
        e.channelFill.style.width = `${Math.round(k * 100)}%`;
        e.channelLabel.textContent = p.channel.kind === 'plant' ? 'PLANTING…' : 'DEFUSING…';
      } else {
        e.channel.classList.add('hidden');
      }
      // Damage vignette fades with health; flash overlay with flash state.
      e.vignette.style.opacity = p.hp < 100 ? String(Math.min(0.7, (100 - p.hp) / 100 + 0.15)) : '0';
      const flashed = p.flashUntilTick > tick;
      e.flash.style.opacity = flashed ? String(p.flashStrength * 0.9) : '0';
      // Banner expiry.
      if (this.banner && performance.now() > this.banner.until) {
        this.banner = null;
        e.banner.classList.add('hidden');
      }
      // Buy prompt during freeze.
      e.prompt.textContent = r.phase === 'freeze'
        ? 'FREEZE — press B to buy'
        : p.hasBomb && r.phase === 'live' ? 'Hold E at the site to plant' : '';
      this.drawMinimap();
      this.drawCrosshair();
    },
    drawCrosshair() {
      const g = this.game;
      const p = g.player;
      const spread = g.spreadOf ? g.spreadOf(p) : 0.01;
      const gap = 6 + spread * 900;
      const el = this.els.crosshair;
      el.style.setProperty('--gap', `${gap.toFixed(1)}px`);
      el.classList.toggle('scoped', !!(g.input.ads && p.weapons[p.slot].def.scope));
    },
    drawMinimap() {
      const cv = this.els.minimap;
      if (!cv) return;
      const ctx = cv.getContext('2d');
      const W = cv.width;
      const H = cv.height;
      const sx = (x) => ((x + 26) / 52) * W;
      const sz = (z) => ((z + 22) / 44) * H;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(10,12,14,0.85)';
      ctx.fillRect(0, 0, W, H);
      // Walls / cover.
      ctx.fillStyle = '#4a5158';
      for (const c of this.game.map.colliders) {
        ctx.fillRect(sx(c.x0), sz(c.z0), sx(c.x1) - sx(c.x0), sz(c.z1) - sz(c.z0));
      }
      // Sites.
      const site = (s, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(s.x), sz(s.z), 8, 0, Math.PI * 2);
        ctx.stroke();
      };
      site(this.game.map.sites.A, '#ff6a1a');
      site(this.game.map.sites.B, '#2ec4b6');
      // Bomb.
      if (this.game.round.bombPos) {
        ctx.fillStyle = '#ff2a1a';
        ctx.beginPath();
        ctx.arc(sx(this.game.round.bombPos.x), sz(this.game.round.bombPos.z), 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Combatants.
      for (const c of this.game.combatants) {
        if (!c.alive) continue;
        ctx.fillStyle = c.isPlayer ? '#ffffff' : c.team === 'ember' ? '#ff6a1a' : '#8fa3b8';
        ctx.beginPath();
        ctx.arc(sx(c.body.pos.x), sz(c.body.pos.z), c.isPlayer ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Player facing arrow.
      const p = this.game.player;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx(p.body.pos.x), sz(p.body.pos.z));
      ctx.lineTo(
        sx(p.body.pos.x) - Math.sin(p.yaw) * 9,
        sz(p.body.pos.z) - Math.cos(p.yaw) * 9,
      );
      ctx.stroke();
    },
    showHitmarker(kill) {
      const el = this.els.hitmarker;
      el.classList.remove('hidden');
      el.classList.toggle('kill', !!kill);
      setTimeout(() => el.classList.add('hidden'), 120);
    },
    showOverlay(title, sub) {
      this.els.overlayTitle.textContent = title;
      this.els.overlaySub.textContent = sub;
      this.els.overlay.classList.remove('hidden');
    },
    hideOverlay() {
      this.els.overlay.classList.add('hidden');
    },
  };
  return hud;
}
