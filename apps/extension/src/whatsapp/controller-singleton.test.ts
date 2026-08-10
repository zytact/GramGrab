import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { installWhatsAppController } from './controller-runtime.ts';

function makeRuntime() {
  const listeners = new Set<(port: unknown) => void>();
  return {
    runtime: {
      onConnect: {
        addListener: vi.fn((listener: (port: unknown) => void) => listeners.add(listener)),
        removeListener: vi.fn((listener: (port: unknown) => void) => listeners.delete(listener)),
      },
    },
    connect: (port: unknown) => listeners.forEach(listener => listener(port)),
    listenerCount: () => listeners.size,
  };
}

function makePort() {
  return {
    name: 'gramgrab-whatsapp-capture-v1',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

describe('WhatsApp isolated controller singleton', () => {
  afterEach(() => {
    globalThis.__gramgrabWhatsAppCaptureControllerV1?.dispose();
    vi.unstubAllGlobals();
  });

  it('disposes a prior controller and its accepted port before reinjection', () => {
    const runtime = makeRuntime();
    vi.stubGlobal('browser', runtime);
    const firstPort = makePort();
    installWhatsAppController();
    runtime.connect(firstPort);
    expect(runtime.listenerCount()).toBe(1);

    const secondPort = makePort();
    installWhatsAppController();
    expect(firstPort.disconnect).toHaveBeenCalledTimes(1);
    expect(runtime.listenerCount()).toBe(1);
    runtime.connect(secondPort);
    expect(secondPort.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(firstPort.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it('accepts only one matching port and rejects a second connection', () => {
    const runtime = makeRuntime();
    vi.stubGlobal('browser', runtime);
    const firstPort = makePort();
    const secondPort = makePort();
    installWhatsAppController();
    runtime.connect(firstPort);
    runtime.connect(secondPort);
    expect(firstPort.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(secondPort.disconnect).toHaveBeenCalledTimes(1);
  });
});
