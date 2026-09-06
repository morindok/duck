// ============================================
// duck.ai -> duck-ai-proxy header forwarder
// ============================================
// HOW TO USE:
// 1. Open https://duck.ai in your browser
// 2. Open DevTools console (F12 -> Console)
// 3. Paste this whole script and press Enter
// 4. Send a message in duck.ai — the script will
//    auto-forward fresh x-vqd-hash-1 and x-fe-signals
//    headers to the local proxy (127.0.0.1:8121)
// Keep this tab open while using opencode.
// ============================================
(function () {
  const PROXY = 'http://127.0.0.1:8121';

  async function forwardHeaders(headers) {
    const hash = headers.get('x-vqd-hash-1');
    const sig = headers.get('x-fe-signals');
    try {
      if (hash) {
        await fetch(PROXY + '/set-hash', { method: 'POST', mode: 'no-cors', body: hash });
        console.log('[duck-hook] forwarded x-vqd-hash-1 (' + hash.length + ' chars)');
      }
      if (sig) {
        await fetch(PROXY + '/set-signals', { method: 'POST', mode: 'no-cors', body: sig });
        console.log('[duck-hook] forwarded x-fe-signals');
      }
    } catch (e) {
      console.warn('[duck-hook] forward failed (proxy running?):', e.message);
    }
  }

  // Hook fetch to catch chat requests with fresh headers
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/duckchat/v1/')) {
        const h = new Headers((init && init.headers) || (input && input.headers) || []);
        await forwardHeaders(h);
      }
    } catch (e) { /* ignore hook errors */ }
    return origFetch.apply(this, arguments);
  };

  // Hook XMLHttpRequest too (in case duck.ai uses XHR)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const captured = {};
  XMLHttpRequest.prototype.open = function (method, url) {
    this._duckUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this._duckUrl && String(this._duckUrl).includes('/duckchat/v1/')) {
        captured[name] = value;
        if (name === 'x-fe-signals') forwardHeaders(new Headers(captured));
      }
    } catch (e) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };

  console.log('[duck-hook] installed ✓ — send a chat message in duck.ai now.');
  console.log('[duck-hook] fresh x-vqd-hash-1 headers will auto-forward to ' + PROXY);
})();
