/**
 * demo-compare.js ― 直訳と拡張翻訳の比較ビュー（5-4、H-40）
 *
 * 営業デモの3分フロー（設計書：直訳だけ版 → 拡張翻訳体験 → 実務情報 →
 * 数字と料金）の冒頭「直訳だけでは伝わらない」を、アプリ内で再現する
 * ための整形ロジック。表示中スポットの結果オブジェクト（登録コンテンツ
 * を contentToResult で整えた形でも、AI生成結果でもよい）から、
 * - 直訳だけ側：タイトル＋直訳テキストのみの最小表示
 * - 拡張翻訳側：完全な表示（拡張翻訳・場面・文化タグ・ギャップ・
 *   好奇心フック＋実務情報の要約）
 * の2つを組み立てる純粋関数だけを持つ。DOM・ストレージには触らない。
 *
 * 言語の選び方は main.js の pick() と同じ：lang が 'ja' のときだけ
 * `<field>_ja` を優先し、それ以外は主フィールドを使う（登録コンテンツは
 * 言語ブロック選択済みなので主フィールドのみで正しく動く。AI結果は
 * en/ja が二言語JSON、zh/ko は主フィールドに当該言語が入る）。
 *
 * 比較モードはデモ専用であり、通常の来訪者体験の計測に混ぜない。
 * 表示側は viewMode（'normal' / 'demo-compare'）を持ち、将来の計測
 * 送信（3-3）は isComparisonMode(viewMode) が true の間はイベントを
 * 送らない、という判定に使える。
 *
 * ブラウザでは window.CultureLensDemoCompare として公開し、Node では
 * module.exports する（pack-loader.js と同じ形）。
 */
(function (global) {
  'use strict';

  var VIEW_MODE_NORMAL = 'normal';
  var VIEW_MODE_DEMO_COMPARE = 'demo-compare';

  /** 比較モード（デモ用表示）かどうか。計測対象外の判定に使う。 */
  function isComparisonMode(mode) {
    return mode === VIEW_MODE_DEMO_COMPARE;
  }

  // lang が 'ja' のときだけ _ja 側を優先するフィールド取得（main.js pick と同義）
  function fieldOf(result, name, lang) {
    if (!result) return '';
    if (lang === 'ja') {
      var ja = result[name + '_ja'];
      if (ja !== undefined && ja !== null && ja !== '') return ja;
    }
    var v = result[name];
    return v === undefined || v === null ? '' : v;
  }

  /**
   * 直訳だけ側の最小表示。返すのは title と literal_translation の
   * 2キーだけ（文化背景・実務情報を構造的に含まないことを保証する）。
   * 結果が無ければ null。
   */
  function buildLiteralView(result, lang) {
    if (!result) return null;
    return {
      title: fieldOf(result, 'title', lang),
      literal_translation: fieldOf(result, 'literal_translation', lang),
    };
  }

  /**
   * 実務情報（スポットの practical）を、表示言語に依存しない構造の
   * まま比較ビュー用に要約する。言語ブロック（価格メモ・量の注記）は
   * pickText（(block) => string|null、呼び出し側が i18n.pickContent 等で
   * 実装する）で文字列化する。pickText が無ければ注記は落とす。
   * practical が無ければ null。
   */
  function summarizePractical(practical, pickText) {
    if (!practical || typeof practical !== 'object') return null;
    var pick = typeof pickText === 'function' ? pickText : function () { return null; };
    var summary = { price: null, allergens: [], dietary: null, portion_note: null, last_confirmed_at: null };
    if (practical.price && typeof practical.price.amount === 'number') {
      summary.price = {
        amount: practical.price.amount,
        currency: practical.price.currency || 'JPY',
        tax_included: !!practical.price.tax_included,
        note: pick(practical.price.note),
      };
    }
    if (Array.isArray(practical.allergens)) summary.allergens = practical.allergens.slice();
    if (practical.dietary && typeof practical.dietary === 'object') {
      summary.dietary = {
        vegetarian: !!practical.dietary.vegetarian,
        vegan: !!practical.dietary.vegan,
        halal: practical.dietary.halal || null,
      };
    }
    summary.portion_note = pick(practical.portion_note);
    summary.last_confirmed_at = practical.last_confirmed_at || null;
    var hasAny = summary.price || summary.allergens.length || summary.dietary ||
      summary.portion_note || summary.last_confirmed_at;
    return hasAny ? summary : null;
  }

  /**
   * 拡張翻訳側の完全な表示。文化背景（タグ・ギャップ・フック）と
   * 実務情報の要約を含む。結果が無ければ null。
   * @param {object} result 結果オブジェクト（登録／AI共通の形）
   * @param {string} lang 表示言語
   * @param {object|null} practicalSummary summarizePractical の戻り値
   */
  function buildExtendedView(result, lang, practicalSummary) {
    if (!result) return null;
    var tags = (Array.isArray(result.tags) ? result.tags : []).map(function (tag) {
      return {
        title: fieldOf(tag, 'title', lang),
        description: fieldOf(tag, 'description', lang),
        why_it_matters: fieldOf(tag, 'why_it_matters', lang),
      };
    });
    return {
      title: fieldOf(result, 'title', lang),
      literal_translation: fieldOf(result, 'literal_translation', lang),
      extended_translation: fieldOf(result, 'extended_translation', lang),
      scene_summary: fieldOf(result, 'scene_summary', lang),
      tags: tags,
      cultural_gap: fieldOf(result, 'cultural_gap', lang),
      curiosity_hook: fieldOf(result, 'curiosity_hook', lang),
      practical: practicalSummary || null,
    };
  }

  /**
   * 比較ビュー全体を組み立てる。
   * @param {object} result 結果オブジェクト
   * @param {{lang:string, practical:object|null, pickText:Function}} options
   * @returns {{literal:object, extended:object}|null}
   */
  function buildComparison(result, options) {
    if (!result) return null;
    var opts = options || {};
    var lang = opts.lang || 'en';
    var summary = summarizePractical(opts.practical || null, opts.pickText);
    return {
      literal: buildLiteralView(result, lang),
      extended: buildExtendedView(result, lang, summary),
    };
  }

  var api = {
    VIEW_MODE_NORMAL: VIEW_MODE_NORMAL,
    VIEW_MODE_DEMO_COMPARE: VIEW_MODE_DEMO_COMPARE,
    isComparisonMode: isComparisonMode,
    fieldOf: fieldOf,
    buildLiteralView: buildLiteralView,
    summarizePractical: summarizePractical,
    buildExtendedView: buildExtendedView,
    buildComparison: buildComparison,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensDemoCompare = api;
})(typeof window !== 'undefined' ? window : globalThis);
