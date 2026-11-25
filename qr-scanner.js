/**
 * qr-scanner.js ― QR検出（A-3）の抽象モジュール
 *
 * CultureLens B2B：カメラ映像からスポットQRを検出し、検出テキストから
 * スポットコードを取り出す。表示側（main.js）は検出方式の違いを知らず、
 * 「フレームを渡すとスポットコードが返る」形で使える。
 *
 * 検出方式の選定（この順で使えるものを選ぶ）:
 * 1. BarcodeDetector（ブラウザ標準。Android Chrome 等で利用でき、
 *    ネイティブ実装のため軽く、追加の読み込みが不要）
 * 2. jsQR（同梱版 vendor/jsQR.js、Apache-2.0。BarcodeDetector が無い
 *    iOS Safari 等向けの代替。CDN には依存しない）
 * 3. どちらも無い環境では kind: 'none' を返し、QR検出だけを無効化する
 *    （カメラ認識・スポット一覧などの従来フローは影響を受けない）
 *
 * スポットコードは仕様（culturelens-b2b-url-pack-spec §1.3）に合わせ、
 * 誤読しやすい文字（0/1/I/L/O/U）を除いた大文字英数字6文字とする。
 * 受け付ける検出テキスト:
 * - https://culturelens.jp/s/{code}（パス形式。github.io の接頭辞付きも可）
 * - https://culturelens.jp/?s={code}（クエリ形式）
 * - {code}（裸のコード）
 * それ以外（施設/ツアー入口、別形式、不正なコード）は null を返す。
 *
 * ブラウザでは window.CultureLensQr として公開し、Node では
 * module.exports する（facility-context.js と同じ形）。
 */
(function (global) {
  'use strict';

  var SPOT_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

  function normalizeSpotCode(value) {
    if (typeof value !== 'string') return null;
    var code = value.trim().toUpperCase();
    return SPOT_CODE_PATTERN.test(code) ? code : null;
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  /**
   * QRの検出テキストからスポットコードを取り出す純粋関数。
   * 取れなければ null（呼び出し側は「QRは読めたがスポットではない」として
   * 静かに無視できる）。
   */
  function extractSpotCode(text) {
    if (typeof text !== 'string') return null;
    var value = text.trim();
    if (!value) return null;

    var bare = normalizeSpotCode(value);
    if (bare) return bare;

    // スキーム無しの公式ドメイン表記もURLとして扱う
    if (/^(culturelens\.jp|joe-wolf-woof\.github\.io)\//i.test(value)) {
      value = 'https://' + value;
    }
    var looksLikeUrl = /^https?:\/\//i.test(value) || value.charAt(0) === '/' || value.charAt(0) === '?';
    if (!looksLikeUrl) return null;

    var url;
    try {
      url = new URL(value, 'https://culturelens.jp/');
    } catch (e) {
      return null;
    }

    // パス形式 /s/{code}（配信形態の接頭辞が付いていても拾う）
    var segs = url.pathname.split('/').filter(function (s) { return s !== ''; }).map(safeDecode);
    for (var i = 0; i + 1 < segs.length; i++) {
      if (segs[i] === 's') return normalizeSpotCode(segs[i + 1]);
    }
    // クエリ形式 ?s={code}
    if (url.searchParams && url.searchParams.get('s')) {
      return normalizeSpotCode(url.searchParams.get('s'));
    }
    return null;
  }

  function barcodeDetectorCtor(env, explicit) {
    if (typeof explicit === 'function') return explicit;
    if (env && typeof env.BarcodeDetector === 'function') return env.BarcodeDetector;
    return null;
  }

  function jsQRFunction(env, explicit) {
    if (typeof explicit === 'function') return explicit;
    if (env && typeof env.jsQR === 'function') return env.jsQR;
    if (typeof global.jsQR === 'function') return global.jsQR;
    return null;
  }

  /** 同期で分かる範囲の対応状況（選定の事前表示用）。 */
  function getCapabilities(env, options) {
    options = options || {};
    var scope = env || global;
    var hasBarcodeDetector = !!barcodeDetectorCtor(scope, options.BarcodeDetector);
    var hasJsQR = !!jsQRFunction(scope, options.jsQR);
    return {
      barcodeDetector: hasBarcodeDetector,
      jsQR: hasJsQR,
      preferred: hasBarcodeDetector ? 'barcode-detector' : (hasJsQR ? 'jsqr' : 'none'),
      available: hasBarcodeDetector || hasJsQR,
    };
  }

  /**
   * 検出器を作成する。options で差し替え可能（単体確認用）:
   * { env, BarcodeDetector, jsQR }
   * 戻り値: { selectDetector, detect, detectSpotCode, getSelection }
   * - selectDetector(): Promise<{kind:'barcode-detector'|'jsqr'|'none', available:boolean}>
   * - detect(frame): Promise<string|null>（QRの生テキスト）
   *   frame は BarcodeDetector には {source} または映像ソースそのもの、
   *   jsQR には {imageData} または ImageData 相当 {data,width,height} を渡す
   * - detectSpotCode(frame): Promise<{code,text,kind}|null>
   */
  function createScanner(options) {
    options = options || {};
    var env = options.env || global;
    var BarcodeCtor = barcodeDetectorCtor(env, options.BarcodeDetector);
    var jsQRFn = jsQRFunction(env, options.jsQR);
    var selection = null;
    var selectionPromise = null;

    function selectDetector() {
      if (selection) return Promise.resolve(selection);
      if (selectionPromise) return selectionPromise;
      selectionPromise = (async function () {
        if (BarcodeCtor) {
          try {
            if (typeof BarcodeCtor.getSupportedFormats === 'function') {
              var formats = await BarcodeCtor.getSupportedFormats();
              if (Array.isArray(formats) && formats.indexOf('qr_code') === -1) {
                throw new Error('qr_code is not supported');
              }
            }
            var nativeDetector = new BarcodeCtor({ formats: ['qr_code'] });
            selection = { kind: 'barcode-detector', available: true, detector: nativeDetector, jsQR: null };
            return selection;
          } catch (e) {
            // 標準APIが使えない場合は同梱 jsQR に倒す
          }
        }
        if (jsQRFn) {
          selection = { kind: 'jsqr', available: true, detector: null, jsQR: jsQRFn };
          return selection;
        }
        selection = { kind: 'none', available: false, detector: null, jsQR: null };
        return selection;
      })();
      return selectionPromise;
    }

    async function detect(frame) {
      if (!frame) return null;
      var sel = await selectDetector();
      if (sel.kind === 'barcode-detector') {
        try {
          var source = frame.source || frame;
          var results = await sel.detector.detect(source);
          if (!results || !results.length) return null;
          var first = results[0];
          if (typeof first === 'string') return first;
          return first.rawValue || first.raw_text || null;
        } catch (e) {
          return null;
        }
      }
      if (sel.kind === 'jsqr') {
        var imageData = frame.imageData || frame;
        if (!imageData || !imageData.data || !imageData.width || !imageData.height) return null;
        try {
          var result = sel.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
          return result && result.data ? result.data : null;
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    async function detectSpotCode(frame) {
      var text = await detect(frame);
      var code = extractSpotCode(text);
      if (!code) return null;
      return { code: code, text: text, kind: selection ? selection.kind : null };
    }

    return {
      selectDetector: selectDetector,
      detect: detect,
      detectSpotCode: detectSpotCode,
      extractSpotCode: extractSpotCode,
      getSelection: function () { return selection; },
    };
  }

  var api = {
    SPOT_CODE_PATTERN: SPOT_CODE_PATTERN,
    normalizeSpotCode: normalizeSpotCode,
    extractSpotCode: extractSpotCode,
    getCapabilities: getCapabilities,
    createScanner: createScanner,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensQr = api;
})(typeof window !== 'undefined' ? window : globalThis);
