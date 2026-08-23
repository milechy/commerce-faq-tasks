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
// GID 1216970103691946: chat_sessions.metadata.source='user' のみを対象にする。
// metadata 列は chat_sessions の初期migrationから存在するため列の有無を動的確認
// する必要はない（PR-3訂正: 従来の information_schema 動的チェックは
// 「列がまだ無いかもしれない」という誤った前提に基づいていたため撤去した）。
// source が未設定(過去データ)のセッションは許容する(OR IS NULL)。
//
// GID 1216978855735482 かつ chat_sessions の作成経路・metadata記録そのものには
// 一切触れていない（読み取り専用の突合のみ）。

import type { Pool } from 'pg';
import { getConversionTypes } from '../admin/chat-history/chatHistoryRepository';

const USER_SOURCE_FILTER = `AND (cs.metadata->>'source' = 'user' OR cs.metadata->>'source' IS NULL)`;

const TWO_PLUS_EXCHANGES_MESSAGE_COUNT = 4;

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
  tenantId: string,
): Promise<void> {
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
       ${USER_SOURCE_FILTER}`,
    [experimentId, TWO_PLUS_EXCHANGES_MESSAGE_COUNT],
  );

  // CV(副次指標): outcomeが設定済みかつ非成約終端でない行を converted=true に更新。
  // GID 1216970103691946 (PR-6訂正): 以前は '離脱'/'不明' を全テナント共通でハード
  // コードしており、conversion_typesをカスタマイズしたテナントでは一致せず誤判定
  // していた。tenants.conversion_types の末尾2件(既定配列の並び「成約...、離脱、
  // 不明」という既存の暗黙の慣習に合わせる。ConversionTypesTab.tsx はカスタム時
  // もこの並びを崩さない前提)を、そのテナントの「非成約終端」として使う。
  const conversionTypes = await getConversionTypes(tenantId);
  const nonConvertingOutcomes = conversionTypes.slice(-2);

  await pool.query(
    `UPDATE ab_results r
     SET converted = true
     FROM chat_sessions cs
     WHERE r.experiment_id = $1
       AND r.session_id::text = cs.session_id
       AND r.converted IS NOT TRUE
       AND cs.outcome IS NOT NULL
       AND cs.outcome <> ALL($2::text[])
       ${USER_SOURCE_FILTER}`,
    [experimentId, nonConvertingOutcomes],
  );
}
