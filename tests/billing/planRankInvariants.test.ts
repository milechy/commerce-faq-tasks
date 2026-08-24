// tests/billing/planRankInvariants.test.ts
//
// TenantPlan/PLAN_RANK/FEATURE_MIN_PLAN は以下の3箇所に独立して定義されている
// (src/lib/billing/planFeatures.ts と admin-ui/src/lib/planFeatures.ts はimportで
// 共有できない — server と admin-ui はビルド・tsconfigが別のcross-packageのため)。
// 過去に実際に1回この3箇所がズレたことがあるが、通常のimportベースのテストでは
// 検知できない(admin-uiはserver側のモジュールをimportしていないため、片方だけ
// 直し忘れてもTypeScriptの型チェックすら通ってしまう)。
//
// このファイルは tests/widget/widgetSourceInvariants.test.ts と同じ手法を踏襲し、
// 3ファイルのソーステキストを直接読み込んで PLAN_RANK / FEATURE_MIN_PLAN の
// オブジェクトリテラルを正規表現で抽出・パースし、内容が一致することをロックする。

import fs from 'fs';
import path from 'path';

const SERVER_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/lib/billing/planFeatures.ts'),
  'utf8',
);
const ADMIN_UI_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../admin-ui/src/lib/planFeatures.ts'),
  'utf8',
);
const USE_AUTH_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../admin-ui/src/auth/useAuth.tsx'),
  'utf8',
);

/**
 * `NAME: Record<...> = { ...obj literal... };` の形の宣言を抽出し、
 * 素朴な変換(コメント除去→キーをクォート→末尾カンマ除去)でJSONとしてパースする。
 * 値は文字列/数値のみを想定(このリポジトリのPLAN_RANK/FEATURE_MIN_PLANは全てそう)。
 */
function extractRecordLiteral(src: string, name: string): Record<string, unknown> {
  const re = new RegExp(`${name}\\s*:\\s*Record<[^>]+>\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`${name} のオブジェクトリテラルが見つからない: 抽出用正規表現の更新が必要`);
  }
  const jsonish = match[1]
    .replace(/\/\/.*$/gm, '')
    .replace(/(\w+)\s*:/g, '"$1":')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(jsonish);
}

/**
 * `export type TenantPlan = "a" | "b" | ...;` の形の union type 宣言から
 * リテラル値の一覧を抽出する。
 */
function extractStringUnion(src: string, typeName: string): string[] {
  const re = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`type ${typeName} が見つからない: 抽出用正規表現の更新が必要`);
  }
  return match[1]
    .split('|')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

describe('TenantPlan/PLAN_RANK/FEATURE_MIN_PLAN のクロスパッケージ整合性', () => {
  it('PLAN_RANK が server(src/lib/billing/planFeatures.ts) と admin-ui(admin-ui/src/lib/planFeatures.ts) で一致する', () => {
    const serverRank = extractRecordLiteral(SERVER_SRC, 'PLAN_RANK');
    const adminUiRank = extractRecordLiteral(ADMIN_UI_SRC, 'PLAN_RANK');
    expect(adminUiRank).toEqual(serverRank);
  });

  it('FEATURE_MIN_PLAN が server と admin-ui で一致する', () => {
    const serverFeatureMinPlan = extractRecordLiteral(SERVER_SRC, 'FEATURE_MIN_PLAN');
    const adminUiFeatureMinPlan = extractRecordLiteral(ADMIN_UI_SRC, 'FEATURE_MIN_PLAN');
    expect(adminUiFeatureMinPlan).toEqual(serverFeatureMinPlan);
  });

  it('TenantPlan の取りうる値が admin-ui/src/auth/useAuth.tsx の TenantPlan と一致する(既知の三重化)', () => {
    const serverRank = extractRecordLiteral(SERVER_SRC, 'PLAN_RANK');
    const useAuthPlans = extractStringUnion(USE_AUTH_SRC, 'TenantPlan');
    expect(useAuthPlans.slice().sort()).toEqual(Object.keys(serverRank).sort());
  });

  it('TenantPlan の取りうる値が admin-ui/src/lib/planFeatures.ts の PLAN_RANK のキーと一致する', () => {
    const adminUiRank = extractRecordLiteral(ADMIN_UI_SRC, 'PLAN_RANK');
    const useAuthPlans = extractStringUnion(USE_AUTH_SRC, 'TenantPlan');
    expect(useAuthPlans.slice().sort()).toEqual(Object.keys(adminUiRank).sort());
  });
});
