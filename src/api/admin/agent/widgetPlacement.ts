// src/api/admin/agent/widgetPlacement.ts
//
// ウィジェットの設置位置（widget_theme.position / offsetX / offsetY）の検証と、
// 埋め込みコード属性への変換。
//
// なぜ設定可能にしているか: FAB は z-index に int 最大値を使うため、テナントサイト側の
// 「トップへ戻る」ボタン・カート・LINE相談などが右下にあると、見えなくなるだけでなく
// クリック不能になる（=こちらが相手のサイトを壊す）。寄せる角と余白を逃げ道として公開する。
//
// ⚠️ 同じ関心事が admin-ui/src/pages/admin/tenants/EmbedCodeTab.tsx にもある。
// admin-ui は別ビルドで src/ から import できないため複製になっている。片方だけ直さない。
// 丸め範囲は public/widget.js の parseOffset() と一致させること。

export const WIDGET_POSITIONS = ['bottom-right', 'bottom-left'] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const WIDGET_OFFSET_MIN = 0;
export const WIDGET_OFFSET_MAX = 320;

/**
 * 既定値。埋め込みコードには出力しない（widget.js 側の既定と同じため）。
 * get_widget_placement が「現在値 vs 既定値」を提示するためにも参照する。
 */
export const DEFAULT_WIDGET_POSITION: WidgetPosition = 'bottom-right';
export const DEFAULT_WIDGET_OFFSET = 24;

export function isValidWidgetPosition(value: unknown): value is WidgetPosition {
  return typeof value === 'string' && (WIDGET_POSITIONS as readonly string[]).includes(value);
}

/**
 * 余白を px の整数として解釈する。範囲外・非数値は null（=不正）。
 * LLM 由来の引数は数値と数字文字列が混在するため両方受ける。
 */
export function parseWidgetOffset(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < WIDGET_OFFSET_MIN || n > WIDGET_OFFSET_MAX) return null;
  return n;
}

/**
 * set_widget_theme の入力検証。問題があればユーザー向け日本語メッセージ、無ければ null。
 * 不正値を保存させると埋め込みコードが壊れた属性を持つため、書き込み前に弾く。
 */
export function validateWidgetPlacement(theme: Record<string, unknown>): string | null {
  const position = theme['position'];
  if (position !== undefined && !isValidWidgetPosition(position)) {
    return `position は ${WIDGET_POSITIONS.join(' か ')} で指定してください（例: "bottom-left"）`;
  }
  for (const key of ['offsetX', 'offsetY']) {
    const raw = theme[key];
    if (raw !== undefined && parseWidgetOffset(raw) === null) {
      return `${key} は ${WIDGET_OFFSET_MIN}〜${WIDGET_OFFSET_MAX} の整数（px）で指定してください（例: 96）`;
    }
  }
  return null;
}

/**
 * widget_theme から埋め込みコードに追記する属性行を組み立てる。
 * 既定値と同じ設定・不正値は出力しない（テナントがコピペするスニペットを短く保つため、
 * また直接DBを触られた場合に壊れた属性を出さないため）。
 */
export function buildPlacementAttributes(theme: Record<string, unknown> | null | undefined): string {
  if (!theme) return '';
  const attrs: string[] = [];

  const position = theme['position'];
  if (isValidWidgetPosition(position) && position !== DEFAULT_WIDGET_POSITION) {
    attrs.push(`data-position="${position}"`);
  }
  const pairs: Array<[string, string]> = [
    ['offsetX', 'data-offset-x'],
    ['offsetY', 'data-offset-y'],
  ];
  for (const [key, attr] of pairs) {
    const offset = parseWidgetOffset(theme[key]);
    if (offset !== null && offset !== DEFAULT_WIDGET_OFFSET) {
      attrs.push(`${attr}="${offset}"`);
    }
  }

  return attrs.map((a) => `\n  ${a}`).join('');
}
