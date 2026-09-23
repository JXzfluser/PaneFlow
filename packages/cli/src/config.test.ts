import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DEFAULT_URL, resolveBaseUrl } from './config.js';
import { makeIo, stubFetch } from './fixtures.js';
import { main } from './main.js';

describe('地址解析链：--url > PANEFLOW_URL > ~/.paneflow/cli.json > 默认', () => {
  const file = (url: string) => ({
    readFile: (p: string) =>
      p === path.join('/home/test', '.paneflow', 'cli.json') ? JSON.stringify({ url }) : null,
    homedir: () => '/home/test',
  });

  it('四级各取一环，高优先级压制低优先级', () => {
    const { io } = makeIo();
    expect(resolveBaseUrl(io)).toBe(DEFAULT_URL);
    expect(resolveBaseUrl({ ...io, ...file('http://file.test:1') })).toBe('http://file.test:1');
    expect(
      resolveBaseUrl({ ...io, ...file('http://file.test:1'), env: { PANEFLOW_URL: 'http://env.test:2/' } }),
    ).toBe('http://env.test:2'); // 尾斜杠剥掉
    expect(
      resolveBaseUrl(
        { ...io, ...file('http://file.test:1'), env: { PANEFLOW_URL: 'http://env.test:2' } },
        'http://flag.test:3',
      ),
    ).toBe('http://flag.test:3');
  });

  it('cli.json 坏 JSON / 无 url 字段：静默回落默认', () => {
    const { io } = makeIo({ homedir: () => '/home/test', readFile: () => '{ broken json' });
    expect(resolveBaseUrl(io)).toBe(DEFAULT_URL);
    expect(resolveBaseUrl({ ...io, readFile: () => '{}' })).toBe(DEFAULT_URL);
  });

  it('请求真的打到解析出的地址（含 PANEFLOW_TOKEN → Bearer 头）', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { runs: [] } }]);
    const { io, lines } = makeIo({
      fetch: fetchImpl,
      env: { PANEFLOW_URL: 'http://env.test:9', PANEFLOW_TOKEN: 'tk' },
    });
    expect(await main(['runs'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://env.test:9/api/runs');
    expect(calls[0]!.init.headers?.authorization).toBe('Bearer tk');
    expect(lines).toEqual(['（暂无 run）']);
  });
});
