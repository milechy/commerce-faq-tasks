// src/api/admin/agent/legacyUiParity.test.ts
//
// GID 1217807273726537 (W0): 旧UI↔Copilot UI の対応台帳を機械的に検査する。
//
// docs/COPILOT_UI_PARITY.md §12 の「反映状況台帳」を単一の情報源とし、
// confirmPolicy.test.ts / cardPayloadSync.test.ts と同じ手法(readFileSync + 正規表現)で
// toolDefinitions.ts と突き合わせる。台帳を別ファイル(TSモジュール等)に複製しないのは、
// 台帳の実体が要件定義(COPILOT_UI_PARITY.md §3.1)の当初16件 + D2改訂(CP-3、
// GID 1218086647623729、2026-09-02)で追加した#17の計17件と1:1対応する表として
// ドキュメント側に存在しており、複製すると2箇所が独立に腐る(docs/LEGACY_UI_SUNSET.md が
// 自ら「更新頻度に追いつけていない前提で読め」と書いた症状の再発)ため。
//
// ★別ブランチ feature/widget-page-exclusion(commit 515bc425)が独立に17件目(別機能)を
// 追加している。マージ時は両方の行を残し(#17の重複をどちらか#18へ採番し直し)、
// この行数検査を実際の行数(18)に合わせて更新すること。台帳(§12)側にも同じ注記あり。★
//
// 検査する不変条件:
//   1. 台帳は17行ちょうどで、# が 1〜17 の重複なし連番であること
//   2. 「参照」列は `tool:<name>[,<name>...]` / `handoff:<key>` / `direct` / `pending` の
//      いずれかであること(誤字や未知の形式を検出する)。`direct` はチャットツールを経由せず
//      Copilot UI内で直接完結する実装(既存のavatarCandidates系フロントエンド直叩き
//      パターン)であることを示す。
//   3. `tool:` が参照するツール名は toolDefinitions.ts の ADMIN_AGENT_TOOLS に実在すること
//   4. `handoff:` が参照する feature キーは toolDefinitions.ts の LEGACY_UI_FEATURES に実在すること
//
// 検査しないこと(意図的な範囲外):
//   - 実装済みなのに台帳が `pending` のまま更新されていないケース。これは
//     ソースコード側からは「本当にpendingで正しい」のか「更新忘れ」なのか機械的に
//     区別できないため、レビューで見る(§12 に明記済み)。

import { readFileSync } from 'fs';
import { join } from 'path';

const LEDGER_PATH = join(__dirname, '../../../../docs/COPILOT_UI_PARITY.md');
const TOOL_DEFINITIONS_PATH = join(__dirname, 'toolDefinitions.ts');

const REF_PATTERN = /^(?:tool:([a-z0-9_]+(?:,[a-z0-9_]+)*)|handoff:([a-z0-9_]+)|direct|pending)$/;

interface LedgerRow {
  id: number;
  feature: string;
  ref: string;
}

/** docs/COPILOT_UI_PARITY.md §12 の表を抽出する。`| # | 機能 | 参照 |` 形式の行のみ対象。 */
function readLedgerRows(): LedgerRow[] {
  const source = readFileSync(LEDGER_PATH, 'utf8');
  const rows: LedgerRow[] = [];
  for (const m of source.matchAll(/^\| (\d+) \| ([^|]+) \| `([^`]+)` \|$/gm)) {
    rows.push({ id: Number(m[1]), feature: m[2]!.trim(), ref: m[3]! });
  }
  return rows;
}

/** toolDefinitions.ts の ADMIN_AGENT_TOOLS が持つツール名(snake_case、シングルクォート)。 */
function readToolNames(): Set<string> {
  const source = readFileSync(TOOL_DEFINITIONS_PATH, 'utf8');
  const matches = [...source.matchAll(/^\s*name:\s*'([a-z0-9_]+)',/gm)].map((m) => m[1]!);
  return new Set(matches);
}

/** toolDefinitions.ts の LEGACY_UI_FEATURES 配列が持つ feature キー。 */
function readLegacyUiFeatures(): Set<string> {
  const source = readFileSync(TOOL_DEFINITIONS_PATH, 'utf8');
  const arrayMatch = source.match(/export const LEGACY_UI_FEATURES = \[([\s\S]*?)\] as const;/);
  if (!arrayMatch) return new Set();
  const matches = [...arrayMatch[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
  return new Set(matches);
}

describe('legacyUiParity: 台帳(docs/COPILOT_UI_PARITY.md §12)の整合性', () => {
  const rows = readLedgerRows();

  it('台帳が空でない(パスや正規表現が壊れて0件を誤って通過させていないか)', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('台帳は17行ちょうどである(§3.1 の当初16件 + D2改訂の#17と1:1対応する)', () => {
    expect(rows).toHaveLength(17);
  });

  it('# が 1〜17 の重複なし連番である', () => {
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  it('「参照」列がすべて既定の3形式(tool: / handoff: / pending)のいずれかである', () => {
    const invalid = rows.filter((r) => !REF_PATTERN.test(r.ref));
    expect(invalid).toEqual([]);
  });

  it('`tool:` が参照するツール名はすべて toolDefinitions.ts に実在する', () => {
    const toolNames = readToolNames();
    const missing: string[] = [];
    for (const row of rows) {
      const m = row.ref.match(/^tool:(.+)$/);
      if (!m) continue;
      for (const name of m[1]!.split(',')) {
        if (!toolNames.has(name)) missing.push(`#${row.id} ${row.feature}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('`handoff:` が参照する feature キーはすべて LEGACY_UI_FEATURES に実在する', () => {
    const features = readLegacyUiFeatures();
    const missing: string[] = [];
    for (const row of rows) {
      const m = row.ref.match(/^handoff:(.+)$/);
      if (!m) continue;
      if (!features.has(m[1]!)) missing.push(`#${row.id} ${row.feature}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  // S0(可視化)の完了判定そのもの。pending が 0 になるまでは意図的に赤くならない
  // (このテストは「pending の存在」ではなく「参照の実在」だけを検査する契約のため)。
  // 現在の内訳を出力しておくと、S0 の進捗をテスト実行のたびに確認できる。
  it('現在の内訳(tool: / handoff: / direct / pending)を記録する', () => {
    const counts = { tool: 0, handoff: 0, direct: 0, pending: 0 };
    for (const row of rows) {
      if (row.ref === 'pending') counts.pending++;
      else if (row.ref === 'direct') counts.direct++;
      else if (row.ref.startsWith('tool:')) counts.tool++;
      else if (row.ref.startsWith('handoff:')) counts.handoff++;
    }
    expect(counts.tool + counts.handoff + counts.direct + counts.pending).toBe(rows.length);
  });
});
