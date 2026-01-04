// SCRIPTS/sync-notion.ts
/* eslint-disable no-console */
import "dotenv/config";
import { NotionSyncService } from "../src/integrations/notion/notionSyncService";

async function main() {
  console.log("[sync-notion] start");

  const service = new NotionSyncService();

  await service.syncAll();

  console.log("[sync-notion] done");
}

main().catch((err) => {
  console.error("[sync-notion] error", err);
  process.exit(1);
});
