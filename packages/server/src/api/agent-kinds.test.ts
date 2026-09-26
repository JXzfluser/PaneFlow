import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { AGENT_BINARIES, AGENT_KINDS, agentBinaryName, isAgentKind } from './agent-kinds.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v14 前置-1：agent kind 两枚白名单合一（docs/iteration-v14-requirements.md §一 第 9 行 + §七 Q2）。
 *
 * 这片要防的病很具体：清单曾经写两遍（探测表 + 请求白名单），加一种 agent 只改一处时的症状**不是编译红**，
 * 而是两面读数互相打脸——实探说「这台机器装了它」、写入面判它「不是已知类型」（或反过来）。
 * 所以第一条判据就是「两张表的键集必须一字不差地相等」，它是合一这件事本身的机器证；
 * 第二条走真路由，证白名单与 `/api/health` 的 `agentKinds` 消费的是同一枚清单（不是又一份抄件）。
 */

const HOST = '127.0.0.1:4310';

function buildServer(dataDir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: { ping: async () => ({ version: 'test' }) } as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

describe('agent kind 单一事实源（v14 前置-1）', () => {
  it('白名单与探测表同源：键集相等、无重复项', () => {
    expect([...Object.keys(AGENT_BINARIES)].sort()).toEqual([...AGENT_KINDS].sort());
    expect(new Set(AGENT_KINDS).size).toBe(AGENT_KINDS.length);
  });

  it('合一没丢既有映射：只有 antigravity-cli 的二进制名与 kind 不同', () => {
    const renamed = Object.entries(AGENT_BINARIES).filter(([kind, bin]) => kind !== bin);
    expect(renamed).toEqual([['antigravity-cli', 'antigravity']]);
    expect(agentBinaryName('antigravity-cli')).toBe('antigravity');
  });

  it('清单外的串仍按原名探（detectInstalledAgents 的既有宽容，合一不许顺手收紧）', () => {
    expect(isAgentKind('node')).toBe(false);
    expect(agentBinaryName('node')).toBe('node');
  });

  it('isAgentKind 只认清单内的非空串（大小写与破烂一律 false）', () => {
    expect(isAgentKind('pi')).toBe(true);
    expect(isAgentKind('PI')).toBe(false);
    expect(isAgentKind('')).toBe(false);
    expect(isAgentKind(42)).toBe(false);
    expect(isAgentKind(undefined)).toBe(false);
  });
});

describe('合一后的消费面（真路由，不是抄件）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agent-kinds-'));

  it('GET /api/health 的 agentKinds 就是这一枚清单，agentsMissing 与实探互补', async () => {
    const { app } = await buildServer(dataDir);
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } })).json();
      expect(body.agentKinds).toEqual([...AGENT_KINDS]);
      const installed: string[] = body.env.agentsInstalled;
      const missing: string[] = body.env.agentsMissing;
      expect([...installed.filter((k) => AGENT_KINDS.includes(k as never)).concat(missing)].sort()).toEqual(
        [...AGENT_KINDS].sort(),
      );
      installed.forEach((k) => expect(missing).not.toContain(k));
    } finally {
      await app.close();
    }
  });

  it('PUT /api/spaces/:id 的 defaultAgentKind 走同一值域：未知 400 一句指路，已知才落档', async () => {
    const { app } = await buildServer(dataDir);
    try {
      const bad = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: dataDir, defaultAgentKind: 'not-an-agent' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('not-an-agent');

      const good = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: dataDir, defaultAgentKind: 'pi' },
      });
      expect(good.statusCode).toBe(200);
      const got = (await app.inject({ method: 'GET', url: '/api/spaces/demo', headers: { host: HOST } })).json();
      expect(got.defaultAgentKind).toBe('pi');
    } finally {
      await app.close();
    }
  });
});
