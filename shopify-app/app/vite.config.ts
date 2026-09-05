import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// R2C Shopify 埋め込み管理画面(shopify-app/app/)専用の Vite 設定。
// admin-ui/vite.config.ts / root の設定とは完全に独立している
// (docs/SHOPIFY_APP_REQUIREMENTS.md §3.2: shopify-app/ は独立ビルド・独立デプロイ)。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
});
