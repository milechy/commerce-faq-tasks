# 手話（JSL）対応調査

**作成日:** 2026-04-06
**ステータス:** 調査のみ（実装は 2028 年以降）
**短期代替案:** Widget.js の WAI-ARIA 対応（キーボードナビゲーション、スクリーンリーダー対応）

---

## 1. 調査対象リソース

### 1.1 SignrrGPT

- **概要:** 双方向手話翻訳 AI。音声/テキスト ↔ 手話映像の相互変換
- **技術:** MediaPipe Holistic でハンドランドマーク検出 + Transformer ベースの翻訳
- **精度:** JSL（日本手話）の精度は ASL（アメリカ手話）より低い（学習データ不足）
- **API:** REST API（クラウドホスト）/ ローカルモデル両方あり
- **ライセンス:** 商用ライセンスの確認が必要

### 1.2 ub-MOJI（日本手話データセット）

- **概要:** 東京大学が公開した日本手話（JSL）の映像データセット
- **規模:** 約 10,000 単語 / フレーズの手話映像
- **用途:** JSL 認識モデルのトレーニング
- **取得方法:** 研究用途のみ、商用利用には別途契約が必要

### 1.3 Learn-JSL

- **概要:** 日本手話学習アプリの OSS 実装
- **技術スタック:** React Native + MediaPipe
- **GitHub:** [Learn-JSL](https://github.com/example/learn-jsl)
- **参考点:** 手話認識のリアルタイム処理のアーキテクチャ参考

### 1.4 JSL_App_Webapp

- **概要:** ブラウザベースの手話認識 Web アプリ
- **技術:** TensorFlow.js + カメラアクセス
- **処理速度:** 約 15-30fps での手話認識
- **認識精度:** 限定語彙（200-500 語）で 80-90%、自由会話で 40-60%

---

## 2. R2C への統合可能性

### 2.1 入力パス（手話 → チャット API）

```
カメラ映像 → MediaPipe Holistic（ランドマーク抽出）
  → JSL 認識モデル（手話 → テキスト）
  → テキスト → POST /dialog/turn（既存 API）
  → AI 応答 → テキスト表示 / 読み上げ
```

**実装箇所:** `public/widget.js` に「手話モード」トグル追加

```javascript
// widget.js の手話モード（将来実装イメージ）
class SignLanguageInput {
  constructor(videoElement) {
    this.holistic = new Holistic({ locateFile: ... });
    this.model = await tf.loadLayersModel('/models/jsl-recognition/model.json');
  }

  async start() {
    const camera = new Camera(this.videoElement, {
      onFrame: async () => {
        await this.holistic.send({ image: this.videoElement });
      },
    });
    camera.start();
  }

  onResults(results) {
    const landmarks = this.extractLandmarks(results);
    const gesture = this.model.predict(landmarks);
    const text = this.gestureToText(gesture);
    if (text && this.confidence > 0.85) {
      this.onTextDetected(text);
    }
  }
}
```

### 2.2 出力パス（チャット応答 → 手話アバター）

```
AI 応答テキスト → 手話翻訳 API → 手話ジェスチャーシーケンス
  → Lemonslice/LiveKit アバターに送信（要: ジェスチャー再生機能）
  → アバターが手話でレスポンスを表現
```

**課題:** Lemonslice の現状アバターは口パク（リップシンク）のみ。手話ジェスチャー（腕・手の動き）のアニメーションは未対応。

---

## 3. 技術的課題

### 3.1 リアルタイム手話認識の精度

| 語彙数 | 認識精度（SOTAモデル） | 備考 |
|---|---|---|
| 200語以内（定型文） | 85-95% | 問い合わせ対応に使えるレベル |
| 500語 | 70-85% | 誤認識が体験を損なう可能性 |
| 自由会話 | 40-60% | 現状では実用困難 |

**チャット用途への影響:** 問い合わせでよく使われる定型フレーズ（挨拶、価格確認、予約方法など）に限定すれば精度は確保できる。

### 3.2 手話認識のレイテンシ

| 処理ステップ | 処理時間 |
|---|---|
| MediaPipe Holistic（ランドマーク抽出） | 20-50ms |
| JSL 認識モデル推論 | 30-100ms |
| テキスト → チャット API 送信 | 100-300ms |
| **合計** | **150-450ms** |

一般的なテキスト入力の応答時間（キー入力後 1-2 秒）と比較して許容範囲内。

### 3.3 アバターの手話表現

**Lemonslice の現状:**
- 音声から口パク同期（リップシンク）: 対応済み
- 顔の表情: 限定対応
- 手話ジェスチャー: **未対応**

**解決策候補:**
- A: 3D アバターを Three.js/Babylon.js で自前実装（コスト大）
- B: 手話特化のアバター API を別途調達（例: Hand Talk、SignAll）
- C: テキスト + 字幕 + 音声読み上げで代替（手話アバターは保留）

---

## 4. アクセシビリティ価値

### 4.1 市場規模

- 日本の聴覚障害者: 約 **34 万人**（身体障害者手帳所持者 2023 年時点）
- 難聴者（補聴器利用者含む）: 約 1,200 万人
- 先天性聴覚障害のうち JSL が母語の人口: 約 5-7 万人

### 4.2 ブランディング効果

- 全業種対応の R2C が手話対応すれば、医療・教育・行政分野での差別化要因
- WAI-ARIA 対応 + 手話 = アクセシビリティ先進企業としてのブランド確立
- 障害者差別解消法（2024 年改正）への対応として訴求可能

### 4.3 BtoB 営業面

- 官公庁・自治体テナントへの訴求材料（バリアフリー要件）
- 医療機関テナント（聴覚障害者の医療アクセス改善）

---

## 5. 評価結論

**実装は 2028 年以降。まず WAI-ARIA 対応を優先。**

### 優先度判断

| 施策 | 優先度 | 理由 |
|---|---|---|
| WAI-ARIA + キーボードナビゲーション | **P1** | コスト低、恩恵大（全障害者に有効） |
| スクリーンリーダー対応（NVDA/VoiceOver） | **P1** | 視覚障害者への対応、Widget.js の aria-label 付与 |
| 手話認識（入力） | P3 | 精度・コスト・対象者数の費用対効果 |
| 手話アバター（出力） | P4 | 技術的ハードル高（アバター側の対応が必要） |

### 短期アクション（WAI-ARIA 対応）

```html
<!-- widget.js のアクセシビリティ改善（短期実装） -->
<button
  aria-label="チャットを開始"
  aria-expanded="false"
  role="button"
  tabindex="0"
  onkeydown="if(event.key==='Enter'||event.key===' ')this.click()"
>
  💬
</button>

<div
  role="dialog"
  aria-label="AIチャット"
  aria-live="polite"
  aria-atomic="false"
>
  <!-- チャットメッセージ -->
</div>
```

### 中長期ロードマップ

| 時期 | マイルストーン |
|---|---|
| 2026 Q3 | Widget.js WAI-ARIA 対応（P1） |
| 2026 Q4 | スクリーンリーダー対応テスト（NVDA / VoiceOver） |
| 2027 H2 | PoC: 定型フレーズ（50語）の JSL 認識デモ |
| 2028 | テナント要望・技術成熟度次第で本実装判断 |

---

## 6. 参考リンク

- [MediaPipe Holistic](https://developers.google.com/mediapipe/solutions/vision/holistic_landmarker) — ハンドランドマーク検出
- [TensorFlow.js Hand Pose](https://github.com/tensorflow/tfjs-models/tree/master/handpose) — ブラウザ手話認識
- [Hand Talk API](https://handtalk.me) — ブラジル手話 → アバター変換（商用 API、JSL 未対応）
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) — アクセシビリティ実装ガイド
- [JIS X 8341-3](https://www.jisc.go.jp/) — 日本のウェブアクセシビリティ規格

---

*関連ドキュメント: PHASE_ROADMAP.md / R2C_STRATEGIC_VISION.md*
