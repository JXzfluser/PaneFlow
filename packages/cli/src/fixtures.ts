import type { CliIo } from './types.js';

/**
 * 测试夹具：假 io（内存 stdout/stderr、可注入 fetch/时钟）。
 * 生产代码不 import 这个文件——只给 *.test.ts 用。
 */
export function makeIo(overrides: Partial<CliIo> = {}) {
  const lines: string[] = [];
  const errLines: string[] = [];
  const io: CliIo = {
    fetch: async () => {
      throw new Error('test: fetch not stubbed');
    },
    out: (l) => lines.push(l),
    err: (l) => errLines.push(l),
    env: {},
    homedir: () => '/home/test',
    readFile: () => null,
    now: () => Date.now(),
    sleep: async () => {},
    color: false,
    ...overrides,
  };
  return { io, lines, errLines };
}

/** 假 fetch：按序回放响应（JSON），并记录每次调用 */
export function stubFetch(responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: (init ?? {}) as typeof calls[number]['init'] });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/** 假时钟：sleep(ms) 直接推进 now，watch 测试零等待 */
export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}
