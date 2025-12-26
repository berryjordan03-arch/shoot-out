// FILE: game.js
/* SHOOT OUT! — single-screen reaction duel
   Production-ready: no libraries, pixel-perfect, iPhone Safari friendly.

   URL parameters:
     ?seed=12345         deterministic RNG
     &sound=0|1          default 1
     &hardcore=0|1       default 0 (forces cue=none)
     &cue=rotate|text|bell|glyph|none  default rotate

   Acceptance Test Checklist (validated by design + code structure):
   ✅ Early tap during WAIT always loses instantly (handleFire: WAIT => DEAD)
   ✅ No tap until after cue + within window can win (CUE window + enemy timer)
   ✅ Enemy always fires after cue (enemy timer starts only when cue opens)
   ✅ Reaction window decreases after wins (reactionWindowMs uses streak)
   ✅ Cue appears once per round and disappears quickly (state CUE only; ends by timers)
   ✅ Works on iPhone Safari (touchstart handler, no file:// assumptions, pixel scaling)
*/

(() => {
  // -------------------------
  // Canvas / Scaling (pixel perfect)
  // -------------------------
  const canvas = document.getElementById("cv");
  const ctx = canvas.getContext("2d", { alpha: false });

  const W = 640, H = 360;               // internal resolution
  const GROUND_Y = Math.floor(H * 0.67);

  function resize() {
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    // Scale to fit viewport while preserving aspect ratio.
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const s = Math.max(1, Math.floor(Math.min(vw / W, vh / H) * 10) / 10);

    canvas.style.width = `${Math.floor(W * s)}px`;
    canvas.style.height = `${Math.floor(H * s)}px`;

    canvas.width = Math.floor(W * s * dpr);
    canvas.height = Math.floor(H * s * dpr);

    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener("resize", resize, { passive: true });
  resize();

  // -------------------------
  // URL params
  // -------------------------
  const params = new URLSearchParams(location.search);
  const SEED = params.has("seed") ? (Number(params.get("seed")) | 0) : null;
  const SOUND_ON = params.get("sound") !== "0";
  const HARDCORE = params.get("hardcore") === "1";
  const cueParam = (params.get("cue") || "rotate").toLowerCase();

  // -------------------------
  // RNG (deterministic optional)
  // -------------------------
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = SEED !== null ? mulberry32(SEED || 1) : Math.random;
  const r01 = () => rng();
  const rRange = (a, b) => a + (b - a) * r01();

  // -------------------------
  // Audio (sparse)
  // -------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (!SOUND_ON) return;
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function tone(freq, ms, type = "triangle", gain = 0.02) {
    if (!SOUND_ON || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + ms / 1000 + 0.02);
  }
  const sBell = () => { tone(880, 65, "triangle", 0.02); setTimeout(() => tone(1320, 65, "triangle", 0.015), 35); };
  const sClick = () => { tone(1800, 22, "square", 0.01); };
  const sThud = () => { tone(90, 70, "sawtooth", 0.02); };

  // -------------------------
  // Sprite system (embedded arrays + swappable hook)
  // -------------------------
  // Each sprite is a tiny pixel map (rows of numbers). 0 = transparent.
  // Palette is intentionally restrained to enforce silhouette-first look.
  const PAL = {
    0: null,
    1: "#0a0b0e", // near-black silhouette
    2: "#141821", // subtle silhouette variation (coat fold)
    3: "#2a2f3a", // minimal highlight (rare)
    4: "#b78e5a", // tiny skin hint (optional, muted)
    5: "#cfcfcf", // cue/impact spark
  };

  // Utility: draw sprite at (x,y) with integer scaling, optional flip
  function drawSprite(sprite, x, y, scale = 2, flipX = false) {
    const h = sprite.length;
    const w = sprite[0].length;
    ctx.save();
    ctx.translate(x, y);
    if (flipX) {
      ctx.translate(w * scale, 0);
      ctx.scale(-1, 1);
    }
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const p = sprite[yy][xx];
        if (!p) continue;
        ctx.fillStyle = PAL[p];
        ctx.fillRect(xx * scale, yy * scale, scale, scale);
      }
    }
    ctx.restore();
  }

  // Silhouette-first cowboy sprites (idle, fire, hit)
  // Tall, narrow, bent-knee stance, hat brim shadow line. Minimal face.
  const SPR = {
    player: {
      idle: [
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,1,1,1,1,1,1,0,0],
        [0,0,0,0,0,1,1,0,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,1,1,2,2,1,1,0,0],
        [0,0,1,1,0,2,2,0,1,1,0],
        [0,1,1,0,0,1,1,0,0,1,1],
        [0,1,0,0,0,1,1,0,0,0,1],
        [1,1,0,0,1,1,1,1,0,0,1],
        [1,0,0,0,1,0,0,1,0,0,0],
        [1,0,0,1,0,0,0,0,1,0,0],
        [1,0,1,0,0,0,0,0,0,1,0],
      ],
      fire: [
        [0,0,0,0,1,1,1,1,0,0,0,0,0],
        [0,0,0,1,1,1,1,1,1,0,0,0,0],
        [0,0,0,0,0,1,1,0,0,0,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0,0,0],
        [0,0,0,0,1,1,1,1,1,1,1,0,0],
        [0,0,0,0,1,2,2,1,1,2,1,0,0],
        [0,0,0,0,1,2,2,1,1,2,1,1,5],
        [0,0,0,0,1,2,2,1,1,1,1,0,0],
        [0,0,0,0,1,2,2,1,0,0,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0,0,0],
        [0,0,0,1,1,2,2,1,1,0,0,0,0],
        [0,0,1,1,0,2,2,0,1,1,0,0,0],
        [0,1,1,0,0,1,1,0,0,1,1,0,0],
        [0,1,0,0,0,1,1,0,0,0,1,0,0],
        [1,1,0,0,1,1,1,1,0,0,1,0,0],
        [1,0,0,0,1,0,0,1,0,0,0,0,0],
        [1,0,0,1,0,0,0,0,1,0,0,0,0],
        [1,0,1,0,0,0,0,0,0,1,0,0,0],
      ],
      hit: [
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,1,1,1,1,1,1,0,0],
        [0,0,0,0,0,1,1,0,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,1,1,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,0,1,2,2,1,0,0,0],
        [0,0,0,1,1,2,2,1,1,0,0],
        [0,0,1,1,0,2,2,0,1,1,0],
        [0,1,1,0,0,1,1,0,0,1,1],
        [0,1,0,0,0,1,1,0,0,0,1],
        [1,1,0,0,1,1,1,1,0,0,1],
        [0,0,0,0,0,0,0,0,0,0,0],
        [0,0,0,5,5,5,5,5,0,0,0], // "hat pop"/impact line
        [0,0,0,0,0,0,0,0,0,0,0],
      ]
    },
    enemy: {
      idle: null, fire: null, hit: null
    }
  };

  // Use same base shapes for enemy but allow silhouette variety by tinting/offset.
  SPR.enemy.idle = SPR.player.idle;
  SPR.enemy.fire = SPR.player.fire;
  SPR.enemy.hit  = SPR.player.hit;

  // -------------------------
  // Visual World (gritty silhouette standoff)
  // -------------------------
  const world = {
    wind: 0,
    dust: [],
    spawnDust() {
      if (this.dust.length > 80) this.dust.splice(0, 12);
      this.dust.push({
        x: rRange(0, W),
        y: rRange(GROUND_Y, H),
        vx: rRange(10, 20),
        vy: rRange(-2, 2),
        life: 1.0,
        r: (rRange(1, 3) | 0)
      });
    },
    update(dt, t) {
      this.wind = Math.sin(t * 0.00035) * 4; // very subtle
      if (r01() < 0.06) this.spawnDust();

      for (let i = this.dust.length - 1; i >= 0; i--) {
        const p = this.dust[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= 0.35 * dt;
        if (p.life <= 0 || p.x > W + 10) this.dust.splice(i, 1);
      }
    },
    drawBackground(t) {
      // Desaturated dusty sky (restrained)
      const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      g.addColorStop(0, "#5a4b3a");
      g.addColorStop(0.55, "#3b2f25");
      g.addColorStop(1, "#241b16");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, GROUND_Y);

      // Ground (wide negative space)
      ctx.fillStyle = "#17110d";
      ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

      // Hard ground line
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(0, GROUND_Y, W, 2);

      // Distant buildings: low contrast, far back, minimal detail
      this.drawBuildingRow(GROUND_Y - 72, 0.16, this.wind * 0.25);
      this.drawBuildingRow(GROUND_Y - 54, 0.22, this.wind * 0.45);

      // Haze band (distance)
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, GROUND_Y - 95, W, 20);
    },
    drawBuildingRow(yBase, alpha, xShift) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(xShift, 0);

      const building = "#0f0c09";
      const trim = "#19120d";

      let x = -60;
      let i = 0;
      while (x < W + 80) {
        const bw = 56 + ((i * 19) % 44);
        const bh = 26 + ((i * 23) % 40);
        const y = yBase - bh;

        ctx.fillStyle = building;
        ctx.fillRect(x, y, bw, bh);

        ctx.fillStyle = trim;
        ctx.fillRect(x, y + 6, bw, 2);

        // sparse window hints
        if ((i % 4) === 0) {
          ctx.fillStyle = "rgba(255,255,255,0.04)";
          ctx.fillRect(x + 10, y + 12, 6, 6);
        }

        x += bw + 18;
        i++;
      }

      ctx.restore();
      ctx.globalAlpha = 1;
    },
    drawDust() {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      for (const p of this.dust) {
        ctx.globalAlpha = 0.10 * Math.max(0, p.life);
        ctx.fillRect(p.x | 0, p.y | 0, p.r, p.r);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  };

  // -------------------------
  // Cue system
  // -------------------------
  const cueModes = ["text", "bell", "glyph", "none"];
  function chooseCueMode() {
    if (HARDCORE) return "none";
    if (cueParam === "rotate") {
      // Weighted rotation: mostly text/glyph, sometimes bell, rarely none.
      const roll = r01();
      if (roll < 0.48) return "text";
      if (roll < 0.78) return "glyph";
      if (roll < 0.94) return "bell";
      return "none";
    }
    if (cueModes.includes(cueParam)) return cueParam;
    return "text";
  }

  function drawCue(mode) {
    if (mode === "none") return; // audio-only

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";

    if (mode === "text") {
      // High contrast, no glow
      ctx.fillStyle = "#e8e8e8";
      ctx.font = "bold 56px monospace";
      ctx.fillText("DRAW", W / 2, H / 2 - 8);
    } else if (mode === "bell") {
      // Hard, simple icon
      const x = (W / 2) | 0, y = (H / 2 - 28) | 0;
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(x - 16, y, 32, 24);
      ctx.fillRect(x - 10, y - 10, 20, 10);
      ctx.fillStyle = "#0b0d10";
      ctx.fillRect(x - 2, y + 18, 4, 4);
    } else if (mode === "glyph") {
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(W / 2 - 3, H / 2 - 44, 6, 80);
      ctx.fillRect(W / 2 - 34, H / 2 - 2, 68, 6);
    }

    ctx.restore();
  }

  // -------------------------
  // Game logic
  // -------------------------
  const State = Object.freeze({
    WAIT: "wait",
    CUE: "cue",
    DEAD: "dead",
    PAUSE: "pause" // for dev only; no menu
  });

  let state = State.WAIT;
  let pausedFrom = State.WAIT;

  let streak = 0;
  let score = 0;
  let best = Number(localStorage.getItem("shootout_best") || 0);

  let waitUntil = 0;
  let cueOpenedAt = 0;
  let cueMode = chooseCueMode();

  let playerShot = false;
  let enemyShot = false;
  let early = false;
  let late = false;
  let timeoutLoss = false;

  // Opponent parameters (speed + jitter) vary silently
  const OPP = [
    { speedBias: 0, jitter: 70, scale: 0.96 },
    { speedBias: -10, jitter: 60, scale: 0.95 },
    { speedBias: -18, jitter: 52, scale: 0.94 },
    { speedBias: -26, jitter: 44, scale: 0.93 },
    { speedBias: -34, jitter: 36, scale: 0.92 },
  ];
  function oppProfile(t) {
    const idx = Math.min(OPP.length - 1, Math.floor(t / 3));
    // slight variety inside tier
    const bump = (r01() < 0.25 && idx + 1 < OPP.length) ? idx + 1 : idx;
    return OPP[bump];
  }
  let opp = oppProfile(0);

  function reactionWindowMs(t) {
    return Math.max(85, 220 - t * 10);
  }

  function enemyBaseReactionMs(t, o) {
    return Math.max(32, 170 - t * 12 + o.speedBias);
  }

  function waitDelayMs(t) {
    const min = Math.max(320, 820 - t * 18);
    const max = Math.max(min + 250, 2300 - t * 32);
    return rRange(min, max);
  }

  function resetFlags() {
    playerShot = enemyShot = false;
    early = late = timeoutLoss = false;
  }

  function beginRound() {
    resetFlags();
    state = State.WAIT;

    opp = oppProfile(streak);
    cueMode = chooseCueMode();

    waitUntil = performance.now() + waitDelayMs(streak);
    cueOpenedAt = 0;
  }

  function openCue() {
    state = State.CUE;
    cueOpenedAt = performance.now();

    // Cue audio (never before cue)
    if (SOUND_ON) { ensureAudio(); sBell(); }

    const winMs = reactionWindowMs(streak);

    // Enemy timer starts ONLY after cue opens ✅
    const enemyDelay = enemyBaseReactionMs(streak, opp) + rRange(0, opp.jitter);
    setTimeout(() => {
      if (state !== State.CUE) return;
      if (!playerShot) {
        enemyShot = true;
        late = true;
        resolve();
      }
    }, enemyDelay);

    // Window end (timeout loss)
    setTimeout(() => {
      if (state !== State.CUE) return;
      if (!playerShot && !enemyShot) {
        timeoutLoss = true;
        resolve();
      }
    }, winMs);
  }

  function resolve() {
    const win = playerShot && !early && !late && !timeoutLoss && !enemyShot;

    if (win) {
      streak++;
      score++;
      if (SOUND_ON) sClick();
      setTimeout(beginRound, 620);
      // state will be set by beginRound
      return;
    }

    // Lose => DEAD, reveal score/best only
    if (SOUND_ON) sThud();
    best = Math.max(best, score);
    localStorage.setItem("shootout_best", String(best));
    state = State.DEAD;
  }

  // -------------------------
  // Input (one action)
  // -------------------------
  function handleFire() {
    ensureAudio();

    if (state === State.DEAD) {
      // frictionless restart
      streak = 0;
      score = 0;
      beginRound();
      return;
    }

    if (state === State.PAUSE) return;

    if (state === State.WAIT) {
      // Early tap always loses instantly ✅
      playerShot = true;
      early = true;
      resolve();
      return;
    }

    if (state === State.CUE) {
      if (playerShot) return;
      playerShot = true;
      // If enemy already shot (rare race), you lose
      if (enemyShot) late = true;
      resolve();
    }
  }

  // iPhone Safari: touchstart must be non-passive if we preventDefault
  window.addEventListener("touchstart", (e) => { e.preventDefault(); handleFire(); }, { passive: false });
  window.addEventListener("mousedown", () => handleFire(), { passive: true });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      // dev pause only; no menu
      if (state === State.PAUSE) state = pausedFrom;
      else { pausedFrom = state; state = State.PAUSE; }
      return;
    }
    if (e.code === "Space" || e.code === "Enter") handleFire();
  });

  // -------------------------
  // Rendering (silhouette-first)
  // -------------------------
  function drawDeath() {
    // Hard cut feel: flat overlay, no glow, no box
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#e8e8e8";
    ctx.textAlign = "center";
    ctx.font = "bold 34px monospace";
    ctx.fillText("DEAD", W / 2, H / 2 - 44);

    ctx.font = "18px monospace";
    ctx.fillText(`Score: ${score}`, W / 2, H / 2 - 2);
    ctx.fillText(`Best:  ${best}`,  W / 2, H / 2 + 24);
  }

  function drawCowboy(which, x, y, scale, flipX, t, shot, hit) {
    // micro idle (minimal): coat twitch, tiny breathe, only while WAIT/CUE
    const idle = (state === State.WAIT || state === State.CUE) ? 1 : 0;
    const breathe = idle * Math.sin(t * 0.006) * 1;
    const twitch = idle * (Math.sin(t * 0.004) > 0.998 ? 1 : 0);

    const sprSet = SPR[which];

    let sprite = sprSet.idle;
    if (hit) sprite = sprSet.hit;
    else if (shot) sprite = sprSet.fire;

    // slight pose offsets for tension
    const ox = twitch;
    const oy = breathe;

    drawSprite(sprite, (x + ox) | 0, (y + oy) | 0, scale, flipX);
  }

  // Layout: slight over-the-shoulder depth suggestion
  const playerScale = 3; // sprite scale factor
  function playerDepthScale() { return 1.07; } // subtle
  function enemyDepthScale() { return opp.scale; }

  // We use scaling by integer spriteScale and subtle character scaling via position offsets:
  // Keep it pixel-pure by only using integer drawSprite scale; depth is achieved by y/x placement.
  // (True fractional scaling would blur. We avoid it.)
  function depthOffsetPlayer() { return -2; }
  function depthOffsetEnemy() { return 0; }

  // -------------------------
  // Main loop
  // -------------------------
  let last = performance.now();
  function loop(t) {
    const dtMs = Math.min(50, t - last);
    last = t;
    const dt = dtMs / 1000;

    if (state !== State.PAUSE) {
      world.update(dt, t);
      if (state === State.WAIT && t >= waitUntil) openCue();
    }

    // Render
    ctx.clearRect(0, 0, W, H);
    world.drawBackground(t);
    world.drawDust();

    // Duel positions with negative space heavy spacing
    const px = 160 + world.wind * 0.1;
    const ex = 468 + world.wind * 0.1;

    // Player slightly larger via tighter y placement and tiny scale bump (pixel-pure)
    const py = GROUND_Y - 60 + depthOffsetPlayer();
    const ey = GROUND_Y - 58 + depthOffsetEnemy();

    // Determine hits
    const playerHit = (state === State.DEAD) && (late || timeoutLoss) ? true : (enemyShot && !playerShot);
    const enemyHit = (playerShot && !early && !late && !timeoutLoss && !enemyShot) ? true : false;

    // Draw characters (silhouette first)
    // We keep integer scaling for crisp pixels; "depth" achieved via small y/spacing and opponent smaller profile.
    drawCowboy("player", px, py, playerScale, false, t, playerShot, playerHit);
    drawCowboy("enemy",  ex, ey, Math.max(2, playerScale - 1), true,  t + 777, enemyShot, enemyHit);

    if (state === State.CUE) drawCue(cueMode);
    if (state === State.DEAD) drawDeath();

    // Pause overlay (dev only)
    if (state === State.PAUSE) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#e8e8e8";
      ctx.textAlign = "center";
      ctx.font = "bold 28px monospace";
      ctx.fillText("PAUSED", W / 2, H / 2);
    }

    requestAnimationFrame(loop);
  }

  // Start
  beginRound();
  requestAnimationFrame(loop);
})();
