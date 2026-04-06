// src/repositories/faqRepository.ts
import type { NotionFaq } from "../integrations/notion/notionSchemas";
import { logger } from '../lib/logger';


export class FaqRepository {
  // TODO: Inject actual DB client when ready
  async bulkUpsert(faqs: NotionFaq[]): Promise<void> {
    // MVP: log count only, to be replaced with real persistence
    // eslint-disable-next-line no-console
    logger.info("[FaqRepository] bulkUpsert", faqs.length);
  }
}
