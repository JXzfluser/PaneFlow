import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/** A1（v7）：空间档案保存一致性——全字段回写后重读必须一致。 */
function buildServer(dataDir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-spaces-'));
}

const HOST = '127.0.0.1:4310';

describe('PUT /api/spaces/:id 保存一致性（v7-A1）', () => {
  it('全字段 PUT 后 GET 重读一致（conventionFiles/skills/repos 不再丢）', async () => {
    const { app } = await buildServer(tmp());
    try {
      const payload = {
        rootCwd: '/repo/main',
        description: 'd',
        conventionFiles: ['AGENTS.md', 'docs/CLAUDE.md'],
        skills: ['skills/pdf'],
        repos: ['svc-a', 'svc-b'],
      };
      const put = await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload });
      expect(put.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/api/spaces/demo', headers: { host: HOST } });
      const p = get.json();
      expect(p.conventionFiles).toEqual(payload.conventionFiles);
      expect(p.skills).toEqual(payload.skills);
      expect(p.repos).toEqual(payload.repos);
      expect(p.rootCwd).toBe('/repo/main');
    } finally {
      await app.close();
    }
  });

  it('磁盘持久：新 Store 实例（模拟重启服务）读到的档案含勾选字段', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { conventionFiles: ['AGENTS.md'] },
      });
    } finally {
      await app.close();
    }
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'demo', 'profile.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.conventionFiles).toEqual(['AGENTS.md']);
  });

  it('merge 语义保住未发送的键；空数组是显式清空而非丢失', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { conventionFiles: ['A.md'], skills: ['s1'] },
      });
      const second = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: '/x', skills: [] },
      });
      const p = second.json();
      expect(p.conventionFiles).toEqual(['A.md']); // 未发送 → 保住
      expect(p.skills).toEqual([]); // 显式空 → 清空
    } finally {
      await app.close();
    }
  });

  it('白名单：name/createdAt/id 不经 body 污染，未知键被忽略', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { description: 'ok' } });
      const evil = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { name: 'hijacked', createdAt: '1999-01-01', id: 'other', rootCwd: '/r', evilKey: 1 } as Record<string, unknown>,
      });
      const p = evil.json();
      expect(evil.statusCode).toBe(200);
      expect(p.name).not.toBe('hijacked');
      expect(p.createdAt).not.toBe('1999-01-01');
      expect(p.id).toBe('demo');
      expect(p.rootCwd).toBe('/r');
      expect((p as Record<string, unknown>).evilKey).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('__proto__ 注入在传输层即被拒（400），到不了白名单', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST, 'content-type': 'application/json' },
        payload: '{"rootCwd":"/r","__proto__":{"polluted":true}}',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('v9-B1 班底名册（team 机检 + 标准五连装填）', () => {
  it('合法 team 存取一致；merge 不误伤其他键', async () => {
    const { app } = await buildServer(tmp());
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: '/r', team: [{ roleId: 'std-planner', alias: '阿规' }, { roleId: 'x', note: '外聘' }] },
      });
      expect(put.statusCode).toBe(200);
      const p = put.json();
      expect(p.team).toEqual([{ roleId: 'std-planner', alias: '阿规' }, { roleId: 'x', note: '外聘' }]);
      expect(p.rootCwd).toBe('/r');
    } finally {
      await app.close();
    }
  });

  it('脏形状 400：非数组 / 缺 roleId / 超 16 项 / 重复入列', async () => {
    const { app } = await buildServer(tmp());
    try {
      const bad: unknown[] = [
        'nope',
        [{ role: 'typo' }],
        [{ roleId: '  ' }],
        Array.from({ length: 17 }, (_, i) => ({ roleId: `r${i}` })),
        [{ roleId: 'a' }, { roleId: 'a' }],
      ];
      for (const team of bad) {
        const res = await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { team } });
        expect(res.statusCode, JSON.stringify(team)).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('一键装填标准五连：team 落档案、std-* 角色进全局库、重复装填幂等', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      // 用户已有同名 id 的角色：装填不得覆盖
      await app.inject({
        method: 'PUT',
        url: '/api/roles',
        headers: { host: HOST },
        payload: { roles: [{ id: 'std-planner', name: '我的规划师', prePrompt: '自定义' }] },
      });
      const res = await app.inject({ method: 'POST', url: '/api/spaces/demo/team/standard', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profile.team.map((m: { roleId: string }) => m.roleId)).toEqual([
        'std-planner',
        'std-implementer',
        'std-reviewer',
        'std-verifier',
        'std-curator',
      ]);
      expect(body.profile.team[0].alias).toBe('我的规划师'); // 已存在的角色按库里的名字，不塞标准名
      const roles = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8')) as { id: string; name: string }[];
      expect(roles.find((r) => r.id === 'std-planner')!.name).toBe('我的规划师');
      expect(roles.filter((r) => r.id === 'std-implementer')).toHaveLength(1);
      const again = await app.inject({ method: 'POST', url: '/api/spaces/demo/team/standard', headers: { host: HOST } });
      const roles2 = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8')) as unknown[];
      expect(roles2).toHaveLength(5); // 幂等：不重复追加
      expect(again.json().profile.team).toEqual(body.profile.team);
    } finally {
      await app.close();
    }
  });
});

describe('v13-B1 delivery 声明位（PUT 机检 + GET 原样带出）', () => {
  const BUG = {
    repo: 'web-console',
    branchFrom: 'main',
    branchName: 'fix/issue-{issue}',
    prTarget: 'main',
    gates: ['对齐先行', 'PR 前', '关单前'],
    note: '驳回开 Bug 链回主 Issue',
  };
  const FEATURE = {
    repo: 'web-console',
    branchFrom: 'main',
    branchName: 'feature/v{version}-{issue}',
    prTarget: 'release/v{version}',
  };

  it('两副样本家规 PUT→GET 原样往返；GET /api/spaces 列表也带出；占位符不解析', async () => {
    const { app } = await buildServer(tmp());
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { delivery: [BUG, FEATURE] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().delivery).toEqual([BUG, FEATURE]);
      const get = await app.inject({ method: 'GET', url: '/api/spaces/demo', headers: { host: HOST } });
      expect(get.json().delivery).toEqual([BUG, FEATURE]);
      expect(get.json().delivery[1].branchName).toBe('feature/v{version}-{issue}'); // B1 不解析占位符
      const list = await app.inject({ method: 'GET', url: '/api/spaces', headers: { host: HOST } });
      const spaces = list.json().spaces as { id: string; delivery?: unknown }[];
      expect(spaces.find((s) => s.id === 'demo')?.delivery).toEqual([BUG, FEATURE]);
    } finally {
      await app.close();
    }
  });

  it('脏形状 400 拒写：非数组 / 必填缺失 / branchName 空串 / 未知键 / gates 破烂；拒后档案照旧无 delivery', async () => {
    const { app } = await buildServer(tmp());
    try {
      const bad: unknown[] = [
        'nope',
        [{ branchFrom: 'main', branchName: 'fix/{issue}' }], // 缺 prTarget
        [{ branchFrom: 'main', branchName: '  ', prTarget: 'main' }], // branchName 空串
        [{ ...BUG, branchTo: 'dev' }], // 未知键
        [{ ...FEATURE, gates: '三道人闸' }], // gates 非数组
      ];
      for (const delivery of bad) {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/spaces/demo',
          headers: { host: HOST },
          payload: { delivery },
        });
        expect(res.statusCode, JSON.stringify(delivery)).toBe(400);
        expect(res.json().error).toContain('delivery');
      }
      const get = await app.inject({ method: 'GET', url: '/api/spaces/demo', headers: { host: HOST } });
      expect('delivery' in get.json()).toBe(false); // 一次都没写进去——不静默塞半成品
    } finally {
      await app.close();
    }
  });

  it('红线：旧空间档案（完全没有 delivery 键）读写照常；PUT 其余字段不被静默塞入空数组', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/spaces/legacy',
        headers: { host: HOST },
        payload: { rootCwd: '/r', description: '老档案', team: [{ roleId: 'std-planner' }] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().rootCwd).toBe('/r');
      expect('delivery' in put.json()).toBe(false);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'legacy', 'profile.json'), 'utf8')) as Record<string, unknown>;
      expect('delivery' in raw).toBe(false);
      const list = await app.inject({ method: 'GET', url: '/api/spaces', headers: { host: HOST } });
      const legacy = (list.json().spaces as Record<string, unknown>[]).find((s) => s.id === 'legacy');
      expect(legacy && 'delivery' in legacy).toBe(false); // 列表端点同样缺省不显示、不造默认值
    } finally {
      await app.close();
    }
  });

  it('merge 语义：delivery 配好后 PUT 其余字段不误伤；显式 PUT delivery:[] 才清空', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { delivery: [BUG] },
      });
      const touch = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { description: '只改描述' },
      });
      expect(touch.json().delivery).toEqual([BUG]);
      const clear = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { delivery: [] },
      });
      expect(clear.json().delivery).toEqual([]); // 显式清空如实存，不冒充「已配置家规」
    } finally {
      await app.close();
    }
  });
});

describe('v10-U1 GET /api/roles/usage 部署聚合', () => {
  it('按 roleId 聚合各项目班底；alias 带上；无 team 的项目不产条目；悬空 roleId 也返回', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/alpha',
        headers: { host: HOST },
        payload: { team: [{ roleId: 'std-planner', alias: '阿规' }, { roleId: 'ghost', note: '库里没有的角色' }] },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/beta',
        headers: { host: HOST },
        payload: { team: [{ roleId: 'std-planner' }] },
      });
      await app.inject({ method: 'PUT', url: '/api/spaces/gamma', headers: { host: HOST }, payload: { description: '无班底' } });
      const res = await app.inject({ method: 'GET', url: '/api/roles/usage', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const { usage } = res.json() as { usage: Record<string, { spaceId: string; name: string; alias?: string }[]> };
      expect(usage['std-planner']).toEqual([
        { spaceId: 'alpha', name: 'alpha', alias: '阿规' },
        { spaceId: 'beta', name: 'beta' },
      ]);
      expect(usage['ghost']).toEqual([{ spaceId: 'alpha', name: 'alpha' }]);
      expect(usage['std-curator']).toBeUndefined(); // 没被任何班底引用的角色不占键
    } finally {
      await app.close();
    }
  });

  it('空数据目录 → usage 为 {}（不抛）', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/roles/usage', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ usage: {} });
    } finally {
      await app.close();
    }
  });
});
