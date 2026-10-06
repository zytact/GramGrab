#!/usr/bin/env node
// Answers the extension worker's Instagram requests whose URL contains <match>
// with <status> and an empty body, the way Instagram throttles an endpoint.
// `--pass N` lets the first N matching requests through untouched. Runs until
// killed and prints one line per matching request.
//
//   throttle.mjs <match> [status] [--pass N]   e.g. throttle.mjs web_profile_info 429
//
// Needs GRAMGRAB_CDP_PORT and GRAMGRAB_EXT_ID from session.env. It re-attaches
// when the service worker restarts, so it survives an idle worker shutdown.

const args = process.argv.slice(2);
const passAt = args.indexOf('--pass');
let passes = passAt === -1 ? 0 : Number(args.splice(passAt, 2)[1]);
const [match, status = '429'] = args;
const port = process.env.GRAMGRAB_CDP_PORT;
const extId = process.env.GRAMGRAB_EXT_ID;
if (!match || !port || !extId) {
  process.stderr.write('Usage: throttle.mjs <match> [status] [--pass N], with session.env sourced.\n');
  process.exit(2);
}

const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
const socket = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
const attached = new Set();
let nextId = 0;

const send = (method, params = {}, sessionId) =>
  new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function attachWorker() {
  const { targetInfos } = await send('Target.getTargets');
  for (const target of targetInfos) {
    if (target.type !== 'service_worker' || !target.url.includes(extId)) continue;
    if (attached.has(target.targetId)) continue;
    attached.add(target.targetId);
    const { sessionId } = await send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: `*${match}*` }] }, sessionId);
    process.stdout.write(`attached ${target.targetId}\n`);
  }
}

socket.onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) return pending.get(message.id)?.(message.result ?? {});
  if (message.method === 'Target.detachedFromTarget') attached.clear();
  if (message.method !== 'Fetch.requestPaused') return;
  const { pathname } = new URL(message.params.request.url);
  if (passes > 0) {
    passes--;
    process.stdout.write(`${new Date().toISOString()} passed ${pathname}\n`);
    await send('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId);
    return;
  }
  process.stdout.write(`${new Date().toISOString()} ${status} ${pathname}\n`);
  await send(
    'Fetch.fulfillRequest',
    { requestId: message.params.requestId, responseCode: Number(status), body: '' },
    message.sessionId
  );
};

socket.onopen = () => {
  void attachWorker();
  setInterval(attachWorker, 500);
};
