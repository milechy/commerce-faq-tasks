// src/agent/psychology/principleSchemaMap.ts
// 書籍の動的スキーマ → PrincipleChunk のフィールド対応表。
//
// なぜ必要か(2026-08-29 調査):
// 書籍の構造化フィールドは contentAnalyzer.ts の KNOWN_SCHEMAS から
// 書籍ごとに Gemini が選ぶ(psychology_book / sales_manual / ...)。
// にもかかわらず principleSearch.ts は psychology_book のキー名
// (principle/situation/example/contraindication)を直接 SQL に埋めており、
// 別スキーマで取り込まれた書籍は原則注入から永久に外れていた。
//
// 実害: 本番の赤嶺哲也氏の書籍2冊のうち
//   book_id=7「世界一やさしいテレアポ＆電話営業の本」→ psychology_book と判定 → 91件が原則注入に乗る
//   book_id=6「最強のセールストーク」→ sales_manual と判定 → 81件全てが `principle IS NOT NULL` で落ちる
// 管理画面はどちらも「登録完了・N件の分割テキスト」と表示するため、UIからは区別がつかない。
//
// 「book_id=6 を psychology_book スキーマで再構造化する」という対処は採らない。
// 実データを比較すると sales_manual 側の方が質が高く(problem「商談の主導権をお客さまに
// 握られてしまう」/ solution「営業マンがプロフェッショナルとして知識を提供し、お客さまを
// 助ける」)、psychology_book 側は situation と example が同一文言・contraindication が
// 禁忌になっていない行が多い。質の良いデータを捨てて質の悪い形式に合わせることになる。
// 検索側がキー名に依存している方が構造的な誤りなので、そちらを直す。
//
// 3冊目が別スキーマで入った場合は、ここに1行足せば原則注入に乗る。

import { KNOWN_SCHEMAS } from "../../lib/book-pipeline/contentAnalyzer";

/**
 * PrincipleChunk の各フィールドを、どのスキーマのどのキーから読むか。
 *
 * `null` は「このスキーマに対応するフィールドが無い」ことを表す。
 * buildPrinciplePrompt は空文字のフィールドを行ごと省くため、欠けても壊れない。
 */
export interface PrincipleFieldMapping {
  /** KNOWN_SCHEMAS のキー。principleSchemaMap.test.ts が実在を検証する。 */
  contentType: keyof typeof KNOWN_SCHEMAS | string;
  /** 打ち手そのもの。これが無いスキーマは原則注入の対象にしない。 */
  principle: string;
  /** どんな場面で使うか。 */
  situation: string | null;
  /** どう使うか。 */
  example: string | null;
  /** 使うときの注意・禁忌。 */
  contraindication: string | null;
}

/**
 * 原則注入の対象にするスキーマと、そのフィールド対応。
 *
 * product_catalog / business_document / general_report は「打ち手」を表すフィールドを
 * 持たない(商品名・仕様・要点・データ)ため、意図的に対象外にしている。
 * これらは通常の RAG(pgvector.ts)が source を問わず引くので、参考情報としては届く。
 */
export const PRINCIPLE_SCHEMA_MAPPINGS: readonly PrincipleFieldMapping[] = [
  {
    contentType: "psychology_book",
    principle: "principle",
    situation: "situation",
    example: "example",
    contraindication: "contraindication",
  },
  {
    // sales_manual には「禁忌」に相当するフィールドが無い。objection_handling
    // (予想される反論と対処法)は例示ではなく「気をつけること」に最も近いため
    // contraindication に寄せる。benefit / target_customer は打ち手の説明として
    // 情報量が乏しい(実データ例:「営業マンが売れる」)ため使わない。
    contentType: "sales_manual",
    principle: "solution",
    situation: "problem",
    example: null,
    contraindication: "objection_handling",
  },
] as const;

/** PrincipleChunk の論理フィールド名。SQL の COALESCE 生成順にも使う。 */
export const PRINCIPLE_FIELDS = [
  "principle",
  "situation",
  "example",
  "contraindication",
] as const;

export type PrincipleField = (typeof PRINCIPLE_FIELDS)[number];

/**
 * 1つの論理フィールドについて `COALESCE(metadata->>'a', metadata->>'b') AS field` を組み立てる。
 * 対応キーが1つだけなら COALESCE で包まない。
 */
export function buildFieldSelect(field: PrincipleField): string {
  const keys = PRINCIPLE_SCHEMA_MAPPINGS.map((m) => m[field]).filter(
    (k): k is string => k !== null,
  );
  // 重複キー(複数スキーマが同名フィールドを持つ場合)は先勝ちで1つにまとめる
  const uniqueKeys = [...new Set(keys)];
  const exprs = uniqueKeys.map((k) => `metadata->>'${k}'`);
  if (exprs.length === 0) return `NULL AS ${field}`;
  if (exprs.length === 1) return `${exprs[0]} AS ${field}`;
  return `COALESCE(${exprs.join(", ")}) AS ${field}`;
}

/**
 * 「いずれかのスキーマの打ち手フィールドを持つ行」を絞り込む WHERE 句を組み立てる。
 * 打ち手が無い行(目次・奥付など構造化に失敗したチャンク)は原則注入に載せない。
 */
export function buildPrincipleWhereClause(): string {
  const keys = [...new Set(PRINCIPLE_SCHEMA_MAPPINGS.map((m) => m.principle))];
  return `(${keys.map((k) => `metadata->>'${k}' IS NOT NULL`).join(" OR ")})`;
}

/** PRINCIPLE_FIELDS の各要素を検索テキストに埋め込むときの日本語ラベル。 */
const PRINCIPLE_FIELD_LABELS: Record<PrincipleField, string> = {
  principle: "原則",
  situation: "状況",
  example: "例",
  contraindication: "禁忌",
};

/**
 * 指定スキーマの metadata から、bookStructurizer.ts の `buildSearchText` に渡す
 * ラベル付きフィールドを組み立てる(T6: チャンク編集後の再埋め込みで使用)。
 *
 * 対応表に無いスキーマ(product_catalog 等、打ち手フィールドを持たない)は空配列を返す。
 * 値が空文字/未設定のフィールドは省く(スキーマによっては対応キーが無いため)。
 */
export function buildSearchTextFields(
  contentType: string,
  metadata: Record<string, unknown>,
): { label: string; value: string }[] {
  const mapping = PRINCIPLE_SCHEMA_MAPPINGS.find((m) => m.contentType === contentType);
  if (!mapping) return [];

  const fields: { label: string; value: string }[] = [];
  for (const field of PRINCIPLE_FIELDS) {
    const key = mapping[field];
    if (key === null) continue;
    const value = metadata[key];
    if (typeof value === "string" && value !== "") {
      fields.push({ label: PRINCIPLE_FIELD_LABELS[field], value });
    }
  }
  return fields;
}
