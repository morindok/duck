// duck-ai-bridge: opencode (OpenAI API) -> real Chrome (Playwright) -> duck.ai
// A persistent headed browser session does the chatting; responses are read
// from the browser's own network stream. If duck.ai shows a challenge (image
// captcha etc.), solve it manually in the opened window.
const { chromium } = require('C:/Users/Morindok/.config/opencode/node_modules/playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 8121;
const USER_DATA = path.join(__dirname, 'pw-profile');

const MODELS = {
  'duck/gpt-4o-mini': 'gpt-4o-mini',
  'duck/claude-3-haiku': 'claude-3-haiku-20240307',
  'duck/claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'duck/claude-3-5-sonnet': 'claude-3-5-sonnet-latest',
  'duck/llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'duck/mistral-small-3': 'mistralai/Mistral-Small-24B-Instruct-2501',
  'duck/o3-mini': 'o3-mini',
};
const MODEL_ALIASES = {
  'duck/gpt-4o-mini': 'gpt-4o-mini',
  'duck/llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'duck/mistral-small-3': 'mistralai/Mistral-Small-24B-Instruct-2501',
};

let browser, context, page;
let chain = Promise.resolve(); // serialize chat turns
let responsePromise = null; // set before sending a message

function log(...a) { console.log('[bridge]', ...a); }

async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  log('launching persistent Chrome...');
  context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--window-size=1280,900'],
  }).catch(() => chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: 'msedge', viewport: null, args: ['--window-size=1280,900'],
  }));
  page = context.pages()[0] || await context.newPage();
  await page.goto('https://duck.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto:', e.message));
  log('duck.ai loaded. IF A CHALLENGE APPEARS, SOLVE IT IN THE OPEN WINDOW.');
}

async function newChat() {
  // Try to start a fresh conversation so contexts don't mix.
  const selectors = ['a[href="/chat"]', '[data-testid="new-chat"]', 'button[aria-label*="New" i]', 'a:has-text("New Chat")', 'button:has-text("New Chat")'];
  for (const sel of selectors) {
    try { const el = await page.$(sel); if (el) { await el.click({ timeout: 3000 }); await page.waitForTimeout(800); return; } } catch {}
  }
  // fallback: navigate directly
  await page.goto('https://duck.ai/?q=', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function chatTurn(model, userText, timeoutMs) {
  await ensureBrowser();
  await newChat();

  const input = await page.$('textarea') || await page.$('[contenteditable="true"]');
  if (!input) throw new Error('no chat input found on page — is duck.ai loaded?');

  // Arm the response waiter BEFORE sending so we capture the full SSE stream.
  responsePromise = page.waitForResponse(
    r => r.url().includes('/duckchat/v1/chat') && r.request().method() === 'POST',
    { timeout: timeoutMs }
  ).catch(() => null);

  await input.click();
  await page.keyboard.type(userText, { delay: 5 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  log('message sent:', JSON.stringify(userText.slice(0, 60)));

  const res = await responsePromise;
  if (!res) throw new Error('timeout waiting for duck.ai response (did a challenge appear? solve it in the window)');
  const status = res.status();
  log('chat response:', status, 'url:', res.url());
  let bodyText = '';
  // Streaming bodies can appear empty on first read; retry a few times.
  for (let i = 0; i < 5 && bodyText.length === 0; i++) {
    const b = await res.body().catch(() => null);
    bodyText = b ? (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)) : '';
    if (!bodyText) await page.waitForTimeout(1000);
  }
  log('body bytes:', bodyText.length, 'start:', bodyText.slice(0, 150).replace(/\n/g, ' '));
  if (status !== 200) {
    throw new Error('upstream status ' + status + ': ' + bodyText.slice(0, 200));
  }

  // Parse SSE body -> concatenated message text
  let out = '';
  for (const line of bodyText.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data: ')) continue;
    const payload = s.slice(6);
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (typeof obj.message === 'string') out += obj.message;
    } catch {}
  }
  if (!out) throw new Error('empty response parsed from stream; raw: ' + bodyText.slice(0, 200));
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bridge: 'playwright-dom', models: Object.keys(MODELS), pageOpen: !!(page && !page.isClosed()) }));
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
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
      }
      const reqModel = parsed.model || 'duck/gpt-4o-mini';
      const duckModel = MODEL_ALIASES[reqModel] || MODELS[reqModel] || reqModel.replace(/^duck\//, '');
      // Use only the last user message (duck.ai keeps its own context per chat)
      const lastUser = [...(parsed.messages || [])].reverse().find(m => m.role === 'user');
      const userText = typeof (lastUser && lastUser.content) === 'string' ? lastUser.content : JSON.stringify((lastUser && lastUser.content) || '');

      chain = chain.then(async () => {
        try {
          const text = await chatTurn(duckModel, userText, 180000);
          const id = 'chatcmpl-duck-' + Date.now();
          const created = Math.floor(Date.now() / 1000);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            const chunk = { id, object: 'chat.completion.chunk', created, model: reqModel, choices: [{ index: 0, delta: { content: text } }] };
            res.write('data: ' + JSON.stringify(chunk) + '\n\n');
            res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: reqModel, choices: [{ index: 0, delta: {} }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, object: 'chat.completion', created, model: reqModel, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
          }
          log('turn OK, reply len:', text.length);
        } catch (e) {
          log('turn FAILED:', e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, hint: 'If a challenge is visible in the opened Chrome window, solve it, then retry.' } }));
          } else { try { res.end(); } catch {} }
        }
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, () => {
  log('bridge API on http://127.0.0.1:' + PORT + ' — browser will open; solve challenges there if asked');
  ensureBrowser().catch(e => log('initial browser launch failed:', e.message));
});
