import { useMemo, useState } from 'react';
import type { EnvProbeItem } from '../api.js';
import { api, fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { Icon } from './Icon.js';

/**
 * 项目新建向导（v17-W）：新用户从零到能跑任务的一条线——
 *   ① 起名 + 给根目录 → ② 创建并扫描，勾选要登记的能力（可选装首发班底）→ 完成。
 *   扫描登记走既有的只读 envProbe / 事务性 envRegister（rootCwd 由 server 在登记现场写进档案），
 *   本组件不 stat 任何盘上路径，判据全在 server。
 *   诚实边界：第②步「创建项目」落定后中途取消，会留下一个空档案——无害，可在项目页补配或忽略。
 */

const KIND_LABELS: Record<string, string> = {
  repo: '📦 仓库',
  doc: '📄 约定文档',
  skill: '📚 技能',
  rule: '📏 规则',
};

const KIND_HINTS: Record<string, string> = {
  repo: 'Agent 干活的代码仓，交付家规按它拉分支',
  doc: '会作为约定注入给该项目的 Agent',
  skill: '作业手册，运行时自动注入',
  rule: '硬约束（可带仓库/目录作用域）',
};

/** 项目 ID 只能字母/数字/-/_（server 同一把尺，提前给是为了让「自动起 id」不白打） */
function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32);
}

export function ProjectWizard() {
  const log = useStore((s) => s.log);
  const setPwOpen = useStore((s) => s.setPwOpen);
  const switchSpace = useStore((s) => s.switchSpace);
  const setCwd = useStore((s) => s.setCwd);
  const setView = useStore((s) => s.setView);

  const [step, setStep] = useState<0 | 1>(0);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [step1Err, setStep1Err] = useState<string | null>(null);

  // 第②步的读数（项目已建成才有）
  const [spaceId, setSpaceId] = useState('');
  const [items, setItems] = useState<EnvProbeItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [seedTeam, setSeedTeam] = useState(true);
  const [finishing, setFinishing] = useState(false);

  const autoId = useMemo(() => slugify(name), [name]);

  const close = () => setPwOpen(false);

  /** 第①步 → 第②步：创建项目 → 只读扫描。登记留到「完成」那一下（勾选在此步做） */
  const createAndScan = async () => {
    setStep1Err(null);
    if (!name.trim()) return setStep1Err('先给项目起个名字');
    if (!dir.trim().startsWith('/')) return setStep1Err('根目录要是绝对路径（以 / 开头）');
    setCreating(true);
    try {
      const finalId = autoId || `proj-${Date.now().toString(36)}`;
      await fetchJson<unknown>('POST', '/api/spaces', { id: finalId, name: name.trim() });
      const probed = await api.envProbe(dir.trim());
      const probedItems = probed.items ?? [];
      setSpaceId(finalId);
      setItems(probedItems);
      setSelected(new Set(probedItems.map((_, i) => i)));
      setStep(1);
    } catch (e) {
      const msg = (e as Error).message;
      setStep1Err(
        msg.includes('已存在')
          ? `项目 ID「${autoId}」已被占用——换个名字，或到「项目」页直接用它`
          : `创建/扫描没走通：${msg}`,
      );
    } finally {
      setCreating(false);
    }
  };

  /** 完成：勾选项批量登记（rootCwd 由 server 顺带写入）＋ 可选装首发班底 → 切过去开用 */
  const finish = async () => {
    setFinishing(true);
    try {
      const r = await api.envRegister(dir.trim(), spaceId, Array.from(selected));
      if (seedTeam) {
        await fetchJson<unknown>('POST', `/api/spaces/${encodeURIComponent(spaceId)}/team/standard`);
      }
      log(
        'info',
        `项目「${name.trim()}」就绪：登记 ${r.registered} 项${seedTeam ? '＋首发五连班底' : ''}。工作目录已带上，现在可以派第一个任务了。`,
      );
      switchSpace(spaceId);
      setCwd(dir.trim());
      void api.listRuns().then((x) => useStore.getState().mergeRuns(x.runs)).catch(() => undefined);
      setPwOpen(false);
      setView('tasks');
    } catch (e) {
      log('error', `收尾登记失败：${(e as Error).message}（项目已建好，可到「项目 → 编辑档案」手工补）`);
      setPwOpen(false);
    } finally {
      setFinishing(false);
    }
  };

  const kindCount = (k: string) => items.filter((it) => it.kind === k).length;

  return (
    <div className="pw-backdrop" onClick={close}>
      <div className="pw-modal" role="dialog" aria-modal="true" aria-label="新建项目向导" onClick={(e) => e.stopPropagation()}>
        <div className="pw-head">
          <b>{step === 0 ? '⚡ 30 秒新建项目' : '勾选要接进来的能力'}</b>
          <button className="registry-form-close" aria-label="关闭向导" onClick={close}>✕</button>
        </div>

        {step === 0 ? (
          <>
            <p className="pw-sub">给项目起个名字、指一下它在本机的根目录。向导会自动发现里面的仓库/技能/规则并登记，跑任务的工作目录也会自动带上。</p>
            <div className="pw-field">
              <label>项目名称 *</label>
              <input
                autoFocus
                value={name}
                placeholder="如：商品目录服务"
                onChange={(e) => setName(e.target.value)}
              />
              {autoId && <span className="pw-hint">项目 ID：{autoId}（自动生成）</span>}
            </div>
            <div className="pw-field">
              <label>根目录（绝对路径）*</label>
              <input
                value={dir}
                placeholder="/Users/you/work/my-service"
                onChange={(e) => setDir(e.target.value)}
              />
              <span className="pw-hint">下一步会只读扫描这个目录：发现什么登记什么，不改盘上任何文件。</span>
            </div>
            {step1Err && <p className="pw-err">{step1Err}</p>}
            <div className="pw-ops">
              <button onClick={close}>取消</button>
              <button className="primary" disabled={creating || !name.trim() || !dir.trim()} onClick={() => void createAndScan()}>
                {creating ? '创建并扫描中…' : '创建项目并扫描 →'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="pw-sub">
              项目 <b>{name.trim()}</b>（{spaceId}）已创建。在 <code>{dir.trim()}</code> 发现 {items.length} 项，勾选要登记的：
            </p>
            {items.length === 0 ? (
              <p className="pw-hint" style={{ padding: '6px 2px' }}>
                这个目录下没探出仓库/文档/技能——没关系，直接完成；之后随时在「设置 → 能力注册」扫描或单项登记。
              </p>
            ) : (
              <div className="pw-items">
                <div className="pw-items-head">
                  <button
                    className="link"
                    onClick={() => setSelected(items.length && selected.size === items.length ? new Set() : new Set(items.map((_, i) => i)))}
                  >
                    {selected.size === items.length ? '全不选' : '全选'}
                  </button>
                  <span className="pw-hint">
                    仓库 {kindCount('repo')} · 文档 {kindCount('doc')} · 技能 {kindCount('skill')} · 规则 {kindCount('rule')}
                  </span>
                </div>
                {items.map((it, i) => (
                  <label key={i} className="pw-item">
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={(e) =>
                        setSelected((p) => {
                          const next = new Set(p);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                    <span className="pw-item-kind">{KIND_LABELS[it.kind] ?? it.kind}</span>
                    <b>{it.name}</b>
                    <span className="pw-item-detail" title={KIND_HINTS[it.kind] ?? ''}>{it.detail}</span>
                  </label>
                ))}
              </div>
            )}
            <label className="pw-team">
              <input type="checkbox" checked={seedTeam} onChange={(e) => setSeedTeam(e.target.checked)} />
              装填首发班底（规划 / 实现 / 评审 / 验收 / 沉淀 五个角色）
            </label>
            <div className="pw-ops">
              <button onClick={close}>以后再说（项目已建好）</button>
              <button className="primary" disabled={finishing} onClick={() => void finish()}>
                <Icon name="check" size={12} /> {finishing ? '登记中…' : `✓ 完成：登记 ${selected.size} 项并开始使用`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
