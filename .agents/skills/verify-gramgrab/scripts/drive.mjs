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
//   drive.mjs key <match> <key>            press Tab, Enter, or an arrow; prefix shift+ to hold Shift
//   drive.mjs drag <match> <selector> <dx> <dy>  drag from an element's centre by CSS pixels
//   drive.mjs upload <match> <selector> <file>  choose a file in a file input
//   drive.mjs eval <match> <expression>    evaluate in the target whose url ends with <match>, else the first containing it
//   drive.mjs text <match>                 print document.body.innerText
//   drive.mjs shot <match> <file> [sel]    save a PNG screenshot, cropped to <sel> when given
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
    const pages = matches.filter(target => target.type === 'page');
    const hit = pages.find(target => target.url.endsWith(match)) ?? pages[0] ?? matches[0];
    if (hit) return hit;
    if (Date.now() > deadline) fail(`No target matching ${JSON.stringify(match)}.`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// Runs `steps` over one socket to a single target, then closes it, so a failed
// drive step never leaves a socket attached to the browser. Remote object IDs
// live only as long as the socket, so commands that share one go in one call.
async function session(target, steps) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const call = (method, params = {}) => {
    const id = ++nextId;
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
    return result;
  };
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), {
        once: true,
      });
    });
    return await steps(call);
  } finally {
    socket.close();
  }
}

const send = (target, method, params = {}) => session(target, call => call(method, params));

async function evaluate(match, expression, userGesture = false) {
  const target = await findTarget(match);
  const result = await send(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails)
    fail(result.exceptionDetails.exception?.description ?? 'Evaluation threw.');
  return result.result.value;
}

const KEY_CODES = {
  Tab: 9,
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

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
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('Clickable element not found.'); element.click(); })()`,
    true
  );
  process.stdout.write(`${selector}\n`);
} else if (command === 'key') {
  const [match, chord] = rest;
  const shift = chord?.startsWith('shift+') ?? false;
  const key = shift ? chord.slice('shift+'.length) : chord;
  const keyCode = KEY_CODES[key];
  if (!match || !keyCode) fail(`Usage: drive.mjs key <match> [shift+]${Object.keys(KEY_CODES).join('|')}`);
  const target = await findTarget(match);
  await send(target, 'Page.bringToFront');
  const params = {
    key,
    code: key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: shift ? 8 : 0,
  };
  await send(target, 'Input.dispatchKeyEvent', {
    ...params,
    type: 'keyDown',
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
  await send(target, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  process.stdout.write(`${chord}\n`);
} else if (command === 'drag') {
  const [match, selector, dx, dy] = rest;
  if (!match || !selector || !Number.isFinite(Number(dx)) || !Number.isFinite(Number(dy)))
    fail('Usage: drive.mjs drag <match> <selector> <dx> <dy>');
  const target = await findTarget(match);
  await send(target, 'Page.bringToFront');
  const start = await evaluate(
    match,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Element not found.'); element.scrollIntoView({ block: 'center' }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
  );
  await session(target, async call => {
    const mouse = (type, x, y) =>
      call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', start.x, start.y);
    for (let step = 1; step <= 10; step++)
      await mouse('mouseMoved', start.x + (Number(dx) * step) / 10, start.y + (Number(dy) * step) / 10);
    await mouse('mouseReleased', start.x + Number(dx), start.y + Number(dy));
  });
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
} else if (command === 'upload') {
  const [match, selector, file] = rest;
  if (!match || !selector || !file) fail('Usage: drive.mjs upload <match> <selector> <file>');
  const { resolve } = await import('node:path');
  await session(await findTarget(match), async call => {
    const found = await call('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    if (found.result.subtype !== 'node') fail('File input not found.');
    await call('DOM.setFileInputFiles', {
      files: [resolve(file)],
      objectId: found.result.objectId,
    });
  });
  process.stdout.write(`${file}\n`);
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
  const [match, file, selector] = rest;
  if (!match || !file) fail('Usage: drive.mjs shot <match> <file> [selector]');
  const target = await findTarget(match);
  // Chromium stalls captureScreenshot on a tab that is not rendering, which by
  // this point in a run is most of them. Raise it first.
  await send(target, 'Page.bringToFront').catch(() => {});
  // A crop keeps the rest of the page, account names included, out of the file.
  const clip = selector
    ? await evaluate(
        match,
        `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Element not found.'); element.scrollIntoView({ block: 'center' }); const r = element.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; })()`
      )
    : undefined;
  const { data } = await send(target, 'Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip } : {}),
  });
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
  fail(
    'Usage: drive.mjs targets|open|activate|click|key|drag|type|blur|upload|eval|text|shot|wait ...'
  );
}
