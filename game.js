/**
 * game.js
 * "SIGNAL" — a minimal dodge game steered entirely by hand gestures,
 * recognized locally via handTracker.js (MediaPipe Hands, on-device WASM).
 */
(function () {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const videoEl = document.getElementById('inputVideo');
  const camCanvas = document.getElementById('camCanvas');
  const camDot = document.getElementById('camDot');

  const scoreVal = document.getElementById('scoreVal');
  const bestVal = document.getElementById('bestVal');
  const gestureVal = document.getElementById('gestureVal');
  const shieldFill = document.getElementById('shieldFill');
  const healthPipsEl = document.getElementById('healthPips');
  const restartFill = document.getElementById('restartFill');

  const startScreen = document.getElementById('startScreen');
  const endScreen = document.getElementById('endScreen');
  const loadingScreen = document.getElementById('loadingScreen');
  const loadingEyebrow = document.getElementById('loadingEyebrow');
  const loadingTitle = document.getElementById('loadingTitle');
  const loadingHint = document.getElementById('loadingHint');
  const skipDetectBtn = document.getElementById('skipDetectBtn');
  const camPanel = document.getElementById('camPanel');
  const startBtn = document.getElementById('startBtn');
  const retryBtn = document.getElementById('retryBtn');
  const startError = document.getElementById('startError');
  const endScoreLabel = document.getElementById('endScoreLabel');
  const endMessage = document.getElementById('endMessage');

  // ---------- Mobile viewport height fix ----------
  // Mobile browsers resize their chrome (address bar) which throws off 100vh.
  // We track real viewport height in a CSS var instead.
  function setViewportUnit() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  setViewportUnit();
  window.addEventListener('resize', setViewportUnit);
  window.addEventListener('orientationchange', setViewportUnit);

  const isMobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;

  let W = 0, H = 0;
  function resize() {
    setViewportUnit();
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  // ---------- Persistent best score ----------
  const BEST_KEY = 'signal_best_score';
  let bestScore = 0;
  try { bestScore = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; } catch (e) { bestScore = 0; }
  bestVal.textContent = String(bestScore).padStart(4, '0');

  // ---------- Hand state ----------
  const hand = { present: false, x: 0.5, y: 0.5, gesture: 'none' };
  const avatar = { x: W / 2, y: H / 2, r: 16 };

  const SHIELD_MAX = 100;
  let shieldEnergy = SHIELD_MAX;
  let shieldActive = false;
  const SHIELD_DRAIN_PER_SEC = 45;
  const SHIELD_REGEN_PER_SEC = 18;

  // ---------- Health / healing ----------
  const HEALTH_MAX = 3;
  let health = HEALTH_MAX;
  let invulnTimer = 0;
  const INVULN_DURATION = 1.2; // seconds of i-frames after taking a hit
  let timeSinceLastHit = 0;
  const REGEN_INTERVAL = 9; // seconds of clean survival to regenerate one point

  function renderHealthPips() {
    healthPipsEl.innerHTML = '';
    for (let i = 0; i < HEALTH_MAX; i++) {
      const pip = document.createElement('div');
      pip.className = 'health-pip' + (i < health ? ' filled' : '');
      healthPipsEl.appendChild(pip);
    }
  }

  function flashHealthHit() {
    const pips = healthPipsEl.querySelectorAll('.health-pip');
    const idx = health; // the pip that just emptied
    if (pips[idx]) {
      pips[idx].classList.add('hit');
      setTimeout(() => pips[idx] && pips[idx].classList.remove('hit'), 300);
    }
  }

  // ---------- Gesture-controlled restart (no mouse needed after game over) ----------
  const RESTART_HOLD_MS = 1100;
  let restartHoldStart = 0;
  let restartTriggered = false;

  function updateRestartGesture() {
    if (endScreen.classList.contains('hidden')) {
      restartHoldStart = 0;
      if (restartFill) restartFill.style.width = '0%';
      return;
    }
    const now = performance.now();
    if (hand.present && hand.gesture === 'open') {
      if (!restartHoldStart) restartHoldStart = now;
      const progress = Math.min((now - restartHoldStart) / RESTART_HOLD_MS, 1);
      if (restartFill) restartFill.style.width = (progress * 100) + '%';
      if (progress >= 1 && !restartTriggered) {
        restartTriggered = true;
        endScreen.classList.add('hidden');
        startGame();
      }
    } else {
      restartHoldStart = 0;
      if (restartFill) restartFill.style.width = '0%';
    }
  }

  // ---------- Waiting for an initial hand detection before play begins ----------
  let awaitingHandDetection = false;
  let handDetectHoldStart = 0;
  const HAND_DETECT_HOLD_MS = 350; // brief sustained detection avoids starting on a flicker
  let resolveHandDetected = null;

  function updateHandDetectionWait() {
    if (!awaitingHandDetection) return;
    const now = performance.now();
    if (hand.present) {
      if (!handDetectHoldStart) handDetectHoldStart = now;
      if (now - handDetectHoldStart >= HAND_DETECT_HOLD_MS) {
        awaitingHandDetection = false;
        if (resolveHandDetected) { resolveHandDetected(); resolveHandDetected = null; }
      }
    } else {
      handDetectHoldStart = 0;
    }
  }

  function onHandUpdate(state) {
    hand.present = state.present;
    if (state.present) {
      hand.x = state.x;
      hand.y = state.y;
    }
    hand.gesture = state.gesture;

    camDot.classList.toggle('live', state.present);

    let label = '—';
    if (!state.present) label = 'NO HAND';
    else if (state.gesture === 'fist') label = 'FIST · SHIELD';
    else if (state.gesture === 'open') label = 'OPEN · STEER';
    else if (state.gesture === 'point') label = 'POINT';
    gestureVal.textContent = label;

    updateHandDetectionWait();

    // The end-screen gesture-restart check runs off the same per-frame
    // callback so it keeps working even while the main game loop is stopped.
    updateRestartGesture();
  }

  // ---------- Game state ----------
  let running = false;
  let score = 0;
  let elapsed = 0;
  let obstacles = [];
  let spawnTimer = 0;
  let lastTime = 0;
  let particles = [];

  function resetGame() {
    score = 0;
    elapsed = 0;
    obstacles = [];
    particles = [];
    spawnTimer = 0;
    shieldEnergy = SHIELD_MAX;
    shieldActive = false;
    health = HEALTH_MAX;
    invulnTimer = 0;
    timeSinceLastHit = 0;
    restartTriggered = false;
    avatar.x = W / 2;
    avatar.y = H / 2;
    renderHealthPips();
  }

  // Slower, gentler difficulty ramp: takes well over a minute to approach
  // its ceiling instead of spiking in the first few seconds.
  function difficultySpeed() {
    return Math.min(190 + elapsed * 3.2, 480);
  }

  function difficultySpawnInterval() {
    return Math.max(1.3 - elapsed * 0.0055, 0.5);
  }

  function spawnObstacle() {
    const edge = Math.floor(Math.random() * 4); // 0 top,1 right,2 bottom,3 left
    let x, y, vx, vy;
    const speed = difficultySpeed() * (0.85 + Math.random() * 0.3);
    const margin = 40;

    switch (edge) {
      case 0: x = Math.random() * W; y = -margin; break;
      case 1: x = W + margin; y = Math.random() * H; break;
      case 2: x = Math.random() * W; y = H + margin; break;
      default: x = -margin; y = Math.random() * H; break;
    }

    // Aim roughly toward the current avatar position with some spread,
    // so obstacles feel targeted but dodgeable.
    const spread = 0.6;
    const targetX = avatar.x + (Math.random() * 2 - 1) * W * spread * 0.5;
    const targetY = avatar.y + (Math.random() * 2 - 1) * H * spread * 0.5;
    const dx = targetX - x, dy = targetY - y;
    const dist = Math.hypot(dx, dy) || 1;
    vx = (dx / dist) * speed;
    vy = (dy / dist) * speed;

    obstacles.push({
      x, y, vx, vy,
      r: 10 + Math.random() * 10,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() * 2 - 1) * 3
    });
  }

  function spawnBurst(x, y, color) {
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI * 2 * i) / 10;
      particles.push({
        x, y,
        vx: Math.cos(a) * (120 + Math.random() * 80),
        vy: Math.sin(a) * (120 + Math.random() * 80),
        life: 0.5,
        maxLife: 0.5,
        color
      });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const alpha = Math.max(p.life / p.maxLife, 0);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function updateAvatarTarget() {
    if (!hand.present) return;
    const margin = 40;
    const tx = margin + hand.x * (W - margin * 2);
    const ty = margin + hand.y * (H - margin * 2);
    // Smooth follow so tracking jitter doesn't feel twitchy.
    avatar.x += (tx - avatar.x) * 0.22;
    avatar.y += (ty - avatar.y) * 0.22;
  }

  function updateShield(dt) {
    const wantsShield = hand.gesture === 'fist';
    if (wantsShield && shieldEnergy > 0) {
      shieldActive = true;
      shieldEnergy = Math.max(0, shieldEnergy - SHIELD_DRAIN_PER_SEC * dt);
    } else {
      shieldActive = false;
      shieldEnergy = Math.min(SHIELD_MAX, shieldEnergy + SHIELD_REGEN_PER_SEC * dt);
    }
    const pct = (shieldEnergy / SHIELD_MAX) * 100;
    shieldFill.style.width = pct + '%';
    shieldFill.classList.toggle('ready', !shieldActive && shieldEnergy > SHIELD_MAX * 0.6);
  }

  function updateHealth(dt) {
    if (invulnTimer > 0) invulnTimer = Math.max(0, invulnTimer - dt);

    if (health < HEALTH_MAX) {
      timeSinceLastHit += dt;
      if (timeSinceLastHit >= REGEN_INTERVAL) {
        timeSinceLastHit = 0;
        health = Math.min(HEALTH_MAX, health + 1);
        renderHealthPips();
      }
    }
  }

  function takeDamage(x, y) {
    if (invulnTimer > 0) return; // still recovering from the last hit
    health -= 1;
    invulnTimer = INVULN_DURATION;
    timeSinceLastHit = 0;
    spawnBurst(x, y, '#ff6b4a');
    flashHealthHit();
    renderHealthPips();
    if (health <= 0) {
      endGame('Integrity depleted.');
    }
  }

  function checkCollisions() {
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      const d = Math.hypot(o.x - avatar.x, o.y - avatar.y);
      if (d < o.r + avatar.r) {
        if (shieldActive) {
          spawnBurst(o.x, o.y, '#ffb454');
          obstacles.splice(i, 1);
          score += 5;
        } else if (invulnTimer > 0) {
          // Already recovering — clear the obstacle without a second penalty.
          obstacles.splice(i, 1);
        } else {
          obstacles.splice(i, 1);
          takeDamage(o.x, o.y);
          if (!running) return;
        }
      }
    }
  }

  function pruneOffscreen() {
    const pad = 100;
    obstacles = obstacles.filter(o =>
      o.x > -pad && o.x < W + pad && o.y > -pad && o.y < H + pad
    );
  }

  function drawGrid() {
    // subtle radial vignette to keep focus centered
    const grad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H) * 0.7);
    grad.addColorStop(0, 'rgba(11,14,20,0)');
    grad.addColorStop(1, 'rgba(11,14,20,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function drawAvatar() {
    let color = shieldActive ? '#ffb454' : '#5eead4';
    // Blink while invulnerable so a hit reads as a hit, not a freebie.
    if (invulnTimer > 0 && !shieldActive) {
      const blink = Math.floor(invulnTimer * 10) % 2 === 0;
      if (blink) color = '#ff6b4a';
    }

    ctx.save();
    ctx.shadowBlur = shieldActive ? 30 : 18;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.arc(avatar.x, avatar.y, avatar.r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (shieldActive) {
      ctx.beginPath();
      ctx.arc(avatar.x, avatar.y, avatar.r + 12, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawObstacles() {
    ctx.save();
    for (const o of obstacles) {
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.rot);
      ctx.shadowBlur = 14;
      ctx.shadowColor = '#ff6b4a';
      ctx.fillStyle = '#ff6b4a';
      ctx.beginPath();
      const r = o.r;
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.86, r * 0.6);
      ctx.lineTo(-r * 0.86, r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function update(dt) {
    elapsed += dt;
    score += dt * 12;

    updateAvatarTarget();
    updateShield(dt);
    updateHealth(dt);

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnObstacle();
      spawnTimer = difficultySpawnInterval();
    }

    for (const o of obstacles) {
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.rot += o.spin * dt;
    }

    updateParticles(dt);
    checkCollisions();
    if (!running) return;
    pruneOffscreen();

    scoreVal.textContent = String(Math.floor(score)).padStart(4, '0');
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawGrid();
    drawObstacles();
    drawParticles();
    drawAvatar();
  }

  function loop(ts) {
    if (!running) return;
    if (!lastTime) lastTime = ts;
    const dt = Math.min((ts - lastTime) / 1000, 0.05);
    lastTime = ts;

    update(dt);
    if (!running) return;
    render();

    requestAnimationFrame(loop);
  }

  function endGame(message) {
    running = false;
    const finalScore = Math.floor(score);
    if (finalScore > bestScore) {
      bestScore = finalScore;
      try { localStorage.setItem(BEST_KEY, String(bestScore)); } catch (e) {}
      bestVal.textContent = String(bestScore).padStart(4, '0');
    }
    endScoreLabel.textContent = String(finalScore).padStart(4, '0');
    endMessage.textContent = message;
    restartTriggered = false;
    restartHoldStart = 0;
    if (restartFill) restartFill.style.width = '0%';
    endScreen.classList.remove('hidden');
  }

  function startGame() {
    endScreen.classList.add('hidden');
    resetGame();
    running = true;
    lastTime = 0;
    requestAnimationFrame(loop);
  }

  function waitForHandDetected() {
    return new Promise((resolve) => {
      awaitingHandDetection = true;
      handDetectHoldStart = 0;
      resolveHandDetected = resolve;
    });
  }

  skipDetectBtn.addEventListener('click', () => {
    if (awaitingHandDetection) {
      awaitingHandDetection = false;
      if (resolveHandDetected) { resolveHandDetected(); resolveHandDetected = null; }
    }
  });

  const HAND_DETECT_HINT_TEXT = loadingHint.textContent;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function describeStartupError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera permission was denied — allow camera access in your browser, we\u2019ll keep checking.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found — connect one and we\u2019ll keep checking.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera seems to be in use by another app — close it and we\u2019ll keep checking.';
    }
    return (err && err.message) || 'Having trouble starting hand tracking — retrying automatically.';
  }

  // ---------- Boot: camera + model (retries indefinitely instead of giving up) ----------
  let bootAttempt = 0;

  async function boot() {
    startBtn.disabled = true;
    startError.textContent = '';
    skipDetectBtn.classList.add('hidden');
    loadingHint.classList.add('hidden');
    loadingScreen.classList.remove('hidden');

    // eslint-disable-next-line no-constant-condition
    while (true) {
      bootAttempt++;
      loadingEyebrow.textContent = bootAttempt === 1 ? 'INITIALIZING' : `RETRYING · ATTEMPT ${bootAttempt}`;
      loadingTitle.innerHTML = 'CALIBRATING MODEL<span class="ellipsis"><span>.</span><span>.</span><span>.</span></span>';

      try {
        await window.HandTracker.start(videoEl, camCanvas, onHandUpdate, {
          facingMode: 'user',
          width: isMobile ? 320 : 480,
          height: isMobile ? 240 : 360
        });
        break; // success — fall through to phase 2 below
      } catch (err) {
        console.warn(`Hand-tracking start attempt ${bootAttempt} failed, retrying:`, err);
        window.HandTracker.stop();
        loadingHint.textContent = describeStartupError(err);
        loadingHint.classList.remove('hidden');
        await sleep(1500);
        // loop continues — never dead-ends here
      }
    }

    // Phase 2: model is confirmed running — now wait for an actual hand.
    camPanel.classList.remove('hidden');
    loadingEyebrow.textContent = 'AWAITING SIGNAL';
    loadingTitle.textContent = 'SHOW YOUR HAND';
    loadingHint.textContent = HAND_DETECT_HINT_TEXT;
    loadingHint.classList.remove('hidden');

    const skipTimer = setTimeout(() => {
      skipDetectBtn.classList.remove('hidden');
    }, 6000);

    await waitForHandDetected();
    clearTimeout(skipTimer);

    loadingScreen.classList.add('hidden');
    startScreen.classList.add('hidden');
    startGame();
  }

  startBtn.addEventListener('click', boot);
  retryBtn.addEventListener('click', () => {
    endScreen.classList.add('hidden');
    startGame();
  });

  renderHealthPips();
  loadingScreen.classList.add('hidden'); // only show while actively booting
})();
