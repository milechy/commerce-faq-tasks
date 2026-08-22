// tests/syncEsIdFormat.test.ts
//
// SCRIPTS/sync-es.ts はスクリプト（モジュール読込時に main() が実行され、
// process.exit / 実DB接続まで行う）のため require/import してのユニットテストは
// 安全に行えない（jest.config.cjs が SCRIPTS/ 配下・script-style ファイルを
// testMatch対象外にしている方針と同じ理由）。
//
// このテストはソースを静的に検査し、ESドキュメントIDが
// faqCrudRoutes.ts/faqAdminRoutes.ts 系の書き込みと同じ `${faqId}_${tenantId}`
// 規約（faqEsDocId）で組み立てられていることを保証する回帰ガードである。
// 旧実装 `_id: String(row.id)`（tenant_idを含まない）への先祖返りを検知する。

import { readFileSync } from "fs";
import { join } from "path";
import { faqEsDocId } from "../src/lib/knowledge/faqIndexSync";

const SOURCE_PATH = join(__dirname, "..", "SCRIPTS", "sync-es.ts");

describe("SCRIPTS/sync-es.ts の _id 規約", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("faqIndexSync の faqEsDocId を import している", () => {
    expect(source).toMatch(
      /import\s*\{\s*faqEsDocId\s*\}\s*from\s*["']\.\.\/src\/lib\/knowledge\/faqIndexSync["']/
    );
  });

  it("bulk _id は faqEsDocId(row.tenant_id, row.id) で組み立てる", () => {
    expect(source).toMatch(/_id:\s*faqEsDocId\(row\.tenant_id,\s*row\.id\)/);
  });

  it("旧実装（tenant_idを含まない _id: String(row.id)）が復活していない", () => {
    expect(source).not.toMatch(/_id:\s*String\(row\.id\)/);
  });

  it("faqEsDocId自体は既存の書き込みパス（faqCrudRoutes等）と同一規約", () => {
    // sync-es.ts は countTenantDocs/bulkIndex 内で row.tenant_id, row.id を渡す前提。
    // ここでは規約そのもの（`${faqId}_${tenantId}`）を直接固定する。
    expect(faqEsDocId("acme", 42)).toBe("42_acme");
  });
});
