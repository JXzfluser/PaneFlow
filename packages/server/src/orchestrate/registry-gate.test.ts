import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardOnDiskDeletes } from './registry-gate.js';

/**
 * v14 A5-5a 删除闸的**判定层**：三枚「正身在盘上」的视图 kind（role/template/gateway-profile）
 * 各自的删除面在放行与拦下什么。
 *
 * 全部读真实落盘形状（fixture dataDir 手写项目档案、`roles.json`、`graphs/*.json`、
 * `gateway.json`），不桩 `registryViewEntries`/`readReferenceIndex`：本片的全部风险恰在
 * 「闸取的格子对不对」——把引用账桩掉，就只剩在证明自己的假设有引用了。
 *
 * 每一格都两头断：**拦的那格**要点名能改的位置（`via` 的键路径），**放的那格**要证明它不是因为
 * 读不出而放（那种情况在 500 那一格专测）。
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-gate-'));

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 项目档案：只给到 `refsFromSpace` 认的那几枚键，其余留缺（缺键=没配，不是空配） */
function putSpace(dataDir: string, id: string, extra: Record<string, unknown>): void {
  writeJson(path.join(dataDir, 'spaces', id, 'profile.json'), { id, name: id, createdAt: '2026-01-01T00:00:00.000Z', ...extra });
}

/** 岗位 fixture：`r-deliver` 被班底与画布两处指着，`r-free` 一处也没有 */
function dirWithRoles(): string {
  const dataDir = tmp();
  putSpace(dataDir, 'demo', { name: '演示项目', team: [{ roleId: 'r-deliver' }] });
  writeJson(path.join(dataDir, 'roles.json'), [
    { id: 'r-deliver', name: '交付岗' },
    { id: 'r-free', name: '闲岗' },
  ]);
  writeJson(path.join(dataDir, 'graphs', 'flow.json'), {
    version: 1,
    name: 'flow',
    nodes: [{ id: 'n1', type: 'agent', label: '干活', config: { role: 'r-deliver' } }],
    edges: [],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  return dataDir;
}

describe('删除闸：role（正身＝角色库名册）', () => {
  it('被两处指着则拦，拒句把两处能改的位置逐一点名', () => {
    const gate = guardOnDiskDeletes(dirWithRoles(), 'role', ['r-deliver']);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(400);
      expect(gate.error).toContain('还被 2 处引用着');
      expect(gate.error).toContain('项目「演示项目」的 team[0].roleId');
      expect(gate.error).toContain('模板「flow」的 nodes[0].config.role');
      expect(gate.error).toContain('先改掉那几处再来');
      // 「0 是正读数」的反面：拒句里的数目来自账，不是文案里写死的
      expect(gate.error).not.toContain('r-free');
    }
  });

  it('整本覆写一次撤两枚：拦在第一个删不动的那枚上，另一枚没人用不影响结论', () => {
    const gate = guardOnDiskDeletes(dirWithRoles(), 'role', ['r-free', 'r-deliver']);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('「r-deliver」');
  });

  it('没人引用的岗放行（放的那格也要有读数：同一张盘上另一枚确实被拦着）', () => {
    expect(guardOnDiskDeletes(dirWithRoles(), 'role', ['r-free'])).toEqual({ ok: true });
  });

  it('targets 里没有机器值就不编引用：空串/非串一律跳过（那是调用方的形状问题）', () => {
    const dataDir = dirWithRoles();
    expect(guardOnDiskDeletes(dataDir, 'role', [])).toEqual({ ok: true });
    expect(guardOnDiskDeletes(dataDir, 'role', ['', '   ', undefined as unknown as string])).toEqual({ ok: true });
  });
});

describe('删除闸：gateway-profile（正身＝网关盘 profiles[]）', () => {
  /** `free` 只被文档级 current 指着；`paid` 被项目钉档指着，同时也不是 current */
  function dirWithGateway(): string {
    const dataDir = tmp();
    writeJson(path.join(dataDir, 'gateway.json'), {
      profiles: [
        { id: 'free', name: '免费档', baseUrl: 'https://gw.example', apiKey: 'sk-secret' },
        { id: 'paid', name: '付费档', baseUrl: 'https://paid.example' },
      ],
      current: 'free',
    });
    putSpace(dataDir, 'demo', { gatewayProfile: 'paid' });
    return dataDir;
  }

  it('只有 current 指它 → 放行：删掉生效档会顺延，边不悬挂（拿文档级读数拦删除就是冒充人的决定）', () => {
    expect(guardOnDiskDeletes(dirWithGateway(), 'gateway-profile', ['free'])).toEqual({ ok: true });
  });

  it('被项目钉档指着 → 拦，且拒句不把 current 算成引用者', () => {
    const gate = guardOnDiskDeletes(dirWithGateway(), 'gateway-profile', ['paid']);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(400);
      expect(gate.error).toContain('还被 1 处引用着');
      expect(gate.error).toContain('项目「demo」的 gatewayProfile');
      expect(gate.error).not.toContain('current');
    }
  });

  it('密钥不在拒句里（R1 边界②：网关盘是闸的输入，apiKey 仍一步都不能走出来）', () => {
    const gate = guardOnDiskDeletes(dirWithGateway(), 'gateway-profile', ['paid']);
    expect(JSON.stringify(gate)).not.toContain('sk-secret');
  });
});

describe('删除闸：template（正身＝graphs/ 盘）', () => {
  it('自指不算引用者：图自己把自己当子流水线指着时，随文件一起消失（referrer 的 id 是图内 name）', () => {
    const dataDir = tmp();
    writeJson(path.join(dataDir, 'graphs', 'wrap.json'), {
      version: 1,
      name: 'wrap',
      nodes: [{ id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'wrap' } } }],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    // 不给 selfIds 就会把自己拦死（这张图从此删不掉）——两头都断，才看得出剔的是哪一格
    expect(guardOnDiskDeletes(dataDir, 'template', ['wrap'])).not.toEqual({ ok: true });
    expect(guardOnDiskDeletes(dataDir, 'template', ['wrap'], { selfIds: ['wrap'] })).toEqual({ ok: true });
    // 空白串进黑名单不扩大剔除面
    expect(guardOnDiskDeletes(dataDir, 'template', ['wrap'], { selfIds: ['', '  '] })).not.toEqual({ ok: true });
  });

  it('别的图把它当子流水线/兜底模板指着 → 拦，两处写法各算一笔', () => {
    const dataDir = tmp();
    writeJson(path.join(dataDir, 'graphs', 'sub.json'), {
      version: 1,
      name: 'sub',
      nodes: [{ id: 'n1', type: 'agent', label: '活', config: {} }],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    writeJson(path.join(dataDir, 'graphs', 'main.json'), {
      version: 1,
      name: 'main',
      nodes: [
        { id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'sub', fallbackTemplate: 'sub' } } },
        { id: 'p2', type: 'pipeline', label: '另一个子流程', config: { pipeline: { template: 'other' } } },
      ],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    const gate = guardOnDiskDeletes(dataDir, 'template', ['sub'], { selfIds: ['sub'] });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toContain('还被 2 处引用着');
      expect(gate.error).toContain('模板「main」的 nodes[0].config.pipeline.template');
      expect(gate.error).toContain('nodes[0].config.pipeline.fallbackTemplate');
      // 同一张图指着别处的那一笔（`other`）不该混进这一枚的账
      expect(gate.error).not.toContain('other');
    }
    // 没被人指的模板照删
    expect(guardOnDiskDeletes(dataDir, 'template', ['main'], { selfIds: ['main'] })).toEqual({ ok: true });
  });

  it('镜子里读不出这一枚（图坏到画不出来）时改从 dangling 取引用者，且拒句明说拿的是哪格读数', () => {
    const dataDir = tmp();
    fs.mkdirSync(path.join(dataDir, 'graphs'), { recursive: true });
    // 坏 JSON：`templateEntries` 与 `readStoredGraphs` 两处都跳过它（所以条目里没有它），
    // 但另一张图写的裸串仍然在账上——这一格不拦就是「文件脏了反而能连带剪断引用」
    fs.writeFileSync(path.join(dataDir, 'graphs', 'broken.json'), '{ "nodes": [');
    writeJson(path.join(dataDir, 'graphs', 'user.json'), {
      version: 1,
      name: 'user',
      nodes: [{ id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'broken' } } }],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    const gate = guardOnDiskDeletes(dataDir, 'template', ['broken'], { selfIds: ['broken'] });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(400);
      expect(gate.error).toContain('这一枚在注册表的镜子里读不出条目');
      expect(gate.error).toContain('模板「user」的 nodes[0].config.pipeline.template');
    }
  });

  it('运行时变量槽不是引用者：`{{…}}` 那种整串占位在账里没有边，删目标不受它影响', () => {
    const dataDir = tmp();
    writeJson(path.join(dataDir, 'graphs', 'triage.json'), {
      version: 1,
      name: 'triage',
      nodes: [{ id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: '{{pick.suggestedTemplate}}' } } }],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    writeJson(path.join(dataDir, 'graphs', 'pick.json'), {
      version: 1,
      name: 'pick',
      nodes: [{ id: 'n1', type: 'agent', label: '活', config: {} }],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    });
    expect(guardOnDiskDeletes(dataDir, 'template', ['pick'], { selfIds: ['pick'] })).toEqual({ ok: true });
  });
});

describe('删除闸：读不出这一格绝不降级成「零引用」', () => {
  it('扫描抛错 → 500 不放行（R2 最危险的假绿：读不出＝给删除开绿灯）', () => {
    const dataDir = tmp();
    // `graphs` 摆成一枚普通文件：`readdirSync` 抛 ENOTDIR。视图面把它渲成一条披露（不炸整张注册表），
    // 引用账那一侧照抛——闸必须把这句话原样报出来，而不是当作「没人用」放行
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'graphs'), 'not a directory');
    const gate = guardOnDiskDeletes(dataDir, 'template', ['whatever']);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(500);
      expect(gate.error).toContain('引用账扫不出');
      expect(gate.error).toContain('读不出不等于没人用，这次不放行');
    }
  });

  it('拦与放都不写盘：闸只读账，运行面那三张盘一个字节都不动', () => {
    const dataDir = dirWithRoles();
    putSpace(dataDir, 'other', { gatewayProfile: 'paid' });
    const files = ['roles.json', path.join('graphs', 'flow.json'), path.join('spaces', 'demo', 'profile.json'), path.join('spaces', 'other', 'profile.json')];
    const snap = () => JSON.stringify([...fs.readdirSync(dataDir, { recursive: true })].sort()) + files.map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('');
    const before = snap();
    expect(guardOnDiskDeletes(dataDir, 'role', ['r-deliver']).ok).toBe(false);
    expect(guardOnDiskDeletes(dataDir, 'role', ['r-free']).ok).toBe(true);
    expect(snap()).toBe(before);
  });

  it('动词措辞跟着调用方走（同一份判据，两种说法）', () => {
    const gate = guardOnDiskDeletes(dirWithRoles(), 'role', ['r-deliver'], { action: '清账' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('清账会把这些引用变成悬挂引用');
  });
});
