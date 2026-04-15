/**
 * FAQ Chat Widget — 1行埋め込みスクリプト
 *
 * 使い方:
 *   <script src="/widget.js" data-tenant="YOUR_TENANT_ID" async></script>
 *
 * セキュリティ:
 *   - innerHTML 禁止 → textContent / createElement のみ使用
 *   - tenantId は data-tenant 属性から取得（body から禁止）
 *   - postMessage 受信時は event.origin を検証
 *   - Shadow DOM で CSS を外部サイトから隔離
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. 初期化 — data 属性から tenantId を取得                            */
  /* ------------------------------------------------------------------ */

  var currentScript = document.currentScript;

  // tenantId は data-tenant 属性から取得（CLAUDE.md Anti-Slop: body から禁止）
  var tenantId = currentScript ? currentScript.getAttribute('data-tenant') : '';
  var apiKey = currentScript ? currentScript.getAttribute('data-api-key') : '';

  if (!tenantId) {
    console.warn('[FAQ Widget] data-tenant 属性が必要です。例: data-tenant="your-tenant-id"');
    return;
  }

  // スクリプトの src からウィジェットの API オリジンを決定
  var scriptSrc = currentScript ? currentScript.getAttribute('src') : '';
  var widgetOrigin = window.location.origin;
  if (scriptSrc) {
    try {
      widgetOrigin = new URL(scriptSrc, window.location.href).origin;
    } catch (_e) {
      widgetOrigin = window.location.origin;
    }
  }
  var apiBase = widgetOrigin;

  // 許可するホストオリジン（デフォルト: スクリプトが動作している現在のオリジン）
  // data-allowed-origins で追加可能: "https://a.com,https://b.com"
  var rawAllowed = currentScript ? currentScript.getAttribute('data-allowed-origins') : '';
  var allowedOrigins = rawAllowed
    ? rawAllowed.split(',').map(function (s) { return s.trim(); })
    : [window.location.origin];

  /* ------------------------------------------------------------------ */
  /* 2. prefers-reduced-motion 検出                                       */
  /* ------------------------------------------------------------------ */

  var prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ */
  /* 3. Shadow DOM コンテナを生成                                         */
  /* ------------------------------------------------------------------ */

  var host = document.createElement('div');
  host.setAttribute('id', 'faq-chat-widget-host');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'FAQチャットウィジェット');
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: 'open' });

  /* ------------------------------------------------------------------ */
  /* 4. CSS を Shadow DOM に注入（textContent 使用、innerHTML 禁止）      */
  /* ------------------------------------------------------------------ */

  var styleEl = document.createElement('style');
  styleEl.textContent = [
    ':host { all: initial; font-family: system-ui, -apple-system, sans-serif; }',
    '*,*::before,*::after { box-sizing: border-box; }',

    /* FABボタン */
    '.fab {',
    '  position: fixed;',
    '  bottom: 24px;',
    '  right: 24px;',
    '  z-index: 2147483647;',
    '  min-width: 64px;',
    '  min-height: 64px;',
    '  width: 64px;',
    '  height: 64px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background-color: #2563eb;',
    '  color: #fff;',
    '  cursor: pointer;',
    '  box-shadow: 0 4px 16px rgba(37,99,235,0.4);',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: 0;',
    '  overflow: hidden;',
    '  transition: ' + (prefersReducedMotion ? 'none' : 'transform 0.15s, box-shadow 0.15s') + ';',
    '}',
    '.fab:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(37,99,235,0.5); }',
    '.fab:active { transform: scale(0.95); }',
    '.fab:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }',
    /* FABアバター接続中ローディング状態 */
    '.fab.avatar-loading {',
    '  background: #94a3b8;',
    '  animation: fab-pulse 1.5s ease-in-out infinite;',
    '  pointer-events: auto;',
    '}',
    '.fab.avatar-loading::after {',
    '  content: "";',
    '  display: block;',
    '  width: 24px;',
    '  height: 24px;',
    '  border: 3px solid rgba(255,255,255,0.4);',
    '  border-top-color: #fff;',
    '  border-radius: 50%;',
    '  animation: fab-spin 0.8s linear infinite;',
    '}',
    '@keyframes fab-pulse {',
    '  0%, 100% { opacity: 0.7; }',
    '  50% { opacity: 1; }',
    '}',
    '@keyframes fab-spin {',
    '  to { transform: rotate(360deg); }',
    '}',
    /* FABアバターメディアコンテナ */
    '.fab-media-container {',
    '  position: absolute;',
    '  top: 0; left: 0;',
    '  width: 100%;',
    '  height: 100%;',
    '  border-radius: 50%;',
    '  overflow: hidden;',
    '  pointer-events: none;',
    '}',
    '.fab-media-container img,',
    '.fab-media-container video {',
    '  width: 100%;',
    '  height: 100%;',
    '  object-fit: cover;',
    '}',

    /* チャットパネル */
    '.panel {',
    '  position: fixed;',
    '  bottom: 92px;',
    '  right: 24px;',
    '  z-index: 2147483646;',
    '  width: min(390px, calc(100vw - 32px));',
    '  height: min(560px, calc(100vh - 120px));',
    '  background: #fff;',
    '  border-radius: 16px;',
    '  box-shadow: 0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);',
    '  display: flex;',
    '  flex-direction: column;',
    '  overflow: hidden;',
    '  opacity: 0;',
    '  transform: scale(0.9) translateY(16px);',
    '  transform-origin: bottom right;',
    '  transition: ' + (prefersReducedMotion ? 'none' : 'opacity 0.2s, transform 0.2s') + ';',
    '  pointer-events: none;',
    '}',
    '.panel.open {',
    '  opacity: 1;',
    '  transform: scale(1) translateY(0);',
    '  pointer-events: auto;',
    '}',

    /* ヘッダ */
    '.header {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  padding: 16px 20px;',
    '  background-color: #2563eb;',
    '  color: #fff;',
    '  flex-shrink: 0;',
    '}',
    '.header-title { font-size: 16px; font-weight: 600; margin: 0; }',
    '.header-meta { font-size: 12px; opacity: 0.8; margin: 2px 0 0; }',
    '.close-btn {',
    '  min-width: 44px;',
    '  min-height: 44px;',
    '  width: 44px;',
    '  height: 44px;',
    '  border: none;',
    '  background: rgba(255,255,255,0.2);',
    '  border-radius: 50%;',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: 0;',
    '  flex-shrink: 0;',
    '}',
    '.close-btn:hover { background: rgba(255,255,255,0.3); }',
    '.close-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',

    /* メッセージエリア */
    '.messages {',
    '  flex: 1;',
    '  overflow-y: auto;',
    '  padding: 12px 16px;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 12px;',
    '}',
    '.msg-wrapper { display: flex; }',
    '.msg-wrapper.user { justify-content: flex-end; }',
    '.msg-wrapper.assistant { justify-content: flex-start; }',
    '.bubble {',
    '  max-width: 80%;',
    '  padding: 10px 14px;',
    '  font-size: 16px;',
    '  line-height: 1.5;',
    '  word-break: break-word;',
    '  white-space: pre-wrap;',
    '}',
    '.bubble.user {',
    '  background-color: #2563eb;',
    '  color: #fff;',
    '  border-radius: 18px 18px 4px 18px;',
    '}',
    '.bubble.assistant {',
    '  background-color: #f1f5f9;',
    '  color: #1e293b;',
    '  border-radius: 18px 18px 18px 4px;',
    '}',
    '.actions {',
    '  display: flex;',
    '  flex-wrap: wrap;',
    '  gap: 8px;',
    '  margin-top: 8px;',
    '}',
    '.action-btn {',
    '  min-height: 44px;',
    '  border: none;',
    '  border-radius: 10px;',
    '  background: #2563eb;',
    '  color: #fff;',
    '  padding: 10px 14px;',
    '  font-size: 16px;',
    '  line-height: 1.2;',
    '  cursor: pointer;',
    '}',
    '.action-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',
    '.action-btn:hover { background: #1d4ed8; }',
    '.ts { font-size: 11px; color: #94a3b8; margin-top: 4px; text-align: center; }',
    '.empty-state {',
    '  flex: 1;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  color: #94a3b8;',
    '  font-size: 16px;',
    '  padding: 32px 16px;',
    '  text-align: center;',
    '}',

    /* ローディングドット */
    '.loading-dots { display: flex; gap: 4px; align-items: center; padding: 10px 14px; background: #f1f5f9; border-radius: 18px 18px 18px 4px; }',
    '.dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }',
    '@keyframes bounce { 0%,80%,100%{transform:scale(0);opacity:0.3} 40%{transform:scale(1);opacity:1} }',
    prefersReducedMotion ? '' : '.dot:nth-child(1){animation:bounce 1.2s 0s infinite}',
    prefersReducedMotion ? '' : '.dot:nth-child(2){animation:bounce 1.2s 0.2s infinite}',
    prefersReducedMotion ? '' : '.dot:nth-child(3){animation:bounce 1.2s 0.4s infinite}',

    /* エラーバナー */
    '.error-banner {',
    '  padding: 10px 16px;',
    '  background: #fef2f2;',
    '  color: #dc2626;',
    '  font-size: 14px;',
    '  border-bottom: 1px solid #fecaca;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  flex-shrink: 0;',
    '}',
    '.error-dismiss {',
    '  min-width: 44px;',
    '  min-height: 44px;',
    '  background: none;',
    '  border: none;',
    '  color: #dc2626;',
    '  cursor: pointer;',
    '  font-size: 16px;',
    '  padding: 0 8px;',
    '}',

    /* 入力エリア */
    '.input-area {',
    '  display: flex;',
    '  gap: 8px;',
    '  padding: 12px 16px;',
    '  border-top: 1px solid #e2e8f0;',
    '  background: #fff;',
    '  align-items: flex-end;',
    '  flex-shrink: 0;',
    '}',
    'textarea {',
    '  flex: 1;',
    '  min-height: 44px;',
    '  max-height: 120px;',
    '  padding: 10px 14px;',
    '  font-size: 16px;',
    '  line-height: 1.5;',
    '  border: 1px solid #cbd5e1;',
    '  border-radius: 22px;',
    '  resize: none;',
    '  outline: none;',
    '  font-family: inherit;',
    '  background: #f8fafc;',
    '  color: #1e293b;',
    '  overflow-y: auto;',
    '  transition: border-color 0.15s;',
    '}',
    'textarea:focus { border-color: #2563eb; background: #fff; }',
    'textarea:disabled { opacity: 0.6; }',
    '.send-btn {',
    '  min-width: 44px;',
    '  min-height: 44px;',
    '  width: 44px;',
    '  height: 44px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background: #2563eb;',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  flex-shrink: 0;',
    '  padding: 0;',
    '  transition: background-color 0.15s;',
    '}',
    '.send-btn:disabled { background: #cbd5e1; cursor: not-allowed; }',
    '.send-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',

    /* マイクボタン */
    '.mic-btn {',
    '  min-width: 44px;',
    '  min-height: 44px;',
    '  width: 44px;',
    '  height: 44px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background: #f1f5f9;',
    '  color: #64748b;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  flex-shrink: 0;',
    '  padding: 0;',
    '  transition: background-color 0.15s, color 0.15s;',
    '}',
    '.mic-btn:hover { background: #e2e8f0; color: #2563eb; }',
    '.mic-btn.recording { background: #fef2f2; color: #dc2626; }',
    '.mic-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',
    '@keyframes mic-shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)} }',
    '.mic-btn.error { animation: mic-shake 0.4s ease; background: #fef2f2; color: #dc2626; }',

    /* アバターエリア（avatar=true テナントのみ表示） */
    '.avatar-area {',
    '  width: calc(100% - 16px);',
    '  height: 220px;',
    '  margin: 8px;',
    '  border-radius: 12px;',
    '  background: linear-gradient(160deg, #0f0f1a 0%, #1a1a2e 60%, #0d1117 100%);',
    '  overflow: hidden;',
    '  position: relative;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '}',
    '.avatar-status { color: #888; font-size: 13px; }',
    '.panel.avatar-active .avatar-status { color: rgba(255,255,255,0.7); }',
    '.avatar-video {',
    '  width: 100%;',
    '  height: 100%;',
    '  object-fit: cover;',
    '  object-position: center top;',
    '  border-radius: 12px;',
    '}',

    /* アバターミュートボタン */
    '.avatar-mute-btn {',
    '  position: absolute;',
    '  bottom: 10px;',
    '  right: 10px;',
    '  min-width: 36px;',
    '  min-height: 36px;',
    '  width: 36px;',
    '  height: 36px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background: rgba(0,0,0,0.5);',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: 0;',
    '  z-index: 10;',
    '}',
    '.avatar-mute-btn:hover { background: rgba(0,0,0,0.75); }',
    '.avatar-mute-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',

    /* 音声モード表示 */
    '.voice-mode-indicator {',
    '  padding: 4px 12px;',
    '  background: #eff6ff;',
    '  color: #2563eb;',
    '  font-size: 12px;',
    '  text-align: center;',
    '  border-bottom: 1px solid #dbeafe;',
    '  flex-shrink: 0;',
    '}',

    /* モバイル最適化 */
    '@media (max-width: 390px) { .avatar-area { height: 180px; } }',

    /* ───── avatar-active: PC 横並び2パネル / モバイル縦スプリット ───── */

    /* PC: CSS Grid 2カラム（左: アバター60% / 右: チャット40%） */
    '.panel.avatar-active {',
    '  background: linear-gradient(135deg, #050510 0%, #0a0a1a 100%);',
    '  overscroll-behavior: contain;',
    '  display: grid;',
    '  grid-template-columns: 3fr 2fr;',
    '  grid-template-rows: auto 1fr auto;',
    '  width: min(900px, calc(100vw - 48px));',
    '}',

    /* ヘッダー: 右カラム上部（ダークテーマ） */
    '.panel.avatar-active .header {',
    '  grid-column: 2;',
    '  grid-row: 1;',
    '  display: flex;',
    '  background: #111;',
    '  border-bottom: 1px solid rgba(255,255,255,0.1);',
    '  color: #e5e7eb;',
    '}',

    /* アバターエリア: 左カラム全体（3行スパン） */
    '.panel.avatar-active .avatar-area {',
    '  grid-column: 1;',
    '  grid-row: 1 / 4;',
    '  position: relative;',
    '  width: 100%;',
    '  height: 100%;',
    '  min-height: unset;',
    '  max-height: unset;',
    '  margin: 0;',
    '  border-radius: 16px 0 0 16px;',
    '  background: #000;',
    '  overflow: hidden;',
    '}',
    '.panel.avatar-active .avatar-video { border-radius: 0; width: 100%; height: 100%; object-fit: cover; object-position: center top; }',

    /* 閉じるボタン: アバターエリア右上 */
    '.avatar-close-btn {',
    '  position: absolute;',
    '  top: 12px; right: 12px;',
    '  z-index: 10;',
    '  min-width: 40px; min-height: 40px;',
    '  width: 40px; height: 40px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background: rgba(0,0,0,0.4);',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  padding: 0;',
    '  -webkit-backdrop-filter: blur(4px);',
    '  backdrop-filter: blur(4px);',
    '}',
    '.avatar-close-btn:hover { background: rgba(0,0,0,0.6); }',
    '.avatar-close-btn:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }',
    /* PC: ヘッダー（右カラム）に×ボタンがあるので左パネルの avatar-close-btn は非表示 */
    '.panel.avatar-active .avatar-close-btn { display: none; }',

    /* メッセージエリア: 右カラム中段（独立スクロール） */
    '.panel.avatar-active .messages {',
    '  grid-column: 2;',
    '  grid-row: 2;',
    '  position: static;',
    '  max-height: none;',
    '  z-index: auto;',
    '  background: #111;',
    '  padding: 8px 16px;',
    '  overflow-y: auto;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 8px;',
    '  scrollbar-width: none;',
    '  -ms-overflow-style: none;',
    '  overscroll-behavior: contain;',
    '  -webkit-overflow-scrolling: touch;',
    '  touch-action: pan-y;',
    '}',
    '.panel.avatar-active .messages::-webkit-scrollbar { display: none; }',
    '.panel.avatar-active .messages > :first-child { margin-top: auto; }',

    /* チャットバブル: ダークテーマ */
    '.panel.avatar-active .bubble.assistant {',
    '  background: rgba(255,255,255,0.08);',
    '  color: #e5e7eb;',
    '  border: 1px solid rgba(255,255,255,0.1);',
    '  border-radius: 16px 16px 16px 4px;',
    '}',
    '.panel.avatar-active .bubble.user {',
    '  background: rgba(37,99,235,0.7);',
    '  color: #fff;',
    '  border-radius: 16px 16px 4px 16px;',
    '}',
    '.panel.avatar-active .ts { color: rgba(255,255,255,0.4); font-size: 10px; }',
    '.avatar-name-label { font-size: 11px; font-weight: 600; color: #6b7280; margin-bottom: 2px; padding-left: 2px; }',
    '.panel.avatar-active .avatar-name-label { color: rgba(255,255,255,0.5); }',

    /* 入力エリア: 右カラム下段 */
    '.panel.avatar-active .input-area {',
    '  grid-column: 2;',
    '  grid-row: 3;',
    '  position: static;',
    '  flex-shrink: 0;',
    '  z-index: auto;',
    '  background: rgba(0,0,0,0.85);',
    '  -webkit-backdrop-filter: blur(8px);',
    '  backdrop-filter: blur(8px);',
    '  border-top: 1px solid rgba(255,255,255,0.12);',
    '  padding: 10px 12px;',
    '  border-radius: 0 0 16px 0;',
    '}',
    '.panel.avatar-active textarea {',
    '  background: rgba(255,255,255,0.1);',
    '  border-color: rgba(255,255,255,0.2);',
    '  color: #fff;',
    '}',
    '.panel.avatar-active textarea::placeholder { color: rgba(255,255,255,0.4); }',
    '.panel.avatar-active textarea:focus {',
    '  background: rgba(255,255,255,0.15);',
    '  border-color: rgba(255,255,255,0.35);',
    '}',

    /* ミュートボタン */
    '.panel.avatar-active .avatar-mute-btn {',
    '  position: static;',
    '  background: rgba(255,255,255,0.15);',
    '  width: 40px; height: 40px;',
    '  min-width: 40px; min-height: 40px;',
    '  flex-shrink: 0;',
    '}',
    '.panel.avatar-active .avatar-mute-btn:hover { background: rgba(255,255,255,0.25); }',
    '.panel.avatar-active .mic-btn { background: rgba(255,255,255,0.15); color: #fff; }',
    '.panel.avatar-active .mic-btn:hover { background: rgba(255,255,255,0.25); color: #fff; }',
    '.panel.avatar-active .mic-btn.recording { background: rgba(220,38,38,0.6); color: #fff; }',
    '.panel.avatar-active .mic-btn.error { background: rgba(220,38,38,0.4); color: #fff; }',
    '.panel.avatar-active .send-btn { background: rgba(37,99,235,0.8); }',
    '.panel.avatar-active .send-btn:disabled { background: rgba(255,255,255,0.2); cursor: not-allowed; }',

    /* エラーバナー: パネル絶対配置 */
    '.panel.avatar-active .error-banner {',
    '  position: absolute;',
    '  top: 0; left: 0; right: 0;',
    '  z-index: 15;',
    '  background: rgba(220,38,38,0.9);',
    '  color: #fff;',
    '  border-bottom: none;',
    '}',

    '.panel.avatar-active .voice-mode-indicator { display: none; }',
    '.panel.avatar-active .empty-state { display: none; }',

    /* モバイル（<=500px）: flex-column 縦スプリット */
    '@media (max-width: 500px) {',
    '  .panel.avatar-active {',
    '    display: flex;',
    '    flex-direction: column;',
    '    width: 100vw !important;',
    '    max-width: 100vw !important;',
    '    right: 0 !important; bottom: 0 !important;',
    '    height: 100dvh;',
    '    border-radius: 0;',
    '  }',
    '  .panel.avatar-active .header { display: none; }',
    '  .panel.avatar-active .close-btn { display: none !important; }',
    '  .panel.avatar-active .avatar-close-btn { display: flex; }',
    '  .panel.avatar-active .avatar-area {',
    '    grid-column: unset; grid-row: unset;',
    '    width: 100%; height: 45%;',
    '    min-height: 200px; max-height: 320px;',
    '    border-radius: 0;',
    '  }',
    '  .panel.avatar-active .messages {',
    '    grid-column: unset; grid-row: unset;',
    '    flex: 1;',
    '  }',
    '  .panel.avatar-active .input-area {',
    '    grid-column: unset; grid-row: unset;',
    '    border-radius: 0;',
    '  }',
    '}',
  ].join('\n');

  shadow.appendChild(styleEl);

  /* ------------------------------------------------------------------ */
  /* 5. DOM 構築（innerHTML 禁止 — createElement / textContent のみ）     */
  /* ------------------------------------------------------------------ */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') {
          node.className = attrs[k];
        } else if (k === 'style') {
          Object.assign(node.style, attrs[k]);
        } else {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (typeof c === 'string') {
          node.appendChild(document.createTextNode(c));
        } else if (c) {
          node.appendChild(c);
        }
      });
    }
    return node;
  }

  function svgIcon(pathD, viewBox) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (Array.isArray(pathD)) {
      pathD.forEach(function (d) {
        var p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      });
    } else {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', pathD);
      svg.appendChild(p);
    }
    return svg;
  }

  var CHAT_SVG_PATH = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';
  var CLOSE_SVG = (function () {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var l1 = document.createElementNS(ns, 'line');
    l1.setAttribute('x1', '18'); l1.setAttribute('y1', '6');
    l1.setAttribute('x2', '6'); l1.setAttribute('y2', '18');
    var l2 = document.createElementNS(ns, 'line');
    l2.setAttribute('x1', '6'); l2.setAttribute('y1', '6');
    l2.setAttribute('x2', '18'); l2.setAttribute('y2', '18');
    svg.appendChild(l1);
    svg.appendChild(l2);
    return svg;
  })();

  var SEND_SVG = (function () {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', '22'); l.setAttribute('y1', '2');
    l.setAttribute('x2', '11'); l.setAttribute('y2', '13');
    var poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');
    svg.appendChild(l);
    svg.appendChild(poly);
    return svg;
  })();

  /* --- パネル --- */
  var panel = el('div', { className: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'サポートチャット', 'aria-hidden': 'true' });

  /* --- ヘッダ --- */
  var headerTitleEl = el('p', { className: 'header-title' }, 'サポートチャット');
  var headerMetaEl = el('p', { className: 'header-meta' }, 'ご質問はお気軽にどうぞ');
  var headerInfo = el('div', {}, [headerTitleEl, headerMetaEl]);
  var closeBtn = el('button', { className: 'close-btn', type: 'button', 'aria-label': 'チャットを閉じる' });
  closeBtn.appendChild(CLOSE_SVG.cloneNode(true));
  var header = el('div', { className: 'header' }, [headerInfo, closeBtn]);
  panel.appendChild(header);

  /* --- エラーバナー（非表示で作成） --- */
  var errorText = el('span', {});
  var dismissBtn = el('button', { className: 'error-dismiss', type: 'button', 'aria-label': 'エラーを閉じる' }, '✕');
  var errorBanner = el('div', { className: 'error-banner', role: 'alert', 'aria-live': 'assertive' }, [errorText, dismissBtn]);
  errorBanner.style.display = 'none';
  panel.appendChild(errorBanner);

  /* --- アバターエリア（初期は非表示 — avatar=true テナントのみ使用） --- */
  var avatarArea = document.createElement('div');
  avatarArea.className = 'avatar-area';
  avatarArea.style.display = 'none';
  var avatarStatusText = document.createElement('div');
  avatarStatusText.className = 'avatar-status';
  avatarStatusText.textContent = 'アバターに接続中...';
  avatarArea.appendChild(avatarStatusText);
  panel.appendChild(avatarArea);

  /* --- 音声モードインジケーター（アバター有効時のみ表示） --- */
  var voiceModeIndicator = document.createElement('div');
  voiceModeIndicator.className = 'voice-mode-indicator';
  voiceModeIndicator.textContent = '🔇 音声ミュート中';
  voiceModeIndicator.style.display = 'none';
  panel.appendChild(voiceModeIndicator);

  /* --- メッセージエリア --- */
  var messagesArea = el('div', { className: 'messages', role: 'log', 'aria-live': 'polite', 'aria-label': 'チャット履歴' });
  var emptyStateEl = el('div', { className: 'empty-state' }, 'ご質問をどうぞ。お気軽にお聞きください。');
  messagesArea.appendChild(emptyStateEl);
  panel.appendChild(messagesArea);

  /* --- 入力エリア --- */
  var textarea = el('textarea', {
    placeholder: 'メッセージを入力…',
    rows: '1',
    maxlength: '2000',
    'aria-label': 'メッセージ',
  });

  /* --- マイクボタン（Web Speech API 非対応ブラウザでは非表示） --- */
  var micBtn = el('button', { className: 'mic-btn', type: 'button', 'aria-label': '音声入力' });
  (function () {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var p1 = document.createElementNS(ns, 'path');
    p1.setAttribute('d', 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z');
    var p2 = document.createElementNS(ns, 'path');
    p2.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2');
    var p3 = document.createElementNS(ns, 'path');
    p3.setAttribute('d', 'M12 19v4 M8 23h8');
    svg.appendChild(p1); svg.appendChild(p2); svg.appendChild(p3);
    micBtn.appendChild(svg);
  })();

  // Web Speech API 非対応ブラウザでは非表示
  var SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionAPI) {
    micBtn.style.display = 'none';
  }

  var sendBtn = el('button', { className: 'send-btn', type: 'button', 'aria-label': '送信', disabled: 'true' });
  sendBtn.appendChild(SEND_SVG.cloneNode(true));
  var inputArea = el('div', { className: 'input-area', role: 'form', 'aria-label': 'メッセージ入力フォーム' }, [textarea, micBtn, sendBtn]);
  panel.appendChild(inputArea);

  shadow.appendChild(panel);

  /* --- FABボタン --- */
  var fab = el('button', {
    className: 'fab',
    type: 'button',
    'aria-label': 'チャットを開く',
    'aria-expanded': 'false',
    'aria-haspopup': 'dialog',
  });
  fab.appendChild(svgIcon(CHAT_SVG_PATH));
  shadow.appendChild(fab);

  /* ------------------------------------------------------------------ */
  /* 6. 状態管理                                                          */
  /* ------------------------------------------------------------------ */

  var isOpen = false;
  var isLoading = false;
  var messages = [];

  /* アバター状態 */
  var avatarConfig = null;      // { enabled, livekitUrl, token, roomName, agentId, imageUrl, avatarName }
  var avatarConfigFetched = false;
  var avatarMuted = true;       // 音声ミュート状態（デフォルト: ミュート）
  var anamClient = null;         // Anam SDK クライアント
  var avatarProvider = null;     // 'anam' | 'lemonslice' | null
  var currentAvatarName = null;  // アバター名（未設定時は null）
  var avatarPlaceholderImg = null; // LiveKit接続前のアバター画像プレースホルダー
  var fabMediaContainer = null;  // FABメディアコンテナ（アバター映像/静止画）
  var fabVideoEl = null;         // LiveKitビデオ要素（FAB↔avatarAreaで移動）

  var conversationId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
  var currentAbortController = null;

  function generateMsgId() {
    return 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  function formatTime(ts) {
    return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  }

  /* ------------------------------------------------------------------ */
  /* 7. DOM 更新関数                                                      */
  /* ------------------------------------------------------------------ */

  function updateSendButton() {
    var hasText = textarea.value.trim().length > 0;
    var canSend = hasText && !isLoading;
    sendBtn.disabled = !canSend;
  }

  function showError(msg) {
    // textContent を使用（innerHTML 禁止）
    errorText.textContent = msg;
    errorBanner.style.display = 'flex';
  }

  function hideError() {
    errorBanner.style.display = 'none';
    errorText.textContent = '';
  }

  function autoResizeTextarea() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  function scrollToBottom(force) {
    if (force) {
      messagesArea.scrollTop = messagesArea.scrollHeight;
      return;
    }
    // ユーザーが最下部付近（50px以内）にいる場合のみ自動スクロール
    var isNearBottom = (messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight) < 50;
    if (isNearBottom) {
      messagesArea.scrollTop = messagesArea.scrollHeight;
    }
  }

  /* ------------------------------------------------------------------ */
  /* アバター — LiveKit接続                                               */
  /* ------------------------------------------------------------------ */

  var LIVEKIT_SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.9.1/dist/livekit-client.umd.min.js';

  function showAvatarPlaceholder(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return;
    if (avatarPlaceholderImg) return; // 既に表示中
    var img = document.createElement('img');
    img.src = imageUrl;
    img.className = 'avatar-video';  // .avatar-video と同じスタイルを使用
    img.alt = 'アバター画像';
    img.style.objectFit = 'cover';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.position = 'absolute';
    img.style.top = '0';
    img.style.left = '0';
    avatarPlaceholderImg = img;
    avatarArea.appendChild(img);
    avatarStatusText.style.display = 'none';
    // FABにも静止画を表示（パネル展開前のプレビュー）
    if (!fabVideoEl) {
      var fabPreviewImg = document.createElement('img');
      fabPreviewImg.src = imageUrl;
      fabPreviewImg.alt = 'アバター';
      fabPreviewImg.onerror = function () { resetFabIcon(); };
      showFabMedia(fabPreviewImg);
    }
  }

  function removeAvatarPlaceholder() {
    if (avatarPlaceholderImg && avatarPlaceholderImg.parentNode) {
      avatarPlaceholderImg.parentNode.removeChild(avatarPlaceholderImg);
    }
    avatarPlaceholderImg = null;
  }

  function ensureFabMediaContainer() {
    if (fabMediaContainer) return;
    fabMediaContainer = document.createElement('div');
    fabMediaContainer.className = 'fab-media-container';
  }

  /**
   * FABにメディア要素（video/img）を表示する。
   * isOpen=true（パネル展開中）の場合は何もしない（FABはcloseアイコン表示中）。
   */
  function showFabMedia(mediaEl) {
    ensureFabMediaContainer();
    while (fabMediaContainer.firstChild) {
      fabMediaContainer.removeChild(fabMediaContainer.firstChild);
    }
    fabMediaContainer.appendChild(mediaEl);
    if (!isOpen) {
      while (fab.firstChild) { fab.removeChild(fab.firstChild); }
      fab.appendChild(fabMediaContainer);
    }
  }

  /**
   * FABをデフォルトのチャットアイコンに戻す。
   */
  function resetFabIcon() {
    fab.classList.remove('avatar-loading');
    while (fab.firstChild) { fab.removeChild(fab.firstChild); }
    fab.appendChild(svgIcon(CHAT_SVG_PATH));
  }

  function startFabLoading() {
    fab.classList.add('avatar-loading');
    while (fab.firstChild) { fab.removeChild(fab.firstChild); }
  }

  function fetchAvatarConfig() {
    if (avatarConfigFetched || !apiKey) return;
    avatarConfigFetched = true;

    // まず Anam セッションを試みる
    fetch(apiBase + '/api/avatar/anam-session', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.enabled && data.avatarProvider === 'anam' && data.sessionToken) {
          // Anam フロー
          avatarProvider = 'anam';
          currentAvatarName = data.avatarName || null;
          try { sessionStorage.setItem(avatarCacheKey, 'true'); } catch (_e) {}
          startFabLoading();
          if (isOpen) {
            avatarArea.style.display = 'flex';
            panel.classList.add('avatar-active');
          }
          initAnamAvatar(data.sessionToken);
          return;
        }
        // Lemonslice フォールバック: 既存の room-token フロー
        avatarProvider = 'lemonslice';
        fetch(apiBase + '/api/avatar/room-token', {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
        })
          .then(function (r) { return r.json(); })
          .then(function (lkData) {
            try { sessionStorage.setItem(avatarCacheKey, lkData.enabled ? 'true' : 'false'); } catch (_e) {}
            if (!lkData.enabled) return;
            avatarConfig = lkData;
            currentAvatarName = lkData.avatarName || null;
            startFabLoading();
            if (isOpen) {
              avatarArea.style.display = 'flex';
              panel.classList.add('avatar-active');
            }
            showAvatarPlaceholder(lkData.imageUrl);
            initLiveKitAvatar();
          })
          .catch(function (e) {
            console.warn('[FAQ Widget] LiveKit config fetch failed:', e && e.message);
            resetFabIcon();
          });
      })
      .catch(function (e) {
        // anam-session 失敗時は既存フローへ
        console.warn('[FAQ Widget] Anam session fetch failed, falling back to LiveKit:', e && e.message);
        avatarProvider = 'lemonslice';
        fetch(apiBase + '/api/avatar/room-token', {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
        })
          .then(function (r) { return r.json(); })
          .then(function (lkData) {
            try { sessionStorage.setItem(avatarCacheKey, lkData.enabled ? 'true' : 'false'); } catch (_e) {}
            if (!lkData.enabled) return;
            avatarConfig = lkData;
            currentAvatarName = lkData.avatarName || null;
            startFabLoading();
            if (isOpen) {
              avatarArea.style.display = 'flex';
              panel.classList.add('avatar-active');
            }
            showAvatarPlaceholder(lkData.imageUrl);
            initLiveKitAvatar();
          })
          .catch(function () { resetFabIcon(); });
      });
  }

  /* ------------------------------------------------------------------ */
  /* アバター — Anam.ai接続                                               */
  /* ------------------------------------------------------------------ */

  var ANAM_SDK_URL = 'https://esm.sh/@anam-ai/js-sdk@latest';

  function initAnamAvatar(sessionToken) {
    avatarArea.style.display = 'flex';
    avatarStatusText.style.display = '';

    // ESM dynamic import で Anam SDK をロード
    var loadScript = document.createElement('script');
    loadScript.type = 'module';
    loadScript.textContent = [
      'import { createClient, AnamEvent } from "' + ANAM_SDK_URL + '";',
      'window.__anamCreateClient = createClient;',
      'window.__AnamEvent = AnamEvent;',
      'window.dispatchEvent(new CustomEvent("anam-sdk-loaded"));',
    ].join('\n');
    document.head.appendChild(loadScript);

    function onAnamSdkLoaded() {
      window.removeEventListener('anam-sdk-loaded', onAnamSdkLoaded);
      connectAnam(sessionToken);
    }

    if (window.__anamCreateClient) {
      connectAnam(sessionToken);
    } else {
      window.addEventListener('anam-sdk-loaded', onAnamSdkLoaded);
    }
  }

  // Phase42: Anam映像 + Fish Audio TTS
  // Anam内蔵TTSはカタコト（Kaoriのみ）のため回避。Fish Audioで自然な日本語音声を再生。
  // messageHistory: [{ role: 'user'|'assistant', content: string }]
  async function handleAnamMessageUpdate(messageHistory) {
    if (!messageHistory || !messageHistory.length) return;
    var lastMsg = messageHistory[messageHistory.length - 1];
    if (lastMsg.role !== 'user') return;
    if (!anamClient) return;

    try {
      // 1. Groq LLMでテキスト生成
      var chatStreamUrl = apiBase.replace(/\/$/, '') + '/api/avatar/chat-stream';
      var response = await fetch(chatStreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          messages: messageHistory.map(function (m) {
            return { role: m.role, content: m.content };
          }),
        }),
      });

      if (!response.ok) throw new Error('chat-stream ' + response.status);

      // 全文バッファリング
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var fullText = '';

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        var text = decoder.decode(result.value);
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          try {
            var data = JSON.parse(line);
            if (data.content) fullText += data.content;
          } catch (_e) { /* malformed JSON — skip */ }
        }
      }

      if (!fullText) return;

      // 2. Anamにテキスト送信（リップシンク用、音声はミュート済み）
      if (anamClient && typeof anamClient.talk === 'function') {
        try { anamClient.talk(fullText); } catch (_e) {
          console.warn('[FAQ Widget] anamClient.talk failed:', _e && _e.message);
        }
      }

      // 3. Fish Audio TTSで自然な日本語音声を取得して再生
      var ttsUrl = apiBase.replace(/\/$/, '') + '/api/avatar/tts';
      try {
        var ttsResponse = await fetch(ttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ text: fullText }),
        });

        if (ttsResponse.ok) {
          var audioBlob = await ttsResponse.blob();
          var audioUrl = URL.createObjectURL(audioBlob);
          var audio = new Audio(audioUrl);
          audio.onended = function () {
            URL.revokeObjectURL(audioUrl);
          };
          audio.play().catch(function (err) {
            console.warn('[FAQ Widget] Audio play failed (autoplay policy?):', err);
          });
        } else {
          console.error('[FAQ Widget] TTS failed:', ttsResponse.status);
        }
      } catch (ttsErr) {
        console.warn('[FAQ Widget] TTS error:', ttsErr && ttsErr.message);
      }

    } catch (e) {
      console.error('[FAQ Widget] Custom LLM error:', e && e.message);
    }
  }

  function connectAnam(sessionToken) {
    if (!window.__anamCreateClient) {
      console.warn('[FAQ Widget] Anam SDK not loaded');
      avatarArea.style.display = 'none';
      return;
    }

    try {
      // ミュートボタンを生成（既存の LiveKit フローと同じ構造）
      var avatarMuteBtn = document.createElement('button');
      avatarMuteBtn.className = 'avatar-mute-btn';
      avatarMuteBtn.setAttribute('type', 'button');
      avatarMuteBtn.setAttribute('aria-label', '音声ミュート切替');
      avatarMuteBtn.setAttribute('aria-pressed', 'true');

      function _anamMuteSvg() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var body = document.createElementNS(ns, 'polygon');
        body.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
        var x1 = document.createElementNS(ns, 'line');
        x1.setAttribute('x1', '23'); x1.setAttribute('y1', '9');
        x1.setAttribute('x2', '17'); x1.setAttribute('y2', '15');
        var x2 = document.createElementNS(ns, 'line');
        x2.setAttribute('x1', '17'); x2.setAttribute('y1', '9');
        x2.setAttribute('x2', '23'); x2.setAttribute('y2', '15');
        svg.appendChild(body); svg.appendChild(x1); svg.appendChild(x2);
        return svg;
      }
      function _anamSpeakerSvg() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var body = document.createElementNS(ns, 'polygon');
        body.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
        var w1 = document.createElementNS(ns, 'path');
        w1.setAttribute('d', 'M15.54 8.46a5 5 0 0 1 0 7.07');
        var w2 = document.createElementNS(ns, 'path');
        w2.setAttribute('d', 'M19.07 4.93a10 10 0 0 1 0 14.14');
        svg.appendChild(body); svg.appendChild(w1); svg.appendChild(w2);
        return svg;
      }

      avatarMuteBtn.appendChild(_anamMuteSvg());
      avatarArea.appendChild(avatarMuteBtn);

      avatarMuteBtn.addEventListener('click', function () {
        avatarMuted = !avatarMuted;
        if (anamClient) {
          try {
            if (avatarMuted) {
              // muteAudio() を優先、フォールバックで muteOutputAudio()
              if (typeof anamClient.muteAudio === 'function') {
                anamClient.muteAudio();
              } else {
                anamClient.muteOutputAudio();
              }
            } else {
              if (typeof anamClient.unmuteAudio === 'function') {
                anamClient.unmuteAudio();
              } else {
                anamClient.unmuteOutputAudio();
              }
            }
          } catch (_e) {}
        }
        while (avatarMuteBtn.firstChild) { avatarMuteBtn.removeChild(avatarMuteBtn.firstChild); }
        avatarMuteBtn.appendChild(avatarMuted ? _anamMuteSvg() : _anamSpeakerSvg());
        avatarMuteBtn.setAttribute('aria-pressed', String(avatarMuted));
        voiceModeIndicator.textContent = avatarMuted ? '🔇 音声ミュート中' : '🔊 音声で応答中';
      });

      // Anam SDKはdocument.getElementById()でvideo要素を探すためShadow DOM外に作成
      // Shadow DOM内のdisplay用videoにはsrcObjectでミラーする
      var videoId = 'anam-video-' + Date.now();
      var outerVideoEl = document.createElement('video');
      outerVideoEl.id = videoId;
      outerVideoEl.setAttribute('autoplay', '');
      outerVideoEl.setAttribute('playsinline', '');
      outerVideoEl.setAttribute('muted', '');
      outerVideoEl.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(outerVideoEl);
      window.__anamOuterVideo = outerVideoEl;

      // Shadow DOM内の表示用video要素
      var shadowVideoEl = document.createElement('video');
      shadowVideoEl.className = 'avatar-video';
      shadowVideoEl.setAttribute('autoplay', '');
      shadowVideoEl.setAttribute('playsinline', '');
      shadowVideoEl.setAttribute('muted', '');
      avatarArea.appendChild(shadowVideoEl);

      // outerVideoにストリームが来たらshadowVideoにsrcObjectをミラー
      outerVideoEl.addEventListener('loadedmetadata', function () {
        if (outerVideoEl.srcObject) {
          shadowVideoEl.srcObject = outerVideoEl.srcObject;
          shadowVideoEl.play().catch(function () {});
          avatarStatusText.style.display = 'none';
        }
      });

      anamClient = window.__anamCreateClient(sessionToken, {
        avatarModel: 'CARA-3',
      });

      // デフォルトミュート (muteAudio優先、フォールバックでmuteOutputAudio)
      try {
        if (typeof anamClient.muteAudio === 'function') {
          anamClient.muteAudio();
        } else {
          anamClient.muteOutputAudio();
        }
      } catch (_e) {}

      anamClient.streamToVideoElement(videoId)
        .then(function () {
          console.log('[FAQ Widget] Anam avatar streaming started');
          fab.classList.remove('avatar-loading');
          avatarStatusText.style.display = 'none';
          voiceModeIndicator.style.display = '';

          panel.classList.add('avatar-active');
          textarea.setAttribute('placeholder', 'メッセージを入力…');

          // 右上フローティング閉じるボタン
          var avatarCloseBtn = el('button', {
            className: 'avatar-close-btn',
            type: 'button',
            'aria-label': 'チャットを閉じる',
          });
          avatarCloseBtn.appendChild(CLOSE_SVG.cloneNode(true));
          avatarCloseBtn.addEventListener('click', closePanel);
          avatarArea.appendChild(avatarCloseBtn);

          // ミュートボタンを入力バー左端に移動
          inputArea.insertBefore(avatarMuteBtn, inputArea.firstChild);

          // Client-Side Custom LLM: 音声入力完了時に Groq で応答生成
          var AnamEvent = window.__AnamEvent;
          if (AnamEvent && AnamEvent.MESSAGE_HISTORY_UPDATED) {
            anamClient.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, handleAnamMessageUpdate);
          }

          window.__anamClient = anamClient;
        })
        .catch(function (e) {
          console.warn('[FAQ Widget] Anam stream failed:', e && e.message);
          resetFabIcon();
          avatarArea.style.display = 'none';
          panel.classList.remove('avatar-active');
        });

    } catch (e) {
      console.warn('[FAQ Widget] Anam init failed:', e && e.message);
      resetFabIcon();
      avatarArea.style.display = 'none';
    }
  }

  function cleanupAnam() {
    try {
      if (anamClient || window.__anamClient) {
        var client = anamClient || window.__anamClient;
        client.stopStreaming();
      }
    } catch (_e) {}
    // Shadow DOM外に作成したvideo要素を削除
    try {
      if (window.__anamOuterVideo && window.__anamOuterVideo.parentNode) {
        window.__anamOuterVideo.parentNode.removeChild(window.__anamOuterVideo);
      }
    } catch (_e) {}
    window.__anamOuterVideo = null;
    anamClient = null;
    window.__anamClient = null;
    panel.classList.remove('avatar-active');
    var cBtns = avatarArea.querySelectorAll('.avatar-close-btn');
    for (var ci = 0; ci < cBtns.length; ci++) { cBtns[ci].remove(); }
    avatarArea.style.display = 'none';
    avatarStatusText.style.display = '';
    avatarConfigFetched = false;
    avatarProvider = null;
  }

  function initLiveKitAvatar() {
    if (!avatarConfig) return;

    // アバターエリアを表示（接続中テキスト付き）
    avatarArea.style.display = 'flex';
    avatarStatusText.style.display = '';

    // SDK 既にロード済みならそのまま接続
    if (window.LivekitClient) {
      connectLiveKit();
      return;
    }

    // スクリプトタグが既に DOM にある（ロード中）なら追加しない
    if (document.querySelector('script[src="' + LIVEKIT_SDK_URL + '"]')) {
      return;
    }

    // LiveKit Client SDK を CDN から動的ロード（innerHTML 禁止 — createElement を使用）
    var script = document.createElement('script');
    script.src = LIVEKIT_SDK_URL;
    script.onload = function () { connectLiveKit(); };
    script.onerror = function () {
      avatarArea.style.display = 'none';
      console.warn('[FAQ Widget] LiveKit SDK load failed');
    };
    document.head.appendChild(script);
  }

  function connectLiveKit() {
    if (!avatarConfig || !window.LivekitClient) return;

    // 切断済み・エラー状態の古いRoomを先にクリーンアップ
    if (window.__rajiuceRoom && window.__rajiuceRoom.state !== 'connected') {
      try { window.__rajiuceRoom.disconnect(); } catch (_e) {}
      window.__rajiuceRoom = null;
    }
    // 既に接続済みなら再利用
    if (window.__rajiuceRoom && window.__rajiuceRoom.state === 'connected') {
      avatarArea.style.display = 'flex';
      return;
    }

    // 再接続前: Disconnected ハンドラが非同期で戻した stale 要素も含めて完全削除
    var _rkClose = avatarArea.querySelectorAll('.avatar-close-btn');
    for (var _rki = 0; _rki < _rkClose.length; _rki++) { _rkClose[_rki].remove(); }
    var _rkMuteA = avatarArea.querySelectorAll('.avatar-mute-btn');
    for (var _rkj = 0; _rkj < _rkMuteA.length; _rkj++) { _rkMuteA[_rkj].remove(); }
    var _rkMuteI = inputArea.querySelectorAll('.avatar-mute-btn');
    for (var _rkk = 0; _rkk < _rkMuteI.length; _rkk++) { _rkMuteI[_rkk].remove(); }

    try {
      var LK = window.LivekitClient;
      var room = new LK.Room({ adaptiveStream: true, dynacast: true });

      // ミュートボタンを生成（SVGは createElement で — innerHTML 禁止）
      var avatarMuteBtn = document.createElement('button');
      avatarMuteBtn.className = 'avatar-mute-btn';
      avatarMuteBtn.setAttribute('type', 'button');
      avatarMuteBtn.setAttribute('aria-label', '音声ミュート切替');
      avatarMuteBtn.setAttribute('aria-pressed', 'true');

      function _speakerSvg() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var body = document.createElementNS(ns, 'polygon');
        body.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
        var w1 = document.createElementNS(ns, 'path');
        w1.setAttribute('d', 'M15.54 8.46a5 5 0 0 1 0 7.07');
        var w2 = document.createElementNS(ns, 'path');
        w2.setAttribute('d', 'M19.07 4.93a10 10 0 0 1 0 14.14');
        svg.appendChild(body); svg.appendChild(w1); svg.appendChild(w2);
        return svg;
      }

      function _muteSvg() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var body = document.createElementNS(ns, 'polygon');
        body.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
        var x1 = document.createElementNS(ns, 'line');
        x1.setAttribute('x1', '23'); x1.setAttribute('y1', '9');
        x1.setAttribute('x2', '17'); x1.setAttribute('y2', '15');
        var x2 = document.createElementNS(ns, 'line');
        x2.setAttribute('x1', '17'); x2.setAttribute('y1', '9');
        x2.setAttribute('x2', '23'); x2.setAttribute('y2', '15');
        svg.appendChild(body); svg.appendChild(x1); svg.appendChild(x2);
        return svg;
      }

      avatarMuteBtn.appendChild(_muteSvg());   // デフォルトミュート → ミュートアイコンで初期化
      avatarArea.appendChild(avatarMuteBtn);

      avatarMuteBtn.addEventListener('click', function () {
        avatarMuted = !avatarMuted;
        // 全 audio 要素にミュートを反映
        var audios = avatarArea.querySelectorAll('audio');
        for (var i = 0; i < audios.length; i++) { audios[i].muted = avatarMuted; }
        // アイコン更新
        while (avatarMuteBtn.firstChild) { avatarMuteBtn.removeChild(avatarMuteBtn.firstChild); }
        avatarMuteBtn.appendChild(avatarMuted ? _muteSvg() : _speakerSvg());
        avatarMuteBtn.setAttribute('aria-pressed', String(avatarMuted));
        // インジケーター更新
        voiceModeIndicator.textContent = avatarMuted ? '🔇 音声ミュート中' : '🔊 音声で応答中';
      });

      // Agent からのテキスト応答をチャットバブルとして表示（ミュート時のみ）
      room.on(LK.RoomEvent.DataReceived, function (data) {
        try {
          var msg = JSON.parse(new TextDecoder().decode(data));
          if (msg.type === 'agent_reply' && msg.text) {
            var assistantMsg = {
              id: generateMsgId(),
              role: 'assistant',
              content: String(msg.text),
              timestamp: Date.now(),
            };
            messages.push(assistantMsg);
            renderMessages();
            // アバター返答は常に最新テキストが全文表示されるよう強制スクロール
            scrollToBottom(true);
          }
        } catch (_e) {}
      });

      room.on(LK.RoomEvent.TrackSubscribed, function (track) {
        if (track.kind === 'video') {
          removeAvatarPlaceholder();
          var videoEl = track.attach();
          videoEl.className = 'avatar-video';
          avatarStatusText.style.display = 'none';
          fab.classList.remove('avatar-loading');
          fabVideoEl = videoEl;
          if (isOpen) {
            // パネル展開中: avatarAreaに直接追加
            avatarArea.appendChild(videoEl);
          } else {
            // パネル閉鎖中: FABにビデオを表示（アイドルモーション表示）
            showFabMedia(videoEl);
          }
        } else if (track.kind === 'audio') {
          // Agent TTS からの音声トラックを再生（innerHTML 禁止 — attach() で要素生成）
          var audioEl = track.attach();
          audioEl.style.display = 'none';
          audioEl.setAttribute('playsinline', '');
          // autoplay policy 対策: 最初は muted で play() → 再生開始後に実際のミュート状態を適用
          // （muted=false の unmuted 要素は Chrome の autoplay policy でブロックされる場合がある）
          audioEl.muted = true;
          avatarArea.appendChild(audioEl);
          var _ap = audioEl.play();
          if (_ap && typeof _ap.then === 'function') {
            _ap.then(function () {
              audioEl.muted = avatarMuted;  // 再生開始後に実際のミュート状態を適用
            }).catch(function (err) {
              audioEl.muted = avatarMuted;
              console.warn('[FAQ Widget] audio autoplay blocked:', err && err.name);
            });
          } else {
            audioEl.muted = avatarMuted;
          }
          console.log('[FAQ Widget] Audio track subscribed, muted=' + avatarMuted);
        }
      });

      room.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
        if (track.kind === 'video') {
          var videos = avatarArea.querySelectorAll('.avatar-video');
          for (var i = 0; i < videos.length; i++) { videos[i].remove(); }
          if (avatarStatusText) avatarStatusText.style.display = '';
        } else if (track.kind === 'audio') {
          var attached = track.detach();
          for (var j = 0; j < attached.length; j++) { attached[j].remove(); }
        }
      });

      room.on(LK.RoomEvent.Disconnected, function () {
        removeAvatarPlaceholder();
        // フルスクリーンモード解除
        panel.classList.remove('avatar-active');
        document.body.style.overflow = '';
        textarea.setAttribute('placeholder', 'メッセージを入力…');
        // 閉じるボタンを削除
        var cBtns = avatarArea.querySelectorAll('.avatar-close-btn');
        for (var ci = 0; ci < cBtns.length; ci++) { cBtns[ci].remove(); }
        // ミュートボタンをavatarAreaに戻す
        if (avatarMuteBtn && avatarMuteBtn.parentNode !== avatarArea) {
          avatarArea.appendChild(avatarMuteBtn);
        }
        avatarArea.style.display = 'none';
        voiceModeIndicator.style.display = 'none';
        window.__rajiuceRoom = null;
        // Room が切断されたら次のパネル開閉で再fetch可能にする
        avatarConfigFetched = false;
        avatarConfig = null;
        // FABをリセット
        fabVideoEl = null;
        fabMediaContainer = null;
        resetFabIcon();
      });

      room.on(LK.RoomEvent.Reconnecting, function () {
        console.log('[FAQ Widget] LiveKit reconnecting...');
      });

      room.on(LK.RoomEvent.Reconnected, function () {
        console.log('[FAQ Widget] LiveKit reconnected');
        if (isOpen) {
          avatarArea.style.display = 'flex';
          panel.classList.add('avatar-active');
        }
      });

      room.connect(avatarConfig.livekitUrl, avatarConfig.token)
        .then(function () {
          console.log('[FAQ Widget] Connected to LiveKit room');
          voiceModeIndicator.style.display = '';

          // フルスクリーンアバターUIへ切り替え
          panel.classList.add('avatar-active');
          textarea.setAttribute('placeholder', 'メッセージを入力…');

          // 右上フローティング閉じるボタンを生成
          var avatarCloseBtn = el('button', {
            className: 'avatar-close-btn',
            type: 'button',
            'aria-label': 'チャットを閉じる',
          });
          avatarCloseBtn.appendChild(CLOSE_SVG.cloneNode(true));
          avatarCloseBtn.addEventListener('click', closePanel);
          avatarArea.appendChild(avatarCloseBtn);

          // ミュートボタンを入力バー左端に移動
          inputArea.insertBefore(avatarMuteBtn, inputArea.firstChild);

          // LiveKit Data Channel 経由でウェルカムメッセージを送信
          // （Python Agent がテキストを受信して LLM 処理 → TTS → アバター映像を返す）
          try {
            var encoder = new TextEncoder();
            var localParticipant = room.localParticipant;
            if (localParticipant) {
              localParticipant.publishData(
                encoder.encode(JSON.stringify({ type: 'widget_connected' })),
                { reliable: true }
              );
            }
          } catch (_e) {}
        })
        .catch(function (e) {
          avatarArea.style.display = 'none';
          console.warn('[FAQ Widget] LiveKit connect failed:', e && e.message);
        });

      window.__rajiuceRoom = room;
    } catch (e) {
      avatarArea.style.display = 'none';
      console.warn('[FAQ Widget] LiveKit init failed:', e && e.message);
    }
  }

  function sendTTSRequest(text) {
    try {
      var room = window.__rajiuceRoom;
      console.log('[FAQ Widget] sendTTSRequest called: roomState=' + (room ? room.state : 'NO_ROOM') + ' textLen=' + (text ? text.length : 0));
      if (!room) {
        console.warn('[FAQ Widget] sendTTSRequest: no room (window.__rajiuceRoom is null)');
        return;
      }
      if (!room.localParticipant) {
        console.warn('[FAQ Widget] sendTTSRequest: localParticipant is null, state=' + room.state);
        return;
      }
      // TTS用テキストを 500 文字に制限（Data Channel 上限対策）
      var ttsText = text.length > 500 ? text.slice(0, 500) : text;
      var encoder = new TextEncoder();
      var payload = encoder.encode(JSON.stringify({ type: 'tts_request', text: ttsText }));
      console.log('[FAQ Widget] sendTTSRequest: publishing ' + payload.length + ' bytes');
      var result = room.localParticipant.publishData(payload, { reliable: true });
      if (result && typeof result.then === 'function') {
        result.then(function() {
          console.log('[FAQ Widget] sendTTSRequest: published OK');
        }).catch(function(err) {
          console.error('[FAQ Widget] sendTTSRequest: publishData rejected:', err && (err.message || err));
        });
      } else {
        console.log('[FAQ Widget] sendTTSRequest: publishData returned synchronously (no promise)');
      }
    } catch (e) {
      console.error('[FAQ Widget] sendTTSRequest error:', e && (e.message || e));
    }
  }

  function cleanupLiveKit() {
    // 明示的な完全終了用（ページ離脱など）
    // 通常の closePanel() では呼ばない — Room は切断せず保持する
    try {
      if (window.__rajiuceRoom) {
        window.__rajiuceRoom.disconnect();
        window.__rajiuceRoom = null;
      }
    } catch (_e) {}
    panel.classList.remove('avatar-active');
    var cBtns = avatarArea.querySelectorAll('.avatar-close-btn');
    for (var ci = 0; ci < cBtns.length; ci++) { cBtns[ci].remove(); }
    avatarArea.style.display = 'none';
    avatarStatusText.style.display = '';
    avatarConfigFetched = false;
    avatarConfig = null;
    fabVideoEl = null;
    fabMediaContainer = null;
    resetFabIcon();
  }

  function renderMessages() {
    // DOM再構築でscrollTopがリセットされるため、クリア前に最下部付近かどうかを保存
    var wasNearBottom = (messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight) < 50;

    // 既存のノードをすべて削除
    while (messagesArea.firstChild) {
      messagesArea.removeChild(messagesArea.firstChild);
    }

    if (messages.length === 0 && !isLoading) {
      messagesArea.appendChild(emptyStateEl);
      return;
    }

    messages.forEach(function (msg) {
      var wrapper = el('div', { className: 'msg-wrapper ' + msg.role });
      var inner = el('div', {});
      // アバターモード時にassistantバブルの上に名前を表示
      if (msg.role === 'assistant' && avatarProvider) {
        var nameLabel = el('div', { className: 'avatar-name-label' });
        nameLabel.textContent = currentAvatarName || 'AIアシスタント';
        inner.appendChild(nameLabel);
      }
      var bubble = el('div', { className: 'bubble ' + msg.role });
      // textContent を使用（innerHTML 禁止）
      bubble.textContent = msg.content;
      if (Array.isArray(msg.actions) && msg.actions.length > 0) {
        var actionsEl = el('div', { className: 'actions' });
        msg.actions.forEach(function (action) {
          if (!action || !action.url || !action.label) return;
          var actionBtn = el('button', {
            className: 'action-btn',
            type: 'button',
          });
          actionBtn.textContent = String(action.label);
          actionBtn.addEventListener('click', function () {
            try {
              window.open(String(action.url), '_blank', 'noopener,noreferrer');
            } catch (_e) {
              // ignore navigation failure
            }
          });
          actionsEl.appendChild(actionBtn);
        });
        if (actionsEl.childNodes.length > 0) {
          inner.appendChild(bubble);
          inner.appendChild(actionsEl);
        } else {
          inner.appendChild(bubble);
        }
      } else {
        inner.appendChild(bubble);
      }
      var ts = el('div', { className: 'ts' });
      ts.textContent = formatTime(msg.timestamp);
      inner.appendChild(ts);
      wrapper.appendChild(inner);
      messagesArea.appendChild(wrapper);
    });

    if (isLoading) {
      var loadingWrapper = el('div', { className: 'msg-wrapper assistant', role: 'status', 'aria-label': '返答を生成中' });
      var dotsEl = el('div', { className: 'loading-dots' });
      dotsEl.appendChild(el('div', { className: 'dot' }));
      dotsEl.appendChild(el('div', { className: 'dot' }));
      dotsEl.appendChild(el('div', { className: 'dot' }));
      loadingWrapper.appendChild(dotsEl);
      messagesArea.appendChild(loadingWrapper);
    }

    // DOM再構築後はscrollTopが0にリセットされるため、クリア前の状態に応じて強制スクロール
    if (wasNearBottom) {
      scrollToBottom(true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 8. postMessage: ホストサイトへのイベント発火                          */
  /* ------------------------------------------------------------------ */

  function emitToHost(type, payload) {
    var data = Object.assign({ source: 'faq-widget', type: type }, payload || {});
    // 許可 origin のみへ送信
    allowedOrigins.forEach(function (origin) {
      try {
        window.postMessage(data, origin);
      } catch (_e) {
        // 無効な origin は無視
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 9. パネル開閉                                                         */
  /* ------------------------------------------------------------------ */

  var avatarCacheKey = 'rajiuce-avatar-' + tenantId;

  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-label', 'チャットを閉じる');
    fab.setAttribute('aria-expanded', 'true');
    // パネル表示中はFABを非表示（パネル内の閉じるボタンで代替）
    fab.style.display = 'none';
    // SVG を閉じるアイコンに交換
    while (fab.firstChild) { fab.removeChild(fab.firstChild); }
    fab.appendChild(CLOSE_SVG.cloneNode(true));
    // アバタービデオをFABからavatarAreaへ移動
    if (fabVideoEl) {
      if (fabVideoEl.parentNode && fabVideoEl.parentNode !== avatarArea) {
        fabVideoEl.parentNode.removeChild(fabVideoEl);
      }
      if (fabVideoEl.parentNode !== avatarArea) {
        avatarArea.appendChild(fabVideoEl);
        if (avatarStatusText) avatarStatusText.style.display = 'none';
      }
    }
    textarea.focus();
    emitToHost('widget:opened', {});
    // 既存 Room が接続中ならエリアを再表示するだけ（再fetch・再接続しない）
    if (window.__rajiuceRoom && window.__rajiuceRoom.state === 'connected') {
      avatarArea.style.display = 'flex';
      panel.classList.add('avatar-active');
      document.body.style.overflow = 'hidden';
    } else {
      // avatarConfig が事前取得済み、またはセッションキャッシュがあれば即ダークUI適用
      var shouldDark = avatarConfig !== null;
      if (!shouldDark) {
        try { shouldDark = sessionStorage.getItem(avatarCacheKey) === 'true'; } catch (_e) {}
      }
      if (shouldDark) {
        avatarArea.style.display = 'flex';
        panel.classList.add('avatar-active');
        document.body.style.overflow = 'hidden';
      }
      fetchAvatarConfig();
    }
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-label', 'チャットを開く');
    fab.setAttribute('aria-expanded', 'false');
    // パネルを閉じたらFABを再表示
    fab.style.display = '';
    // アバタービデオをavatarAreaからFABへ移動（またはチャットアイコン表示）
    if (fabVideoEl) {
      // ビデオをavatarAreaから取り出してFABへ
      if (fabVideoEl.parentNode && fabVideoEl.parentNode !== fabMediaContainer) {
        fabVideoEl.parentNode.removeChild(fabVideoEl);
      }
      showFabMedia(fabVideoEl);
    } else {
      // アバターなし: チャットアイコン
      while (fab.firstChild) { fab.removeChild(fab.firstChild); }
      fab.appendChild(svgIcon(CHAT_SVG_PATH));
    }
    emitToHost('widget:closed', {});
    // LiveKit Room を切断（次回開閉時に新規接続で安定化）
    if (window.__rajiuceRoom) {
      try { window.__rajiuceRoom.disconnect(); } catch (_e) {}
      window.__rajiuceRoom = null;
    }
    // アバターUI要素を同期的にクリーンアップ
    // （Disconnected イベントは非同期のため、ここで先に削除しておく）
    var _cpClose = avatarArea.querySelectorAll('.avatar-close-btn');
    for (var _cpci = 0; _cpci < _cpClose.length; _cpci++) { _cpClose[_cpci].remove(); }
    var _cpMuteI = inputArea.querySelectorAll('.avatar-mute-btn');
    for (var _cpmi = 0; _cpmi < _cpMuteI.length; _cpmi++) { _cpMuteI[_cpmi].remove(); }
    var _cpMuteA = avatarArea.querySelectorAll('.avatar-mute-btn');
    for (var _cpaj = 0; _cpaj < _cpMuteA.length; _cpaj++) { _cpMuteA[_cpaj].remove(); }
    // Anam: ストリーミング停止
    if (avatarProvider === 'anam' && (anamClient || window.__anamClient)) {
      try {
        var _ac = anamClient || window.__anamClient;
        _ac.stopStreaming();
      } catch (_e) {}
    }
    panel.classList.remove('avatar-active');
    avatarArea.style.display = 'none';
    document.body.style.overflow = '';
  }

  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 10. API 呼び出し                                                      */
  /* ------------------------------------------------------------------ */

  function sendMessage(text) {
    if (!text || !text.trim() || isLoading) return;

    hideError();

    var userMsg = {
      id: generateMsgId(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };
    messages.push(userMsg);
    isLoading = true;
    renderMessages();
    scrollToBottom(true);  // ユーザー送信時は強制スクロール
    updateSendButton();
    textarea.disabled = true;

    emitToHost('user:message', { messageLength: text.length });

    // Anam アバター有効時 → Client-Side Custom LLM (Groq) で応答生成してTTSへ
    if (avatarProvider === 'anam' && (anamClient || window.__anamClient)) {
      // messages配列をそのまま渡してGroq→Anam TTSパイプラインへ
      handleAnamMessageUpdate(messages.map(function (m) {
        return { role: m.role, content: m.content };
      }));
      isLoading = false;
      textarea.disabled = false;
      renderMessages();
      updateSendButton();
      textarea.focus();
      return;
    }

    if (currentAbortController) {
      currentAbortController.abort();
    }
    currentAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    var historyForApi = messages.slice(-20).map(function (m) {
      return { role: m.role, content: m.content };
    });

    var requestBody = JSON.stringify({
      message: text.trim(),
      conversationId: conversationId,
      history: historyForApi,
      // Phase57: 行動コンテキスト注入のためvisitor_idを送信
      visitor_id: (_tracker && _tracker.visitorId) ? _tracker.visitorId : undefined,
    });

    var headers = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenantId,
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    var fetchOptions = {
      method: 'POST',
      headers: headers,
      body: requestBody,
    };
    if (currentAbortController) {
      fetchOptions.signal = currentAbortController.signal;
    }

    fetch(apiBase + '/api/chat', fetchOptions)
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            throw new Error(j.error || 'HTTP ' + res.status);
          });
        }
        return res.json();
      })
      .then(function (json) {
        if (json.error) throw new Error(json.error);

        var assistantContent = (json.data && json.data.content)
          ? json.data.content
          : '申し訳ありません。現在回答を生成できませんでした。再度お試しください。';

        var assistantMsg = {
          id: (json.data && json.data.id) || generateMsgId(),
          role: 'assistant',
          content: assistantContent,
          actions:
            json.data &&
            Array.isArray(json.data.actions)
              ? json.data.actions.map(function (action) {
                  return {
                    type: action && action.type ? String(action.type) : 'link',
                    label: action && action.label ? String(action.label) : '',
                    url: action && action.url ? String(action.url) : '',
                  };
                }).filter(function (action) {
                  return action.label.length > 0 && action.url.length > 0;
                })
              : undefined,
          timestamp: (json.data && json.data.timestamp) || Date.now(),
        };
        messages.push(assistantMsg);

        // アバター有効（LiveKit接続中）→ 応答テキストをTTSリクエストとして送信
        var lkRoom = window.__rajiuceRoom;
        console.log('[FAQ Widget] sendMessage after API: avatarProvider=' + avatarProvider + ' roomState=' + (lkRoom ? lkRoom.state : 'null') + ' hasParticipant=' + !!(lkRoom && lkRoom.localParticipant));
        if (avatarProvider === 'lemonslice' && lkRoom && lkRoom.localParticipant) {
          sendTTSRequest(assistantContent);
        }

        emitToHost('assistant:message', { messageLength: assistantContent.length });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showError('通信エラーが発生しました。しばらくしてから再試行してください。');
        emitToHost('widget:error', { error: err ? err.message : 'unknown' });
      })
      .finally(function () {
        isLoading = false;
        textarea.disabled = false;
        renderMessages();
        updateSendButton();
        textarea.focus();
      });
  }

  /* ------------------------------------------------------------------ */
  /* 11. イベントリスナー                                                  */
  /* ------------------------------------------------------------------ */

  fab.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', closePanel);
  dismissBtn.addEventListener('click', hideError);

  // メッセージエリアのスクロールをページに伝播させない
  messagesArea.addEventListener('touchmove', function (e) {
    e.stopPropagation();
  }, { passive: true });

  /* --- マイクボタン: Web Speech API 音声入力 --- */
  if (SpeechRecognitionAPI) {
    var isRecording = false;
    var currentRecognition = null;

    function _stopRecognition() {
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.setAttribute('aria-label', '音声入力');
      if (currentRecognition) {
        try { currentRecognition.stop(); } catch (_e) {}
        currentRecognition = null;
      }
      // 途中の interim テキストをクリア
      if (textarea.value) {
        textarea.value = '';
        autoResizeTextarea();
        updateSendButton();
      }
    }

    micBtn.addEventListener('click', function () {
      if (isRecording) {
        // OFF: 即時リセット（onend を待たない）
        _stopRecognition();
        return;
      }

      // ON: 即時 UI フィードバック（二重クリック防止）
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.setAttribute('aria-label', '録音中 — タップで停止');

      var recognition = new SpeechRecognitionAPI();
      recognition.lang = 'ja-JP';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      currentRecognition = recognition;

      recognition.onstart = function () {
        // UI は click 時に更新済み
      };

      recognition.onresult = function (event) {
        var interim = '';
        var finalText = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalText += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        // 途中結果を入力欄にプレビュー表示
        if (interim) {
          textarea.value = interim;
          autoResizeTextarea();
          updateSendButton();
        }
        // 確定結果 → 自動送信
        if (finalText.trim()) {
          textarea.value = '';
          autoResizeTextarea();
          updateSendButton();
          sendMessage(finalText.trim());
        }
      };

      recognition.onend = function () {
        isRecording = false;
        currentRecognition = null;
        micBtn.classList.remove('recording');
        micBtn.setAttribute('aria-label', '音声入力');
        // interim が残っていればクリア
        if (textarea.value) {
          textarea.value = '';
          autoResizeTextarea();
          updateSendButton();
        }
      };

      recognition.onerror = function (event) {
        var errCode = event && event.error;
        console.warn('[FAQ Widget] Speech recognition error:', errCode);
        isRecording = false;
        currentRecognition = null;
        micBtn.classList.remove('recording');
        micBtn.classList.add('error');
        setTimeout(function () { micBtn.classList.remove('error'); }, 500);
        micBtn.setAttribute('aria-label', '音声入力');
        var errMsg = errCode === 'not-allowed' || errCode === 'service-not-allowed'
          ? 'マイク権限が必要です（HTTPS環境でのみ利用可能）'
          : errCode === 'audio-capture'
            ? 'マイクが見つかりません'
            : errCode === 'network'
              ? 'ネットワークエラーが発生しました'
              : '音声認識に失敗しました';
        micBtn.setAttribute('title', errMsg);
      };

      try {
        recognition.start();
      } catch (e) {
        console.warn('[FAQ Widget] recognition.start() failed:', e && e.message);
        isRecording = false;
        currentRecognition = null;
        micBtn.classList.remove('recording');
        micBtn.classList.add('error');
        setTimeout(function () { micBtn.classList.remove('error'); }, 500);
        micBtn.setAttribute('title', '音声認識を開始できませんでした');
      }
    });
  }

  textarea.addEventListener('input', function () {
    autoResizeTextarea();
    updateSendButton();
  });

  var isComposing = false;
  textarea.addEventListener('compositionstart', function () { isComposing = true; });
  textarea.addEventListener('compositionend', function () { isComposing = false; });

  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isComposing) {
      e.preventDefault();
      var text = textarea.value;
      textarea.value = '';
      textarea.style.height = 'auto';
      sendMessage(text);
    }
  });

  sendBtn.addEventListener('click', function () {
    var text = textarea.value;
    textarea.value = '';
    textarea.style.height = 'auto';
    sendMessage(text);
  });

  /* ------------------------------------------------------------------ */
  /* 12. postMessage: ホストサイトからの制御コマンドを受信                   */
  /* ------------------------------------------------------------------ */

  window.addEventListener('message', function (event) {
    // origin 検証（必須）: allowedOrigins に含まれるオリジンのみ処理
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(event.origin)) {
      return;
    }

    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'faq-widget-host') {
      return;
    }

    switch (data.type) {
      case 'open':
        if (!isOpen) openPanel();
        break;
      case 'close':
        if (isOpen) closePanel();
        break;
      case 'toggle':
        togglePanel();
        break;
      default:
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* 13. ページ離脱時にLiveKit Roomを切断                                  */
  /* ------------------------------------------------------------------ */

  window.addEventListener('beforeunload', function () { cleanupLiveKit(); });

  /* ------------------------------------------------------------------ */
  /* 14. 公開 API（window.FaqWidget）                                     */
  /* ------------------------------------------------------------------ */

  window.FaqWidget = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    getTenantId: function () { return tenantId; },
  };

  // アバター設定を事前取得（パネルを開く前に完了させ、FABクリック時のフラッシュを防止）
  if (apiKey) { fetchAvatarConfig(); }

  /* ------------------------------------------------------------------ */
  /* 15. Phase55: 行動イベントトラッカー                                   */
  /* ------------------------------------------------------------------ */

  // EventTracker: バッファリング＆バッチ送信（5秒間隔）
  function EventTracker(apiKeyArg, apiBaseArg) {
    this.apiKey = apiKeyArg;
    this.apiBase = apiBaseArg;
    this.buffer = [];
    this.active = false;
    this.visitorId = this._getOrCreateVisitorId();
    this.sessionId = this._getOrCreateSessionId();
    this._flushTimer = null;
  }

  EventTracker.prototype._getOrCreateVisitorId = function () {
    try {
      var id = localStorage.getItem('r2c_vid');
      if (!id) { id = crypto.randomUUID(); localStorage.setItem('r2c_vid', id); }
      return id;
    } catch (_e) { return crypto.randomUUID(); }
  };

  EventTracker.prototype._getOrCreateSessionId = function () {
    try {
      var id = sessionStorage.getItem('r2c_sid');
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('r2c_sid', id); }
      return id;
    } catch (_e) { return crypto.randomUUID(); }
  };

  EventTracker.prototype.track = function (eventType, eventData) {
    if (!this.active) return;
    this.buffer.push({
      event_type: eventType,
      event_data: eventData || {},
      page_url: window.location.href.slice(0, 2048),
      referrer: (document.referrer || '').slice(0, 2048),
      timestamp: new Date().toISOString(),
    });
  };

  EventTracker.prototype.flush = function () {
    if (!this.active || this.buffer.length === 0) return;
    var events = this.buffer.slice(0, 50);
    this.buffer = this.buffer.slice(50);
    var self = this;
    fetch(self.apiBase + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': self.apiKey },
      body: JSON.stringify({
        visitor_id: self.visitorId,
        session_id: self.sessionId,
        events: events,
      }),
      keepalive: true,
    }).catch(function () { /* fire-and-forget */ });
  };

  EventTracker.prototype.start = function () {
    this.active = true;
    var self = this;
    this._flushTimer = setInterval(function () { self.flush(); }, 5000);
    this._startAutoTracking();
  };

  EventTracker.prototype._startAutoTracking = function () {
    var self = this;

    // page_view
    this.track('page_view', {
      url: window.location.href,
      referrer: document.referrer,
      utm_source: new URL(window.location.href).searchParams.get('utm_source'),
      utm_medium: new URL(window.location.href).searchParams.get('utm_medium'),
      utm_campaign: new URL(window.location.href).searchParams.get('utm_campaign'),
    });

    // scroll_depth (25%, 50%, 75%, 100%)
    var firedScrollThresholds = {};
    window.addEventListener('scroll', function () {
      var depth = Math.round(
        (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100
      );
      [25, 50, 75, 100].forEach(function (t) {
        if (depth >= t && !firedScrollThresholds[t]) {
          firedScrollThresholds[t] = true;
          self.track('scroll_depth', { depth_percent: t, page_url: window.location.href.slice(0, 2048) });
        }
      });
    }, { passive: true });

    // idle_time (10s, 30s, 60s)
    var idleSeconds = 0;
    var firedIdleThresholds = {};
    setInterval(function () {
      idleSeconds++;
      [10, 30, 60].forEach(function (t) {
        if (idleSeconds >= t && !firedIdleThresholds[t]) {
          firedIdleThresholds[t] = true;
          self.track('idle_time', { seconds: t, page_url: window.location.href.slice(0, 2048) });
        }
      });
    }, 1000);

    // exit_intent (マウスがブラウザ上端)
    var exitFired = false;
    document.addEventListener('mouseout', function (e) {
      if (e.clientY <= 0 && !exitFired) {
        exitFired = true;
        self.track('exit_intent', {
          page_url: window.location.href.slice(0, 2048),
          time_on_page_sec: idleSeconds,
        });
        self.flush(); // 離脱前に即送信
      }
    });

    // product_view (JSON-LD自動抽出)
    var jsonLd = document.querySelector('script[type="application/ld+json"]');
    if (jsonLd) {
      try {
        var ldData = JSON.parse(jsonLd.textContent);
        if (ldData['@type'] === 'Product') {
          this.track('product_view', {
            product_name: (ldData.name || '').slice(0, 256),
            price: ldData.offers ? ldData.offers.price : undefined,
            category: (ldData.category || '').slice(0, 128),
          });
        }
      } catch (_e) { /* ignore */ }
    }

    // ページ離脱時にflush
    window.addEventListener('beforeunload', function () { self.flush(); });
  };

  // Phase56: TriggerEngine — プロアクティブエンゲージメント（LLM不使用）
  function TriggerEngine(tracker) {
    this.tracker = tracker;
    this.rules = [];
    this.firedRuleIds = new Set();
    this.suppressedUntil = 0;
  }

  TriggerEngine.prototype.loadRules = function () {
    var self = this;
    try {
      var cached = sessionStorage.getItem('r2c_rules');
      var cacheTs = sessionStorage.getItem('r2c_rules_ts');
      if (cached && cacheTs && Date.now() - Number(cacheTs) < 300000) {
        self.rules = JSON.parse(cached);
        return Promise.resolve();
      }
    } catch (_e) {}
    return fetch(self.tracker.apiBase + '/api/engagement/rules', {
      headers: { 'x-api-key': self.tracker.apiKey },
    })
      .then(function (r) { return r.ok ? r.json() : { rules: [] }; })
      .then(function (data) {
        self.rules = data.rules || [];
        try {
          sessionStorage.setItem('r2c_rules', JSON.stringify(self.rules));
          sessionStorage.setItem('r2c_rules_ts', String(Date.now()));
        } catch (_e) {}
      })
      .catch(function () { /* ignore */ });
  };

  TriggerEngine.prototype.checkRules = function (context) {
    if (Date.now() < this.suppressedUntil) return null;
    for (var i = 0; i < this.rules.length; i++) {
      var rule = this.rules[i];
      if (this.firedRuleIds.has(rule.id)) continue;
      var matched = false;
      switch (rule.trigger_type) {
        case 'scroll_depth':
          matched = context.scroll_depth >= rule.trigger_config.threshold;
          break;
        case 'idle_time':
          matched = context.idle_seconds >= rule.trigger_config.seconds;
          break;
        case 'exit_intent':
          matched = !!context.is_exit_intent;
          break;
        case 'page_url_match':
          matched = this._matchUrl(window.location.href, rule.trigger_config.pattern);
          break;
      }
      if (matched) {
        this.firedRuleIds.add(rule.id);
        return rule;
      }
    }
    return null;
  };

  TriggerEngine.prototype._matchUrl = function (url, pattern) {
    try {
      var pathname = new URL(url).pathname;
      var regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      return regex.test(pathname);
    } catch (_e) { return false; }
  };

  TriggerEngine.prototype.onRuleFired = function (rule) {
    if (this.tracker) {
      this.tracker.track('chat_open', { trigger: 'proactive', trigger_rule_id: rule.id });
      this.tracker.flush();
    }
    // ウィジェットを自動オープン
    if (!isOpen) openPanel();
    // プロアクティブメッセージをアシスタントバブルとして挿入
    var proactiveMsg = {
      id: 'proactive-' + rule.id,
      role: 'assistant',
      content: rule.message_template,
      timestamp: Date.now(),
    };
    messages.push(proactiveMsg);
    renderMessages();
  };

  TriggerEngine.prototype.onWidgetClosed = function () {
    this.suppressedUntil = Date.now() + 30 * 60 * 1000;
  };

  // Phase55: features.event_tracking が true のテナントのみ有効化
  var _tracker = null;
  var _triggerEngine = null;
  if (apiKey) {
    fetch(apiBase + '/api/widget/features', {
      headers: { 'x-api-key': apiKey },
    })
      .then(function (r) { return r.ok ? r.json() : { event_tracking: false }; })
      .then(function (cfg) {
        if (!cfg.event_tracking) return;
        _tracker = new EventTracker(apiKey, apiBase);
        _tracker.start();

        // TriggerEngine 初期化
        _triggerEngine = new TriggerEngine(_tracker);
        _triggerEngine.loadRules().then(function () {
          // page_url_match: ルール読み込み後すぐにチェック
          if (_triggerEngine.rules.length > 0) {
            var matchedRule = _triggerEngine.checkRules({
              scroll_depth: 0,
              idle_seconds: 0,
              is_exit_intent: false,
            });
            if (matchedRule) _triggerEngine.onRuleFired(matchedRule);
          }
        });

        // close ボタンに suppressionフック
        closeBtn.addEventListener('click', function () {
          if (_triggerEngine) _triggerEngine.onWidgetClosed();
        });

        // chat_open / chat_message イベントをwidgetに紐付け
        var _origOpen = window.FaqWidget.open;
        window.FaqWidget.open = function () {
          if (_tracker) _tracker.track('chat_open', { page_url: window.location.href.slice(0, 2048) });
          return _origOpen.apply(this, arguments);
        };
        var _origOpenPanel = openPanel;
        openPanel = function () {
          if (_tracker) _tracker.track('chat_open', { page_url: window.location.href.slice(0, 2048) });
          return _origOpenPanel.apply(this, arguments);
        };

        // scroll/idle/exit イベント時にトリガーチェック（_startAutoTracking後に追加）
        var _scrollDepthCurrent = 0;
        var _idleSecondsCurrent = 0;
        window.addEventListener('scroll', function () {
          _scrollDepthCurrent = Math.round(
            (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100
          );
          if (_triggerEngine && _triggerEngine.rules.length > 0) {
            var rule = _triggerEngine.checkRules({
              scroll_depth: _scrollDepthCurrent,
              idle_seconds: _idleSecondsCurrent,
              is_exit_intent: false,
            });
            if (rule) _triggerEngine.onRuleFired(rule);
          }
        }, { passive: true });

        setInterval(function () {
          _idleSecondsCurrent++;
          if (_triggerEngine && _triggerEngine.rules.length > 0) {
            var rule = _triggerEngine.checkRules({
              scroll_depth: _scrollDepthCurrent,
              idle_seconds: _idleSecondsCurrent,
              is_exit_intent: false,
            });
            if (rule) _triggerEngine.onRuleFired(rule);
          }
        }, 1000);

        document.addEventListener('mouseout', function (e) {
          if (e.clientY <= 0 && _triggerEngine && _triggerEngine.rules.length > 0) {
            var rule = _triggerEngine.checkRules({
              scroll_depth: _scrollDepthCurrent,
              idle_seconds: _idleSecondsCurrent,
              is_exit_intent: true,
            });
            if (rule) _triggerEngine.onRuleFired(rule);
          }
        });
      })
      .catch(function () { /* feature check失敗は無視 */ });
  }

  // ─── R2C Conversion Tracking API ─────────────────────────────────────────
  // パートナーが購入完了ページ等で呼び出す: window.r2c.trackConversion('purchase', 50000)
  window.r2c = window.r2c || {};
  window.r2c.trackConversion = function(conversionType, conversionValue) {
    if (!conversionType) {
      console.warn('[R2C] trackConversion: conversionType is required');
      return;
    }
    var visitorId = '';
    var sessionId = '';
    try { visitorId = localStorage.getItem('r2c_vid') || ''; } catch (_e) {}
    try { sessionId = sessionStorage.getItem('r2c_sid') || ''; } catch (_e) {}

    var payload = {
      visitor_id: visitorId || 'unknown',
      session_id: sessionId || 'unknown',
      events: [{
        event_type: 'chat_conversion',
        event_data: {
          conversion_type: conversionType,
          conversion_value: (typeof conversionValue === 'number') ? conversionValue : null
        },
        page_url: location.href,
        referrer: document.referrer
      }]
    };

    fetch(apiBase + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(function(response) {
      if (!response.ok) {
        console.warn('[R2C] trackConversion: server returned ' + response.status);
      }
    }).catch(function() { /* silent fail */ });
  };

  // r2cQueue drain: async読み込みで先にキューに積まれたイベントを処理する
  if (window.r2cQueue && Array.isArray(window.r2cQueue)) {
    window.r2cQueue.forEach(function(item) {
      if (item.type === 'conversion') {
        window.r2c.trackConversion(item.conversionType, item.value);
      }
    });
    window.r2cQueue = null;
  }

})();
