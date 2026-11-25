/**
 * metrics.js ― 計測イベント送信（3-3 / D-18）と誤り報告の送信（2-15 / F-31）
 *
 * CultureLens B2B：表示経路から送る計測イベントと、来訪者・事業者の
 * 誤り報告を、受け口（endpoint/worker.js）の検証仕様に合う形へ整形し、
 * 送信する。設計根拠：culturelens-measurement-events-design-2026-11-26.md
 *
 * 送信方針（設計 §7）：
 * - 1イベント＝1リクエストの JSON POST。送信先は本ファイルの定数で固定し、
 *   施設コンテキストやパックの内容に依存させない（§7-4）
 * - fire-and-forget：結果を待たず、失敗しても表示・操作に一切影響させない。
 *   navigator.sendBeacon を優先し、使えない／失敗したら fetch
 *   （keepalive）に落とす。リトライはしない（欠測は下限値として扱う）
 * - オフライン時は送らない・ためない（キューを持たない。§7-3）
 * - 送るのは設計 §3／§4 のホワイトリスト項目だけ。IP・User-Agent・
 *   端末識別子・位置情報は、そもそも組み立てない（§5）
 * - 施設コンテキストが無い通常起動（個人利用）では計測イベントを
 *   送らない（§1）。例外は誤り報告だけで、facility_id が null でもよい
 *
 * 整形（build*）は純粋関数で、受け口の検証ルール（必須項目・列挙値・
 * 形式・サイズ上限）をそのまま写してある。検証を通らない入力は
 * 「送らない（null）」に倒す。送信（createSender）は環境（beacon /
 * fetch / オンライン状態 / 抑制判定）を注入でき、Node の単体確認では
 * フェイクを差し替える。
 *
 * ブラウザでは window.CultureLensMetrics として公開し、Node では
 * module.exports する（pack-loader.js と同じ形）。
 */
(function (global) {
  'use strict';

  /* ---------- 送信先（固定。設計 §7-4） ---------- */
  var ENDPOINT_BASE = 'https://culturelens-endpoint.joe-wolf-woof.workers.dev';
  var EVENT_URL = ENDPOINT_BASE + '/event';
  var REPORT_URL = ENDPOINT_BASE + '/report';
  var PV = 1;

  /* ---------- 受け口（endpoint/worker.js）の検証ルールの写し ---------- */
  var LANGS = ['en', 'zh', 'ko', 'ja'];
  var ROUTES = ['direct', 'facility-list', 'qr-scan'];
  var ENTRIES = ['facility', 'spot', 'tour', 'link'];
  var FAILURE_KINDS = ['key-required', 'rate-limit', 'timeout', 'server', 'network', 'unknown'];
  var REPORT_TARGETS = ['registered', 'ai', 'practical', 'other'];
  var REPORT_CATEGORIES = ['price', 'allergen', 'hours', 'translation', 'content', 'other'];
  var REPORTERS = ['visitor', 'business'];
  var FACILITY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var SPOT_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
  var SPOT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
  var MAX_EVENT_BYTES = 4096;
  var MAX_REPORT_BYTES = 8192;
  var FREE_TEXT_MAX = 500;

  /* ---------- 値の整え（検証を通らない値は落とす／送らないに倒す） ---------- */

  function cleanFacilityId(v) {
    return typeof v === 'string' && v.length <= 64 && FACILITY_ID_PATTERN.test(v) ? v : null;
  }
  // スポットコードは大文字に正規化してから形式を検証する
  function cleanSpotCode(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toUpperCase();
    return SPOT_CODE_PATTERN.test(s) ? s : null;
  }
  function cleanSpotId(v) {
    return typeof v === 'string' && v.length <= 128 && SPOT_ID_PATTERN.test(v) ? v : null;
  }
  function cleanLang(v) {
    return LANGS.indexOf(v) >= 0 ? v : 'en';
  }
  function cleanPackVersion(v) {
    return Number.isInteger(v) && v >= 0 ? v : null;
  }
  // デジタル配布リンクの文脈。制御文字を含む・長すぎる値は付けない
  function cleanCtx(v) {
    if (typeof v !== 'string' || !v || v.length > 64 || /[\u0000-\u001f\u007f]/.test(v)) return null;
    return v;
  }
  function cleanEntry(v) {
    return ENTRIES.indexOf(v) >= 0 ? v : null;
  }
  function isoTs(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === 'string' && now) return now;
    return new Date().toISOString();
  }
  function byteLength(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return s.length;
  }

  /* ---------- 表示判定 → display_kind / source の対応（設計 §2-1） ----------
     decideDisplay（pack-loader.js）の kind と status から、計測側の
     display_kind と source を引く。'preview'（4-3 の事業者確認表示）は
     来訪者の表示ではないので計測対象にせず、null を返す。 */
  function mapDisplayKind(decision) {
    if (!decision || typeof decision.kind !== 'string') return null;
    switch (decision.kind) {
      case 'registered':
        return { displayKind: 'registered', source: 'registered' };
      case 'registered-fallback-lang':
        return { displayKind: 'registered-fallback-lang', source: 'registered' };
      case 'guidance':
        if (decision.status === 'retired') return { displayKind: 'guidance-retired', source: 'registered' };
        if (decision.status === 'suspended') return { displayKind: 'guidance-suspended', source: 'registered' };
        return null;
      case 'not-found':
        return { displayKind: 'not-found', source: 'registered' };
      case 'ai':
        return { displayKind: 'ai', source: 'ai' };
      default:
        return null; // 'preview' など、計測対象外の表示
    }
  }

  /* エンジン結果の source（'gemini (model)' / 'mock' / 'demo'）から
     ai_source を導出する。モデル名の文字列そのものは送らない（設計 §3）。 */
  function deriveAiSource(engineSource) {
    if (typeof engineSource !== 'string') return null;
    if (engineSource.indexOf('gemini') === 0) return 'gemini';
    if (engineSource === 'mock' || engineSource === 'demo') return 'mock';
    return null;
  }

  /* ---------- 共通部の組み立て ----------
     input: { facilityId, spotCode, spotId, lang, entry, ctx, packVersion, now }
     施設IDが検証を通らない場合はイベント自体を送らない（null）。 */
  function baseFields(input) {
    var facilityId = cleanFacilityId(input && input.facilityId);
    if (!facilityId) return null;
    var entry = cleanEntry(input.entry);
    if (!entry) return null;
    var out = {
      pv: PV,
      ts: isoTs(input.now),
      facility_id: facilityId,
      lang: cleanLang(input.lang),
      entry: entry,
    };
    var ctx = cleanCtx(input.ctx);
    if (ctx) out.ctx = ctx;
    var pv2 = cleanPackVersion(input.packVersion);
    if (pv2 !== null) out.pack_version = pv2;
    return out;
  }
  function putSpotFields(out, input) {
    var code = cleanSpotCode(input.spotCode);
    if (code) out.spot_code = code;
    var id = cleanSpotId(input.spotId);
    if (id) out.spot_id = id;
    return out;
  }

  /** facility_view：施設パネルの表示（設計 §2 #1）。スポット項目は持たない。 */
  function buildFacilityView(input) {
    var out = baseFields(input || {});
    if (!out) return null;
    out.event = 'facility_view';
    return out;
  }

  /**
   * spot_view：スポット表示の確定（設計 §2 #2、中核イベント）。
   * input は共通部に加え { decision: decideDisplay の戻り値, route }。
   * spot_code・source・display_kind・route が受け口の必須項目なので、
   * どれか欠けたら送らない（null）。
   */
  function buildSpotView(input) {
    input = input || {};
    var mapped = mapDisplayKind(input.decision);
    if (!mapped) return null;
    if (ROUTES.indexOf(input.route) < 0) return null;
    var out = baseFields(input);
    if (!out) return null;
    putSpotFields(out, input);
    if (!out.spot_code) return null;
    out.event = 'spot_view';
    out.source = mapped.source;
    out.display_kind = mapped.displayKind;
    out.route = input.route;
    // 実際に表示した登録コンテンツの言語。登録表示のときだけ付ける
    var contentLang = input.decision && input.decision.contentLang;
    if ((mapped.displayKind === 'registered' || mapped.displayKind === 'registered-fallback-lang')
      && LANGS.indexOf(contentLang) >= 0) {
      out.content_lang = contentLang;
    }
    return out;
  }

  /** ai_generate：AI生成の成功（設計 §2 #3）。ai_source が必須。 */
  function buildAiGenerate(input) {
    input = input || {};
    var aiSource = deriveAiSource(input.resultSource);
    if (!aiSource) return null;
    var out = baseFields(input);
    if (!out) return null;
    putSpotFields(out, input);
    out.event = 'ai_generate';
    out.ai_source = aiSource;
    return out;
  }

  /** ai_failure：AI生成の失敗案内の表示（設計 §2 #4）。failure_kind が必須。 */
  function buildAiFailure(input) {
    input = input || {};
    if (FAILURE_KINDS.indexOf(input.failureKind) < 0) return null;
    var out = baseFields(input);
    if (!out) return null;
    putSpotFields(out, input);
    out.event = 'ai_failure';
    out.failure_kind = input.failureKind;
    return out;
  }

  /**
   * 誤り報告（設計 §4、受け口は POST /report）。
   * 他イベントと違い、施設コンテキストが無い通常起動からも送れる
   * （facility_id は null 可）。自由文は任意で、受け口の上限（500字）に
   * 合わせて文字数で切り詰める。target / category / reporter が
   * 列挙値でなければ送らない（null）。
   */
  function buildReport(input) {
    input = input || {};
    if (REPORT_TARGETS.indexOf(input.target) < 0) return null;
    if (REPORT_CATEGORIES.indexOf(input.category) < 0) return null;
    if (REPORTERS.indexOf(input.reporter) < 0) return null;
    var out = {
      pv: PV,
      ts: isoTs(input.now),
      target: input.target,
      category: input.category,
      lang: cleanLang(input.lang),
      reporter: input.reporter,
    };
    var facilityId = cleanFacilityId(input.facilityId);
    if (facilityId) out.facility_id = facilityId;
    putSpotFields(out, input);
    if (typeof input.freeText === 'string') {
      var text = input.freeText.trim();
      if (text) out.free_text = Array.from(text).slice(0, FREE_TEXT_MAX).join('');
    }
    var cv = cleanPackVersion(input.contentVersion);
    if (cv !== null) out.content_version = cv;
    return out;
  }

  /* ---------- 送信 ----------
     env: { baseUrl, beacon, fetchFn, isOnline, isSuppressed }
     すべて任意で、ブラウザでは実物に倒れる。isSuppressed は計測イベント
     だけに効く抑制判定（比較モード中・プレビュー確認中など、通常の
     来訪者表示でない間は送らないために呼び出し側が渡す）。誤り報告は
     来訪者・事業者の能動的な送信なので、抑制の対象にしない。 */
  function createSender(env) {
    env = env || {};
    var baseUrl = typeof env.baseUrl === 'string' && env.baseUrl ? env.baseUrl : ENDPOINT_BASE;
    var beaconFn = typeof env.beacon === 'function' ? env.beacon
      : (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? function (url, body) { return navigator.sendBeacon(url, body); } : null);
    var fetchFn = typeof env.fetchFn === 'function' ? env.fetchFn
      : (typeof fetch !== 'undefined' ? function (url, opts) { return fetch(url, opts); } : null);
    var isOnline = typeof env.isOnline === 'function' ? env.isOnline
      : function () { return typeof navigator === 'undefined' || navigator.onLine !== false; };
    var isSuppressed = typeof env.isSuppressed === 'function' ? env.isSuppressed
      : function () { return false; };

    /**
     * 計測イベントを送る。戻り値は「送信を試みたか」。
     * どの失敗でも例外を投げず、表示処理に影響させない。
     */
    function sendEvent(payload) {
      try {
        if (!payload) return false;
        if (isSuppressed()) return false;
        if (!isOnline()) return false; // オフライン時は送らない・ためない
        var json = JSON.stringify(payload);
        if (byteLength(json) > MAX_EVENT_BYTES) return false;
        var url = baseUrl + '/event';
        if (beaconFn) {
          try {
            // Blob の型は simple request の範囲（text/plain）にし、
            // プリフライト無しで届く形にする。本文は JSON のまま送る
            var blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
            if (beaconFn(url, blob) === true) return true;
          } catch (e) { /* beacon が使えなければ fetch に落とす */ }
        }
        if (fetchFn) {
          var p = fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json,
            keepalive: true,
            credentials: 'omit',
          });
          if (p && typeof p.catch === 'function') p.catch(function () { /* 欠測として扱う */ });
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    /**
     * 誤り報告を送る。報告は「届いたか」が来訪者に分かる必要があるため、
     * beacon は使わず fetch で結果を返す。
     * @returns {Promise<{ok:boolean, id:(number|null), error:(string|null)}>}
     *   例外は投げない。
     */
    async function sendReport(payload) {
      try {
        if (!payload) return { ok: false, id: null, error: 'invalid' };
        if (!isOnline()) return { ok: false, id: null, error: 'offline' };
        if (!fetchFn) return { ok: false, id: null, error: 'unavailable' };
        var json = JSON.stringify(payload);
        if (byteLength(json) > MAX_REPORT_BYTES) return { ok: false, id: null, error: 'too-large' };
        var res = await fetchFn(baseUrl + '/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: json,
          credentials: 'omit',
        });
        var body = null;
        try { body = await res.json(); } catch (e) { /* 本文が無くても成否はステータスで判断する */ }
        var ok = !!(res && res.ok && (!body || body.ok !== false));
        return { ok: ok, id: body && typeof body.id === 'number' ? body.id : null, error: ok ? null : 'rejected' };
      } catch (e) {
        return { ok: false, id: null, error: 'network' };
      }
    }

    return { sendEvent: sendEvent, sendReport: sendReport };
  }

  var api = {
    ENDPOINT_BASE: ENDPOINT_BASE,
    EVENT_URL: EVENT_URL,
    REPORT_URL: REPORT_URL,
    PV: PV,
    LANGS: LANGS,
    ROUTES: ROUTES,
    ENTRIES: ENTRIES,
    FAILURE_KINDS: FAILURE_KINDS,
    REPORT_TARGETS: REPORT_TARGETS,
    REPORT_CATEGORIES: REPORT_CATEGORIES,
    REPORTERS: REPORTERS,
    FREE_TEXT_MAX: FREE_TEXT_MAX,
    mapDisplayKind: mapDisplayKind,
    deriveAiSource: deriveAiSource,
    buildFacilityView: buildFacilityView,
    buildSpotView: buildSpotView,
    buildAiGenerate: buildAiGenerate,
    buildAiFailure: buildAiFailure,
    buildReport: buildReport,
    createSender: createSender,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
