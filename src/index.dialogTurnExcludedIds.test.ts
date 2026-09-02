// src/index.dialogTurnExcludedIds.test.ts
//
// [外1] GID 1218086284362759: /dialog/turn の options に excluded_ids が無く、
// Zod既定の strip で黙って捨てられていた（HTTP 200 が返り除外が一切適用されない）。
// AVAS向け仕様書 docs/PHASE69_2_API_SPEC.md は「★実装確認済み」と誤記していたため
// 出荷ブロッカーだった。
//
// src/index.ts は app.listen 副作用のため丸ごと import できない
// （index.wiringInvariants.test.ts と同じ制約）。ここでは index.ts のソースから
// `const schemaIn = z.object(...)` の実ソース断片をそのまま抽出して実行し、
// 実際に本番で使われている Zod スキーマそのものに対して safeParse を走らせる
// （手で書き写した複製を検査するのではなく、実ソースのドリフトを直接検出する）。
// 抽出対象の文字列が実ソースと一致していることは index.wiringInvariants.test.ts
// 側で固定する。

import { readFileSync } from "fs";
import { join } from "path";
import { z, type ZodTypeAny } from "zod";

const SOURCE_PATH = join(__dirname, "index.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

/**
 * index.ts の `const schemaIn = z.object({ ... });`（/dialog/turn ルート内）を
 * 丸ごと抽出し、実行して同一の ZodObject を返す。
 */
function loadDialogTurnSchema(): ZodTypeAny {
  // まず /dialog/turn ルート登録の位置を見つけ、その直後にある schemaIn 宣言を探す
  // （インデント/改行の揺れに強くするため、まずルート自体を正規表現で見つける）。
  const routeMatch = source.match(/app\.post\(\s*["']\/dialog\/turn["']/);
  if (!routeMatch || routeMatch.index === undefined) {
    throw new Error("`/dialog/turn` ルート登録が見つからない");
  }
  const startMarker = "const schemaIn = z.object(";
  const declStart = source.indexOf(startMarker, routeMatch.index);
  if (declStart === -1) {
    throw new Error("schemaIn 宣言が見つからない");
  }

  // "z.object(" の開き括弧から対応する閉じ括弧までを、括弧の深さを数えて追跡する。
  let i = declStart + "const schemaIn = z.object".length; // "(" の位置
  let depth = 0;
  let endIdx = -1;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error("schemaIn 定義の括弧バランスが取れない");
  }

  const extracted = source.slice(declStart, endIdx + 1); // "const schemaIn = z.object(...)"
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function("z", `${extracted};\nreturn schemaIn;`);
  return build(z) as ZodTypeAny;
}

/** /dialog/turn の 400 応答本文を、index.ts と同じ分岐ロジックで組み立てる。 */
function buildErrorResponse(parsed: z.ZodSafeParseResult<unknown>) {
  if (parsed.success) return null;
  const touchesOptions = parsed.error.issues.some((issue: { path: PropertyKey[] }) => issue.path[0] === "options");
  if (touchesOptions) {
    return { status: 400, body: { error: "invalid_excluded_ids", details: parsed.error.flatten() } };
  }
  return { status: 400, body: { error: "invalid_request", details: parsed.error.issues } };
}

describe("/dialog/turn の options.excluded_ids バリデーション（実ソース抽出）", () => {
  const schemaIn = loadDialogTurnSchema();

  it("excluded_ids を渡すと options.excluded_ids として受理される（従来は黙って捨てられていた）", () => {
    const parsed = schemaIn.safeParse({
      message: "返品ポリシーを教えて",
      options: { excluded_ids: ["id-1", "id-2"] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as any).options.excluded_ids).toEqual(["id-1", "id-2"]);
    }
  });

  it("excluded_ids が501件で400になる（/agent.search と同じ上限500件）", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const parsed = schemaIn.safeParse({
      message: "質問",
      options: { excluded_ids: tooMany },
    });
    expect(parsed.success).toBe(false);
    const res = buildErrorResponse(parsed);
    expect(res?.status).toBe(400);
    expect(res?.body.error).toBe("invalid_excluded_ids");
  });

  it("500件はぎりぎり通る（境界値）", () => {
    const exactly500 = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const parsed = schemaIn.safeParse({
      message: "質問",
      options: { excluded_ids: exactly500 },
    });
    expect(parsed.success).toBe(true);
  });

  it("options に未知キーを送ると400になり、details にキー名が含まれる", () => {
    const parsed = schemaIn.safeParse({
      message: "質問",
      options: { totallyUnknownKey: "value" },
    });
    expect(parsed.success).toBe(false);
    const res = buildErrorResponse(parsed);
    expect(res?.status).toBe(400);
    expect(res?.body.error).toBe("invalid_excluded_ids");
    expect(JSON.stringify(res?.body.details)).toContain("totallyUnknownKey");
  });

  it("options が未指定でも従来どおり通る（後方互換）", () => {
    const parsed = schemaIn.safeParse({ message: "こんにちは" });
    expect(parsed.success).toBe(true);
  });

  it("options 以外の検証エラー（message欠落）は invalid_request のまま", () => {
    const parsed = schemaIn.safeParse({ options: { excluded_ids: ["a"] } });
    expect(parsed.success).toBe(false);
    const res = buildErrorResponse(parsed);
    expect(res?.body.error).toBe("invalid_request");
  });

  // 仕様書 docs/PHASE69_2_API_SPEC.md に載る全フィールドがルートのスキーマに
  // 存在することを検証するメタテスト。
  //
  // 対象は §2.2 の「フィールド」表（必須/説明つきの正式な仕様行）に限定する。
  // 同じ節の JSON サンプルには language/piiMode も併記されているが、それらは
  // 「excluded_ids は options 配下に入る」という nesting を示すための例示であり、
  // 正式なフィールド表には excluded_ids しか無い。特に piiMode は
  // src/api/chat/route.ts が自前で判定した値のみを信用し、クライアント入力を
  // 無視する設計（PII判定をクライアントに渡すとなりすまし放題になる）で、
  // runDialogTurn 自体もこれを読んでいない死んだ型フィールドのため、意図的に
  // このメタテストの対象外にする。
  describe("メタテスト: docs/PHASE69_2_API_SPEC.md §2.2 フィールド表 との整合", () => {
    const specPath = join(__dirname, "..", "docs", "PHASE69_2_API_SPEC.md");
    const specSource = readFileSync(specPath, "utf-8");

    function documentedDialogTurnFields(): string[] {
      const sectionIdx = specSource.indexOf("#### `/dialog/turn`");
      if (sectionIdx === -1) throw new Error("spec doc: `/dialog/turn` セクションが見つからない");
      const nextHeadingIdx = specSource.indexOf("\n### ", sectionIdx);
      const section = specSource.slice(sectionIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);

      // 「| `field_name` | 型 | 必須 | 説明 |」形式の表の行だけを拾う
      // （ヘッダ行・区切り行(---)は除外）。
      const rows = section
        .split("\n")
        .filter((line) => line.trim().startsWith("|"))
        .map((line) => {
          const m = line.match(/^\|\s*`([a-zA-Z_][a-zA-Z0-9_]*)`\s*\|/);
          return m?.[1];
        })
        .filter((name): name is string => Boolean(name));

      if (rows.length === 0) {
        throw new Error("spec doc: /dialog/turn のフィールド表が空 — 抽出ロジックが壊れている可能性");
      }
      return rows;
    }

    it("仕様書のフィールド表に載る各フィールドが options スキーマに存在する", () => {
      const documented = documentedDialogTurnFields();
      expect(documented).toContain("excluded_ids"); // 抽出ロジック自体の健全性チェック

      const optionsSchema: any = (schemaIn as any).shape.options;
      const unwrapped = optionsSchema.unwrap ? optionsSchema.unwrap() : optionsSchema._def.innerType;
      const optionKeys = Object.keys(unwrapped.shape);

      for (const field of documented) {
        expect(optionKeys).toContain(field);
      }
    });
  });
});
