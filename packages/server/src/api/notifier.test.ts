import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notify, readNotifySettings, writeNotifySettings } from './notifier.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-notify-'));
}

const calls: { url: string; body: unknown }[] = [];

describe('notifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  function stubFetch(status = 200): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({}), { status });
    }));
  }

  it('persists and round-trips settings', () => {
    const dir = tmp();
    writeNotifySettings(dir, { feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', notifyEvents: ['blocked'] });
    const s = readNotifySettings(dir);
    expect(s.feishuWebhook).toContain('open.feishu.cn');
    expect(s.notifyEvents).toEqual(['blocked']);
  });

  it('posts subscribed events to the configured webhook', async () => {
    const dir = tmp();
    writeNotifySettings(dir, { feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' });
    stubFetch();
    notify(dir, 'blocked', 'demo run 162 等待审批');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('open.feishu.cn');
    expect(JSON.stringify(calls[0]!.body)).toContain('⛔ 等待审批');
    expect(JSON.stringify(calls[0]!.body)).toContain('162');
  });

  it('skips unsubscribed events', async () => {
    const dir = tmp();
    writeNotifySettings(dir, { feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', notifyEvents: ['blocked'] });
    stubFetch();
    notify(dir, 'completed', 'done');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it('silently no-ops when unconfigured', async () => {
    const dir = tmp();
    stubFetch();
    notify(dir, 'failed', 'boom');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it('never rejects even when the webhook fails', async () => {
    const dir = tmp();
    writeNotifySettings(dir, { feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(() => notify(dir, 'failed', 'x')).not.toThrow();
    await new Promise((r) => setTimeout(r, 30)); // rejection swallowed
  });
});
