/**
 * engine/translate-engine.js ― 拡張翻訳エンジン
 *
 * 単なる直訳ではなく、映像＋語り手の言葉から
 * 「文化・歴史・語り手の感情」の文脈を JSON で抽出する。
 *
 * プロンプト設計（心理学・行動科学の知見を組み込み済み）:
 * - 情報ギャップ理論（Loewenstein）: 「知っているつもり」と「知らないこと」の
 *   落差を1つだけ鋭く提示すると好奇心が最大化する。タグを並べるのではなく
 *   "cultural_gap" を1つに絞らせる。
 * - 自己関連効果: 受け手（英語圏の生活者）の日常と接続する一文を必ず入れる。
 * - 具体性効果: 抽象的な文化説明ではなく、感覚（匂い・手触り・音・温度）で語る。
 * - 物語輸送: 語り手の感情と小さなエピソードを字幕に残す（無難な説明との差分）。
 *   ただしエピソードは入力に実在する場合のみ。2026-11-17の実機実験で、言葉なし
 *   実行時に "grandmother's house" という来歴の捏造が混入したため、プロンプトに
 *   【事実の扱い】として接地ルールを明文化した（一般的な文化知識の補足は可、
 *   語り手個人の事情の創作は禁止）。
 *
 * Gemini キーが無ければ API_KEY_REQUIRED を投げる（B-9）。モック（チャイの
 * デモデータ）は、利用者がデモを明示選択した場合にだけ main.js が使う。
 * モデルフォールバックは HowLink の「見せる」高速化と同じ処方:
 * 軽量モデル（lite）を先頭に試し、モデルごとのタイムアウトと全体デッドラインで
 * 応答の遅いモデルに引きずられないようにする。400/404/429/503 とタイムアウトで次へ。
 *
 * 【再発防止】thinking 制御のパラメータはモデル世代で異なる（混在させると 400）:
 * - Gemini 3 系（gemini-3* / gemini-flash-latest）→ thinkingLevel を使う。
 *   2.5 系の thinkingBudget を送ると、モデルにより 400 INVALID_ARGUMENT になる
 *   （2026-11-22 実機で gemini-3.5-flash-lite が thinkingBudget: 0 を拒否し、
 *   当時の即時 throw のためフォールバックも効かず全体が失敗した）。
 * - Gemini 2.5 系 → thinkingBudget を使う。thinkingLevel を送ると 400 になる。
 * 世代の判定は thinkingConfigFor() に集約してある。パラメータを一律に送らないこと。
 * また、モデルごとの仕様差は今後も起こりうるため、400 でも次のモデルへ進む。
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
// モデルごとのタイムアウト(ms)。MODEL_CANDIDATES と同じ順序。
// CultureLens は日英バイリンガルJSON（maxOutputTokens 3200）を返す重い呼び出しのため、
// HowLink の処方（[8000, 9000, 5000, 4000]）より各値を長めに取る:
// 先頭の lite は「速さ優先だが生成量は多い」ので 12s、2番手 flash は品質本命として 15s、
// 後段は保険として短めにし、全体デッドライン 45s で必ず打ち切る。
const MODEL_TIMEOUTS_MS = [12000, 15000, 10000, 8000, 10000];
const OVERALL_DEADLINE_MS = 45000;
const KEY_STORAGE = 'etw_gemini_api_key';
const MODEL_STORAGE = 'etw_gemini_model';

export function getApiKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
export function hasApiKey() { return !!getApiKey(); }
// キー未設定でAI生成が呼ばれたことを示すエラー（B-9 キーレス分離）。
// 呼び出し側はこれを「AI生成は追加機能で、キーが必要」という案内に変える。
// 登録スポットの表示はこのエラーの対象外（キーに依存しない）。
export function apiKeyRequiredError() {
  const e = new Error('APIキー未設定のため、AI生成は利用できません');
  e.code = 'API_KEY_REQUIRED';
  return e;
}
export function setApiKey(k) { localStorage.setItem(KEY_STORAGE, k); localStorage.removeItem(MODEL_STORAGE); }

export const EXTENDED_TRANSLATION_PROMPT = `
あなたは「拡張翻訳」エンジンです。入力は (1) 現地の景色・モノを写した画像、(2) 語り手が自分の言葉（日本語）で語ったテキストです。
受け手は英語圏の一般生活者です。Google翻訳やGoogleレンズのような「正確だが無難で退屈な説明」は禁止です。

やること:
1. literal_translation: 語り手の言葉の忠実な英訳。言葉がない場合は空文字にする。
2. extended_translation: 感情と文脈が伝わる英語の字幕（2文以内）。語り手の声の温度を残すこと。ただし下記の【事実の扱い】を厳守すること。
3. tags: 画像の中のモノ・風景について2〜4個。各タグには、その文化でそれが大切な理由（why_it_matters）と、受け手の日常と接続する一文を含める。x,y は画像内の位置（0〜1）。
4. cultural_gap: 受け手が最も驚く異文化のギャップを「1つだけ」選んで書く（情報ギャップ理論：落差は1つに絞るほど好奇心が強くなる）。
5. curiosity_hook: 読んだ人が次に質問したくなる「問い」を1文で。
6. speaker_emotion: 語り手の感情を英語1語＋短い根拠。言葉がない場合は推定せず、空文字にする。
7. 日本語版: 英語フィールドそれぞれに対応する自然な日本語版も返す。literal_translation_ja は literal_translation に対応する日本語（語り手の言葉を整えた文でよい）。extended_translation_ja は extended_translation の感情と文脈を保った日本語（字幕調、2文以内）。tags の各要素には title_ja / description_ja / why_it_matters_ja を付ける。cultural_gap_ja / curiosity_hook_ja も同様に付ける。日本語版にも【事実の扱い】を厳守すること（英語版にない来歴や事情を日本語版で足さない）。

【事実の扱い（最重要）】
- 事実として書いてよいのは、(a) 語り手の言葉に実際に含まれていること、(b) 画像に実際に写っていること、の2種類だけ。加えて、対象物そのものに関する文化・歴史の一般知識は補ってよい。
- 語り手の個人的な来歴（誰の家か、誰にもらったか、いつ・どこで手に入れたか、家族との思い出など）は、言葉に明示されていない限り絶対に創作しない。"my grandmother's house" のような一人称のエピソードも作らない。
- 言葉がない場合は、語り手の感情・事情・来歴を推定しない。extended_translation は画像の事実と文化的文脈だけで構成する。
- 受け手の日常との接続は「〜に相当する」「〜のようなものだ」という比喩・例えの形でのみ行い、語り手側の事実として書かない。

必ず次のJSON形式だけで答えてください:
{"literal_translation":"","extended_translation":"","literal_translation_ja":"","extended_translation_ja":"","speaker_emotion":"","scene_summary":"","tags":[{"title":"","title_ja":"","x":0.5,"y":0.5,"description":"","description_ja":"","why_it_matters":"","why_it_matters_ja":""}],"cultural_gap":"","cultural_gap_ja":"","curiosity_hook":"","curiosity_hook_ja":""}
`.trim();

/* ---------- 出力言語の切り替え（2-11） ----------
   表示言語が zh / ko のときは、英日バイリンガルJSONではなく、その言語の
   単一言語JSONを返すよう指示する。en / ja のときは従来の
   EXTENDED_TRANSLATION_PROMPT のまま（二言語JSONの挙動は変えない）。
   表示側（main.js）は主フィールド（_ja でない側）を読むため、zh/ko の
   結果は主フィールドに当該言語のテキストが入る形でそのまま描画できる。 */
const TARGET_LANG_NAMES = { zh: '簡体字中国語', ko: '韓国語' };
const TARGET_LANG_JSON = '{"literal_translation":"","extended_translation":"","speaker_emotion":"","scene_summary":"","tags":[{"title":"","x":0.5,"y":0.5,"description":"","why_it_matters":""}],"cultural_gap":"","curiosity_hook":""}';

function buildTargetLangPrompt(lang) {
  const name = TARGET_LANG_NAMES[lang];
  return `
あなたは「拡張翻訳」エンジンです。入力は (1) 現地の景色・モノを写した画像、(2) 語り手が自分の言葉（日本語）で語ったテキストです。
受け手は${name}を母語とする一般生活者です。Google翻訳やGoogleレンズのような「正確だが無難で退屈な説明」は禁止です。

出力言語: テキストフィールドはすべて${name}で書いてください。日本語版フィールド（_ja サフィックス）は返さないでください。

やること:
1. literal_translation: 語り手の言葉の忠実な${name}訳。言葉がない場合は空文字にする。
2. extended_translation: 感情と文脈が伝わる${name}の字幕（2文以内）。語り手の声の温度を残すこと。ただし下記の【事実の扱い】を厳守すること。
3. tags: 画像の中のモノ・風景について2〜4個。各タグには、その文化でそれが大切な理由（why_it_matters）と、受け手の日常と接続する一文を含める。x,y は画像内の位置（0〜1）。
4. cultural_gap: 受け手が最も驚く異文化のギャップを「1つだけ」選んで書く（情報ギャップ理論：落差は1つに絞るほど好奇心が強くなる）。
5. curiosity_hook: 読んだ人が次に質問したくなる「問い」を1文で。
6. speaker_emotion: 語り手の感情を${name}で1語＋短い根拠。言葉がない場合は推定せず、空文字にする。

【事実の扱い（最重要）】
- 事実として書いてよいのは、(a) 語り手の言葉に実際に含まれていること、(b) 画像に実際に写っていること、の2種類だけ。加えて、対象物そのものに関する文化・歴史の一般知識は補ってよい。
- 語り手の個人的な来歴（誰の家か、誰にもらったか、いつ・どこで手に入れたか、家族との思い出など）は、言葉に明示されていない限り絶対に創作しない。一人称のエピソードも作らない。
- 言葉がない場合は、語り手の感情・事情・来歴を推定しない。extended_translation は画像の事実と文化的文脈だけで構成する。
- 受け手の日常との接続は「〜に相当する」「〜のようなものだ」という比喩・例えの形でのみ行い、語り手側の事実として書かない。

必ず次のJSON形式だけで答えてください:
${TARGET_LANG_JSON}
`.trim();
}

/**
 * プロンプトを組み立てる純粋関数（単体確認用に公開）。
 * lang が 'zh' / 'ko' のときだけ単一言語プロンプトに切り替わり、
 * それ以外（'en' / 'ja' / 未指定）は従来プロンプトと完全に同一になる。
 */
export function buildPrompt(transcript, lang) {
  const base = (lang === 'zh' || lang === 'ko') ? buildTargetLangPrompt(lang) : EXTENDED_TRANSLATION_PROMPT;
  return `${base}\n\n語り手の言葉（日本語）: ${transcript || '（言葉なし）'}`;
}

export const MOCK_RESULT = {
  literal_translation: "This is masala chai made from whole spices. On cold days, holding the cup with both hands is our family's winter ritual.",
  extended_translation: "He doesn't buy tea bags. He crushes whole spices by hand — because in his home, warmth is something you make, not something you buy.",
  literal_translation_ja: "これはホールスパイスから作るマサラチャイです。寒い日は、両手でカップを持つのが我が家の冬の習慣です。",
  extended_translation_ja: "彼はティーバッグを買わない。ホールスパイスを手で砕く。彼の家では、温かさは買うものではなく、作るものだからだ。",
  speaker_emotion: "proud — he slows down when describing the two-handed grip on the cup",
  scene_summary: "A small home kitchen; a pot of masala chai simmering, whole spices beside it.",
  tags: [
    { title: "Masala chai from whole spices", title_ja: "ホールスパイスのマサラチャイ", x: 0.45, y: 0.55, description: "Cardamom, cloves and ginger, crushed just before brewing — never pre-mixed powder.", description_ja: "カルダモン、クローブ、生姜を、淹れる直前に砕く。混ぜ合わせ済みの粉は使わない。", why_it_matters: "Grinding spices by hand is a small daily act of care; the aroma is the signal that 'someone is home'.", why_it_matters_ja: "スパイスを手で砕くのは、日々の小さな手入れ。その香りが『誰かが家にいる』合図になる。" },
    { title: "The two-handed cup", title_ja: "両手で持つカップ", x: 0.6, y: 0.7, description: "Holding a hot cup with both palms is a winter habit across Japan, for tea and soup alike.", description_ja: "熱いカップを両手のひらで包むのは、日本中で見られる冬の習慣。お茶でも汁物でも同じだ。", why_it_matters: "Warmth through the palms is treated as comfort itself — the drink is almost an excuse.", why_it_matters_ja: "手のひらの温かさ自体が心地よさとして扱われる。飲み物は、ほとんど口実にすぎない。" },
  ],
  cultural_gap: "In Japan, a drink can be a hand-warmer first and a beverage second — convenience stores even sell hot canned drinks purely to hold on cold train platforms.",
  curiosity_hook: "What everyday object in your home would carry this much memory for you?",
  cultural_gap_ja: "日本では、飲み物はまず『手を温めるもの』で、次に飲み物であることがある。コンビニでは、寒い駅のホームで持つためだけに、温かい缶飲料が売られている。",
  curiosity_hook_ja: "あなたの家で、これほど記憶を背負った日用品は何ですか？",
  source: 'mock',
};

// thinking 制御は世代ごとに片方だけを送る（両方送る／違う世代のものを送ると 400）。
function thinkingConfigFor(model) {
  if (model.includes('2.5')) return { thinkingBudget: 0 }; // Gemini 2.5 系
  if (model.startsWith('gemini-3') || model === 'gemini-flash-latest') return { thinkingLevel: 'minimal' }; // Gemini 3 系
  return { thinkingLevel: 'minimal' }; // 未知のモデルは現行世代（3系）側に倒す
}

async function callModel(model, key, parts, timeoutMs) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 3200, thinkingConfig: thinkingConfigFor(model) },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const ej = (await res.json())?.error;
        detail = ej?.message || '';
        // 400 の message は「Request contains an invalid argument.」だけで項目名を含まないため、
        // details 側の fieldViolations があれば併記して原因項目が分かるようにする
        const fv = (ej?.details || []).flatMap((d) => d.fieldViolations || []).map((v) => `${v.field}: ${v.description}`).join('; ');
        if (fv) detail += ` [${fv}]`;
      } catch { /* noop */ }
      const err = new Error(`Gemini API error: ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = JSON.parse(raw);
    parsed.source = `gemini (${model})`;
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Gemini timeout: ${model} (${timeoutMs}ms)`);
      e.timeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{mimeType:string, data:string}} frame Base64フレーム
 * @param {string} transcript 語り手の言葉
 * @param {{lang?:string}} [options] 出力言語（'zh'/'ko' で単一言語出力に切替。
 *        'en'/'ja'/未指定は従来の英日バイリンガルJSON）
 * @returns {Promise<object>} 拡張翻訳JSON
 */
export async function extendedTranslate(frame, transcript, options) {
  const key = getApiKey();
  // B-9: キー未設定のときモックを本物の結果らしく返さない。
  // デモ表示は main.js 側で「デモデータで試す」が明示選択された場合のみ行う。
  if (!key) throw apiKeyRequiredError();
  const parts = [
    { text: buildPrompt(transcript, options && options.lang) },
    { inline_data: { mime_type: frame.mimeType, data: frame.data } },
  ];
  // 毎回 lite-first の順序で先頭から試す（HowLink の saveModel:false と同じ考え方）。
  // 成功したモデルは MODEL_STORAGE に「記録」だけし、次回の開始モデルには使わない
  // （重いモデルが保存されていると、毎回そのモデルから始まって遅くなるため）。
  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  let lastError = null;
  for (let i = 0; i < MODEL_CANDIDATES.length; i++) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const model = MODEL_CANDIDATES[i];
    try {
      const out = await callModel(model, key, parts, Math.min(MODEL_TIMEOUTS_MS[i], remain));
      localStorage.setItem(MODEL_STORAGE, model);
      return out;
    } catch (err) {
      lastError = err;
      if (err.timeout) continue;
      // 400 も次へ: モデルごとのパラメータ仕様差（thinkingConfig 等）で 400 になっても、
      // 他のモデルなら通ることがあるため、1モデルの 400 で全体を落とさない。
      if (![400, 404, 429, 503].includes(err.status)) throw err;
    }
  }
  throw lastError || new Error('拡張翻訳がタイムアウトしました');
}
