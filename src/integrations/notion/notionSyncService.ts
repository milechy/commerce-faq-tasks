// src/integrations/notion/notionSyncService.ts
import { FaqRepository } from "../../repositories/faqRepository";
import { LpPointRepository } from "../../repositories/lpPointRepository";
import { ProductRepository } from "../../repositories/productRepository";
import { TuningTemplateRepository } from "../../repositories/tuningTemplateRepository";
import { INotionClient, NotionClient } from "./notionClient";
import type { NotionTuningTemplate } from "./notionSchemas";
import {
  mapFaqRow,
  mapLpPointRow,
  mapProductRow,
  mapTuningTemplateRow,
} from "./notionSchemas";

const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? "english-demo";

export class NotionSyncService {
  constructor(
    private readonly notion: INotionClient = new NotionClient(),
    private readonly faqRepo = new FaqRepository(),
    private readonly productRepo = new ProductRepository(),
    private readonly lpPointRepo = new LpPointRepository(),
    private readonly tuningTemplateRepo = new TuningTemplateRepository()
  ) {}

  async syncFaq(databaseId = process.env.NOTION_DB_FAQ_ID!) {
    const notionRows = await this.notion.queryDatabaseAll({
      databaseId,
    });

    const faqEntities = notionRows.map((row) =>
      mapFaqRow(row as any, DEFAULT_TENANT_ID)
    );
    await this.faqRepo.bulkUpsert(faqEntities);
  }

  async syncProducts(databaseId = process.env.NOTION_DB_PRODUCTS_ID!) {
    const notionRows = await this.notion.queryDatabaseAll({
      databaseId,
    });

    const productEntities = notionRows.map((row) =>
      mapProductRow(row as any, DEFAULT_TENANT_ID)
    );

    await this.productRepo.bulkUpsert(productEntities);
  }

  async syncLpPoints(databaseId = process.env.NOTION_DB_LP_POINTS_ID!) {
    const notionRows = await this.notion.queryDatabaseAll({
      databaseId,
    });

    const lpPointEntities = notionRows.map((row) =>
      mapLpPointRow(row as any, DEFAULT_TENANT_ID)
    );

    await this.lpPointRepo.bulkUpsert(lpPointEntities);
  }

  async syncTuningTemplates(
    databaseId = process.env.NOTION_DB_TUNING_TEMPLATES_ID!
  ): Promise<NotionTuningTemplate[]> {
    const notionRows = await this.notion.queryDatabaseAll({
      databaseId,
    });

    const tuningTemplateEntities = notionRows.map((row) =>
      mapTuningTemplateRow(row as any, DEFAULT_TENANT_ID)
    );

    await this.tuningTemplateRepo.bulkUpsert(tuningTemplateEntities);

    return tuningTemplateEntities;
  }

  async syncAll() {
    await this.syncFaq();
    await this.syncProducts();
    await this.syncLpPoints();
    await this.syncTuningTemplates();
  }
}
