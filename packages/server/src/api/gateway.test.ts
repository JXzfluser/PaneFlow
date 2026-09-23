import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildGatewayEnv,
  deleteGatewayProfile,
  listGatewayProfiles,
  PI_GATEWAY_PROVIDER,
  probeGatewayModels,
  readGateway,
  setCurrentGateway,
  syncPiGatewayProvider,
  upsertGatewayProfile,
  writeGateway,
} from './gateway.js';

function dirWith(settings: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-'));
  fs.writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify(settings));
  return dir;
}

function homeWithModelsJson(doc: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pihome-'));
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify(doc, null, 2));
  return home;
}

describe('v8-AE buildGatewayEnv 地址归一', () => {
  const base = { apiKey: 'sk-t', enabled: true, freeModel: 'auto/best-free' };

  it('用户把 /v1 一起贴进来也不会拼成 /v1/v1；ANTHROPIC 基址不带 /v1', () => {
    const env = buildGatewayEnv(dirWith({ ...base, baseUrl: 'http://gw.local:20128/v1' }));
    expect(env.OPENAI_API_BASE).toBe('http://gw.local:20128/v1');
    expect(env.OPENAI_BASE_URL).toBe('http://gw.local:20128/v1');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://gw.local:20128');
  });

  it('裸地址与尾斜杠同样归一', () => {
    for (const b of ['http://gw.local:20128', 'http://gw.local:20128/']) {
      const env = buildGatewayEnv(dirWith({ ...base, baseUrl: b }));
      expect(env.OPENAI_API_BASE).toBe('http://gw.local:20128/v1');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://gw.local:20128');
    }
  });

  it('未启用/缺 key 一律空对象（不注入）', () => {
    expect(buildGatewayEnv(dirWith({ ...base, baseUrl: 'http://gw', enabled: false }))).toEqual({});
    expect(buildGatewayEnv(dirWith({ baseUrl: 'http://gw', enabled: true }))).toEqual({});
  });

  it('PANEFLOW_GW_KEY 随 env 注入（models.json 里的 $ 引用靠它解析）', () => {
    const env = buildGatewayEnv(dirWith({ ...base, baseUrl: 'http://gw.local:20128/v1' }));
    expect(env.PANEFLOW_GW_KEY).toBe('sk-t');
  });

  it('网关主机进 NO_PROXY（herdr 继承的死代理不能挡住网关和本机回环）', () => {
    const env = buildGatewayEnv(dirWith({ ...base, baseUrl: 'http://gw.local:20128/v1' }));
    const list = env.NO_PROXY!.split(',');
    expect(list).toContain('gw.local');
    expect(list).toContain('127.0.0.1');
    expect(list).toContain('localhost');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
});

describe('v8-AF syncPiGatewayProvider（pi 走网关的 models.json 注册）', () => {
  const gw = { apiKey: 'sk-t', enabled: true, freeModel: 'glmcn/glm-4.7', baseUrl: 'http://gw.local:20128/v1' };

  it('网关启用：合并写入 paneflow-gw（openai-completions + $PANEFLOW_GW_KEY），不动用户其他 provider', () => {
    const dataDir = dirWith(gw);
    const home = homeWithModelsJson({ providers: { mine: { baseUrl: 'http://other' } } });
    const r = syncPiGatewayProvider(dataDir, { homeDir: home });
    expect(r.synced).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8')) as {
      providers: Record<string, { api?: string; baseUrl?: string; apiKey?: string; models?: { id: string }[] }>;
    };
    expect(doc.providers.mine).toBeTruthy();
    const p = doc.providers[PI_GATEWAY_PROVIDER]!;
    expect(p.api).toBe('openai-completions');
    expect(p.baseUrl).toBe('http://gw.local:20128/v1');
    expect(p.apiKey).toBe('$PANEFLOW_GW_KEY');
    expect(p.models![0]!.id).toBe('glmcn/glm-4.7');
    // 磁盘上绝不落明文 key
    expect(JSON.stringify(doc)).not.toContain('sk-t');
  });

  it('幂等：配置没变第二次调用不写盘；freeModel 变了则更新', () => {
    const dataDir = dirWith(gw);
    const home = homeWithModelsJson({ providers: {} });
    const file = path.join(home, '.pi', 'agent', 'models.json');
    expect(syncPiGatewayProvider(dataDir, { homeDir: home }).synced).toBe(true);
    const mtime = fs.statSync(file).mtimeMs;
    expect(syncPiGatewayProvider(dataDir, { homeDir: home }).synced).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    fs.writeFileSync(path.join(dataDir, 'gateway.json'), JSON.stringify({ ...gw, freeModel: 'auto/fast' }));
    expect(syncPiGatewayProvider(dataDir, { homeDir: home }).synced).toBe(true);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers: Record<string, { models: { id: string }[] }> };
    expect(doc.providers[PI_GATEWAY_PROVIDER]!.models[0]!.id).toBe('auto/fast');
  });

  it('网关停用：只摘掉 paneflow-gw，其余保留；models.json 不存在或损坏则不擅动', () => {
    const dataDir = dirWith(gw);
    const home = homeWithModelsJson({ providers: { mine: { baseUrl: 'http://other' } } });
    syncPiGatewayProvider(dataDir, { homeDir: home });
    fs.writeFileSync(path.join(dataDir, 'gateway.json'), JSON.stringify({ ...gw, enabled: false }));
    const r = syncPiGatewayProvider(dataDir, { homeDir: home });
    expect(r.synced).toBe(true);
    expect(r.removed).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8')) as {
      providers: Record<string, unknown>;
    };
    expect(doc.providers[PI_GATEWAY_PROVIDER]).toBeUndefined();
    expect(doc.providers.mine).toBeTruthy();
    // 损坏文件：不覆盖
    const bad = homeWithModelsJson('this-is-not-an-object-hopefully-parse-ok');
    fs.writeFileSync(path.join(bad, '.pi', 'agent', 'models.json'), '{{{ broken');
    expect(syncPiGatewayProvider(dirWith(gw), { homeDir: bad }).synced).toBe(false);
    expect(fs.readFileSync(path.join(bad, '.pi', 'agent', 'models.json'), 'utf8')).toBe('{{{ broken');
  });

  it('Z1 防误删：从未配过网关的 dataDir（新装/第二实例）不删别人写好的 paneflow-gw', () => {
    const freshDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-empty-'));
    const home = homeWithModelsJson({ providers: { [PI_GATEWAY_PROVIDER]: { baseUrl: 'http://other-instance' } } });
    const r = syncPiGatewayProvider(freshDataDir, { homeDir: home });
    expect(r.synced).toBe(false);
    expect(r.removed).toBeUndefined();
    const doc = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8')) as {
      providers: Record<string, { baseUrl?: string }>;
    };
    expect(doc.providers[PI_GATEWAY_PROVIDER]!.baseUrl).toBe('http://other-instance');
  });
});

describe('v9-D2 多网关档（profiles + current，旧扁平读侧兼容）', () => {
  it('旧扁平 gateway.json：readGateway 语义不变，列表包成一档「默认档」且为 current', () => {
    const dir = dirWith({ baseUrl: 'http://old/v1', apiKey: 'sk-old', freeModel: 'm-old', enabled: true });
    expect(readGateway(dir)).toEqual({ baseUrl: 'http://old/v1', apiKey: 'sk-old', freeModel: 'm-old', enabled: true });
    const { profiles, current } = listGatewayProfiles(dir);
    expect(current).toBe('default');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe('默认档');
    // 密钥只在服务端流转：列表只有 keyConfigured
    expect(profiles[0]!.apiKey).toBeUndefined();
    expect(profiles[0]!.keyConfigured).toBe(true);
  });

  it('writeGateway（旧消费方语义）：先改 current 档不增档；无档时建默认档', () => {
    const dir = dirWith({ baseUrl: 'http://old', apiKey: 'k', enabled: true });
    writeGateway(dir, { baseUrl: 'http://new', apiKey: 'k2', freeModel: 'fm', enabled: true });
    const { profiles, current } = listGatewayProfiles(dir);
    expect(profiles).toHaveLength(1);
    expect(current).toBe('default');
    expect(readGateway(dir)).toMatchObject({ baseUrl: 'http://new', apiKey: 'k2', freeModel: 'fm' });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-empty-'));
    writeGateway(empty, { baseUrl: 'http://first', apiKey: 'k', enabled: true });
    expect(readGateway(empty).baseUrl).toBe('http://first');
  });

  it('upsert：首档自动 current；同 id 覆盖且 apiKey 留空=保留旧值；非法 id 自动生成', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-'));
    const a = upsertGatewayProfile(dir, { id: 'gw-a', name: 'A 网关', baseUrl: 'http://a', apiKey: 'ka' });
    expect(a.enabled).toBe(true);
    expect(listGatewayProfiles(dir).current).toBe('gw-a');
    const b = upsertGatewayProfile(dir, { id: 'gw b bad!', name: 'B 网关', baseUrl: 'http://b', apiKey: 'kb' });
    expect(b.id).toMatch(/^gw-/);
    const re = upsertGatewayProfile(dir, { id: 'gw-a', name: 'A 网关', baseUrl: 'http://a2' });
    expect(re.apiKey).toBe('ka');
    expect(readGateway(dir, 'gw-a').baseUrl).toBe('http://a2');
  });

  it('current 切换与删除：未知 id 拒绝；唯一档不许删；删 current 顺延到第一档', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-'));
    upsertGatewayProfile(dir, { id: 'g1', name: '档一', baseUrl: 'http://1', apiKey: 'k1' });
    expect(setCurrentGateway(dir, 'nope')).toBe(false);
    expect(deleteGatewayProfile(dir, 'nope').ok).toBe(false);
    expect(deleteGatewayProfile(dir, 'g1').ok).toBe(false);
    expect(deleteGatewayProfile(dir, 'g1').error).toContain('只剩这一档');
    upsertGatewayProfile(dir, { id: 'g2', name: '档二', baseUrl: 'http://2', apiKey: 'k2' });
    expect(setCurrentGateway(dir, 'g2')).toBe(true);
    expect(readGateway(dir).baseUrl).toBe('http://2');
    expect(deleteGatewayProfile(dir, 'g2')).toEqual({ ok: true, current: 'g1' });
    expect(readGateway(dir).baseUrl).toBe('http://1');
  });

  it('空间钉档：buildGatewayEnv/gatewayActive 按 profileId 取档，悬空 id 回落 current；无 pin 用 current', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gw-'));
    upsertGatewayProfile(dir, { id: 'cur', name: '在用', baseUrl: 'http://cur', apiKey: 'kc', freeModel: 'm-cur' });
    upsertGatewayProfile(dir, { id: 'pin', name: '钉住', baseUrl: 'http://pin', apiKey: 'kp', freeModel: 'm-pin' });
    expect(buildGatewayEnv(dir, 'pin').ANTHROPIC_MODEL).toBe('m-pin');
    expect(buildGatewayEnv(dir).ANTHROPIC_MODEL).toBe('m-cur');
    expect(buildGatewayEnv(dir, 'dangling').ANTHROPIC_MODEL).toBe('m-cur');
    // 被钉档停用则不注入（即使 current 是启用档）——钉了就按钉的算
    upsertGatewayProfile(dir, { id: 'pin', name: '钉住', baseUrl: 'http://pin', apiKey: 'kp', enabled: false });
    expect(buildGatewayEnv(dir, 'pin')).toEqual({});
  });
});

describe('v11-prep probeGatewayModels：网关模型清单探针', () => {
  it('成功：剥 /v1 去重后拼 <base>/v1/models，带 Bearer，返回 id 清单且不含密钥', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('Authorization') ?? undefined });
      return new Response(JSON.stringify({ data: [{ id: 'glm-4.7' }, { id: 'auto' }, { nope: 1 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probeGatewayModels({ baseUrl: 'http://gw.example/v1', apiKey: 'sk-abc', enabled: true }, fakeFetch);
    expect(r).toEqual({ models: ['glm-4.7', 'auto'] });
    expect(calls[0]!.url).toBe('http://gw.example/v1/models');
    expect(calls[0]!.auth).toBe('Bearer sk-abc');
    expect(JSON.stringify(r)).not.toContain('sk-abc');
  });

  it('未配置/停用 → error 不发请求；非 2xx → HTTP 状态；网络炸 → message，全部不抛', async () => {
    const never = (async () => {
      throw new Error('不该被调用');
    }) as unknown as typeof fetch;
    expect(await probeGatewayModels({ baseUrl: 'http://gw', apiKey: 'k', enabled: false }, never)).toEqual({
      models: [],
      error: '网关未配置或未启用',
    });
    expect(await probeGatewayModels({ apiKey: 'k', enabled: true }, never)).toEqual({
      models: [],
      error: '网关未配置或未启用',
    });
    const bad = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await probeGatewayModels({ baseUrl: 'http://gw', apiKey: 'k', enabled: true }, bad)).toEqual({
      models: [],
      error: 'HTTP 503',
    });
    const boom = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const r = await probeGatewayModels({ baseUrl: 'http://gw', apiKey: 'k', enabled: true }, boom);
    expect(r.models).toEqual([]);
    expect(r.error).toContain('socket hang up');
  });
});
