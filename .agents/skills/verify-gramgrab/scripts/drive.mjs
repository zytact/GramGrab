#!/usr/bin/env node
// CDP driver for the GramGrab verification skill. No dependencies: Node 24 ships
// a global WebSocket and fetch.
//
//   drive.mjs targets                      list every debuggable target
//   drive.mjs open <url>                   open a tab and print its target id
//   drive.mjs activate <match>             bring a matching page to the front
//   drive.mjs click <match> <selector>     click an element
//   drive.mjs type <match> <selector> <v>  replace an input value and dispatch input
//   drive.mjs blur <match> <selector>      blur an element
//   drive.mjs eval <match> <expression>    evaluate in the first target whose url contains <match>
//   drive.mjs text <match>                 print document.body.innerText
//   drive.mjs shot <match> <file>          save a PNG screenshot
//   drive.mjs wait <match> <needle> [ms]   poll innerText until <needle> appears
//
// The port comes from GRAMGRAB_CDP_PORT, or --port as the first argument.

const argv = process.argv.slice(2);
let port = process.env.GRAMGRAB_CDP_PORT;
if (argv[0] === '--port') {
  port = argv[1];
  argv.splice(0, 2);
}
if (!port) fail('Set GRAMGRAB_CDP_PORT or pass --port <port>.');
const base = `http://127.0.0.1:${port}`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function targets() {
  const response = await fetch(`${base}/json/list`).catch(error => {
    fail(`No CDP endpoint on ${base}: ${error.message}`);
  });
  return response.json();
}

// A site can own several targets at once: the tab, its service worker, and
// cross-origin iframes. Prefer the tab, or an eval lands in a worker with no
// document and fails with a confusing SecurityError. Non-page targets are still
// reachable, which is how the extension's own service worker gets driven.
async function findTarget(match) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const matches = (await targets()).filter(
      target =>
        target.webSocketDebuggerUrl && (target.url.includes(match) || target.title === match)
    );
    const hit = matches.find(target => target.type === 'page') ?? matches[0];
    if (hit) return hit;
    if (Date.now() > deadline) fail(`No target matching ${JSON.stringify(match)}.`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// One command/response round trip against a single target. Kept short-lived so a
// failed drive step never leaves a socket attached to the browser.
async function send(target, method, params = {}) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), {
        once: true,
      });
    });
    const id = 1;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return await result;
  } finally {
    socket.close();
  }
}

async function evaluate(match, expression) {
  const target = await findTarget(match);
  const result = await send(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    fail(result.exceptionDetails.exception?.description ?? 'Evaluation threw.');
  return result.result.value;
}

const [command, ...rest] = argv;

if (command === 'targets') {
  const list = await targets();
  for (const target of list) process.stdout.write(`${target.type}\t${target.url}\n`);
} else if (command === 'open') {
  const [url] = rest;
  if (!url) fail('Usage: drive.mjs open <url>');
  const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) fail(`Could not open ${url}: HTTP ${response.status}`);
  const target = await response.json();
  // A new target starts on the initial blank document, whose origin is opaque.
  // Returning before it settles hands the caller a page where document.cookie
  // throws a SecurityError. Wait for the real document instead.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = (await targets()).find(item => item.id === target.id);
    if (!current) fail(`Target ${target.id} disappeared while loading ${url}.`);
    if (current.url !== 'about:blank') {
      const state = await send(current, 'Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }).catch(() => undefined);
      if (state?.result?.value === 'complete') break;
    }
    if (Date.now() > deadline) fail(`${url} did not finish loading in 30s.`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  process.stdout.write(`${target.id}\n`);
} else if (command === 'close') {
  // A clean shutdown. Chromium only flushes its cookie store on a real exit, so
  // signalling the process instead would discard a sign-in made moments ago.
  const info = await fetch(`${base}/json/version`).then(response => response.json());
  await send({ webSocketDebuggerUrl: info.webSocketDebuggerUrl }, 'Browser.close').catch(() => {});
  process.stdout.write('closing\n');
} else if (command === 'activate') {
  const [match] = rest;
  if (!match) fail('Usage: drive.mjs activate <match>');
  await send(await findTarget(match), 'Page.bringToFront');
  process.stdout.write(`${match}\n`);
} else if (command === 'click') {
  const [match, selector] = rest;
  if (!match || !selector) fail('Usage: drive.mjs click <match> <selector>');
  await evaluate(
    match,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('Clickable element not found.'); element.click(); })()`
  );
  process.stdout.write(`${selector}\n`);
} else if (command === 'type') {
  const [match, selector, value] = rest;
  if (!match || !selector || value === undefined)
    fail('Usage: drive.mjs type <match> <selector> <value>');
  await evaluate(
    match,
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!(input instanceof HTMLInputElement)) throw new Error('Input not found.'); input.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`
  );
  process.stdout.write(`${selector}\n`);
} else if (command === 'blur') {
  const [match, selector] = rest;
  if (!match || !selector) fail('Usage: drive.mjs blur <match> <selector>');
  await evaluate(
    match,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('Element not found.'); element.blur(); element.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); })()`
  );
  process.stdout.write(`${selector}\n`);
} else if (command === 'eval') {
  const [match, expression] = rest;
  if (!match || !expression) fail('Usage: drive.mjs eval <match> <expression>');
  const value = await evaluate(match, expression);
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
} else if (command === 'text') {
  const [match] = rest;
  if (!match) fail('Usage: drive.mjs text <match>');
  process.stdout.write(`${await evaluate(match, 'document.body.innerText')}\n`);
} else if (command === 'shot') {
  const [match, file] = rest;
  if (!match || !file) fail('Usage: drive.mjs shot <match> <file>');
  const target = await findTarget(match);
  // Chromium stalls captureScreenshot on a tab that is not rendering, which by
  // this point in a run is most of them. Raise it first.
  await send(target, 'Page.bringToFront').catch(() => {});
  const { data } = await send(target, 'Page.captureScreenshot', { format: 'png' });
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  process.stdout.write(`${file}\n`);
} else if (command === 'wait') {
  const [match, needle, timeout = '15000'] = rest;
  if (!match || !needle) fail('Usage: drive.mjs wait <match> <needle> [timeoutMs]');
  const deadline = Date.now() + Number(timeout);
  for (;;) {
    const text = await evaluate(match, 'document.body.innerText');
    if (String(text).includes(needle)) break;
    if (Date.now() > deadline) fail(`Timed out waiting for ${JSON.stringify(needle)}.`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  process.stdout.write(`${needle}\n`);
} else {
  fail('Usage: drive.mjs targets|open|activate|click|type|blur|eval|text|shot|wait ...');
}
