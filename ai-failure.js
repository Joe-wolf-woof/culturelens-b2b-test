/**
 * ai-failure.js ― 障害時の振る舞い（F-30）の判定ロジック
 *
 * CultureLens B2B：AI生成（拡張翻訳）が失敗しても、登録コンテンツの
 * 表示は一切影響を受けず、AI部分だけが丁寧な案内に切り替わるための
 * 単一の判定点。仕様根拠：culturelens-b2b-required-improvements-2026-11-25.md
 * F-30「API障害・429・タイムアウトでも登録型は表示され続け、AI部分
 * だけが丁寧な案内に切り替わる」。
 *
 * このモジュールは純粋な分類と案内文だけを持ち、DOM には触らない。
 * 生のエラー文（例外メッセージや API の詳細）を来訪者へ見せないため、
 * 表示文はすべてここで用意した固定文から選ぶ。
 * 呼び出し側（main.js）は、失敗時にこのモジュールの案内を専用パネルへ
 * 出すだけでよく、登録コンテンツの描画には一切触らない。
 *
 * ブラウザでは window.CultureLensAiFailure として公開し、Node では
 * module.exports する（単体確認用。keyless-mode.js と同じ形）。
 */
(function (global) {
  'use strict';

  /**
   * AI生成の失敗を種別に分類する。
   * エンジン（engine/translate-engine.js）が投げるエラーの形に合わせる:
   * - キー未設定: err.code === 'API_KEY_REQUIRED'
   * - HTTPエラー: err.status にステータスコード
   * - タイムアウト: err.timeout === true（AbortError 由来も含む）
   * それ以外はメッセージからの推定と汎用種別で受ける。
   *
   * @param {*} err
   * @returns {'key-required'|'rate-limit'|'timeout'|'server'|'network'|'unknown'}
   */
  function classifyAiError(err) {
    if (!err) return 'unknown';
    if (err.code === 'API_KEY_REQUIRED') return 'key-required';
    if (err.timeout === true || err.name === 'AbortError') return 'timeout';
    var status = typeof err.status === 'number' ? err.status : null;
    if (status === 429) return 'rate-limit';
    if (status !== null && status >= 500) return 'server';
    var msg = String(err.message || '');
    if (/timeout|timed out/i.test(msg)) return 'timeout';
    if (/\b429\b/.test(msg)) return 'rate-limit';
    if (/\b5\d\d\b/.test(msg)) return 'server';
    if (err instanceof TypeError || /fetch|network/i.test(msg)) return 'network';
    return 'unknown';
  }

  // 種別ごとの案内文（en/zh/ko/ja、2-11）。登録コンテンツが影響を受けないことを
  // 一文添え、来訪者が「店の情報は見られる」ことを不安なく分かるようにする。
  // showRetry: AI部分だけの再試行ボタンを出すかどうか。キー未設定だけは
  // 再試行しても進まないため false にし、設定への案内に寄せる（B-9と整合）。
  var GUIDANCE = {
    'key-required': {
      en: { title: 'AI translation needs an API key', text: 'Registered spots are shown without a key. AI-generated translation is an add-on feature and needs a Gemini API key — you can add one from Settings.', showRetry: false },
      ja: { title: 'AI生成にはAPIキーが必要です', text: '登録スポットはキーなしで表示できます。AIによる拡張翻訳は追加機能で、Gemini APIキーが必要です（右上の「設定」から登録できます）。', showRetry: false },
      zh: { title: 'AI 翻译需要 API 密钥', text: '登记景点无需密钥即可显示。AI 扩展翻译是附加功能，需要 Gemini API 密钥（可在“设置”中添加）。', showRetry: false },
      ko: { title: 'AI 생성에는 API 키가 필요합니다', text: '등록 스팟은 키 없이 표시할 수 있습니다. AI 확장 번역은 추가 기능으로 Gemini API 키가 필요합니다(오른쪽 위 “설정”에서 등록할 수 있습니다).', showRetry: false },
    },
    'rate-limit': {
      en: { title: 'The AI service is busy right now', text: 'Too many requests at the moment. Please wait a little and try again. Registered spot information stays available in the meantime.', showRetry: true },
      ja: { title: 'AIサービスが混み合っています', text: 'ただいまリクエストが集中しています。少し時間をおいてから、もう一度お試しください。その間も登録スポットの情報はそのままご覧いただけます。', showRetry: true },
      zh: { title: 'AI 服务目前繁忙', text: '目前请求过于集中。请稍等片刻后再试。其间登记景点信息仍可正常查看。', showRetry: true },
      ko: { title: 'AI 서비스가 혼잡합니다', text: '현재 요청이 집중되고 있습니다. 잠시 후 다시 시도해 주세요. 그 동안에도 등록 스팟 정보는 그대로 보실 수 있습니다.', showRetry: true },
    },
    'timeout': {
      en: { title: 'The AI took too long to respond', text: 'The response timed out. Please try again — it often works on a second attempt. Registered spot information is not affected.', showRetry: true },
      ja: { title: 'AIの応答に時間がかかりすぎました', text: '応答がタイムアウトしました。もう一度お試しください（再試行で成功することがよくあります）。登録スポットの表示には影響ありません。', showRetry: true },
      zh: { title: 'AI 响应时间过长', text: '响应超时了。请再试一次（重试常常可以成功）。登记景点的显示不受影响。', showRetry: true },
      ko: { title: 'AI 응답 시간이 너무 오래 걸렸습니다', text: '응답이 시간 초과되었습니다. 다시 시도해 주세요(재시도로 성공하는 경우가 많습니다). 등록 스팟 표시에는 영향이 없습니다.', showRetry: true },
    },
    'server': {
      en: { title: 'The AI service is temporarily unavailable', text: 'There seems to be a temporary problem on the AI service side. Please try again later. Registered spot information stays available.', showRetry: true },
      ja: { title: 'AIサービスで一時的な障害が起きています', text: 'AIサービス側で一時的な問題が発生しているようです。しばらくしてからもう一度お試しください。登録スポットの情報はそのままご覧いただけます。', showRetry: true },
      zh: { title: 'AI 服务暂时不可用', text: 'AI 服务端似乎出现了临时问题。请稍后再试。登记景点信息仍可正常查看。', showRetry: true },
      ko: { title: 'AI 서비스에 일시적인 장애가 발생했습니다', text: 'AI 서비스 측에 일시적인 문제가 발생한 것 같습니다. 잠시 후 다시 시도해 주세요. 등록 스팟 정보는 그대로 보실 수 있습니다.', showRetry: true },
    },
    'network': {
      en: { title: 'Could not reach the AI service', text: 'Please check your connection and try again. Registered spots that were already loaded stay available.', showRetry: true },
      ja: { title: 'AIサービスに接続できませんでした', text: '通信環境をご確認のうえ、もう一度お試しください。読み込み済みの登録スポットは、そのまま表示されます。', showRetry: true },
      zh: { title: '无法连接到 AI 服务', text: '请检查您的网络连接后重试。已加载的登记景点仍可正常显示。', showRetry: true },
      ko: { title: 'AI 서비스에 연결할 수 없었습니다', text: '통신 환경을 확인한 뒤 다시 시도해 주세요. 이미 불러온 등록 스팟은 그대로 표시됩니다.', showRetry: true },
    },
    'unknown': {
      en: { title: 'AI translation could not be completed', text: 'Something went wrong while generating the AI translation. Please try again. Registered spot information is not affected.', showRetry: true },
      ja: { title: 'AI生成を完了できませんでした', text: 'AI生成の途中で問題が発生しました。もう一度お試しください。登録スポットの表示には影響ありません。', showRetry: true },
      zh: { title: 'AI 翻译未能完成', text: 'AI 生成过程中出现了问题。请再试一次。登记景点的显示不受影响。', showRetry: true },
      ko: { title: 'AI 생성을 완료할 수 없었습니다', text: 'AI 생성 중에 문제가 발생했습니다. 다시 시도해 주세요. 등록 스팟 표시에는 영향이 없습니다.', showRetry: true },
    },
  };

  /**
   * 種別と言語から案内文を引く。未知の種別・言語は汎用案内／英語に倒す。
   * @param {string} kind classifyAiError の戻り値
   * @param {string} lang 'en'|'zh'|'ko'|'ja'（それ以外は en）
   * @returns {{kind:string, title:string, text:string, showRetry:boolean}}
   */
  function guidanceFor(kind, lang) {
    var g = GUIDANCE[kind] || GUIDANCE.unknown;
    // 対応言語（en/zh/ko/ja）は正規化して引き、それ以外は英語に倒す
    var l = typeof lang === 'string' ? lang.trim().toLowerCase().split('-')[0] : '';
    var entry = (['en', 'zh', 'ko', 'ja'].indexOf(l) >= 0 && g[l]) || g.en;
    return {
      kind: GUIDANCE[kind] ? kind : 'unknown',
      title: entry.title,
      text: entry.text,
      showRetry: entry.showRetry,
    };
  }

  /** 分類と案内引きをまとめて行う。 */
  function describeAiFailure(err, lang) {
    return guidanceFor(classifyAiError(err), lang);
  }

  var api = {
    classifyAiError: classifyAiError,
    guidanceFor: guidanceFor,
    describeAiFailure: describeAiFailure,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensAiFailure = api;
})(typeof window !== 'undefined' ? window : globalThis);
