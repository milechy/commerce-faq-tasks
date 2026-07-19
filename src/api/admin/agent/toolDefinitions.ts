// src/api/admin/agent/toolDefinitions.ts
// Phase B-Admin: AIエージェント用ツール定義（Groq function calling 形式）

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
      description: 'テナントの FAQ 一覧を取得する（最大20件）',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '取得件数（1〜20、デフォルト10）',
          },
          search: {
            type: 'string',
            description: '検索キーワード（任意）',
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
            description: 'カテゴリ（inventory / campaign / coupon / store_info のいずれか、任意）',
            enum: ['inventory', 'campaign', 'coupon', 'store_info'],
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
      name: 'activate_avatar',
      description: '指定した ID のアバター設定を有効化する（他のアバターは自動的に無効化される）',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '有効化するアバター設定の ID',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_embed_code',
      description: 'ウィジェット埋め込みコードのひな形を取得する（APIキーは発行時のみ表示のため、key_prefix のみ表示）',
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
      description: 'ウィジェットのテーマ設定（色・フォント等）を JSONB で更新する',
      parameters: {
        type: 'object',
        properties: {
          theme: {
            type: 'object',
            description: 'テーマ設定オブジェクト（例: {"primaryColor": "#3B82F6", "fontFamily": "sans-serif"}）',
          },
        },
        required: ['theme'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_tuning_rule',
      description:
        '店舗管理者の自然な言葉による指示を、AIチャットボットの「指示ルール」（トリガー条件・期待する応答方針・優先度）の下書きに変換する。書き込みは行わない読み取り専用ツール。提案内容は必ずユーザーに提示して明確な同意を得てから save_tuning_rule で保存すること。',
      parameters: {
        type: 'object',
        properties: {
          free_text: {
            type: 'string',
            description: '管理者が話した自然文の指示（例:「保証について聞かれたら2年とお伝えして」）',
          },
        },
        required: ['free_text'],
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
            description: '優先度（0〜10の整数、任意。省略時は5）',
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
        '現在の指示ルール（AIの振る舞いルール）の一覧を取得する読み取り専用ツール。suggest_tuning_rule/save_tuning_ruleで作成済みのものも含め、有効/無効の状態ごと全件を確認したい時に使う。',
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
        '既存の指示ルールを編集する、または有効/無効を切り替える。編集する場合は trigger_pattern/expected_behavior を、有効/無効の切り替えのみの場合は is_active だけを指定する。必ず先に変更内容をユーザーに提示し、明確な同意を得たターンでのみ confirmed=true で呼び出すこと。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'get_tuning_rulesの結果に含まれるルールID' },
          trigger_pattern: { type: 'string', description: '新しいトリガー内容（変更する場合のみ指定）' },
          expected_behavior: { type: 'string', description: '新しい対応方針（変更する場合のみ指定）' },
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
        '直近7日間のテナントの状況（会話数・前週比・応答品質スコア・成約・AIが答えられなかった質問トップ3）をまとめて取得する読み取り専用ツール。ログイン直後など、ユーザーから明示的な依頼がなくても状況を能動的に説明する際に使う。',
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
          limit: { type: 'number', description: '取得件数の上限（任意、省略時10、最大20）' },
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
        '最近の会話セッション一覧（開始日時・メッセージ数・最初の質問プレビュー）を取得する読み取り専用ツール。会話履歴の概要を確認したい時に使う。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '取得件数の上限（任意、省略時10、最大20）' },
        },
        required: [],
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
        '性格設定・ライブテスト）、エスカレーションへの有人返信、会話セッションの削除について尋ねられたら、' +
        '無理にチャットで実行しようとせずこのツールを呼び出して案内すること。',
      parameters: {
        type: 'object',
        properties: {
          feature: {
            type: 'string',
            description: '案内先の機能',
            enum: ['billing', 'avatar_studio', 'escalation_reply', 'session_deletion'],
          },
        },
        required: ['feature'],
      },
    },
  },
];
