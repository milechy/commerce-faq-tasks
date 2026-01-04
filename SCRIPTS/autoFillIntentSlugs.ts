// SCRIPTS/autoFillIntentSlugs.ts
// TuningTemplates (Notion) の Name / Phase から Intent スラッグを自動生成して
// Notion の Intent(select) プロパティに書き込むユーティリティ。
//
// 使い方:
//  Dry-run (生成結果だけ確認):
//    npx ts-node SCRIPTS/autoFillIntentSlugs.ts
//
//  実際に Notion を更新:
//    npx ts-node SCRIPTS/autoFillIntentSlugs.ts --apply
//
// 前提:
//  - .env に NOTION_API_KEY, NOTION_DB_TUNING_TEMPLATES_ID が設定されていること。

import { Client } from "@notionhq/client";
import "dotenv/config";
import type { NotionTuningTemplate } from "../src/integrations/notion/notionSchemas";
import { NotionSyncService } from "../src/integrations/notion/notionSyncService";

type Candidate = {
  pageId: string;
  name: string;
  phase?: string | null;
  currentIntent?: string | null;
  newIntent: string;
};

/**
 * 日本語混じりの Name から Intent 用の英語スラッグを雑に生成する。
 * ルール:
 * - "（" or "(" 以降は削る (日本語の補足を除外)
 * - 英数字とスペース, アンダースコアだけ残す
 * - スペース/ハイフンはアンダースコアに
 * - 連続アンダースコアはまとめる
 * - 前後のアンダースコアを削除
 * - すべて小文字
 * - 何も残らなければ 'template' を返す
 */
function makeBaseSlugFromName(name: string): string {
  const withoutParen = name.split("（")[0].split("(")[0].trim();
  const asciiOnly = withoutParen.replace(/[^a-zA-Z0-9 _-]+/g, "");
  const replaced = asciiOnly
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "template";
}

/**
 * Phase をプレフィックスにした Intent 名を作る。
 * 例: phase=Propose, name="trial_lesson_offer (体験レッスン提案)" ->
 *      "propose_trial_lesson_offer"
 */
function generateIntentSlug(
  phase: string | null | undefined,
  name: string
): string {
  const base = makeBaseSlugFromName(name);
  const phasePrefix = (phase ?? "").toLowerCase();

  if (!phasePrefix) return base;
  // Clarify -> clarify, Propose -> propose などを想定
  return `${phasePrefix}_${base}`;
}

/**
 * Notion から TuningTemplates を取得する。
 * ここでは NotionSyncService を再利用して、pageId や intent をまとめて取る。
 */
async function fetchTemplates(): Promise<NotionTuningTemplate[]> {
  const notionDbId = process.env.NOTION_DB_TUNING_TEMPLATES_ID;
  if (!notionDbId) {
    throw new Error("NOTION_DB_TUNING_TEMPLATES_ID is not set in environment");
  }

  const syncService = new NotionSyncService();
  // syncTuningTemplates は副作用として DB も更新するが、ここでは一覧取得用として再利用する。
  const templates = await syncService.syncTuningTemplates(notionDbId);
  return templates;
}

/**
 * Intent が空 or 未設定のテンプレに対して、新しい Intent 候補を作る。
 */
function buildCandidates(templates: NotionTuningTemplate[]): Candidate[] {
  const candidates: Candidate[] = [];

  for (const tpl of templates) {
    const pageId = tpl.notionPageId;
    const name = tpl.name ?? "";
    const phase = tpl.phase ?? null;
    const currentIntent = tpl.intent ?? null;

    // すでに Intent が入っているものはスキップ
    if (currentIntent && currentIntent.trim().length > 0) continue;
    if (!pageId || !name) continue;

    const newIntent = generateIntentSlug(phase, name);

    candidates.push({
      pageId,
      name,
      phase,
      currentIntent,
      newIntent,
    });
  }

  return candidates;
}

/**
 * Notion の Intent(select) プロパティを更新する。
 */
async function applyIntentToNotion(candidates: Candidate[]): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    throw new Error("NOTION_API_KEY is not set in environment");
  }

  const notion = new Client({ auth: notionApiKey });

  for (const c of candidates) {
    // eslint-disable-next-line no-console
    console.log(
      `[update] pageId=${c.pageId} name="${c.name}" intent="${c.newIntent}"`
    );

    await notion.pages.update({
      page_id: c.pageId,
      properties: {
        // Notion 上の列名が "Intent" の select プロパティであることを前提とする。
        Intent: {
          select: {
            name: c.newIntent,
          },
        },
      },
    });
  }
}

async function main() {
  try {
    const [, , ...args] = process.argv;
    const apply = args.includes("--apply");

    const templates = await fetchTemplates();
    const candidates = buildCandidates(templates);

    if (candidates.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        "[autoFillIntentSlugs] no empty intents found. nothing to do."
      );
      return;
    }

    // Dry run: 一覧表示
    // eslint-disable-next-line no-console
    console.log(
      `[autoFillIntentSlugs] found ${candidates.length} templates without intent.`
    );
    for (const c of candidates) {
      // eslint-disable-next-line no-console
      console.log(
        `- pageId=${c.pageId}, phase=${c.phase ?? "-"}, name="${
          c.name
        }" -> intent="${c.newIntent}"`
      );
    }

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log(
        '\n[autoFillIntentSlugs] dry-run only. To actually update Notion, run with "--apply".'
      );
      return;
    }

    // 実際に Notion を更新
    await applyIntentToNotion(candidates);

    // eslint-disable-next-line no-console
    console.log(
      `[autoFillIntentSlugs] applied ${candidates.length} intent updates to Notion.`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[autoFillIntentSlugs] failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
