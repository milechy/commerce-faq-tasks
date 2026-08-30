// tests/lp/planFeatureBulletInvariants.test.ts
//
// public/lp/index.html の料金表(プラン別箇条書き)と
// src/lib/billing/planFeatures.ts の FEATURE_MIN_PLAN を突合するテスト。
//
// 背景: PR #1058 で「詳しい分析レポート」の掲載プランを Growth → Standard へ
// 移したのは人手作業だった。LPの箇条書きと FEATURE_MIN_PLAN が一致していることを
// 強制する仕組みが無いため、今後ゲートを動かすたびに同じズレ(表記だけ先に進む/
// 実装だけ先に進む)が起き得る。
//
// 設計方針(tests/billing/planRankInvariants.test.ts と同じ手法を踏襲):
// FEATURE_MIN_PLAN は非exportのモジュール内constなので、import はできない。
// 代わりに実ファイルのソーステキストを直接読み込み、オブジェクトリテラルを
// 正規表現で抽出してパースする(admin-uiとの整合を見る既存テストと同じ作法)。
//
// 対応表(LPの人間向け文言 → GatedFeatureキー)はこのファイル内に置く。
// - LPの箇条書きは「ゲートの表示名」であり、GatedFeatureはコードの内部キー。
//   両者を繋ぐ対応関係そのものが新しい真実の源泉になるため、他ファイルに
//   切り出すよりテストの意図が一目で分かるここに置く方が良いと判断した
//   (このテスト以外から参照されないデータであり、共有の必要がない)。
// - LPの全箇条書きを網羅する必要はない。「専任サポート」「稼働率保証」
//   「カスタム開発対応」等、ゲート(GatedFeature)に対応しない項目は対象外。
// - voice_clone・pre_dispatch は FEATURE_MIN_PLAN には存在するが、料金表の
//   箇条書きに一字一句対応する文言が無い(内部フラグ・文脈依存の説明のみ)ため、
//   誤対応を避けてここでは対象外とする(下記 EXCLUDED_FROM_LP_BULLETS 参照)。
//
// ★穴を塞ぐ仕組み(新しいGatedFeatureの書き忘れ検出)★
// 上記の「対象外」は本来 FEATURE_BULLETS に載っていない全てのGatedFeatureと
// 見分けが付かない(=新しいゲートを追加してLPへの反映を忘れても、単に
// FEATURE_BULLETSに無いだけの状態と区別できず、このテストは静かに緑のまま
// だった)。これを塞ぐため、GatedFeature型の全メンバーを
// `FEATURE_BULLETS ∪ EXCLUDED_FROM_LP_BULLETS` で完全に被覆することを
// 別テストで強制する。新しいゲートを追加したら、必ずどちらかに追記しないと
// テストが落ちる。
//
// 検証の考え方(LPの累積表記に注意):
// 料金表は「Standardの全機能」のように前段プランの機能を積み上げて表示するため、
// 例えば「成果（購入・予約）の計測」はGrowthのカードにのみ書かれ、Enterpriseの
// カードには(積み上げ表記のため)繰り返し書かれない。つまり、ある文言が
// 「初めて登場するプラン」がそのままLPが主張する最低プランである。
// これを機械的に求めるため、各プランのカード本文を切り出し、
//   1) 対応表の文言が「ちょうど1枚のカード」にのみ出現すること
//      (0枚 = LPから消えた/文言が変わった、2枚以上 = プランを跨いで重複しており
//      「どのプランに書いてあるか」を一意に決められない、いずれも即エラー)
//   2) その1枚のカードのプラン と FEATURE_MIN_PLAN[feature] が一致すること
// を assert する。FEATURE_MIN_PLAN 側の値をこの対応表に埋め込まない(=期待値を
// 両側で決め打ちしない)ことで、「LPをGrowthに書いたのにコードはstandard」
// のような食い違いを型チェックを通ったまま静かに緑にしない。

import fs from "fs";
import path from "path";

const LP_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../public/lp/index.html"),
  "utf8",
);
const PLAN_FEATURES_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/lib/billing/planFeatures.ts"),
  "utf8",
);

// tests/billing/planRankInvariants.test.ts と同じ抽出方式
// (`NAME: Record<...> = { ...obj literal... };` をJSONライクにパースする)。
function extractRecordLiteral(src: string, name: string): Record<string, string> {
  const re = new RegExp(`${name}\\s*:\\s*Record<[^>]+>\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`${name} のオブジェクトリテラルが見つからない: 抽出用正規表現の更新が必要`);
  }
  const jsonish = match[1]
    .replace(/\/\/.*$/gm, "")
    .replace(/(\w+)\s*:/g, '"$1":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(jsonish);
}

// `export type GatedFeature = | "a" | "b" | ...;` からユニオンの全メンバーを抽出する。
// GatedFeatureは型(値ではない)なのでimportできず、FEATURE_MIN_PLANと同様に
// ソーステキストを直接読む(この抽出方式が壊れる=GatedFeatureの定義形式が
// 変わった場合は、後述のテストがマーカー未検出で落ちる)。
function extractGatedFeatureUnionMembers(src: string): string[] {
  const re = /export type GatedFeature\s*=\s*([\s\S]*?);/;
  const match = src.match(re);
  if (!match) {
    throw new Error("GatedFeature のunion型定義が見つからない: 抽出用正規表現の更新が必要");
  }
  const members = [...match[1].matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  if (members.length === 0) {
    throw new Error("GatedFeature のunion型からメンバーを1つも抽出できなかった");
  }
  return members;
}

// 料金表(#pricing セクション)のプラン毎カードを切り出すための境界マーカー。
// public/lp/index.html 側に既にある `<!-- Free(広告表示) -->` 等のHTMLコメントを
// そのままアンカーとして使う(このコメント自体が変わったら「カード境界を機械的に
// 区別できない」ことになるため、その場合はこのテストがマーカー未検出で落ちる)。
const PLAN_CARD_MARKERS: ReadonlyArray<{ plan: string; marker: string }> = [
  { plan: "free_ad", marker: "<!-- Free(広告表示) -->" },
  { plan: "starter", marker: "<!-- Starter -->" },
  { plan: "standard", marker: "<!-- Standard -->" },
  { plan: "growth", marker: "<!-- Growth (featured) -->" },
  { plan: "enterprise", marker: "<!-- Enterprise -->" },
];
// 料金表セクション全体の終端(Enterpriseカードの直後にある注記段落の開始位置)。
// これが無いと最後のカード(Enterprise)の切り出し範囲が無限に伸び、
// セクション外の注記文言(例: 907行目付近の「R2Cエージェントによる各種設定代行」)を
// 誤って拾ってしまう。
const PRICING_SECTION_END_MARKER =
  '<p style="text-align:center; font-size:13px; color:var(--muted); margin-top:24px;';

/** プラン名 → そのプランのカード本文(次マーカーまたはセクション終端まで)。 */
function extractPlanCardSections(src: string): Record<string, string> {
  const positions = PLAN_CARD_MARKERS.map(({ plan, marker }) => {
    const idx = src.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        `料金表のマーカーが見つからない: "${marker}" (LP構造が変わった場合はこのテストのマーカーも更新すること)`,
      );
    }
    return { plan, start: idx };
  });
  const endIdx = src.indexOf(PRICING_SECTION_END_MARKER);
  if (endIdx === -1) {
    throw new Error("料金表セクションの終端マーカーが見つからない");
  }

  const sections: Record<string, string> = {};
  positions.forEach(({ plan, start }, i) => {
    const end = i + 1 < positions.length ? positions[i + 1].start : endIdx;
    sections[plan] = src.slice(start, end);
  });
  return sections;
}

// LPの箇条書き文言 → GatedFeatureキー の対応表。
// 「対応するGatedFeatureが存在する箇条書きのみ」を載せる(冒頭コメント参照)。
const FEATURE_BULLETS: ReadonlyArray<{ feature: string; lpText: string }> = [
  { feature: "avatar", lpText: "AIアバター（既定アバター・顔・声）" },
  // voice(音声入出力)はLP上、avatarと同じ箇条書き「AIアバター（既定アバター・顔・声）」の
  // 「声」に内包されており、単独の箇条書きは存在しない。avatarと同じlpTextを
  // 割り当てることで「1枚のカードにのみ出現」チェックはavatarと共有しつつ、
  // FEATURE_MIN_PLAN.voice が avatar と食い違って動いた場合(例: 音声だけGrowthへ
  // 引き上げたのにLPの表記をStandardカードのまま放置)を検出できるようにする。
  { feature: "voice", lpText: "AIアバター（既定アバター・顔・声）" },
  { feature: "analytics", lpText: "詳しい分析レポート" },
  { feature: "avatar_customize", lpText: "アバターのカスタム作成（自社の顔・声）" },
  { feature: "conversion", lpText: "成果（購入・予約）の計測" },
  { feature: "premium_avatar", lpText: "プレミアムアバター生成（従量オプション）" },
  { feature: "hide_branding", lpText: "「Powered by R2C」バッジの非表示" },
  { feature: "deep_research", lpText: "ディープリサーチ" },
  { feature: "sai_task", lpText: "R2Cエージェントによる設定代行" },
];

// FEATURE_BULLETSに載せない(=LPの箇条書きと突合しない)GatedFeatureの明示allowlist。
// ここに無い、かつFEATURE_BULLETSにも無いGatedFeatureが増えたら、後述の
// 「未網羅のGatedFeatureが無いこと」テストが落ちる(新しいゲートをLPにもallowlistにも
// 反映し忘れて静かに緑のままになる穴を塞ぐため)。
const EXCLUDED_FROM_LP_BULLETS: ReadonlyArray<{ feature: string; reason: string }> = [
  {
    feature: "voice_clone",
    reason:
      "FEATURE_MIN_PLANには存在するが、料金表の箇条書きに一字一句対応する文言が無い" +
      "(内部フラグ・文脈依存の説明のみ)。誤対応を避けるため対象外。",
  },
  {
    feature: "pre_dispatch",
    reason:
      "事前ディスパッチ(アバター高速表示)はLPの箇条書きとして独立掲載されておらず、" +
      "FAQ等の文脈依存の説明のみ。誤対応を避けるため対象外。",
  },
];

describe("LP料金表(public/lp/index.html)とFEATURE_MIN_PLANの整合性", () => {
  const planCards = extractPlanCardSections(LP_SRC);
  const featureMinPlan = extractRecordLiteral(PLAN_FEATURES_SRC, "FEATURE_MIN_PLAN");

  it.each(FEATURE_BULLETS)(
    "「$lpText」が初めて登場するプランとFEATURE_MIN_PLAN.$featureが一致する",
    ({ feature, lpText }) => {
      // LPの累積表記(Standardの全機能、のように前段を積み上げる)により、
      // この文言は「最低プランのカードにのみ」出現するはず。0枚/2枚以上は
      // いずれも「LPからどのプランの機能か一意に読み取れない」状態なので、
      // ここで検出してテストを落とす(片方向だけの比較にしない)。
      const plansContainingText = Object.entries(planCards)
        .filter(([, cardHtml]) => cardHtml.includes(lpText))
        .map(([plan]) => plan);

      if (plansContainingText.length !== 1) {
        throw new Error(
          `"${lpText}" が ${plansContainingText.length}枚のカードに出現した(期待:1枚)。` +
            `出現先: [${plansContainingText.join(", ")}]。文言が変わったか、複数プランに重複記載されている。`,
        );
      }

      const [lpMinPlan] = plansContainingText;
      // LP上「初めて登場したプラン」とコードのFEATURE_MIN_PLANが一致しない場合、
      // ここでの失敗メッセージ自体が「LPが${lpMinPlan}に置いているのにFEATURE_MIN_PLANは
      // ${featureMinPlan[feature]}」というズレの内容そのものになる。
      expect(featureMinPlan[feature]).toBe(lpMinPlan);
    },
  );

  it("対応表に載せた文言が、それぞれ想定より下位のプランのカードには一切出現しない", () => {
    // it.each 内の「ちょうど1枚」判定に加え、想定プラン未満のカードに
    // 部分的に出現していないかも明示的に確認する(累積表記の取り違え防止の二重check)。
    const planOrder = PLAN_CARD_MARKERS.map((m) => m.plan);

    for (const { feature, lpText } of FEATURE_BULLETS) {
      const minPlan = featureMinPlan[feature];
      const minPlanIndex = planOrder.indexOf(minPlan);
      if (minPlanIndex < 0) {
        throw new Error(`未知のプラン: ${minPlan} (feature=${feature})`);
      }

      const lowerPlans = planOrder.slice(0, minPlanIndex);
      for (const lowerPlan of lowerPlans) {
        if (planCards[lowerPlan].includes(lpText)) {
          throw new Error(
            `"${lpText}"は${feature}(min=${minPlan})の対象より下位の${lowerPlan}カードに出現している`,
          );
        }
      }
    }
  });

  it("GatedFeatureの全メンバーがFEATURE_BULLETS(LP対応)かEXCLUDED_FROM_LP_BULLETS(明示allowlist)のどちらかに載っている", () => {
    // 新しいGatedFeatureを追加したとき、LPへの反映(FEATURE_BULLETS)を忘れても
    // 「対象外として明示的に許可されている」ケースと区別が付かず、このファイルの
    // 他のテストは静かに緑のままになる。それを防ぐため、GatedFeatureの全メンバーが
    // 必ずどちらか一方に(重複なく)載っていることを強制する。
    const allGatedFeatures = extractGatedFeatureUnionMembers(PLAN_FEATURES_SRC);
    const coveredByBullets = new Set(FEATURE_BULLETS.map((b) => b.feature));
    const coveredByAllowlist = new Set(EXCLUDED_FROM_LP_BULLETS.map((e) => e.feature));

    const missing = allGatedFeatures.filter(
      (f) => !coveredByBullets.has(f) && !coveredByAllowlist.has(f),
    );
    if (missing.length > 0) {
      throw new Error(
        `GatedFeatureに追加されたが、LP対応表(FEATURE_BULLETS)にも明示allowlist` +
          `(EXCLUDED_FROM_LP_BULLETS)にも載っていない: [${missing.join(", ")}]。\n` +
          "LPの箇条書きに対応する文言があるならFEATURE_BULLETSに追加し、" +
          "無いなら理由を添えてEXCLUDED_FROM_LP_BULLETSに追加すること。",
      );
    }

    const overlapping = allGatedFeatures.filter(
      (f) => coveredByBullets.has(f) && coveredByAllowlist.has(f),
    );
    if (overlapping.length > 0) {
      throw new Error(
        `FEATURE_BULLETSとEXCLUDED_FROM_LP_BULLETSの両方に載っている(意図が矛盾する): [${overlapping.join(", ")}]`,
      );
    }

    // allowlist側に、既にGatedFeatureから削除された古いキーが残っていないかも確認する
    // (残存していても実害は無いが、削除漏れは「なぜ対象外なのか」の記録が陳腐化する)。
    const staleAllowlistEntries = EXCLUDED_FROM_LP_BULLETS.map((e) => e.feature).filter(
      (f) => !allGatedFeatures.includes(f),
    );
    if (staleAllowlistEntries.length > 0) {
      throw new Error(
        `EXCLUDED_FROM_LP_BULLETSに、既にGatedFeatureから削除されたキーが残っている: [${staleAllowlistEntries.join(", ")}]`,
      );
    }
  });
});
