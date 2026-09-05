// shopify-app/app/src/main.tsx
//
// エントリポイント。App Bridge の初期化は index.html のスクリプトタグ + meta タグ
// (shopify-api-key)側で行うため、ここでは通常の React マウントのみを行う。

import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

createRoot(container).render(<App />);
