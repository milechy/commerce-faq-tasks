// src/api/admin/agent/billingToolCopySync.test.ts
//
// Asana GID 1218086647363731 (CP-1): get_billing_summary の説明文と
// 旧UI(admin-ui)の実装との整合を機械的に検査する。
//
// なぜこのテストが要るか: 2026-08-25の決定D2(「請求は閲覧のみ、変更操作は
// super_admin専用の別画面」)を前提に get_billing_summary の description を
// 書いたが、その後の旧UIの機能追加(PR #1007/#1013/#1017)でテナント自身が
// プラン変更できるようになった(admin-ui/src/pages/admin/billing/PlanSection.tsx
// の canChangePlan、および PUT /v1/admin/my-tenant/plan)。description 側は
// 追随せず「プラン変更はテナント自身は実行できない」という誤った文言が1週間
// 気付かれずに残り、テナントが Copilot に「プランを変えたい」と聞くと
// できることをできないと答える状態になっていた。confirmPolicy.test.ts /
// cardPayloadSync.test.ts / legacyUiParity.test.ts と同じ手法
// (readFileSync + 正規表現で2ファイルを突合する)で再発を防ぐ。

import { readFileSync } from 'fs';
import { join } from 'path';

const TOOL_DEFINITIONS_PATH = join(__dirname, 'toolDefinitions.ts');
const PLAN_SECTION_PATH = join(__dirname, '../../../../admin-ui/src/pages/admin/billing/PlanSection.tsx');

/** get_billing_summary の description（連結後の全文）を取り出す。 */
function readBillingSummaryDescription(): string {
  const source = readFileSync(TOOL_DEFINITIONS_PATH, 'utf8');
  const blockMatch = source.match(/name:\s*'get_billing_summary',\s*description:\s*([\s\S]*?)\n\s*parameters:/);
  if (!blockMatch) return '';
  const literals = [...blockMatch[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
  return literals.join('');
}

/** PlanSection.tsx が client_admin にプラン変更ボタンを許可しているか(canChangePlan)。 */
function planSectionAllowsClientAdminToChangePlan(): boolean {
  const source = readFileSync(PLAN_SECTION_PATH, 'utf8');
  return /canChangePlan\s*=\s*user\?\.role\s*===\s*["']client_admin["']/.test(source);
}

describe('billingToolCopySync: get_billing_summary の説明文と旧UIの実装の整合', () => {
  it('description の抽出が空でない(パスや正規表現が壊れて0件を誤って通過させていないか)', () => {
    expect(readBillingSummaryDescription().length).toBeGreaterThan(0);
  });

  it('前提: PlanSection.tsx で client_admin にプラン変更(canChangePlan)が許可されている', () => {
    // この前提が崩れたら(旧UI側でテナント自身のプラン変更が撤回されたら)、
    // 下の不変条件テストの意味も変わる。silent passを避けるため明示的に確認する。
    expect(planSectionAllowsClientAdminToChangePlan()).toBe(true);
  });

  // 固定する不変条件: PlanSection.tsx に canChangePlan(client_admin許可)が存在する限り、
  // get_billing_summary の description は「プラン変更」を「テナント自身は実行できない」側の
  // 列挙に含めてはならない。フルテキスト完全一致では比較しない(文言の推敲で無関係に
  // 落ちるため)。「実行できない」を含む文だけを取り出し、その文にキーワード「プラン変更」が
  // 同居していないかをキーワード単位で見る。
  it('client_admin にプラン変更が許可されている限り、「テナント自身は実行できない」の文に「プラン変更」を含めない', () => {
    expect(planSectionAllowsClientAdminToChangePlan()).toBe(true);

    const description = readBillingSummaryDescription();
    const sentences = description.split('。');
    const cannotExecuteSentences = sentences.filter((s) => s.includes('実行できない'));

    // 検出漏れの罠: 「実行できない」の文言自体がdescriptionから消えていたら
    // filterは常に空になり、下のassertが無意味に緑化する。文が実在することを確認する。
    expect(cannotExecuteSentences.length).toBeGreaterThan(0);

    const violating = cannotExecuteSentences.filter((s) => s.includes('プラン変更'));
    expect(violating).toEqual([]);
  });
});
