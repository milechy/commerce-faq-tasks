// src/config/r2cFeatureCatalog.ts
// Phase61: R2C機能カタログ — feedbackAI / ai-assist でのキーワードマッチに使用

export interface R2CFeature {
  id: string;
  name: string;
  nameEn: string;
  category: 'setup' | 'config' | 'content' | 'monitoring';
  keywords: string[];
  description: string;
  /** Phase64: 課金単価 (cents) */
  pricePerUnit?: number;
  /** Phase64: 代行サービスフラグ（弊社が手動で制作する） */
  isService?: boolean;
}

export const R2C_FEATURE_CATALOG: R2CFeature[] = [
  {
    id: 'widget_embed',
    name: 'ウィジェット埋め込み',
    nameEn: 'Widget Embedding',
    category: 'setup',
    keywords: ['埋め込み', 'script', 'タグ', 'ウィジェット', 'widget', 'HTML'],
    description: 'パートナーサイトへのチャットウィジェット設置',
  },
  {
    id: 'avatar_setup',
    name: 'アバター設定',
    nameEn: 'Avatar Setup',
    category: 'setup',
    keywords: ['アバター', '声', '画像', 'avatar', '音声', 'TTS'],
    description: 'AIアバターの外見・声・プロンプト設定',
  },
  {
    id: 'knowledge_upload',
    name: 'ナレッジ登録',
    nameEn: 'Knowledge Upload',
    category: 'content',
    keywords: ['PDF', '書籍', 'アップロード', 'ナレッジ', 'knowledge', 'FAQ'],
    description: 'PDF書籍・FAQ データのアップロードと登録',
  },
  {
    id: 'faq_management',
    name: 'FAQ管理',
    nameEn: 'FAQ Management',
    category: 'content',
    keywords: ['FAQ', '質問', '回答', '登録', '編集', '削除'],
    description: 'FAQ の作成・編集・削除',
  },
  {
    id: 'tuning_rules',
    name: 'チューニングルール',
    nameEn: 'Tuning Rules',
    category: 'config',
    keywords: ['チューニング', 'ルール', '応答調整', '調整', 'tuning'],
    description: 'AI応答のトーン・スタイル・ルール設定',
  },
  {
    id: 'system_prompt',
    name: 'システムプロンプト',
    nameEn: 'System Prompt',
    category: 'config',
    keywords: ['プロンプト', 'システム', '指示', 'prompt'],
    description: 'テナント別AIシステムプロンプト設定',
  },
  {
    id: 'tenant_config',
    name: 'テナント設定',
    nameEn: 'Tenant Configuration',
    category: 'config',
    keywords: ['テナント', 'APIキー', 'ドメイン', '設定', 'CORS', 'オリジン'],
    description: 'テナント基本設定・APIキー・許可ドメイン',
  },
  {
    id: 'ab_testing',
    name: 'A/Bテスト',
    nameEn: 'A/B Testing',
    category: 'config',
    keywords: ['AB', 'テスト', 'バリアント', '実験', 'experiment'],
    description: 'トーン・CTA・ルールセットのA/Bテスト設定',
  },
  {
    id: 'analytics_dashboard',
    name: '分析ダッシュボード',
    nameEn: 'Analytics Dashboard',
    category: 'monitoring',
    keywords: ['分析', 'ダッシュボード', 'KPI', 'レポート', '統計'],
    description: '会話分析・Judge評価・センチメント確認',
  },
  {
    id: 'deep_research',
    name: 'ディープリサーチ',
    nameEn: 'Deep Research',
    category: 'config',
    keywords: ['リサーチ', 'Perplexity', '検索', 'ウェブ', 'web'],
    description: 'Perplexityディープリサーチ機能のON/OFF',
  },

  // Phase64: プレミアムアバター生成（セルフサービス）
  {
    id: 'premium_avatar',
    name: 'プレミアムアバター生成',
    nameEn: 'Premium Avatar Generation',
    category: 'config',
    keywords: ['プレミアム', 'アバター生成', 'Magnific', 'Flux', '高品質', '高解像度', 'premium avatar'],
    description: '高品質AIアバター画像生成（Flux 2 Pro + Magnific AI アップスケール）',
    pricePerUnit: 100,
  },

  // Phase64: プレミアムアバター制作代行（弊社手動制作）
  {
    id: 'premium_avatar_service',
    name: 'プレミアムアバター制作代行',
    nameEn: 'Premium Avatar Production Service',
    category: 'config',
    keywords: [
      'アバター品質', 'アバター 品質', 'リアル', 'もっとリアル', 'リアルな',
      '高品質アバター', 'プロフェッショナルアバター', 'アバター制作代行',
      'アバター 代行', 'アバターをもっと', 'アバターの改善',
      '品質を上げたい', '品質向上', '最高品質',
    ],
    description: '弊社デザイナーがFlux 2 + Vellum + Magnific AIで世界最高品質のアバターを制作します',
    pricePerUnit: 5000,
    isService: true,
  },
];

/**
 * ユーザーのクエリ文字列から最初にマッチするR2C機能を返す。
 * キーワードが1つもマッチしない場合は null。
 */
export function matchFeatureCatalog(query: string): R2CFeature | null {
  const q = query.toLowerCase();
  for (const feature of R2C_FEATURE_CATALOG) {
    if (feature.keywords.some((kw) => q.includes(kw.toLowerCase()))) {
      return feature;
    }
  }
  return null;
}
