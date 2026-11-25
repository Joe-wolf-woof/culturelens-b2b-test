/**
 * keyless-mode.js ― キーレス分離（B-9）の判定ロジック
 *
 * CultureLens B2B：登録スポットの表示は APIキーに一切依存させず、
 * AI生成（拡張翻訳）は「追加機能」として切り離すための単一の判定点。
 * 仕様根拠：culturelens-b2b-required-improvements-2026-11-25.md B-9
 *   「キー未設定でも登録型が動く分離：登録スポットだけでも完全に動く
 *     状態にし、AI生成は『追加機能』として切り離す」
 *
 * このモジュールは純粋な判定だけを持ち、DOM・localStorage には触らない。
 * 呼び出し側（main.js）が hasApiKey / demo / 登録コンテンツの有無を渡す。
 *
 * ブラウザでは window.CultureLensKeyless として公開し、Node では
 * module.exports する（単体確認用。facility-context.js と同じ形）。
 */
(function (global) {
  'use strict';

  /**
   * 現在の利用可否を決める。
   * @param {{hasApiKey:boolean, demo:boolean, hasRegisteredContent:boolean, hasFacilityContext:boolean}} input
   * @returns {{
   *   mode: 'demo'|'registered+ai'|'registered-only'|'ai-only'|'keyless-empty',
   *   canShowRegistered: boolean,
   *   canUseAi: boolean,
   *   aiIsAddon: boolean,
   *   needsKeyForAi: boolean,
   *   showKeylessNotice: boolean
   * }}
   *
   * mode の意味:
   * - demo: デモデータで試す（明示選択時のみ。キー有無と無関係）
   * - registered+ai: 登録コンテンツ表示可＋AI生成も可
   * - registered-only: 登録コンテンツ表示可。AI生成はキー未設定のため不可
   * - ai-only: 登録コンテンツは無いが、キーがあるのでAI生成は可
   * - keyless-empty: 登録コンテンツもキーも無い。AI生成は使えず、
   *   案内だけを出す（モックを本物らしく見せることはしない）
   */
  function resolveAccess(input) {
    var hasApiKey = !!(input && input.hasApiKey);
    var demo = !!(input && input.demo);
    var hasRegisteredContent = !!(input && input.hasRegisteredContent);
    var hasFacilityContext = !!(input && input.hasFacilityContext);

    if (demo) {
      return {
        mode: 'demo',
        canShowRegistered: hasRegisteredContent,
        canUseAi: true,
        aiIsAddon: true,
        needsKeyForAi: false,
        showKeylessNotice: false,
      };
    }

    var canUseAi = hasApiKey;
    var mode;
    if (hasRegisteredContent && canUseAi) mode = 'registered+ai';
    else if (hasRegisteredContent) mode = 'registered-only';
    else if (canUseAi) mode = 'ai-only';
    else mode = 'keyless-empty';

    return {
      mode: mode,
      canShowRegistered: hasRegisteredContent,
      canUseAi: canUseAi,
      aiIsAddon: true,
      needsKeyForAi: !hasApiKey,
      // 案内は「施設・スポットの文脈で来たのにキーが無い」ときと、
      // 「表示できるものが何も無い」ときに出す。通常起動でキーを
      // 設定済みの利用者には出さない。
      showKeylessNotice: !hasApiKey && (hasFacilityContext || !hasRegisteredContent),
    };
  }

  var api = {
    resolveAccess: resolveAccess,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensKeyless = api;
})(typeof window !== 'undefined' ? window : globalThis);
