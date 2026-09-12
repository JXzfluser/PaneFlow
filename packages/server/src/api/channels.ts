import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

/**
 * 出站通道层：把原先「只有飞书一种、且写死在 notifier 里」的通知，
 * 抽成可配置的通道插件。每个通道独立选择类型、订阅事件与消息模板。
 */

export type ChannelType = 'webhook' | 'feishu' | 'dingtalk';
export type NotifyEvent = 'blocked' | 'completed' | 'failed';

export const ALL_EVENTS: NotifyEvent[] = ['blocked', 'completed', 'failed'];

export const EVENT_LABEL: Record<NotifyEvent, string> = {
  blocked: '⛔ 等待审批',
  completed: '✅ 已完成',
  failed: '❌ 失败',
};

export const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
  webhook: '通用 Webhook（自定义 JSON）',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
};

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** 接收地址（飞书/钉钉为机器人 webhook，通用 webhook 为任意 POST 端点） */
  url: string;
  /** 钉钉加签密钥（可选）；留空则用「自定义关键词」以外的普通模式 */
  secret?: string;
  /** 订阅的事件；空数组视为全不选 */
  events: NotifyEvent[];
  /** 可选消息模板，支持 {{title}} {{body}} {{event}} {{runId}} */
  template?: string;
}

export interface NotifyPayload {
  event: NotifyEvent;
  title: string;
  body: string;
  runId?: string;
  dagName?: string;
  nodeIds?: string[];
}

interface ChannelsFile {
  channels: Channel[];
}

function channelsPath(dataDir: string): string {
  return path.join(dataDir, 'channels.json');
}

function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json');
}

export function readChannels(dataDir: string): Channel[] {
  try {
    const raw = JSON.parse(fs.readFileSync(channelsPath(dataDir), 'utf8')) as ChannelsFile;
    if (Array.isArray(raw.channels)) return raw.channels;
  } catch {
    // fall through to migration
  }
  return migrateLegacy(dataDir);
}

/**
 * 一次性迁移：把旧的 settings.json 里的 feishuWebhook 变成一条飞书通道，
 * 保证升级后用户原有配置不丢。迁移结果落盘，避免每次读盘都重写。
 */
function migrateLegacy(dataDir: string): Channel[] {
  const out: Channel[] = [];
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')) as {
      feishuWebhook?: string;
      notifyEvents?: NotifyEvent[];
    };
    if (s.feishuWebhook && !s.feishuWebhook.startsWith('(')) {
      out.push({
        id: 'ch-feishu-legacy',
        type: 'feishu',
        name: '飞书（迁移自旧配置）',
        enabled: true,
        url: s.feishuWebhook,
        events: s.notifyEvents?.length ? s.notifyEvents : [...ALL_EVENTS],
      });
    }
  } catch {
    // no legacy settings
  }
  try {
    fs.writeFileSync(channelsPath(dataDir), JSON.stringify({ channels: out }, null, 2));
  } catch {
    // best effort
  }
  return out;
}

export function writeChannels(dataDir: string, channels: Channel[]): void {
  fs.writeFileSync(channelsPath(dataDir), JSON.stringify({ channels }, null, 2));
}

/** 渲染模板：未配置时按通道类型走默认排版。 */
export function renderText(ch: Channel, p: NotifyPayload): string {
  const base = `${p.title}\n${p.body}`;
  if (!ch.template) return base;
  return ch.template
    .replace(/\{\{title\}\}/g, p.title)
    .replace(/\{\{body\}\}/g, p.body)
    .replace(/\{\{event\}\}/g, EVENT_LABEL[p.event])
    .replace(/\{\{runId\}\}/g, p.runId ?? '');
}

/** 钉钉加签：timestamp + "\n" + secret 的 HMAC-SHA256，base64 后 urlencode。 */
export function dingSign(secret: string, timestamp: number): string {
  const str = `${timestamp}\n${secret}`;
  return encodeURIComponent(createHmac('sha256', secret).update(str).digest('base64'));
}

/** 按通道类型拼出最终 URL 与请求体。导出以便单测直接断言。 */
export function buildRequest(ch: Channel, p: NotifyPayload): { url: string; body: string } {
  const text = renderText(ch, p);
  if (ch.type === 'feishu') {
    return { url: ch.url, body: JSON.stringify({ msg_type: 'text', content: { text } }) };
  }
  if (ch.type === 'dingtalk') {
    let url = ch.url;
    if (ch.secret) {
      const ts = Date.now();
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}timestamp=${ts}&sign=${dingSign(ch.secret, ts)}`;
    }
    return { url, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
  }
  // 通用 webhook：结构化 JSON，便于对接任意系统
  return {
    url: ch.url,
    body: JSON.stringify({
      source: 'paneflow',
      event: p.event,
      eventLabel: EVENT_LABEL[p.event],
      title: p.title,
      body: p.body,
      runId: p.runId ?? null,
      dagName: p.dagName ?? null,
      nodeIds: p.nodeIds ?? [],
      at: new Date().toISOString(),
    }),
  };
}

/** 发送一条（返回是否成功），供「测试发送」与分发共用。 */
export async function sendChannel(ch: Channel, p: NotifyPayload): Promise<{ ok: boolean; error?: string }> {
  try {
    const { url, body } = buildRequest(ch, p);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 向所有「启用且订阅了该事件」的通道推送。
 * 与引擎解耦：失败绝不抛出、绝不阻塞流水线。
 */
export function dispatchChannels(dataDir: string, p: NotifyPayload): void {
  let channels: Channel[] = [];
  try {
    channels = readChannels(dataDir);
  } catch {
    return;
  }
  for (const ch of channels) {
    if (!ch.enabled || !ch.url) continue;
    if (!ch.events.includes(p.event)) continue;
    void sendChannel(ch, p).catch(() => {
      // notification failures must never affect pipeline execution
    });
  }
}
