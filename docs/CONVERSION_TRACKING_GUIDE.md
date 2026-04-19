# コンバージョン計測ガイド（パートナー向け）

このガイドは、R2C チャットウィジェットの「コンバージョン計測」機能を設定・活用するための手順書です。  
コンバージョン（購入・問い合わせ・予約など）をウィジェットと紐づけて計測することで、チャットがどれだけビジネス成果に貢献しているかを可視化できます。

---

## 目次

1. [コンバージョン計測とは](#1-コンバージョン計測とは)
2. [導入手順](#2-導入手順)
3. [trackConversion 関数リファレンス](#3-trackconversion-関数リファレンス)
4. [コンバージョン種別](#4-コンバージョン種別)
5. [実装パターン別サンプル](#5-実装パターン別サンプル)
6. [管理画面での確認方法](#6-管理画面での確認方法)
7. [よくある質問](#7-よくある質問)
8. [実サイト実装例：中古車販売サイト（カーネーション）](#8-実サイト実装例中古車販売サイトカーネーション)

---

## 1. コンバージョン計測とは

R2C ウィジェットは「チャットを通じた訪問者が、その後どのようなアクションを完了したか」を自動的に記録します。

```
訪問者がチャット開始
    ↓
商品について質問・検討
    ↓
購入・予約・問い合わせ完了  ← ここが「コンバージョン」
    ↓
管理画面でチャット貢献を確認
```

計測には、**完了ページ（サンクスページ）** に1行のJavaScriptを追加するだけで利用できます。

---

## 2. 導入手順

### Step 1: ウィジェットの設置（未設置の場合）

購入完了ページ等にもウィジェットを読み込む必要があります。通常はサイト全体のヘッダーやフッターに設置してください。

```html
<script
  src="https://api.r2c.biz/widget.js"
  data-api-key="YOUR_API_KEY"
  async
></script>
```

### Step 2: 完了ページへのコンバージョン通知

購入完了・予約完了・フォーム送信完了などのページに、以下のコードを追加します。

```html
<script>
  // ウィジェットがまだ読み込まれていない場合でも動作するよう、
  // キュー経由で呼び出してください（詳細は Section 5 参照）
  window.r2cQueue = window.r2cQueue || [];
  window.r2cQueue.push({
    type: 'conversion',
    conversionType: 'purchase',  // 種別を指定（Section 4 参照）
    value: 50000                  // 金額（任意）
  });
</script>
<script
  src="https://api.r2c.biz/widget.js"
  data-api-key="YOUR_API_KEY"
  async
></script>
```

これだけで計測が始まります。

---

## 3. trackConversion 関数リファレンス

ウィジェット読み込み後は `window.r2c.trackConversion()` を直接呼び出すことができます。

### 構文

```javascript
window.r2c.trackConversion(conversionType, conversionValue)
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `conversionType` | `string` | **必須** | コンバージョン種別（[Section 4](#4-コンバージョン種別) 参照） |
| `conversionValue` | `number` | 任意 | 金額や件数（例: `50000` = 5万円） |

### 戻り値

なし（非同期でサーバーに送信されます。エラーが発生しても画面の動作には影響しません）

### 動作仕様

- 計測データは非同期（`fetch` + `keepalive: true`）で送信されます
- ページ離脱直後でもデータが失われません
- `visitor_id` / `session_id` がない場合は自動的に `'unknown'` としてフォールバックします
- 送信失敗時はコンソールに警告を出力しますが、例外はスローされません

---

## 4. コンバージョン種別

`conversionType` に指定できる値は以下のとおりです。

| 値 | 用途の例 |
|---|---|
| `'purchase'` | 商品購入・決済完了 |
| `'inquiry'` | 問い合わせフォーム送信 |
| `'reservation'` | 予約・来店予約の完了 |
| `'signup'` | 会員登録・資料請求 |
| `'other'` | 上記に当てはまらないその他のアクション |

管理画面のコンバージョン分析では、種別ごとの集計が確認できます。

---

## 5. 実装パターン別サンプル

### パターン A: キュー方式（推奨）

ウィジェットスクリプトより**前**に記述できます。スクリプト読み込み完了後に自動的に実行されます。

```html
<!-- ① キューに積む（スクリプトより前でもOK） -->
<script>
  window.r2cQueue = window.r2cQueue || [];
  window.r2cQueue.push({
    type: 'conversion',
    conversionType: 'purchase',
    value: 50000
  });
</script>

<!-- ② ウィジェット読み込み（async で非同期） -->
<script
  src="https://api.r2c.biz/widget.js"
  data-api-key="YOUR_API_KEY"
  async
></script>
```

### パターン B: 直接呼び出し

ウィジェットが読み込み済みの状態（例：ページ内のボタンクリック時）で使用できます。

```html
<script>
  // ウィジェット読み込み後に実行
  document.getElementById('purchase-btn').addEventListener('click', function() {
    window.r2c.trackConversion('purchase', 29800);
  });
</script>
```

### パターン C: SPAでのページ遷移後（React / Vue / Next.js）

シングルページアプリでの購入完了コンポーネントの例：

```javascript
// React コンポーネント例（購入完了ページ）
useEffect(() => {
  if (window.r2c && window.r2c.trackConversion) {
    window.r2c.trackConversion('purchase', orderTotal);
  } else {
    // フォールバック: キュー経由
    window.r2cQueue = window.r2cQueue || [];
    window.r2cQueue.push({
      type: 'conversion',
      conversionType: 'purchase',
      value: orderTotal
    });
  }
}, []); // マウント時に一度だけ実行
```

### パターン D: 問い合わせフォーム送信後

```html
<script>
  document.getElementById('inquiry-form').addEventListener('submit', function(e) {
    // フォーム送信と同時にコンバージョンを記録
    window.r2cQueue = window.r2cQueue || [];
    window.r2cQueue.push({
      type: 'conversion',
      conversionType: 'inquiry'
      // value は省略可（金額換算が難しい場合）
    });
  });
</script>
```

### パターン E: 予約フォーム送信後

来店予約・試乗予約・宿泊予約などのフォームに設置する例です。

```html
<script>
  document.getElementById('reservation-form').addEventListener('submit', function() {
    // 予約フォーム送信時にコンバージョンを記録
    window.r2cQueue = window.r2cQueue || [];
    window.r2cQueue.push({
      type: 'conversion',
      conversionType: 'reservation'
      // value は省略可（予約単価が不定の場合）
    });
  });
</script>
```

> **ヒント**: フォームの `id` はサイトの実装に合わせて変更してください（例: `'booking-form'`、`'visit-form'` など）。

---

## 6. 管理画面での確認方法

導入後は、管理画面の「**コンバージョン分析**」ページで計測結果を確認できます。

### 表示される指標

| 指標 | 説明 |
|---|---|
| 総コンバージョン数 | 期間内の合計件数 |
| コンバージョン種別内訳 | purchase / inquiry / reservation / signup / other ごとの件数 |
| 平均温度スコア | コンバージョン時の訪問者エンゲージメント（0〜100） |
| トップ心理アプローチ | 最も効果的だったAIの会話アプローチ |

### 集計期間の切り替え

画面右上のセレクターから **7日 / 30日 / 90日** を選択できます。

### ダッシュボードの「CV計測」バッジ

ダッシュボードのKPIカードに「CV計測: ON」バッジが表示されていれば、直近30日以内にコンバージョンが正常に記録されています。  
「CV計測: 未計測」と表示されている場合は、Step 2 の実装を確認してください。

### 「CV未計測アラート」の見方

管理画面の「**アラート**」タブ（またはダッシュボード右上の🔔ベルアイコン）に以下のアラートが表示されることがあります。

| アラート名 | 意味 | 対処方法 |
|---|---|---|
| CV未計測（7日間） | 直近7日間にコンバージョンが1件も記録されていない | Step 2 のコードが完了ページに設置されているか確認 |
| CV種別不明 | `conversionType` に想定外の値が送られている | Section 4 の種別一覧に沿った値を使用する |

アラートが表示されても、すでに実装済みの場合は **テスト購入や問い合わせをダミー送信** してコンバージョンが記録されるか確認してください。

---

## 7. よくある質問

### Q1. 1回の購入で複数回 trackConversion が呼ばれた場合は？

各呼び出しがそれぞれ1件として記録されます。購入完了ページへのリロード等で重複しないよう、送信済みフラグをセッションストレージで管理することをお勧めします。

```javascript
if (!sessionStorage.getItem('cv_sent')) {
  window.r2cQueue = window.r2cQueue || [];
  window.r2cQueue.push({ type: 'conversion', conversionType: 'purchase', value: 50000 });
  sessionStorage.setItem('cv_sent', '1');
}
```

### Q2. conversionValue に何を入れればよいですか？

数値（円・ドル等の通貨単位）を想定しています。金額に換算しにくい場合（問い合わせ、会員登録など）は省略してください。省略時は `null` として記録されます。

### Q3. チャットを使っていない訪問者のコンバージョンも記録されますか？

`session_id` がない場合は `'unknown'` として記録されます。チャットとの紐づけ分析では、チャット利用セッションのみがカウントされます。

### Q4. ウィジェットを設置していないページでも trackConversion を呼べますか？

ウィジェットスクリプト（`widget.js`）を読み込んでいないページでは動作しません。完了ページにもスクリプトを追加してください（表示は不要です）。

### Q5. データはどのくらいの期間保存されますか？

コンバージョンデータは削除されるまで保持されます。管理画面の集計は最大90日前まで表示できます。

### Q6. テスト環境で計測をオフにしたい場合は？

APIキーをテスト用のものに切り替えるか、`data-api-key` を設定しないことで計測されなくなります。または、以下のように環境判定を追加してください。

```javascript
if (location.hostname !== 'localhost' && !location.hostname.includes('staging')) {
  window.r2cQueue = window.r2cQueue || [];
  window.r2cQueue.push({ type: 'conversion', conversionType: 'purchase', value: amount });
}
```

---

## 8. 実サイト実装例：中古車販売サイト（カーネーション）

中古車販売サイトを運営するパートナー向けの具体的な実装例です。

### シナリオ

- 訪問者がチャットで「この車の支払い方法を教えて」と質問
- AIが回答し、「購入問い合わせフォームから申し込めます」と案内
- 訪問者が購入問い合わせを送信して完了ページに遷移

### 実装コード（購入問い合わせ完了ページ）

```html
<!-- 購入問い合わせ完了ページ (例: /cars/contact-complete) -->

<!-- ウィジェット読み込み（非表示でもOK） -->
<script
  src="https://api.r2c.biz/widget.js"
  data-api-key="YOUR_API_KEY"
  async
></script>

<script>
  // 購入問い合わせ完了時にコンバージョンを記録
  // conversionType: 'inquiry'（問い合わせ）
  // value: 問い合わせ対象の車両価格（円）
  window.r2cQueue = window.r2cQueue || [];
  window.r2cQueue.push({
    type: 'conversion',
    conversionType: 'inquiry',
    value: 1980000  // 例: 198万円の車両の問い合わせ
  });
</script>
```

### 管理画面での確認

導入後、管理画面の「コンバージョン分析」で以下が確認できます。

- **inquiry 件数**: チャット経由の購入問い合わせ数
- **平均温度スコア**: 問い合わせ者がチャットでどれだけ関心を示していたか
- **貢献率**: 全問い合わせのうちチャット利用者が占める割合

> **補足**: 来店予約を取る場合は `conversionType: 'reservation'`、成約（決済完了）を取る場合は `conversionType: 'purchase'` に変更すると、種別ごとの集計が分かれて管理画面で比較できます。

---

## 関連リンク

- [ウィジェット導入ガイド](./WIDGET_SETUP.md)（別途参照）
- 管理画面 URL: `https://admin.r2c.biz/admin/conversion`
- サポート: 管理画面右上の「お問い合わせ」ボタン

---

*最終更新: 2026-04-19 / Phase65-2 (追補: パターンE・CVアラート・カーネーション実装例)*
