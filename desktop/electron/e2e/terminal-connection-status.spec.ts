import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Drive the real renderer with deferred SSH replies. No network connection or
// OS-keychain credential is needed to reproduce a handshake that never returns.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userDataDir = '';

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-term-status-'));
  fs.mkdirSync(path.join(userDataDir, 'migration'));
  fs.writeFileSync(path.join(userDataDir, 'migration', 'state-v1.json'), JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      'connections': JSON.stringify([{
        id: 'status-host', name: 'Status host', host: 'status.invalid', port: 22,
        username: 'tester', authMethod: 'password', keyId: null, tmuxPath: null,
        group: null, createdAt: '2026-09-10T00:00:00Z', lastConnectedAt: null, deepLinkId: null,
      }]),
    },
  }));
  app = await electron.launch({
    args: ['--no-sandbox', '--disable-gpu', '--password-store=basic', `--user-data-dir=${userDataDir}`, path.resolve(__dirname, '../out/main.cjs')],
    env: { ...process.env, TERMIPOD_DIST: path.resolve(__dirname, '../../dist'), TERMIPOD_E2E: '1' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as {
      pendingSsh: Array<(id: string) => void>;
      closedSsh: string[];
    };
    state.pendingSsh = [];
    state.closedSsh = [];
    ipcMain.removeHandler('bridge:invoke');
    ipcMain.handle('bridge:invoke', async (_event, cmd: string, args: { key?: string; id?: string }) => {
      if (cmd === 'ssh_connect') return new Promise<string>((resolve) => state.pendingSsh.push(resolve));
      if (cmd === 'ssh_close') { state.closedSsh.push(args.id!); return; }
      if (cmd === 'keychain_get') return args.key === 'secretstore.v1'
        ? JSON.stringify({ 'password_status-host': 'test-password' }) : 'test-password';
      if (cmd === 'keychain_is_windows') return false;
      if (cmd === 'platform_os') return 'linux';
      return null;
    });
  });
  const dialog = page.getByRole('dialog', { name: 'Add a hub' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close' }).click();
  await page.locator('[data-job="terminal"]').click();
  await expect(page.locator('.term-nav-quick')).toBeVisible();
  await page.clock.install();
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function connectSaved(): Promise<void> {
  await page.locator('.term-nav-quick').click();
  await expect(page.locator('.term-main .term-connection-status[role="status"]')).toContainText('Status host');
  await expect(page.locator('.term-main .term-connecting-spinner')).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { pendingSsh: unknown[] }).pendingSsh.length)).toBeGreaterThan(0);
}

async function resolveNext(id: string): Promise<void> {
  await app.evaluate((_electron, sessionId) => {
    (globalThis as unknown as { pendingSsh: Array<(id: string) => void> }).pendingSsh.shift()!(sessionId);
  }, id);
}

test('timeout expires, retry clears the error, and late sessions cannot overwrite success', async () => {
  await connectSaved();
  // Fold the nav: progress must still be visible in the main pane.
  await page.locator('.term-surface-head').getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.locator('.term-main .term-connecting-spinner')).toBeVisible();
  await page.clock.fastForward(20_001);
  const error = page.locator('.term-main [role="alert"]');
  await expect(error).toContainText('Connection timed out');
  await expect(page.locator('.term-nav .error')).toHaveCount(0);
  await expect(page.locator('.term-main .term-connection-status[role="status"]')).toHaveCount(0);
  await page.clock.fastForward(15_001);
  await expect(error).toHaveCount(0);
  await resolveNext('expired-session');
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { closedSsh: string[] }).closedSsh)).toContain('expired-session');

  await page.locator('.term-surface-head').getByRole('button', { name: 'Expand panel' }).click();
  await connectSaved();
  await page.clock.fastForward(20_001);
  await expect(error).toContainText('Connection timed out');
  // Retry through the fallback form while the expired IPC is still pending.
  const connect = page.locator('.term-actions button.primary');
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(error).toHaveCount(0);
  await expect(page.locator('.term-actions .term-connecting-spinner')).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { pendingSsh: unknown[] }).pendingSsh.length)).toBe(2);
  await resolveNext('late-session');
  await resolveNext('live-session');
  await expect(page.locator('.term-tab')).toHaveCount(1);
  await expect(page.locator('.term-actions')).toHaveCount(0);
  await expect(page.locator('.term-main .term-connecting-spinner')).toHaveCount(0);
  await expect(error).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { closedSsh: string[] }).closedSsh)).toContain('late-session');
});

test('a failure can be dismissed while a live session remains mounted', async () => {
  await connectSaved();
  await page.clock.fastForward(20_001);
  const error = page.locator('.term-main [role="alert"]');
  await expect(error).toBeVisible();
  await error.getByRole('button', { name: 'Close' }).click();
  await expect(error).toHaveCount(0);
  await resolveNext('dismissed-session');
  await expect(page.locator('.term-tab')).toHaveCount(1);
  expect(await app.evaluate(() => (globalThis as unknown as { closedSsh: string[] }).closedSsh)).not.toContain('live-session');
});
