import { describe, expect, it } from 'vitest';
import type { DagGraph } from '@paneflow/shared';
import {
  canonicalJson,
  computeCtxSha,
  contentSha,
  ctxShaDriftDiff,
  EXPERIENCE_BLOCK_HEAD_PREFIX,
  EXPERIENCE_BLOCK_TAIL_PREFIX,
  graphHasReadbackBlock,
  harnessDriftDiffs,
  skeletonGraph,
  skeletonSha,
  stripInjectionBlocks,
  type SkeletonLiteral,
} from './harness.js';
import { READBACK_HEADER } from './readback.js';

/** v13-V2 起 RunHarness 必填等臂两键的底座（比对面只认逐字段）；v13-V4 ctxSha 同为可选比对面 */
const h = (over: { graphSha?: string; agentKind?: string; gwProfile?: string; model?: string; skeletonSha?: string; ctxSha?: string } = {}) => ({
  graphSha: 'x',
  agentKind: 'pi',
  readback: false as const,
  readbackOutcome: 'switch-off' as const,
  ...over,
});

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

describe('v12-V1 + v13-V2 harnessDriftDiffs（replay 漂移比对：钉档/model + 骨架，只报不拦）', () => {
  it('原记录无 harness（旧单）或新单没算出来 → 无从比，返回空', () => {
    expect(harnessDriftDiffs(undefined, h())).toEqual([]);
    expect(harnessDriftDiffs(h(), undefined)).toEqual([]);
  });

  it('一致（含双方都缺省）→ 无差异；gwProfile/model 任一变了 → 给「原→今」文案', () => {
    expect(harnessDriftDiffs(h(), { ...h() })).toEqual([]);
    expect(harnessDriftDiffs(h({ gwProfile: 'a', model: 'm' }), h({ gwProfile: 'a', model: 'm' }))).toEqual([]);
    expect(harnessDriftDiffs(h({ gwProfile: 'a' }), h({ gwProfile: 'b' }))).toEqual(['钉档 a→b']);
    expect(harnessDriftDiffs(h({ model: 'free' }), h())).toEqual(['model free→未设']);
    expect(harnessDriftDiffs(h(), h({ model: 'free' }))).toEqual(['model 未设→free']);
    // agentKind/graphSha 不在比对面（graphSha 被注入块改写，v13-V2 起比的是骨架）
    expect(harnessDriftDiffs(h({ graphSha: 'a' }), h({ graphSha: 'b', agentKind: 'claude' }))).toEqual([]);
    const both = harnessDriftDiffs(h({ gwProfile: 'a', model: 'm1' }), h({ gwProfile: 'b', model: 'm2' }));
    expect(both).toEqual(['钉档 a→b', 'model m1→m2']);
  });

  it('v13-V2 骨架入比对面：skeletonSha 不等=真拓扑漂移（给原→今指纹）；相等/任一侧缺键（旧单）不报', () => {
    expect(harnessDriftDiffs(h({ skeletonSha: 'aaaa1111' }), h({ skeletonSha: 'bbbb2222' }))).toEqual([
      '骨架 #aaaa1111→#bbbb2222（剥注入块后真拓扑已变）',
    ]);
    expect(harnessDriftDiffs(h({ skeletonSha: 'aaaa1111' }), h({ skeletonSha: 'aaaa1111' }))).toEqual([]);
    expect(harnessDriftDiffs(h({ skeletonSha: 'aaaa1111' }), h())).toEqual([]); // 新侧缺键不猜
    expect(harnessDriftDiffs(h(), h({ skeletonSha: 'aaaa1111' }))).toEqual([]); // 源侧旧单不猜
  });

  it('v13-V2 改判：readback/readbackOutcome 差不算漂移——那是 A/B 的受测变量（实验设计）', () => {
    expect(
      harnessDriftDiffs(
        { ...h(), readback: false, readbackOutcome: 'switch-off' },
        { ...h(), readback: true, readbackOutcome: 'injected' },
      ),
    ).toEqual([]);
  });
});

// -- v13-V2 等臂机检：读回块实扫 + 骨架指纹（「只差读回块 → skeletonSha 相等」「改了真拓扑 → 不等」两条命门） --
describe('v13-V2 graphHasReadbackBlock（扫 graph 实态：块在不在就是有没有）', () => {
  const block = (pages: string) => [READBACK_HEADER, '以下摘录……', `- s/a.md 「页」：${pages}`].join('\n');

  it('prompt 尾部注入块（引擎姿势：\\n\\n + 表头独占行）命中；无块不命中；非 prompt 字段出现表头同样命中', () => {
    expect(graphHasReadbackBlock({ nodes: [{ config: { prompt: `干活。\n\n${block('x')}` } }] })).toBe(true);
    expect(graphHasReadbackBlock({ nodes: [{ config: { prompt: '干活，没沉淀可读。' } }] })).toBe(false);
    // 表头必须独占一行才算块——正文里顺嘴提一句「## 相关沉淀（PaneFlow wiki）」不算
    expect(graphHasReadbackBlock({ nodes: [{ config: { prompt: `见 ## 相关沉淀（PaneFlow wiki） 一节` } }] })).toBe(false);
    expect(graphHasReadbackBlock({ nodes: [{ config: { label: `${READBACK_HEADER}\n` } }] })).toBe(true);
  });

  it('replay 二次堆叠（旧块+新块连排）照出 true——off 臂带旧块骗不过实扫', () => {
    const doubled = { nodes: [{ config: { prompt: `本体\n\n${block('旧')}\n\n${block('新')}` } }] };
    expect(graphHasReadbackBlock(doubled)).toBe(true);
  });
});

describe('v13-V2 skeletonGraph / skeletonSha（剥注入块 + 归一 run_id/draft_dir）', () => {
  const RB_HEADER = READBACK_HEADER;
  const readbackBlock = (page: string) => `${RB_HEADER}\n以下摘录……\n- s/a.md 「页」：${page}`;
  const experienceBlock = (prevRunId: string) =>
    [
      `${EXPERIENCE_BLOCK_HEAD_PREFIX}，仅变量层】同空间同模板（demo）的绿 run ${prevRunId}：`,
      `· 当时实填变量：task=甲`,
      `· 当时的断言清单（措辞与颗粒度可借鉴；本单以自身契约为准）：`,
      `  - AC-1：断言甲`,
      `· 成本画像：总耗时 1.0 分、重试 0 次、tokens 未知（agent 未自报）`,
      `${EXPERIENCE_BLOCK_TAIL_PREFIX}；不要因为「上次这么干过」就照抄路径。`,
    ].join('\n');

  /** 两臂共用的图底：prompt 里带本次 run_id/draft_dir 字面量（applyVariables 烧进去的形态） */
  const armGraph = (promptSuffix: string, runId: string, draftDir: string): DagGraph =>
    ({
      version: 1,
      name: 'c4-demo',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'impl', type: 'agent', label: '实现', config: { agentKind: 'pi', prompt: `实现导出模块的空值兜底，草稿落 ${draftDir}，分支 pf/${runId}。${promptSuffix}` } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'impl' },
        { id: 'e2', source: 'impl', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    }) as unknown as DagGraph;

  const lits = (runId: string, draftDir: string): SkeletonLiteral[] => [
    { token: '{{run_id}}', value: runId },
    { token: '{{draft_dir}}', value: draftDir },
  ];

  it('命门一：fresh dispatch 两臂只差一个读回块（各自的 run_id/draft_dir 与注入块内容都不同）→ skeletonSha 相等', () => {
    const on = armGraph(`\n\n${readbackBlock('登录页修复经验，摘录甲乙丙')}`, 'aaaa1111', '/data/drafts/aaaa1111');
    const off = armGraph('', 'bbbb2222', '/data/drafts/bbbb2222');
    // 直接 graphSha 必不同（注入块+路径字面量都改写了指纹）——这正是 v13 批判轮的账
    expect(contentSha(on)).not.toBe(contentSha(off));
    expect(skeletonSha(on, lits('aaaa1111', '/data/drafts/aaaa1111'))).toBe(
      skeletonSha(off, lits('bbbb2222', '/data/drafts/bbbb2222')),
    );
  });

  it('命门一（加码）：on 臂带 I2 经验块、off 臂不带；off 臂 replay 二次堆叠旧块——全剥净后骨架仍相等', () => {
    const on = armGraph(`\n\n${experienceBlock('prev0001')}\n\n${readbackBlock('经验页摘录')}`, 'aaaa1111', '/data/drafts/aaaa1111');
    const offDoubled = armGraph(`\n\n${readbackBlock('旧块内容还不一样')}\n\n${readbackBlock('新块')}`, 'cccc3333', '/data/drafts/cccc3333');
    expect(skeletonSha(on, lits('aaaa1111', '/data/drafts/aaaa1111'))).toBe(
      skeletonSha(armGraph('', 'dddd4444', '/data/drafts/dddd4444'), lits('dddd4444', '/data/drafts/dddd4444')),
    );
    expect(skeletonSha(offDoubled, lits('cccc3333', '/data/drafts/cccc3333'))).toBe(
      skeletonSha(armGraph('', 'dddd4444', '/data/drafts/dddd4444'), lits('dddd4444', '/data/drafts/dddd4444')),
    );
  });

  it('命门二：改真拓扑（多一刀 prompt 正文 / 加节点 / 换边）→ skeletonSha 不等', () => {
    const base = armGraph('', 'aaaa1111', '/data/drafts/aaaa1111');
    const baseSha = skeletonSha(base, lits('aaaa1111', '/data/drafts/aaaa1111'));
    const promptEdited = structuredClone(base);
    ((promptEdited.nodes as unknown as Record<string, unknown>[])[1] as { config: { prompt: string } }).config.prompt +=
      ' 再加一句真要求';
    expect(skeletonSha(promptEdited, lits('aaaa1111', '/data/drafts/aaaa1111'))).not.toBe(baseSha);
    const nodeAdded = structuredClone(base);
    (nodeAdded.nodes as unknown[]).push({ id: 'extra', type: 'agent', label: '插一脚', config: { prompt: 'x' } });
    expect(skeletonSha(nodeAdded, lits('aaaa1111', '/data/drafts/aaaa1111'))).not.toBe(baseSha);
    const edgeSwapped = structuredClone(base);
    (edgeSwapped.edges as { id: string; source: string; target: string }[])[1]!.target = 'start';
    expect(skeletonSha(edgeSwapped, lits('aaaa1111', '/data/drafts/aaaa1111'))).not.toBe(baseSha);
  });

  it('replay 路：源 run 的旧 run_id/draft_dir 字面量烧在册 graph 里，血缘链字面量同步归一后骨架与源相等', () => {
    const src = armGraph('', 'old11111', '/data/drafts/old11111');
    const srcSha = skeletonSha(src, lits('old11111', '/data/drafts/old11111'));
    // 新单 graph=源在册字面量（旧 id 还在），本单自己的新 id 只活在 harness 侧
    const replayed = structuredClone(src);
    expect(
      skeletonSha(replayed, [
        { token: '{{run_id}}', value: 'new22222' },
        { token: '{{draft_dir}}', value: '/data/drafts/new22222' },
        ...lits('old11111', '/data/drafts/old11111'),
      ]),
    ).toBe(srcSha);
    // 不喂血缘链旧值就是假阳漂移——这条即「为什么 skeletonLiteralsFor 要上溯 replay 链」
    expect(skeletonSha(replayed, lits('new22222', '/data/drafts/new22222'))).not.toBe(srcSha);
  });

  it('stripInjectionBlocks 只动 prompt 注入面：任务本体逐字节保留，块外文字不连坐', () => {
    const base = '实现导出模块的空值兜底。\n\n第二段正文。';
    const withBlock = `${base}\n\n${readbackBlock('摘录')}`;
    expect(stripInjectionBlocks(withBlock)).toBe(base);
    expect(stripInjectionBlocks(`${base}\n\n${experienceBlock('prev0001')}`)).toBe(base);
    expect(stripInjectionBlocks(base)).toBe(base);
    // 表头在 prompt 中间（前后都有正文）也只抠掉块
    const mid = `前文\n\n${readbackBlock('x')}\n\n后文`;
    expect(stripInjectionBlocks(mid)).toBe('前文\n\n后文');
  });

  it('skeletonGraph 纯函数：不改入参（structuredClone 后归一），非 prompt 串里的 run_id 字面量同样折回占位', () => {
    const g = armGraph('', 'aaaa1111', '/data/drafts/aaaa1111');
    (g.nodes as unknown as { config: Record<string, unknown> }[])[1]!.config.branch = 'pf/aaaa1111';
    const before = JSON.stringify(g);
    const sk = skeletonGraph(g, lits('aaaa1111', '/data/drafts/aaaa1111'));
    expect(JSON.stringify(g)).toBe(before); // 入参一字不动
    expect(JSON.stringify(sk)).not.toContain('aaaa1111');
    expect(JSON.stringify(sk)).toContain('{{run_id}}');
  });
});

// -- v13-V4 ctxSha：注入面指纹的构成与漂移比对（引擎端接线与生产可达路径见 engine.test.ts） --
describe('v13-V4 computeCtxSha / ctxShaDriftDiff（注入面指纹单源）', () => {
  it('三块构成任一变动即换指纹；files 键序不影响（canonicalJson 归一，可复算）', () => {
    const base = {
      files: { '/repo/AGENTS.md': contentSha('约定甲'), '/repo/skills/x.md': contentSha('技能乙') },
      gwThrottleRetries: 2,
      nodeTimeoutMsDefault: 1_800_000,
    };
    const sha = computeCtxSha(base);
    expect(sha).toMatch(/^[0-9a-f]{8}$/);
    expect(computeCtxSha(base)).toBe(sha);
    expect(computeCtxSha({ ...base, files: { ...base.files, '/repo/extra.md': 'zzzz1111' } })).not.toBe(sha);
    expect(
      computeCtxSha({ ...base, files: { ...base.files, '/repo/AGENTS.md': contentSha('约定甲改') } }),
    ).not.toBe(sha);
    expect(computeCtxSha({ ...base, gwThrottleRetries: 3 })).not.toBe(sha);
    expect(computeCtxSha({ ...base, nodeTimeoutMsDefault: 60_000 })).not.toBe(sha);
    // 键插入序不同 → 同一枚指纹
    expect(computeCtxSha({ files: { '/repo/skills/x.md': base.files['/repo/skills/x.md']!, '/repo/AGENTS.md': base.files['/repo/AGENTS.md']! }, gwThrottleRetries: 2, nodeTimeoutMsDefault: 1_800_000 })).toBe(sha);
  });

  it('零文件也是正读数：没配约定/技能的单得到确定指纹（只含两枚旋钮），不是 undefined', () => {
    const empty = computeCtxSha({ files: {}, gwThrottleRetries: 2, nodeTimeoutMsDefault: 1_800_000 });
    expect(empty).toMatch(/^[0-9a-f]{8}$/);
    expect(empty).not.toBe(computeCtxSha({ files: { '/a.md': 'x' }, gwThrottleRetries: 2, nodeTimeoutMsDefault: 1_800_000 }));
  });

  it('漂移比对：两侧在册值不等给「原→今」文案；相等不报；任一侧缺键（v13-V4 前旧单）跳过，宁缺毋假', () => {
    const src = { ...h({ ctxSha: 'aaaa1111' }) };
    const cur = { ...h({ ctxSha: 'bbbb2222' }) };
    expect(ctxShaDriftDiff(src, cur)).toBe('上下文 #aaaa1111→#bbbb2222（约定文档/技能实读集或运行旋钮已变）');
    expect(ctxShaDriftDiff(src, src)).toBeNull();
    expect(ctxShaDriftDiff(h(), cur)).toBeNull(); // 源侧旧单：无 ctxSha 不猜
    expect(ctxShaDriftDiff(src, h())).toBeNull(); // 新侧没落上（防御路/没走注入）：不猜
    expect(ctxShaDriftDiff(undefined, cur)).toBeNull();
    expect(ctxShaDriftDiff(src, undefined)).toBeNull();
  });
});
