// Shared test helpers: reads index.html, extracts its inline scripts, and builds a tiny DOM stub
// so those scripts can be executed outside a browser. Used by tests/index-html.test.js and
// tests/fed-analysis.test.js — no jsdom, no network, no browser.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function makeElement(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    title: '',
    style: {},
    dataset: {},
    offsetWidth: 0,
    nextElementSibling: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    click() {}
  };
}

// Builds a fresh sandbox. `fetchImpl` lets a test decide what the page "sees" from the network;
// the default fails every request, which is the state a visitor gets when Functions are down.
function makeSandbox({ fetchImpl } = {}) {
  const elements = new Map();
  const store = new Map();
  const sandbox = {
    console,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; }, // run timers immediately
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    Promise,
    Date,
    Math,
    JSON,
    Map,
    Set,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    isFinite,
    parseInt,
    parseFloat,
    // window-level listeners (the page registers hashchange / visibilitychange on window)
    addEventListener() {},
    removeEventListener() {},
    location: { hash: '', href: 'https://example.test/', replace() {} },
    history: { replaceState() {} },
    navigator: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })),
    document: {
      hidden: false,
      body: makeElement('body'),
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      // Mimic `#id` lookups (the page uses them in a couple of error paths).
      querySelector: (sel) => {
        if (typeof sel !== 'string' || !sel.startsWith('#')) return null;
        const id = sel.slice(1);
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      createElement: () => makeElement('created'),
      addEventListener() {},
      documentElement: makeElement('html')
    },
    // handle to the stub's element map, for assertions in tests
    __elements: elements
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

// Runs every inline script in one shared sandbox (i.e. like a real page load) and lets the async
// work they kick off settle, so unhandled rejections surface as test failures.
async function runAllScripts(sandbox, { settle = 40 } = {}) {
  SCRIPTS.forEach((src, i) => vm.runInNewContext(src, sandbox, { filename: `index.html#script${i}` }));
  for (let i = 0; i < settle; i++) await new Promise((resolve) => setImmediate(resolve));
  return sandbox;
}

module.exports = { HTML, SCRIPTS, makeSandbox, runAllScripts };
