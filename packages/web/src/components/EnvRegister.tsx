import { useEffect, useMemo, useState } from 'react';

import { api, type EnvProbeItem, type EnvProbeResult } from '../api.js';

type Step = 'pick' | 'view' | 'select' | 'receipt';

const KIND_LABEL: Record<EnvProbeItem['kind'], string> = {
  repo: 'Git 仓',
  doc: '约定文档',
  skill: '技能',
  rule: '作用域规则',
  check: '机检候选',
  workflow: '工作流',
  worktree: 'Worktree',
};

const MAPPABLE: ReadonlySet<EnvProbeItem['kind']> = new Set<EnvProbeItem['kind']>(['repo', 'doc', 'skill', 'rule']);

const STEPS: { id: Step; label: string }[] = [
  { id: 'pick', label: '选目录' },
  { id: 'view', label: '看发现' },
  { id: 'select', label: '勾选' },
  { id: 'receipt', label: '回执' },
];

/**
 * v14-E2 一次事务登记：向导四步。
 * 探测只读，登记走 `POST /api/env/register`（服务端 probe → map → write 原子完成，任一步失败整体不落盘）。
 */
export function EnvRegister({ spaceId, onClose, onRegistered }: { spaceId: string; onClose: () => void; onRegistered?: () => void }) {
  const [step, setStep] = useState<Step>('pick');
  const [pathInput, setPathInput] = useState('');
  const [probe, setProbe] = useState<EnvProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [registering, setRegistering] = useState(false);
  const [receipt, setReceipt] = useState<{ registered: number; warnings: string[]; profile: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stepIdx = STEPS.findIndex((s) => s.id === step);

  // Esc 关掉向导（与 PromptModal/RunsCenter 同一把手势）。登记已在飞时不关：
  // 服务端那一笔事务照旧落盘，此刻收掉界面等于让人以为「取消了」而档案其实改了。
  useEffect(() => {
    if (registering) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, registering]);

  const mappableCount = useMemo(() => {
    if (!probe) return 0;
    return probe.items.filter((it) => MAPPABLE.has(it.kind)).length;
  }, [probe]);

  const grouped = useMemo(() => {
    if (!probe) return [] as { kind: EnvProbeItem['kind']; items: EnvProbeItem[] }[];
    const order: EnvProbeItem['kind'][] = ['repo', 'doc', 'skill', 'rule', 'check', 'workflow', 'worktree'];
    const map = new Map<EnvProbeItem['kind'], EnvProbeItem[]>();
    for (const it of probe.items) {
      const arr = map.get(it.kind);
      if (arr) arr.push(it);
      else map.set(it.kind, [it]);
    }
    return order.filter((k) => map.has(k)).map((k) => ({ kind: k, items: map.get(k)! }));
  }, [probe]);

  const startProbe = async () => {
    setError(null);
    const trimmed = pathInput.trim();
    if (!trimmed) { setError('请填写目录绝对路径'); return; }
    if (!(trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed))) {
      setError('必须是绝对路径（相对路径不猜基准）');
      return;
    }
    setProbing(true);
    try {
      const r = await api.envProbe(trimmed);
      if (r.error) { setError(r.error); setProbe(r); return; }
      setProbe(r);
      setSelected(new Set(r.items.map((it, i) => (MAPPABLE.has(it.kind) ? i : -1)).filter((i) => i >= 0)));
      setStep('view');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    setRegistering(true);
    try {
      const indices = [...selected].sort((a, b) => a - b);
      const r = await api.envRegister(probe?.path ?? pathInput.trim(), spaceId, indices);
      setReceipt(r);
      setStep('receipt');
      onRegistered?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="modal-mask" onClick={() => { if (!registering) onClose(); }}>
      <div className="modal env-register" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="发现环境并登记">
        <div className="er-head">
          <h2>发现环境并登记</h2>
          <div className="er-steps">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`er-step${i === stepIdx ? ' on' : ''}${i < stepIdx ? ' done' : ''}`}
                aria-current={i === stepIdx ? 'step' : undefined}
              >
                <span className="er-dot" aria-hidden />
                <span>{s.label}</span>
              </span>
            ))}
          </div>
        </div>

        {error && <div className="er-error" role="alert">✘ {error}</div>}

        {step === 'pick' && (
          <div className="er-body">
            <label className="field">
              <span>目录绝对路径</span>
              <input
                type="text"
                placeholder="/Users/you/code/my-repo"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !probing) void startProbe(); }}
                autoFocus
              />
            </label>
            <p className="wiz-note">
              目标项目：<b>{spaceId}</b>。探测只读（stat / readdir + 三条只读 git 命令），绝不 fetch / checkout / 写盘；登记一次事务落档案，失败整体回滚。
            </p>
          </div>
        )}

        {step === 'view' && probe && (
          <div className="er-body">
            <p className="er-summary">{probe.summary ?? `${probe.items.length} 项发现 · ${probe.missing.length} 项未探到`}</p>
            {grouped.length === 0 ? (
              <p className="wiz-note">没有探到任何项。</p>
            ) : (
              <div className="er-groups">
                {grouped.map((g) => (
                  <div key={g.kind} className="er-group">
                    <div className="er-group-head">
                      <span className="er-kind">{KIND_LABEL[g.kind]}</span>
                      <span className="er-count">{g.items.length}</span>
                      {!MAPPABLE.has(g.kind) && <span className="er-tag disclosed">只披露</span>}
                    </div>
                    <ul className="er-group-list">
                      {g.items.map((it, i) => (
                        <li key={i}>
                          <b>{it.name}</b> <span className="er-detail">{it.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {probe.missing.length > 0 && (
              <div className="er-missing">
                <b>未探到</b>
                <ul>{probe.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        {step === 'select' && probe && (
          <div className="er-body">
            <p className="er-summary">
              勾选要登记的项 · 已选 <b>{selected.size}</b>/{mappableCount}（可登记项共 {mappableCount} 枚，其余只披露）
            </p>
            <div className="er-list">
              {probe.items.map((item, i) => {
                const canPick = MAPPABLE.has(item.kind);
                return (
                  <label key={i} className={`er-item${canPick ? '' : ' disclosed'}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggle(i)}
                      disabled={!canPick}
                      aria-label={`${KIND_LABEL[item.kind]} ${item.name}`}
                    />
                    <span className="er-kind">{KIND_LABEL[item.kind]}</span>
                    <span className="er-name">{item.name}</span>
                    <span className="er-detail">{item.detail}</span>
                    <span className="er-evidence">依据 · {item.evidence}</span>
                    {!canPick && <span className="er-tag disclosed">无字段</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 'receipt' && receipt && (
          <div className="er-body">
            <div className="er-ok">✔ 已登记 <b>{receipt.registered}</b> 项 · 项目 <b>{spaceId}</b></div>
            {receipt.warnings.length > 0 && (
              <ul className="er-warns">{receipt.warnings.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
            )}
            <p className="wiz-note">回项目档案可看到新增的 repos / conventionFiles / skills / rules。</p>
          </div>
        )}

        <div className="close-row">
          {step === 'pick' && <button onClick={onClose}>取消</button>}
          {step === 'view' && <button onClick={() => setStep('pick')}>← 上一步</button>}
          {step === 'select' && <button onClick={() => setStep('view')}>← 上一步</button>}
          {step === 'receipt' && <button onClick={onClose}>关闭</button>}
          <div className="er-spacer" />
          {step === 'pick' && (
            <button className="primary" disabled={probing} onClick={() => void startProbe()}>
              {probing ? '探测中…' : '开始探测 →'}
            </button>
          )}
          {step === 'view' && probe && !probe.error && (
            <button className="primary" onClick={() => setStep('select')}>下一步：勾选 →</button>
          )}
          {step === 'select' && (
            <button className="primary" disabled={registering || selected.size === 0} onClick={() => void submit()}>
              {registering ? '登记中…' : `登记 ${selected.size} 项`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
