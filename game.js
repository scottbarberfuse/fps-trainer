/* FPS TRAINER — a static-position aim trainer.
 *
 * Core logic borrowed & adapted from scottbarberfuse/intox (src/lib/reflex.js):
 * the target palette, the shrinking-lifetime ramp, and the median/accuracy
 * scoring helpers all come from that "tap the dot" reflex checkpoint. Here they
 * drive an FPS-style trainer instead — dots move, hide behind cover, and take
 * three clicks to pop, across five score-gated waves.
 */

'use strict';

// ===== Borrowed from intox/src/lib/reflex.js =================================
// Good targets cycle a multi-colour palette; the arena is never one hue.
const TARGET_COLORS = ['#4d9de0', '#3fb950', '#e3b341', '#a371f7', '#39c5cf'];

// Shrinking-lifetime ramp: later dots in a wave stay up a little less time,
// bottoming out at a hittable floor. (intox: LIFETIME_START/FLOOR/STEP_MS.)
function lifetimeFor(baseMs, index) {
  const STEP = 60, FLOOR = 1100;
  return Math.max(FLOOR, baseMs - index * STEP);
}

// Median of a non-empty array; NaN if empty. (intox: median())
function median(arr) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
// ===========================================================================

// ---- tuning ---------------------------------------------------------------
const DOTS_PER_WAVE = 8;
const HITS_PER_DOT = 3;
const SHRINK = 0.62;           // radius multiplier per hit
const TOTAL_WAVES = 5;

// Per-wave difficulty. speed/radius are fractions of the smaller screen edge.
const WAVES = [
  { speedFrac: 0.055, radiusFrac: 0.050, lifetimeMs: 4200, concurrent: 2 },
  { speedFrac: 0.075, radiusFrac: 0.045, lifetimeMs: 3800, concurrent: 3 },
  { speedFrac: 0.095, radiusFrac: 0.040, lifetimeMs: 3400, concurrent: 3 },
  { speedFrac: 0.120, radiusFrac: 0.036, lifetimeMs: 3000, concurrent: 4 },
  { speedFrac: 0.150, radiusFrac: 0.032, lifetimeMs: 2700, concurrent: 4 },
];

// Points: 20 + 30 + 50 = 100 max per dot, so a perfect wave is 800.
const HIT_POINTS = [20, 30, 50];
// Cumulative score you must hold at each wave's checkpoint or you die.
// (~50% / 59% / 67% / 73% / 80% of a flawless run — the ramp is the pressure.)
const CHECKPOINTS = [400, 950, 1600, 2350, 3200];

// ---- canvas / DOM ---------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const el = (id) => document.getElementById(id);

let W = 0, H = 0, MIN = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  MIN = Math.min(W, H);
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  buildCover();
}
window.addEventListener('resize', resize);

// Arena bounds — keep dots clear of the top HUD strip.
const TOP = 100;
function arena() { return { x0: 24, y0: TOP, x1: W - 24, y1: H - 24 }; }

// ---- cover blocks ("peek around the corner") ------------------------------
let cover = [];
function buildCover() {
  // Fractional rectangles; regenerated on resize so layout scales with screen.
  const specs = [
    [0.14, 0.30, 0.10, 0.16],
    [0.74, 0.26, 0.11, 0.18],
    [0.40, 0.60, 0.20, 0.10],
    [0.20, 0.72, 0.12, 0.12],
    [0.66, 0.66, 0.14, 0.12],
  ];
  cover = specs.map(([fx, fy, fw, fh]) => ({
    x: fx * W, y: TOP + fy * (H - TOP),
    w: fw * W, h: fh * (H - TOP),
  }));
}
function pointInCover(x, y) {
  return cover.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
}

// ---- game state -----------------------------------------------------------
const State = { MENU: 'menu', PLAYING: 'playing', BREAK: 'break', OVER: 'over' };
let state = State.MENU;

let score = 0;
let waveIndex = 0;         // 0-based
let dots = [];
let spawnedThisWave = 0;
let resolvedThisWave = 0;
let wavePips = [];         // 'pending' | 'done' | 'leaked'
let combo = 0;

let shotsFired = 0;
let shotsHit = 0;
const killTimes = [];      // ms a dot survived before being popped (for stats)

const sparks = [];
const floaters = [];       // rising score numbers
let recoil = 0;            // crosshair kick 0..1
let shakeT = 0;            // screen-shake timer
const mouse = { x: -100, y: -100 };

// ---- audio (tiny WebAudio synth, no assets) -------------------------------
let actx = null;
function beep(freq, dur, type = 'square', vol = 0.15, slideTo = null) {
  if (!actx) return;
  const t = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur);
}
const sfx = {
  hit: () => beep(680, 0.06, 'square', 0.12, 900),
  kill: () => { beep(520, 0.09, 'square', 0.16, 1040); beep(1040, 0.12, 'triangle', 0.10); },
  miss: () => beep(150, 0.08, 'sawtooth', 0.08, 90),
  leak: () => beep(200, 0.22, 'sine', 0.10, 70),
  wave: () => { [440, 660, 880].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'square', 0.14), i * 90)); },
  dead: () => { [400, 300, 200, 120].forEach((f, i) => setTimeout(() => beep(f, 0.22, 'sawtooth', 0.14), i * 130)); },
};

// ---- dots -----------------------------------------------------------------
function spawnDot() {
  const cfg = WAVES[waveIndex];
  const a = arena();
  const r = Math.max(15, cfg.radiusFrac * MIN);
  let x, y, tries = 0;
  // Avoid spawning already tucked behind cover.
  do {
    x = a.x0 + r + Math.random() * (a.x1 - a.x0 - 2 * r);
    y = a.y0 + r + Math.random() * (a.y1 - a.y0 - 2 * r);
    tries++;
  } while (pointInCover(x, y) && tries < 20);

  const ang = Math.random() * Math.PI * 2;
  const spd = cfg.speedFrac * MIN;
  dots.push({
    x, y,
    vx: Math.cos(ang) * spd,
    vy: Math.sin(ang) * spd,
    r, maxR: r,
    hits: 0,
    born: performance.now(),
    life: lifetimeFor(cfg.lifetimeMs, spawnedThisWave),
    color: TARGET_COLORS[(Math.random() * TARGET_COLORS.length) | 0],
    dying: 0,        // >0 while pop animation plays
    leaking: 0,      // >0 while leak (fade) animation plays
    pop: 0,          // hit flash 0..1
  });
  spawnedThisWave++;
}

function resolveDot(dot, leaked) {
  const pipIdx = resolvedThisWave;
  wavePips[pipIdx] = leaked ? 'leaked' : 'done';
  resolvedThisWave++;
  renderPips();
  if (leaked) { combo = 0; sfx.leak(); }
}

// ---- shooting -------------------------------------------------------------
function shoot(px, py) {
  if (state !== State.PLAYING) return;
  shotsFired++;
  recoil = 1;

  // Clicked the wall itself → spark, no target behind it counts.
  if (pointInCover(px, py)) { addSpark(px, py, '#5a5a8a'); sfx.miss(); combo = 0; return; }

  // Topmost hittable dot: alive, not mid-animation, centre not behind cover.
  let hit = null;
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.dying || d.leaking) continue;
    if (pointInCover(d.x, d.y)) continue;           // peeking — can't tag it yet
    if (Math.hypot(px - d.x, py - d.y) <= d.r) { hit = d; break; }
  }

  if (!hit) { addSpark(px, py, '#3a3a5c'); sfx.miss(); combo = 0; return; }

  // Register the hit.
  shotsHit++;
  combo++;
  hit.pop = 1;
  const idx = hit.hits;
  hit.hits++;
  let gained = HIT_POINTS[idx];
  const bonus = Math.floor(combo / 4) * 5;         // streak upside (never gated on)
  gained += bonus;

  // knockback + speed-up so shrinking dots get twistier.
  const k = 60;
  const n = Math.hypot(hit.x - px, hit.y - py) || 1;
  hit.vx += ((hit.x - px) / n) * k * 0.4;
  hit.vy += ((hit.y - py) / n) * k * 0.4;
  hit.vx *= 1.08; hit.vy *= 1.08;

  if (hit.hits >= HITS_PER_DOT) {
    hit.dying = 1;
    gained += 0; // kill points already in HIT_POINTS[2]
    killTimes.push(performance.now() - hit.born);
    sfx.kill();
    shakeT = 0.18;
    burst(hit.x, hit.y, hit.color);
  } else {
    hit.r *= SHRINK;
    sfx.hit();
  }

  score += gained;
  addFloater(hit.x, hit.y - hit.r - 6, '+' + gained, hit.color);
  updateHud();
}

// ---- fx -------------------------------------------------------------------
function addSpark(x, y, color) { sparks.push({ x, y, r: 3, color, t: 1, ring: true }); }
function burst(x, y, color) {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 220;
    sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 2 + Math.random() * 3, color, t: 1 });
  }
}
function addFloater(x, y, text, color) { floaters.push({ x, y, text, color, t: 1 }); }

// ---- update loop ----------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state === State.PLAYING) update(dt, now);
  draw(now);
  requestAnimationFrame(frame);
}

function update(dt, now) {
  const cfg = WAVES[waveIndex];
  const a = arena();

  // keep the arena topped up with live dots
  const live = dots.filter((d) => !d.dying && !d.leaking).length;
  if (live < cfg.concurrent && spawnedThisWave < DOTS_PER_WAVE) spawnDot();

  for (const d of dots) {
    if (d.pop > 0) d.pop = Math.max(0, d.pop - dt * 5);

    if (d.dying) { d.dying += dt * 4; continue; }
    if (d.leaking) { d.leaking += dt * 3; continue; }

    d.x += d.vx * dt;
    d.y += d.vy * dt;
    // bounce off arena walls
    if (d.x - d.r < a.x0) { d.x = a.x0 + d.r; d.vx = Math.abs(d.vx); }
    if (d.x + d.r > a.x1) { d.x = a.x1 - d.r; d.vx = -Math.abs(d.vx); }
    if (d.y - d.r < a.y0) { d.y = a.y0 + d.r; d.vy = Math.abs(d.vy); }
    if (d.y + d.r > a.y1) { d.y = a.y1 - d.r; d.vy = -Math.abs(d.vy); }

    if (now - d.born > d.life) { d.leaking = 0.001; resolveDot(d, true); }
  }

  // retire finished animations
  for (const d of dots) {
    if (d.dying && d.dying >= 1 && !d._counted) { d._counted = true; resolveDot(d, false); }
  }
  dots = dots.filter((d) => !(d.dying >= 2) && !(d.leaking >= 1));

  // fx timers
  for (const s of sparks) { if (s.vx != null) { s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.9; s.vy *= 0.9; } s.t -= dt * (s.ring ? 3 : 1.4); }
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].t <= 0) sparks.splice(i, 1);
  for (const f of floaters) { f.y -= dt * 40; f.t -= dt * 1.1; }
  for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].t <= 0) floaters.splice(i, 1);
  if (recoil > 0) recoil = Math.max(0, recoil - dt * 6);
  if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);

  // wave complete?
  if (resolvedThisWave >= DOTS_PER_WAVE) endWave();
}

// ---- drawing --------------------------------------------------------------
function draw(now) {
  ctx.clearRect(0, 0, W, H);

  // screen shake
  let sx = 0, sy = 0;
  if (shakeT > 0) { const m = shakeT * 40; sx = (Math.random() - 0.5) * m; sy = (Math.random() - 0.5) * m; }
  ctx.save();
  ctx.translate(sx, sy);

  drawGrid();

  // dots first, so cover draws on top (the "peek" occlusion).
  for (const d of dots) drawDot(d, now);
  drawCover();

  // fx above everything in the arena
  for (const s of sparks) drawSpark(s);
  for (const f of floaters) drawFloater(f);

  ctx.restore();

  if (state === State.PLAYING || state === State.BREAK) drawCrosshair();
}

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = 'rgba(80, 70, 140, 0.10)';
  ctx.lineWidth = 1;
  const step = 46;
  ctx.beginPath();
  for (let x = 0; x <= W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y <= H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.restore();
}

function drawDot(d, now) {
  ctx.save();
  const alpha = d.leaking ? Math.max(0, 1 - d.leaking) : 1;
  let r = d.r;
  if (d.dying) r = d.r * (1 + d.dying * 0.6);
  ctx.globalAlpha = alpha * (d.dying ? Math.max(0, 1 - d.dying) : 1);

  // life ring drains as the dot's clock runs down
  if (!d.dying && !d.leaking) {
    const frac = Math.max(0, 1 - (now - d.born) / d.life);
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = frac < 0.3 ? '#f85149' : d.color;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = alpha * 0.7;
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  ctx.shadowColor = d.color;
  ctx.shadowBlur = 22;
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
  ctx.fill();

  // white hot core + hit flash
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(255,255,255,${0.35 + d.pop * 0.5})`;
  ctx.beginPath();
  ctx.arc(d.x, d.y, r * (0.45 + d.pop * 0.3), 0, Math.PI * 2);
  ctx.fill();

  // remaining-hits ticks
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const left = HITS_PER_DOT - d.hits;
  for (let i = 0; i < left; i++) {
    const ang = -Math.PI / 2 + (i / HITS_PER_DOT) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(d.x + Math.cos(ang) * r * 0.55, d.y + Math.sin(ang) * r * 0.55, Math.max(1.5, r * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCover() {
  for (const b of cover) {
    ctx.save();
    ctx.fillStyle = '#12122a';
    ctx.strokeStyle = '#ff2e97';
    ctx.shadowColor = '#ff2e97';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    // hazard hatching
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,46,151,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let o = -b.h; o < b.w; o += 14) { ctx.moveTo(b.x + o, b.y + b.h); ctx.lineTo(b.x + o + b.h, b.y); }
    ctx.save(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip(); ctx.stroke(); ctx.restore();
    ctx.restore();
  }
}

function drawSpark(s) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, s.t);
  ctx.fillStyle = s.color;
  ctx.shadowColor = s.color;
  ctx.shadowBlur = 8;
  if (s.ring) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, (1 - s.t) * 20 + 4, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFloater(f) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, f.t);
  ctx.fillStyle = f.color;
  ctx.font = '14px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.shadowColor = f.color;
  ctx.shadowBlur = 8;
  ctx.fillText(f.text, f.x, f.y);
  ctx.restore();
}

function drawCrosshair() {
  const kick = recoil * 6;
  const x = mouse.x, y = mouse.y;
  ctx.save();
  ctx.strokeStyle = '#39c5cf';
  ctx.shadowColor = '#39c5cf';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2;
  const gap = 6 + kick, len = 14;
  ctx.beginPath();
  ctx.moveTo(x - gap - len, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(x + gap + len, y);
  ctx.moveTo(x, y - gap - len); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, y + gap + len);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#39c5cf';
  ctx.fill();
  ctx.restore();
}

// ---- wave / flow ----------------------------------------------------------
function startWave(idx) {
  waveIndex = idx;
  dots = [];
  spawnedThisWave = 0;
  resolvedThisWave = 0;
  wavePips = new Array(DOTS_PER_WAVE).fill('pending');
  state = State.PLAYING;
  renderPips();
  updateHud();
  showBanner(`WAVE ${idx + 1}`, `SURVIVE ${CHECKPOINTS[idx]} PTS`, WAVES.length);
}

function endWave() {
  state = State.BREAK;
  const need = CHECKPOINTS[waveIndex];
  if (score < need) { gameOver(false); return; }

  sfx.wave();
  if (waveIndex + 1 >= TOTAL_WAVES) { gameOver(true); return; }

  showBanner('CHECKPOINT CLEARED', `NEXT: WAVE ${waveIndex + 2}`, 0);
  setTimeout(() => startWave(waveIndex + 1), 1900);
}

function gameOver(won) {
  state = State.OVER;
  won ? sfx.wave() : sfx.dead();
  el('end-title').textContent = won ? 'YOU SURVIVED' : 'FLATLINED';
  el('end-title').style.color = won ? 'var(--neon-green)' : 'var(--danger)';
  el('end-title').style.textShadow = `0 0 14px ${won ? 'var(--neon-green)' : 'var(--danger)'}`;
  el('final-score').textContent = score;
  el('final-wave').textContent = (won ? TOTAL_WAVES : waveIndex + 1) + '/' + TOTAL_WAVES;
  const acc = shotsFired ? Math.round((shotsHit / shotsFired) * 100) : 0;
  el('final-acc').textContent = acc + '%';
  const medMs = median(killTimes);
  const speed = Number.isFinite(medMs) ? ` · MED KILL ${(medMs / 1000).toFixed(2)}s` : '';
  el('end-msg').textContent = won
    ? `FLAWLESS OPERATOR — ${acc}% ACCURACY${speed}`
    : `WAVE ${waveIndex + 1} CHECKPOINT WAS ${CHECKPOINTS[waveIndex]} — YOU HAD ${score}`;

  // render leaderboard (current state before any new entry)
  renderLeaderboard(el('end-lb-rows'));

  el('end').classList.remove('hidden');
  el('hud').classList.add('hidden');
  el('wave-progress').classList.add('hidden');

  // prompt for initials if it's a new high score
  if (lbIsHigh(score)) {
    showHiscoreEntry({ score, wave: won ? TOTAL_WAVES : waveIndex + 1, acc });
  }
}

// ---- HUD ------------------------------------------------------------------
function updateHud() {
  el('score').textContent = score;
  el('wave').innerHTML = (waveIndex + 1) + '<span class="dim">/5</span>';
  const need = CHECKPOINTS[waveIndex];
  const cp = el('checkpoint');
  cp.textContent = need;
  cp.className = 'hud-value ' + (score >= need ? 'done-ok' : 'warn');
  cp.style.color = score >= need ? 'var(--neon-green)' : '';
  cp.style.textShadow = score >= need ? '0 0 10px var(--neon-green)' : '';
}
function renderPips() {
  const wrap = el('wave-progress');
  wrap.innerHTML = '';
  for (let i = 0; i < DOTS_PER_WAVE; i++) {
    const p = document.createElement('div');
    p.className = 'pip' + (wavePips[i] === 'done' ? ' done' : wavePips[i] === 'leaked' ? ' leaked' : '');
    wrap.appendChild(p);
  }
}
let bannerTimer = null;
function showBanner(big, sub, holdWaves) {
  const b = el('banner');
  const color = TARGET_COLORS[(waveIndex) % TARGET_COLORS.length];
  b.innerHTML = `<div class="big" style="color:${color}">${big}</div><div class="sub">${sub}</div>`;
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 1600);
}

// ---- leaderboard (localStorage) -------------------------------------------
const LB_KEY = 'fps_trainer_lb';
const LB_MAX = 10;

function lbGet() {
  try { return JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch (_) { return []; }
}
function lbSave(lb) {
  try { localStorage.setItem(LB_KEY, JSON.stringify(lb)); } catch (_) {}
}
function lbIsHigh(s) {
  const lb = lbGet();
  return lb.length < LB_MAX || s > lb[lb.length - 1].score;
}
function lbAdd(code, s, wave, acc) {
  const lb = lbGet();
  lb.push({ code: (code + '---').slice(0, 3).toUpperCase(), score: s, wave, acc, ts: Date.now() });
  lb.sort((a, b) => b.score - a.score);
  lb.splice(LB_MAX);
  lbSave(lb);
}
function lbDaysAgo(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return 'TODAY';
  if (days === 1) return '1 DAY AGO';
  return days + ' DAYS AGO';
}
function renderLeaderboard(rowsEl) {
  const lb = lbGet();
  if (!lb.length) {
    rowsEl.innerHTML = '<p class="lb-empty">NO SCORES YET — BE THE FIRST</p>';
    return;
  }
  rowsEl.innerHTML = lb.map((e, i) =>
    `<div class="lb-row${i === 0 ? ' lb-top' : ''}">` +
    `<span class="lb-rank">${i + 1}</span>` +
    `<span class="lb-code">${e.code}</span>` +
    `<span class="lb-score">${e.score}</span>` +
    `<span class="lb-meta">W${e.wave}·${e.acc}%</span>` +
    `<span class="lb-date">${lbDaysAgo(e.ts)}</span>` +
    `</div>`
  ).join('');
}

// ---- high-score initials entry --------------------------------------------
let hsLetters = ['A', 'A', 'A'];
let hsCursor = 0;
let hsPending = null; // { score, wave, acc }

function showHiscoreEntry(pending) {
  hsPending = pending;
  hsLetters = ['A', 'A', 'A'];
  hsCursor = 0;
  el('hs-scorenum').textContent = pending.score;
  renderHsSlots();
  el('hiscore').classList.remove('hidden');
}

function renderHsSlots() {
  for (let i = 0; i < 3; i++) {
    const s = el('hs-slot-' + i);
    s.textContent = hsLetters[i];
    s.classList.toggle('active', i === hsCursor);
  }
}

function hsCycleUp() {
  const c = hsLetters[hsCursor].charCodeAt(0);
  hsLetters[hsCursor] = String.fromCharCode(c >= 90 ? 65 : c + 1);
  renderHsSlots();
}
function hsCycleDown() {
  const c = hsLetters[hsCursor].charCodeAt(0);
  hsLetters[hsCursor] = String.fromCharCode(c <= 65 ? 90 : c - 1);
  renderHsSlots();
}

function hsSubmit() {
  if (!hsPending) return;
  lbAdd(hsLetters.join(''), hsPending.score, hsPending.wave, hsPending.acc);
  hsPending = null;
  el('hiscore').classList.add('hidden');
  // refresh leaderboard on both screens now that the new score is saved
  renderLeaderboard(el('end-lb-rows'));
  renderLeaderboard(el('start-lb-rows'));
}

document.addEventListener('keydown', (e) => {
  if (el('hiscore').classList.contains('hidden')) return;
  const key = e.key;
  if (key === 'ArrowLeft')  { e.preventDefault(); hsCursor = (hsCursor + 2) % 3; renderHsSlots(); return; }
  if (key === 'ArrowRight') { e.preventDefault(); hsCursor = (hsCursor + 1) % 3; renderHsSlots(); return; }
  if (key === 'ArrowUp')    { e.preventDefault(); hsCycleUp();   return; }
  if (key === 'ArrowDown')  { e.preventDefault(); hsCycleDown(); return; }
  if (key === 'Backspace')  { e.preventDefault(); if (hsCursor > 0) { hsCursor--; hsLetters[hsCursor] = 'A'; renderHsSlots(); } return; }
  if (key === 'Enter' || key === ' ') { e.preventDefault(); hsSubmit(); return; }
  if (/^[A-Za-z0-9]$/.test(key)) {
    hsLetters[hsCursor] = key.toUpperCase();
    if (hsCursor < 2) hsCursor++;
    renderHsSlots();
  }
});

el('hs-ok').addEventListener('click', hsSubmit);
for (let i = 0; i < 3; i++) {
  el('hs-slot-' + i).addEventListener('click', () => { hsCursor = i; renderHsSlots(); });
}

// ---- input / boot ---------------------------------------------------------
canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; shoot(e.clientX, e.clientY); });
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  mouse.x = t.clientX; mouse.y = t.clientY;
  shoot(t.clientX, t.clientY);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  mouse.x = t.clientX; mouse.y = t.clientY;
}, { passive: true });
// swallow right-click menu so rapid clicking never pops it
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function begin() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
  score = 0; combo = 0; shotsFired = 0; shotsHit = 0; killTimes.length = 0;
  el('start').classList.add('hidden');
  el('end').classList.add('hidden');
  el('hiscore').classList.add('hidden');
  hsPending = null;
  el('hud').classList.remove('hidden');
  el('wave-progress').classList.remove('hidden');
  startWave(0);
}

el('start-btn').addEventListener('click', begin);
el('retry-btn').addEventListener('click', begin);

resize();
requestAnimationFrame(frame);

// populate start-screen leaderboard immediately
renderLeaderboard(el('start-lb-rows'));
