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

import { dispatchChannels, EVENT_LABEL, type NotifyEvent } from './channels.js';

/**
 * 出站通知（已由通道层接管）。
 *
 * 保留本函数只是为了兼容既有调用点与测试：真正的行为在 `channels.dispatchChannels`
 * ——旧 settings.json 里的 feishuWebhook 会在首次读通道时自动迁移为一条飞书通道，
 * 因此升级后原有配置不丢。
 */
export function notify(dataDir: string, event: NotifyEvent, text: string): void {
  dispatchChannels(dataDir, { event, title: `PaneFlow ${EVENT_LABEL[event]}`, body: text });
}
