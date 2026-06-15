# LemonSlice PiP 常時アバター表示 — 設計ドキュメント

Asana GID: 1215698769951562

## 概要

チャットパネルを閉じてもアバター（LiveKit Room）を接続維持し、FAB（フローティングボタン）上にアバター映像を継続表示する「PiP（Picture-in-Picture）常駐」機能の設計。

現行は `closePanel()` 内で Room を切断するため、パネルを再開するたびに新規接続が発生する。接続を維持することで **再開時の接続待ち（1〜3 秒）を排除**し、アバターとの対話継続性を高める。

---

## 現行フロー（closePanel = disconnect）

```
openPanel()
  └─ connectLiveKit()
       ├─ 既存 Room が connected → 再利用（reuse-guard）
       └─ 新規 Room 作成 → token 取得 → 接続（~1-3s）

closePanel()
  ├─ avatarArea 非表示、panel close アニメーション
  ├─ fabVideoEl を FAB へ移動（アバター映像を FAB で見せる）
  └─ window.__rajiuceRoom.disconnect()  ← Room 切断（PR#397 で追加）
       └─ "次回開閉時に新規接続で安定化" コメント
```

**問題**: パネルを閉じるたびに切断→再開時に再接続ラグが発生する。

---

## 提案フロー（closePanel = Room 維持）

```
openPanel()
  └─ connectLiveKit()
       └─ 既存 Room が connected → 即座に再利用 ← 接続ラグ 0

closePanel()
  ├─ avatarArea 非表示、panel close アニメーション
  ├─ fabVideoEl を FAB へ移動（アバター映像を FAB で継続表示）
  └─ (disconnect しない — Room を保持)

cleanupLiveKit()  ← 明示的終了用（変更なし）
  ├─ beforeunload（ページ離脱）→ disconnect
  └─ FaqWidget.destroy()（SPA 再注入前）→ disconnect
```

**効果**: パネルを閉じても FAB でアバター映像が見え続け、再開時は即座に会話を再開できる。

---

## 実装変更（widget.js のみ）

### 変更対象: `closePanel()` L2073-2077

```js
// 現在 (PR#397 で追加)
// LiveKit Room を切断（次回開閉時に新規接続で安定化）
if (window.__rajiuceRoom) {
  try { window.__rajiuceRoom.disconnect(); } catch (_e) {}
  window.__rajiuceRoom = null;
}

// 変更後: このブロックを削除する（Room を保持）
```

**変更はこの 5 行の削除のみ**。他の安全網は現行コードに既存。

---

## 既存の安全網（3 層）

| 層 | 場所 | 役割 |
|---|---|---|
| L1 | `connectLiveKit()` L1582–1590 (reuse-guard) | 既接続 Room を再利用。disconnected/error 状態のみ再作成 |
| L2 | `beforeunload` L2533 → `cleanupLiveKit()` | ページ離脱時に Room を切断 |
| L3 | `FaqWidget.destroy()` L2549 → `cleanupLiveKit()` | SPA 再注入前に明示的に切断（管理画面テストチャット用） |

`cleanupLiveKit()` コメントに「通常の closePanel() では呼ばない — Room は切断せず保持する」と既に記載されており、アーキテクチャとしては PiP を前提にしている。

---

## リスクと衝突点（PR#397 との関係）

### 衝突の構造

PR#397「LiveKit接続リーク修正」で追加した `closePanel()` 内 disconnect は、SPA が widget を再注入するとき `beforeunload` が発火しないために Room が残留し 429 を誘発する問題への対処だった。

```
SPA 再注入（管理画面など）:
  widget 削除 → widget 再挿入
  ↑ beforeunload は発火しない
  → __rajiuceRoom が残留し再接続タイマーが増殖
  → /rtc/validate が 429
```

PR#397 は `closePanel()` での disconnect を「保険」として導入したが、本来の対処は `FaqWidget.destroy()` を SPA 再注入前に呼ぶことである（`destroy()` のコメント参照）。

### PiP 実装後の前提条件

| 条件 | 詳細 |
|---|---|
| SPA 再注入前に `FaqWidget.destroy()` を呼ぶ | 管理画面の TestChat コンポーネントが `useEffect` cleanup で呼んでいること（要確認） |
| E2E: widget 再注入で Room が増殖しないこと | `window.__rajiuceRoom` が 1 つ以下であること |
| E2E: 複数タブで Room が増殖しないこと | タブ間では `window.__rajiuceRoom` は共有されない（同一 window スコープのみ） |

### 429 再発リスク

429（`/rtc/validate` レート制限）は **実 LiveKit Cloud の接続上限下でしか再現しない**。ローカル/エミュ環境では no-regression を確認できないため、ローカルテストだけでは不十分。

**→ デプロイ後の実機接続数モニタリングを gate にする（詳細は下記）。**

---

## Gate 条件（実装開始前に人間が承認）

### 実装前 Gate（Human GO 必須）

- [ ] 管理画面の TestChat コンポーネントが `useEffect` cleanup 内で `FaqWidget.destroy()` を呼んでいることを確認（grep で実機照合）
- [ ] `destroy()` が呼ばれるパスを E2E テストで検証する方針を合意する

### 実装後 Gate（デプロイ前）

- [ ] `pnpm verify` 通過（typecheck / lint / test）
- [ ] Playwright: パネル開閉 × 3 回 → `window.__rajiuceRoom` が 1 つだけ存在することを確認
- [ ] Playwright: widget 再注入シミュレーション（`FaqWidget.destroy()` → 再挿入）→ Room が 0 になることを確認

### デプロイ後 Gate（5 軸監視）

1. **LiveKit Room 数**: `/rtc/validate` の 429 レート が baseline（PiP 前）比で増加しないこと（Grafana: `livekit_room_count` / `rtc_validate_4xx_total`）
2. **接続リーク**: Room が閉じられないまま蓄積しないこと（デプロイ後 1h 観察）
3. **ページ再訪問**: FAB アバター映像が維持されて表示されること
4. **パネル再開**: 開閉を 5 回繰り返してラグなし・映像維持を確認
5. **SPA 再注入**: 管理画面テストチャットで destroy() → 再注入 → 新規接続 1 本のみを確認

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `public/widget.js` | 変更対象（closePanel L2073-2077 のみ） |
| `public/widget.js` L1578–1590 | connectLiveKit reuse-guard（変更なし） |
| `public/widget.js` L1873–1892 | cleanupLiveKit（変更なし） |
| `public/widget.js` L2533 | beforeunload → cleanupLiveKit（変更なし） |
| `public/widget.js` L2539–2550 | FaqWidget.destroy()（変更なし） |
| `admin-ui/src/` | TestChat コンポーネント（destroy() 呼び出し確認要） |
| `docs/ARCHITECTURE.md` | アバター接続ライフサイクル概要 |

---

## 実装ステータス

| 状態 | 内容 |
|---|---|
| **設計完了** | 本ドキュメント |
| **実装待ち** | Human GO 確認後（closePanel L2073-2077 削除） |
| **E2E 待ち** | Playwright 再注入テスト追加 |
| **デプロイ待ち** | Human GO + 5 軸監視準備後 |
