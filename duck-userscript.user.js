// ==UserScript==
// @name         duck.ai -> duck-ai-proxy header forwarder
// @namespace    local.duckproxy
// @version      1.0
// @description  Forwards fresh x-vqd-hash-1 / x-fe-signals headers from duck.ai chat to local proxy
// @match        https://duck.ai/*
// @match        https://duckduckgo.com/?q=*&ia=chat*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  const PROXY = 'http://127.0.0.1:8121';
  let lastHash = '';

  function gmPost(path, body) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: PROXY + path,
      data: body,
      headers: { 'Content-Type': 'text/plain' },
      onload: () => console.log('[duck-hook] forwarded ' + path + ' (' + String(body).length + ' chars)'),
      onerror: (e) => console.warn('[duck-hook] forward failed for ' + path + ' — proxy running?', e),
    });
  }

  function forward(hash, sig, reqBody) {
    if (hash && hash !== lastHash) {
      lastHash = hash;
      gmPost('/set-hash', hash);
    }
    if (sig) gmPost('/set-signals', sig);
    if (reqBody) gmPost('/set-last-body', typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody));
  }

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/duckchat/v1/chat')) {
        const h = new Headers((init && init.headers) || (input && input.headers) || []);
        let body = init && init.body;
        if (!body && input && input.body) body = input.body;
        forward(h.get('x-vqd-hash-1'), h.get('x-fe-signals'), body);
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // Hook XHR as fallback
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const captured = {};
  XMLHttpRequest.prototype.open = function (m, url) {
    this._duckUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this._duckUrl && String(this._duckUrl).includes('/duckchat/v1/')) {
        captured[name] = value;
        if (name === 'x-fe-signals') forward(captured['x-vqd-hash-1'], value);
      }
    } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };

  console.log('[duck-hook] userscript installed — send a chat message in duck.ai now.');
})();
