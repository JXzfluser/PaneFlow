import { describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PURGE_KEY,
  isChecked,
  overwriteIntakeRequest,
  purgeRunRequest,
  removeGatewayProfileRequest,
  resumeRunRequest,
  unlinkPatRequest,
} from './dialogs';

/** 取 onSubmit 并喂一组 values（模态里勾选框的形状就是 {'键':'1'} / {'键':''}）；
 *  只按结构取 onSubmit，免把 React 组件引进 node 环境的测试里 */
const submit = (values: Record<string, string>, req: { onSubmit: (v: Record<string, string>) => void }) =>
  req.onSubmit(values);

describe('v14 better-ui 原生 confirm 归位：勾选默认侧', () => {
  it('真删除：破坏性加料（连带清产物）默认不勾——「不可恢复」那一侧永不当默认值', () => {
    const req = purgeRunRequest('r-1', () => {});
    expect(req.danger).toBe(true);
    expect(req.confirmText).toBe('真删除');
    expect(req.checks).toHaveLength(1);
    const check = req.checks?.[0];
    if (!check) throw new Error('真删除框必须有那枚产物勾选框');
    expect(check.key).toBe(ARTIFACT_PURGE_KEY);
    expect(check.defaultChecked ?? false).toBe(false);
    // 文案里得留得住旧原生框那三条边界：删什么、不勾就保留、只碰本 run 的件
    expect(check.label).toContain('产物架');
    expect(check.label).toContain('不勾则保留');
  });

  it('真删除：勾与不勾分别把 alsoArtifacts=true/false 传下去（原来靠两次连排 confirm）', () => {
    const seen: boolean[] = [];
    const req = purgeRunRequest('r-1', (alsoArtifacts) => void seen.push(alsoArtifacts));
    submit({}, req);
    submit({ [ARTIFACT_PURGE_KEY]: '1' }, req);
    submit({ [ARTIFACT_PURGE_KEY]: '' }, req);
    expect(seen).toEqual([false, true, false]);
  });

  it('isChecked：只认 "1"，空串与缺键都是没勾', () => {
    expect(isChecked({ k: '1' }, 'k')).toBe(true);
    expect(isChecked({ k: '' }, 'k')).toBe(false);
    expect(isChecked({}, 'k')).toBe(false);
  });
});

const run = (nodes: [string, string][]) => ({
  runId: 'r-9',
  nodes: Object.fromEntries(nodes.map(([nodeId, state]) => [nodeId, { nodeId, state }])),
});

describe('断点续跑确认：继承读数摊开说清', () => {
  it('混合状态：计数、done 节点清单、未跑节点会重跑都写在 message 里', () => {
    const req = resumeRunRequest(run([['plan', 'done'], ['impl', 'failed'], ['review', 'blocked']]), () => {});
    expect(req.title).toBe('从断点续跑 #r-9');
    expect(req.message).toContain('1/3');
    expect(req.message).toContain('plan');
    expect(req.message).not.toContain('impl'); // 只有继承的那几格进清单
    expect(req.message).toContain('失败与未执行节点将重新执行');
    expect(req.danger).toBeFalsy(); // 续跑开新 run，源 run 不动——不是破坏性动作
  });

  it('零 done：明说「等于整单重跑」，不画一个空的「：」冒充有继承', () => {
    const req = resumeRunRequest(run([['plan', 'failed']]), () => {});
    expect(req.message).toContain('0/1');
    expect(req.message).toContain('没有可继承的格');
  });
});

describe('凭据与网关档：删除类确认的口径', () => {
  it('解绑 PAT 亮红，但说清「默认仓库保留 + gh 兜底还在」（只清本机存的 token）', () => {
    const req = unlinkPatRequest(() => {});
    expect(req.danger).toBe(true);
    expect(req.message).toContain('默认仓库等配置会保留');
    expect(req.message).toContain('gh 登录态');
  });

  it('删网关档亮红，并把 A5-5a 那道口预先说清：被项目钉着会被拦、会点名出处', () => {
    const req = removeGatewayProfileRequest('免费档', () => {});
    expect(req.danger).toBe(true);
    expect(req.title).toContain('免费档');
    expect(req.message).toContain('密钥与地址会一并从本地移除');
    expect(req.message).toContain('拦下并点名出处');
  });

  it('接单模板 409：server 原文一字不吞地进 message（前端不重述判据），确认只回调一次', () => {
    const onConfirm = vi.fn();
    const msg = '模板文件已存在，确定要覆盖吗？（传 overwrite:true 覆盖）';
    const req = overwriteIntakeRequest(msg, onConfirm);
    expect(req.message).toContain(msg);
    submit({}, req);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
