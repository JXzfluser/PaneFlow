import fs from 'node:fs';
import path from 'node:path';

export interface NotifySettings {
  /** 飞书自定义机器人 webhook URL（出站推送，无公网暴露） */
  feishuWebhook?: string;
  /** 订阅事件：blocked / completed / failed（默认全开） */
  notifyEvents?: ('blocked' | 'completed' | 'failed')[];
}

function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json');
}

export function readNotifySettings(dataDir: string): NotifySettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')) as NotifySettings;
  } catch {
    return {};
  }
}

export function writeNotifySettings(dataDir: string, next: NotifySettings): void {
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2));
}

/**
 * Fire-and-forget outbound notification. Never throws, never blocks the
 * engine; silently no-ops when unconfigured or event not subscribed.
 */
export function notify(dataDir: string, event: 'blocked' | 'completed' | 'failed', text: string): void {
  const cfg = readNotifySettings(dataDir);
  if (!cfg.feishuWebhook) return;
  const events = cfg.notifyEvents ?? ['blocked', 'completed', 'failed'];
  if (!events.includes(event)) return;
  const body = JSON.stringify({
    msg_type: 'text',
    content: { text: `PaneFlow ${event === 'blocked' ? '⛔ 等待审批' : event === 'completed' ? '✅ 已完成' : '❌ 失败'}\n${text}` },
  });
  void fetch(cfg.feishuWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // notification failures must never affect pipeline execution
  });
}
