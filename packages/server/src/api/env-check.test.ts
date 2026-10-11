import { describe, expect, it } from 'vitest';
import {
  clearAgentProbeCache,
  detectInstalledAgents,
  probeWin32Binary,
  recommendAgentKind,
  resolveAutoAgentKind,
  RECOMMEND_PRIORITY,
} from './env-check.js';

/**
 * v13-E2 Windows 诚实入账：探测三态各锁一条——
 *  1) win32 命中：PATH × PATHEXT 枚举要能命中 .cmd/.exe 后缀（win32 的 npm 系 CLI 全是 .cmd shim）；
 *  2) win32 未命中：装了假 fs 视图全不中 → false（宁缺毋假，不猜）；
 *  3) posix 路：command -v 行为与今天一字不差（现网零回归优先）。
 */

describe('probeWin32Binary（PATH × PATHEXT 纯枚举，不起 shell）', () => {
  const env = { PATH: 'C:\\tools;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.CMD' };
  // 注入的「文件系统视图」按 win32 真实语义大小写不敏感（默认视图 win32FileExists 走真 fs，天然如此）
  const view = (target: string) => (p: string) => p.toLowerCase() === target.toLowerCase();

  it('win32 命中 .cmd：候选以 win32 分隔符拼接，逐个过文件系统视图', () => {
    const seen: string[] = [];
    const hit = probeWin32Binary('pi', env, (p) => {
      seen.push(p);
      return view('C:\\tools\\pi.cmd')(p);
    });
    expect(hit).toBe(true);
    expect(seen.map((p) => p.toLowerCase())).toContain('c:\\tools\\pi.exe'); // PATHEXT 全枚举，不押注单一后缀
    expect(seen.map((p) => p.toLowerCase())).toContain('c:\\tools\\pi.cmd');
  });

  it('win32 命中 .exe：落在 PATH 第二目录也算', () => {
    expect(probeWin32Binary('codex', env, view('C:\\Windows\\System32\\codex.exe'))).toBe(true);
  });

  it('win32 未装：所有组合都不命中 → false（哪怕 bin 撞上个目录名——只认文件）', () => {
    // 视图只「存在」一个同名目录/无关文件——都不算命中
    expect(probeWin32Binary('qwen', env, () => false)).toBe(false);
  });

  it('无 PATH 读数 = false（拿不到不猜）', () => {
    expect(probeWin32Binary('pi', { PATHEXT: '.EXE' }, () => true)).toBe(false);
    expect(probeWin32Binary('pi', {}, () => true)).toBe(false);
  });

  it('bin 自带扩展名时按原名直判（不再叠 PATHEXT 也能中）', () => {
    expect(probeWin32Binary('claude.exe', env, view('C:\\tools\\claude.exe'))).toBe(true);
  });

  it('env 键名大小写不稳（Path/PathExt 实际存在过的形态）照判', () => {
    expect(probeWin32Binary('pi', { Path: 'C:\\tools', PathExt: '.cmd' }, view('C:\\tools\\pi.cmd'))).toBe(true);
  });

  it('PATHEXT 缺失回落常识默认（.COM;.EXE;.BAT;.CMD）', () => {
    expect(probeWin32Binary('droid', { PATH: 'D:\\bin' }, view('D:\\bin\\droid.bat'))).toBe(true);
  });
});

describe('posix 路（sh -c command -v）：行为与今天一字不差', () => {
  // 该分支只在非 win32 生产可达；win32 真机上跳过（它验的是 darwin/linux 的现网行为）
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('真实存在的二进制探测为已装（kind 不在 AGENT_BINARIES 时按 kind 原名探）', async () => {
    clearAgentProbeCache();
    expect(await detectInstalledAgents(['node'])).toEqual(['node']);
  });

  posixIt('不存在的 kind 探测为缺（不回装错集）', async () => {
    clearAgentProbeCache();
    expect(await detectInstalledAgents(['paneflow-no-such-agent-kind'])).toEqual([]);
  });

  posixIt('recommendAgentKind：装了推荐链即返回其中实装的第一优先，全空返回 null（不猜）', async () => {
    clearAgentProbeCache();
    const installed = await detectInstalledAgents([...RECOMMEND_PRIORITY]);
    const reco = await recommendAgentKind();
    if (installed.length) {
      expect(reco).toBe(RECOMMEND_PRIORITY.find((k) => installed.includes(k)));
    } else {
      expect(reco).toBeNull(); // v13-E2 fail-closed 的读数前提：null 是「不知道/没有」，不是 'claude'
    }
  });
});

describe('resolveAutoAgentKind（「自动派活会落到哪个引擎」的单源梯）', () => {
  it('档案里的默认引擎在白名单内即 project-default，实探根本不该被调用（省一次 sh 子进程）', async () => {
    let probed = 0;
    const read = await resolveAutoAgentKind(' pi ', async () => {
      probed++;
      return 'codex';
    });
    expect(read).toEqual({
      agentKind: 'pi',
      via: 'project-default',
      note: '引擎按项目默认解析 → pi（各步若自绑岗位，仍以该岗的引擎为准）',
    });
    expect(probed).toBe(0);
  });

  it('档案默认是本机不认的 kind → 与接单口同尺：不算默认，落实探那一级', async () => {
    const read = await resolveAutoAgentKind('not-a-kind', async () => 'opencode');
    expect(read).toMatchObject({ agentKind: 'opencode', via: 'probed' });
    expect(read.note).toContain('按本机实探落到 → opencode');
  });

  it('两路全空 → none + agentKind null（null 是「查过了没有」，与 unknown 的「没查成」分家）', async () => {
    const read = await resolveAutoAgentKind(undefined, async () => null);
    expect(read.agentKind).toBeNull();
    expect(read.via).toBe('none');
    expect(read.note).toContain('派不出单');
  });

  it('实探返回 undefined（http deps 那张签名）也当没有，不落成 agentKind: undefined', async () => {
    expect((await resolveAutoAgentKind('', async () => undefined)).via).toBe('none');
  });
});
