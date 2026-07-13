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

  const startScreen = document.getElementById('startScreen');
  const endScreen = document.getElementById('endScreen');
  const loadingScreen = document.getElementById('loadingScreen');
  const startBtn = document.getElementById('startBtn');
  const retryBtn = document.getElementById('retryBtn');
  const startError = document.getElementById('startError');
  const endScoreLabel = document.getElementById('endScoreLabel');
  const endMessage = document.getElementById('endMessage');

  let W = 0, H = 0;
  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
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
    avatar.x = W / 2;
    avatar.y = H / 2;
  }

  function difficultySpeed() {
    // Base speed ramps up gradually with survival time, capped.
    return Math.min(260 + elapsed * 9, 720);
  }

  function difficultySpawnInterval() {
    return Math.max(0.85 - elapsed * 0.012, 0.22);
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

  function checkCollisions() {
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      const d = Math.hypot(o.x - avatar.x, o.y - avatar.y);
      if (d < o.r + avatar.r) {
        if (shieldActive) {
          spawnBurst(o.x, o.y, '#ffb454');
          obstacles.splice(i, 1);
          score += 5;
        } else {
          endGame('An obstacle got through your guard.');
          return;
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
    const color = shieldActive ? '#ffb454' : '#5eead4';
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
    endScreen.classList.remove('hidden');
  }

  function startGame() {
    endScreen.classList.add('hidden');
    resetGame();
    running = true;
    lastTime = 0;
    requestAnimationFrame(loop);
  }

  // ---------- Boot: camera + model ----------
  let trackerStarted = false;

  async function boot() {
    startBtn.disabled = true;
    startError.textContent = '';
    loadingScreen.classList.remove('hidden');
    try {
      await window.HandTracker.start(videoEl, camCanvas, onHandUpdate);
      trackerStarted = true;
      loadingScreen.classList.add('hidden');
      startScreen.classList.add('hidden');
      startGame();
    } catch (err) {
      console.error(err);
      loadingScreen.classList.add('hidden');
      startBtn.disabled = false;
      startError.textContent =
        'Could not access the camera. Check permissions and that you are on https:// (or localhost), then try again.';
    }
  }

  startBtn.addEventListener('click', boot);
  retryBtn.addEventListener('click', () => {
    endScreen.classList.add('hidden');
    startGame();
  });

  loadingScreen.classList.add('hidden'); // only show while actively booting
})();
