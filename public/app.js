/* ============================================================
   Aaron AI Chat — Frontend Application Logic
   Author: Aaron Lee F. Angeles
   ------------------------------------------------------------
   - Maintains in-memory session history (system/user/assistant).
   - Streams tokens from the backend SSE endpoint using fetch +
     ReadableStream (the browser EventSource API cannot POST).
   - Renders AI output as Markdown (Marked) with syntax
     highlighting (highlight.js).
   - DOMPurify sanitisation on all AI markdown output.
   - Stop-generating button to abort the streaming response.
   - Copy-to-clipboard buttons on all code blocks.
   - Smart scroll: pauses auto-scroll when user scrolls up.
   - Context-window enforcement (12 message cap, oldest trimmed).
   ============================================================ */

'use strict';

(function () {
  'use strict';

  /* ── CDN library availability flags ────────────────────── */
  const markedAvailable   = typeof marked   !== 'undefined';
  const hljsAvailable     = typeof hljs     !== 'undefined';
  const dompurifyAvailable = typeof DOMPurify !== 'undefined';

  /* ── API endpoints ──────────────────────────────────────── */
  var API_CHAT_URL   = '/api/chat';
  var API_HEALTH_URL = '/api/health';

  /* ── Markdown renderer ──────────────────────────────────── */
  if (markedAvailable && hljsAvailable) {
    marked.setOptions({
      gfm:    true,
      breaks: true,
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
    });
  }

  /* ── DOM references ─────────────────────────────────────── */
  var el = {
    messages:       document.getElementById('messages'),
    sidebar:        document.getElementById('sidebar'),
    sidebarContent: document.getElementById('sidebar-content'),
    menuToggle:     document.getElementById('menu-toggle'),
    modelNameEl:    document.getElementById('model-name'),
    chatInput:      document.getElementById('chat-input'),
    sendBtn:        document.getElementById('send-btn'),
    stopBtn:        document.getElementById('stop-btn'),
    charCount:      document.getElementById('char-count'),
    newChatBtn:     document.getElementById('new-chat-btn'),
    overlay:        document.getElementById('overlay'),
    tokenEstimate:  document.getElementById('token-estimate'),
  };

  /* ── Application state ─────────────────────────────────── */
  /** @type {Map<string, Array<{role:string,content:string}>>} */
  var histories        = new Map();
  var activeId         = null;
  var isStreaming      = false;
  var streamAbortController      = null;   // AbortController for current stream
  var MAX_MESSAGES     = 12;    // context-window cap
  var userScrolledUp   = false; // true when user scrolled history up

  /* ── Persistence helpers ────────────────────────────────── */
  function persist() {
    try {
      var data = JSON.stringify(Object.fromEntries(histories));
      localStorage.setItem('aaron_histories', data);
      localStorage.setItem('aaron_active',    activeId || '');
    } catch (_) { /* quota or private mode */ }
  }

  function loadPersisted() {
    try {
      var raw = localStorage.getItem('aaron_histories');
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var k in parsed) histories.set(k, parsed[k]);
      }
      activeId = localStorage.getItem('aaron_active') || null;
    } catch (_) { /* corrupted data */ }
  }

  /* ── ID / history helpers ──────────────────────────────── */
  function nowId() {
    return 'c_' + Date.now().toString(36);
  }

  /**
   * Enforce MAX_MESSAGES by trimming oldest system/user/assistant
   * rounds from the head of the active conversation, keeping the
   * system prompt at index 0.
   */
  function enforceContextWindow() {
    var hist = histories.get(activeId);
    if (!hist || hist.length <= MAX_MESSAGES) return;
    var excess = hist.length - MAX_MESSAGES;
    hist.splice(1, excess);
  }

  function newConversation() {
    var id = nowId();
    histories.set(id, []);
    activeId = id;
    persist();
    renderHistory();
    renderConversation();
    return id;
  }

  function activeConversation() {
    if (!activeId || !histories.has(activeId)) {
      activeId = newConversation();
    }
    return histories.get(activeId);
  }

  function setActive(id) {
    activeId = id;
    persist();
    renderConversation();
    closeSidebar();
  }

  /* ── Sidebar / history list ─────────────────────────────── */
  function renderHistory() {
    var frag = document.createDocumentFragment();
    for (var _i = 0, _arr = Array.from(histories.entries()); _i < _arr.length; _i++) {
      var pair = _arr[_i];
      var id   = pair[0];
      var hist = pair[1];
      var preview = (function () {
        for (var _j = 0, _h = hist; _j < _h.length; _j++) {
          var m = _h[_j];
          if (m.role === 'user') return m.content.slice(0, 40);
        }
        return 'Empty conversation';
      })();

      var div = document.createElement('div');
      div.className = 'history-item' + (id === activeId ? ' active' : '');
      div.dataset.id = id;
      div.innerHTML =
        '<span class="history-preview">' + escHtml(preview) + '</span>' +
        '<button class="history-delete" title="Delete">&#10005;</button>';
      div.querySelector('.history-delete').addEventListener('click', function (e) {
        e.stopPropagation();
        deleteConversation(this.closest('.history-item').dataset.id);
      }.bind(id));
      div.addEventListener('click', setActive.bind(null, id));
      frag.appendChild(div);
    }
    el.sidebarContent.replaceChildren(frag);
  }

  function deleteConversation(id) {
    histories.delete(id);
    var keys = Array.from(histories.keys());
    if (activeId === id) activeId = keys[0] || null;
    if (!activeId) newConversation();
    persist();
    renderHistory();
    renderConversation();
  }

  /* ── Conversation view ─────────────────────────────────── */
  function renderConversation() {
    el.messages.replaceChildren();
    var hist = activeConversation();
    for (var _k = 0, _hist = hist; _k < _hist.length; _k++) {
      var msg = _hist[_k];
      appendMessage(msg.role, msg.content, false);
    }
    scrollToBottom(false);
  }

  function appendMessage(role, content, animate) {
    animate = animate !== false;
    var container = document.createElement('div');
    container.className = 'message ' + role;
    if (animate) container.classList.add('animating');

    if (role === 'user') {
      container.textContent = content;
    } else {
      var inner = document.createElement('div');
      inner.className = 'markdown-body';
      container.appendChild(inner);
      renderMarkdown(inner, content);
    }

    el.messages.appendChild(container);
    if (!userScrolledUp) scrollToBottom(true);

    if (animate) {
      requestAnimationFrame(function () {
        container.classList.remove('animating');
      });
    }
  }

  /* ── Markdown rendering pipeline ────────────────────────── */
  function renderMarkdown(container, markdown) {
    if (!markdown) { container.replaceChildren(); return; }
    var html = '';

    if (markedAvailable) {
      try { html = marked.parse(markdown); }
      catch (_) { html = escHtml(markdown).replace(/\n/g, '<br>'); }
    } else {
      html = escHtml(markdown).replace(/\n/g, '<br>');
      container.textContent = markdown;
    }

    if (dompurifyAvailable) {
      html = DOMPurify.sanitize(html, {
        ADD_TAGS: ['button'],
        ADD_ATTR: ['class', 'data-lang'],
      });
    }

    container.innerHTML = html;
    if (markedAvailable) highlightCodeBlocks(container);
    attachCopyButtons(container);
  }

  /* ── Syntax highlighting ───────────────────────────────── */
  function highlightCodeBlocks(container) {
    if (!hljsAvailable) return;
    var blocks = container.querySelectorAll('pre code');
    for (var _l = 0, _blocks = blocks; _l < _blocks.length; _l++) {
      var block = _blocks[_l];
      var lang = block.className.replace('language-', '') || null;
      var highlighted;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(block.textContent, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(block.textContent).value;
      }
      block.innerHTML = highlighted;
        block.dataset.highlighted = 'true';
    }
  }

  /* ── Copy-to-clipboard on code blocks ──────────────────── */
  function attachCopyButtons(container) {
    var pres = container.querySelectorAll('pre');
    for (var _m = 0, _pres = pres; _m < _pres.length; _m++) {
      var pre = _pres[_m];
      if (pre.querySelector('.copy-btn')) continue;

      var btn = document.createElement('button');
      btn.className   = 'copy-btn';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');

      btn.addEventListener('click', function (btnEl, preEl) {
        return function () {
          var codeEl = preEl.querySelector('code');
          var text   = codeEl ? codeEl.textContent : preEl.textContent;
          navigator.clipboard.writeText(text).then(function () {
            btnEl.textContent = 'Copied!';
            btnEl.classList.add('copied');
            setTimeout(function () {
              btnEl.textContent = 'Copy';
              btnEl.classList.remove('copied');
            }, 2000);
          }).catch(function () {
            btnEl.textContent = 'Failed';
            setTimeout(function () { btnEl.textContent = 'Copy'; }, 2000);
          });
        };
      }(btn, pre));

      pre.style.position = 'relative';
      pre.appendChild(btn);
    }
  }

  /* ── Scroll management ─────────────────────────────────── */
  function scrollToBottom(smooth) {
    if (!el.messages) return;
    el.messages.scrollTo({
      top:      el.messages.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
  }

  function handleScroll() {
    if (!el.messages) return;
    var dist = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
    userScrolledUp = dist > 80;
  }

  el.messages.addEventListener('scroll', handleScroll, { passive: true });

  /* ── Stop generating ────────────────────────────────────── */
  function stopGenerating() {
    if (streamAbortController) {
      streamAbortController.abort();
      streamAbortController = null;
    }
    isStreaming = false;
    updateSendState();
  }

  /* ── Main send handler ─────────────────────────────────── */
  async function sendMessage() {
    var text = el.chatInput.value.trim();
    if (!text || isStreaming) return;

    enforceContextWindow();

    var hist = activeConversation();
    hist.push({ role: 'user', content: text });

    appendMessage('user', text);
    el.chatInput.value = '';
    updateCharCount();
    autoResize();
    persist();

    userScrolledUp = false;
    isStreaming     = true;
    updateSendState();
    scrollToBottom(true);

    streamAbortController = new AbortController();

    var aiContainer = document.createElement('div');
    aiContainer.className = 'message assistant animating';
    var aiInner = document.createElement('div');
    aiInner.className = 'markdown-body';
    aiContainer.appendChild(aiInner);
    el.messages.appendChild(aiContainer);

    var fullText = '';

    try {
      var response = await fetch(API_CHAT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: hist }),
        signal:  streamAbortController.signal,
      });

      if (!response.ok) {
        var errData;
        try { errData = await response.json(); } catch (_) { errData = {}; }
        throw new Error(errData.error || ('HTTP ' + response.status + ': ' + response.statusText));
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var remainder = '';

      userScrolledUp = false;

      /* The server emits NAMED SSE events (see server.js `send()`):
       *     event: delta   data: {"token":"..."}
       *     event: done    data: {}
       *     event: error   data: {"message":"..."}
       * plus `: ping` keep-alive comments. Earlier this loop tried to read
       * raw OpenAI chunks (parsed.choices[0].delta.content), which this
       * wire format never contains — so no token ever rendered.
       * `currentEvent` lives outside the read loop because an `event:` line
       * and its `data:` line can land in different network chunks. */
      var currentEvent = 'message';

      streamLoop:
      while (true) {
        var _ref = await reader.read();
        var done  = _ref.done;
        var value = _ref.value;
        if (done) break;

        remainder += decoder.decode(value, { stream: true });
        var lines = remainder.split('\n');
        remainder = lines.pop() || '';

        for (var _n = 0, _lines = lines; _n < _lines.length; _n++) {
          var line = _lines[_n].replace(/\r$/, '');

          if (line.startsWith(':')) continue;               // keep-alive comment

          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }

          if (!line.startsWith('data: ')) continue;
          var data = line.slice(6).trim();
          if (data === '[DONE]') break streamLoop;

          var parsed;
          try { parsed = JSON.parse(data); } catch (_) { continue; }

          if (currentEvent === 'error' || parsed.error) {
            throw new Error(parsed.message || parsed.error || 'Unknown stream error');
          }

          if (currentEvent === 'done') break streamLoop;

          // Server format first, raw OpenAI shape kept as a fallback so the
          // client still works if pointed straight at an upstream provider.
          var token = typeof parsed.token === 'string'
            ? parsed.token
            : (parsed.choices && parsed.choices[0] && parsed.choices[0].delta
              ? parsed.choices[0].delta.content
              : null);
          if (!token) continue;

          fullText += token;
          renderMarkdown(aiInner, fullText);
          if (!userScrolledUp) scrollToBottom(false);
        }
      }

      hist.push({ role: 'assistant', content: fullText });
      enforceContextWindow();
      persist();
      renderHistory();

    } catch (err) {
      if (err.name === 'AbortError' || (streamAbortController && streamAbortController.signal.aborted)) {
        aiContainer.remove();
      } else {
        aiInner.innerHTML =
          '<p class="error-inline">&#9888; ' + escHtml(err.message) + '</p>';
      }
    } finally {
      isStreaming = false;
      streamAbortController = null;
      updateSendState();
      aiContainer.classList.remove('animating');
      if (!userScrolledUp) scrollToBottom(true);
    }
  }

  /* ── Utility ────────────────────────────────────────────── */
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function removeCaret() {
    var s = window.getSelection();
    if (s && s.rangeCount > 0 && s.toString().trim() === '') {
      var r = s.getRangeAt(0);
      if (r.collapsed) {
        var nr = document.createRange();
        nr.selectNodeContents(el.messages);
        nr.collapse(false);
        s.removeAllRanges();
        s.addRange(nr);
      }
    }
  }

  function updateCharCount() {
    if (!el.charCount) return;
    el.charCount.textContent = el.chatInput.value.length + ' char' +
      (el.chatInput.value.length !== 1 ? 's' : '');
  }

  function autoResize() {
    if (!el.chatInput) return;
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 240) + 'px';
  }

  /** Toggle send/stop button visibility based on streaming state. */
  function updateSendState() {
    var hasText = el.chatInput.value.trim().length > 0;
    el.sendBtn.disabled  = !hasText || isStreaming;
    el.stopBtn.style.display = isStreaming ? 'inline-flex' : 'none';
    el.sendBtn.style.display = isStreaming ? 'none'        : 'inline-flex';
  }

  /* ── Sidebar ─────────────────────────────────────────────── */
  function closeSidebar() {
    if (el.sidebar)  el.sidebar.classList.remove('open');
    if (el.overlay)  el.overlay.classList.remove('active');
  }

  function openSidebar() {
    if (el.sidebar)  el.sidebar.classList.add('open');
    if (el.overlay)  el.overlay.classList.add('active');
    renderHistory();
  }

  /* ── Model name loader ──────────────────────────────────── */
  async function loadModelName() {
    if (!el.modelNameEl) return;
    try {
      var res = await fetch(API_HEALTH_URL);
      if (res.ok) {
        var data = await res.json();
        if (data.model) el.modelNameEl.textContent = data.model;
      }
    } catch (_) { /* keep default */ }
  }

  /* ── Event listeners ─────────────────────────────────────── */
  el.sendBtn.addEventListener('click', sendMessage);

  el.chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      removeCaret();
      sendMessage();
    }
  });

  el.chatInput.addEventListener('input', function () {
    autoResize();
    updateCharCount();
    updateSendState();
  });

  el.newChatBtn.addEventListener('click', function () {
    newConversation();
    closeSidebar();
  });

  el.stopBtn.addEventListener('click', stopGenerating);

  if (el.menuToggle) {
    el.menuToggle.addEventListener('click', function () {
      if (el.sidebar && el.sidebar.classList.contains('open')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (el.overlay) {
    el.overlay.addEventListener('click', closeSidebar);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSidebar();
  });

  /* ── Init ────────────────────────────────────────────────── */
  loadPersisted();
  if (!activeId || !histories.has(activeId)) newConversation();
  else renderHistory();
  renderConversation();
  updateSendState();
  loadModelName();

})();