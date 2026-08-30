// src/lib/db.ts
// Single shared PostgreSQL connection pool for the application.
// Import `pool` for nullable access (null when DATABASE_URL is absent),
// or `getPool()` for guaranteed access (throws if DATABASE_URL is not set).

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { config } from "../config/env";

const POOL_MAX = 10;
const POOL_IDLE_TIMEOUT_MS = 30_000;
const POOL_CONNECTION_TIMEOUT_MS = 5_000;

export const pool: InstanceType<typeof Pool> | null = config.DATABASE_URL
  ? new Pool({
      connectionString: config.DATABASE_URL,
      max: POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    })
  : null;

/** Returns the shared pool. Throws if DATABASE_URL is not set. */
export function getPool(): InstanceType<typeof Pool> {
  if (!pool) throw new Error("DATABASE_URL is not set");
  return pool;
}

process.on("beforeExit", () => {
  void pool?.end();
});

// ---------------------------------------------------------------------------
// RLS 配線: withTenant() — トランザクション単位でテナントコンテキストを注入する
// ---------------------------------------------------------------------------
// phase76_rls_tenant_isolation.sql が敷いた Row Level Security ポリシーは、
// GUC `app.current_tenant`(と super_admin 用 `app.is_super_admin`)を読む。
// このラッパは 1 トランザクション内でその GUC を設定し、コールバックに同じ
// クライアントを渡す。これにより、そのトランザクション内の全クエリが
// アプリ層の WHERE 述語とは独立に、DB 側でもテナント行に絞られる(多層防御)。
//
// ★重要な前提と限界(誠実に明記する)★
//  - 本ラッパは既存の getPool().query(...) 経路を置き換えるものではない。まず
//    「代表経路で使える薄い配線」を用意する段階であり、全 300 本超のクエリを
//    これ経由へ移すのは別タスク(段階導入)。
//  - RLS が実際に効くのはアプリ接続が「テーブルの非オーナーロール」の場合のみ。
//    現状の接続ロール(通常 postgres=オーナー)では RLS はバイパスされ、本ラッパは
//    正しく GUC を設定するが実効の絞り込みは発生しない。実効化は運用ステップ
//    (専用非オーナーロールへの切替、migration 末尾の RUNBOOK 参照)に委ねる。
//  - ポリシーは「GUC 未設定=全行許可」の後方互換設計。したがって withTenant() を
//    通さない既存経路は、非オーナー切替後も挙動が変わらない。

/**
 * withTenant() のオプション。
 * - `pool`: 使用するプール(テスト/特殊経路用)。省略時は共有 getPool()。
 * - `superAdmin`: true のとき app.is_super_admin='on' を立て、全テナント横断を許可する。
 *   super_admin 経路では tenantId に null を渡しつつ superAdmin:true を指定する。
 */
export interface WithTenantOptions {
  pool?: InstanceType<typeof Pool>;
  superAdmin?: boolean;
}

/**
 * テナントコンテキストを設定した単一トランザクション内でコールバックを実行する。
 *
 * - BEGIN → `SET LOCAL` 相当(set_config(..., is_local=true))で GUC を設定 →
 *   fn(client) → 成功で COMMIT / 例外で ROLLBACK → クライアント返却。
 * - GUC はトランザクションローカルなので、COMMIT/ROLLBACK 後・クライアントが
 *   プールへ返却された後には残らない(接続の使い回しで別テナントへ漏れない)。
 * - tenantId が null かつ superAdmin=false の場合は GUC を一切設定しない
 *   (＝ポリシーの後方互換分岐で全行アクセス。移行期の既存挙動と同じ)。
 *
 * set_config() を使い tenantId をパラメータバインドする(SET LOCAL の直接補間だと
 * SQL インジェクション面が生じるため)。
 *
 * @throws DATABASE_URL 未設定時(getPool() 経由)。
 */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const activePool = options.pool ?? getPool();
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    if (options.superAdmin) {
      // 全テナント横断。tenant 固有 GUC は立てない(is_super_admin だけで足りる)。
      await client.query("SELECT set_config('app.is_super_admin', 'on', true)");
    } else if (tenantId !== null && tenantId !== "") {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }
    // tenantId=null かつ superAdmin=false: GUC 未設定のまま(後方互換=全行)。
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK 自体の失敗は握り潰し、元の例外を優先して投げる。
    }
    throw err;
  } finally {
    client.release();
  }
}
