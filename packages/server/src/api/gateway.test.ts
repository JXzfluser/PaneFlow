import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGatewayEnv, PI_GATEWAY_PROVIDER, syncPiGatewayProvider } from './gateway.js';

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
});
