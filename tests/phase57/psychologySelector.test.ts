// tests/phase57/psychologySelector.test.ts
// Phase57: selectPsychologyHints テスト

import { selectPsychologyHints } from '../../src/api/events/psychologySelector';

describe('selectPsychologyHints', () => {
  describe('hot + close → 損失回避が含まれる', () => {
    it('損失回避キーワードが principleKeywords に含まれる', () => {
      const hints = selectPsychologyHints('close', 'hot');
      expect(hints.principleKeywords).toContain('損失回避');
    });

    it('希少性が含まれる', () => {
      const hints = selectPsychologyHints('close', 'hot');
      expect(hints.principleKeywords).toContain('希少性');
    });

    it('situationKeywords に決断が含まれる', () => {
      const hints = selectPsychologyHints('close', 'hot');
      expect(hints.situationKeywords).toContain('決断');
    });
  });

  describe('cold + clarify → 返報性が含まれる', () => {
    it('返報性が principleKeywords に含まれる', () => {
      const hints = selectPsychologyHints('clarify', 'cold');
      expect(hints.principleKeywords).toContain('返報性');
    });

    it('一貫性が含まれる', () => {
      const hints = selectPsychologyHints('clarify', 'cold');
      expect(hints.principleKeywords).toContain('一貫性');
    });
  });

  describe('warm + propose → 社会的証明が含まれる', () => {
    it('返報性が principleKeywords に含まれる', () => {
      const hints = selectPsychologyHints('propose', 'warm');
      expect(hints.principleKeywords).toContain('返報性');
    });

    it('社会的証明が含まれる', () => {
      const hints = selectPsychologyHints('propose', 'warm');
      expect(hints.principleKeywords).toContain('社会的証明');
    });
  });

  describe('hot + recommend', () => {
    it('アンカリングが含まれる', () => {
      const hints = selectPsychologyHints('recommend', 'hot');
      expect(hints.principleKeywords).toContain('アンカリング');
    });
  });

  describe('warm + recommend', () => {
    it('バンドワゴンが含まれる', () => {
      const hints = selectPsychologyHints('recommend', 'warm');
      expect(hints.principleKeywords).toContain('バンドワゴン');
    });
  });

  describe('unknown stage → _default フォールバック', () => {
    it('hot + unknown_stage → hot._default', () => {
      const hints = selectPsychologyHints('unknown_stage', 'hot');
      expect(hints.principleKeywords).toContain('損失回避');
    });

    it('warm + unknown_stage → warm._default', () => {
      const hints = selectPsychologyHints('unknown_stage', 'warm');
      expect(hints.principleKeywords).toContain('返報性');
    });

    it('cold + unknown_stage → cold._default', () => {
      const hints = selectPsychologyHints('unknown_stage', 'cold');
      expect(hints.principleKeywords).toContain('返報性');
    });

    it('salesStage=null → _default', () => {
      const hints = selectPsychologyHints(null, 'warm');
      expect(hints.principleKeywords.length).toBeGreaterThan(0);
    });
  });

  describe('戻り値の型チェック', () => {
    it('principleKeywords と situationKeywords は配列', () => {
      const hints = selectPsychologyHints('close', 'hot');
      expect(Array.isArray(hints.principleKeywords)).toBe(true);
      expect(Array.isArray(hints.situationKeywords)).toBe(true);
    });
  });
});
