// admin-ui/src/pages/admin/billing/margin/utils.test.ts
//
// ★このテストが守っている一番大事なこと★
// exportMarginCsv は「営業リストとして社外の目にも触れうる」ファイルを作る。
// tenant_id/tenant_name はDB由来でテナント管理者が設定可能な値であり、
// CSV Formula Injection(セルが =/+/-/@ で始まると Excel/Sheets が数式として
// 評価する攻撃手法。外部URL読み込み数式による情報持ち出し等に使われる)の
// 経路になりうる。ここでは実際に悪意ある値を注入して無害化を確認する。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fmtJpyConverted, fmtPct, fmtJpyOrUnavailable, fmtQuotaUsage,
  sortMarginRows, exportMarginCsv, recentMonths, monthToPeriod,
} from './utils';
import type { TenantMarginRow } from './types';

const ROW: TenantMarginRow = {
  tenant_id: 'acme', tenant_name: 'Acme', plan: 'standard',
  total_requests: 10, text_units: 5, avatar_minutes: 0,
  revenue_estimate_jpy: 1000, cost_base_usd_cents: 100, cost_base_jpy: 150,
  cost_nonbillable_usd_cents: 0, cost_nonbillable_jpy: 0,
  gross_profit_jpy: 850, gross_margin_pct: 85,
  estimation_method: 'recorded', recorded_row_ratio: 1, unavailable_reason: null,
};

describe('exportMarginCsv — CSV Formula Injection 対策', () => {
  let capturedBlob: Blob | null = null;

  function captureCsv(rows: TenantMarginRow[]): string {
    const realBlob = globalThis.Blob;
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    // Blob 自体はそのまま使い、内容だけ後で読む
    class CapturingBlob extends realBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        capturedBlob = this;
        (this as unknown as { __parts: BlobPart[] }).__parts = parts;
      }
    }
    vi.stubGlobal('Blob', CapturingBlob);

    const clicked = vi.fn();
    const anchor = { href: '', download: '', click: clicked } as unknown as HTMLAnchorElement;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    exportMarginCsv(rows, '2026-09', 150);

    const parts = (capturedBlob as unknown as { __parts: BlobPart[] }).__parts;
    return parts.map((p) => (typeof p === 'string' ? p : '')).join('');
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('★"=" で始まるテナント名は先頭にシングルクォートが付き数式化しない★', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: "=cmd|'/c calc'!A1" }]);
    expect(csv).toContain("'=cmd");
    // 生の "=cmd" がクォート無しでセル先頭に来ていないこと
    expect(csv).not.toMatch(/,=cmd/);
  });

  it('"+" で始まる値も無害化する(Excel は + も数式扱いする)', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: '+1+1' }]);
    expect(csv).toContain("'+1+1");
  });

  it('"@" で始まる値(DDE攻撃で使われる形)も無害化する', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: '@SUM(1+1)' }]);
    expect(csv).toContain("'@SUM");
  });

  it('"-" で始まる値も無害化する', () => {
    const csv = captureCsv([{ ...ROW, tenant_id: '-2+3+cmd|calc' }]);
    expect(csv).toContain("'-2+3");
  });

  it('通常のテナント名(危険な先頭文字なし)は無変更', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: 'Acme Corp' }]);
    expect(csv).toContain('Acme Corp');
    expect(csv).not.toContain("'Acme");
  });

  it('カンマ・改行・引用符を含む値は引用符で囲む(既存のエスケープを壊さない)', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: 'A,B"C\nD' }]);
    expect(csv).toContain('"A,B""C\nD"');
  });

  it('数式文字 + カンマの組み合わせでも両方の対策が効く', () => {
    const csv = captureCsv([{ ...ROW, tenant_name: '=A,B' }]);
    expect(csv).toContain('"\'=A,B"');
  });

  it('★算出不可(null)は空欄であって"0"ではない★(禁止20の回帰)', () => {
    const csv = captureCsv([{ ...ROW, revenue_estimate_jpy: null, gross_profit_jpy: null, gross_margin_pct: null }]);
    const dataLine = csv.split('\n')[1]!;
    const cols = dataLine.split(',');
    // 売上_推計_JPY(5列目, 0-indexed=5) と 粗利_推計_JPY(8列目) が空欄
    expect(cols[5]).toBe('');
    expect(cols[8]).toBe('');
  });

  it('空配列でもクラッシュしない(ヘッダ行のみ)', () => {
    const csv = captureCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
  });
});

describe('sortMarginRows — 境界・異常系', () => {
  it('★同率(タイ)のとき順序が安定している(Array.prototype.sort の安定ソート依存)★', () => {
    const rows: TenantMarginRow[] = [
      { ...ROW, tenant_id: 't1', gross_margin_pct: 50 },
      { ...ROW, tenant_id: 't2', gross_margin_pct: 50 },
      { ...ROW, tenant_id: 't3', gross_margin_pct: 50 },
    ];
    const sorted = sortMarginRows(rows, 'margin', 'asc');
    expect(sorted.map((r) => r.tenant_id)).toEqual(['t1', 't2', 't3']);
  });

  it('全行が null のとき例外を投げない(全滅ケース)', () => {
    const rows: TenantMarginRow[] = [
      { ...ROW, tenant_id: 't1', gross_margin_pct: null },
      { ...ROW, tenant_id: 't2', gross_margin_pct: null },
    ];
    expect(() => sortMarginRows(rows, 'margin', 'asc')).not.toThrow();
    expect(sortMarginRows(rows, 'margin', 'asc')).toHaveLength(2);
  });

  it('0件配列でも例外を投げない', () => {
    expect(sortMarginRows([], 'margin', 'asc')).toEqual([]);
  });

  it('desc でも null は末尾に固定される(0 扱いで先頭に来ない)', () => {
    const rows: TenantMarginRow[] = [
      { ...ROW, tenant_id: 'null-row', gross_margin_pct: null },
      { ...ROW, tenant_id: 'neg-row', gross_margin_pct: -50 },
    ];
    const sorted = sortMarginRows(rows, 'margin', 'desc');
    expect(sorted[0]!.tenant_id).toBe('neg-row');
    expect(sorted[1]!.tenant_id).toBe('null-row');
  });

  it('tenant_name が null のテナントは tenant_id で比較する(クラッシュしない)', () => {
    const rows: TenantMarginRow[] = [
      { ...ROW, tenant_id: 'zzz', tenant_name: null },
      { ...ROW, tenant_id: 'aaa', tenant_name: null },
    ];
    expect(() => sortMarginRows(rows, 'tenant', 'asc')).not.toThrow();
  });

  it('負の粗利(赤字)も正しくソートできる', () => {
    const rows: TenantMarginRow[] = [
      { ...ROW, tenant_id: 'a', gross_profit_jpy: -100 },
      { ...ROW, tenant_id: 'b', gross_profit_jpy: -500 },
      { ...ROW, tenant_id: 'c', gross_profit_jpy: 100 },
    ];
    const sorted = sortMarginRows(rows, 'profit', 'asc');
    expect(sorted.map((r) => r.tenant_id)).toEqual(['b', 'a', 'c']);
  });
});

describe('recentMonths — 境界(年またぎ)', () => {
  it('1月を含む範囲で前年12月へ正しく繰り下がる', () => {
    const months = recentMonths(3, new Date(Date.UTC(2026, 0, 15))); // 2026-01
    expect(months).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('count=0 なら空配列', () => {
    expect(recentMonths(0)).toEqual([]);
  });

  it('count=1 なら当月のみ', () => {
    expect(recentMonths(1, new Date(Date.UTC(2026, 8, 15)))).toEqual(['2026-09']);
  });
});

describe('monthToPeriod', () => {
  it('YYYY-MM を YYYYMM へ変換する', () => {
    expect(monthToPeriod('2026-09')).toBe('202609');
  });
});

describe('フォーマット関数 — null/undefined 混入時の防御', () => {
  it('fmtJpyConverted(null) は「—」であって "null" 文字列ではない', () => {
    expect(fmtJpyConverted(null)).toBe('—');
    expect(fmtJpyConverted(null)).not.toContain('null');
  });

  it('fmtJpyOrUnavailable(null) は「算出不可」', () => {
    expect(fmtJpyOrUnavailable(null)).toBe('算出不可');
  });

  it('fmtPct(0) は "0%" であって「—」ではない(0 と算出不可を区別)', () => {
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(null)).toBe('—');
  });

  it('fmtQuotaUsage(0) は "0%" であって「枠なし」ではない', () => {
    expect(fmtQuotaUsage(0)).toBe('0%');
    expect(fmtQuotaUsage(null)).toBe('枠なし');
  });

  it('負の金額も符号付きでそのまま表示する(赤字を隠さない)', () => {
    expect(fmtJpyOrUnavailable(-500)).toContain('-');
  });
});
