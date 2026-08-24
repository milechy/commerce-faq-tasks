// tests/phase38/globalRuleGate.test.ts
// 共有学習プールの参加モデル S3(GID 1217769376950104: 要件§6 X1・X2 / 受け入れ G1・E4・E9・E10)
//
// tuningRulesRepository.test.ts / judgeEvaluator.test.ts は「正しい入力に正しい出力が
// 返るか」を検証する挙動テスト。このファイルは excludedIds.test.ts /
// widgetSourceInvariants.test.ts / confirmPolicy.test.ts と同じ流儀で、ソースコードを
// 正規表現で走査する「機械ガード」に専念する(挙動テストと目的を混ぜない)。
//
// 検査内容:
//   a) src/ 配下に「述語(GLOBAL_RULE_VISIBILITY_WHERE)を経由しない生の
//      tenant_id = 'global'(tuning_rules 文脈)」が残っていないこと。
//      許可リストは crossTenantContext.ts のコメントのみ(同ファイルは tuning_rules を
//      一切読まないため、そもそも本チェックには引っかからない設計)。
//   b) judgeEvaluator.ts が GLOBAL_RULE_VISIBILITY_WHERE を import していること
//   c) GLOBAL_RULE_VISIBILITY_WHERE がエイリアス t(tenants)を含むこと
//      (引数化されていないこと。PR #896 の FAQ_VISIBILITY_WHERE と同じ理由)

import fs from 'fs';
import path from 'path';
import { GLOBAL_RULE_VISIBILITY_WHERE } from '../../src/api/admin/tuning/tuningRulesRepository';

const SRC_DIR = path.resolve(__dirname, '../../src');

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// 「述語を経由しない生の tenant_id = 'global'」の判定パターン。
// tuning_rules 文脈だけを対象にするため、"FROM tuning_rules" の近傍(前後300文字)に
// 生のOR結合パターンが現れる場合のみ違反とみなす。他テーブル
// (faq_embeddings / sai_task_rules / principles 等)の同型パターンはこのタスクの
// スコープ外であり、対象にしない(誤検知防止。実測: 最も近い他テーブルの
// 事例でも距離1000文字以上あり、tuning_rules 実例は距離30文字以内)。
const RAW_OR_GLOBAL = /tenant_id\s*=\s*\$\d+\s*OR\s*tenant_id\s*=\s*'global'/;
const PROXIMITY_WINDOW = 300;

describe('tuning_rules の global 可視性: 機械ガード(S3, GID 1217769376950104)', () => {
  const files = walkTsFiles(SRC_DIR);

  it('a) src/ 配下に、述語を経由しない生の "tenant_id = $N OR tenant_id = \'global\'"(tuning_rules 文脈)が残っていない', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      let fromIdx = content.indexOf('FROM tuning_rules');
      while (fromIdx !== -1) {
        const windowStart = Math.max(0, fromIdx - PROXIMITY_WINDOW);
        const windowEnd = Math.min(content.length, fromIdx + PROXIMITY_WINDOW);
        const window = content.slice(windowStart, windowEnd);
        if (RAW_OR_GLOBAL.test(window)) {
          violations.push(path.relative(SRC_DIR, file));
        }
        fromIdx = content.indexOf('FROM tuning_rules', fromIdx + 1);
      }
    }

    expect(violations).toEqual([]);
  });

  it('b) judgeEvaluator.ts が GLOBAL_RULE_VISIBILITY_WHERE を import している', () => {
    const judgeSrc = fs.readFileSync(
      path.resolve(SRC_DIR, 'agent/judge/judgeEvaluator.ts'),
      'utf8',
    );
    expect(judgeSrc).toMatch(
      /import\s*\{\s*GLOBAL_RULE_VISIBILITY_WHERE\s*\}\s*from\s*['"][^'"]*tuningRulesRepository['"]/,
    );
  });

  it('c) GLOBAL_RULE_VISIBILITY_WHERE はエイリアス t(tenants)を含む(引数化されていない)', () => {
    expect(GLOBAL_RULE_VISIBILITY_WHERE).toMatch(/FROM tenants t\b/);
    expect(GLOBAL_RULE_VISIBILITY_WHERE).toMatch(/\bt\.id\s*=\s*\$1\b/);
    expect(GLOBAL_RULE_VISIBILITY_WHERE).toMatch(/\bt\.features\b/);
  });

  // 補助: bindは$1=tenantId固定。呼び出し側がプレースホルダ番号をずらして使うと
  // 述語が別の値と誤って比較される事故になるため、定数自体が$1のみを参照することを固定する。
  it('補助: GLOBAL_RULE_VISIBILITY_WHERE が参照するバインド変数は $1 のみ', () => {
    const placeholders = GLOBAL_RULE_VISIBILITY_WHERE.match(/\$\d+/g) ?? [];
    expect(new Set(placeholders)).toEqual(new Set(['$1']));
  });
});
