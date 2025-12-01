// src/repositories/productRepository.ts
import type { NotionProduct } from "../integrations/notion/notionSchemas";

export class ProductRepository {
  // TODO: Inject actual DB client when ready
  async bulkUpsert(products: NotionProduct[]): Promise<void> {
    // MVP: log count only, to be replaced with real persistence
    // eslint-disable-next-line no-console
    console.log("[ProductRepository] bulkUpsert", products.length);
  }
}
