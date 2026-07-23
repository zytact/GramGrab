import { describe, expect, it } from 'vite-plus/test';
import { localIpcEndpoint } from '../src/index.ts';

describe('local IPC endpoint', () => {
  it('uses a per-user Unix socket in the runtime directory', () => {
    expect(
      localIpcEndpoint({ platform: 'linux', runtimeDirectory: '/run/user/1000', userId: 1000 })
    ).toBe('/run/user/1000/gramgrab-1000.sock');
    expect(localIpcEndpoint({ platform: 'darwin', userId: 501 })).toBe('/tmp/gramgrab-501.sock');
  });

  it('uses the stable Windows named pipe', () => {
    expect(localIpcEndpoint({ platform: 'win32' })).toBe(String.raw`\\.\pipe\gramgrab`);
  });

  it('honors the development override on every platform', () => {
    expect(localIpcEndpoint({ platform: 'win32', override: 'custom-endpoint' })).toBe(
      'custom-endpoint'
    );
  });
});
