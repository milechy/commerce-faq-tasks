// src/repositories/tuningTemplateRepository.ts
// Phase13 MVP: In-memory repository for TuningTemplates
// ------------------------------------------------------

import type { NotionTuningTemplate } from "../integrations/notion/notionSchemas";

/**
 * Phase13 では DB 永続化は行わず、メモリ上に保持する。
 * - sync:notion 実行時に bulkUpsert() でメモリを更新
 * - Planner / Provider 側は findAll() で参照する
 */
export class TuningTemplateRepository {
  /** メモリ上に保持するテンプレ一覧 */
  private templates: NotionTuningTemplate[] = [];

  /**
   * Notion Sync 時にテンプレ一覧を上書き保存する
   */
  async bulkUpsert(rows: NotionTuningTemplate[]): Promise<void> {
    this.templates = rows;
    // eslint-disable-next-line no-console
    console.log("[TuningTemplateRepository] bulkUpsert", rows.length);
  }

  /**
   * 現在メモリに保持しているテンプレ一覧を返す
   */
  async findAll(): Promise<NotionTuningTemplate[]> {
    return this.templates;
  }
}
