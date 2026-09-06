// duck-ai-proxy: DuckDuckGo AI Chat -> OpenAI-compatible API
// No login needed. If duck.ai serves a bot challenge, solve it manually in your
// browser and paste the x-vqd-4 token into token.txt (or POST /set-token).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

// Detect Windows system HTTP proxy (e.g. Clash/v2ray on dynamic port) so Node's
// fetch can reach duckduckgo.com. Falls back to direct connection.
function detectSystemProxy() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!m) return null;
    const raw = m[1];
    let host = null;
    const https = raw.match(/https=([^;]+)/);
    const httpm = raw.match(/(?:^|;)http=([^;]+)/);
    if (https) host = https[1];
    else if (httpm) host = httpm[1];
    else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(raw)) host = raw;
    if (host) {
      setGlobalDispatcher(new ProxyAgent('http://' + host));
      console.log('[duck-proxy] using system proxy:', host);
      return host;
    }
  } catch (e) {
    console.log('[duck-proxy] no system proxy detected, connecting directly');
  }
  return null;
}
detectSystemProxy();

const PORT = process.env.PORT || 8121;
const TOKEN_FILE = path.join(__dirname, 'token.txt');

const MODELS = {
  'duck/gpt-4o-mini': 'gpt-4o-mini',
  'duck/claude-3-haiku': 'claude-3-haiku-20240307',
  'duck/claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'duck/claude-3-5-sonnet': 'claude-3-5-sonnet-latest',
  'duck/llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'duck/mistral-small-3': 'mistralai/Mistral-Small-24B-Instruct-2501',
  'duck/o3-mini': 'o3-mini',
};
const ALIAS_TO_ID = {};
for (const [id, real] of Object.entries(MODELS)) ALIAS_TO_ID[real] = id;

let manualToken = null;
let manualSignals = null;
try { manualToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch {}
try { manualSignals = fs.readFileSync(path.join(__dirname, 'signals.txt'), 'utf8').trim() || null; } catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const vm = require('vm');

// DOM/browser shims so the obfuscated challenge script runs headlessly.
function makeChallengeContext() {
  const styleShim = { cssText: '' };
  const iframeShim = {
    srcdoc: '', sandbox: '', title: '',
    style: styleShim,
    setAttribute() {}, getAttribute() { return null; },
    contentWindow: { self: { contentDocument: { get: () => null } } },
    contentDocument: null,
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => iframeShim,
    body: { appendChild() {}, removeChild() {} },
  };
  const window = { document, Promise, JSON, Array, Object, String, Number };
  window.top = window; window.self = window; window.window = window;
  return vm.createContext(Object.assign({ navigator: { userAgent: UA, webdriver: false }, console }, window));
}

// Run the x-vqd-hash-1 challenge loop until the server issues a real x-vqd-4.
async function solveChallenge(baseHeaders) {
  let headers = Object.assign({}, baseHeaders);
  for (let round = 1; round <= 8; round++) {
    const res = await fetch('https://duckduckgo.com/duckchat/v1/status', {
      dispatcher: undefined,
      signal: AbortSignal.timeout(20000),
      headers,
    });
    const tok = res.headers.get('x-vqd-4');
    if (tok) {
      console.log('[duck-proxy] x-vqd-4 acquired after', round, 'round(s)');
      return tok;
    }
    const hash1 = res.headers.get('x-vqd-hash-1');
    if (!hash1) throw new Error('challenge: no x-vqd-4 and no x-vqd-hash-1 (round ' + round + ')');
    const script = Buffer.from(hash1, 'base64').toString('utf8');
    let answer;
    try {
      answer = await vm.runInContext(script, makeChallengeContext(), { timeout: 5000 });
    } catch (e) {
      throw new Error('challenge: auto-solve failed (' + (e.message || e) + '). Get x-vqd-4 manually: open https://duck.ai in your browser, F12 -> Network -> request to duckchat -> copy the x-vqd-4 request header, then paste it at http://127.0.0.1:8121/');
    }
    headers = Object.assign({}, baseHeaders, { 'x-vqd-hash-1': JSON.stringify(answer) });
  }
  throw new Error('challenge: not solved after 8 rounds');
}

async function getSessionToken() {
  if (manualToken) return manualToken;
  const token = await solveChallenge({
    'x-vqd-accept': '1',
    'User-Agent': UA,
    'Accept': '*/*',
    'Referer': 'https://duck.ai/',
    'Origin': 'https://duck.ai',
  });
  sessionToken = token;
  sessionTokenTime = Date.now();
  return token;
}

let sessionToken = null;
let sessionTokenTime = 0;

async function getAnyToken() {
  if (manualToken) return manualToken;
  // Cached auto token stays valid ~1 hour; refresh via challenge otherwise.
  if (sessionToken && Date.now() - sessionTokenTime < 3600000) return sessionToken;
  try {
    return await getSessionToken();
  } catch (e) {
    if (sessionToken) return sessionToken; // fall back to possibly-stale token
    throw e;
  }
}

function toDuckPayload(model, messages) {
  return JSON.stringify({ model, messages, retries: 0 });
}

// Build chat body: prefer the real browser body template captured by the userscript.
function buildDuckPayload(model, messages) {
  const raw = readFresh(path.join(__dirname, 'lastbody.txt'));
  if (raw) {
    try {
      const tpl = JSON.parse(raw);
      if (tpl && typeof tpl === 'object' && Array.isArray(tpl.messages)) {
        tpl.model = model;
        tpl.messages = messages;
        tpl.retries = 0;
        delete tpl.canary;
        return JSON.stringify(tpl);
      }
    } catch (e) {
      console.log('[duck-proxy] bad lastbody.txt template:', e.message);
    }
  }
  return toDuckPayload(model, messages);
}

let manualHash = null;
try { manualHash = fs.readFileSync(path.join(__dirname, 'hash1.txt'), 'utf8').trim() || null; } catch {}

function readFresh(p) { try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; } }

async function streamDuck(model, messages, send, onReady, onDone) {
  const chatHeaders = {
    signal: AbortSignal.timeout(60000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Accept': 'text/event-stream',
      'Referer': 'https://duck.ai/',
      'Origin': 'https://duck.ai',
    },
    body: buildDuckPayload(model, messages),
  };
  manualHash = readFresh(path.join(__dirname, 'hash1.txt'));
  manualSignals = readFresh(path.join(__dirname, 'signals.txt'));
  manualToken = readFresh(TOKEN_FILE);
  if (manualHash) chatHeaders.headers['x-vqd-hash-1'] = manualHash;
  else chatHeaders.headers['x-vqd-4'] = await getAnyToken();
  if (manualSignals) chatHeaders.headers['x-fe-signals'] = manualSignals;
  const res = await fetch('https://duck.ai/duckchat/v1/chat', chatHeaders);
  if (res.status !== 200) {
    const t = await res.text().catch(() => '');
    throw new Error('challenge/upstream error: ' + res.status + ' ' + t.slice(0, 300));
  }
  if (onReady) onReady(); // upstream OK; only now send SSE headers
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let id = 'chatcmpl-duck-' + Date.now();
  let created = Math.floor(Date.now() / 1000);
  function chunk(delta) {
    send('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: mapAlias(model), choices: [{ index: 0, delta }] }) + '\n\n');
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { console.log('[duck-proxy] unparsable SSE line:', line.slice(0, 200)); continue; }
      if (obj.action === 'error') throw new Error('upstream: ' + JSON.stringify(obj).slice(0, 200));
      if (typeof obj.message === 'string' && obj.message) chunk({ content: obj.message });
      else console.log('[duck-proxy] SSE event (no message):', JSON.stringify(obj).slice(0, 300));
    }
  }
  chunk({});
  send('data: [DONE]\n\n');
  onDone();
}

function mapAlias(name) {
  return MODELS[name] || name;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><title>duck-ai-proxy</title><meta charset="utf-8"><style>body{font-family:monospace;background:#111;color:#ddd;max-width:720px;margin:40px auto;padding:0 16px}textarea,input,button{font-family:monospace;font-size:14px}textarea{width:100%;height:80px;background:#1b1b1b;color:#ddd;border:1px solid #444;padding:8px}button{background:#de5833;color:#fff;border:0;padding:8px 16px;cursor:pointer;margin-top:8px}code{color:#7ec96f}#msg{margin-top:12px;color:#7ec96f}</style></head><body>
<h2>🦆 duck-ai-proxy</h2>
<p>Status: <span id="st">checking…</span></p>
<p>اگر چالش داد: در مرورگر برو به <code>https://duck.ai</code>، چالش رو حل کن، سپس از DevTools → Network → درخواست <code>status</code> یا <code>chat</code>، مقدار هدر <code>x-vqd-4</code> رو کپی کن و اینجا بچسبون:</p>
<textarea id="tok" placeholder="x-vqd-4 token"></textarea><br>
<button onclick="save()">Set Token</button>
<p>هدر اصلی چالش: از DevTools → Network → درخواست <code>chat</code> → مقدار هدر <code>x-vqd-hash-1</code> رو کپی کن:</p>
<textarea id="hash" placeholder="x-vqd-hash-1 header value"></textarea><br>
<button onclick="saveHash()">Set Hash</button>
<p>هدر دوم: مقدار هدر <code>x-fe-signals</code> رو هم کپی کن:</p>
<textarea id="sig" placeholder="x-fe-signals header value"></textarea><br>
<button onclick="saveSig()">Set Signals</button>
<div id="msg"></div>
<script>
fetch('/health').then(r=>r.json()).then(j=>{document.getElementById('st').textContent=j.ok?('running, token:'+j.manualToken+', signals:'+j.manualSignals):'down';});
function saveHash(){fetch('/set-hash',{method:'POST',body:document.getElementById('hash').value.trim()}).then(r=>r.json()).then(j=>{document.getElementById('msg').textContent=j.ok?'Hash saved ✓':'failed';});}
function saveSig(){fetch('/set-signals',{method:'POST',body:document.getElementById('sig').value.trim()}).then(r=>r.json()).then(j=>{document.getElementById('msg').textContent=j.ok?'Signals saved ✓':'failed';});}
</script></body></html>`);
  }

  if (url.pathname === '/set-token' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      manualToken = body.trim();
      fs.writeFileSync(TOKEN_FILE, manualToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === '/set-last-body' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { JSON.parse(body); fs.writeFileSync(path.join(__dirname, 'lastbody.txt'), body.trim()); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'invalid JSON' })); }
    });
    return;
  }

  if (url.pathname === '/set-hash' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      manualHash = body.trim();
      fs.writeFileSync(path.join(__dirname, 'hash1.txt'), manualHash);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === '/set-signals' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      manualSignals = body.trim();
      fs.writeFileSync(path.join(__dirname, 'signals.txt'), manualSignals);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, models: Object.keys(MODELS), manualToken: !!manualToken, manualSignals: !!manualSignals }));
  }

  if (url.pathname === '/v1/models') {
    const now = Math.floor(Date.now() / 1000);
    const data = Object.keys(MODELS).map(id => ({ id, object: 'model', created: now, owned_by: 'duck.ai' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data }));
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
      }
      const model = mapAlias(parsed.model || 'gpt-4o-mini');
      const messages = (parsed.messages || []).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
      const send = s => res.write(s);
      try {
        if (parsed.stream === false) {
          let out = '';
          const fakeRes = { writeHead: () => {}, end: () => {} };
          await streamDuck(model, messages, s => { const m = s.match(/"content":"((?:\\.|[^"])*)"/); if (m) out += JSON.parse('"' + m[1] + '"'); }, () => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'chatcmpl-duck', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: parsed.model || 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }] }));
        }
        let ready = false;
        await streamDuck(model, messages, send, () => {
          ready = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        }, () => { if (!ready) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); } res.end(); });
      } catch (e) {
        const msg = e.message || 'error';
        console.error('[duck-proxy] chat error:', e.stack || e);
        if (!res.headersSent) {
          const challenge = msg.includes('challenge');
          res.writeHead(challenge ? 403 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: msg, hint: challenge ? 'Solve the duck.ai challenge in your browser, then POST the x-vqd-4 value to /set-token' : undefined } }));
        } else { res.end(); }
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, () => console.log('duck-ai-proxy listening on http://127.0.0.1:' + PORT));
