/**
 * i18n.js ― 表示言語の基盤（2-11：表示の4言語対応 E-24、アプリ側）
 *
 * CultureLens B2B：対応言語を en / zh（簡体字）/ ko / ja の4つに統一する
 * 単一の置き場。ここが担うのは「アプリ側」の範囲：
 * - 言語コードの正規化（zh-Hans / zh-CN / ko-KR 等の揺れを寄せる）
 * - フォールバック順の定義（要求言語 → 施設の既定言語 → en）
 * - B2Bで追加した表示面（施設パネル／スポット案内／実務情報／出典バッジ／
 *   キーレス案内／ステータス）の文面テーブル
 * - アレルゲン名称（日本の食品表示の対象品目）の4言語表記
 * 登録コンテンツの中・韓「制作」は後段リストであり、ここには含まない。
 * パックに zh/ko ブロックがあればそのまま表示され、無ければ
 * pickContent / pack-loader の decideDisplay が既定言語へ落とす。
 *
 * 純粋な定義と関数だけを持ち、DOM・ストレージには触らない。
 * ブラウザでは window.CultureLensI18n として公開し、Node では
 * module.exports する（facility-context.js と同じ形）。
 */
(function (global) {
  'use strict';

  var SUPPORTED_LANGS = ['en', 'zh', 'ko', 'ja'];
  var DEFAULT_LANG = 'en';

  // 言語選択UIに出す自称表記
  var LANG_LABELS = {
    en: 'English',
    zh: '简体中文',
    ko: '한국어',
    ja: '日本語',
  };
  // 言語チップに出す短い表記
  var LANG_SHORT = {
    en: 'EN',
    zh: '中文',
    ko: '한국어',
    ja: 'あ',
  };
  // 読み上げ（SpeechSynthesis）のロケール
  var SPEECH_LOCALES = {
    en: 'en-US',
    zh: 'zh-CN',
    ko: 'ko-KR',
    ja: 'ja-JP',
  };

  /**
   * 言語コードの揺れを対応言語へ寄せる。対応外は null。
   * 例: 'zh-Hans' 'zh-CN' 'zh-TW' 'zh' → 'zh'、'ko-KR' → 'ko'、
   *     'ja-JP' → 'ja'、'en-US' 'EN' → 'en'、'fr' → null
   */
  function normalizeLang(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim().toLowerCase().replace(/_/g, '-');
    if (!v) return null;
    var primary = v.split('-')[0];
    return SUPPORTED_LANGS.indexOf(primary) >= 0 ? primary : null;
  }

  function isSupportedLang(value) {
    return normalizeLang(value) !== null;
  }

  /**
   * フォールバック順を返す（重複なし）。
   * 要求言語 → 施設の既定言語 → en の順。どちらも正規化してから並べる。
   * 例: fallbackChain('ko', 'ja') → ['ko', 'ja', 'en']
   */
  function fallbackChain(lang, defaultLang) {
    var chain = [];
    var items = [normalizeLang(lang), normalizeLang(defaultLang), DEFAULT_LANG];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && chain.indexOf(items[i]) < 0) chain.push(items[i]);
    }
    return chain;
  }

  /**
   * 言語別ブロック（パックの content や施設名など）から、フォールバック順で
   * 最初に存在するブロックを選ぶ。pack-loader の decideDisplay の
   * 言語選択と同じ意味（要求→既定→en→どれか1つ）。
   * @returns {{block:*, lang:string}|null}
   */
  function pickContent(blocks, lang, defaultLang) {
    if (!blocks || typeof blocks !== 'object') return null;
    var chain = fallbackChain(lang, defaultLang);
    for (var i = 0; i < chain.length; i++) {
      if (blocks[chain[i]]) return { block: blocks[chain[i]], lang: chain[i] };
    }
    var keys = Object.keys(blocks);
    for (var j = 0; j < keys.length; j++) {
      if (blocks[keys[j]]) return { block: blocks[keys[j]], lang: keys[j] };
    }
    return null;
  }

  /* ---------- 文面テーブル（B2B表示面） ----------
     {name} は差し込み位置。値が欠けた言語は en に倒れる（t() 側）。 */
  var STRINGS = {
    /* キーレス案内（B-9） */
    keyless_notice_facility: {
      en: 'Registered spots at this facility are shown without an API key. AI-generated translation is an add-on feature (a Gemini API key is required to use it).',
      zh: '本设施的登记景点无需 API 密钥即可显示。AI 扩展翻译是附加功能（使用时需要 Gemini API 密钥）。',
      ko: '이 시설의 등록 스팟은 API 키 없이 표시할 수 있습니다. AI 확장 번역은 추가 기능입니다(이용하려면 Gemini API 키가 필요합니다).',
      ja: 'この施設の登録スポットは、APIキーなしで表示できます。AIによる拡張翻訳は追加機能です（利用にはGemini APIキーが必要です）。',
    },
    keyless_notice_plain: {
      en: 'AI-generated translation is an add-on feature and needs a Gemini API key (add one from Settings, top right). Registered spots are shown without a key.',
      zh: 'AI 扩展翻译是附加功能，使用时需要 Gemini API 密钥（可在右上角“设置”中添加）。登记景点无需密钥即可显示。',
      ko: 'AI 확장 번역은 추가 기능이며 Gemini API 키가 필요합니다(오른쪽 위 “설정”에서 등록할 수 있습니다). 등록 스팟은 키 없이 표시됩니다.',
      ja: 'AIによる拡張翻訳は追加機能です。利用にはGemini APIキーが必要です（右上の「設定」から登録できます）。登録スポットの表示にはキーは不要です。',
    },
    key_required_status_registered: {
      en: 'Showing registered spots. AI generation needs an API key.',
      zh: '正在显示登记景点。AI 生成需要 API 密钥。',
      ko: '등록 스팟을 표시하고 있습니다. AI 생성에는 API 키가 필요합니다.',
      ja: '登録スポットを表示しています。AI生成にはAPIキーが必要です',
    },
    key_required_status: {
      en: 'AI generation needs an API key. Registered spots are shown without a key.',
      zh: 'AI 生成需要 API 密钥。登记景点无需密钥即可显示。',
      ko: 'AI 생성에는 API 키가 필요합니다. 등록 스팟은 키 없이 표시할 수 있습니다.',
      ja: 'AI生成にはAPIキーが必要です。登録スポットはキーなしで表示できます',
    },
    /* スポット案内（廃止・停止・未公開・未登録） */
    guidance_retired_title: {
      en: 'This spot has ended',
      zh: '该景点已结束',
      ko: '이 스팟은 종료되었습니다',
      ja: 'このスポットは終了しました',
    },
    guidance_retired_text: {
      en: 'Guidance for this spot has ended. You can see the facility’s other spots from the list.',
      zh: '该景点的介绍已结束。您可以从列表查看本设施的其他景点。',
      ko: '이 스팟의 안내는 종료되었습니다. 시설의 다른 스팟은 목록에서 보실 수 있습니다.',
      ja: 'このスポットのご案内は終了しました。施設の他のスポットは一覧からご覧いただけます。',
    },
    guidance_suspended_title: {
      en: 'Guidance is currently paused',
      zh: '目前暂停介绍',
      ko: '현재 안내를 중지하고 있습니다',
      ja: '現在ご案内を停止しています',
    },
    guidance_suspended_text: {
      en: 'Guidance for this spot is currently paused. You can see the facility’s other spots from the list.',
      zh: '该景点目前暂停介绍。您可以从列表查看本设施的其他景点。',
      ko: '이 스팟은 현재 안내를 중지하고 있습니다. 시설의 다른 스팟은 목록에서 보실 수 있습니다.',
      ja: 'このスポットは現在ご案内を停止しています。施設の他のスポットは一覧からご覧いただけます。',
    },
    guidance_not_found_title: {
      en: 'Spot not found',
      zh: '未找到该景点',
      ko: '스팟을 찾을 수 없습니다',
      ja: 'スポットが見つかりません',
    },
    guidance_not_published_text: {
      en: 'This spot is not currently published.',
      zh: '该景点目前尚未公开。',
      ko: '이 스팟은 현재 공개되어 있지 않습니다.',
      ja: 'このスポットは現在公開されていません。',
    },
    guidance_spot_unregistered_text: {
      en: 'The spot for this QR code is not registered.',
      zh: '该二维码的景点尚未登记。',
      ko: '이 QR코드의 스팟은 등록되어 있지 않습니다.',
      ja: 'このQRコードのスポットは登録されていません。',
    },
    guidance_facility_not_found_title: {
      en: 'Facility not found',
      zh: '未找到该设施',
      ko: '시설을 찾을 수 없습니다',
      ja: '施設が見つかりません',
    },
    guidance_facility_unregistered_text: {
      en: 'This facility is not registered.',
      zh: '该设施尚未登记。',
      ko: '이 시설은 등록되어 있지 않습니다.',
      ja: 'この施設は登録されていません。',
    },
    /* 実務情報（A-5）のラベル */
    practical_title: {
      en: 'Practical information',
      zh: '实用信息',
      ko: '실용 정보',
      ja: '実務情報',
    },
    price_label: {
      en: 'Price',
      zh: '价格',
      ko: '가격',
      ja: '価格',
    },
    tax_included: {
      en: '(tax incl.)',
      zh: '（含税）',
      ko: '(세금 포함)',
      ja: '（税込）',
    },
    allergens_label: {
      en: 'Allergens',
      zh: '过敏原',
      ko: '알레르기',
      ja: 'アレルギー',
    },
    dietary_label: {
      en: 'Dietary',
      zh: '饮食对应',
      ko: '식이 대응',
      ja: '嗜好対応',
    },
    dietary_vegetarian: {
      en: 'vegetarian',
      zh: '素食（蛋奶素）',
      ko: '베지테리언',
      ja: 'ベジタリアン対応',
    },
    dietary_vegan: {
      en: 'vegan',
      zh: '纯素',
      ko: '비건',
      ja: 'ヴィーガン対応',
    },
    dietary_halal: {
      en: 'halal',
      zh: '清真',
      ko: '할랄',
      ja: 'ハラル',
    },
    last_confirmed_label: {
      en: 'Last confirmed',
      zh: '最后确认日期',
      ko: '최종 확인일',
      ja: '最終確認日',
    },
    /* 出典バッジ（2-6） */
    badge_supervised: {
      en: '✓ Verified by the shop / facility',
      zh: '✓ 已由店铺・设施审核',
      ko: '✓ 매장・시설 감수 완료',
      ja: '✓ 店舗・施設監修済み',
    },
    badge_registered: {
      en: 'Registered content',
      zh: '登记内容',
      ko: '등록 콘텐츠',
      ja: '登録コンテンツ',
    },
    badge_ai: {
      en: 'AI-generated',
      zh: 'AI 生成',
      ko: 'AI 생성',
      ja: 'AI生成',
    },
    badge_demo: {
      en: 'Demo data',
      zh: '演示数据',
      ko: '데모 데이터',
      ja: 'デモデータ',
    },
    badge_preview: {
      en: '👀 Preview (not published)',
      zh: '👀 预览（未公开）',
      ko: '👀 미리보기(미공개)',
      ja: '👀 プレビュー（未公開）',
    },
    /* ステータス表示 */
    status_registered: {
      en: 'Showing a registered spot',
      zh: '正在显示登记景点',
      ko: '등록 스팟을 표시 중',
      ja: '登録スポットを表示中',
    },
    status_fallback_lang: {
      en: 'Registered content in this language is not ready yet, so the default language is shown.',
      zh: '该语言的登记内容尚在准备中，现以默认语言显示。',
      ko: '이 언어의 등록 콘텐츠가 준비 중이어서 기본 언어로 표시하고 있습니다.',
      ja: 'この言語の登録コンテンツは準備中のため、既定言語で表示しています',
    },
    status_guidance: {
      en: 'Showing spot guidance',
      zh: '正在显示景点指南',
      ko: '스팟 안내를 표시 중',
      ja: 'スポットの案内表示中',
    },
    status_not_published: {
      en: 'This spot is not published',
      zh: '该景点尚未公开',
      ko: '이 스팟은 공개되어 있지 않습니다',
      ja: 'スポットは公開されていません',
    },
    status_not_registered_spot: {
      en: 'This spot is not registered',
      zh: '该景点尚未登记',
      ko: '이 스팟은 등록되어 있지 않습니다',
      ja: 'スポットは登録されていません',
    },
    status_facility_mode: {
      en: 'Showing in facility mode',
      zh: '以设施模式显示中',
      ko: '시설 모드로 표시 중',
      ja: '施設モードで表示中',
    },
    status_pack_load_failed: {
      en: 'Could not load facility information',
      zh: '无法加载设施信息',
      ko: '시설 정보를 불러올 수 없었습니다',
      ja: '施設情報を読み込めませんでした',
    },
    status_qr_reading: {
      en: 'QR code read. Loading the spot…',
      zh: '已读取二维码。正在加载景点…',
      ko: 'QR코드를 읽었습니다. 스팟을 표시하고 있습니다…',
      ja: 'QRコードを読み取りました。スポットを表示しています…',
    },
    status_qr_load_failed: {
      en: 'Could not load the spot for this QR code',
      zh: '无法加载该二维码的景点信息',
      ko: 'QR의 스팟 정보를 불러올 수 없었습니다',
      ja: 'QRのスポット情報を読み込めませんでした',
    },
    status_not_registered_ai_hint: {
      en: 'This is not a registered spot. You can use AI generation (add-on feature) for an extended translation.',
      zh: '这不是登记景点。可以使用 AI 生成（附加功能）进行扩展翻译。',
      ko: '등록 스팟이 아닙니다. AI 생성(추가 기능)으로 확장 번역할 수 있습니다.',
      ja: '登録スポットではありません。AI生成（追加機能）で拡張翻訳できます',
    },
    /* プレビュー（4-3、事業者の公開前確認） */
    status_preview: {
      en: 'Showing a preview of an unpublished spot',
      zh: '正在显示未公开景点的预览',
      ko: '미공개 스팟의 미리보기를 표시 중',
      ja: '未公開スポットのプレビューを表示中',
    },
    preview_panel_draft: {
      en: '(draft)',
      zh: '（草稿）',
      ko: '(초안)',
      ja: '（下書き）',
    },
    /* 比較ビュー（5-4、デモ用：直訳だけ vs 拡張翻訳） */
    demo_compare_open: {
      en: '🆚 Compare literal vs extended (demo)',
      zh: '🆚 对比直译与扩展翻译（演示）',
      ko: '🆚 직역과 확장 번역 비교 (데모)',
      ja: '🆚 直訳と拡張翻訳を見比べる（デモ用）',
    },
    demo_compare_title: {
      en: 'Literal translation vs Extended translation',
      zh: '直译与扩展翻译的对比',
      ko: '직역과 확장 번역 비교',
      ja: '直訳と拡張翻訳の比較',
    },
    demo_compare_banner: {
      en: '🧪 Demo comparison view — regular visitors never see this screen.',
      zh: '🧪 演示用对比显示——普通访客不会看到此画面。',
      ko: '🧪 데모용 비교 표시 — 일반 방문자에게는 보이지 않는 화면입니다.',
      ja: '🧪 デモ用比較表示 ― 通常の来訪者には表示されない画面です',
    },
    demo_compare_literal: {
      en: 'Literal translation only',
      zh: '仅直译',
      ko: '직역만',
      ja: '直訳だけ',
    },
    demo_compare_extended: {
      en: 'Extended translation',
      zh: '扩展翻译',
      ko: '확장 번역',
      ja: '拡張翻訳',
    },
    demo_compare_scene: {
      en: 'Scene',
      zh: '场景',
      ko: '장면',
      ja: '場面',
    },
    demo_compare_tags: {
      en: 'Cultural background tags',
      zh: '文化背景标签',
      ko: '문화 배경 태그',
      ja: '文化背景タグ',
    },
    demo_compare_gap: {
      en: '🧳 Cultural gap',
      zh: '🧳 文化差异',
      ko: '🧳 문화적 차이',
      ja: '🧳 異なる文化とのギャップ',
    },
    demo_compare_hook: {
      en: '🗺️ Curiosity hook',
      zh: '🗺️ 激发好奇心的一点',
      ko: '🗺️ 호기심을 끄는 한마디',
      ja: '🗺️ もっと知りたくなる好奇心フック',
    },
    demo_compare_why: {
      en: 'Why it matters',
      zh: '为何重要',
      ko: '왜 중요한가',
      ja: 'なぜ大切か',
    },
    demo_compare_close: {
      en: 'Back to normal view',
      zh: '返回普通显示',
      ko: '일반 표시로 돌아가기',
      ja: '通常表示に戻る',
    },
    /* 誤り報告（2-15、F-31） */
    report_open: {
      en: '⚠ Report an error in this content',
      zh: '⚠ 报告内容错误',
      ko: '⚠ 내용 오류 신고',
      ja: '⚠ 内容の誤りを報告',
    },
    report_title: {
      en: 'Report an error',
      zh: '报告错误',
      ko: '오류 신고',
      ja: '内容の誤りを報告する',
    },
    report_intro: {
      en: 'If something shown here is wrong — a price, allergen information, a translation — please let us know. Reports are anonymous.',
      zh: '如果此处显示的内容有误——如价格、过敏原信息、翻译——请告诉我们。报告为匿名提交。',
      ko: '여기에 표시된 내용에 잘못이 있으면(가격, 알레르기 정보, 번역 등) 알려 주세요. 신고는 익명으로 접수됩니다.',
      ja: '表示されている内容に誤り（価格・アレルギー情報・翻訳など）がありましたらお知らせください。報告は匿名で送られます。',
    },
    report_target_label: {
      en: 'What the report is about',
      zh: '报告对象',
      ko: '신고 대상',
      ja: '報告の対象',
    },
    report_target_registered: {
      en: 'Registered content',
      zh: '登记内容',
      ko: '등록 콘텐츠',
      ja: '登録コンテンツ',
    },
    report_target_ai: {
      en: 'AI-generated content',
      zh: 'AI 生成内容',
      ko: 'AI 생성 내용',
      ja: 'AI生成の内容',
    },
    report_target_practical: {
      en: 'Practical info (price, allergens…)',
      zh: '实用信息（价格、过敏原等）',
      ko: '실용 정보(가격, 알레르기 등)',
      ja: '実務情報（価格・アレルギー等）',
    },
    report_target_other: {
      en: 'Other',
      zh: '其他',
      ko: '기타',
      ja: 'その他',
    },
    report_category_label: {
      en: 'Type of error',
      zh: '错误类型',
      ko: '오류 종류',
      ja: '誤りの種類',
    },
    report_category_price: {
      en: 'Price',
      zh: '价格',
      ko: '가격',
      ja: '価格',
    },
    report_category_allergen: {
      en: 'Allergens / dietary',
      zh: '过敏原・饮食对应',
      ko: '알레르기・식이 대응',
      ja: 'アレルギー・嗜好対応',
    },
    report_category_hours: {
      en: 'Hours / availability',
      zh: '营业时间等',
      ko: '영업시간 등',
      ja: '営業時間など',
    },
    report_category_translation: {
      en: 'Translation',
      zh: '翻译',
      ko: '번역',
      ja: '翻訳',
    },
    report_category_content: {
      en: 'Factual error in the content',
      zh: '内容与事实不符',
      ko: '내용의 사실 오류',
      ja: '内容の事実誤り',
    },
    report_category_other: {
      en: 'Other',
      zh: '其他',
      ko: '기타',
      ja: 'その他',
    },
    report_reporter_label: {
      en: 'You are',
      zh: '您的身份',
      ko: '신고자 구분',
      ja: '報告者',
    },
    report_reporter_visitor: {
      en: 'A visitor',
      zh: '访客',
      ko: '방문객',
      ja: '来訪者',
    },
    report_reporter_business: {
      en: 'The shop / facility',
      zh: '店铺・设施方',
      ko: '매장・시설 측',
      ja: '店舗・施設の関係者',
    },
    report_text_label: {
      en: 'Details (optional, up to 500 characters)',
      zh: '详细内容（可选，最多500字）',
      ko: '자세한 내용 (선택, 최대 500자)',
      ja: '詳しい内容（任意・500字まで）',
    },
    report_text_placeholder: {
      en: 'e.g. The price shown is different from the menu.',
      zh: '例如：显示的价格与菜单不一致。',
      ko: '예: 표시된 가격이 메뉴와 다릅니다.',
      ja: '例：表示されている価格がメニューと違います',
    },
    report_privacy_note: {
      en: 'Please do not include personal information such as your name or contact details.',
      zh: '请勿填写姓名、联系方式等个人信息。',
      ko: '이름이나 연락처 등 개인정보는 적지 마세요.',
      ja: 'お名前や連絡先などの個人情報は書かないでください。',
    },
    report_send: {
      en: 'Send report',
      zh: '发送报告',
      ko: '신고 보내기',
      ja: '報告を送信する',
    },
    report_sending: {
      en: 'Sending…',
      zh: '发送中…',
      ko: '보내는 중…',
      ja: '送信中…',
    },
    report_sent: {
      en: 'Thank you — your report has been received.',
      zh: '感谢您，报告已收到。',
      ko: '감사합니다. 신고가 접수되었습니다.',
      ja: 'ありがとうございます。報告を受け付けました。',
    },
    report_failed: {
      en: 'Could not send the report. Please check your connection and try again.',
      zh: '报告发送失败。请检查网络后重试。',
      ko: '신고를 보내지 못했습니다. 연결을 확인하고 다시 시도해 주세요.',
      ja: '報告を送信できませんでした。通信環境を確認してもう一度お試しください。',
    },
    report_close: {
      en: 'Close',
      zh: '关闭',
      ko: '닫기',
      ja: '閉じる',
    },
  };

  /* ---------- アレルゲン名称（日本の食品表示の対象品目） ----------
     コードは実務情報の allergens 配列の値。表示名は一般的な訳語。 */
  var ALLERGENS = {
    shrimp: { en: 'Shrimp', zh: '虾', ko: '새우', ja: 'えび' },
    wheat: { en: 'Wheat', zh: '小麦', ko: '밀', ja: '小麦' },
    egg: { en: 'Egg', zh: '鸡蛋', ko: '달걀', ja: '卵' },
    milk: { en: 'Milk', zh: '牛奶', ko: '우유', ja: '乳' },
    peanut: { en: 'Peanut', zh: '花生', ko: '땅콩', ja: '落花生（ピーナッツ）' },
    buckwheat: { en: 'Buckwheat', zh: '荞麦', ko: '메밀', ja: 'そば' },
    crab: { en: 'Crab', zh: '蟹', ko: '게', ja: 'かに' },
    walnut: { en: 'Walnut', zh: '核桃', ko: '호두', ja: 'くるみ' },
    soy: { en: 'Soybeans', zh: '大豆', ko: '대두', ja: '大豆' },
  };

  /**
   * 文面を引く。言語は正規化し、欠けた言語は en に倒れる。
   * params の {name} を差し込む。
   */
  function t(lang, key, params) {
    var entry = STRINGS[key];
    if (!entry) return key;
    var l = normalizeLang(lang) || DEFAULT_LANG;
    var text = entry[l] || entry[DEFAULT_LANG] || '';
    if (params) {
      text = text.replace(/\{(\w+)\}/g, function (m, name) {
        return params[name] !== undefined ? String(params[name]) : m;
      });
    }
    return text;
  }

  /** アレルゲンの表示名。未知のコードはそのまま返す。 */
  function allergenLabel(code, lang) {
    var entry = ALLERGENS[code];
    if (!entry) return code;
    var l = normalizeLang(lang) || DEFAULT_LANG;
    return entry[l] || entry[DEFAULT_LANG] || code;
  }

  var api = {
    SUPPORTED_LANGS: SUPPORTED_LANGS,
    DEFAULT_LANG: DEFAULT_LANG,
    LANG_LABELS: LANG_LABELS,
    LANG_SHORT: LANG_SHORT,
    SPEECH_LOCALES: SPEECH_LOCALES,
    STRINGS: STRINGS,
    ALLERGENS: ALLERGENS,
    normalizeLang: normalizeLang,
    isSupportedLang: isSupportedLang,
    fallbackChain: fallbackChain,
    pickContent: pickContent,
    t: t,
    allergenLabel: allergenLabel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CultureLensI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
