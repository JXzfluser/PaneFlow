import { describe, expect, it } from 'vitest';
import { canonicalJson, contentSha, harnessDriftDiffs } from './harness.js';

describe('v12-V1 canonicalJson / contentSha（稳定序列化与指纹）', () => {
  it('键插入序不同 → 序列化逐字节一致（sha 可复算）', () => {
    const a = { name: 'g', nodes: [{ id: 'n1', config: { prompt: 'p', agentKind: 'pi' } }], version: 1 };
    const b = { version: 1, nodes: [{ config: { agentKind: 'pi', prompt: 'p' }, id: 'n1' }], name: 'g' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentSha(a)).toBe(contentSha(b));
  });

  it('嵌套层也排序；值任何一处变化 sha 即变；undefined 成员按 JSON 语义丢弃/折 null', () => {
    const base = { x: { b: 1, a: 2 }, list: [1, 2] };
    expect(canonicalJson(base)).toBe('{"list":[1,2],"x":{"a":2,"b":1}}');
    expect(canonicalJson({ x: base, y: undefined })).toBe(canonicalJson({ x: base }));
    expect(canonicalJson({ list: [undefined] })).toBe('{"list":[null]}');
    expect(contentSha({ x: { b: 1, a: 2 } })).not.toBe(contentSha({ x: { b: 2, a: 2 } }));
  });

  it('指纹是 sha256 前 8 位十六进制（与 v8-M6 templateSha 同口径），对同一输入两次调用稳定', () => {
    const g = { version: 1, name: 'serial-test', nodes: [], edges: [] };
    const sha = contentSha(g);
    expect(sha).toMatch(/^[0-9a-f]{8}$/);
    expect(contentSha(g)).toBe(sha);
  });
});

describe('v12-V1 harnessDriftDiffs（replay 漂移比对：只比 model/钉档，只报不拦）', () => {
  it('原记录无 harness（旧单）或新单没算出来 → 无从比，返回空', () => {
    expect(harnessDriftDiffs(undefined, { graphSha: 'x', agentKind: 'pi' })).toEqual([]);
    expect(harnessDriftDiffs({ graphSha: 'x', agentKind: 'pi' }, undefined)).toEqual([]);
  });

  it('一致（含双方都缺省）→ 无差异；gwProfile/model 任一变了 → 给「原→今」文案', () => {
    const h = { graphSha: 'x', agentKind: 'pi' };
    expect(harnessDriftDiffs(h, { ...h })).toEqual([]);
    expect(harnessDriftDiffs({ ...h, gwProfile: 'a', model: 'm' }, { ...h, gwProfile: 'a', model: 'm' })).toEqual([]);
    expect(harnessDriftDiffs({ ...h, gwProfile: 'a' }, { ...h, gwProfile: 'b' })).toEqual(['钉档 a→b']);
    expect(harnessDriftDiffs({ ...h, model: 'free' }, { ...h })).toEqual(['model free→未设']);
    expect(harnessDriftDiffs(h, { ...h, model: 'free' })).toEqual(['model 未设→free']);
    // agentKind/graphSha 不在比对面（graphSha replay 恒等，R5 不做判据）
    expect(harnessDriftDiffs({ ...h, graphSha: 'a', agentKind: 'pi' }, { ...h, graphSha: 'b', agentKind: 'claude' })).toEqual([]);
    const both = harnessDriftDiffs({ ...h, gwProfile: 'a', model: 'm1' }, { ...h, gwProfile: 'b', model: 'm2' });
    expect(both).toEqual(['钉档 a→b', 'model m1→m2']);
  });
});
