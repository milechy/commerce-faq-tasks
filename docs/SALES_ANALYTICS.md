# Sales Analytics (Phase15-16)

SalesFlow の実運用ログ（SalesLogs）と TemplateMatrix をもとに、

- どの intent / persona で fallback が多いか
- どのステージにどれくらい滞留しているか

を可視化するための「分析レイヤー」の仕様と使い方をまとめる。

対象となるスクリプト:

- `SCRIPTS/convertTemplateMatrixCsvToJson.ts`
- `SCRIPTS/convertSalesLogsCsvToJson.ts`
- `SCRIPTS/analyzeTemplateFallbacks.ts`
- `SCRIPTS/analyzeSalesKpiFunnel.ts`
- `SCRIPTS/run_template_fallback_report.sh`
- `SCRIPTS/run_sales_reports.sh`

---

## 1. Overview（目的と全体像）

### 1.1 何をしたいか

Phase15-16 の Sales Analytics は、次のような問いに答えるための仕組み:

- **Template 側の問い**

  - どの `phase × intent × personaTag` で Notion テンプレが存在するか？
  - Notion テンプレがあるはずなのに、実際には fallback で返してしまっているケースはどこか？

- **KPI / Funnel 側の問い**
  - SalesFlow の各ステージ（clarify / propose / recommend / close）に、実ログがどれだけ分布しているか？
  - intent や personaTag ごとに、fallback 率はどれくらいか？

これらを、

- ログ → CSV → JSON
- JSON → Markdown レポート

という形で処理し、日次 / 任意タイミングで実行できるようにするのがゴール。

### 1.2 ざっくりした処理フロー

1. 本番 / ローカル環境で生成された SalesLogs を CSV としてエクスポート
2. TemplateMatrix を CSV（`phase,intent,personaTag,hasTemplate`）として用意
3. 次の CLI を順番に実行してレポートを生成:
   - `SCRIPTS/run_template_fallback_report.sh`
   - `SCRIPTS/run_sales_reports.sh`
4. 生成された Markdown レポート（`reports/*.md`）を見ながら、
   - どの intent / personaTag のセルを優先して Notion テンプレで埋めるか
   - SalesFlow のステージ分布や fallback 率が改善しているか
     を確認する。

---

## 2. Data Sources（入力データ）

Analytics 用の CLI は、主に 2 種類の入力ファイルを前提としている。

- **TemplateMatrix CSV**: `data/template_matrix.csv`
- **Sales Logs CSV**: `data/sales_logs.csv`（または日付付きファイルを指定）

これらを JSON に変換したうえで、分析スクリプトが集計を行う。

### 2.1 TemplateMatrix CSV

パス:

- デフォルト: `data/template_matrix.csv`

想定カラム（ヘッダー）:

- `phase` — `clarify | propose | recommend | close` など
- `intent` — 例: `trial_lesson_offer`, `recommend_course_based_on_level`
- `personaTag` — 例: `beginner`, `ANY`
- `hasTemplate` — `true` / `false`（Notion テンプレが存在するか）

役割:

- 「設計上、このセルには Notion テンプレがあるはずか？」という **期待値** を表す。
- 分析時には、実ログ側の `templateSource`（notion / fallback）と突き合わせて、
  - `NG_FALLBACK_SHOULD_HAVE_TEMPLATE`（テンプレあるのに fallback している）
  - `OK_NOTION` / `OK_EXPECTED_FALLBACK`
    を判定するために利用する。

JSON への変換:

- コマンド例:
  ```bash
  npx ts-node SCRIPTS/convertTemplateMatrixCsvToJson.ts \
    --input data/template_matrix.csv \
    --output data/template_matrix.json
  ```

### 2.2 Sales Logs CSV

パス:

- デフォルト: `data/sales_logs.csv`
- 日付ごとにエクスポートする場合の例: `data/sales_logs_YYYYMMDD.csv`

最低限必要なカラム（推奨）:

- `timestamp` — ログ時刻（任意）
- `tenantId` — テナント ID（任意）
- `sessionId` — セッション ID（任意）
- `phase` — SalesFlow のステージ（例: `propose`, `recommend`）
- `intent` — 検出 or 指定された intent
- `personaTags` — カンマ区切りのタグ（例: `beginner,price_sensitive`）
- `templateId` — 実際に使われたテンプレート ID（Notion ID や fallback ID）
- `templateSource` — `notion` / `fallback`
- `prevStage`, `nextStage`, `stageTransitionReason` — Phase16 時点では、ステージ遷移分析・Funnel 分析のために含める前提

役割:

- 実際の SalesFlow 実行ログを集計・分析するための **生データ**。
- Template fallback 分析では:
  - `phase`
  - `intent`
  - `personaTags`
  - `templateSource`
    を中心に参照する。
- KPI Funnel 分析では:
  - `phase`
  - `intent`
  - `personaTags`
  - `prevStage` / `nextStage` / `stageTransitionReason`
    を利用して、ステージ分布・ステージ遷移・Funnel を算出する。

JSON への変換:

- コマンド例:
  ```bash
  npx ts-node SCRIPTS/convertSalesLogsCsvToJson.ts \
    --input data/sales_logs.csv \
    --output data/sales_logs.json
  ```

この 2 つの JSON（`template_matrix.json` / `sales_logs.json`）をもとに、

- `analyzeTemplateFallbacks.ts`
- `analyzeSalesKpiFunnel.ts`

が Markdown レポートを生成する。

---

## 3. Template Fallback Report の読み方

Template fallback のレポートは、主に次のスクリプトで生成する。

- 単体実行: `npx ts-node SCRIPTS/analyzeTemplateFallbacks.ts --matrix data/template_matrix.json --logs data/sales_logs.json`
- 一括実行: `SCRIPTS/run_template_fallback_report.sh`
  - 内部で CSV → JSON 変換とレポート生成をまとめて実行する

### 3.1 レポート構成

出力例（抜粋）:

```md
# Template Fallback Analysis

- Matrix file: data/template_matrix.json
- Logs file: data/sales_logs.json
- Generated at: 2025-12-07T05:30:44.889Z

## Summary

- Cells: 3
- Total hits: 3
- Fallback hits: 2

## Per-cell Detail

| Phase     | Intent                          | PersonaTag | MatrixHasTemplate | Hits | FallbackHits | NonFallbackHits | Status                           |
| --------- | ------------------------------- | ---------- | ----------------- | ---: | -----------: | --------------: | -------------------------------- |
| propose   | trial_lesson_offer              | ANY        | NO                |    0 |            0 |               0 | UNUSED_CELL                      |
| propose   | trial_lesson_offer              | beginner   | YES               |    2 |            1 |               1 | NG_FALLBACK_SHOULD_HAVE_TEMPLATE |
| recommend | recommend_course_based_on_level | beginner   | NO                |    1 |            1 |               0 | OK_EXPECTED_FALLBACK             |
```

主に見るポイントは次の 3 つ:

1. **Summary セクション**

   - `Cells`: TemplateMatrix 上のセル数（phase × intent × personaTag の組み合わせ）
   - `Total hits`: ログ上、そのセルに一度でもアクセスがあった回数の合計
   - `Fallback hits`: そのうち `templateSource = fallback` だった回数の合計

2. **Per-cell Detail テーブル**

   - `Hits`: ログ上でそのセルが参照された回数
   - `FallbackHits`: そのセルで fallback が使われた回数
   - `NonFallbackHits`: Notion テンプレが使われた回数
   - `MatrixHasTemplate`: TemplateMatrix 上で `hasTemplate = true` かどうか
   - `Status`: セルの評価結果（後述）

3. **Status の値**
   - `OK_NOTION`: TemplateMatrix 上で `hasTemplate = true` かつ、実ログでも Notion テンプレが使われている
   - `OK_EXPECTED_FALLBACK`: TemplateMatrix 上でも `hasTemplate = false` で、fallback 利用が前提になっている
   - `NG_FALLBACK_SHOULD_HAVE_TEMPLATE`: `hasTemplate = true` にも関わらず、fallback が使われているケースがある
   - `UNUSED_CELL`: 現時点でログ上、一度も参照されていないセル

### 3.2 どのセルを優先改善するか

運用上は、次の順番で見ると効率が良い:

1. **`NG_FALLBACK_SHOULD_HAVE_TEMPLATE` のセル**

   - 期待値としては Notion テンプレが存在する想定だが、実際には fallback が使われている。
   - 主な原因:
     - TuningTemplates Notion DB にレコードが存在しない
     - `personaTag` / `intent` / `phase` のマッピングがずれている
   - 対応:
     - Notion DB に該当セルのテンプレを追加 or 修正する
     - TemplateMatrix / ルールロジック側の条件を見直す

2. **`OK_EXPECTED_FALLBACK` のセル**

   - もともと「fallback 前提」だが、fallback hits が多くなっている箇所。
   - fallback 文言でユーザー体験が十分であればそのままでもよいが、重要 intent であれば：
     - TuningTemplates DB に専用テンプレを追加することで、UX を高められる候補になる。

3. **`UNUSED_CELL` のセル**
   - 将来のために設計だけしている intent / persona 組み合わせ、あるいは単に使われていないセル。
   - すぐに対応は不要だが、「今後キャンペーンで使う intent」など、増やしたいトラフィックとの整合を確認する。

---

## 4. Sales KPI Funnel Report の読み方

Sales KPI Funnel のレポートは、主に次のスクリプトで生成する。

- 単体実行: `npx ts-node SCRIPTS/analyzeSalesKpiFunnel.ts --logs data/sales_logs.json`
- 一括実行: `SCRIPTS/run_sales_reports.sh`
  - Template fallback レポートと同時に、KPI Funnel レポートも生成する

### 4.1 レポート構成

出力例（抜粋）:

```
# Sales KPI Funnel Analysis

- Logs file: data/sales_logs.json
- Generated at: 2025-12-07T05:51:20.990Z

## Summary

- Entries: 5
- Unique sessions: 1
- Unique tenants: 1

## Stage Distribution

| Stage     | Count | Ratio |
| --------- | ----: | ----: |
| propose   |     3 | 60.0% |
| recommend |     2 | 40.0% |

## Stage Transitions

| From    | To        | Count |
| ------- | --------- | ----: |
| clarify | propose   |     1 |
| propose | recommend |     1 |

## Funnel Metrics (clarify → propose → recommend → close)

| From    | To        | Count | Base (from *) | Rate   |
| ------- | --------- | ----: | ------------: | -----: |
| clarify | propose   |     1 |             1 | 100.0% |
| propose | recommend |     1 |             1 | 100.0% |
| recommend | close   |     0 |             0 |   0.0% |

## PersonaTag Breakdown

| PersonaTag | Total | clarify | propose | recommend | close |
| ---------- | ----: | ------: | ------: | --------: | ----: |
| beginner   |     5 |       0 |       3 |         2 |     0 |

## Intent Breakdown

| Intent                          | Count | FallbackCount | FallbackRate |
| ------------------------------- | ----: | ------------: | -----------: |
| recommend_course_based_on_level |     2 |             1 |        50.0% |
| trial_lesson_offer              |     3 |             1 |        33.3% |
```

主に見るポイント:

1. **Stage Distribution**
   - 各ステージ（clarify / propose / recommend / close）に、SalesLogs がどれだけ分布しているか。
2. **Stage Transitions**
   - `prevStage` / `nextStage` ごとの遷移回数を確認し、どのステージ間で詰まりやすいかを見る。
3. **Funnel Metrics**
   - clarify → propose → recommend → close の各ステップで、何件が次のステージに進めているか（Rate を含む）を確認する。
4. **PersonaTag Breakdown**
   - personaTag ごとに、どのステージで多く出現しているかを見る。
5. **Intent Breakdown（FallbackRate を含む）**
   - intent ごとのヒット数と fallback 利用率を一覧で確認し、どの intent を優先的にチューニングすべきかを判断する。

### 4.2 今後の拡張ポイント

Phase16 では SalesLogWriter / runSalesFlowWithLogging が `prevStage` / `nextStage` / `stageTransitionReason` を書き出し、`SCRIPTS/analyzeSalesKpiFunnel.ts` では Stage Distribution / Stage Transitions / Funnel Metrics までを出力するようになった。一方で、personaTag 別の Funnel や userAction ベースのコンバージョン分析など、高度な分析はまだ最小限であり、以下は今後の拡張アイデアである。

- `userAction`（例: trial レッスン予約）のイベントをログに追加し、コンバージョン率を計測
- `personaTag` 別の Funnel（beginner と non-beginner での比較）を出す

これらは Phase16 以降のテーマとして検討する。
