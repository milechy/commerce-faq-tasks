// src/api/admin/agent/cardPayloadSync.test.ts
//
// GID 1217752900578379 (R4): 構造化カードの3層同期を機械的に検査する。
//
// なぜ confirmPolicy.test.ts に含めないか: confirmPolicy.test.ts の責務は
// 「書き込みツールの確認ゲート分類が漏れていないか」であり、カードの型同期は
// 別の関心事(1層でも漏れると型は通るのに画面に描画されない、という別種の障害)。
// 混ぜると「このテストが何を守っているか」がテスト名から追えなくなるため分ける。
//
// 3層の実体:
//   1. サーバの型 — src/api/admin/agent/actionExecutor.ts の各 *CardPayload
//      (kind は snake_case のシングルクォート文字列リテラル)
//   2. transport層の型 — admin-ui/src/lib/useAgentChatTransport.ts の
//      各 *AgentActionCard (kind は snake_case のダブルクォート文字列リテラル。
//      サーバ側と1:1で対応するが型そのものは共有できない)
//   3. UIの変換分岐 — admin-ui/src/pages/copilot-preview/index.tsx の
//      `if (a.card?.kind === "...")` (サーバのcardをUI用のCard型へ変換する箇所。
//      ここに分岐が無いと、型は通るのに何も描画されない)
//
// confirmPolicy.test.ts と同じ手法(readFileSync + 正規表現)で3ファイルを
// 突き合わせ、どちらか一方だけに存在する kind を検出する。

import { readFileSync } from 'fs';
import { join } from 'path';

const ACTION_EXECUTOR_PATH = join(__dirname, 'actionExecutor.ts');
const TRANSPORT_PATH = join(__dirname, '../../../../admin-ui/src/lib/useAgentChatTransport.ts');
const COPILOT_PREVIEW_PATH = join(__dirname, '../../../../admin-ui/src/pages/copilot-preview/index.tsx');

/** actionExecutor.ts の各 *CardPayload 型が持つ kind リテラル(シングルクォート)。 */
function readServerCardKinds(): string[] {
  const source = readFileSync(ACTION_EXECUTOR_PATH, 'utf8');
  return [...source.matchAll(/^\s*kind:\s*'([a-z0-9_]+)';/gm)].map((m) => m[1]!);
}

/** useAgentChatTransport.ts の各 *AgentActionCard 型が持つ kind リテラル(ダブルクォート)。 */
function readTransportCardKinds(): string[] {
  const source = readFileSync(TRANSPORT_PATH, 'utf8');
  return [...source.matchAll(/^\s*kind:\s*"([a-z0-9_]+)";/gm)].map((m) => m[1]!);
}

/**
 * copilot-preview/index.tsx がサーバの card を UI の Card へ変換している分岐で
 * 参照している snake_case の kind。`a.card?.kind === "..."` の形で出現する箇所を
 * すべて拾う(weeklySummary/chat_session_list のようにチップ生成用に複数箇所で
 * 参照されるものもあるため重複除去する)。
 */
function readCopilotPreviewHandledKinds(): Set<string> {
  const source = readFileSync(COPILOT_PREVIEW_PATH, 'utf8');
  const matches = [...source.matchAll(/a\.card\?\.kind === "([a-z0-9_]+)"/g)].map((m) => m[1]!);
  return new Set(matches);
}

describe('cardPayloadSync: サーバ/transport/UI変換分岐の3層同期', () => {
  it('サーバ(actionExecutor.ts)の全カードkindが、transport層(useAgentChatTransport.ts)にも存在する', () => {
    const serverKinds = new Set(readServerCardKinds());
    const transportKinds = new Set(readTransportCardKinds());
    const missingInTransport = [...serverKinds].filter((k) => !transportKinds.has(k));
    expect(missingInTransport).toEqual([]);
  });

  it('transport層(useAgentChatTransport.ts)の全カードkindが、サーバ(actionExecutor.ts)にも存在する(stale型の検出)', () => {
    const serverKinds = new Set(readServerCardKinds());
    const transportKinds = new Set(readTransportCardKinds());
    const staleInTransport = [...transportKinds].filter((k) => !serverKinds.has(k));
    expect(staleInTransport).toEqual([]);
  });

  // 回帰: T3(#876)の作業中、useAgentChatTransport.ts の RuleEffectAgentActionCard に
  // groupLabel フィールドを追加し忘れたまま amend せずに進めていたら、型は通っても
  // 画面に群ラベルが出ない状態でマージされていた。フィールド単位の欠落はこのテストでは
  // 検出できない(kindの存在有無のみを見る)ため、フィールド形状はレビューで見る必要がある
  // ことを明示しておく。
  it('transport層の全カードkindが、UIの変換分岐(copilot-preview/index.tsx)でも処理されている(1層漏れの検出)', () => {
    const transportKinds = new Set(readTransportCardKinds());
    const handledKinds = readCopilotPreviewHandledKinds();
    const unhandled = [...transportKinds].filter((k) => !handledKinds.has(k));
    expect(unhandled).toEqual([]);
  });

  it('UIの変換分岐が参照しているkindは、すべてtransport層に実在する(削除済みkindへの参照が残っていないか)', () => {
    const transportKinds = new Set(readTransportCardKinds());
    const handledKinds = readCopilotPreviewHandledKinds();
    const dangling = [...handledKinds].filter((k) => !transportKinds.has(k));
    expect(dangling).toEqual([]);
  });

  it('サーバのカードkind一覧が空でない(パスやパターンが壊れて0件を誤って通過させていないか)', () => {
    expect(readServerCardKinds().length).toBeGreaterThan(5);
  });
});
