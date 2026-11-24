// Face + eye tracking with Google MediaPipe Face Landmarker (runs on-device, no upload).
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export async function createLandmarker() {
  const files = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try { return await FaceLandmarker.createFromOptions(files, opts('GPU')); }
  catch { return await FaceLandmarker.createFromOptions(files, opts('CPU')); }
}

// Expression scores that tend to rise with tension
const TENSION_KEYS = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'mouthPressLeft', 'mouthPressRight',
  'mouthRollLower', 'mouthRollUpper', 'eyeSquintLeft', 'eyeSquintRight', 'noseSneerLeft', 'noseSneerRight',
];

export class FrameAnalyzer {
  constructor(video, landmarker, overlay) {
    this.video = video;
    this.landmarker = landmarker;
    this.overlay = overlay;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastTs = -1;
  }

  process(now) {
    const v = this.video;
    if (!v.videoWidth || now <= this.lastTs) return null;
    this.lastTs = now;
    const res = this.landmarker.detectForVideo(v, now);
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) { this.drawOverlay(null); return { face: false }; }

    const bs = {};
    (res.faceBlendshapes?.[0]?.categories || []).forEach((c) => { bs[c.categoryName] = c.score; });

    // Downscaled frame for colour sampling
    const sw = Math.min(320, v.videoWidth);
    const sh = Math.round((sw * v.videoHeight) / v.videoWidth);
    if (this.canvas.width !== sw) { this.canvas.width = sw; this.canvas.height = sh; }
    this.ctx.drawImage(v, 0, 0, sw, sh);

    const faceWpx = Math.hypot((lm[454].x - lm[234].x) * sw, (lm[454].y - lm[234].y) * sh);
    const rois = [
      { c: lm[151], w: 0.3, h: 0.1 }, // forehead
      { c: lm[50], w: 0.1, h: 0.1 },  // left cheek
      { c: lm[280], w: 0.1, h: 0.1 }, // right cheek
    ].map(({ c, w, h }) => {
      const bw = Math.max(2, Math.round(w * faceWpx)), bh = Math.max(2, Math.round(h * faceWpx));
      const x = Math.round(c.x * sw - bw / 2), y = Math.round(c.y * sh - bh / 2);
      return { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(bw, sw - Math.max(0, x)), h: Math.min(bh, sh - Math.max(0, y)) };
    });

    let r = 0, g = 0, b = 0, n = 0;
    for (const roi of rois) {
      if (roi.w < 1 || roi.h < 1) continue;
      const d = this.ctx.getImageData(roi.x, roi.y, roi.w, roi.h).data;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    }
    if (!n) return { face: false };
    r /= n; g /= n; b /= n;

    // Gaze: iris centre position within each eye (0..1 across, 0..1 down)
    const ratio = (iris, a, bb) => (lm[iris].x - lm[a].x) / ((lm[bb].x - lm[a].x) || 1e-6);
    const vratio = (iris, top, bot) => (lm[iris].y - lm[top].y) / ((lm[bot].y - lm[top].y) || 1e-6);
    const gazeX = (ratio(468, 33, 133) + ratio(473, 362, 263)) / 2;
    const gazeY = (vratio(468, 159, 145) + vratio(473, 386, 374)) / 2;

    let tension = 0;
    for (const k of TENSION_KEYS) tension += bs[k] || 0;
    tension /= TENSION_KEYS.length;

    this.drawOverlay(lm, rois, sw, sh);

    return {
      face: true,
      rgb: [r, g, b],
      brightness: (r + g + b) / 3,
      blink: ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2,
      tension,
      gazeX, gazeY,
      noseX: lm[1].x, noseY: lm[1].y,
      faceW: Math.hypot(lm[454].x - lm[234].x, lm[454].y - lm[234].y),
    };
  }

  drawOverlay(lm, rois, sw, sh) {
    const o = this.overlay;
    if (!o) return;
    const W = this.video.videoWidth, H = this.video.videoHeight;
    if (o.width !== W) { o.width = W; o.height = H; }
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!lm) return;
    const k = W / sw;
    ctx.lineWidth = Math.max(2, W / 320);
    ctx.strokeStyle = 'rgba(255, 99, 99, 0.9)';
    for (const r of rois) ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
    ctx.fillStyle = 'rgba(80, 200, 255, 0.95)';
    for (const i of [468, 473]) {
      ctx.beginPath();
      ctx.arc(lm[i].x * W, lm[i].y * H, Math.max(3, W / 160), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
