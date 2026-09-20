import { describe, expect, it, vi } from 'vitest';

// v11-C5：wikiPublishTick 信号面——node 环境无浏览器全局，先打桩再动态 import store
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
});
vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } });

const { useStore } = await import('./store.js');

describe('v11-C5 store.wikiPublishTick：发布成功 → 设置页沉淀卡自刷新信号', () => {
  it('初值为 0；notifyWikiPublished 逐次 +1（多次发布多次触发重拉）', () => {
    expect(useStore.getState().wikiPublishTick).toBe(0);
    useStore.getState().notifyWikiPublished();
    expect(useStore.getState().wikiPublishTick).toBe(1);
    useStore.getState().notifyWikiPublished();
    useStore.getState().notifyWikiPublished();
    expect(useStore.getState().wikiPublishTick).toBe(3);
  });

  it('只动这一个切片：bump 不污染其它状态', () => {
    const before = useStore.getState();
    const view = before.view;
    const space = before.space;
    useStore.getState().notifyWikiPublished();
    const after = useStore.getState();
    expect(after.wikiPublishTick).toBe(before.wikiPublishTick + 1);
    expect(after.view).toBe(view);
    expect(after.space).toBe(space);
    expect(after.runs).toBe(before.runs);
  });
});
