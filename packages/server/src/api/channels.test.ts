import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRequest,
  dingSign,
  dispatchChannels,
  readChannels,
  renderText,
  writeChannels,
  type Channel,
  type NotifyPayload,
} from './channels.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-channels-'));
}

const payload: NotifyPayload = {
  event: 'blocked',
  title: 'PaneFlow ⛔ 等待审批',
  body: 'demo（run r1）节点 planner 等待人工审批',
  runId: 'r1',
  dagName: 'demo',
  nodeIds: ['planner'],
};

const feishu: Channel = {
  id: 'c1',
  type: 'feishu',
  name: '飞书',
  enabled: true,
  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
  events: ['blocked', 'completed', 'failed'],
};

const calls: { url: string; body: string }[] = [];

function stubFetch(status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { body?: string }) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({}), { status });
    }),
  );
}

describe('channels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it('migrates a legacy feishuWebhook into a channel', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ feishuWebhook: 'https://open.feishu.cn/h/legacy', notifyEvents: ['blocked'] }),
    );
    const list = readChannels(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.type).toBe('feishu');
    expect(list[0]!.url).toContain('legacy');
    expect(list[0]!.events).toEqual(['blocked']);
    // 迁移结果落盘，第二次读不应重复迁移
    expect(readChannels(dir)).toHaveLength(1);
  });

  it('returns empty list and persists when nothing configured', () => {
    const dir = tmp();
    expect(readChannels(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'channels.json'))).toBe(true);
  });

  it('renders feishu payload shape', () => {
    const r = buildRequest(feishu, payload);
    expect(r.url).toBe(feishu.url);
    const body = JSON.parse(r.body) as { msg_type: string; content: { text: string } };
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('等待审批');
  });

  it('renders dingtalk payload with signature when secret set', () => {
    const ch: Channel = { ...feishu, id: 'c2', type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 'SEC123' };
    const r = buildRequest(ch, payload);
    expect(r.url).toContain('timestamp=');
    expect(r.url).toContain('sign=');
    const body = JSON.parse(r.body) as { msgtype: string; text: { content: string } };
    expect(body.msgtype).toBe('text');
    expect(body.text.content).toContain('等待审批');
  });

  it('omits signature when no secret', () => {
    const ch: Channel = { ...feishu, id: 'c3', type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t' };
    expect(buildRequest(ch, payload).url).not.toContain('sign=');
  });

  it('renders generic webhook as structured JSON', () => {
    const ch: Channel = { ...feishu, id: 'c4', type: 'webhook', url: 'https://example.com/hook' };
    const body = JSON.parse(buildRequest(ch, payload).body) as Record<string, unknown>;
    expect(body.source).toBe('paneflow');
    expect(body.event).toBe('blocked');
    expect(body.runId).toBe('r1');
    expect(body.nodeIds).toEqual(['planner']);
  });

  it('supports custom template placeholders', () => {
    const ch: Channel = { ...feishu, template: '[{{event}}] {{title}} :: {{body}} ({{runId}})' };
    const text = renderText(ch, payload);
    expect(text).toContain('[⛔ 等待审批]');
    expect(text).toContain(':: ');
    expect(text).toContain('(r1)');
  });

  it('dingSign is a stable urlencoded hmac', () => {
    const a = dingSign('SEC', 1700000000000);
    const b = dingSign('SEC', 1700000000000);
    expect(a).toBe(b);
    expect(a).toBe(encodeURIComponent(decodeURIComponent(a)));
    expect(dingSign('OTHER', 1700000000000)).not.toBe(a);
  });

  it('dispatches only to enabled channels subscribed to the event', async () => {
    const dir = tmp();
    writeChannels(dir, [
      { ...feishu, id: 'ok' },
      { ...feishu, id: 'off', enabled: false },
      { ...feishu, id: 'nosub', events: ['completed'] },
    ]);
    stubFetch();
    dispatchChannels(dir, payload);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('open.feishu.cn');
  });

  it('never throws when a channel fails', async () => {
    const dir = tmp();
    writeChannels(dir, [{ ...feishu, id: 'bad' }]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(() => dispatchChannels(dir, payload)).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
  });
});
