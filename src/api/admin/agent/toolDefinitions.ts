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
];
