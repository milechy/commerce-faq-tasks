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
    '  min-width: 56px;',
    '  min-height: 56px;',
    '  width: 56px;',
    '  height: 56px;',
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
    '  transition: ' + (prefersReducedMotion ? 'none' : 'transform 0.15s, box-shadow 0.15s') + ';',
    '}',
    '.fab:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(37,99,235,0.5); }',
    '.fab:active { transform: scale(0.95); }',
    '.fab:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }',

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

  /* --- メッセージエリア --- */
  var messagesArea = el('div', { className: 'messages', role: 'log', 'aria-live': 'polite', 'aria-label': 'チャット履歴' });
  var emptyStateEl = el('div', { className: 'empty-state' }, 'ご質問をどうぞ。お気軽にお聞きください。');
  messagesArea.appendChild(emptyStateEl);
  panel.appendChild(messagesArea);

  /* --- 入力エリア --- */
  var textarea = el('textarea', {
    placeholder: 'メッセージを入力… (Shift+Enterで改行)',
    rows: '1',
    maxlength: '2000',
    'aria-label': 'メッセージ',
  });
  var sendBtn = el('button', { className: 'send-btn', type: 'button', 'aria-label': '送信', disabled: 'true' });
  sendBtn.appendChild(SEND_SVG.cloneNode(true));
  var inputArea = el('div', { className: 'input-area', role: 'form', 'aria-label': 'メッセージ入力フォーム' }, [textarea, sendBtn]);
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
  var conversationId = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
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

  function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function renderMessages() {
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
      var bubble = el('div', { className: 'bubble ' + msg.role });
      // textContent を使用（innerHTML 禁止）
      bubble.textContent = msg.content;
      var ts = el('div', { className: 'ts' });
      ts.textContent = formatTime(msg.timestamp);
      inner.appendChild(bubble);
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

    scrollToBottom();
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

  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-label', 'チャットを閉じる');
    fab.setAttribute('aria-expanded', 'true');
    // SVG を閉じるアイコンに交換
    while (fab.firstChild) { fab.removeChild(fab.firstChild); }
    fab.appendChild(CLOSE_SVG.cloneNode(true));
    textarea.focus();
    emitToHost('widget:opened', {});
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-label', 'チャットを開く');
    fab.setAttribute('aria-expanded', 'false');
    // SVG をチャットアイコンに交換
    while (fab.firstChild) { fab.removeChild(fab.firstChild); }
    fab.appendChild(svgIcon(CHAT_SVG_PATH));
    emitToHost('widget:closed', {});
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
    updateSendButton();
    textarea.disabled = true;

    emitToHost('user:message', { messageLength: text.length });

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
    });

    var fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // tenantId は X-Tenant-ID ヘッダで送信（body から禁止）
        'X-Tenant-ID': tenantId,
      },
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
          timestamp: (json.data && json.data.timestamp) || Date.now(),
        };
        messages.push(assistantMsg);

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

  textarea.addEventListener('input', function () {
    autoResizeTextarea();
    updateSendButton();
  });

  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
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
  /* 13. 公開 API（window.FaqWidget）                                     */
  /* ------------------------------------------------------------------ */

  window.FaqWidget = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    getTenantId: function () { return tenantId; },
  };

})();
