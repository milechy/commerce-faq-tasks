// SCRIPTS/seedFaqEmbeddings.ts
//
// Phase7: Groq Compound-mini の埋め込みを使って
// Hetzner Postgres の faq_embeddings にデータを投入するスクリプト。

import { embedTextOpenAI } from "../src/agent/llm/openaiEmbeddingClient";

// @ts-ignore - pg types なしで require する
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const pgUrl = process.env.DATABASE_URL;

if (!pgUrl) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: pgUrl });

// 今はテスト用に 送料系だけ。後で Notion / CSV から増やしてOK。
const FAQS: { tenantId: string; text: string }[] = [
  {
    tenantId: "demo",
    text: "当店の送料は全国一律500円です。沖縄・離島は別料金となります。",
  },
  {
    tenantId: "demo",
    text: "送料は購入金額が5,000円以上の場合は無料になります。",
  },
  {
    tenantId: "demo",
    text: "返品・交換時の送料はお客様負担となります。初期不良の場合は当店負担です。",
  },
];

async function main() {
  console.log("Seeding faq_embeddings with Groq embeddings...");
  console.log(`DATABASE_URL=${pgUrl}`);

  for (const faq of FAQS) {
    console.log(`→ embedding: "${faq.text.slice(0, 20)}..."`);

    // Groq Compound-mini で埋め込み生成（fast=true）
    const embedding = await embedTextOpenAI(faq.text);

    // pgvector は '[0.1,0.2,...]' 形式のリテラルに変換
    const embedLiteral = `[${embedding.join(",")}]`;

    await pool.query(
      `
      INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
      VALUES ($1, $2, $3::vector, $4)
      `,
      [
        faq.tenantId,
        faq.text,
        embedLiteral,
        { source: "groq/compound-mini", seededAt: new Date().toISOString() },
      ]
    );
  }

  console.log("Done.");
  await pool.end();
}

main().catch((err: any) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
