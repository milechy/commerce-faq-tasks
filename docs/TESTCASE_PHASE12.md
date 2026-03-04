

# Test Cases — Phase12 完了検証

## 1. shipping

### clarify
```
配送について教えてください
→ Clarify（product / region）
```

### fast-path
```
ノートPCを東京に届けたいです
→ 送料ポリシー回答
```

---

## 2. returns

### clarify
```
返品したいのですがどうすれば？
→ orderId / item / reason Clarify
```

### fast-path
```
注文番号1234のイヤホンを返品したいです。理由は〜
→ 返品手順の説明
```

---

## 3. product-info

### clarify
```
サイズ感を知りたい
→ Clarify（product）
```

### fast-path
```
ABC123のTシャツのサイズ感を教えて
→ fallback回答
```

---

## 4. general

### simple（fast-path）
```
支払い方法を教えてください
```

### complex（LLM Planner）
```
セール中に一番お得に買う方法は？
```

---

## 5. p95 計測
```
node dist/SCRIPTS/analyze-agent-logs.js logs/app.log
```

---
