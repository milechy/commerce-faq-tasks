import {
  isValidWidgetPosition,
  parseWidgetOffset,
  validateWidgetPlacement,
  buildPlacementAttributes,
} from './widgetPlacement';

describe('widgetPlacement', () => {
  describe('parseWidgetOffset', () => {
    it('数値・数字文字列の両方を受ける（LLM由来の引数は型が揺れる）', () => {
      expect(parseWidgetOffset(96)).toBe(96);
      expect(parseWidgetOffset('96')).toBe(96);
      expect(parseWidgetOffset(' 96 ')).toBe(96);
    });

    it('境界値 0 と 320 は通す', () => {
      expect(parseWidgetOffset(0)).toBe(0);
      expect(parseWidgetOffset(320)).toBe(320);
    });

    it('範囲外・非整数・非数値・真偽値は null', () => {
      expect(parseWidgetOffset(-1)).toBeNull();
      expect(parseWidgetOffset(321)).toBeNull();
      expect(parseWidgetOffset(24.5)).toBeNull();
      expect(parseWidgetOffset('96px')).toBeNull();
      expect(parseWidgetOffset('')).toBeNull();
      expect(parseWidgetOffset(NaN)).toBeNull();
      expect(parseWidgetOffset(true)).toBeNull();
      expect(parseWidgetOffset(null)).toBeNull();
      expect(parseWidgetOffset(undefined)).toBeNull();
      expect(parseWidgetOffset({})).toBeNull();
    });
  });

  describe('isValidWidgetPosition', () => {
    it('許可されている2値のみ', () => {
      expect(isValidWidgetPosition('bottom-right')).toBe(true);
      expect(isValidWidgetPosition('bottom-left')).toBe(true);
      expect(isValidWidgetPosition('top-left')).toBe(false);
      expect(isValidWidgetPosition('BOTTOM-LEFT')).toBe(false);
      expect(isValidWidgetPosition(undefined)).toBe(false);
    });
  });

  describe('validateWidgetPlacement', () => {
    it('未指定・正常値は null（エラーなし）', () => {
      expect(validateWidgetPlacement({})).toBeNull();
      expect(validateWidgetPlacement({ primaryColor: '#3B82F6' })).toBeNull();
      expect(validateWidgetPlacement({ position: 'bottom-left', offsetX: 0, offsetY: 96 })).toBeNull();
    });

    it('不正な position は日本語メッセージを返す', () => {
      const msg = validateWidgetPlacement({ position: 'top-right' });
      expect(msg).toContain('position');
      expect(msg).toContain('bottom-left');
    });

    it('不正な offset はどちらのキーでも弾く', () => {
      expect(validateWidgetPlacement({ offsetX: 999 })).toContain('offsetX');
      expect(validateWidgetPlacement({ offsetY: 'abc' })).toContain('offsetY');
    });

    // フロントのスライダーは min=0/max=320 で境界外を防ぐが、set_widget_theme は
    // フロント以外(LLMの引数生成ミス・将来の別UI)からも呼ばれうる唯一の安全網。
    // ここでは境界のすぐ外側(321, -1)と不正enum(top-left)を、実際にサーバへ
    // 直接渡された想定で明示的に固定する。
    it('境界のすぐ外側(offsetY: 321, offsetY: -1)を明示的に弾く', () => {
      const over = validateWidgetPlacement({ offsetY: 321 });
      expect(over).toContain('offsetY');
      expect(over).toContain('0〜320');

      const under = validateWidgetPlacement({ offsetY: -1 });
      expect(under).toContain('offsetY');
      expect(under).toContain('0〜320');
    });

    it('不正なenum値 position: "top-left" を明示的に弾く(bottom-right/bottom-leftのみ許可)', () => {
      const msg = validateWidgetPlacement({ position: 'top-left' });
      expect(msg).toContain('position');
      expect(msg).toContain('bottom-right');
      expect(msg).toContain('bottom-left');
    });
  });

  describe('buildPlacementAttributes', () => {
    it('未設定・null は空文字（既定の埋め込みコードを汚さない）', () => {
      expect(buildPlacementAttributes(null)).toBe('');
      expect(buildPlacementAttributes(undefined)).toBe('');
      expect(buildPlacementAttributes({})).toBe('');
    });

    it('既定値と同じ設定は出力しない', () => {
      expect(buildPlacementAttributes({ position: 'bottom-right', offsetX: 24, offsetY: 24 })).toBe('');
    });

    it('既定と異なる設定のみ属性化する', () => {
      expect(buildPlacementAttributes({ position: 'bottom-left' })).toBe('\n  data-position="bottom-left"');
      expect(buildPlacementAttributes({ offsetY: 96 })).toBe('\n  data-offset-y="96"');
      expect(buildPlacementAttributes({ position: 'bottom-left', offsetX: 16, offsetY: 96 })).toBe(
        '\n  data-position="bottom-left"\n  data-offset-x="16"\n  data-offset-y="96"'
      );
    });

    it('offset 0 は既定と異なるので出力する（falsy 取り違えの回帰）', () => {
      expect(buildPlacementAttributes({ offsetX: 0 })).toBe('\n  data-offset-x="0"');
    });

    it('DBを直接触られた場合の不正値は黙って捨てる（壊れた属性を出さない）', () => {
      expect(buildPlacementAttributes({ position: 'top-left', offsetY: 9999 })).toBe('');
      expect(buildPlacementAttributes({ position: '" onload="alert(1)' })).toBe('');
      expect(buildPlacementAttributes({ offsetX: '12"><script>' })).toBe('');
    });

    it('primaryColor など無関係のキーは無視する', () => {
      expect(buildPlacementAttributes({ primaryColor: '#3B82F6', tone: 'polite' })).toBe('');
    });
  });
});
