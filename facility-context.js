/**
 * facility-context.js ― 施設コンテキスト（J-44）の解析・保持
 *
 * CultureLens B2B：URL経由の入口（施設／スポット／ツアー）がアプリに与える
 * 「施設コンテキスト」を、アプリ全体から参照できる単一の状態として保持する。
 * 仕様：culturelens-b2b-url-pack-spec-2026-11-25.md §1（URL設計）
 *
 * 受け付けるURL形式（静的ホスティングではパス形式がそのまま index.html に
 * 届かないため、ドメインのリダイレクト層がパス→クエリへ変換する想定で両対応）：
 *   パス形式   /f/{facility_id}  /s/{spot_code}  /t/{tour_id}
 *   クエリ形式 ?f={facility_id}  ?s={spot_code}  ?t={tour_id}
 * 任意パラメータ：?lang=（デジタル配布リンク用。言語は原則URLに焼かない）
 *                 ?ctx=（計測の文脈。印刷QRには焼かない）
 *                 ?preview=1&ptoken=（事業者の公開前確認用、4-3。トークンの
 *                 照合は pack-loader.js の isPreviewRequest が担う）
 *
 * URLにも保存済みコンテキストにも無い場合は null（＝URLなしの通常起動で、
 * 参加者各自のキー方式など従来の動作は一切変わらない）。
 * コンテキストは sessionStorage に保存し、同じセッション内は保持する。
 *
 * ブラウザでは window.CultureLensFacility として公開し、Node では
 * module.exports する（パーサの単体確認用）。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cl_facility_context';
  var CONTEXT_VERSION = 1;

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // 施設ID・ツアーID（人間可読スラッグ）の検証。空・不正な値は「無し」として扱う
  function cleanSlug(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) ? s : null;
  }

  // スポットコードは大文字小文字を区別しない（仕様§1.3）。大文字に正規化する
  function cleanSpotCode(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toUpperCase();
    return /^[A-Z0-9]+$/.test(s) ? s : null;
  }

  // ?lang= / ?ctx= の値。表示や計測に使う文字列なので、長さだけ制限する
  function cleanParam(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    return s && s.length <= 64 ? s : null;
  }

  // プレビュー確認用トークン（?ptoken=、4-3 確認フロー C-14）。
  // pack-admin が発行し、マニフェストの施設エントリ（preview_token）に
  // 保持されたものと表示側が照合する。秘匿ではなく「通常来訪者と
  // 事業者確認を分ける目印」なので、形式だけを検証する。
  function cleanPreviewToken(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
  }

  // ?lang= は対応言語（en/zh/ko/ja、2-11）だけを受理し、正規化して保持する。
  // zh-Hans / zh-CN / ko-KR 等の揺れは寄せ、対応外の言語は「指定なし」
  // として扱う（表示側が保存済み設定に倒れる）。正規化の正本は i18n.js の
  // normalizeLang で、ここは単体で動くための自己完結した同等実装。
  var SUPPORTED_LANGS = ['en', 'zh', 'ko', 'ja'];
  function cleanLang(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase().replace(/_/g, '-');
    if (!s) return null;
    var primary = s.split('-')[0];
    return SUPPORTED_LANGS.indexOf(primary) >= 0 ? primary : null;
  }

  /**
   * URL文字列を解析して施設コンテキストを返す。該当が無ければ null。
   * 戻り値: { v, source: 'facility'|'spot'|'tour'|'link',
   *           facilityId, spotCode, tourId, lang, ctx, via: 'path'|'query'|null }
   * source='link' は、入口（f/s/t）は無いが ?lang= / ?ctx= だけを持つ
   * デジタル配布リンクの場合。
   */
  function parseFacilityContext(urlString) {
    var u;
    try { u = new URL(urlString); } catch (e) { return null; }

    var source = null, facilityId = null, spotCode = null, tourId = null, via = null;

    // パス形式（基底パスに接頭辞が付く配信形態でも拾えるよう、区切りを走査する）
    var segs = u.pathname.split('/').filter(function (s) { return s !== ''; }).map(safeDecode);
    for (var i = 0; i + 1 < segs.length && !source; i++) {
      var key = segs[i], val = segs[i + 1];
      if (key === 'f') {
        var f = cleanSlug(val);
        if (f) { source = 'facility'; facilityId = f; via = 'path'; }
      } else if (key === 's') {
        var s = cleanSpotCode(val);
        if (s) { source = 'spot'; spotCode = s; via = 'path'; }
      } else if (key === 't') {
        var t = cleanSlug(val);
        if (t) { source = 'tour'; tourId = t; via = 'path'; }
      }
    }

    // クエリ形式（パス形式で取れた場合はそちらを優先する）
    if (!source) {
      var qf = cleanSlug(u.searchParams.get('f'));
      var qs = cleanSpotCode(u.searchParams.get('s'));
      var qt = cleanSlug(u.searchParams.get('t'));
      if (qf) { source = 'facility'; facilityId = qf; via = 'query'; }
      else if (qs) { source = 'spot'; spotCode = qs; via = 'query'; }
      else if (qt) { source = 'tour'; tourId = qt; via = 'query'; }
    }

    var lang = cleanLang(u.searchParams.get('lang'));
    var ctx = cleanParam(u.searchParams.get('ctx'));

    // プレビュー指定（?preview=1&ptoken=...）。preview=1 のときだけ
    // コンテキストにキーを持たせる（プレビューでないURLの解析結果は
    // 従来と完全に同じ形に保つ）。
    var preview = u.searchParams.get('preview') === '1';
    var previewToken = preview ? cleanPreviewToken(u.searchParams.get('ptoken')) : null;

    if (!source && !lang && !ctx && !preview) return null;
    var context = {
      v: CONTEXT_VERSION,
      source: source || 'link',
      facilityId: facilityId,
      spotCode: spotCode,
      tourId: tourId,
      lang: lang,
      ctx: ctx,
      via: via,
    };
    if (preview) {
      context.preview = true;
      context.previewToken = previewToken;
    }
    return context;
  }

  function saveContext(storage, context) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(context)); } catch (e) { /* 保存できなくても動作は継続する */ }
  }

  function loadContext(storage) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      return c && c.v === CONTEXT_VERSION ? c : null;
    } catch (e) { return null; }
  }

  /**
   * 起動時の初期化。URLにコンテキストがあればそれを採用して保存し、
   * 無ければ sessionStorage の保存済みを復元する。どちらも無ければ null。
   * env は単体確認用に { location, sessionStorage } を差し替えられる。
   */
  function init(env) {
    env = env || {};
    var loc = env.location || (typeof window !== 'undefined' ? window.location : null);
    var storage = env.sessionStorage || (typeof window !== 'undefined' ? window.sessionStorage : null);
    var context = null;
    if (loc && loc.href) context = parseFacilityContext(loc.href);
    if (context) {
      if (storage) saveContext(storage, context);
    } else if (storage) {
      context = loadContext(storage);
    }
    api.current = context;
    return context;
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    CONTEXT_VERSION: CONTEXT_VERSION,
    parseFacilityContext: parseFacilityContext,
    cleanLang: cleanLang,
    cleanPreviewToken: cleanPreviewToken,
    loadContext: loadContext,
    saveContext: saveContext,
    init: init,
    current: null,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensFacility = api;
})(typeof window !== 'undefined' ? window : globalThis);
