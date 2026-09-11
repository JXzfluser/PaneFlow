import { useState } from 'react';
import type { DagGraph } from '@paneflow/shared';
import { api } from '../api.js';
import { useStore } from '../store.js';

/**
 * Run dialog: collects pipeline cwd + declared template variables, replaces
 * the old bare-cwd prompt. Submitting starts the run.
 */
export function RunDialog({
  graph,
  onClose,
  onStarted,
}: {
  graph: DagGraph;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const log = useStore((s) => s.log);
  const variables = graph.variables ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of variables) init[v.key] = v.default ?? '';
    return init;
  });
  const [busy, setBusy] = useState(false);

  const missing = variables.filter((v) => v.required && !values[v.key]?.trim());

  const submit = async () => {
    if (!cwd.trim()) {
      log('error', '请填写流水线工作目录（须已存在）');
      return;
    }
    if (missing.length) {
      log('error', `缺少必填参数：${missing.map((v) => v.label).join('、')}`);
      return;
    }
    setBusy(true);
    try {
      const { run } = await api.startRun(graph, cwd.trim(), values);
      onStarted(run.runId);
      log('info', `流水线已启动：${run.runId}`);
      onClose();
    } catch (e) {
      log('error', `启动失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 'min(520px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <h2>运行「{graph.name}」</h2>
        <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, margin: '14px 0 4px' }}>
          流水线工作目录（须已存在）
        </label>
        <input
          className="gname"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/tmp/my-project"
          style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit' }}
          autoFocus
        />
        {variables.length > 0 && (
          <>
            <h3 style={{ margin: '16px 0 6px', fontSize: 13, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
              运行参数
            </h3>
            {variables.map((v) => (
              <div key={v.key} style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, marginBottom: 3 }}>
                  {v.label || v.key}
                  {v.required && <span style={{ color: 'var(--err)' }}> *</span>}
                  {v.default ? <span style={{ opacity: 0.6 }}>（默认 {v.default}）</span> : null}
                </label>
                <input
                  value={values[v.key] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  placeholder={`{{${v.key}}} 将注入全部指令与路径`}
                  style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit' }}
                />
              </div>
            ))}
          </>
        )}
        <div className="close-row">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '启动中…' : '▶ 启动'}
          </button>
        </div>
      </div>
    </div>
  );
}
