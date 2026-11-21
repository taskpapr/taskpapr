#!/usr/bin/env node
// ============================================================
// cdp-eval.js — evaluate a JavaScript expression in a Chrome page on the
// emulator, over the Chrome DevTools Protocol (Node built-ins only).
//
// Runs ON the test host; droid.sh `eval` forwards the emulator's DevTools
// socket to PORT first.
//
// Usage: node cdp-eval.js PORT URL_PREFIX EXPRESSION
//   Evaluates EXPRESSION in the first page whose URL starts with URL_PREFIX
//   and prints the result (strings as-is, anything else as JSON).
// Exit code: 0 = evaluated, 1 = no matching page, an exception, or a timeout.
// ============================================================
'use strict';

const [port, prefix, expression] = process.argv.slice(2);
if (!port || !prefix || expression === undefined) {
  console.error('usage: node cdp-eval.js PORT URL_PREFIX EXPRESSION');
  process.exit(1);
}

setTimeout(() => { console.error('cdp-eval: timed out'); process.exit(1); }, 15000).unref();

// Evaluate one expression in a page; resolves { value } or { error }.
function evaluate(page, expr) {
  return new Promise(resolve => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onerror = () => resolve({ error: 'websocket error' });
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
    ws.onmessage = msg => {
      const data = JSON.parse(msg.data);
      if (data.id !== 1) return;
      ws.close();
      const res = data.result || {};
      if (data.error || res.exceptionDetails) {
        resolve({ error: JSON.stringify(data.error || res.exceptionDetails.exception || res.exceptionDetails) });
      } else {
        resolve({ value: res.result && res.result.value });
      }
    };
  });
}

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const pages = targets.filter(t => t.type === 'page' && t.url.startsWith(prefix));
  if (!pages.length) {
    console.error(`cdp-eval: no page at ${prefix} (open: ${targets.map(t => t.url).join(', ') || 'none'})`);
    process.exit(1);
  }
  // Tabs left over from earlier runs can share the URL: use the one on screen.
  let page = pages[0];
  for (const p of pages) {
    const { value } = await evaluate(p, 'document.visibilityState');
    if (value === 'visible') { page = p; break; }
  }
  const { value, error } = await evaluate(page, expression);
  if (error) { console.error('cdp-eval: ' + error); process.exit(1); }
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
  process.exit(0);
})().catch(err => { console.error('cdp-eval: ' + err.message); process.exit(1); });
