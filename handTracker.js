/**
 * handTracker.js
 *
 * Thin wrapper around MediaPipe Hands. Everything here runs locally in the
 * browser (WASM) — the video frames never leave the device.
 *
 * Exposes `window.HandTracker`:
 *   - start(videoEl, previewCanvasEl, onUpdate): begins camera + model, calls
 *     onUpdate(state) on every processed frame.
 *   - stop(): stops the camera.
 *
 * state passed to onUpdate:
 *   {
 *     present: boolean,        // was a hand detected this frame
 *     x, y: number,            // normalized 0..1 fingertip position, MIRRORED
 *                               // so moving your hand right moves x right
 *     gesture: 'open' | 'fist' | 'point' | 'none'
 *   }
 */
(function () {
  const FINGER_TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 };
  const FINGER_PIPS = { index: 6, middle: 10, ring: 14, pinky: 18 };

  function isFingerExtended(landmarks, tipIdx, pipIdx) {
    // In image space, y grows downward. An extended finger's tip sits
    // meaningfully above (smaller y) its pip joint.
    return landmarks[tipIdx].y < landmarks[pipIdx].y - 0.02;
  }

  function classifyGesture(landmarks) {
    let extendedCount = 0;
    let indexExtended = false;

    for (const name of ['index', 'middle', 'ring', 'pinky']) {
      const extended = isFingerExtended(landmarks, FINGER_TIPS[name], FINGER_PIPS[name]);
      if (extended) extendedCount++;
      if (name === 'index') indexExtended = extended;
    }

    // Thumb: compare x distance from palm since thumb moves sideways, not up/down.
    const thumbTip = landmarks[4];
    const thumbMcp = landmarks[2];
    const wrist = landmarks[0];
    const thumbExtended = Math.abs(thumbTip.x - wrist.x) > Math.abs(thumbMcp.x - wrist.x) + 0.03;

    if (extendedCount === 0 && !thumbExtended) return 'fist';
    if (extendedCount >= 3) return 'open';
    if (indexExtended && extendedCount === 1) return 'point';
    return 'none';
  }

  function drawSkeleton(ctx, landmarks, w, h) {
    const CONNECTIONS = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],
      [0,17]
    ];
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const p1 = landmarks[a], p2 = landmarks[b];
      ctx.moveTo(p1.x * w, p1.y * h);
      ctx.lineTo(p2.x * w, p2.y * h);
    }
    ctx.stroke();

    ctx.fillStyle = '#ffb454';
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let camera = null;
  let hands = null;

  async function start(videoEl, previewCanvasEl, onUpdate, options) {
    const opts = Object.assign({
      facingMode: 'user',
      width: 480,
      height: 360
    }, options || {});

    hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0, // fastest, lowest-latency model — plenty for gesture control
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5
    });

    const previewCtx = previewCanvasEl.getContext('2d');

    hands.onResults((results) => {
      const w = previewCanvasEl.width;
      const h = previewCanvasEl.height;

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        previewCtx.clearRect(0, 0, w, h);
        onUpdate({ present: false, x: 0.5, y: 0.5, gesture: 'none' });
        return;
      }

      const landmarks = results.multiHandLandmarks[0];
      drawSkeleton(previewCtx, landmarks, w, h);

      const tip = landmarks[FINGER_TIPS.index];
      const gesture = classifyGesture(landmarks);

      onUpdate({
        present: true,
        x: 1 - tip.x, // mirror so hand-right = screen-right
        y: tip.y,
        gesture
      });
    });

    camera = new Camera(videoEl, {
      onFrame: async () => {
        await hands.send({ image: videoEl });
      },
      facingMode: opts.facingMode,
      width: opts.width,
      height: opts.height
    });

    await camera.start();
  }

  function stop() {
    if (camera) {
      camera.stop();
      camera = null;
    }
  }

  window.HandTracker = { start, stop };
})();
