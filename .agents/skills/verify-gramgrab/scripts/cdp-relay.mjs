#!/usr/bin/env node
// Relays a local TCP port to the Windows browser's CDP port, so drive.mjs and
// doctor.mjs work unchanged on WSL. Each connection runs through one
// powershell.exe, because WSL in NAT mode cannot reach Windows 127.0.0.1.
//
//   cdp-relay.mjs <windows-port> <local-port>
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const [windowsPort, localPort] = process.argv.slice(2).map(Number);
if (!windowsPort || !localPort) {
  process.stderr.write('Usage: cdp-relay.mjs <windows-port> <local-port>\n');
  process.exit(2);
}

const relay = `
$client = [Net.Sockets.TcpClient]::new('127.0.0.1', ${windowsPort})
$stream = $client.GetStream()
$null = [Console]::OpenStandardInput().CopyToAsync($stream)
$stream.CopyTo([Console]::OpenStandardOutput())
`;
const encoded = Buffer.from(relay, 'utf16le').toString('base64');

createServer(socket => {
  const powershell = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { cwd: '/mnt/c', stdio: ['pipe', 'pipe', 'ignore'] }
  );
  socket.pipe(powershell.stdin);
  powershell.stdout.pipe(socket);
  socket.on('error', () => powershell.kill());
  socket.on('close', () => powershell.kill());
  powershell.on('exit', () => socket.destroy());
}).listen(localPort, '127.0.0.1');
