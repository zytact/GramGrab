import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const artifacts = new URL('../../../artifacts/', import.meta.url);

function run(command, arguments_, expectedCode) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not exit.`));
    }, 5_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === expectedCode) resolve();
      else reject(new Error(`${command} exited with ${code}: ${error}`));
    });
    child.stdin.end();
  });
}

const cli = new URL('gramgrab.mjs', artifacts);
const host = new URL('gramgrab-native-host.mjs', artifacts);
await run(process.execPath, [fileURLToPath(cli), 'unknown'], 2);
await run(process.execPath, [fileURLToPath(host)], 0);

if (process.platform === 'win32') {
  await run(
    'cmd.exe',
    ['/d', '/s', '/c', fileURLToPath(new URL('gramgrab.cmd', artifacts)), 'unknown'],
    2
  );
  await run(
    'cmd.exe',
    ['/d', '/s', '/c', fileURLToPath(new URL('gramgrab-native-host.cmd', artifacts))],
    0
  );
}
