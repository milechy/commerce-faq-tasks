// tests/phase35/globalRag.test.ts
// Phase35: グローバルナレッジ (tenant_id = "global") の動作検証
import fs from "fs";
import path from "path";

// ──────────────────────────────────────────────
// SQL ソースコード検証（静的解析）
// ──────────────────────────────────────────────
describe("pgvector global search — SQL source", () => {
  it("pgvector.ts の SQL に OR fe.tenant_id = 'global' が含まれる", () => {
    const filePath = path.resolve(__dirname, "../../src/search/pgvector.ts");
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("OR fe.tenant_id = 'global'");
  });

  it("pgvectorSearch.ts の SQL に OR tenant_id = 'global' が含まれる", () => {
    const filePath = path.resolve(__dirname, "../../src/search/pgvectorSearch.ts");
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("OR tenant_id = 'global'");
  });
});

// ──────────────────────────────────────────────
// ES hybrid.ts: should条件 global 検証（静的解析）
// ──────────────────────────────────────────────
describe("hybrid ES global search — source", () => {
  it("hybrid.ts の ES クエリに global の should 条件が含まれる", () => {
    const filePath = path.resolve(__dirname, "../../src/search/hybrid.ts");
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain('"global"');
    expect(source).toContain("minimum_should_match");
  });

  it("hybrid.ts のprobeクエリにも global の should 条件が含まれる", () => {
    const filePath = path.resolve(__dirname, "../../src/search/hybrid.ts");
    const source = fs.readFileSync(filePath, "utf8");
    // 2箇所のminimum_should_matchが存在する（メインクエリ＋probe）
    const matches = source.match(/minimum_should_match/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────
// グローバルガード — knowledge/routes.ts のソース確認
// ──────────────────────────────────────────────
describe("global guard — knowledge routes source", () => {
  const filePath = path.resolve(
    __dirname,
    "../../src/api/admin/knowledge/routes.ts"
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(filePath, "utf8");
  });

  it("text/commit に target フィールドの定義がある", () => {
    expect(source).toContain("target: z.string().optional()");
  });

  it("scrape/commit に target フィールドの定義がある", () => {
    // 2箇所含まれることを確認
    const matches = source.match(/target: z\.string\(\)\.optional\(\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("global ガードのエラーメッセージが含まれる", () => {
    const globalGuardCount = (source.match(/グローバルナレッジはSuper Adminのみ/g) || []).length;
    // PDF route + text/commit + scrape/commit = 少なくとも3箇所
    expect(globalGuardCount).toBeGreaterThanOrEqual(3);
  });

  it("DELETE guard で global の super_admin チェックがある", () => {
    expect(source).toContain("グローバルナレッジはSuper Adminのみ削除可能です");
  });

  it("DELETE で recordTenantId を使って削除する", () => {
    expect(source).toContain("recordTenantId");
  });
});

// ──────────────────────────────────────────────
// src/index.ts — PDF route の target 対応
// ──────────────────────────────────────────────
describe("PDF route target support — index.ts source", () => {
  it("target 変数が定義されている", () => {
    const filePath = path.resolve(__dirname, "../../src/index.ts");
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("const target");
    expect(source).toContain('req.body?.target');
  });

  it("runOcrPipeline に target が渡されている", () => {
    const filePath = path.resolve(__dirname, "../../src/index.ts");
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("runOcrPipeline(pdfBuffer, target)");
  });
});
