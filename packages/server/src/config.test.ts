import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultDataDir,
  defaultHerdrSocketPath,
  loadConfig,
  userHome,
  type PlatformView,
} from './config.js';

/**
 * v13-E2 Windows 诚实入账（默认路径候选）：
 *  - darwin/linux 上返回值与今天一字不差（现网零回归，每条都有断言钉住）；
 *  - win32 认 %APPDATA%（本机 darwin 未实机验证——测试锁的是纯函数语义）；
 *  - 显式 env 永远最优先。
 */

const darwin: PlatformView = { platform: 'darwin', env: {}, home: '/Users/u' };
const win32View = (env: NodeJS.ProcessEnv): PlatformView => ({
  platform: 'win32',
  env,
  home: 'C:\\Users\\u',
});

describe('defaultDataDir', () => {
  it('posix：与今天一字不差（~/.paneflow）', () => {
    expect(defaultDataDir(darwin)).toBe('/Users/u/.paneflow');
    expect(defaultDataDir({ platform: 'linux', env: {}, home: '/home/u' })).toBe('/home/u/.paneflow');
  });
  it('win32：认 %APPDATA%', () => {
    expect(defaultDataDir(win32View({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }))).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\paneflow',
    );
    // win32 env 键名大小写不稳（AppData 实存形态）照认
    expect(defaultDataDir(win32View({ Appdata: 'D:\\Roaming' }))).toBe('D:\\Roaming\\paneflow');
  });
  it('win32 无 APPDATA：回落主目录（宁缺毋假，不猜盘符）', () => {
    expect(defaultDataDir(win32View({}))).toBe('C:\\Users\\u\\.paneflow');
  });
});

describe('defaultHerdrSocketPath', () => {
  it('posix 默认与会话形态：与今天一字不差（~/.config/herdr/…）', () => {
    expect(defaultHerdrSocketPath(undefined, darwin)).toBe('/Users/u/.config/herdr/herdr.sock');
    expect(defaultHerdrSocketPath('pf-test', darwin)).toBe('/Users/u/.config/herdr/sessions/pf-test/herdr.sock');
  });
  it('win32：默认与会话都进 %APPDATA%\\herdr（XDG 是 posix 口径）', () => {
    const v = win32View({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' });
    expect(defaultHerdrSocketPath(undefined, v)).toBe('C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock');
    expect(defaultHerdrSocketPath('pf-test', v)).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\pf-test\\herdr.sock',
    );
  });
});

describe('userHome（fs-routes 浏览锚点的唯一口径）', () => {
  it('posix：HOME 在位即认 HOME（与今天 fs-routes 一致）', () => {
    expect(userHome({ platform: 'darwin', env: { HOME: '/home/override' }, home: '/real' })).toBe('/home/override');
  });
  it("posix：HOME 缺失回落 os.homedir 视图（好过旧的裸 '/'）", () => {
    expect(userHome({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe('/Users/u');
  });
  it('win32：认 USERPROFILE', () => {
    expect(userHome(win32View({ USERPROFILE: 'C:\\Users\\boss' }))).toBe('C:\\Users\\boss');
  });
});

describe('loadConfig：显式 env 仍最优先，缺省解析链与今天一致', () => {
  const keys = ['PF_DATA_DIR', 'PF_HERDR_SOCKET', 'PF_HERDR_SESSION', 'PF_PORT', 'PF_HOST', 'PF_TOKEN'] as const;

  const withEnv = async (overrides: NodeJS.ProcessEnv, fn: () => void): Promise<void> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, overrides);
    try {
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it('PF_DATA_DIR / PF_HERDR_SOCKET 压过一切缺省候选', () => {
    withEnv({ PF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cfg-')), PF_HERDR_SOCKET: '/tmp/x.sock' }, () => {
      const cfg = loadConfig();
      expect(cfg.dataDir).toBe(process.env.PF_DATA_DIR);
      expect(cfg.herdrSocketPath).toBe('/tmp/x.sock');
    });
  });

  it('PF_HERDR_SESSION 走会话形态缺省链（今天语义：~/.config/herdr/sessions/…）', () => {
    withEnv({ PF_HERDR_SESSION: 'alpha' }, () => {
      expect(loadConfig().herdrSocketPath).toBe(
        path.join(os.homedir(), '.config', 'herdr', 'sessions', 'alpha', 'herdr.sock'),
      );
    });
  });

  it('全缺省（本机即 posix）：dataDir/socket 与今天一字不差', () => {
    withEnv({}, () => {
      const cfg = loadConfig();
      expect(cfg.dataDir).toBe(path.join(os.homedir(), '.paneflow'));
      expect(cfg.herdrSocketPath).toBe(path.join(os.homedir(), '.config', 'herdr', 'herdr.sock'));
    });
  });
});
