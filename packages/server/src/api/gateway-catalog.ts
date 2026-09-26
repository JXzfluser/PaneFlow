import { probeGatewayModels, type GatewayProfile } from './gateway.js';

/**
 * v14 R4「探测单通道」的网关侧一件：档位 → 实探模型清单，**缓存 / 时效 / 强刷只此一份实现**。
 *
 * 为什么从 `http.ts` 的路由闭包里搬出来：那段 `catalogCache` 长在 `/api/gateway/catalog` 的处理器内部，
 * 于是第二个消费者（注册中心的健康点）要么再抄一份 TTL、要么绕过实探——两条都是在造第二份判据。
 * 现在路由与探针都走这里；密钥永不进返回值（`probeGatewayModels` 的返回值本就不带它）。
 */
const TTL_MS = 5 * 60_000;

interface Hit {
  at: number;
  models: string[];
  error?: string;
}

/** 键含 dataDir：同进程里多实例（测试各起 tmp 目录）互不吃对方的读数 */
const cache = new Map<string, Hit>();

export interface CatalogProfile {
  id: string;
  name: string;
  baseUrl: string;
  freeModel: string;
  isCurrent: boolean;
  models: string[];
  error?: string;
  /** 这份清单的探得时刻（缓存命中时是当初那一探的时刻，不是本次渲染时刻） */
  probedAt: number;
  /** 本次读数是不是缓存（落盘于 >50ms 之前）——披露用，不参与判定 */
  cached: boolean;
}

/**
 * 逐档实探（并发）。`targets` 由调用方选好（选档与 404 是路由的事），这里只管探与缓存。
 * 一档探不通不拖垮整表：那句 error 挂在那一档上。
 */
export async function probeCatalogProfiles(
  dataDir: string,
  targets: GatewayProfile[],
  current: string | null,
  opts: { refresh?: boolean } = {},
): Promise<CatalogProfile[]> {
  return Promise.all(
    targets.map(async (p) => {
      const key = `${dataDir}\u0000${p.id}`;
      let hit = opts.refresh ? undefined : cache.get(key);
      if (hit && Date.now() - hit.at >= TTL_MS) hit = undefined;
      if (!hit) {
        const { id: _id, name: _name, ...settings } = p;
        const probe = await probeGatewayModels(settings);
        hit = { at: Date.now(), models: probe.models, error: probe.error };
        cache.set(key, hit);
      }
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl ?? '',
        freeModel: p.freeModel ?? '',
        isCurrent: p.id === current,
        models: hit.models,
        error: hit.error,
        probedAt: hit.at,
        cached: Date.now() - hit.at > 50,
      };
    }),
  );
}

/** 档位改了/删了：把这一档的缓存丢掉（下次实探拿新配置，不吃旧清单） */
export function invalidateCatalogProfile(dataDir: string, profileId: string): void {
  cache.delete(`${dataDir}\u0000${profileId}`);
}
