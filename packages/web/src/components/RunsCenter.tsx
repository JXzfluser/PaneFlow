import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';

function useBrowserNotify(): [boolean, () => void] {
  const [on, setOn] = useState(() => localStorage.getItem('pf-notify-browser') === '1');
  const enable = () => {
    if (!on && 'Notification' in window) {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          localStorage.setItem('pf-notify-browser', '1');
          setOn(true);
        }
      });
    } else {
      localStorage.setItem('pf-notify-browser', on ? '0' : '1');
      setOn(!on);
    }
  };
  return [on, enable];
}

/** Global browser notifications on blocked/completed/failed (deduped). */
export function useRunNotifications(): void {
  const runs = useStore((s) => s.runs);
  useEffect(() => {
    if (localStorage.getItem('pf-notify-browser') !== '1' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    for (const r of Object.values(runs)) {
      const blocked = Object.values(r.nodes).filter((n) => n.state === 'blocked');
      const key = (ev: string) => `pf-ntf-${r.runId}-${ev}`;
      if (blocked.length && !sessionStorage.getItem(key('blocked'))) {
        sessionStorage.setItem(key('blocked'), '1');
        new Notification(`PaneFlow ⛔ 等待审批`, { body: `${r.dagName}（${r.runId}）：${blocked.map((n) => n.nodeId).join('、')}` });
      }
      if (['completed', 'failed'].includes(r.state) && !sessionStorage.getItem(key(r.state))) {
        sessionStorage.setItem(key(r.state), '1');
        new Notification(`PaneFlow ${r.state === 'completed' ? '✅ 已完成' : '❌ 失败'}`, { body: `${r.dagName}（${r.runId}）` });
      }
    }
  }, [runs]);
}

/** 运行中心（B9 第一版）：全部空间的运行总览、进度、操作。 */
export function RunsCenter() {
  const runs = useStore((s) => s.runs);
  const [notifyOn, toggleNotify] = useBrowserNotify();
  useRunNotifications();
  const openRun = useStore((s) => s.openRun);
  const setView = useStore((s) => s.setView);
  const log = useStore((s) => s.log);

  const list = Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const blockedCount = list.filter((r) => r.state === 'running' && Object.values(r.nodes).some((n) => n.state === 'blocked')).length;
  const runningCount = list.filter((r) => r.state === 'running').length;

  const stop = async (runId: string) => {
    try {
      await api.stopRun(runId);
      log('warn', `已发送停止指令：${runId}`);
    } catch (e) {
      log('error', `停止失败：${(e as Error).message}`);
    }
  };

  const progress = (r: (typeof list)[number]): { done: number; total: number } => {
    const all = Object.values(r.nodes);
    const done = all.filter((n) => ['done', 'failed', 'skipped', 'cancelled'].includes(n.state)).length;
    return { done, total: all.length };
  };

  return (
    <div className="runs-center">
      <div className="runs-status">
        <span><b>{runningCount}</b> 运行中</span>
        <span className={blockedCount ? 'runs-alert' : ''}><b>{blockedCount}</b> 待审批</span>
        <span style={{ color: 'var(--text-dim)' }}>共 {list.length} 条历史</span>
        <button
          onClick={toggleNotify}
          title={notifyOn ? '浏览器通知已开启（点击关闭）' : '开启浏览器通知：等待审批/完成/失败时提醒'}
          style={notifyOn ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : undefined}
        >
          🔔
        </button>
      </div>
      {list.length === 0 && <div className="runs-empty">还没有运行记录。去「编」视图搭建流水线并运行。</div>}
      {list.map((r) => {
        const p = progress(r);
        const blockedNodes = Object.values(r.nodes).filter((n) => n.state === 'blocked');
        const elapsed = ((new Date(r.finishedAt ?? Date.now()).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(0);
        return (
          <div key={r.runId} className="run-card">
            <div className="run-card-head">
              <b>{r.issueId ? `#${r.issueId}` : `#${r.runId}`}</b> <span style={{ fontFamily: 'var(--font-display)', fontSize: 13.5 }}>{r.dagName}</span>
              <span className={`badge ${r.state === 'completed' ? 'done' : r.state === 'failed' ? 'failed' : r.state === 'running' ? 'working' : ''}`}>
                {r.state === 'running' ? '运行中' : r.state === 'completed' ? '完成 ✅' : r.state === 'failed' ? '失败 ❌' : '已取消'}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{elapsed}s</span>
              <div className="run-card-ops">
                <button title="在画布中打开" onClick={() => { openRun(r.runId); setView('orchestrate'); }}>↗</button>
                {r.state === 'running' && <button className="danger" title="停止" onClick={() => void stop(r.runId)}>⏹</button>}
              </div>
            </div>
            <div className="run-progress">
              <div className="run-progress-bar">
                <div
                  className="run-progress-fill"
                  style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%`, background: r.state === 'failed' ? 'var(--err)' : 'var(--ok)' }}
                />
              </div>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{p.done}/{p.total} 节点</span>
              {blockedNodes.length > 0 && (
                <span className="badge blocked">⛔ {blockedNodes.map((n) => n.nodeId).join('、')} 等审批</span>
              )}
              {r.spaceId && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>空间 {r.spaceId}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
