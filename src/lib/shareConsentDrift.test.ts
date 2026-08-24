// src/lib/shareConsentDrift.test.ts
//
// 「share=ON か」の判定は JS(resolveLearningConsentFromFeatures)と SQL
// (shareConsentSqlPredicate)の2つの実装で行われる。両者がズレると、
// 片方だけ true になるテナントが生まれる:
//
//   SQL=true / JS=false → global ルールは読めるが、hermes-mcp の export は 403。
//                         つまり「共有プールから受け取るだけで出さない」タダ乗りが
//                         無言で成立する(要件 X1/X2 が禁じた状態そのもの)。
//   SQL=false / JS=true → export はされるのに global ルールが届かない(逆に損をする)。
//
// このファイルは両実装を同一のケース表で突き合わせ、ドリフトを検知する。
//
// ■ SQL 側の検証方法について
// jest 実行環境に Postgres は無い(このリポジトリのテストは pool をモックする慣習)。
// そのため SQL の「意味」は、本番 Postgres で実測した結果を expected として
// この表に固定し、SQL 文字列側は「その意味を壊す書き換えが入っていないか」を
// 正規表現で機械的に検査する、という二段構えにしている。
//
// 実測は本番VPS(ssh root@65.108.159.161, /opt/rajiuce/.env の DATABASE_URL)で
// 2026-08-25 に実施。11ケースすべてで JS と SQL が一致することを確認済み。
// 実測に使ったクエリの骨子:
//   with cases(label, f) as (values ('A','{"learning":{"learn":true,"share":true}}'::jsonb), ...)
//   select label, <shareConsentSqlPredicate('f') 相当> from cases;
//
// ■ この検査が実際に落ちた実績(2026-08-25)
// 導入前の SQL は `(features->'learning'->>'share') = 'true'` という形だった。
// ->> はテキスト化するため、以下の2ケースで JS と食い違っていた:
//   E: {"learn":true,"share":"true"}  (share が文字列) → SQL:true / JS:false
//   F: {"share":true}                 (learn 欠落)     → SQL:true / JS:false
// jsonb_typeof で learn/share が両方 boolean であることを要求し、値の比較も
// -> と 'true'::jsonb で行う形に修正して一致させた。

import { resolveLearningConsentFromFeatures, shareConsentSqlPredicate } from './hermesConsent';

jest.mock('./logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * features の形状ごとの期待値。
 * expectedShare は「JSとSQLの双方がこの値を返さなければならない」という契約。
 * SQL 側の値は上記のとおり本番 Postgres で実測済み。
 */
const CASES: Array<{ label: string; features: unknown; expectedShare: boolean; note: string }> = [
  {
    label: 'A',
    features: { learning: { learn: true, share: true } },
    expectedShare: true,
    note: '正常: 新形式で share=true',
  },
  {
    label: 'B',
    features: { learning: { learn: true, share: false } },
    expectedShare: false,
    note: '正常: 新形式で share=false',
  },
  {
    label: 'C',
    features: { hermes_raw_data_consent: true },
    expectedShare: true,
    note: '後方互換: learning 未設定 + 旧フラグ true',
  },
  {
    label: 'D',
    features: { hermes_raw_data_consent: false },
    expectedShare: false,
    note: '後方互換: learning 未設定 + 旧フラグ false',
  },
  {
    label: 'E',
    features: { learning: { learn: true, share: 'true' } },
    expectedShare: false,
    note: 'share が boolean ではなく文字列 "true"。緩い ->> 比較だと true に化けた実績あり',
  },
  {
    label: 'F',
    features: { learning: { share: true } },
    expectedShare: false,
    note: 'learn 欠落で形が不正。緩い比較だと true に化けた実績あり',
  },
  {
    label: 'G',
    features: { learning: null, hermes_raw_data_consent: true },
    expectedShare: false,
    note: 'learning が JSON null。旧フラグへはフォールバックしない(SQL の IS NULL も false)',
  },
  {
    label: 'H',
    features: { learning: {} },
    expectedShare: false,
    note: 'learning が空オブジェクト',
  },
  {
    label: 'I',
    features: { learning: 'x' },
    expectedShare: false,
    note: 'learning が文字列',
  },
  {
    label: 'J',
    features: { learning: [1, 2] },
    expectedShare: false,
    note: 'learning が配列',
  },
  {
    label: 'K',
    features: {},
    expectedShare: false,
    note: 'features が空(新規テナント相当)',
  },
];

describe('share 判定: JS と SQL のドリフト検知', () => {
  describe('JS 側(resolveLearningConsentFromFeatures)がケース表どおりに解決する', () => {
    it.each(CASES)('$label: $note', ({ features, expectedShare }) => {
      expect(resolveLearningConsentFromFeatures(features as never).share).toBe(expectedShare);
    });
  });

  describe('SQL 側(shareConsentSqlPredicate)が JS と同じ意味を保っている', () => {
    const sql = shareConsentSqlPredicate('t.features');

    it('learn / share が boolean であることを jsonb_typeof で要求している(ケースE/F対策)', () => {
      expect(sql).toContain("jsonb_typeof(t.features->'learning'->'learn') = 'boolean'");
      expect(sql).toContain("jsonb_typeof(t.features->'learning'->'share') = 'boolean'");
    });

    it("share の値比較を ->> (text) ではなく -> と 'true'::jsonb で行っている", () => {
      expect(sql).toContain("(t.features->'learning'->'share') = 'true'::jsonb");
    });

    it("退行検知: 緩い ->>'share' = 'true' の形に戻っていない(ケースE/Fが再び true に化ける形)", () => {
      expect(sql).not.toMatch(/->>\s*'share'\s*\)?\s*=\s*'true'/);
    });

    it('後方互換の分岐(learning 未設定のときだけ旧フラグを見る)が残っている', () => {
      expect(sql).toContain("(t.features->'learning') IS NULL");
      expect(sql).toContain("(t.features->>'hermes_raw_data_consent') = 'true'");
    });

    it('渡した features 式が全ての参照箇所に適用される(エイリアス取り違えでNULL扱いにならない)', () => {
      // "features" という素の列名が t.features 以外の形で紛れ込んでいないこと。
      // (t.features を渡したのに一部が features のままだと、別テーブルの列を
      //  参照して常に false になる/エラーになる)
      const strippedAliased = sql.split('t.features').join('');
      expect(strippedAliased).not.toContain('features');
    });

    it('呼び出し側のエイリアスをそのまま反映する(hermesConsent 側は素の features を使う)', () => {
      const unaliased = shareConsentSqlPredicate('features');
      expect(unaliased).toContain("jsonb_typeof(features->'learning'->'learn') = 'boolean'");
      expect(unaliased).not.toContain('t.features');
    });
  });

  describe('ケース表そのものの健全性', () => {
    it('true になるケースと false になるケースの両方を含む(片側だけの表になっていない)', () => {
      expect(CASES.some((c) => c.expectedShare)).toBe(true);
      expect(CASES.some((c) => !c.expectedShare)).toBe(true);
    });

    it('過去に実際にドリフトした形(E: share文字列 / F: learn欠落)が表から消えていない', () => {
      const labels = CASES.map((c) => c.label);
      expect(labels).toEqual(expect.arrayContaining(['E', 'F']));
      expect(CASES.find((c) => c.label === 'E')!.expectedShare).toBe(false);
      expect(CASES.find((c) => c.label === 'F')!.expectedShare).toBe(false);
    });
  });
});
