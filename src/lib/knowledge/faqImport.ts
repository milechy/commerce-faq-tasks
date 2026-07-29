// src/lib/knowledge/faqImport.ts
//
// FAQ一括インポート（テキスト入力／URLスクレイプ）の共有ロジック層。
// Express (Request/Response) に依存しない純粋な関数群として、
//   - src/api/admin/knowledge/routes.ts の POST /v1/admin/knowledge/text(/commit)
//     と POST /v1/admin/knowledge/scrape(/commit)（旧UI・GUI経由）
//   - src/api/admin/agent/actionExecutor.ts のチャットツール
//     suggest_faq_import_from_text / suggest_faq_import_from_urls / commit_faq_import
//     （新UI・チャット経由）
// の両方から呼び出される。
//
// 注意: textToFaqs はこのファイルへ実装ごと移動し、
// src/api/admin/knowledge/routes.ts 側は `export { textToFaqs } from '.../faqImport'`
// で再エクスポートするだけにしている（routes.ts ⇄ faqImport.ts の循環import を避けるため。
// routes.ts がこのファイルを import する一方でこのファイルが routes.ts を import すると、
// モジュール初期化順序によっては textToFaqs が未定義のまま参照される可能性がある）。
// src/api/admin/agent/agentRoutes.test.ts は `jest.mock('../knowledge/routes', ...)` で
// textToFaqs を差し替えるが、これは routes.ts からの再エクスポート経由で
// actionExecutor.ts 側の呼び出しに対して従来どおり機能する
// （actionExecutor.ts は今後もこのファイルではなく routes.ts から textToFaqs を import する）。

import type { Pool } from 'pg';
import { GROQ_VERSATILE_70B } from '../../config/groqModels';
import { groqClient } from '../../agent/llm/groqClient';
import { embedText } from '../../agent/llm/openaiEmbeddingClient';
import { encryptText } from '../crypto/textEncrypt';
import { logger } from '../logger';

export interface FaqEntry {
  question: string;
  answer: string;
  category?: string;
}

/**
 * テキスト→FAQ変換。
 * categoryOverride が指定された場合は全FAQのカテゴリをその値で上書き。
 * 未指定（null/undefined）の場合はAIがカテゴリを自動判定する。
 * existingQuestions が指定された場合はプロンプトに組み込み重複生成を防止する。
 */
export async function textToFaqs(
  text: string,
  categoryOverride?: string | null,
  existingQuestions?: string[]
): Promise<FaqEntry[]> {
  const model = process.env.GROQ_FAQ_GEN_MODEL ?? GROQ_VERSATILE_70B;

  const existingSection =
    existingQuestions && existingQuestions.length > 0
      ? `\n既にこのテナントに登録されているFAQの質問（重複禁止 — 以下と同じ内容は生成しないこと）:\n${existingQuestions
          .slice(0, 40)
          .map((q) => `- ${q}`)
          .join("\n")}\n`
      : "";

  const prompt = `あなたはセールス支援FAQの専門家です。
以下のテキストから、お客様がこの商品・サービスについて質問しそうなFAQを網羅的に生成してください。

重要な原則:
* テキストに含まれる全ての事実情報をFAQとしてカバーすること
* お客様の購入・利用判断に影響する情報は必ずFAQ化すること
* 1つのFAQには1つのトピックのみ（複数の情報を1つにまとめない）
* テキストに書かれていない情報は推測しないこと
* 各FAQに最も適切なカテゴリを自動で判定して付与すること

具体的にFAQ化すべき情報の例:
* 商品のスペック・仕様（各項目を個別のFAQに）
* 価格・料金
* 状態・品質に関する情報
* 付属品・オプション
* 保証・アフターサービス
* 予約・購入方法
* 店舗情報・営業時間
* キャンペーン・割引
${existingSection}
カテゴリの判定基準:
* 商品・サービスの詳細情報 → "product_info"
* 料金・価格・支払い方法 → "pricing"
* 店舗・アクセス・営業時間 → "store_info"
* キャンペーン・セール・割引 → "campaign"
* 在庫・車両情報 → "inventory"
* クーポン・割引コード → "coupon"
* 予約・申し込み方法 → "booking"
* 保証・アフターサービス → "warranty"
* よくある質問・一般 → "general"
* 上記に当てはまらない場合 → 適切なカテゴリ名を英語スネークケースで生成

テキスト:
${text.slice(0, 4000)}

出力形式: JSON配列のみ（他のテキストは含めない）
[{"question": "...", "answer": "...", "category": "..."}]`;

  const raw = await groqClient.call({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 3000,
    tag: "knowledge-text-to-faq",
  });

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("LLMがJSON形式で回答しませんでした");

  const parsed = JSON.parse(jsonMatch[0]) as unknown[];
  if (!Array.isArray(parsed)) throw new Error("JSON形式が不正です");

  const faqs = parsed.filter(
    (f): f is FaqEntry => {
      const r = f as Record<string, unknown>;
      return typeof r.question === "string" && typeof r.answer === "string";
    }
  );

  // カテゴリ強制上書き（手動指定の場合）
  if (categoryOverride) {
    return faqs.map((f) => ({ ...f, category: categoryOverride }));
  }
  return faqs;
}

export interface FaqEntryWithDuplicate extends FaqEntry {
  duplicate: {
    existingQuestion: string;
    existingAnswer: string;
  } | null;
}

/** スクレイプで抽出した商品メタ（OG/JSON-LD） */
export interface ProductMeta {
  product_image_url: string | null;
  product_price: string | null;
  product_cta_url: string | null;
}

/**
 * http(s) スキームのみを許可するガード。javascript:/data:/相対パス等は null に落とす。
 * system boundary (外部 HTML からの抽出値) にのみ適用。
 */
const safeHttpUrl = (u: unknown): string | null =>
  typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;

/** JSON-LD Product オブジェクトから offers.price を文字列として取得 */
function extractJsonLdPrice(product: Record<string, unknown>): string | null {
  const offers = product['offers'];
  if (!offers || typeof offers !== 'object') return null;
  const o = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown>;
  if (!o) return null;
  const price = o['price'];
  if (price === undefined || price === null) return null;
  return String(price);
}

/**
 * HTML から OG/JSON-LD を regex で抽出して商品メタを返す。
 * 依存追加禁止 — cheerio/jsdom 不使用、regex のみ。
 * JSON-LD parse 失敗は non-fatal（握りつぶし）。
 */
export function extractProductMeta(html: string, pageUrl: string): ProductMeta {
  // og:image
  const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const ogImage = ogImageMatch?.[1] ?? null;

  // 価格: og:price:amount → product:price:amount → JSON-LD
  const ogPriceMatch = html.match(/<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:price:amount["']/i)
    ?? html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']product:price:amount["']/i);
  let ogPrice = ogPriceMatch?.[1] ?? null;

  // cta_url: og:url → fallback to pageUrl
  const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  let ctaUrl = ogUrlMatch?.[1] ?? pageUrl;

  // JSON-LD 優先採用（@type=Product の場合）
  const ldJsonMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (ldJsonMatch) {
    for (const block of ldJsonMatch) {
      const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      try {
        const data = JSON.parse(inner) as Record<string, unknown>;
        const objs = Array.isArray(data) ? data : [data];
        for (const obj of objs) {
          if (typeof obj !== 'object' || obj === null) continue;
          const typed = obj as Record<string, unknown>;
          if (typed['@type'] !== 'Product') continue;
          // image 優先採用
          let resolvedImage: string | null = ogImage;
          if (typed['image']) {
            const img = typed['image'];
            if (typeof img === 'string') {
              resolvedImage = img;
            } else if (Array.isArray(img) && typeof img[0] === 'string') {
              resolvedImage = img[0];
            } else if (typeof img === 'object' && img !== null && typeof (img as Record<string, unknown>)['url'] === 'string') {
              resolvedImage = (img as Record<string, unknown>)['url'] as string;
            }
          }
          return {
            product_image_url: safeHttpUrl(resolvedImage),
            product_price: extractJsonLdPrice(typed) ?? ogPrice,
            product_cta_url: safeHttpUrl(typeof typed['url'] === 'string' ? typed['url'] : ctaUrl),
          };
        }
      } catch {
        // non-fatal: JSON.parse 失敗は握りつぶす
      }
    }
  }

  return {
    product_image_url: safeHttpUrl(ogImage),
    product_price: ogPrice,
    product_cta_url: safeHttpUrl(ctaUrl),
  };
}

/** 重複チェック用の質問正規化（句読点・空白・大文字小文字・助詞末尾を無視） */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[？?。、！!　\s]+/g, "").trim();
}

/** 文字バイグラムセットを生成 */
function bigrams(s: string): Set<string> {
  const r = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
  return r;
}

/**
 * バイグラム包含度による類似度（0-1）
 * 短い方の文字列のバイグラムが長い方に何割含まれるかを返す。
 * 例: "営業時間は" vs "営業時間を教えてください" → 0.75
 */
export function bigramSimilarity(a: string, b: string): number {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  if (na === nb) return 1.0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  const [shorter, longer] = ba.size <= bb.size ? [ba, bb] : [bb, ba];
  let inter = 0;
  for (const g of shorter) if (longer.has(g)) inter++;
  // containment: shorter の bigram が longer に何割含まれるか
  return inter / shorter.size;
}

export const DUPLICATE_THRESHOLD = 0.6;

/** embedding を非同期で挿入（fire-and-forget） */
export function insertEmbeddingAsync(
  db: Pool,
  tenantId: string,
  text: string,
  faqId: number,
  meta: Record<string, unknown>
): void {
  embedText(text)
    .then((vec) =>
      db.query(
        "INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata) VALUES ($1, $2, $3::vector, $4::jsonb)",
        [tenantId, encryptText(text), `[${vec.join(",")}]`, JSON.stringify(meta)]
      )
    )
    .catch((e) => logger.warn("[knowledge] embedding insert failed", e));
}

// ---------------------------------------------------------------------------
// プレビュー生成（重複判定込み・DB書き込みなし）
// ---------------------------------------------------------------------------

/** 既存FAQ(質問+回答、直近50件)を取得。取得失敗はnon-fatalで空配列にフォールバック */
export async function fetchExistingFaqRows(
  db: Pool,
  tenantId: string,
): Promise<{ question: string; answer: string }[]> {
  try {
    const r = await db.query(
      "SELECT question, answer FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
      [tenantId]
    );
    return r.rows as { question: string; answer: string }[];
  } catch {
    return [];
  }
}

/** 生成されたFAQ配列に、既存FAQとのバイグラム類似度に基づく重複情報を付与する */
export function attachDuplicateInfo(
  faqs: FaqEntry[],
  existingRows: { question: string; answer: string }[],
): FaqEntryWithDuplicate[] {
  return faqs.map((faq) => {
    let bestMatch: { question: string; answer: string } | null = null;
    let bestScore = 0;
    for (const row of existingRows) {
      const score = bigramSimilarity(faq.question, row.question);
      if (score > bestScore) { bestScore = score; bestMatch = row; }
    }
    return {
      ...faq,
      duplicate:
        bestMatch && bestScore >= DUPLICATE_THRESHOLD
          ? { existingQuestion: bestMatch.question, existingAnswer: bestMatch.answer }
          : null,
    };
  });
}

/** テキストからのFAQプレビュー生成（重複判定込み）。DBへの書き込みは行わない。 */
export async function generateTextFaqPreview(
  db: Pool,
  tenantId: string,
  text: string,
  categoryOverride?: string | null,
): Promise<FaqEntryWithDuplicate[]> {
  const existingRows = await fetchExistingFaqRows(db, tenantId);
  const existingQuestions = existingRows.map((r) => r.question);
  const faqs = await textToFaqs(text, categoryOverride, existingQuestions);
  return attachDuplicateInfo(faqs, existingRows);
}

export interface ScrapeUrlResult {
  url: string;
  faqs: FaqEntryWithDuplicate[];
  productMeta?: ProductMeta;
  error?: string;
}

/** 1件のURLをスクレイプしFAQプレビューを生成する（失敗時はerrorフィールドに格納。例外は投げない） */
export async function scrapeUrlToFaqs(
  url: string,
  categoryOverride: string | null | undefined,
  existingRows: { question: string; answer: string }[],
  existingQuestions: string[],
): Promise<ScrapeUrlResult> {
  try {
    const html = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; R2C/1.0)" },
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.text());

    // OG/JSON-LD から商品メタを抽出（script/style 除去前の生 HTML を使う）
    const productMeta = extractProductMeta(html, url);

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);

    if (text.length < 50) {
      return { url, faqs: [], error: "ページからテキストを取得できませんでした" };
    }

    const faqs = await textToFaqs(text, categoryOverride, existingQuestions);
    const faqsWithDuplicate = attachDuplicateInfo(faqs, existingRows);
    return { url, faqs: faqsWithDuplicate, productMeta };
  } catch (err) {
    return { url, faqs: [], error: String(err).slice(0, 200) };
  }
}

/** URL群(1〜5件)からのFAQプレビュー生成。DBへの書き込みは行わない。 */
export async function generateScrapeFaqPreview(
  db: Pool,
  tenantId: string,
  urls: string[],
  categoryOverride?: string | null,
): Promise<ScrapeUrlResult[]> {
  const existingRows = await fetchExistingFaqRows(db, tenantId);
  const existingQuestions = existingRows.map((r) => r.question);
  const results: ScrapeUrlResult[] = [];
  for (const url of urls) {
    results.push(await scrapeUrlToFaqs(url, categoryOverride, existingRows, existingQuestions));
  }
  return results;
}

// ---------------------------------------------------------------------------
// コミット（DB書き込み）
// ---------------------------------------------------------------------------

/** コミット時点の既存FAQ質問一覧（重複スキップ判定用） */
export async function fetchExistingQuestions(db: Pool, target: string): Promise<string[]> {
  try {
    const r = await db.query("SELECT question FROM faq_docs WHERE tenant_id = $1", [target]);
    return (r.rows as { question: string }[]).map((row) => row.question);
  } catch {
    return [];
  }
}

export interface CommitFaqsResult {
  inserted: number;
  skipped: number;
  insertedIds: number[];
}

/**
 * テキスト由来のFAQをDBへ登録する。
 * POST /v1/admin/knowledge/text/commit（旧UI）と
 * チャットの commit_faq_import（テキスト由来のステージング）の両方から使う。
 * tags・商品メタ列は持たない（元のtext/commitエンドポイントと同一のINSERT列構成）。
 */
export async function commitTextFaqs(
  db: Pool,
  target: string,
  faqs: FaqEntry[],
  categoryOverride: string | undefined,
  source: string,
): Promise<CommitFaqsResult> {
  const existingQuestionsAtCommit = await fetchExistingQuestions(db, target);

  const inserted: number[] = [];
  let skipped = 0;

  for (const faq of faqs) {
    const isDuplicate = existingQuestionsAtCommit.some(
      (q) => bigramSimilarity(faq.question, q) >= DUPLICATE_THRESHOLD
    );
    if (isDuplicate) {
      skipped++;
      continue;
    }
    const faqCategory = categoryOverride || faq.category || "general";
    try {
      const r = await db.query(
        `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [target, faq.question.slice(0, 500), faq.answer.slice(0, 2000), faqCategory]
      );
      const faqId = r.rows[0].id as number;
      inserted.push(faqId);

      const embText = `${faq.question}\n${faq.answer}`;
      insertEmbeddingAsync(db, target, embText, faqId, {
        source,
        faq_id: faqId,
      });
    } catch (err) {
      logger.error("[commit] insert failed for faq:", faq.question, err);
    }
  }

  return { inserted: inserted.length, skipped, insertedIds: inserted };
}

export interface ScrapeCommitItem {
  url: string;
  faqs: FaqEntry[];
  productMeta?: {
    product_image_url?: string | null;
    product_price?: string | null;
    product_cta_url?: string | null;
  };
}

/**
 * スクレイプ由来のFAQをDBへ登録する。
 * POST /v1/admin/knowledge/scrape/commit（旧UI）と
 * チャットの commit_faq_import（URL由来のステージング）の両方から使う。
 */
export async function commitScrapeFaqs(
  db: Pool,
  target: string,
  items: ScrapeCommitItem[],
  categoryOverride: string | undefined,
  source: string,
): Promise<CommitFaqsResult> {
  const existingQuestionsAtScrapeCommit = await fetchExistingQuestions(db, target);

  const inserted: number[] = [];
  let totalSkipped = 0;

  for (const item of items) {
    for (const faq of item.faqs) {
      const isDuplicate = existingQuestionsAtScrapeCommit.some(
        (q) => bigramSimilarity(faq.question, q) >= DUPLICATE_THRESHOLD
      );
      if (isDuplicate) {
        totalSkipped++;
        continue;
      }
      const faqCategory = categoryOverride || faq.category || "general";
      const pm = item.productMeta;
      try {
        const r = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, tags, is_published, product_image_url, product_price, product_cta_url)
           VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
           RETURNING id`,
          [
            target,
            faq.question.slice(0, 500),
            faq.answer.slice(0, 2000),
            faqCategory,
            [item.url],
            pm?.product_image_url ?? null,
            pm?.product_price ?? null,
            pm?.product_cta_url ?? null,
          ]
        );
        const faqId = r.rows[0].id as number;
        inserted.push(faqId);

        const embText = `${faq.question}\n${faq.answer}`;
        insertEmbeddingAsync(db, target, embText, faqId, {
          source,
          faq_id: faqId,
          url: item.url,
        });
      } catch (err) {
        logger.error("[scrape/commit] insert failed", err);
      }
    }
  }

  return { inserted: inserted.length, skipped: totalSkipped, insertedIds: inserted };
}
