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

// GID 1218166714484055: 件単位選択インポート。カード(FaqImportPreviewCardPayload.faqs)は
// text/urlsどちらの場合もフラットな配列として店主に見せているため、選択indexもそのフラット順
// (kind==='scrape'ならitems.flatMap(item => item.faqs)の順)で受け取る。ここでは「絞り込むだけ」
// で登録ロジックは持たない(commitTextFaqs/commitScrapeFaqsは呼び出し側で従来どおり呼ぶ)。
export type SelectedFaqImport =
  | { kind: 'text'; faqs: FaqEntryWithDuplicate[] }
  | { kind: 'scrape'; items: ScrapeUrlResult[] };

export function selectFromStagedFaqImport(staged: StagedFaqImport, selectedIndices: number[]): SelectedFaqImport {
  const indexSet = new Set(selectedIndices);

  if (staged.kind === 'text') {
    return { kind: 'text', faqs: staged.faqs.filter((_, i) => indexSet.has(i)) };
  }

  let flatIndex = 0;
  const items: ScrapeUrlResult[] = [];
  for (const item of staged.items) {
    const faqs = item.faqs.filter(() => indexSet.has(flatIndex++));
    if (faqs.length > 0) items.push({ ...item, faqs });
  }
  return { kind: 'scrape', items };
}

// ---------------------------------------------------------------------------
// プラン制限の案内済みフラグ
// ---------------------------------------------------------------------------
//
// プラン未満の機能を尋ねられるたびに同じ案内文を丸ごと返すと、1つの会話の中で
// 同じ売り込み文を何度も読ませることになる（ダッシュボードのグレーアウトした
// ボタンより体験が悪い）。初回だけ従来どおりの全文を返し、2回目以降は短い
// 確認だけに切り替えるため、「もう案内したか」をここで覚えておく。
//
// 保存の仕組み・前提条件（単一プロセス運用）・TTL・エントリ数上限は上の
// ステージングと同じ方針に揃えている。キーに feature を含めるのは、別の機能で
// 制限に当たったときは初回として全文を出すため（機能ごとに1回ずつ案内する）。

const planLimitNotices = new Map<string, number>();

function planLimitKey(tenantId: string, sessionId: string, feature: string): string {
  return `${tenantId}::${sessionId}::${feature}`;
}

/**
 * 当該セッション・当該機能のプラン制限を「案内済み」として記録し、
 * 2回目以降（＝すでに案内済み）なら true を返す。
 * 呼び出し側は false なら従来の全文、true なら短い文に切り替える。
 */
export function recordPlanLimitMention(tenantId: string, sessionId: string, feature: string): boolean {
  const now = Date.now();
  for (const [key, createdAt] of planLimitNotices) {
    if (now - createdAt > TTL_MS) planLimitNotices.delete(key);
  }

  const key = planLimitKey(tenantId, sessionId, feature);
  if (planLimitNotices.has(key)) return true;

  if (planLimitNotices.size >= MAX_ENTRIES) {
    const oldestKey = planLimitNotices.keys().next().value;
    if (oldestKey !== undefined) planLimitNotices.delete(oldestKey);
  }
  planLimitNotices.set(key, now);
  return false;
}

/** テスト用: 内部Mapを空にする */
export function __resetPlanLimitNoticesForTest(): void {
  planLimitNotices.clear();
}
