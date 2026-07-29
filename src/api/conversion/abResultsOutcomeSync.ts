// src/api/conversion/abResultsOutcomeSync.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤 — 成果の遅延反映
//
// 割当時点(露出)でab_resultsにconverted=NULLの行が入る想定(avatarAbExperiment.ts参照)。
// このモジュールは、結果集計(GET /v1/admin/ab/experiments/:id/results)の直前に
// 呼び出され、chat_sessionsと突合して以下を書き戻す:
//   - reached_two_plus_exchanges: 主要指標。2往復以上（message_count >= 4。
//     saveMessage は user/assistant 各1回ずつ message_count を+1するため、
//     2往復 = 4メッセージ）に到達していれば true。
//   - converted: 副次指標。chat_sessions.outcome が設定されており、かつ
//     デフォルトのconversion_types終端2件（'離脱','不明'）でなければ true とみなす簡易判定。
//     conversion_typesはテナントごとにカスタム可能なため厳密ではないが、CV率は
//     判定に使わない副次指標のため許容する（タスク仕様）。
//
// GID 1216995497... (lane-instrumentのトラフィック分離と並行): chat_sessions.metadata.source
// が導入され次第 source='user' のみを対象にする契約。カラムがまだ存在しない間は
// フィルタを適用しない（未設定を許容）。カラムの有無は毎回 information_schema で
// 確認する（結果APIは高頻度エンドポイントではないため許容できるオーバーヘッド）。
//
// GID 1216978855735482 かつ chat_sessions の作成経路・metadata記録そのものには
// 一切触れていない（読み取り専用の突合のみ）。

import type { Pool } from 'pg';

const TWO_PLUS_EXCHANGES_MESSAGE_COUNT = 4;

// デフォルトのconversion_types終端2件（admin-ui/src/pages/admin/tenants/ConversionTypesTab.tsx
// のデフォルト値と一致させる）。カスタムconversion_typesのテナントでは不正確になりうるが、
// CV率は副次指標(記録のみ・判定に使わない)のため許容する。
const NON_CONVERTING_OUTCOMES = ['離脱', '不明'];

/**
 * chat_sessions に metadata カラムが存在するか確認する。
 * TODO(GID 1216978855735482 / lane-instrument連携): metadata.source 列が入り次第、
 * 下記の存在チェックを廃止し常に `AND (cs.metadata->>'source' = 'user' OR cs.metadata->>'source' IS NULL)`
 * を適用してよい。現状は移行期間中のため動的に判定する。
 */
async function chatSessionsHasMetadataColumn(pool: Pick<Pool, 'query'>): Promise<boolean> {
  try {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'chat_sessions' AND column_name = 'metadata'
       ) AS exists`,
    );
    return result.rows[0]?.exists === true;
  } catch {
    return false;
  }
}

/**
 * 指定experimentの未解決(reached_two_plus_exchanges IS NULL)露出行をchat_sessionsと突合し、
 * reached_two_plus_exchanges / converted を書き戻す。
 * message_countは単調増加するため、まだ2往復未満のセッションは次回呼び出し時に
 * 再評価される（「未到達」を確定値として書き込むことはない — NULLのまま残す）。
 * best-effort: 失敗しても結果集計自体は止めない（呼び出し元でtry/catchすること）。
 */
export async function reconcileAbResultOutcomes(
  pool: Pick<Pool, 'query'>,
  experimentId: number,
): Promise<void> {
  const hasMetadata = await chatSessionsHasMetadataColumn(pool);
  const sourceFilter = hasMetadata
    ? `AND (cs.metadata->>'source' = 'user' OR cs.metadata->>'source' IS NULL)`
    : '';

  // 2往復以上に到達した行: reached_two_plus_exchanges を true に更新
  // NOTE: ab_results.session_id は UUID型だが chat_sessions.session_id は TEXT型
  // （widget側でcrypto.randomUUID()により常にUUID形式の値が入るが、カラム型としては
  // TEXTのため、PostgresはUUID=TEXTの暗黙キャストを行わずエラーになる。r側を::textで
  // 明示キャストして比較する）。
  await pool.query(
    `UPDATE ab_results r
     SET reached_two_plus_exchanges = true
     FROM chat_sessions cs
     WHERE r.experiment_id = $1
       AND r.session_id::text = cs.session_id
       AND r.reached_two_plus_exchanges IS NOT TRUE
       AND cs.message_count >= $2
       ${sourceFilter}`,
    [experimentId, TWO_PLUS_EXCHANGES_MESSAGE_COUNT],
  );

  // CV(副次指標): outcomeが設定済みかつ非離脱/不明の行を converted=true に更新
  await pool.query(
    `UPDATE ab_results r
     SET converted = true
     FROM chat_sessions cs
     WHERE r.experiment_id = $1
       AND r.session_id::text = cs.session_id
       AND r.converted IS NOT TRUE
       AND cs.outcome IS NOT NULL
       AND cs.outcome <> ALL($2::text[])
       ${sourceFilter}`,
    [experimentId, NON_CONVERTING_OUTCOMES],
  );
}
