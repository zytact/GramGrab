import { browser } from '../lib/browser';
import {
  sanitizeSnapshot,
  upgradeWorkspaceSnapshot,
  WORKSPACE_TRANSFER_KEY,
  WORKSPACE_STATUS_KEY,
  workspaceUrl,
  type WorkspaceSnapshot,
} from './contracts';

let openingWorkspace: Promise<'created' | 'focused'> | undefined;
let replacingWorkspace: Promise<void> = Promise.resolve();

function isWorkspaceTab(tab: { url?: string }): boolean {
  const url = tab.url ?? '';
  return url.startsWith(browser.runtime.getURL('popup.html')) && url.includes('surface=workspace');
}

export async function findWorkspaceTab() {
  const tabs = await browser.tabs.query({});
  return tabs.find(isWorkspaceTab);
}

export async function isWorkspaceReportedBusy(): Promise<boolean> {
  const value = (await browser.storage.get(WORKSPACE_STATUS_KEY))[WORKSPACE_STATUS_KEY];
  if (!value || typeof value !== 'object') return false;
  const status = value as { busy?: unknown; updatedAt?: unknown };
  return (
    status.busy === true &&
    typeof status.updatedAt === 'number' &&
    Date.now() - status.updatedAt < 10_000
  );
}

async function focusWorkspace(tab: { id?: number; windowId?: number }): Promise<void> {
  if (tab.id !== undefined) await browser.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

async function createWorkspace(snapshot: WorkspaceSnapshot): Promise<'created'> {
  const offerId = crypto.randomUUID();
  const sanitized = sanitizeSnapshot(snapshot);
  await browser.storage.set({
    [WORKSPACE_TRANSFER_KEY]: sanitized,
    [`${WORKSPACE_TRANSFER_KEY}:${offerId}`]: sanitized,
  });
  await browser.tabs.create({ url: workspaceUrl(snapshot.url, offerId), active: true });
  return 'created';
}

export async function openWorkspace(snapshot: WorkspaceSnapshot): Promise<'created' | 'focused'> {
  if (openingWorkspace) return openingWorkspace;
  openingWorkspace = (async () => {
    const existing = await findWorkspaceTab();
    if (existing) {
      await focusWorkspace(existing);
      return 'focused' as const;
    }
    return createWorkspace(snapshot);
  })();
  try {
    return await openingWorkspace;
  } finally {
    openingWorkspace = undefined;
  }
}

export async function replaceWorkspace(
  snapshot: WorkspaceSnapshot
): Promise<'replaced' | 'created'> {
  const result = replacingWorkspace.then(() => replaceWorkspaceNow(snapshot));
  replacingWorkspace = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function replaceWorkspaceNow(snapshot: WorkspaceSnapshot): Promise<'replaced' | 'created'> {
  const existing = await findWorkspaceTab();
  if (!existing?.id) return createWorkspace(snapshot);
  const offerId = crypto.randomUUID();
  const sanitized = sanitizeSnapshot(snapshot);
  await browser.storage.set({
    [WORKSPACE_TRANSFER_KEY]: sanitized,
    [`${WORKSPACE_TRANSFER_KEY}:${offerId}`]: sanitized,
  });
  try {
    await browser.tabs.update(existing.id, {
      url: workspaceUrl(snapshot.url, offerId),
      active: true,
    });
    await focusWorkspace(existing);
    return 'replaced';
  } catch {
    return createWorkspace(snapshot);
  }
}

export async function claimWorkspaceTransfer(): Promise<WorkspaceSnapshot | undefined> {
  const offerId = new URLSearchParams(globalThis.location?.search ?? '').get('offer');
  const key = offerId ? `${WORKSPACE_TRANSFER_KEY}:${offerId}` : WORKSPACE_TRANSFER_KEY;
  const values = await browser.storage.get(key);
  const candidate = values[key];
  await browser.storage.remove(offerId ? [key, WORKSPACE_TRANSFER_KEY] : key);
  return upgradeWorkspaceSnapshot(candidate);
}
