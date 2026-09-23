import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { CliIo } from './types.js';

/** server 缺省地址：与 packages/server/src/config.ts 的 :4310 对齐 */
export const DEFAULT_URL = 'http://127.0.0.1:4310';

/**
 * 地址解析链：--url > env PANEFLOW_URL > ~/.paneflow/cli.json（{url}）> 默认。
 * 文件读不到/JSON 坏/无 url 字段都静默跳过（链下一环说话）。
 */
export function resolveBaseUrl(io: Pick<CliIo, 'env' | 'homedir' | 'readFile'>, flagUrl?: string): string {
  const pick = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().replace(/\/+$/, '');
    return s || undefined;
  };
  const fromFlag = pick(flagUrl);
  if (fromFlag) return fromFlag;
  const fromEnv = pick(io.env.PANEFLOW_URL);
  if (fromEnv) return fromEnv;
  try {
    const file = io.readFile(path.join(io.homedir(), '.paneflow', 'cli.json'));
    if (file) {
      const fromFile = pick((JSON.parse(file) as { url?: unknown }).url);
      if (fromFile) return fromFile;
    }
  } catch {
    // 配置文件的缺席与损坏不是错误——回落链继续
  }
  return DEFAULT_URL;
}

export function defaultIo(): CliIo {
  // 管道下游（| head / | jq）提前关读会抛异步 EPIPE——不吞掉就是满屏栈+非零码，
  // 把「输出已送达、读者走了」误报成命令失败
  const quietPipe = (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  };
  process.stdout.on('error', quietPipe);
  process.stderr.on('error', quietPipe);
  return {
    fetch: globalThis.fetch,
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
    env: process.env as Record<string, string | undefined>,
    homedir: () => os.homedir(),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  };
}
