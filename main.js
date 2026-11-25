/**
 * main.js ― 拡張翻訳 - CultureLens（MVP）
 * 入力: カメラ映像 + マイク音声（Web Speech API / 手入力フォールバック）
 * 処理: engine/translate-engine.js（Gemini マルチモーダル拡張翻訳）
 * 出力: 字幕 + Three.js 空間タグピン
 */
import * as THREE from 'three';
import { extendedTranslate, getApiKey, setApiKey, hasApiKey, MOCK_RESULT } from './engine/translate-engine.js?v=20261126-1';

const $ = (id) => document.getElementById(id);
const video = $('camera');
let stream = null;

/* ---------- カメラ ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    $('status-chip').textContent = 'カメラ起動中（背面）';
    $('btn-record').disabled = false;
    $('btn-translate').disabled = false;
    $('btn-shutter').disabled = false;
    applyResultVisibility();
    startQrScan();
  } catch (e) {
    $('status-chip').textContent = 'カメラを起動できませんでした: ' + e.message;
  }
  updateCameraButton();
}

/* ---------- カメラ ON/OFF トグル ----------
   OFFにしても翻訳結果（字幕・タグカード・ギャップ／フック・見比べ）は
   そのまま読める。止めるのは映像と空間タグとトラッキングだけ。 */
function stopCamera() {
  if (recognition) { recognition.stop(); }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  stopQrScan();
  stopTracking(true);
  tagGroup.visible = false;
  $('btn-record').disabled = true;
  $('btn-translate').disabled = true;
  $('btn-shutter').disabled = true;
  $('status-chip').textContent = 'カメラ停止中';
  updateCameraButton();
}
function toggleCamera() {
  if (stream) stopCamera();
  else startCamera();
}
function updateCameraButton() {
  // 表示は「押すとどうなるか」：カメラON中は「📷 OFF」、停止中は「📷 ON」
  $('btn-camera').textContent = stream ? '📷 OFF' : '📷 ON';
  $('btn-camera').classList.toggle('off', !stream);
}

function captureFrame() {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 960 / (video.videoWidth || 960));
  c.width = (video.videoWidth || 960) * scale;
  c.height = (video.videoHeight || 720) * scale;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.72);
  return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], bytes: Math.floor(dataUrl.length * 0.75) };
}

/* ---------- 写真モード（静止画の拡張翻訳） ----------
   カメラを向け続けるのが難しい場面向けに、撮った写真／端末内の写真を
   静止画のまま拡張翻訳する。翻訳パイプラインと結果表示はライブと共通で、
   ラベルは静止画に対して1回だけ配置する（NCC追跡はライブ専用のまま）。
   履歴はセッション内のみ（localStorage には画像を保存しない）。 */
let photoMode = false;
let currentPhoto = null; // { dataUrl, frame }
const photoHistory = []; // 新しい順

function showPhoto(entry) {
  currentPhoto = entry;
  photoMode = true;
  stopTracking(true);
  const img = $('photo');
  img.src = entry.dataUrl;
  img.classList.remove('hidden');
  video.classList.add('hidden'); // 映像は隠すがストリームは生かし、撮り直しを速くする
  $('photo-bar').classList.remove('hidden');
  $('status-chip').textContent = '写真を表示中';
  renderPhotoThumbs();
}

function exitPhoto() {
  photoMode = false;
  currentPhoto = null;
  $('photo').classList.add('hidden');
  $('photo').removeAttribute('src');
  video.classList.remove('hidden');
  $('photo-bar').classList.add('hidden');
  $('status-chip').textContent = stream ? 'カメラ起動中（背面）' : 'カメラ未起動';
  renderPhotoThumbs();
}

function addPhotoHistory(entry) {
  photoHistory.unshift(entry);
  if (photoHistory.length > 20) photoHistory.length = 20;
  $('photo-history').classList.remove('hidden');
  renderPhotoThumbs();
}

function renderPhotoThumbs() {
  const box = $('photo-thumbs');
  box.innerHTML = '';
  for (const entry of photoHistory) {
    const t = document.createElement('img');
    t.src = entry.dataUrl;
    t.alt = '撮った写真';
    if (entry === currentPhoto) t.className = 'active';
    t.addEventListener('click', () => showPhoto(entry));
    box.appendChild(t);
  }
}

function takePhoto() {
  if (!stream) return;
  const frame = captureFrame();
  const entry = { dataUrl: `data:${frame.mimeType};base64,${frame.data}`, frame };
  addPhotoHistory(entry);
  showPhoto(entry);
}

function loadPhotoFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1280 / (img.naturalWidth || 1280));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    const frame = { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], bytes: Math.floor(dataUrl.length * 0.75) };
    const entry = { dataUrl, frame };
    addPhotoHistory(entry);
    showPhoto(entry);
  };
  img.onerror = () => { URL.revokeObjectURL(url); $('status-chip').textContent = '写真を読み込めませんでした'; };
  img.src = url;
}

// 静止画は object-fit: contain で全体表示されるため、写真内の座標(0〜1)を
// ステージ内の表示矩形に合わせて変換する（レターボックス分の補正）
function photoStageTransform() {
  const img = $('photo');
  const stage = $('stage');
  const W = stage.clientWidth || 1, H = stage.clientHeight || 1;
  const iw = img.naturalWidth || W, ih = img.naturalHeight || H;
  const s = Math.min(W / iw, H / ih);
  const dw = iw * s, dh = ih * s, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return (u, v) => ({ fx: (ox + u * dw) / W, fy: (oy + v * dh) / H });
}

/* ---------- 音声入力（語り手の声） ---------- */
let recognition = null;
function toggleRecord() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('このブラウザは音声認識に未対応です。下のテキスト欄に手入力してください。'); return; }
  if (recognition) { recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = true;
  let base = $('transcript').value;
  recognition.onresult = (ev) => {
    let text = '';
    for (const r of ev.results) text += r[0].transcript;
    $('transcript').value = base + text;
  };
  recognition.onend = () => { recognition = null; $('btn-record').textContent = '🎙 語る（音声入力）'; };
  recognition.onerror = () => { recognition = null; };
  recognition.start();
  $('btn-record').textContent = '⏹ 停止';
}

/* ---------- Three.js 空間タグ ---------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
cam3d.position.z = 5;
// ジャイロ追従用：カメラ位置（0,0,5）を支点にタグ全体を回すためのグループ
const gyroGroup = new THREE.Group();
gyroGroup.position.set(0, 0, 5);
scene.add(gyroGroup);
let tagGroup = new THREE.Group();
tagGroup.position.z = -5;
gyroGroup.add(tagGroup);
let placedTags = []; // 配置済みタグ（言語切替時にラベルを描き直すために保持）

function resizeGL() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  cam3d.aspect = w / h;
  cam3d.updateProjectionMatrix();
}
new ResizeObserver(resizeGL).observe(canvas);

function makeLabelTexture(title, idx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,0.82)';
  g.beginPath(); g.roundRect(4, 14, 504, 100, 22); g.fill();
  g.fillStyle = '#d29922';
  g.beginPath(); g.arc(52, 64, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
  g.fillText(String(idx + 1), 52, 79);
  g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.textAlign = 'left';
  const t = title.length > 22 ? title.slice(0, 22) + '…' : title;
  g.fillText(t, 92, 76);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function placeTags(tags) {
  stopTracking(false);
  gyroGroup.remove(tagGroup);
  tagGroup = new THREE.Group();
  tagGroup.position.z = -5;
  // 画面の横方向の可視範囲（ラベルのはみ出し防止に使う）
  const halfH = 5 * Math.tan(THREE.MathUtils.degToRad(cam3d.fov / 2));
  const halfW = halfH * cam3d.aspect;
  const placed = [];
  // 写真モードでは静止画の表示矩形に合わせて座標を補正する（ライブは恒等変換）
  const toStage = photoMode ? photoStageTransform() : (u, v) => ({ fx: u, fy: v });
  tags.forEach((tag, i) => {
    // AIが返した画像内座標(0〜1)を NDC 経由で空間にピン留めする（固定カメラ近似）
    const { fx, fy } = toStage(tag.x, tag.y);
    const ax = (fx - 0.5) * 4.6;
    const ay = (0.5 - fy) * 3.4;
    const anchor = new THREE.Group();
    anchor.position.set(ax, ay, 0);

    // 実物の位置を示す小さなアンカードット（実物を覆わない）
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(0.085, 24),
      new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.35 })
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.045, 24),
      new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.95 })
    );
    anchor.add(halo, dot);

    // ラベルはコンパクトにし、実物の上部に浮かせてリーダーラインで結ぶ
    // 横方向はラベル全体が画面内に収まるようずらし、ラインを斜めにしてアンカーと結ぶ
    const labelDy = Math.max(0.3, Math.min(0.52, 1.95 - ay));
    const labelX = THREE.MathUtils.clamp(ax, -(halfW - 0.85), halfW - 0.85) - ax;
    const floatGroup = new THREE.Group();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(1.55, 0.39),
      new THREE.MeshBasicMaterial({ map: makeLabelTexture(tagTitle(tag), i), transparent: true })
    );
    label.position.set(labelX, labelDy, 0);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(labelX, Math.max(0.09, labelDy - 0.21), 0),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.8 }));
    floatGroup.add(line, label);
    floatGroup.userData.phase = i * 1.3;
    anchor.userData.floatGroup = floatGroup;
    anchor.add(floatGroup);

    tagGroup.add(anchor);
    placed.push({ anchor, label, line, labelX, lineTopY: Math.max(0.09, labelDy - 0.21), u: fx, v: fy, tag, idx: i });
  });
  gyroGroup.add(tagGroup);
  placedTags = placed;
  // 写真モードではラベルを1回配置するだけ（NCC追跡はライブ専用）
  if (photoMode) stopTracking(true);
  else initTrackers(placed);
}

/* ---------- 視覚トラッキング（テンプレートマッチング） ----------
   撮影フレームから各タグ位置の画像パッチを切り出し、現在の映像の中で
   正規化相関（NCC）が最大の位置を定期的に探してアンカーを追従させる。
   回転だけでなく移動にも追従する。見失いが続くタグはいったん隠すが、
   低頻度の全画面スキャンで再検出を続け、見つけたら再表示する。
   処理負荷が高い状態が続いたら追従を止めて全ラベルを隠す（発熱・重さ対策）。 */
const TRACK_W = 192;          // 追跡用の作業解像度（横px）
const TRACK_INTERVAL = 100;   // 追跡間隔(ms)
const TRACK_ACCEPT = 0.55;    // これ未満の相関は「見失い」
const TRACK_REACQUIRE = 0.65; // 再検出のしきい値（誤って別物に復活しないよう通常より厳しめ）
const TRACK_LOST_LIMIT = 10;  // 見失いが続いたらそのタグを隠す（約1秒分）
const TRACK_SLOW_LIMIT = 70;  // 1tickの平均処理時間(ms)がこれを超え続けたら全停止
const trackCanvas = document.createElement('canvas');
const trackCtx = trackCanvas.getContext('2d', { willReadFrequently: true });
let captureGray = null; // 撮影時点のグレースケールフレーム {data,w,h}
let trackers = [];
let trackTimer = null;
let trackCostEma = 0;
let tickCount = 0;
let reacquireIdx = 0;
let allLostShown = false;

function grabGray() {
  if (!video.videoWidth) return null;
  const w = TRACK_W;
  const h = Math.max(1, Math.round(TRACK_W * video.videoHeight / video.videoWidth));
  if (trackCanvas.width !== w || trackCanvas.height !== h) { trackCanvas.width = w; trackCanvas.height = h; }
  trackCtx.drawImage(video, 0, 0, w, h);
  const px = trackCtx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  }
  return { data: gray, w, h };
}

function makeTemplate(frame, u, v) {
  const cx = Math.round(u * frame.w), cy = Math.round(v * frame.h);
  const half = 15;
  const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
  const x1 = Math.min(frame.w, cx + half), y1 = Math.min(frame.h, cy + half);
  const tw = x1 - x0, th = y1 - y0;
  if (tw < 12 || th < 12) return null;
  // テンプレートは2pxおきにサンプルして軽量化（統計はすべてこの点集合で一貫させる）
  const pts = [];
  let sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const val = frame.data[y * frame.w + x];
      pts.push({ dx: x - x0, dy: y - y0, v: val });
      sum += val; sum2 += val * val;
    }
  }
  const n = pts.length;
  const mean = sum / n;
  const varT = sum2 / n - mean * mean;
  if (varT < 4) return null; // ほぼ無地のパッチは追跡できない
  return { pts, n, mean, varT, tw, th, offX: cx - x0, offY: cy - y0 };
}

function nccAt(frame, tpl, x0, y0) {
  let sumI = 0, sumI2 = 0, cross = 0;
  const d = frame.data, w = frame.w;
  for (let k = 0; k < tpl.pts.length; k++) {
    const p = tpl.pts[k];
    const val = d[(y0 + p.dy) * w + (x0 + p.dx)];
    sumI += val; sumI2 += val * val; cross += val * p.v;
  }
  const n = tpl.n;
  const meanI = sumI / n;
  const varI = sumI2 / n - meanI * meanI;
  if (varI < 1) return -1;
  return (cross / n - meanI * tpl.mean) / Math.sqrt(varI * tpl.varT);
}

function searchTemplate(frame, tr, othersPx) {
  const tpl = tr.tpl;
  const cx = Math.round(tr.u * frame.w), cy = Math.round(tr.v * frame.h);
  const radius = tr.lost > 0 ? 42 : 24; // 見失い中は探索範囲を広げて復帰を狙う
  const baseX = cx - tpl.offX, baseY = cy - tpl.offY;
  // 他タグの現在位置に近い候補は割り引く（似た模様への吸着とラベルの入れ替わりを防ぐ）
  const scoreAt = (x, y) => {
    let s = nccAt(frame, tpl, x, y);
    const px = x + tpl.offX, py = y + tpl.offY;
    for (const o of othersPx) {
      if (Math.abs(px - o.x) < 12 && Math.abs(py - o.y) < 12) { s *= 0.8; break; }
    }
    return s;
  };
  let best = null;
  for (let y = baseY - radius; y <= baseY + radius; y += 2) {
    for (let x = baseX - radius; x <= baseX + radius; x += 2) {
      if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
      const s = scoreAt(x, y);
      if (!best || s > best.score) best = { score: s, x, y };
    }
  }
  if (best) { // 最良点の近傍を1px刻みで微調整
    const bx = best.x, by = best.y;
    for (let y = by - 1; y <= by + 1; y++) {
      for (let x = bx - 1; x <= bx + 1; x++) {
        if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
        const s = scoreAt(x, y);
        if (s > best.score) best = { score: s, x, y };
      }
    }
  }
  if (!best) return null;
  return { score: best.score, u: (best.x + tpl.offX) / frame.w, v: (best.y + tpl.offY) / frame.h, x: best.x, y: best.y };
}

// 一致度が高いときだけ、現在の見た目をテンプレートへ少しずつ反映し、
// 角度や明るさで見た目が徐々に変わっても追従が外れにくくする
function updateTemplate(frame, tr, x0, y0) {
  const tpl = tr.tpl, d = frame.data, w = frame.w;
  let sum = 0, sum2 = 0;
  for (const p of tpl.pts) {
    const cur = d[(y0 + p.dy) * w + (x0 + p.dx)];
    p.v = p.v * 0.9 + cur * 0.1;
    sum += p.v; sum2 += p.v * p.v;
  }
  tpl.mean = sum / tpl.n;
  tpl.varT = Math.max(1, sum2 / tpl.n - tpl.mean * tpl.mean);
}

// 再検出用：フレーム全体からテンプレートを探す（粗く走査→近傍を精密化）
function searchFullFrame(frame, tr) {
  const tpl = tr.tpl;
  const othersPx = trackers
    .filter((t) => t !== tr && t.state === 'active')
    .map((t) => ({ x: t.u * frame.w, y: t.v * frame.h }));
  const scoreAt = (x, y) => {
    let s = nccAt(frame, tpl, x, y);
    const px = x + tpl.offX, py = y + tpl.offY;
    for (const o of othersPx) {
      if (Math.abs(px - o.x) < 12 && Math.abs(py - o.y) < 12) { s *= 0.8; break; }
    }
    return s;
  };
  let best = null;
  for (let y = 0; y + tpl.th <= frame.h; y += 3) {
    for (let x = 0; x + tpl.tw <= frame.w; x += 3) {
      const s = scoreAt(x, y);
      if (!best || s > best.score) best = { score: s, x, y };
    }
  }
  if (!best) return null;
  const bx = best.x, by = best.y;
  for (let y = by - 2; y <= by + 2; y++) {
    for (let x = bx - 2; x <= bx + 2; x++) {
      if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
      const s = scoreAt(x, y);
      if (s > best.score) best = { score: s, x, y };
    }
  }
  return { score: best.score, u: (best.x + tpl.offX) / frame.w, v: (best.y + tpl.offY) / frame.h, x: best.x, y: best.y };
}

function applyAnchorPos(tr) {
  const ax = (tr.u - 0.5) * 4.6;
  const ay = (0.5 - tr.v) * 3.4;
  tr.anchor.position.set(ax, ay, 0);
  // ラベルの横はみ出し防止オフセットも追従に合わせて更新する
  const halfH = 5 * Math.tan(THREE.MathUtils.degToRad(cam3d.fov / 2));
  const halfW = halfH * cam3d.aspect;
  const labelX = THREE.MathUtils.clamp(ax, -(halfW - 0.85), halfW - 0.85) - ax;
  if (Math.abs(labelX - tr.labelX) > 0.02) {
    tr.labelX = labelX;
    tr.label.position.x = labelX;
    tr.line.geometry.setFromPoints([
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(labelX, tr.lineTopY, 0),
    ]);
  }
}

function trackTick() {
  if (!stream || video.readyState < 2) return;
  tickCount++;
  const hasActive = trackers.some((t) => t.state === 'active');
  const lostList = trackers.filter((t) => t.state === 'lost');
  const scanTick = lostList.length > 0 && tickCount % 8 === 0; // 再検出スキャンは約0.8秒に1回だけ（負荷分散）
  if (!hasActive && !scanTick) return;
  const frame = grabGray();
  if (!frame) return;
  const t0 = performance.now();
  for (const tr of trackers) {
    if (tr.state !== 'active') continue;
    const othersPx = trackers
      .filter((t) => t !== tr && t.state === 'active')
      .map((t) => ({ x: t.u * frame.w, y: t.v * frame.h }));
    const hit = searchTemplate(frame, tr, othersPx);
    if (hit && hit.score >= TRACK_ACCEPT) {
      tr.lost = 0;
      // 適応型平滑化：大きく動いたときは強く追従し、小さなブレだけ抑える（遅れ対策）
      const jump = Math.hypot((hit.u - tr.u) * frame.w, (hit.v - tr.v) * frame.h);
      const alpha = Math.min(0.92, 0.45 + jump / 25);
      tr.u += (hit.u - tr.u) * alpha;
      tr.v += (hit.v - tr.v) * alpha;
      applyAnchorPos(tr);
      if (hit.score >= 0.75) updateTemplate(frame, tr, hit.x, hit.y);
    } else {
      tr.lost++;
      if (tr.lost >= TRACK_LOST_LIMIT) { tr.state = 'lost'; tr.anchor.visible = false; }
    }
  }
  // 再検出：隠れたタグを1つずつ全画面から探し、見つけたら再表示する
  if (scanTick) {
    const tr = lostList[reacquireIdx++ % lostList.length];
    if (tr && tr.state === 'lost') {
      const hit = searchFullFrame(frame, tr);
      if (hit && hit.score >= TRACK_REACQUIRE) {
        tr.state = 'active';
        tr.lost = 0;
        tr.u = hit.u;
        tr.v = hit.v;
        tr.anchor.visible = true;
        applyAnchorPos(tr);
        if (hit.score >= 0.75) updateTemplate(frame, tr, hit.x, hit.y);
        if (!trackers.some((t) => t.state === 'lost')) allLostShown = false;
        if ($('status-chip').textContent.includes('再検出中')) $('status-chip').textContent = '拡張翻訳を表示中';
      }
    }
  }
  const cost = performance.now() - t0;
  trackCostEma = trackCostEma ? trackCostEma * 0.8 + cost * 0.2 : cost;
  if (trackCostEma > TRACK_SLOW_LIMIT) { hideAllTags('負荷軽減のため、ラベルを非表示にしました'); return; }
  if (trackers.length && trackers.every((t) => t.state === 'lost') && !allLostShown) {
    allLostShown = true;
    $('status-chip').textContent = '対象を見失ったためラベルを非表示にしました（再検出中）';
  }
}

function hideAllTags(msg) {
  stopTracking(false);
  tagGroup.children.forEach((a) => { a.visible = false; });
  $('status-chip').textContent = msg;
}

function stopTracking(resetCost) {
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  trackers = [];
  tickCount = 0;
  reacquireIdx = 0;
  allLostShown = false;
  if (resetCost) trackCostEma = 0;
}

function initTrackers(placed) {
  stopTracking(true);
  if (!captureGray || !stream) return;
  for (const p of placed) {
    const tpl = makeTemplate(captureGray, p.u, p.v);
    if (!tpl) continue;
    trackers.push({ ...p, tpl, lost: 0, state: 'active' });
  }
  if (trackers.length) trackTimer = setInterval(trackTick, TRACK_INTERVAL);
}

function animate(t) {
  requestAnimationFrame(animate);
  tagGroup.children.forEach((a) => {
    const f = a.userData.floatGroup;
    if (f) f.position.y = Math.sin(t / 900 + f.userData.phase) * 0.04;
  });
  renderer.render(scene, cam3d);
}
requestAnimationFrame(animate);
resizeGL();

/* ---------- 拡張翻訳の実行 ---------- */
async function runTranslate() {
  const useDemo = $('chk-demo').checked;
  // B-9 キーレス分離: キー未設定でAI生成が押されたら、モックで誤魔化さず
  // 「AI生成は追加機能」という案内を出す。登録スポットの表示はこの経路を通らない。
  if (!useDemo && !hasApiKey()) { trackAiFailure('key-required'); showAiKeyRequiredGuidance(); return; }
  hideAiFailureGuidance();
  const transcript = $('transcript').value.trim();
  $('btn-translate').disabled = true;
  $('btn-photo-translate').disabled = true;
  $('status-chip').textContent = '拡張翻訳中…';
  let frame = { mimeType: 'image/jpeg', data: '', bytes: 0 };
  captureGray = null;
  if (!useDemo) {
    if (photoMode && currentPhoto) {
      // 写真モード: 選択中の静止画をそのまま翻訳する（追跡用の控えは作らない）
      frame = currentPhoto.frame;
    } else if (stream) {
      frame = captureFrame();
      // 追跡用に、撮影時点の映像を作業解像度グレースケールで控える
      captureGray = grabGray();
    }
  }

  try {
    const result = useDemo ? { ...MOCK_RESULT, source: 'demo' } : await extendedTranslate(frame, transcript, { lang: resultLang });
    hideAiFailureGuidance();
    renderResult(result);
    // 計測（3-3）: AI生成の成功を ai_generate として送る（出所は ai_source で区別）
    trackAiGenerate(result);
    $('status-chip').textContent = '拡張翻訳を表示中';
  } catch (e) {
    // F-30: 生のエラー文は来訪者へ見せない。登録表示には触らず、
    // AI部分だけを丁寧な案内に切り替える（handleAiError に集約）。
    handleAiError(e);
  } finally {
    $('btn-translate').disabled = false;
    $('btn-photo-translate').disabled = false;
  }
}

/* ---------- カメラ画面の翻訳結果 表示/非表示トグル（右上の👁） ---------- */
let resultVisible = true;
let hasResult = false;
function applyResultVisibility() {
  $('subtitle-bar').classList.toggle('hidden', !(resultVisible && hasResult));
  tagGroup.visible = resultVisible;
}
$('btn-toggle-result').onclick = () => {
  resultVisible = !resultVisible;
  $('btn-toggle-result').classList.toggle('off', !resultVisible);
  applyResultVisibility();
};

/* ---------- 施設コンテキスト（B2B: J-44） ----------
   URL（パス形式 /f/… /s/… /t/…、またはクエリ形式 ?f= ?s= ?t=）が施設文脈を
   持つ場合に読み取り、セッション内は保持する（facility-context.js）。
   URLなしの通常起動では null で、従来の動作は一切変わらない。
   パック取得・言語・計測は、この単一の状態を参照する（後続の改修項目）。 */
const facilityContext = window.CultureLensFacility ? window.CultureLensFacility.init() : null;
window.CultureLensContext = facilityContext;
// ?lang= はこのセッション限りの表示言語として優先する。ただし既存の
// localStorage 言語設定（etw_result_lang）は恒久的に上書きしない。
// 2-11で対応言語は en/zh/ko/ja の4つになり、受理と正規化は
// facility-context.js（cleanLang）と i18n.js（normalizeLang）が担う。
const sessionLang = facilityContext && window.CultureLensI18n
  ? window.CultureLensI18n.normalizeLang(facilityContext.lang) : null;

/* ---------- 表示言語の状態（2-11） ----------
   宣言を後段の表示言語セクションより前に置くのは、キーレス案内などの
   初期表示（このファイルの前段で実行される）から参照するため。
   優先順位: ?lang= のセッション上書き → localStorage の保存済み設定 → en。
   保存済み値も正規化し、対応外なら en に倒れる。 */
let resultLang = (window.CultureLensI18n
  ? window.CultureLensI18n.normalizeLang(sessionLang || localStorage.getItem('etw_result_lang'))
  : null) || 'en';
const I18n = window.CultureLensI18n || null;
// B2B表示面の文面を現在の表示言語で引く（文面の正本は i18n.js）
const tr = (key) => (I18n ? I18n.t(resultLang, key) : key);

/* ---------- キーレス分離（B2B: B-9） ----------
   登録スポットの表示は APIキーに依存しない。AI生成（拡張翻訳）は
   「追加機能」として切り離し、キー未設定ではモックを本物らしく
   見せず、案内を出す。判定は keyless-mode.js に集約する。
   登録コンテンツの供給側（パック取得 2-4／ハイブリッド判定 2-5）は
   renderRegisteredResult() を呼ぶだけでよく、キーの有無を一切
   気にしなくてよい。 */
let hasRegisteredContent = false;
function currentAccess() {
  const demo = $('chk-demo') ? $('chk-demo').checked : false;
  const input = {
    hasApiKey: hasApiKey(),
    demo: demo,
    hasRegisteredContent: hasRegisteredContent,
    hasFacilityContext: !!facilityContext,
  };
  return window.CultureLensKeyless ? window.CultureLensKeyless.resolveAccess(input)
    : { mode: 'keyless-empty', canShowRegistered: hasRegisteredContent, canUseAi: input.hasApiKey, aiIsAddon: true, needsKeyForAi: !input.hasApiKey, showKeylessNotice: !input.hasApiKey };
}
function updateKeylessNotice() {
  const box = $('keyless-notice');
  if (!box) return;
  const a = currentAccess();
  if (!a.showKeylessNotice) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = tr(facilityContext ? 'keyless_notice_facility' : 'keyless_notice_plain');
  box.classList.remove('hidden');
}
function showAiKeyRequiredGuidance() {
  updateKeylessNotice();
  $('status-chip').textContent = tr(hasRegisteredContent ? 'key_required_status_registered' : 'key_required_status');
}
/* ---------- 障害時の振る舞い（B2B: F-30） ----------
   AI生成が失敗しても、登録コンテンツ（字幕・タグ・カード・実務情報・
   スポット案内）には一切触らない。失敗の影響は専用パネル #ai-failure と
   ステータス表示だけに閉じ込め、生のエラー文は来訪者へ見せない。
   失敗の分類と案内文は ai-failure.js に集約する。再試行は AI生成
   （runTranslate）だけをやり直し、パックの再取得やスポットの再表示は
   しないため、登録表示はそのまま残る。 */
let lastAiFailureKind = null;
function hideAiFailureGuidance() {
  lastAiFailureKind = null;
  const box = $('ai-failure');
  if (box) box.classList.add('hidden');
}
function showAiFailureGuidance(kind) {
  const F = window.CultureLensAiFailure;
  const g = F ? F.guidanceFor(kind, resultLang)
    : { title: 'AI生成を完了できませんでした', text: 'AI生成の途中で問題が発生しました。もう一度お試しください。登録スポットの表示には影響ありません。', showRetry: true };
  lastAiFailureKind = kind;
  $('ai-failure-title').textContent = g.title;
  $('ai-failure-text').textContent = g.text;
  $('btn-ai-retry').classList.toggle('hidden', !g.showRetry);
  $('ai-failure').classList.remove('hidden');
  $('status-chip').textContent = g.title;
}
function handleAiError(err) {
  const F = window.CultureLensAiFailure;
  const kind = F ? F.classifyAiError(err) : 'unknown';
  // 計測（3-3）: 失敗の発生を ai_failure として種別つきで送る。
  // key-required は障害として数えない前提で、種別を分けて送る（設計 §2 #4・§8）。
  // 言語切替での案内の出し直し（showAiFailureGuidance の再描画）では数えないため、
  // 発火点は失敗の集約点であるここに置く
  trackAiFailure(kind);
  // キー未設定は既存のキーレス案内（B-9）に寄せる。再試行しても進まない
  // 種別なので、汎用の失敗パネルではなく設定への案内を出す。
  if (kind === 'key-required') { hideAiFailureGuidance(); showAiKeyRequiredGuidance(); return; }
  showAiFailureGuidance(kind);
}
$('btn-ai-retry').addEventListener('click', () => { hideAiFailureGuidance(); runTranslate(); });

// 登録型コンテンツの表示入口（キー確認を一切しない）
function renderRegisteredResult(r) {
  hasRegisteredContent = true;
  renderResult({ ...r, source: (r && r.source) || 'registered' });
  updateKeylessNotice();
}
window.CultureLensRegistered = { show: renderRegisteredResult };
updateKeylessNotice();

/* ---------- パック連携（2-3〜2-9／2-12／2-14） ----------
   施設コンテキストがある場合、マニフェスト→施設パックの順に読み、
   スポットはハイブリッド判定（pack-loader.js）で表示を決める。
   登録表示はキーに依存しない。取得失敗時はキャッシュで継続する。 */
let currentPack = null;
let currentSpot = null;
/* ---------- プレビュー（4-3、確認フロー C-14） ----------
   事業者の公開前確認だけの例外表示。URLの ?preview=1&ptoken= と、
   マニフェストの施設エントリが保持する preview_token が一致した
   ときだけ previewAuthorized が立ち、draft スポットも登録表示と
   同じ経路で見えるようになる（判定は pack-loader の
   decidePreviewDisplay）。トークンは秘匿ではなく、通常来訪者と
   事業者確認を分ける目印である。一致しない場合は従来どおり
   draft は存在しない扱いになる。 */
let previewAuthorized = false;
function applyPreviewAuth(entry) {
  const P = window.CultureLensPacks;
  previewAuthorized = !!(P && P.isPreviewRequest && P.isPreviewRequest(facilityContext, entry));
  return previewAuthorized;
}
function updatePreviewBadge(show) {
  const b = $('preview-badge');
  if (!b) return;
  b.textContent = show ? tr('badge_preview') : '';
  b.classList.toggle('hidden', !show);
}

/* ---------- 計測送信（3-3、D-18） ----------
   表示が確定した経路から metrics.js の整形＋送信を呼ぶ。送信先は
   metrics.js の定数で固定。施設が特定できない通常起動では送らない
   （設計 §1）。プレビュー確認中（事業者の作業）とデモ比較モード中
   （5-4）は、通常の来訪者表示として数えないため sender 側で抑制する。
   送信の失敗は metrics.js 側で握りつぶされ、表示には影響しない。 */
const Metrics = window.CultureLensMetrics || null;
const metricsSender = Metrics ? Metrics.createSender({ isSuppressed: metricsSuppressed }) : null;
let lastSpotRoute = 'direct';
function metricsSuppressed() {
  if (previewAuthorized) return true;
  const DCm = window.CultureLensDemoCompare;
  const mode = window.CultureLensViewMode ? window.CultureLensViewMode.current() : 'normal';
  return !!(DCm && DCm.isComparisonMode(mode));
}
// 計測の共通部。施設IDは「表示に使ったパック → 施設コンテキスト」の順で引く。
// どちらからも特定できなければ null（＝その表示は計測対象にしない）。
function metricsBase(spot) {
  const facilityId = (currentPack && currentPack.facility_id)
    || (facilityContext && facilityContext.facilityId) || null;
  if (!facilityId) return null;
  return {
    facilityId: facilityId,
    spotCode: spot ? (spot.qr_code || (spot.identifiers && spot.identifiers.qr) || null)
      : (facilityContext && facilityContext.spotCode) || null,
    spotId: spot ? (spot.spot_id || null) : null,
    lang: resultLang,
    entry: facilityContext ? facilityContext.source : 'spot',
    ctx: facilityContext ? facilityContext.ctx : null,
    packVersion: currentPack && typeof currentPack.pack_version === 'number' ? currentPack.pack_version : null,
  };
}
function trackFacilityView() {
  if (!Metrics || !metricsSender) return;
  const base = metricsBase(null);
  if (base) metricsSender.sendEvent(Metrics.buildFacilityView(base));
}
function trackSpotView(spot, decision, route) {
  if (!Metrics || !metricsSender) return;
  const base = metricsBase(spot);
  if (base) metricsSender.sendEvent(Metrics.buildSpotView({ ...base, decision: decision, route: route }));
}
function trackAiGenerate(result) {
  if (!Metrics || !metricsSender) return;
  const base = metricsBase(currentSpot);
  if (base) metricsSender.sendEvent(Metrics.buildAiGenerate({ ...base, resultSource: result && result.source }));
}
function trackAiFailure(kind) {
  if (!Metrics || !metricsSender) return;
  const base = metricsBase(currentSpot);
  if (base) metricsSender.sendEvent(Metrics.buildAiFailure({ ...base, failureKind: kind }));
}
// アレルゲン名称の4言語表記は i18n.js の ALLERGENS に集約（2-11）
function hideSpotGuidance() { $('spot-guidance').classList.add('hidden'); }
function showSpotGuidance(title, text) {
  $('guidance-title').textContent = title;
  $('guidance-text').textContent = text;
  $('spot-guidance').classList.remove('hidden');
}
function renderPractical(spot) {
  const box = $('practical-box');
  const body = $('practical-body');
  const pr = (spot && spot.practical) || null;
  if (!pr) { box.classList.add('hidden'); return; }
  $('practical-title').textContent = '📌 ' + tr('practical_title');
  const lines = [];
  if (pr.price && typeof pr.price.amount === 'number') {
    let line = tr('price_label') + ': ¥' + pr.price.amount.toLocaleString('ja-JP') + (pr.price.tax_included ? tr('tax_included') : '');
    const notePick = I18n ? I18n.pickContent(pr.price.note, resultLang, null) : null;
    if (notePick) line += '　' + notePick.block;
    lines.push(line);
  }
  if (Array.isArray(pr.allergens) && pr.allergens.length) {
    const names = pr.allergens.map((code) => (I18n ? I18n.allergenLabel(code, resultLang) : code));
    lines.push(tr('allergens_label') + ': ' + names.join(', '));
  }
  if (pr.dietary) {
    const d = [];
    if (pr.dietary.vegetarian) d.push(tr('dietary_vegetarian'));
    if (pr.dietary.vegan) d.push(tr('dietary_vegan'));
    if (pr.dietary.halal && pr.dietary.halal !== 'not_available') d.push(tr('dietary_halal') + ': ' + pr.dietary.halal);
    if (d.length) lines.push(tr('dietary_label') + ': ' + d.join(', '));
  }
  const portionPick = I18n ? I18n.pickContent(pr.portion_note, resultLang, null) : null;
  if (portionPick) lines.push(portionPick.block);
  const confirmed = pr.last_confirmed_at || (spot.supervision && spot.supervision.last_confirmed_at);
  if (confirmed) lines.push(tr('last_confirmed_label') + ': ' + confirmed);
  if (!lines.length) { box.classList.add('hidden'); return; }
  body.innerHTML = lines.map((t) => '<p>' + escapeHtml(t) + '</p>').join('');
  box.classList.remove('hidden');
}
function displaySpot(spot, pack, route) {
  currentSpot = spot;
  if (route) lastSpotRoute = route;
  hideAiFailureGuidance(); // スポットが替わったら、前のAI失敗案内は引き継がない
  const P = window.CultureLensPacks;
  const defLang = (I18n && pack && pack.facility && I18n.normalizeLang(pack.facility.default_lang)) || 'en';
  const d = (previewAuthorized && P.decidePreviewDisplay)
    ? P.decidePreviewDisplay({ spot: spot, lang: resultLang, defaultLang: defLang })
    : P.decideDisplay({ spot: spot, lang: resultLang, defaultLang: defLang });
  hideSpotGuidance();
  $('practical-box').classList.add('hidden');
  updatePreviewBadge(d.kind === 'preview');
  if (d.kind === 'preview') {
    renderRegisteredResult(P.contentToResult(d.content, spot));
    renderPractical(spot);
    $('status-chip').textContent = tr('status_preview');
  } else if (d.kind === 'registered' || d.kind === 'registered-fallback-lang') {
    renderRegisteredResult(P.contentToResult(d.content, spot));
    renderPractical(spot);
    $('status-chip').textContent = tr(d.kind === 'registered-fallback-lang' ? 'status_fallback_lang' : 'status_registered');
  } else if (d.kind === 'guidance') {
    if (d.status === 'retired') showSpotGuidance(tr('guidance_retired_title'), tr('guidance_retired_text'));
    else showSpotGuidance(tr('guidance_suspended_title'), tr('guidance_suspended_text'));
    $('status-chip').textContent = tr('status_guidance');
  } else if (d.kind === 'not-found') {
    showSpotGuidance(tr('guidance_not_found_title'), tr('guidance_not_published_text'));
    $('status-chip').textContent = tr('status_not_published');
  } else {
    $('status-chip').textContent = tr('status_not_registered_ai_hint');
  }
  // 計測（3-3）: 表示が確定したので spot_view を送る。プレビュー表示は
  // buildSpotView が対象外（null）にし、比較モード中は sender が抑制する。
  // 言語切替での再表示も、その都度「見られた」事実として数える（設計 §2）
  trackSpotView(spot, d, lastSpotRoute);
  updateReportButton();
}
function showFacilityPanel(pack, opts) {
  if (!pack) return;
  const name = (pack.facility && pack.facility.name) || {};
  const namePick = I18n ? I18n.pickContent(name, resultLang, (pack.facility && pack.facility.default_lang) || null) : null;
  $('facility-name').textContent = (namePick && namePick.block) || pick(name.en, name.ja) || pack.facility_id;
  const box = $('facility-spots');
  box.innerHTML = '';
  (pack.spots || []).filter((sp) => sp.status === 'published' || (previewAuthorized && sp.status === 'draft')).forEach((sp) => {
    const btn = document.createElement('button');
    const c = sp.content || {};
    const blockPick = I18n ? I18n.pickContent(c, resultLang, (pack.facility && pack.facility.default_lang) || null) : null;
    btn.textContent = ((blockPick && blockPick.block && blockPick.block.title) || sp.spot_id)
      + (sp.status === 'draft' ? ' ' + tr('preview_panel_draft') : '');
    btn.addEventListener('click', () => displaySpot(sp, pack, 'facility-list'));
    box.appendChild(btn);
  });
  $('facility-panel').classList.remove('hidden');
  // 計測（3-3）: facility_view はパック読み込み直後の初回表示だけを数える。
  // 言語切替での出し直し（setResultLang 経由）では数えない
  if (opts && opts.countView) trackFacilityView();
}
// 施設エントリを開く共通経路（URL入口 /f/・?f= と、QR検出での施設表示で共用）。
// プレビュー認可→パック取得→施設パネル表示までを行い、表示したことを
// ステータスチップ（status_facility_mode）で知らせる。
async function openFacilityEntry(P, entry) {
  applyPreviewAuth(entry);
  const loaded = await P.loadFacilityPack({ entry: entry });
  currentPack = loaded.pack;
  showFacilityPanel(currentPack, { countView: true });
  $('status-chip').textContent = tr('status_facility_mode');
}
async function initPackContext() {
  if (!facilityContext || !window.CultureLensPacks) return;
  const P = window.CultureLensPacks;
  try {
    const m = await P.loadManifest({});
    if (facilityContext.source === 'spot') {
      const entry = P.findFacilityForSpot(m.manifest, facilityContext.spotCode);
      if (!entry) { showSpotGuidance(tr('guidance_not_found_title'), tr('guidance_spot_unregistered_text')); return; }
      applyPreviewAuth(entry);
      const loaded = await P.loadFacilityPack({ entry: entry });
      currentPack = loaded.pack;
      showFacilityPanel(currentPack, { countView: true });
      displaySpot(P.resolveSpot(currentPack, facilityContext.spotCode), currentPack, 'direct');
    } else if (facilityContext.source === 'facility') {
      const entry = P.findFacilityEntry(m.manifest, facilityContext.facilityId);
      if (!entry) { showSpotGuidance(tr('guidance_facility_not_found_title'), tr('guidance_facility_unregistered_text')); return; }
      await openFacilityEntry(P, entry);
    }
  } catch (e) {
    $('status-chip').textContent = tr('status_pack_load_failed');
  }
}

/* ---------- QR検出（B2B: A-3） ----------
   カメラ起動中だけ、300ms間隔でフレームをQR検出にかける。検出方式の
   選択（BarcodeDetector優先／同梱jsQR代替／不可なら無効化）は
   qr-scanner.js が担う。トラッキング（100ms間隔のNCC）とは別タイマーで、
   検出が終わるまで次を重ねない。BarcodeDetector では映像をそのまま渡し、
   jsQR では最大640px幅に縮小した ImageData だけを作る（負荷抑制）。
   読めたコードは initPackContext と同じ経路（マニフェスト→施設特定→
   パック取得→displaySpot）で即表示する。施設入口QR（/f/{facility_id}）は
   openFacilityEntry（URL入口と共用の経路）で施設パネルを開く
   （BUG-20261126-02: 従来はスポットコードしか処理せず、施設QRを
   デコードしても捨てていた）。同じコード・同じ施設はセッション内で
   一度だけ表示し、連続検出で再表示を繰り返さない。QRが使えない環境でも
   従来フロー（カメラ認識・一覧選択）はそのまま動く。 */
const QR_SCAN_INTERVAL = 300;
const qrScanner = window.CultureLensQr ? window.CultureLensQr.createScanner() : null;
let qrTimer = null;
let qrScanBusy = false;
let qrKind = null;
const qrShownCodes = new Set();
const qrShownFacilityIds = new Set();
const qrCanvas = document.createElement('canvas');
const qrCtx = qrCanvas.getContext('2d', { willReadFrequently: true });

function qrFrame() {
  if (qrKind === 'jsqr') {
    const scale = Math.min(1, 640 / (video.videoWidth || 640));
    const w = Math.max(1, Math.round((video.videoWidth || 640) * scale));
    const h = Math.max(1, Math.round((video.videoHeight || 480) * scale));
    if (qrCanvas.width !== w || qrCanvas.height !== h) { qrCanvas.width = w; qrCanvas.height = h; }
    qrCtx.drawImage(video, 0, 0, w, h);
    return { imageData: qrCtx.getImageData(0, 0, w, h) };
  }
  return video;
}

async function showSpotByQrCode(code) {
  const P = window.CultureLensPacks;
  if (!P) return;
  $('status-chip').textContent = tr('status_qr_reading');
  try {
    const m = await P.loadManifest({});
    const entry = P.findFacilityForSpot(m.manifest, code);
    if (!entry) {
      showSpotGuidance(tr('guidance_not_found_title'), tr('guidance_spot_unregistered_text'));
      $('status-chip').textContent = tr('status_not_registered_spot');
      return;
    }
    applyPreviewAuth(entry);
    const loaded = await P.loadFacilityPack({ entry: entry });
    currentPack = loaded.pack;
    showFacilityPanel(currentPack, { countView: true });
    displaySpot(P.resolveSpot(currentPack, code), currentPack, 'qr-scan');
  } catch (e) {
    $('status-chip').textContent = tr('status_qr_load_failed');
  }
}

async function showFacilityByQrId(facilityId) {
  const P = window.CultureLensPacks;
  if (!P) return;
  $('status-chip').textContent = tr('status_qr_reading');
  try {
    const m = await P.loadManifest({});
    const entry = P.findFacilityEntry(m.manifest, facilityId);
    if (!entry) {
      showSpotGuidance(tr('guidance_facility_not_found_title'), tr('guidance_facility_unregistered_text'));
      $('status-chip').textContent = tr('status_qr_load_failed');
      return;
    }
    // URL入口（initPackContext の施設分岐）と同じ解決経路で開く
    await openFacilityEntry(P, entry);
  } catch (e) {
    $('status-chip').textContent = tr('status_qr_load_failed');
  }
}

async function qrTick() {
  if (!stream || photoMode || qrScanBusy || video.readyState < 2) return;
  qrScanBusy = true;
  try {
    // qr-scanner.js が古い版（detectTarget 無し）でもスポット検出は従来どおり動かす
    const found = qrScanner.detectTarget
      ? await qrScanner.detectTarget(qrFrame())
      : await qrScanner.detectSpotCode(qrFrame());
    if (found && found.type === 'facility') {
      if (!qrShownFacilityIds.has(found.facilityId)) {
        qrShownFacilityIds.add(found.facilityId);
        showFacilityByQrId(found.facilityId);
      }
    } else if (found && found.code && !qrShownCodes.has(found.code)) {
      qrShownCodes.add(found.code);
      showSpotByQrCode(found.code);
    }
  } catch (e) { /* 検出の失敗は従来フローを妨げない */ }
  qrScanBusy = false;
}

function startQrScan() {
  if (!qrScanner || qrTimer) return;
  qrScanner.selectDetector().then((sel) => {
    qrKind = sel.kind;
    if (!sel.available || !stream || qrTimer) return;
    qrTimer = setInterval(qrTick, QR_SCAN_INTERVAL);
  }).catch(() => { /* QRが使えなくても従来フローは継続する */ });
}
function stopQrScan() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  qrScanBusy = false;
}

/* ---------- 表示言語（2-11：チップ＋メニューで4言語切替） ----------
   結果は言語別の形を保持し、表示だけを切り替える。言語状態はアプリ
   全体で1つ（localStorage に保存）。resultLang の宣言は前段にある
   （初期表示から参照するため）。対応言語は en/zh/ko/ja。
   AI生成結果は en/ja では二言語JSON、zh/ko では主フィールドに当該
   言語が入るため、pick() は「ja のとき _ja 側、それ以外は主側」で
   4言語すべて正しく選べる。 */
let lastResult = null;
const pick = (en, ja) => (resultLang === 'ja' ? (ja || en || '') : (en || ''));
const tagTitle = (tag) => pick(tag.title, tag.title_ja);
const tagDesc = (tag) => pick(tag.description, tag.description_ja);
const tagWhy = (tag) => pick(tag.why_it_matters, tag.why_it_matters_ja);

function updateLangChip() {
  const short = (I18n && I18n.LANG_SHORT[resultLang]) || resultLang;
  $('btn-lang').innerHTML = '<b>' + short + '</b> ▾';
  document.querySelectorAll('#lang-menu button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === resultLang);
  });
}
function hideLangMenu() { $('lang-menu').classList.add('hidden'); }
function setResultLang(lang) {
  hideLangMenu();
  const next = I18n ? I18n.normalizeLang(lang) : null;
  if (!next || next === resultLang) { updateLangChip(); return; }
  const failureKind = lastAiFailureKind; // displaySpot が案内を消す前に保持する
  resultLang = next;
  // ?lang= のセッション上書きが効いている間は、恒久設定（localStorage）を書き換えない
  if (!sessionLang) localStorage.setItem('etw_result_lang', resultLang);
  updateLangChip();
  if (currentSpot && currentPack) { displaySpot(currentSpot, currentPack); showFacilityPanel(currentPack); }
  else if (lastResult) { renderTexts(); refreshTagLabels(); }
  // キーレス案内と出典バッジも、表示中のものは新しい言語で出し直す
  updateKeylessNotice();
  if (lastResult) updateSourceBadge(lastResult);
  // 比較ビューのボタン文面と、開いている間の内容も新しい表示言語で出し直す
  updateDemoCompareButton();
  if (lastResult && !$('demo-compare').classList.contains('hidden')) renderDemoCompare();
  // AI失敗案内が出ている間は、文面も新しい表示言語で出し直す
  if (failureKind) showAiFailureGuidance(failureKind);
  // 誤り報告の導線と文面も、新しい表示言語で出し直す
  renderReportTexts();
  updateReportButton();
}
$('btn-lang').onclick = () => { $('lang-menu').classList.toggle('hidden'); };
document.querySelectorAll('#lang-menu button').forEach((b) => {
  b.addEventListener('click', () => setResultLang(b.dataset.lang));
});
updateLangChip();

// 空間タグのラベルだけを現在の言語で描き直す（配置とトラッキングは維持する）
function refreshTagLabels() {
  for (const p of placedTags) {
    const tex = makeLabelTexture(tagTitle(p.tag), p.idx);
    if (p.label.material.map) p.label.material.map.dispose();
    p.label.material.map = tex;
    p.label.material.needsUpdate = true;
  }
}

// 字幕・タグカード・ギャップ欄を、現在の言語で描き直す
function renderTexts() {
  const r = lastResult;
  if (!r) return;
  $('subtitle-original').textContent = pick(r.literal_translation, r.literal_translation_ja);
  $('subtitle-extended').textContent = pick(r.extended_translation, r.extended_translation_ja);
  const cards = $('tag-cards');
  cards.innerHTML = '';
  $('tags-empty').style.display = r.tags?.length ? 'none' : '';
  (r.tags || []).forEach((tag, i) => {
    const div = document.createElement('div');
    div.className = 'tag-card';
    div.innerHTML = `<h4>${i + 1}. ${escapeHtml(tagTitle(tag))}</h4><p>${escapeHtml(tagDesc(tag))}</p><p class="why">なぜ大切か: ${escapeHtml(tagWhy(tag) || '')}</p>`;
    cards.appendChild(div);
  });
  if (r.cultural_gap || r.curiosity_hook) {
    $('gap-box').classList.remove('hidden');
    $('gap-text').textContent = pick(r.cultural_gap, r.cultural_gap_ja);
    $('hook-text').textContent = pick(r.curiosity_hook, r.curiosity_hook_ja);
  }
}

function updateSourceBadge(r) {
  const b = $('source-badge');
  if (!b) return;
  let text = '';
  if (r && r.source === 'registered') text = tr(r.supervised ? 'badge_supervised' : 'badge_registered');
  else if (r && typeof r.source === 'string' && r.source.indexOf('gemini') === 0) text = tr('badge_ai');
  else if (r && (r.source === 'mock' || r.source === 'demo')) text = tr('badge_demo');
  b.textContent = text;
  b.classList.toggle('hidden', !text);
}

function renderResult(r) {
  hasResult = true;
  lastResult = r;
  // 実務情報（価格・アレルギー等）は登録スポットの構造化データ専用。
  // AI生成・モック等の結果では、前に表示していた登録スポットの実務情報が
  // 残って「AIの内容に付いた情報」と誤読されないよう、ここで隠す。
  // 登録表示（source='registered'）はこの後 displaySpot が renderPractical で
  // 出し直すため、登録フローには影響しない（BUG-20261126-01）。
  if (!r || r.source !== 'registered') $('practical-box').classList.add('hidden');
  updateSourceBadge(r);
  renderTexts();
  const speakText = pick(r.extended_translation, r.extended_translation_ja);
  if ($('chk-speak').checked && speakText) {
    const u = new SpeechSynthesisUtterance(speakText);
    u.lang = (I18n && I18n.SPEECH_LOCALES[resultLang]) || 'en-US'; u.rate = 0.98;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  placeTags(r.tags || []);
  applyResultVisibility();
  $('btn-compare').disabled = false;
  $('btn-demo-compare').disabled = false;
  updateReportButton();
}

/* ---------- 見比べシート（案D：EN・日本語の対照表示） ---------- */
function compareRow(label, en, ja) {
  if (!en && !ja) return '';
  return `<div class="cmp-row"><h4>${escapeHtml(label)}</h4><p class="cmp-en"><span class="cmp-tag">EN</span>${escapeHtml(en || '')}</p><p class="cmp-ja"><span class="cmp-tag">日本語</span>${escapeHtml(ja || '')}</p></div>`;
}
function openCompare() {
  const r = lastResult;
  if (!r) return;
  let html = '';
  html += compareRow('直訳', r.literal_translation, r.literal_translation_ja);
  html += compareRow('拡張翻訳', r.extended_translation, r.extended_translation_ja);
  (r.tags || []).forEach((tag, i) => {
    html += compareRow(`タグ ${i + 1}`,
      [tag.title, tag.description, tag.why_it_matters].filter(Boolean).join('\n'),
      [tag.title_ja, tag.description_ja, tag.why_it_matters_ja].filter(Boolean).join('\n'));
  });
  html += compareRow('🧳 異なる文化とのギャップ', r.cultural_gap, r.cultural_gap_ja);
  html += compareRow('🗺️ もっと知りたくなる好奇心フック', r.curiosity_hook, r.curiosity_hook_ja);
  $('compare-body').innerHTML = html || '<p class="muted">まだ結果がありません。</p>';
  $('compare').classList.remove('hidden');
}
$('btn-compare').addEventListener('click', openCompare);
$('btn-close-compare').addEventListener('click', () => $('compare').classList.add('hidden'));

/* ---------- 比較ビュー（5-4、デモ用：直訳だけ vs 拡張翻訳） ----------
   営業デモの冒頭「直訳だけでは伝わらない」を再現する専用表示。
   明示操作（ボタン）でのみ開き、閉じれば通常表示に戻る。整形は
   demo-compare.js の純粋関数が担う。表示モードは viewMode で持ち、
   比較モード中は isComparisonMode(viewMode) で判定できる（将来の
   計測送信 3-3 は、この間は通常来訪者の計測に混ぜないために使う）。 */
const DC = window.CultureLensDemoCompare;
let viewMode = DC ? DC.VIEW_MODE_NORMAL : 'normal';
window.CultureLensViewMode = { current: () => viewMode };
function demoComparePractical() {
  // 実務情報はスポット側の構造化データ。登録表示のときだけ、そのスポットのものを渡す
  if (lastResult && lastResult.source === 'registered' && currentSpot) return currentSpot.practical || null;
  return null;
}
function demoPickText(block) {
  if (!block) return null;
  const p = I18n ? I18n.pickContent(block, resultLang, null) : null;
  return p ? p.block : null;
}
function demoPracticalLines(summary) {
  if (!summary) return '';
  const lines = [];
  if (summary.price) {
    let line = tr('price_label') + ': ¥' + summary.price.amount.toLocaleString('ja-JP') + (summary.price.tax_included ? tr('tax_included') : '');
    if (summary.price.note) line += '　' + summary.price.note;
    lines.push(line);
  }
  if (summary.allergens && summary.allergens.length) {
    const names = summary.allergens.map((code) => (I18n ? I18n.allergenLabel(code, resultLang) : code));
    lines.push(tr('allergens_label') + ': ' + names.join(', '));
  }
  if (summary.dietary) {
    const d = [];
    if (summary.dietary.vegetarian) d.push(tr('dietary_vegetarian'));
    if (summary.dietary.vegan) d.push(tr('dietary_vegan'));
    if (summary.dietary.halal && summary.dietary.halal !== 'not_available') d.push(tr('dietary_halal') + ': ' + summary.dietary.halal);
    if (d.length) lines.push(tr('dietary_label') + ': ' + d.join(', '));
  }
  if (summary.portion_note) lines.push(summary.portion_note);
  if (summary.last_confirmed_at) lines.push(tr('last_confirmed_label') + ': ' + summary.last_confirmed_at);
  if (!lines.length) return '';
  return `<div class="demo-cmp-section"><h5>📌 ${escapeHtml(tr('practical_title'))}</h5>` +
    lines.map((t) => `<p>${escapeHtml(t)}</p>`).join('') + '</div>';
}
function renderDemoCompare() {
  if (!DC || !lastResult) return;
  const cmp = DC.buildComparison(lastResult, { lang: resultLang, practical: demoComparePractical(), pickText: demoPickText });
  if (!cmp) return;
  $('demo-compare-banner').textContent = tr('demo_compare_banner');
  $('demo-compare-title').textContent = tr('demo_compare_title');
  $('btn-close-demo-compare').textContent = tr('demo_compare_close');
  const lit = cmp.literal;
  const ext = cmp.extended;
  let extHtml = '';
  if (ext.title) extHtml += `<h4>${escapeHtml(ext.title)}</h4>`;
  if (ext.literal_translation) extHtml += `<p>${escapeHtml(ext.literal_translation)}</p>`;
  if (ext.extended_translation) extHtml += `<p>${escapeHtml(ext.extended_translation)}</p>`;
  if (ext.scene_summary) extHtml += `<div class="demo-cmp-section"><h5>${escapeHtml(tr('demo_compare_scene'))}</h5><p>${escapeHtml(ext.scene_summary)}</p></div>`;
  if (ext.tags && ext.tags.length) {
    extHtml += `<div class="demo-cmp-section"><h5>${escapeHtml(tr('demo_compare_tags'))}</h5>` + ext.tags.map((tag) =>
      `<div class="demo-cmp-tag"><p><b>${escapeHtml(tag.title)}</b></p><p>${escapeHtml(tag.description)}</p>` +
      (tag.why_it_matters ? `<p class="demo-cmp-why">${escapeHtml(tr('demo_compare_why'))}: ${escapeHtml(tag.why_it_matters)}</p>` : '') + '</div>').join('') + '</div>';
  }
  if (ext.cultural_gap) extHtml += `<div class="demo-cmp-section"><h5>${escapeHtml(tr('demo_compare_gap'))}</h5><p>${escapeHtml(ext.cultural_gap)}</p></div>`;
  if (ext.curiosity_hook) extHtml += `<div class="demo-cmp-section"><h5>${escapeHtml(tr('demo_compare_hook'))}</h5><p>${escapeHtml(ext.curiosity_hook)}</p></div>`;
  extHtml += demoPracticalLines(ext.practical);
  $('demo-compare-body').innerHTML =
    '<div class="demo-cmp-cols">' +
    `<div class="demo-cmp-col demo-cmp-literal"><h3>${escapeHtml(tr('demo_compare_literal'))}</h3>` +
    (lit.title ? `<h4>${escapeHtml(lit.title)}</h4>` : '') +
    (lit.literal_translation ? `<p>${escapeHtml(lit.literal_translation)}</p>` : '') +
    '</div>' +
    `<div class="demo-cmp-col"><h3>${escapeHtml(tr('demo_compare_extended'))}</h3>${extHtml}</div>` +
    '</div>';
}
function openDemoCompare() {
  if (!lastResult || !DC) return;
  viewMode = DC.VIEW_MODE_DEMO_COMPARE;
  renderDemoCompare();
  $('demo-compare').classList.remove('hidden');
}
function closeDemoCompare() {
  viewMode = DC ? DC.VIEW_MODE_NORMAL : 'normal';
  $('demo-compare').classList.add('hidden');
}
function updateDemoCompareButton() { $('btn-demo-compare').textContent = tr('demo_compare_open'); }
$('btn-demo-compare').addEventListener('click', openDemoCompare);
$('btn-close-demo-compare').addEventListener('click', closeDemoCompare);
updateDemoCompareButton();

/* ---------- 誤り報告（2-15、F-31） ----------
   表示内容の誤りに気づいた来訪者・事業者が、対象スポットと種別を
   選んで制作側へ送れる導線。導線はスポットか結果が表示されている
   ときだけ出し、通常の閲覧の邪魔にならない位置（結果パネル下部）に
   置く。送信は受け口の POST /report（beacon ではなく結果が返る
   fetch）で、成否をその場で伝える。自由文は任意・500字までで、
   個人情報を書かない注意書きを添える（設計 §5-4）。文面は i18n.js
   の report_* キー（4言語）。報告先は metrics.js の定数で固定。 */
function reportTargetDefault() {
  if (lastResult && lastResult.source === 'registered') return 'registered';
  if (lastResult && typeof lastResult.source === 'string' && lastResult.source) return 'ai';
  return 'other';
}
function updateReportButton() {
  const b = $('btn-report');
  if (!b) return;
  b.textContent = tr('report_open');
  b.classList.toggle('hidden', !(currentSpot || lastResult));
}
function setOptionTexts(selectId, values) {
  const sel = $(selectId);
  if (!sel) return;
  for (const opt of sel.options) {
    if (values[opt.value]) opt.textContent = values[opt.value];
  }
}
function renderReportTexts() {
  if (!$('report')) return;
  $('report-title').textContent = tr('report_title');
  $('report-intro').textContent = tr('report_intro');
  $('report-reporter-label').textContent = tr('report_reporter_label');
  $('report-target-label').textContent = tr('report_target_label');
  $('report-category-label').textContent = tr('report_category_label');
  $('report-text-label').textContent = tr('report_text_label');
  $('report-text').placeholder = tr('report_text_placeholder');
  $('report-privacy').textContent = tr('report_privacy_note');
  $('btn-report-send').textContent = tr('report_send');
  $('btn-report-close').textContent = tr('report_close');
  setOptionTexts('report-reporter', { visitor: tr('report_reporter_visitor'), business: tr('report_reporter_business') });
  setOptionTexts('report-target', {
    registered: tr('report_target_registered'), ai: tr('report_target_ai'),
    practical: tr('report_target_practical'), other: tr('report_target_other'),
  });
  setOptionTexts('report-category', {
    price: tr('report_category_price'), allergen: tr('report_category_allergen'),
    hours: tr('report_category_hours'), translation: tr('report_category_translation'),
    content: tr('report_category_content'), other: tr('report_category_other'),
  });
}
function openReport() {
  renderReportTexts();
  $('report-target').value = reportTargetDefault();
  const st = $('report-status');
  st.classList.add('hidden');
  st.classList.remove('ok', 'ng');
  $('report').classList.remove('hidden');
}
function closeReport() { $('report').classList.add('hidden'); }
async function submitReport() {
  const st = $('report-status');
  const sendBtn = $('btn-report-send');
  st.classList.remove('hidden', 'ok', 'ng');
  if (!Metrics || !metricsSender) {
    st.textContent = tr('report_failed');
    st.classList.add('ng');
    return;
  }
  const payload = Metrics.buildReport({
    facilityId: (currentPack && currentPack.facility_id) || (facilityContext && facilityContext.facilityId) || null,
    spotCode: currentSpot ? (currentSpot.qr_code || (currentSpot.identifiers && currentSpot.identifiers.qr) || null)
      : (facilityContext && facilityContext.spotCode) || null,
    spotId: currentSpot ? (currentSpot.spot_id || null) : null,
    target: $('report-target').value,
    category: $('report-category').value,
    reporter: $('report-reporter').value,
    lang: resultLang,
    freeText: $('report-text').value,
    contentVersion: currentSpot && currentSpot.supervision ? currentSpot.supervision.content_version : null,
  });
  sendBtn.disabled = true;
  st.textContent = tr('report_sending');
  const res = await metricsSender.sendReport(payload);
  sendBtn.disabled = false;
  if (res.ok) {
    st.textContent = tr('report_sent');
    st.classList.add('ok');
    $('report-text').value = '';
  } else {
    st.textContent = tr('report_failed');
    st.classList.add('ng');
  }
}
$('btn-report').addEventListener('click', openReport);
$('btn-report-close').addEventListener('click', closeReport);
$('btn-report-send').addEventListener('click', submitReport);
renderReportTexts();
updateReportButton();

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* ---------- 設定・初期化 ---------- */
$('btn-settings').addEventListener('click', () => { $('api-key').value = getApiKey(); $('settings').classList.remove('hidden'); });
$('btn-close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
$('btn-save-key').addEventListener('click', () => { setApiKey($('api-key').value.trim()); $('settings').classList.add('hidden'); updateKeylessNotice(); });
$('chk-demo').addEventListener('change', updateKeylessNotice);
$('btn-camera').addEventListener('click', toggleCamera);
updateCameraButton();
$('btn-record').addEventListener('click', toggleRecord);
$('btn-translate').addEventListener('click', runTranslate);
$('btn-shutter').addEventListener('click', takePhoto);
$('btn-pick').addEventListener('click', () => $('file-photo').click());
$('file-photo').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadPhotoFile(f);
  e.target.value = '';
});
$('btn-photo-translate').addEventListener('click', runTranslate);
$('btn-photo-retake').addEventListener('click', exitPhoto);
$('btn-photo-save').addEventListener('click', () => {
  if (!currentPhoto) return;
  // 表示中の写真（カメラ映像のフレームのみ）を端末へ保存する。CultureLens は
  // 通常セッション内メモリにしか写真を持たないため、保存はこの明示操作のときだけ。
  const a = document.createElement('a');
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = currentPhoto.dataUrl;
  a.download = `culturelens-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  $('status-chip').textContent = '写真を端末に保存しました';
});
initPackContext();
