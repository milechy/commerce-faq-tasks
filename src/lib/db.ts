// src/lib/db.ts
// Single shared PostgreSQL connection pool for the application.
// Import `pool` for nullable access (null when DATABASE_URL is absent),
// or `getPool()` for guaranteed access (throws if DATABASE_URL is not set).

import { Pool } from "pg";
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
