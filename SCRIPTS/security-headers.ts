/**
 * security-headers.ts — セキュリティヘッダー設定レポート・差分確認ツール
 * (Phase33 Stream D — CDN・タイムゾーン対応)
 *
 * 使い方（差分レポートを標準出力に表示）:
 *   npx ts-node SCRIPTS/security-headers.ts
 *   or
 *   pnpm tsx SCRIPTS/security-headers.ts
 *
 * 現在の src/lib/headers.ts との差分を報告し、推奨ヘッダーをまとめる。
 */

// -----------------------------------------------------------------------
// 現在の実装（src/lib/headers.ts）
// -----------------------------------------------------------------------

const CURRENT_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  // NOTE: X-Powered-By は res.removeHeader() で削除済み
};

// -----------------------------------------------------------------------
// 推奨ヘッダー（Phase33 CDN対応・グローバル展開向け）
// -----------------------------------------------------------------------

const RECOMMENDED_HEADERS: Record<string, string> = {
  // --- 既存（変更なし） ---
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",

  // --- 追加推奨 ---

  /**
   * X-XSS-Protection
   * 旧式ブラウザ（IE/Edge Legacy）向けXSSフィルター。
   * 現代ブラウザでは CSP が主体だが、後方互換として設定推奨。
   * NOTE: mode=block はブロックモード。"1" だけだとフィルタリングのみ。
   */
  "X-XSS-Protection": "1; mode=block",

  /**
   * Cross-Origin-Opener-Policy (COOP)
   * ブラウザのブラウジングコンテキストグループを分離。
   * Spectre 攻撃対策。Widget埋め込み先との分離に有効。
   */
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",

  /**
   * Cross-Origin-Resource-Policy (CORP)
   * 他オリジンからのリソース読み込みを制御。
   * API サーバの場合 "cross-origin" でWidget/CDNからのアクセスを許可。
   */
  "Cross-Origin-Resource-Policy": "cross-origin",

  /**
   * Cross-Origin-Embedder-Policy (COEP)
   * SharedArrayBuffer / performance.measureUserAgentSpecificMemory() 使用時に必要。
   * 現状は不要だが、将来的な機能追加に備えてコメントアウトで記録。
   * "require-corp" を有効にすると既存の埋め込みが壊れる可能性あり。
   */
  // "Cross-Origin-Embedder-Policy": "require-corp",

  /**
   * X-DNS-Prefetch-Control
   * DNS プリフェッチを無効化（情報漏洩リスク軽減）。
   * API サーバでは不要なため off。
   */
  "X-DNS-Prefetch-Control": "off",
};

// -----------------------------------------------------------------------
// 差分レポート
// -----------------------------------------------------------------------

interface DiffResult {
  added: Record<string, string>;
  removed: string[];
  changed: Record<string, { current: string; recommended: string }>;
  unchanged: string[];
}

function diffHeaders(
  current: Record<string, string>,
  recommended: Record<string, string>
): DiffResult {
  const result: DiffResult = {
    added: {},
    removed: [],
    changed: {},
    unchanged: [],
  };

  // 追加・変更チェック
  for (const [header, value] of Object.entries(recommended)) {
    if (!(header in current)) {
      result.added[header] = value;
    } else if (current[header] !== value) {
      result.changed[header] = { current: current[header], recommended: value };
    } else {
      result.unchanged.push(header);
    }
  }

  // 削除チェック（現在あるが推奨にないもの）
  for (const header of Object.keys(current)) {
    if (!(header in recommended)) {
      result.removed.push(header);
    }
  }

  return result;
}

function printReport(): void {
  const diff = diffHeaders(CURRENT_HEADERS, RECOMMENDED_HEADERS);

  console.log("=".repeat(60));
  console.log("セキュリティヘッダー差分レポート (Phase33 Stream D)");
  console.log("=".repeat(60));
  console.log(`対象: src/lib/headers.ts`);
  console.log(`日時: ${new Date().toISOString()}`);
  console.log("");

  // --- 追加推奨 ---
  const addedKeys = Object.keys(diff.added);
  if (addedKeys.length > 0) {
    console.log("【追加推奨】以下のヘッダーが未設定です:");
    for (const [header, value] of Object.entries(diff.added)) {
      console.log(`  + ${header}: ${value}`);
    }
    console.log("");
  } else {
    console.log("【追加推奨】なし");
    console.log("");
  }

  // --- 値の変更推奨 ---
  const changedKeys = Object.keys(diff.changed);
  if (changedKeys.length > 0) {
    console.log("【変更推奨】以下のヘッダーの値が異なります:");
    for (const [header, { current, recommended }] of Object.entries(diff.changed)) {
      console.log(`  ~ ${header}`);
      console.log(`      現在:    ${current}`);
      console.log(`      推奨:    ${recommended}`);
    }
    console.log("");
  } else {
    console.log("【変更推奨】なし");
    console.log("");
  }

  // --- 削除検討 ---
  if (diff.removed.length > 0) {
    console.log("【削除検討】推奨リストにないヘッダー:");
    for (const header of diff.removed) {
      console.log(`  - ${header}: ${CURRENT_HEADERS[header]}`);
    }
    console.log("");
  }

  // --- 設定済み ---
  console.log(`【設定済み】${diff.unchanged.length}件のヘッダーが推奨通りに設定されています:`);
  for (const header of diff.unchanged) {
    console.log(`  ✓ ${header}`);
  }
  console.log("");

  // --- widget.js 向け Cache-Control ---
  console.log("=".repeat(60));
  console.log("widget.js 配信用 Cache-Control 設定（Nginx/Cloudflare向け）");
  console.log("=".repeat(60));
  console.log("");
  console.log("現在の API サーバ: Cache-Control: no-store（全エンドポイント共通）");
  console.log("");
  console.log("widget.js 配信用に以下のパス別設定を推奨:");
  console.log("");
  console.log("  /widget.v*.min.js    → public, max-age=31536000, immutable");
  console.log("  /widget.js           → public, max-age=3600, stale-while-revalidate=300");
  console.log("  /api/*, /dialog/*    → no-store, no-cache (現行維持)");
  console.log("");
  console.log("※ Nginx の location ブロック、または Cloudflare Cache Rules で設定してください。");
  console.log("※ 詳細は docs/CDN_SETUP.md を参照。");
  console.log("");

  // --- サマリー ---
  console.log("=".repeat(60));
  const totalIssues = addedKeys.length + changedKeys.length;
  if (totalIssues === 0) {
    console.log("✅ すべての推奨ヘッダーが正しく設定されています。");
  } else {
    console.log(`⚠️  ${totalIssues}件の改善項目があります。`);
    console.log("   統合役が src/lib/headers.ts に追加してください。");
  }
  console.log("=".repeat(60));
}

// スクリプトとして直接実行された場合のみレポートを表示
// (モジュールとして import された場合は実行しない)
printReport();

export { CURRENT_HEADERS, RECOMMENDED_HEADERS, diffHeaders };
