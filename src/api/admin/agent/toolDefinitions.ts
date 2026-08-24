// src/api/admin/agent/toolDefinitions.ts
// Phase B-Admin: AIエージェント用ツール定義（Groq function calling 形式）

import { FAQ_CATEGORY_IDS } from '../../../lib/knowledge/faqCategories';

export interface GroqTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * get_legacy_ui_link が案内できる旧管理画面の機能キー。
 *
 * 下の get_legacy_ui_link 定義の enum から参照し、計測側
 * （agentRoutes.ts の agent_legacy_handoff ラベル語彙）もこの配列を import する。
 * 旧UIページの閉鎖でここから値を削除すると、モデルがその feature を渡せなくなり、
 * 万一渡しても計測側は自動的に 'unknown' へ丸める（docs/LEGACY_UI_SUNSET.md が
 * 閉鎖後のトリップワイヤーとして依存している挙動）。値を二重管理しないこと。
 */
export const LEGACY_UI_FEATURES = [
  'billing',
  'avatar_studio',
  'escalation_reply',
  'session_deletion',
  'analytics',
  'conversion',
  'chat_test',
  'avatar_wizard',
  'knowledge_pdf',
  'knowledge_attribution',
  'faq_publish_toggle',
  'faq_bulk_ops',
  'avatar_feature_toggle',
  'avatar_profile',
  'avatar_premium',
] as const;

export const ADMIN_AGENT_TOOLS: GroqTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_tenant_settings',
      description: 'テナントの現在の設定（GA4 Measurement ID、PostHog ホスト、ウィジェットテーマ）を取得する',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_ga4_id',
      description: 'テナントの GA4 Measurement ID を設定する。G- で始まる形式（例: G-ABCD1234）のみ有効',
      parameters: {
        type: 'object',
        properties: {
          measurement_id: {
            type: 'string',
            description: 'GA4 Measurement ID（G-XXXX形式）',
            pattern: '^G-[A-Z0-9]+$',
          },
        },
        required: ['measurement_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_posthog',
      description: 'テナントの PostHog ホスト URL を設定する',
      parameters: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
            description: 'PostHog ホスト URL（例: https://app.posthog.com）',
          },
        },
        required: ['host'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_faq_list',
      description:
        'テナントの FAQ 一覧を取得する読み取り専用ツール。公開状態・並び順・キーワード検索・ページ送りで絞り込める。' +
        '（絞り込み適用後の総件数も併記されるため、表示件数が上限に達していても総数は正しく分かる）',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '取得件数の上限（任意、省略時10、最大20）' },
          offset: { type: 'integer', description: '取得開始位置（任意、省略時0）。前回の続きを見るときに limit ずつ進める' },
          search: { type: 'string', description: '検索キーワード（任意）' },
          published: {
            type: 'string',
            enum: ['all', 'published', 'draft'],
            description: '公開状態での絞り込み（任意、省略時は全件）。published=公開中のみ、draft=下書きのみ',
          },
          sort_by: {
            type: 'string',
            enum: ['newest', 'oldest', 'updated', 'category'],
            description:
              '並び替えの基準（任意、省略時は新しい順）。newest=登録が新しい順、oldest=登録が古い順、' +
              'updated=更新が新しい順、category=カテゴリ順',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_faq',
      description: '新しい FAQ を追加する',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '質問文（500字以内）',
          },
          answer: {
            type: 'string',
            description: '回答文（2000字以内）',
          },
          category: {
            type: 'string',
            description: `カテゴリ（${FAQ_CATEGORY_IDS.join(' / ')} のいずれか、任意）`,
            enum: FAQ_CATEGORY_IDS,
          },
        },
        required: ['question', 'answer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_faq',
      description: '既存の FAQ を更新する',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: '更新対象の FAQ ID',
          },
          question: {
            type: 'string',
            description: '新しい質問文（500字以内）',
          },
          answer: {
            type: 'string',
            description: '新しい回答文（2000字以内）',
          },
          category: {
            type: 'string',
            description: `カテゴリ（${FAQ_CATEGORY_IDS.join(' / ')} のいずれか、任意。未指定なら既存のカテゴリを維持する）`,
            enum: FAQ_CATEGORY_IDS,
          },
        },
        required: ['id', 'question', 'answer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_faq',
      description: '指定した FAQ を削除する。confirmed=true の場合のみ実行される',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: '削除対象の FAQ ID',
          },
          confirmed: {
            type: 'boolean',
            description: '削除確認フラグ（true でのみ実行）',
          },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_faq_published',
      description:
        '既存のFAQの公開状態（公開/非公開）を切り替える。公開を止めるとお客様とのチャットで' +
        'その回答が使われなくなる。誤った回答をすぐ止めたいときはこれを使うこと（内容を作り直してから' +
        '再度公開すればよく、元に戻せる）。delete_faq（削除・元に戻せない）と混同しないこと。' +
        'confirmed=true の場合のみ実行される。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: '対象の FAQ ID',
          },
          published: {
            type: 'boolean',
            description: 'true で公開、false で非公開にする',
          },
          confirmed: {
            type: 'boolean',
            description: '変更確認フラグ（true でのみ実行）',
          },
        },
        required: ['id', 'published', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'import_industry_faq_templates',
      description:
        '新規テナントのオンボーディングで、ユーザーが答えた業種に合わせたFAQのたたき台を一括登録する。' +
        'ユーザーが業種（自動車販売・整備／美容・サロン／飲食／不動産／小売・EC／その他）を教えてくれた' +
        '直後にのみ使用すること。confirmed=falseで呼ぶとテンプレート内容を提示するだけで登録はしない。' +
        '内容をユーザーに提示し、同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          industry: {
            type: 'string',
            description: 'ユーザーが答えた業種',
            enum: ['auto', 'beauty', 'food', 'realestate', 'retail', 'other'],
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        // オンボ 是正D-1: publish_faq_drafts側は confirmed が required なのに、
        // ここは industry だけが required で非対称だった。同じ確認ゲート付きツールとして揃える。
        required: ['industry', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish_faq_drafts',
      description:
        '下書き(非公開)のFAQをユーザーに内容確認のうえ公開する。confirmed=falseで呼ぶと現在の下書き一覧を' +
        '提示するだけで公開はしない。内容をユーザーに提示し、同意を得たターンでのみ confirmed=true で呼び出すこと。' +
        '一度に公開できるのは最大20件。20件を超える下書きがある場合は複数回呼び出しが必要。',
      parameters: {
        type: 'object',
        properties: {
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_avatar_status',
      description: 'アバターの稼働状況（有効/無効、稼働中の設定名）を取得する読み取り専用ツール。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_avatar_list',
      description:
        'アバター設定の一覧（ID・名前・稼働中かどうか・既定に戻せるかどうか）を取得する読み取り専用ツール。' +
        'activate_avatar / reset_avatar_to_default に渡す ID はこのツールで確認したものだけを使うこと。' +
        'reset_avatar_to_default が使えるのは「（既定に戻せます）」と表示された行だけ。' +
        'テナント自身の設定に加えて、そのまま使える既定の見本も返す。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'activate_avatar',
      description:
        '指定した ID のアバター設定を有効化する（他のアバターは自動的に無効化される）。' +
        'ID を推測してはならない。必ず get_avatar_list で確認した ID を使うこと。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '有効化するアバター設定の ID（get_avatar_list が返したもの）',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deactivate_avatar',
      description:
        '稼働中のアバターを停止する（ウィジェットにアバターが表示されなくなる）。' +
        '再開したい場合は activate_avatar で同じ設定を有効化すればよい。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_avatar_feature',
      description:
        'アバター機能全体のマスターON/OFFを切り替える。OFFにするとテナントのアバターが' +
        'ウィジェットに一切表示されなくなる。ONにするにはGrowthプラン以上の契約が必要' +
        '（OFFへの切り替えはプランに関わらず常に実行できる）。confirmed=true の場合のみ実行される。',
      parameters: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true でアバター機能をON、false でOFFにする',
          },
          confirmed: {
            type: 'boolean',
            description: '変更確認フラグ（true でのみ実行）',
          },
        },
        required: ['enabled', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_hermes_consent',
      description:
        '共有学習プールへの参加同意(2軸)をON/OFFする。' +
        'learn=自社内学習の同意(自テナントの会話から自テナント用に学習する。データは外に出ない)。' +
        'share=共有プール参加の同意(R2C共有プールに出し、かつ読む。外部Hermes VPSへ出る)。' +
        'shareをONにすると、貴社の会話ログ・行動データが外部Hermes VPSでの分析対象になる' +
        '代わりに、他社の学びも使えるようになる。' +
        'shareをOFFにすると以降の新規データ提供は止まるが、それまでに提供済みのデータは取り消せない。' +
        'learn=false かつ share=true(自社が学ばないのに他社へ出す)は矛盾するため指定できない。' +
        '広告プラン(free_ad)ではshareが強制ONのため、shareをOFFにする指定は拒否され理由が返る' +
        '(有料プランへの変更が必要)。' +
        '後方互換: 旧引数 enabled(boolean)が来た場合は share の指定として解釈する。' +
        'confirmed=true の場合のみ実行される。',
      parameters: {
        type: 'object',
        properties: {
          learn: {
            type: 'boolean',
            description: '自社内学習(learn)の同意。true でON、false でOFF。省略時は現在の値を維持する',
          },
          share: {
            type: 'boolean',
            description:
              '共有プール参加(share)の同意。true でON、false でOFF。省略時は現在の値を維持する' +
              '（旧引数 enabled が指定された場合はそちらを share として使う）',
          },
          enabled: {
            type: 'boolean',
            description:
              '非推奨・後方互換用。share と同じ意味(true で外部提供の同意をON、false でOFF)。' +
              '新規にはshareを使うこと',
          },
          confirmed: {
            type: 'boolean',
            description: '変更確認フラグ（true でのみ実行）',
          },
        },
        required: ['confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_avatar_profile',
      description:
        'アバターの基本設定（名前・性格・話し方）を更新する。指定した項目だけが更新され、' +
        '省略した項目は変更されない。対象の ID は get_avatar_list で確認したものを使うこと' +
        '（一覧を取るための専用ツールは他にないため、先にそちらを呼ぶ）。' +
        '既定の見本（全テナント共通のひな形）はこのツールでは更新できない。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '更新するアバター設定の ID（get_avatar_list が返したもの）',
          },
          name: {
            type: 'string',
            description: 'アバターの名前（省略時は変更しない）',
          },
          personality_prompt: {
            type: 'string',
            description: '性格の設定文（省略時は変更しない）',
          },
          behavior_description: {
            type: 'string',
            description: '話し方・振る舞いの説明（省略時は変更しない）',
          },
          confirmed: {
            type: 'boolean',
            description: '変更確認フラグ（true でのみ実行）',
          },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset_avatar_to_default',
      description:
        '既定の見本として作られたアバター設定を、名前・性格・声を作成時点の値に戻す。' +
        '対象は get_avatar_list で「（既定に戻せます）」と表示された設定のみで、' +
        'テナントが独自に作成・採用したアバターには使えない。' +
        '対象の ID は get_avatar_list で確認したものを使うこと（一覧を取るための専用ツールは他にない）。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '既定に戻すアバター設定の ID（get_avatar_list が返したもの）',
          },
          confirmed: {
            type: 'boolean',
            description: '変更確認フラグ（true でのみ実行）',
          },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_avatar_preset',
      description:
        'アバターをまだ持っていないユーザーに、既定の見本（見た目・性格が作り込まれた雛形）から' +
        '1件を提案する読み取り専用ツール。この時点では何も作成しない。ユーザーが' +
        '「アバターを作りたい」「初めて設定したい」等と言ったときに使う。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adopt_avatar_preset',
      description:
        'suggest_avatar_preset が提案した見本を、自テナントのアバター設定として採用する。' +
        '採用してもまだ公開されない（別途 activate_avatar が必要）。' +
        'ユーザーの明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          preset_id: {
            type: 'string',
            description: 'suggest_avatar_preset が返した見本の ID（プリセットID）',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['preset_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_category_personas',
      description:
        '現在設定されているカテゴリ別ペルソナ（会話の話題（例: 「家電」「ファッション」）が' +
        '変わった時にアバターの見た目・話し方・声を自動で切り替える設定）の一覧を取得する読み取り専用ツール。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_category_persona',
      description:
        '指定したカテゴリ用のペルソナ（見た目・話し方・声）の下書きを提案する読み取り専用ツール。' +
        'この時点では何も保存しない。現在のアバター設定を土台に下書きを作る。' +
        'ユーザーが「〇〇の話題の時は違う見た目にしたい」等と言ったときに使う。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: '対象のカテゴリ名（例: "returns" "product" 等、店主が自由に決めてよい）',
          },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_category_persona',
      description:
        'suggest_category_persona が提案した下書き、またはユーザーが直接指定した内容を' +
        'カテゴリ別ペルソナとして保存する。ユーザーの明確な同意を得たターンでのみ' +
        'confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: '対象のカテゴリ名',
          },
          image_url: {
            type: 'string',
            description: 'このカテゴリの時に使うアバター参照画像URL（未指定なら見た目は変えない）',
          },
          agent_prompt: {
            type: 'string',
            description: 'このカテゴリの時の話し方・表情プロンプト（未指定なら変えない）',
          },
          idle_prompt: {
            type: 'string',
            description: 'このカテゴリの時の待機中の表情プロンプト（未指定なら変えない）',
          },
          voice_id: {
            type: 'string',
            description: 'このカテゴリの時に使う声のID（未指定なら声は変えない）',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_embed_code',
      description: 'ウィジェット埋め込みコードのひな形を取得する（APIキーは発行時のみ表示のため、key_prefix のみ表示。set_widget_theme で primaryColor を設定済みなら data-accent-color 属性、position / offsetX / offsetY を設定済みなら data-position / data-offset-x / data-offset-y 属性も含める）',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_widget_theme',
      description: 'ウィジェットのブランドカラーと設置位置を設定する。実際にウィジェットへ反映されるのは primaryColor（#RRGGBB形式の16進数）と、設置位置の position / offsetX / offsetY の4キーのみで、いずれも埋め込みコードの data-* 属性として出力される。他のキーは保存はされるが現時点でウィジェットの表示には反映されない。設置位置はサイト右下の「トップへ戻る」ボタン等と重なる場合に変更する',
      parameters: {
        type: 'object',
        properties: {
          theme: {
            type: 'object',
            description: 'テーマ設定オブジェクト（例: {"primaryColor": "#3B82F6", "offsetY": 96}）。primaryColor は #RRGGBB 形式の16進数カラーコード。position は "bottom-right"（既定）か "bottom-left" で寄せる角を指定する。offsetX / offsetY は画面端からの余白 px で 0〜320 の整数（既定 24）',
          },
        },
        required: ['theme'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_answer_correction',
      description:
        '「この回答は間違っている」という店舗管理者の指摘を受け取り、事実の訂正(知識データ)と振る舞いの指示(指示ルール)のどちらとして扱うべきかを判定する。書き込みは行わない読み取り専用ツール。' +
        '会話の全文表示でAIの回答に対して「これは違う」「正しくは〜」と言われた場合に使う。' +
        '**店舗管理者にどちらの層か選ばせてはいけない。** このツールが返した層に従い、' +
        'layer=knowledge なら save_faq、layer=rule なら suggest_tuning_rule(その後 save_tuning_rule)へ進むこと。' +
        '判定結果と下書きは必ず店舗管理者に提示し、同意を得てから保存すること。',
      parameters: {
        type: 'object',
        properties: {
          user_message: {
            type: 'string',
            description: 'お客様側の元の質問。',
          },
          ai_message: {
            type: 'string',
            description: 'その質問に対してAIが返した誤答。',
          },
          correction: {
            type: 'string',
            description: '店舗管理者の指摘（例:「保証は2年です」「値引きの話は避けて」）。',
          },
        },
        required: ['user_message', 'ai_message', 'correction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_tuning_rule',
      description:
        '店舗管理者の自然な言葉による指示、または既存の会話のやりとり・知識ギャップから、AIチャットボットの「指示ルール」（トリガー条件・期待する応答方針・優先度）の下書きに変換する。書き込みは行わない読み取り専用ツール。' +
        'free_text（自然文の指示）か、user_message + ai_message（会話1往復からの提案）のどちらか一方を指定する。' +
        '会話の全文表示や知識ギャップの一覧から「この会話/ギャップからルールを作って」と言われた場合は、free_text ではなく user_message（お客様の発言・質問）と ai_message（それに対するAIの回答。知識ギャップの場合は「ご質問の内容に完全に一致するFAQは見つかりませんでした。」）を使うこと。' +
        '提案内容は必ずユーザーに提示して明確な同意を得てから save_tuning_rule で保存すること。',
      parameters: {
        type: 'object',
        properties: {
          free_text: {
            type: 'string',
            description: '管理者が話した自然文の指示（例:「保証について聞かれたら2年とお伝えして」）。user_message/ai_message とは併用しない。',
          },
          user_message: {
            type: 'string',
            description: '会話やギャップにおけるお客様側の発言・質問。ai_message と組で指定する。',
          },
          ai_message: {
            type: 'string',
            description: 'user_message に対するAIの回答。user_message と組で指定する。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_tuning_rule',
      description:
        '指示ルールをDBに保存する。破壊的な変更ではないが今後のAI応答に影響するため、必ず先に suggest_tuning_rule 等で内容をユーザーに提示し、明確な同意を得てから confirmed=true で呼び出すこと。confirmed=false または未指定では保存されない。',
      parameters: {
        type: 'object',
        properties: {
          trigger_pattern: {
            type: 'string',
            description: 'このルールが適用されるキーワードや状況',
          },
          expected_behavior: {
            type: 'string',
            description: 'AIへの具体的な指示',
          },
          priority: {
            type: 'number',
            description: '優先度（0〜10の整数、任意。省略時は5）。suggest_tuning_ruleの提案値をそのまま渡す場合に使う。ユーザーが「低い/普通/高い優先度で」のように3段階で話した場合は、こちらではなく priority_tier を使うこと（両方指定した場合は priority_tier が優先される）。',
          },
          priority_tier: {
            type: 'string',
            enum: ['low', 'normal', 'high'],
            description: 'ユーザーが優先度を「低い/普通/高い」の3段階で話した場合に指定する。',
          },
          confirmed: {
            type: 'boolean',
            description: '保存確認フラグ（true でのみ実行される）',
          },
        },
        required: ['trigger_pattern', 'expected_behavior', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tuning_rules',
      description:
        '現在の指示ルール（AIの振る舞いルール）の一覧を取得する読み取り専用ツール。suggest_tuning_rule/save_tuning_ruleで作成済みのものに加え、AIが自動提案した未承認のルール（店主の承認なしには本番の応答に反映されない）も含む。一覧・承認判断の両方に使う。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_tuning_rule',
      description:
        '既存の指示ルールを編集する、有効/無効を切り替える、優先度を変更する、またはAI提案ルールを承認/却下する。編集する場合は trigger_pattern/expected_behavior を、有効/無効の切り替えのみの場合は is_active だけを指定する。' +
        'AI提案ルール（get_tuning_rulesの結果でsourceが"judge"のもの）を承認する場合は is_active=true と status="active" を両方指定し、却下する場合は is_active=false と status="rejected" を両方指定すること（is_active だけでは未承認と却下済みを区別できない）。通常のルールのON/OFF切替では status を指定しない。' +
        'ユーザーが「優先度を上げて/下げて/高くして」等と言った場合は priority_tier を指定する。一覧画面の「優先度を◯にする」チップから来た指示は既にユーザーの明確な意思表示なので、そのターンで直接 confirmed=true を指定してよい。それ以外は必ず先に変更内容（承認/却下の場合は根拠を含む）をユーザーに提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_tuning_rulesの結果に含まれるルールID' },
          trigger_pattern: { type: 'string', description: '新しいトリガー内容（変更する場合のみ指定）' },
          expected_behavior: { type: 'string', description: '新しい対応方針（変更する場合のみ指定）' },
          is_active: { type: 'boolean', description: '有効/無効の切り替え（変更する場合のみ指定）' },
          priority_tier: {
            type: 'string',
            enum: ['low', 'normal', 'high'],
            description: '優先度を3段階(低/普通/高)で変更する場合のみ指定する。',
          },
          status: {
            type: 'string',
            enum: ['active', 'rejected'],
            description: 'AI提案ルールの承認("active")/却下("rejected")時のみ指定する。通常のルールのON/OFF切替では指定しない。',
          },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_tuning_rule',
      description:
        '指示ルールを削除する。必ず先にどのルールを削除するか提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_tuning_rulesの結果に含まれるルールID' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_tuning_rule_test_responses',
      description:
        '指示ルールが実際どう応答するかをAIで試作する読み取り専用ツール。丁寧版/簡潔版/提案型の3パターンを生成する（DBには保存されない）。ユーザーが気に入ったものがあれば approve_tuning_rule_response で採用できる。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_tuning_rulesの結果に含まれるルールID' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'approve_tuning_rule_response',
      description:
        'generate_tuning_rule_test_responsesで生成したテスト返答のひとつを、ルールの「採用済み返答」として保存する。必ず先にどの返答を採用するか提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ルールID' },
          text: { type: 'string', description: '採用する返答テキスト（generate_tuning_rule_test_responsesの結果からそのまま使うこと）' },
          style: { type: 'string', description: '返答のスタイル（丁寧版/簡潔版/提案型など、生成結果からそのまま使うこと）' },
          reason: { type: 'string', description: '採用理由（任意）' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'text', 'style', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_approved_response',
      description:
        'ルールに既に採用済みの返答をひとつ取り消す。必ず先にどれを取り消すか提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ルールID' },
          index: { type: 'number', description: 'get_tuning_rulesまたは直前の会話で示された採用済み返答一覧内での位置（0始まり）' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'index', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weekly_briefing',
      description:
        '今週（月曜00:00起点、暦週）のテナントの状況（会話数・先週同時点比・応答品質スコア・成約・FAQ総数と公開数と最終更新日・承認待ちの指示ルール件数・AIが答えられなかった質問トップ3）をまとめて取得する読み取り専用ツール。ログイン直後など、ユーザーから明示的な依頼がなくても状況を能動的に説明する際に使う。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_knowledge_gaps',
      description:
        'AIが答えられなかった質問（知識ギャップ、未対応=openのもの）の一覧を取得する読み取り専用ツール。件数や内容を確認したい時に使う。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '取得件数の上限（任意、省略時10、最大20）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismiss_knowledge_gap',
      description:
        '知識ギャップを「対応不要」として片付ける（FAQ登録はしない、ステータスをdismissedに変更するだけ）。削除ではない。必ず先にどの質問を片付けるか提示し、明確な同意を得たターンでのみ confirmed=true を指定して呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_knowledge_gapsの結果に含まれるギャップID' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_faq',
      description:
        '店舗管理者の自然な言葉による指示から、FAQ（質問・回答・分類）の下書きを生成する。書き込みは行わない読み取り専用ツール。提案内容は必ずユーザーに提示して明確な同意を得てから save_faq で保存すること。',
      parameters: {
        type: 'object',
        properties: {
          free_text: {
            type: 'string',
            description: '管理者が話した自然文の指示（例:「送料は全国一律550円、5000円以上で無料と答えられるようにして」）',
          },
        },
        required: ['free_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_faq',
      description:
        'FAQをDBに保存し即座に公開する。必ず先に suggest_faq 等で内容をユーザーに提示し、明確な同意を得てから confirmed=true で呼び出すこと。confirmed=false または未指定では保存されない。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '質問文' },
          answer: { type: 'string', description: '回答文' },
          category: { type: 'string', description: 'カテゴリ（任意。省略時はAIが判定した値をそのまま使う）' },
          confirmed: { type: 'boolean', description: '保存確認フラグ（true でのみ実行される）' },
        },
        required: ['question', 'answer', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_faq_import_from_text',
      description:
        '管理者が貼り付けた長めのテキスト（商品説明・利用規約の抜粋など）から、FAQを複数まとめて生成しプレビューする。' +
        '生成結果はサーバー側に一時保存される（この会話のセッション内でのみ有効）。書き込みは行わない読み取り専用ツール。' +
        '内容を要約してユーザーに提示し、明確な同意を得てから commit_faq_import で登録すること。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'FAQ化したいテキスト（50〜10000字）',
          },
          category: {
            type: 'string',
            description: '全FAQ共通のカテゴリ（任意。省略時はAIがFAQごとに自動判定する）',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_faq_import_from_urls',
      description:
        '商品ページなどのURL（1〜5件）を取得し、本文からFAQを複数まとめて生成しプレビューする。' +
        '生成結果はサーバー側に一時保存される（この会話のセッション内でのみ有効）。書き込みは行わない読み取り専用ツール。' +
        '内容を要約してユーザーに提示し、明確な同意を得てから commit_faq_import で登録すること。',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: '取得するURL（1〜5件、http(s)で始まること）',
          },
          category: {
            type: 'string',
            description: '全FAQ共通のカテゴリ（任意。省略時はAIがFAQごとに自動判定する）',
          },
        },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_faq_import',
      description:
        'suggest_faq_import_from_text または suggest_faq_import_from_urls でプレビュー済みのFAQをまとめてDBに登録し即座に公開する。' +
        '既存FAQと類似する内容は自動でスキップされる。必ず先にプレビュー内容をユーザーに提示し、明確な同意を得てから' +
        ' confirmed=true で呼び出すこと。confirmed=false または未指定では登録されない。プレビューが存在しない場合は失敗する。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: '登録先テナントID（任意。省略時は現在のテナント。"global"はSuper Adminのみ指定可）',
          },
          confirmed: { type: 'boolean', description: '登録確認フラグ（true でのみ実行される）' },
        },
        required: ['confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discard_faq_import',
      description:
        'suggest_faq_import_from_text / suggest_faq_import_from_urls で作成した未登録のFAQプレビューを破棄する。' +
        'ユーザーが「やめておく」等、登録を望まない意思を示した場合に呼び出す。DBへの書き込みは行っていないため確認は不要。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_engagement_rule',
      description:
        '店舗管理者の自然な言葉による指示から、お客様への声がけ（いつ・どんな条件で・何を表示するか）の下書きを生成する。書き込みは行わない読み取り専用ツール。提案内容は必ずユーザーに提示して明確な同意を得てから save_engagement_rule で保存すること。',
      parameters: {
        type: 'object',
        properties: {
          free_text: {
            type: 'string',
            description: '管理者が話した自然文の指示（例:「商品ページを長く見てる人に、人気ランキングを勧めたい」）',
          },
        },
        required: ['free_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_engagement_rule',
      description:
        '声がけルールをDBに保存し即座に有効化する。必ず先に suggest_engagement_rule で内容をユーザーに提示し、明確な同意を得てから confirmed=true で呼び出すこと。trigger_type/trigger_config/message_template は suggest_engagement_rule の提案値をそのまま使うこと。',
      parameters: {
        type: 'object',
        properties: {
          trigger_type: {
            type: 'string',
            enum: ['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match'],
            description: 'トリガー種別',
          },
          trigger_config: {
            type: 'object',
            description:
              'トリガー種別ごとの設定。scroll_depth: {"threshold": 1-100}, idle_time: {"seconds": 1-3600}, exit_intent: {}, page_url_match: {"patterns": ["/products/*"], "match_type": "glob"}',
          },
          message_template: { type: 'string', description: '表示する声がけ文言' },
          priority: { type: 'number', description: '優先度（0〜100の整数、任意。省略時は0）' },
          confirmed: { type: 'boolean', description: '保存確認フラグ（true でのみ実行される）' },
        },
        required: ['trigger_type', 'trigger_config', 'message_template', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_engagement_rules',
      description:
        '現在の声がけルール（サイト上のプロアクティブな声がけ設定）の一覧を取得する読み取り専用ツール。suggest_engagement_rule/save_engagement_ruleで作成済みのものも含め、有効/無効の状態ごと全件を確認したい時に使う。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_engagement_rule',
      description:
        '既存の声がけルールを編集する、または有効/無効を切り替える。変更したい項目（trigger_type/trigger_config/message_template/priority/is_active）だけを指定すればよく、指定しなかった項目は変更されない。trigger_typeを変更する場合はtrigger_configも合わせて指定すること。必ず先に変更内容をユーザーに提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_engagement_rulesの結果に含まれるルールID' },
          trigger_type: {
            type: 'string',
            enum: ['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match'],
            description: 'トリガー種別（変更する場合のみ指定、trigger_configとセットで）',
          },
          trigger_config: {
            type: 'object',
            description:
              'トリガー種別ごとの設定（変更する場合のみ指定）。scroll_depth: {"threshold": 1-100}, idle_time: {"seconds": 1-3600}, exit_intent: {}, page_url_match: {"patterns": ["/products/*"], "match_type": "glob"}',
          },
          message_template: { type: 'string', description: '表示する声がけ文言（変更する場合のみ指定）' },
          priority: { type: 'number', description: '優先度（0〜100の整数、変更する場合のみ指定）' },
          is_active: { type: 'boolean', description: '有効/無効の切り替え（変更する場合のみ指定）' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_engagement_rule',
      description:
        '声がけルールを削除する。必ず先にどのルールを削除するか提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_engagement_rulesの結果に含まれるルールID' },
          confirmed: { type: 'boolean', description: '確認フラグ（true でのみ実行される）' },
        },
        required: ['id', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chat_sessions',
      description:
        '最近の会話セッション一覧（開始日時・メッセージ数・最初の質問プレビュー）を取得する読み取り専用ツール。会話履歴の概要を確認したい時に使う。' +
        '期間・キーワード検索・評価スコア帯・並び順・ページ送りで絞り込める。' +
        '「最近の会話を点検して」のような品質確認には period や sentiment=negative を、' +
        '「〇〇についての会話を探して」のような照会には search を使うこと。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '取得件数の上限（任意、省略時10、最大20）' },
          offset: { type: 'integer', description: '取得開始位置（任意、省略時0）。前回の続きを見るときに limit ずつ進める' },
          period: {
            type: 'string',
            enum: ['7', '30', '90', 'all'],
            description: '対象期間（任意、省略時は全期間）。7=直近7日、30=直近30日、90=直近90日、all=全期間',
          },
          search: { type: 'string', description: 'お客様の最初の質問文に対する部分一致検索キーワード（任意）' },
          sentiment: {
            type: 'string',
            enum: ['positive', 'negative', 'neutral'],
            description: 'AI品質評価スコア帯での絞り込み（任意）。negative=要改善(60点未満)、positive=良好(70点以上)、neutral=その中間',
          },
          sort_by: {
            type: 'string',
            enum: ['last_message_at', 'message_count', 'score'],
            description: '並び替えの基準（任意、省略時は最終メッセージ日時）',
          },
          sort_order: { type: 'string', enum: ['asc', 'desc'], description: '並び順（任意、省略時は降順）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chat_session_messages',
      description:
        '指定した会話セッションの本文（お客様とAI・担当者のやり取り）を取得する読み取り専用ツール。' +
        'get_chat_sessions が返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。' +
        '「この会話の中身を見せて」「どんなやり取りだったか」と聞かれた時に使う。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_chat_sessions の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
          limit: { type: 'integer', description: '取得するメッセージ数の上限（任意、省略時20、最大50。新しい方から取得）' },
        },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_chat_session',
      description:
        '指定した会話セッションを完全に削除する書き込みツール。取り消せない操作のため、' +
        'get_chat_sessions が返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。' +
        'reason には必ずユーザー自身が話した理由をそのまま使い、モデルが理由を創作しないこと' +
        '（ユーザーがまだ理由を言っていない場合は、先に理由を尋ねること）。' +
        '必ず先に「どの会話を、どんな理由で削除するか」をユーザーに提示し、' +
        '明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_chat_sessions の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
          reason: {
            type: 'string',
            description: '削除する理由（5〜500文字）。ユーザー自身の言葉をそのまま使うこと',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['session_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_conversation_evaluation',
      description:
        '指定した会話セッションのAI品質評価（Judge）を取得する読み取り専用ツール。総合スコア・4軸' +
        '（心理対応力・顧客対応力・商談進行力・禁止事項の遵守率）・所見を返す。get_chat_sessions が' +
        '返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。' +
        '「この会話の対応品質はどうだった？」「評価を見せて」と聞かれた時に使う。未評価の会話もある。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_chat_sessions の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
        },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_escalations',
      description:
        '有人対応にエスカレーションされた、対応中（未解決）の会話一覧を取得する読み取り専用ツール。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_to_escalation',
      description:
        'エスカレーション中の会話に、有人担当者としてお客様へ返信する書き込みツール。' +
        'get_escalations / get_chat_sessions が返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。' +
        '返信はお客様の画面にそのまま表示されるため、必ず先に返信文面をユーザーに要約提示し、' +
        '同意を得たターンでのみ confirmed=true を指定して呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_escalations の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
          content: {
            type: 'string',
            description: 'お客様へ送る返信本文（1〜2000文字）',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['session_id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_escalation',
      description:
        'エスカレーション中の会話を「対応完了」にする書き込みツール。完了にすると get_escalations の一覧から外れる。' +
        'get_escalations / get_chat_sessions が返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。' +
        '必ず先にどの会話を対応完了にするかをユーザーに要約提示し、' +
        '同意を得たターンでのみ confirmed=true を指定して呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_escalations の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_outcome',
      description:
        '指定した会話セッションの成果（コンバージョン結果。例: 購入完了・予約完了・離脱）が' +
        '記録済みかどうかを取得する読み取り専用ツール。get_chat_sessions が返した [xxxxxxxx] の' +
        '短縮IDをそのまま session_id に渡せる。「この会話の成果は記録されている？」と聞かれた時に使う。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_chat_sessions の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
        },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_session_outcome',
      description:
        '指定した会話セッションの成果（コンバージョン結果）を記録する書き込みツール。' +
        'outcome はテナントごとに決められた選択肢（例: 購入完了・予約完了・問い合わせ送信・離脱・不明）の' +
        'いずれかでなければならず、範囲外の値を渡すと有効な選択肢が案内される。get_chat_sessions が' +
        '返した [xxxxxxxx] の短縮IDをそのまま session_id に渡せる。永続コンテンツの変更のため、' +
        '必ず先にどの会話にどの成果を記録するかをユーザーに提示し、同意を得たターンでのみ' +
        'confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'セッションID。get_chat_sessions の [xxxxxxxx] 表記の短縮ID（8文字）をそのまま指定してよい',
          },
          outcome: {
            type: 'string',
            description: '記録する成果。このテナントの成果選択肢のいずれか(不明な場合はまず get_session_outcome か会話一覧で確認すること)',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['session_id', 'outcome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_monitoring_summary',
      description:
        '直近30日間の会話完了率・フォールバック率（AIが答えられなかった割合）のサマリーを取得する読み取り専用ツール。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_sai_task',
      description:
        'R2Cエージェント（Sai）に、テナントの管理画面上での操作を代わりに実行するよう依頼する。' +
        '例: 「送料表記を直して」「FAQのこの文章を直しておいて」等、ユーザーが直接操作するより代行を頼みたい場合に使う。' +
        '利用量に応じた従量課金（他のLLM機能と同じ仕組み）が発生するため、必ず先に依頼内容をユーザーに要約提示し、' +
        '同意を得たターンでのみ confirmed=true を指定して呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Saiに依頼する作業内容（具体的に）',
          },
          confirmed: {
            type: 'boolean',
            description: 'ユーザーの明確な同意を得た場合のみ true',
          },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sai_task_status',
      description: 'request_sai_task で依頼したSaiタスクの進捗状況を取得する読み取り専用ツール。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'request_sai_task が返したタスクID',
          },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_legacy_ui_link',
      description:
        'チャットでは対応していない操作について、旧管理画面（従来のGUI）への案内リンクを返す読み取り専用ツール。' +
        '請求（請求書の再送・金額調整・無料期間設定・一時停止/再開）、アバタースタジオ（画像候補の選択・音声クローン・' +
        '性格設定・ライブテスト）、会話セッションの削除、会話分析（会話数・満足度・' +
        '品質指標の推移や低評価セッションの確認）、成約・効果分析（成約への貢献度・ABテスト・効果測定）、' +
        'テストチャット（設定内容の動作確認）、アバター新規作成（ウィザード）、PDFアップロードでの知識登録について' +
        '尋ねられたら、無理にチャットで実行しようとせずこのツールを呼び出して案内すること。' +
        'テキスト入力やURLからの知識登録は suggest_faq_import_from_text / suggest_faq_import_from_urls が' +
        '使えるため、PDF以外ではこのツールを使わないこと。' +
        'エスカレーションへの有人返信と対応完了はチャットから reply_to_escalation / resolve_escalation で' +
        '直接実行できるため、feature="escalation_reply" は「旧画面で会話の履歴を見返したい」と' +
        'ユーザーが明示した場合にのみ案内すること。' +
        'また会話分析・成約/効果分析の「数値サマリー」は get_analytics_summary / get_conversion_summary で' +
        'チャット上に直接返せるため、まずそちらを使うこと。この2機能でこのツールを使うのは、' +
        'グラフの詳細・個別の低評価セッション・ABテスト結果を旧UIで見たい場合に限る。' +
        'FAQごとの公開/非公開切替は set_faq_published で直接実行できるため、まずそちらを使うこと。' +
        'feature="faq_publish_toggle" は set_faq_published で対応できない場合にのみ使うこと' +
        '（まとめて非公開・まとめて削除をしたい場合は feature="faq_bulk_ops" を使うこと）。' +
        'アバター機能全体のON/OFFは set_avatar_feature で直接実行できるため、まずそちらを使うこと。' +
        'feature="avatar_feature_toggle" は set_avatar_feature で対応できない場合にのみ使うこと。' +
        'アバターの名前・性格・話し方の編集は update_avatar_profile で直接実行できるため、まずそちらを使うこと。' +
        'feature="avatar_profile" は update_avatar_profile で対応できない場合にのみ使うこと。' +
        '高品質なアバター画像を生成したいと聞かれたら feature="avatar_premium" を使うこと。',
      parameters: {
        type: 'object',
        properties: {
          feature: {
            type: 'string',
            description: '案内先の機能',
            enum: LEGACY_UI_FEATURES,
          },
          session_id: {
            type: 'string',
            description:
              '対象の会話の短縮ID（get_chat_sessions や get_escalations が返す8文字のID）。' +
              'session_deletion で使うと、その会話を直接開くリンクになる。',
          },
          avatar_config_id: {
            type: 'string',
            description:
              '対象のアバター設定ID。avatar_studio / avatar_profile で使うと、そのアバターを直接開く' +
              'リンクになる。指定が無ければ稼働中のアバター設定を自動で解決する。',
          },
        },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_analytics_summary',
      description:
        '会話分析の数値サマリー（会話数・前期間比・満足度スコア・1会話あたりのメッセージ数・' +
        '知識ギャップ件数・感情の内訳）をチャット上に直接返す読み取り専用ツール。' +
        '「会話は増えている?」「満足度はどう?」のように数字で答えられる質問にはこのツールを使うこと。' +
        'グラフの詳細や個別の低評価セッションを見たい場合のみ get_legacy_ui_link(analytics) で旧UIへ案内する。',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: '集計期間（既定は30d）',
            enum: ['7d', '30d'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_conversion_summary',
      description:
        '成約・効果分析の数値サマリー（会話数・結果記録率・成約率の推移・成果につながった' +
        'セールステクニック・離脱ステージ）をチャット上に直接返す読み取り専用ツール。' +
        '「成約につながっている?」「どのくらい売れている?」のように数字で答えられる質問にはこのツールを使うこと。' +
        'ABテスト結果や詳細グラフを見たい場合のみ get_legacy_ui_link(conversion) で旧UIへ案内する。',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: '集計期間（既定は30d）',
            enum: ['7d', '30d'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tuning_rule_effect',
      description:
        '承認済みの指示ルールが実際に効いているかを、承認前後のJudgeスコア比較（DiD推定）で' +
        '確認する読み取り専用ツール。「このルール効いてる?」「効果を教えて」と聞かれた時に使う。' +
        '判定に十分な会話数が無い場合は数値を出さず、あと何件・何日でわかりそうかを返す' +
        '（母数不足のときに断定的な数値を出すと誤った自信を与えるため）。まだ承認されていないルールは' +
        '効果を判定できない旨を返す。',
      parameters: {
        type: 'object',
        properties: {
          rule_id: {
            type: 'number',
            description: '指示ルールのID。get_tuning_rules が返す一覧の id をそのまま指定する',
          },
        },
        required: ['rule_id'],
      },
    },
  },
];
