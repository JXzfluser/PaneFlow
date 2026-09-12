import { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';

/** 智能下发对话框：一句任务描述 → Planner 路由 → 模板/骨架自动执行。 */
export function DispatchDialog({
  onClose,
  onDispatched,
}: {
  onClose: () => void;
  onDispatched: (runId: string) => void;
}) {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const log = useStore((s) => s.log);
  const [task, setTask] = useState('');
  const [issueId, setIssueId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!task.trim()) {
      log('error', '请填写任务描述');
      return;
    }
    if (!cwd.trim()) {
      log('error', '请填写工作目录（须已存在）');
      return;
    }
    setBusy(true);
    try {
      const r = await api.dispatch(task.trim(), cwd.trim(), issueId.trim() || undefined);
      log('info', `已下发：Planner 正在路由（run ${r.runId}）`);
      onDispatched(r.runId);
      onClose();
    } catch (e) {
      log('error', `下发失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 'min(560px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <h2>🎯 下发任务</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          用一句话描述要做的事：Planner 会自动选择最合适的交付模板（或生成任务拆解），并在当前空间执行。
        </p>
        <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, margin: '14px 0 4px' }}>
          任务描述 <span style={{ color: 'var(--err)' }}>*</span>
        </label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder={'例如：探索这个项目的功能成熟度，挑出最值得做的改进并建 Issue 推进；或：修复登录页在移动端的布局问题'}
          style={{ width: '100%', minHeight: 110, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 10px', font: 'inherit' }}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, margin: '10px 0 4px' }}>工作目录</label>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/tmp/my-project"
              style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px', font: 'inherit' }}
            />
          </div>
          <div style={{ width: 140 }}>
            <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, margin: '10px 0 4px' }}>关联 Issue（可选）</label>
            <input
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              placeholder="162"
              style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px', font: 'inherit' }}
            />
          </div>
        </div>
        <div className="close-row">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '下发中…' : '🎯 下发'}
          </button>
        </div>
      </div>
    </div>
  );
}
