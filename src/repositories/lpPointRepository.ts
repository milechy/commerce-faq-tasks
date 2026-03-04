// src/repositories/lpPointRepository.ts
import type { NotionLpPoint } from "../integrations/notion/notionSchemas";

export class LpPointRepository {
  // TODO: Inject actual DB client when ready
  async bulkUpsert(points: NotionLpPoint[]): Promise<void> {
    // MVP: log count only, to be replaced with real persistence
    // eslint-disable-next-line no-console
    console.log("[LpPointRepository] bulkUpsert", points.length);
  }
}
