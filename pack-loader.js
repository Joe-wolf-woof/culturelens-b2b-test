/**
 * pack-loader.js ― マニフェスト解決・パック取得/キャッシュ・ハイブリッド判定
 *
 * CultureLens B2B 第1段階の依存の幹：
 *   2-3 マニフェスト取得とスポット解決（A-2）
 *   2-4 パック取得・キャッシュ・版管理（A-2）
 *   2-5 ハイブリッド判定（A-6、仕様書§2.5の5段階）
 *   2-12 オフライン耐性（E-26：取得失敗時はキャッシュで継続）
 * 仕様：culturelens-b2b-url-pack-spec-2026-11-25.md §2.5／§2.6
 *
 * 取得（fetch）と保存（localStorage相当）は差し替え可能にしてあり、
 * Node の単体確認ではフェイクを注入する。ブラウザでは実物を使う。
 * 登録コンテンツの表示は APIキーに一切依存しない（B-9）。
 *
 * ブラウザでは window.CultureLensPacks として公開し、Node では
 * module.exports する（facility-context.js と同じ形）。
 */
(function (global) {
  'use strict';

  var MANIFEST_URL = './packs/manifest.json';
  var MANIFEST_CACHE_KEY = 'cl_manifest_cache';
  var PACK_CACHE_PREFIX = 'cl_pack_cache_';

  function normCode(v) {
    return typeof v === 'string' ? v.trim().toUpperCase() : '';
  }

  /* ---------- マニフェストからの解決（2-3） ---------- */

  function findFacilityEntry(manifest, facilityId) {
    if (!manifest || !Array.isArray(manifest.facilities)) return null;
    for (var i = 0; i < manifest.facilities.length; i++) {
      if (manifest.facilities[i].facility_id === facilityId) return manifest.facilities[i];
    }
    return null;
  }

  // スポットコード（大文字小文字を区別しない）から所属施設のエントリを引く
  function findFacilityForSpot(manifest, spotCode) {
    var code = normCode(spotCode);
    if (!code || !manifest || !Array.isArray(manifest.facilities)) return null;
    for (var i = 0; i < manifest.facilities.length; i++) {
      var idx = manifest.facilities[i].spots_index || {};
      if (idx[code]) return manifest.facilities[i];
    }
    return null;
  }

  // パック内からスポットを引く（qr_code / identifiers.qr のどちらでも可）
  function resolveSpot(pack, spotCode) {
    var code = normCode(spotCode);
    if (!code || !pack || !Array.isArray(pack.spots)) return null;
    for (var i = 0; i < pack.spots.length; i++) {
      var s = pack.spots[i];
      if (normCode(s.qr_code) === code) return s;
      if (s.identifiers && normCode(s.identifiers.qr) === code) return s;
    }
    return null;
  }

  /* ---------- ハイブリッド判定（2-5、仕様§2.5の5段階） ---------- */

  /**
   * @param {{spot:object|null, lang:string, defaultLang:string}} input
   * @returns {{kind:string, spot:object|null, content:object|null,
   *            contentLang:string|null, supervised:boolean,
   *            practical:object|null, status:string|null}}
   * kind:
   * - 'ai'                … パックに無い対象。従来どおりAI生成へ（パック外の挙動）
   * - 'not-found'         … draft。来訪者には存在しないものとして扱う
   * - 'guidance'          … retired / suspended。案内表示。AIへは落とさない
   * - 'registered'        … 表示言語の登録コンテンツを表示
   * - 'registered-fallback-lang' … 表示言語の登録が無く、既定言語の登録を表示
   *                          （実務情報は言語非依存なので常に併せて返す）
   */
  function decideDisplay(input) {
    var spot = (input && input.spot) || null;
    var lang = (input && input.lang) || 'en';
    var defaultLang = (input && input.defaultLang) || 'en';
    if (!spot) {
      return { kind: 'ai', spot: null, content: null, contentLang: null, supervised: false, practical: null, status: null };
    }
    var practical = spot.practical || null;
    var supervised = !!(spot.supervision && spot.supervision.supervised);
    if (spot.status === 'draft') {
      return { kind: 'not-found', spot: spot, content: null, contentLang: null, supervised: supervised, practical: practical, status: spot.status };
    }
    if (spot.status === 'retired' || spot.status === 'suspended') {
      return { kind: 'guidance', spot: spot, content: null, contentLang: null, supervised: supervised, practical: practical, status: spot.status };
    }
    var content = spot.content || {};
    if (content[lang]) {
      return { kind: 'registered', spot: spot, content: content[lang], contentLang: lang, supervised: supervised, practical: practical, status: spot.status };
    }
    var fbLang = content[defaultLang] ? defaultLang : (content.en ? 'en' : null);
    if (!fbLang) {
      var anyLang = Object.keys(content)[0] || null;
      if (anyLang) fbLang = anyLang;
    }
    if (fbLang) {
      return { kind: 'registered-fallback-lang', spot: spot, content: content[fbLang], contentLang: fbLang, supervised: supervised, practical: practical, status: spot.status };
    }
    // 公開状態だがコンテンツが1言語も無い場合は、制作側の不備として
    // AIで誤魔化さず「存在しない」扱いにする（fallback.allow_ai の場合のみAI可）
    if (spot.fallback && spot.fallback.allow_ai) {
      return { kind: 'ai', spot: spot, content: null, contentLang: null, supervised: supervised, practical: practical, status: spot.status };
    }
    return { kind: 'not-found', spot: spot, content: null, contentLang: null, supervised: supervised, practical: practical, status: spot.status };
  }

  /* ---------- プレビュー（4-3、確認フロー C-14） ----------
     公開前の draft スポットは、通常の来訪者には decideDisplay で
     'not-found'（存在しない扱い）になる。その例外として、事業者の
     公開前確認だけに draft を登録表示と同じ経路で見せる判定を用意する。
     プレビューが有効になるのは、URLのプレビューパラメータと確認用
     トークンが、マニフェストの施設エントリに保持されたトークンと
     一致した場合だけ（isPreviewRequest）。トークンは秘匿のための
     ものではなく、通常来訪者と事業者確認を分ける「目印」である
     （静的ホスティングではサーバー側の認証ができないため）。 */

  // プレビューリクエストの照合。context は facility-context.js の解析結果、
  // entry はマニフェストの施設エントリ（preview_token を保持する）。
  function isPreviewRequest(context, entry) {
    if (!context || context.preview !== true) return false;
    if (typeof context.previewToken !== 'string' || !context.previewToken) return false;
    if (!entry || typeof entry.preview_token !== 'string' || !entry.preview_token) return false;
    return context.previewToken === entry.preview_token;
  }

  /**
   * プレビュー時の判定。draft のときだけ登録表示と同じ内容選択を行い、
   * kind: 'preview' を返す（表示側は「プレビュー（未公開）」バッジを付ける）。
   * draft 以外（published / suspended / retired / スポット無し）は
   * decideDisplay と完全に同じ結果を返す。
   * draft でもコンテンツが1言語も無い場合は、プレビューでも見せる
   * 内容が無いので decideDisplay（not-found）に倒れる。
   */
  function decidePreviewDisplay(input) {
    var spot = (input && input.spot) || null;
    if (!spot || spot.status !== 'draft') return decideDisplay(input);
    var lang = (input && input.lang) || 'en';
    var defaultLang = (input && input.defaultLang) || 'en';
    var practical = spot.practical || null;
    var supervised = !!(spot.supervision && spot.supervision.supervised);
    var content = spot.content || {};
    var contentLang = null;
    if (content[lang]) contentLang = lang;
    else if (content[defaultLang]) contentLang = defaultLang;
    else if (content.en) contentLang = 'en';
    else contentLang = Object.keys(content)[0] || null;
    if (!contentLang) return decideDisplay(input);
    return {
      kind: 'preview', preview: true, spot: spot, content: content[contentLang],
      contentLang: contentLang, supervised: supervised, practical: practical, status: spot.status,
    };
  }

  // 登録コンテンツの言語ブロックを、表示側（AI生成結果と同じ形）に整える
  function contentToResult(content, spot) {
    var r = {};
    var keys = ['title', 'literal_translation', 'extended_translation', 'scene_summary', 'tags', 'cultural_gap', 'curiosity_hook'];
    for (var i = 0; i < keys.length; i++) {
      if (content && content[keys[i]] !== undefined) r[keys[i]] = content[keys[i]];
    }
    r.tags = r.tags || [];
    r.source = 'registered';
    r.supervised = !!(spot && spot.supervision && spot.supervision.supervised);
    return r;
  }

  /* ---------- キャッシュ（2-4／2-12） ---------- */

  function cacheRead(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function cacheWrite(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動作は継続する */ }
  }
  function packCacheKey(facilityId) { return PACK_CACHE_PREFIX + facilityId; }

  function defaultStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }
  function defaultFetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('fetch failed: ' + res.status + ' ' + url);
      return res.json();
    });
  }

  /**
   * マニフェストを取得する。失敗したらキャッシュで継続する（2-12）。
   * @returns {Promise<{manifest:object, source:'network'|'cache'}>}
   */
  function loadManifest(opts) {
    opts = opts || {};
    var fetchJson = opts.fetchJson || defaultFetchJson;
    var storage = opts.storage || defaultStorage();
    var url = opts.manifestUrl || MANIFEST_URL;
    return fetchJson(url).then(function (manifest) {
      if (storage) cacheWrite(storage, MANIFEST_CACHE_KEY, { manifest: manifest, fetched_at: opts.now || null });
      return { manifest: manifest, source: 'network' };
    }).catch(function (err) {
      if (storage) {
        var c = cacheRead(storage, MANIFEST_CACHE_KEY);
        if (c && c.manifest) return { manifest: c.manifest, source: 'cache' };
      }
      throw err;
    });
  }

  /**
   * 施設パックを取得する（2-4）。
   * キャッシュの版数がマニフェストの版数以上なら再取得しない。
   * 取得に失敗したらキャッシュで継続する（2-12）。
   * @param {{entry:object, fetchJson:Function, storage:object, now:string}} opts
   *        entry はマニフェストの施設エントリ（pack_url / pack_version を持つ）
   * @returns {Promise<{pack:object, source:'network'|'cache'|'cache-fallback'}>}
   */
  function loadFacilityPack(opts) {
    opts = opts || {};
    var entry = opts.entry;
    if (!entry || !entry.facility_id) return Promise.reject(new Error('facility entry is required'));
    var fetchJson = opts.fetchJson || defaultFetchJson;
    var storage = opts.storage || defaultStorage();
    var key = packCacheKey(entry.facility_id);
    var cached = storage ? cacheRead(storage, key) : null;
    if (cached && cached.pack && typeof entry.pack_version === 'number' && cached.pack_version >= entry.pack_version) {
      return Promise.resolve({ pack: cached.pack, source: 'cache' });
    }
    var url = opts.packBaseUrl ? opts.packBaseUrl + entry.pack_url : './' + (entry.pack_url || '');
    return fetchJson(url).then(function (pack) {
      if (storage) cacheWrite(storage, key, { pack_version: pack.pack_version, pack: pack, fetched_at: opts.now || null });
      return { pack: pack, source: 'network' };
    }).catch(function (err) {
      if (cached && cached.pack) return { pack: cached.pack, source: 'cache-fallback' };
      throw err;
    });
  }

  var api = {
    MANIFEST_URL: MANIFEST_URL,
    MANIFEST_CACHE_KEY: MANIFEST_CACHE_KEY,
    PACK_CACHE_PREFIX: PACK_CACHE_PREFIX,
    findFacilityEntry: findFacilityEntry,
    findFacilityForSpot: findFacilityForSpot,
    resolveSpot: resolveSpot,
    decideDisplay: decideDisplay,
    decidePreviewDisplay: decidePreviewDisplay,
    isPreviewRequest: isPreviewRequest,
    contentToResult: contentToResult,
    loadManifest: loadManifest,
    loadFacilityPack: loadFacilityPack,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensPacks = api;
})(typeof window !== 'undefined' ? window : globalThis);
