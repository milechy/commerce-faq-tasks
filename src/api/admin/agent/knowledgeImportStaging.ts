// src/api/admin/agent/knowledgeImportStaging.ts
//
// チャット経由のFAQ一括インポート（テキスト／URLスクレイプ）は
// 「プレビュー生成 → ユーザー承認 → コミット」の2ターン構成になる。
// LLMに生成済みFAQ配列をそのまま持ち回らせることはできない
// （executeToolCall の戻り値は actionExecutor.ts の truncate = (s) => s.slice(0, 500)
// で500字に切られるため。3件程度の短い候補なら文字列化して持ち回れる
// approve_tuning_rule_response のような方式が既存にあるが、FAQは最大20件と
// 長くなるため同じ方式は成立しない）。
//
// そのため、プレビュー結果は（tenantId, sessionId）をキーにこのプロセス内
// Map へ一時保存し、コミットツールがそれを読んで登録する。
//
// 【重要な前提条件】
// このプロセス内Mapがそのまま「唯一の真実の情報源」として機能するのは、
// ecosystem.config.cjs で API プロセスが instances: 1, exec_mode: "fork"
// （単一プロセス）で運用されているため。将来 cluster 化・マルチプロセス化する
// 場合は、このMapを共有ストア（DB／Redis等）へ移行する必要がある。
//
// TTLとエントリ数上限: プレビューは30分で失効させる（ユーザーが放置したまま
// 別の作業に移った古いステージングがいつまでも残らないように）。また、
// 上限なしのMapはメモリリークになるため、全テナント・全セッション合算で
// 最大200件までとし、超過時は最も古いエントリから追い出す。

import type { FaqEntryWithDuplicate, ScrapeUrlResult } from '../../../lib/knowledge/faqImport';

export type StagedFaqImport =
  | {
      kind: 'text';
      tenantId: string;
      faqs: FaqEntryWithDuplicate[];
      categoryOverride: string | null;
      truncated: boolean;
      createdAt: number;
    }
  | {
      kind: 'scrape';
      tenantId: string;
      items: ScrapeUrlResult[];
      categoryOverride: string | null;
      truncated: boolean;
      createdAt: number;
    };

const TTL_MS = 30 * 60 * 1000; // 30分
const MAX_ENTRIES = 200; // 全テナント・全セッション合計の上限（メモリリーク防止）

const staging = new Map<string, StagedFaqImport>();

function stagingKey(tenantId: string, sessionId: string): string {
  return `${tenantId}::${sessionId}`;
}

function isExpired(entry: StagedFaqImport): boolean {
  return Date.now() - entry.createdAt > TTL_MS;
}

/** 期限切れエントリを一掃する（呼び出しのたびに軽く掃除する程度の簡易実装） */
function sweepExpired(): void {
  for (const [key, entry] of staging) {
    if (isExpired(entry)) staging.delete(key);
  }
}

/**
 * プレビュー結果をステージングに保存する（同一キーへの再保存は上書き）。
 * tenantId + sessionId をキーに含むため、テナント越境・セッション間の混在は起きない。
 */
export function setStagedFaqImport(tenantId: string, sessionId: string, entry: StagedFaqImport): void {
  sweepExpired();

  const key = stagingKey(tenantId, sessionId);
  if (staging.size >= MAX_ENTRIES && !staging.has(key)) {
    // 上限到達時は最古のエントリ（Mapは挿入順を保持）から追い出す
    const oldestKey = staging.keys().next().value;
    if (oldestKey !== undefined) staging.delete(oldestKey);
  }
  staging.set(key, entry);
}

/** ステージング済みプレビューを取得する。期限切れ・未存在の場合は null */
export function getStagedFaqImport(tenantId: string, sessionId: string): StagedFaqImport | null {
  const key = stagingKey(tenantId, sessionId);
  const entry = staging.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    staging.delete(key);
    return null;
  }
  return entry;
}

/** ステージング済みプレビューを破棄する（コミット成功後・明示的な破棄の両方から使う） */
export function clearStagedFaqImport(tenantId: string, sessionId: string): void {
  staging.delete(stagingKey(tenantId, sessionId));
}

/** テスト用: 内部Mapを空にする */
export function __resetKnowledgeImportStagingForTest(): void {
  staging.clear();
}
