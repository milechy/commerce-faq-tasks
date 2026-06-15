# SalesFlow × 商品カード同期表示 — LiveKit Data Tracks 設計

Asana GID: 1215698617354635

## 概要

SalesFlow の `recommend` ステージで商品カードをアバター発話開始と同期して表示する機能の設計。

現行の REST ベース実装（Phase73 PR-1/2 #404/#405）では、商品カードが HTTP レスポンス到着直後にウィジェットへ表示される。これはアバターが発話を始める 500ms〜1s 前であり、「商品カードが先に現れてアバターが遅れて喋る」ズレが生じる。

LiveKit Data Tracks を使うことで、**アバターが発話を開始した瞬間に商品カードを表示**でき、アバターの紹介と視覚表示のタイミングが一致して CV 向上が期待できる。

---

## 現行フロー（REST のみ）

```
Widget  ──POST /api/chat──▶  API Server
  ◀── { content, productCard, flowState } ──

Widget:
  1. チャットバブル描画（content）
  2. productCard があれば即時カード描画  ← ここがアバター発話より早い
  3. avatarProvider=lemonslice なら:
       publishData({ type:"tts_request", text })
       publishData({ type:"state_change", state })
  4. アバターが TTS 開始（~500ms 後）
```

**問題**: 2 と 4 のタイミングがズレる。

---

## 提案フロー（LiveKit Data Tracks 同期）

```
Widget  ──POST /api/chat──▶  API Server
  ◀── { content, productCard, flowState } ──

Widget:
  1. チャットバブル描画（content）
  2. productCard は保持するが即時描画しない
  3. publishData({ type:"tts_request", text, productCard })   ← productCard を同乗
  4. publishData({ type:"state_change", state:"recommend" })

Avatar Agent (agent.py):
  5. on_data_received: tts_request を受信
     → _pending_product_card = productCard を保存
     → session.say(prefix + text)  ← TTS 開始
     → TTS 開始直後に publishData({ type:"product_card", productCard }) ← Widget へ返送

Widget:
  6. DataReceived: product_card イベント受信
     → 商品カードを描画  ← アバター発話開始と同期
```

**効果**: 商品カードはアバターが喋り始めた瞬間に表示される。

---

## Data Channel メッセージプロトコル

### 既存メッセージ（変更なし）

| 方向 | type | 概要 |
|---|---|---|
| Widget → Agent | `tts_request` | TTS テキスト送信 |
| Widget → Agent | `state_change` | SalesFlow ステート通知 |
| Widget → Agent | `thinking_start` | フィラー発話トリガー |
| Widget → Agent | `widget_connected` | 接続完了通知 |
| Widget → Agent | `chat` | フォールバック LLM 呼び出し |
| Agent → Widget | `agent_reply` | TTS テキスト（ミュート時チャット表示用） |

### 変更: `tts_request` に `productCard` フィールドを追加

```json
{
  "type": "tts_request",
  "text": "こちらのプロダクトがおすすめです。",
  "productCard": {
    "product_id": "prod_123",
    "name": "商品名",
    "price": "¥9,800",
    "image_url": "https://example.com/img.jpg",
    "cta_url": "https://example.com/product/123"
  }
}
```

`productCard` は省略可（undefined の場合はアバターが返送しない）。

### 新規: `product_card`（Agent → Widget）

```json
{
  "type": "product_card",
  "productCard": {
    "product_id": "prod_123",
    "name": "商品名",
    "price": "¥9,800",
    "image_url": "https://example.com/img.jpg",
    "cta_url": "https://example.com/product/123"
  }
}
```

アバターが TTS 開始直後に Widget へ送信する。

---

## 実装変更ファイル

| ファイル | 変更概要 |
|---|---|
| `public/widget.js` | `sendTTSRequest()` に `productCard` を同乗。`DataReceived` ハンドラに `product_card` ブランチを追加。REST レスポンスでの即時描画を削除（アバターあり時のみ遅延）。 |
| `avatar-agent/agent.py` | `on_data_received` の `tts_request` ブランチで `productCard` を取得して保存。`handle_tts_request()` の `session.say()` 直後に `publish_data` で返送。 |

---

## widget.js 変更詳細

### 1. `sendTTSRequest()` に productCard を同乗させる

```js
// 現在
function sendTTSRequest(text) {
  var payload = encoder.encode(JSON.stringify({ type: 'tts_request', text: ttsText }));
  room.localParticipant.publishData(payload, { reliable: true });
}

// 変更後
function sendTTSRequest(text, productCard) {
  var msg = { type: 'tts_request', text: ttsText };
  if (productCard) msg.productCard = productCard;
  var payload = encoder.encode(JSON.stringify(msg));
  room.localParticipant.publishData(payload, { reliable: true });
}
```

### 2. REST レスポンスハンドラで productCard を取得して渡す

```js
// .then(function(json) { ... }) 内
var productCard = (json.data && json.data.productCard) ? json.data.productCard : undefined;

if (avatarProvider === 'lemonslice' && lkRoom && lkRoom.localParticipant) {
  sendTTSRequest(assistantContent, productCard);  // productCard を引数追加
  // ...state_change は変更なし
}

// avatarなし時のみ即時描画
if (productCard && !(avatarProvider === 'lemonslice' && lkRoom && lkRoom.localParticipant)) {
  assistantMsg.productCard = sanitizeProductCard(productCard);
}
```

### 3. `DataReceived` ハンドラに `product_card` ブランチを追加

```js
room.on(LK.RoomEvent.DataReceived, function (data) {
  try {
    var msg = JSON.parse(new TextDecoder().decode(data));
    if (msg.type === 'agent_reply' && msg.text) {
      // 既存: チャットバブル表示
    } else if (msg.type === 'product_card' && msg.productCard) {
      // 新規: アバター発話タイミングで商品カードを表示
      var lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.productCard = sanitizeProductCard(msg.productCard);
        renderMessages();
        scrollToBottom(true);
      }
    }
  } catch (_e) {}
});
```

### 4. `sanitizeProductCard()` — URL 検証ヘルパー

```js
function sanitizeProductCard(card) {
  return {
    product_id: String(card.product_id || ''),
    name: String(card.name || ''),
    price: String(card.price || ''),
    image_url: safeHttpUrl(card.image_url),
    cta_url: safeHttpUrl(card.cta_url),
  };
}
```

`safeHttpUrl()` は Phase73 PR-2 で追加済みの `javascript:` スキーム拒否ヘルパー。

---

## avatar-agent/agent.py 変更詳細

```python
# on_data_received 内の tts_request ブランチ

elif msg_type == "tts_request":
    text = msg.get("text", "").strip()
    # Phase73: 商品カードを保存（TTS 開始直後に返送する）
    _pending_product_card["card"] = msg.get("productCard")
    if text:
        logger.info(f"[data_channel] tts_request received: {text[:80]}")
        asyncio.create_task(handle_tts_request(text))
```

```python
# handle_tts_request 末尾

async def handle_tts_request(reply_text: str) -> None:
    try:
        prefix = sales_flow_emotion_prefix(_sales_state["current"])
        logger.info(f"[tts_request] TTS直渡し state={_sales_state['current']!r} ...")
        session.say(prefix + reply_text)

        # Phase73: TTS 開始直後に商品カードを Widget へ返送
        card = _pending_product_card.pop("card", None)
        if card and ctx.room.local_participant:
            payload = json.dumps({"type": "product_card", "productCard": card}).encode()
            await ctx.room.local_participant.publish_data(payload, reliable=True)
            logger.info(f"[data_channel] product_card sent: product_id={card.get('product_id')}")
    except Exception as e:
        logger.error(f"[handle_tts_request] error: {e}")
```

`_pending_product_card` は `_sales_state` と同じパターンのクロージャ辞書:

```python
_pending_product_card = {"card": None}  # entrypoint 内で初期化
```

---

## フォールバック動作

| 条件 | 動作 |
|---|---|
| アバター未接続（テキストチャットのみ） | REST レスポンスの `productCard` を即時描画（既存 Phase73 の動作） |
| `tts_request` に `productCard` なし | agent は `product_card` を返送しない（カード表示なし） |
| `product_card` イベントが届かない（ネットワーク遅延/ロスト） | カード未表示のままになる（ユーザーは再質問で再試行可能） |
| `image_url` が `javascript:` スキーム | `safeHttpUrl()` が `''` を返す → img タグは省略 |

---

## セキュリティ上の注意

- agent.py が Widget から受け取った `productCard` をそのまま返送するため、**Widget 側でも再度 `safeHttpUrl()` で URL を検証する**（信頼境界: LiveKit Room は authenticated 参加者のみだが、Data Channel ペイロードは検証する）
- `product_id` / `name` / `price` は `textContent` 経由で DOM に設定（XSS なし）
- `cta_url` は `window.open()` に渡す前に `safeHttpUrl()` で検証済み

---

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `src/api/chat/route.ts` | `productCard` を REST レスポンスに含める（Phase73 実装済み） |
| `src/agent/dialog/dialogAgent.ts` | `recommend` ステージで `faq_docs` から `productCard` を取得（Phase73 実装済み） |
| `src/types/contracts.ts` | `ProductCard` 型定義（Phase73 実装済み） |
| `src/api/avatar/livekitTokenRoutes.ts` | JWT で `canPublishData: true` を付与済み |
| `avatar-agent/agent.py` | Data Channel ハンドラ（変更対象） |
| `public/widget.js` | チャット送受信 + LiveKit DataReceived（変更対象） |
| `docs/SALESFLOW_DESIGN.md` | SalesFlow ステートマシン設計（Phase15-16） |
| `docs/AVATAR_SALESFLOW_EMOTION_TAGS.md` | 感情タグ連動設計（PR #406） |
