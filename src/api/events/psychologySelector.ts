// src/api/events/psychologySelector.ts
// Phase57: SalesFlowステージ × 温度感 → 心理原則ヒント選択

export interface PsychologySearchHint {
  principleKeywords: string[];   // 検索に追加するキーワード（書籍チャンク検索用）
  situationKeywords: string[];   // situationフィールド検索用
}

type TempLevel = 'cold' | 'warm' | 'hot';
type StageMap = Record<string, PsychologySearchHint>;
type HintMap = Record<TempLevel, StageMap>;

const HINT_MAP: HintMap = {
  hot: {
    close: {
      principleKeywords: ['損失回避', '希少性', 'デッドライン'],
      situationKeywords: ['決断', '最後の一押し', '迷っている'],
    },
    recommend: {
      principleKeywords: ['アンカリング', '社会的証明', '権威'],
      situationKeywords: ['比較', '選択', 'おすすめ'],
    },
    _default: {
      principleKeywords: ['損失回避', 'コミットメント'],
      situationKeywords: ['購入', '決断'],
    },
  },
  warm: {
    propose: {
      principleKeywords: ['返報性', '社会的証明'],
      situationKeywords: ['提案', '興味', '検討'],
    },
    recommend: {
      principleKeywords: ['社会的証明', 'バンドワゴン'],
      situationKeywords: ['人気', '評判', '実績'],
    },
    _default: {
      principleKeywords: ['返報性', '好意'],
      situationKeywords: ['関心', '興味'],
    },
  },
  cold: {
    clarify: {
      principleKeywords: ['返報性', '信頼', '一貫性'],
      situationKeywords: ['初回', '不安', '情報収集'],
    },
    _default: {
      principleKeywords: ['返報性', '好意', '共感'],
      situationKeywords: ['信頼構築', '情報提供'],
    },
  },
};

/**
 * SalesFlowステージと温度感レベルから最適な心理原則ヒントを選択する。
 * 未知のステージは _default にフォールバック。
 */
export function selectPsychologyHints(
  salesStage: string | null,
  tempLevel: TempLevel,
): PsychologySearchHint {
  const tempMap = HINT_MAP[tempLevel] ?? HINT_MAP.cold;
  const stage = salesStage ?? '_default';
  return tempMap[stage] ?? tempMap['_default']!;
}
