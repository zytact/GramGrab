import { browser } from '../lib/browser';
import {
  isValidSnapshot,
  sanitizeSnapshot,
  WORKSPACE_TRANSFER_KEY,
  workspaceUrl,
  type WorkspaceSnapshot,
} from './contracts';

let openingWorkspace: Promise<'created' | 'focused'> | undefined;

function isWorkspaceTab(tab: { url?: string }): boolean {
  const url = tab.url ?? '';
  return url.startsWith(browser.runtime.getURL('popup.html')) && url.includes('surface=workspace');
}

export async function findWorkspaceTab() {
  const tabs = await browser.tabs.query({});
  return tabs.find(isWorkspaceTab);
}

async function focusWorkspace(tab: { id?: number; windowId?: number }): Promise<void> {
  if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
  if (tab.id !== undefined) await browser.tabs.update(tab.id, { active: true });
}

async function createWorkspace(snapshot: WorkspaceSnapshot): Promise<'created'> {
  await browser.storage.set({ [WORKSPACE_TRANSFER_KEY]: sanitizeSnapshot(snapshot) });
  await browser.tabs.create({ url: workspaceUrl(snapshot.url), active: true });
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
  const existing = await findWorkspaceTab();
  if (!existing?.id) return createWorkspace(snapshot);
  await browser.storage.set({ [WORKSPACE_TRANSFER_KEY]: sanitizeSnapshot(snapshot) });
  try {
    await browser.tabs.update(existing.id, { url: workspaceUrl(snapshot.url), active: true });
    await focusWorkspace(existing);
    return 'replaced';
  } catch {
    return createWorkspace(snapshot);
  }
}

export async function claimWorkspaceTransfer(): Promise<WorkspaceSnapshot | undefined> {
  const values = await browser.storage.get(WORKSPACE_TRANSFER_KEY);
  const candidate = values[WORKSPACE_TRANSFER_KEY];
  await browser.storage.remove(WORKSPACE_TRANSFER_KEY);
  return isValidSnapshot(candidate) ? candidate : undefined;
}
