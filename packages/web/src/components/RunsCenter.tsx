import { useEffect, useState } from 'react';
import type { RunEvent, RunRecord } from '@paneflow/shared';
import { useStore } from '../store.js';
import { api, fetchJson } from '../api.js';
import { runCostLabel } from '../cost.js';
import { RunTimeline } from './RunTimeline.js';

function nodeDuration(r: NonNullable<ReturnType<typeof useStore.getState>['runs'][string]>, nodeId: string): number | null {
  const rec = r.nodes[nodeId];
  if (!rec?.startedAt) return null;
  const end = rec.finishedAt ? new Date(rec.finishedAt).getTime() : Date.now();
  return Math.round((end - new Date(rec.startedAt).getTime()) / 1000);
}

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

/** v7-A2 归档面板：反归档回主列表 / 真删除（仅删记录，产物目录不联动清理）。 */
function ArchivedPanel() {
  const log = useStore((s) => s.log);
  const [archived, setArchived] = useState<RunRecord[] | null>(null);

  const reload = () => {
    void fetchJson<{ runs: RunRecord[] }>('GET', '/api/runs?archived=1')
      .then((d) => setArchived(d.runs))
      .catch((e: Error) => {
        log('error', `读取归档列表失败：${e.message}`);
        setArchived([]);
      });
  };
  useEffect(reload, []);

  const unarchive = async (runId: string) => {
    try {
      const d = await fetchJson<{ restored: boolean; run: RunRecord }>('POST', `/api/runs/${encodeURIComponent(runId)}/unarchive`);
      useStore.setState((s) => ({ runs: { ...s.runs, [d.run.runId]: d.run } }));
      setArchived((cur) => (cur ?? []).filter((r) => r.runId !== runId));
      log('info', `已恢复 ${runId} 到主列表`);
    } catch (e) {
      log('error', `反归档失败：${(e as Error).message}`);
    }
  };

  const purge = async (runId: string) => {
    if (!window.confirm(`真删除 ${runId}？\n\n记录文件将从磁盘移除，不可恢复。\n注意：该 run 的产物目录（workspace 内 .herdr/artifacts）不会被自动清理，如需请先自行留存。`)) return;
    try {
      await fetchJson<{ deleted: boolean }>('DELETE', `/api/runs/${encodeURIComponent(runId)}/archive`);
      setArchived((cur) => (cur ?? []).filter((r) => r.runId !== runId));
      log('info', `已真删除 ${runId}`);
    } catch (e) {
      log('error', `删除失败：${(e as Error).message}`);
    }
  };

  if (archived === null) return <div className="runs-empty">归档加载中…</div>;
  if (archived.length === 0) return <div className="runs-empty">没有归档记录。运行卡片上按 📦 可归档到这里。</div>;
  return (
    <div>
      {archived.map((r) => (
        <div key={r.runId} className="run-card" style={{ opacity: 0.85 }}>
          <div className="run-card-head">
            <b>#{r.runId}</b> <span style={{ fontFamily: 'var(--font-display)', fontSize: 13.5 }}>{r.dagName}</span>
            <span className={`badge ${r.state === 'completed' ? 'done' : r.state === 'failed' ? 'failed' : ''}`}>
              {r.state === 'completed' ? '完成' : r.state === 'failed' ? '失败' : r.state}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.startedAt.slice(0, 16).replace('T', ' ')}</span>
            <div className="run-card-ops">
              <button title="导出完整记录 JSON" onClick={() => {
                const a = document.createElement('a');
                a.href = `/api/runs/${encodeURIComponent(r.runId)}/export`;
                a.download = `${r.runId}.json`;
                a.click();
              }}>⤓</button>
              <button title="恢复到主列表（反归档）" onClick={() => void unarchive(r.runId)}>↩</button>
              <button className="danger" title="真删除（不可恢复，产物目录不联动）" onClick={() => void purge(r.runId)}>🗑</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 运行中心（B9 第一版）：全部空间的运行总览、进度、操作。 */
export function RunsCenter() {
  const runs = useStore((s) => s.runs);
  const [notifyOn, toggleNotify] = useBrowserNotify();
  useRunNotifications();
  const openRun = useStore((s) => s.openRun);
  const setView = useStore((s) => s.setView);
  const log = useStore((s) => s.log);
  const [tab, setTab] = useState<'active' | 'archived'>('active');

  // 时间线：运行中的记录随 WS 实时到（读 store），历史记录按需拉一次
  const [openTl, setOpenTl] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Record<string, RunEvent[]>>({});
  const [loadingTl, setLoadingTl] = useState<string | null>(null);

  const toggleTimeline = async (runId: string, liveHasEvents: boolean) => {
    if (openTl === runId) {
      setOpenTl(null);
      return;
    }
    setOpenTl(runId);
    if (liveHasEvents || fetched[runId]) return;
    setLoadingTl(runId);
    try {
      const r = await api.runEvents(runId);
      setFetched((c) => ({ ...c, [runId]: r.events }));
    } catch (e) {
      log('error', `读取事件时间线失败：${(e as Error).message}`);
      setFetched((c) => ({ ...c, [runId]: [] }));
    } finally {
      setLoadingTl((prev) => (prev === runId ? null : prev));
    }
  };

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

  // v7-A5 断点续跑：以源 run 已应用的图重启，done 节点（含 fanout 克隆）整体继承不重跑
  const resume = async (r: RunRecord) => {
    const all = Object.values(r.nodes);
    const done = all.filter((n) => n.state === 'done');
    const ok = window.confirm(
      `从断点续跑 #${r.runId}？\n\n` +
        `继承已完成节点 ${done.length}/${all.length}${done.length ? `：${done.map((n) => n.nodeId).join('、')}` : ''}\n` +
        `失败与未执行节点将重新执行（产物黑板从源 run 载入）。`,
    );
    if (!ok) return;
    try {
      const d = await api.resumeRun(r);
      log('info', `断点续跑已启动：新 run ${d.runId} 继承 ${done.length} 个已完成节点`);
    } catch (e) {
      log('error', `续跑失败：${(e as Error).message}`);
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
        <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>全部运行</button>
        <button className={tab === 'archived' ? 'active' : ''} title="已归档记录：可恢复或真删除" onClick={() => setTab('archived')}>📦 已归档</button>
        <span style={{ marginLeft: 'auto' }}><b>{runningCount}</b> 运行中</span>
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
      {tab === 'archived' && <ArchivedPanel />}
      {tab === 'active' && (
        <>
      {list.length === 0 && <div className="runs-empty">还没有运行记录。去「编」视图搭建流水线并运行。</div>}
      {list.map((r) => {
        const p = progress(r);
        const blockedNodes = Object.values(r.nodes).filter((n) => n.state === 'blocked');
        const elapsed = ((new Date(r.finishedAt ?? Date.now()).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(0);
        const liveEvents = r.events;
        const events = liveEvents && liveEvents.length ? liveEvents : fetched[r.runId];
        const open = openTl === r.runId;
        const eventCount = events?.length ?? liveEvents?.length ?? 0;
        return (
          <div key={r.runId} className="run-card">
            <div className="run-card-head">
              <b>{r.issueId ? `#${r.issueId}` : `#${r.runId}`}</b> <span style={{ fontFamily: 'var(--font-display)', fontSize: 13.5 }}>{r.dagName}</span>
              <span className={`badge ${r.state === 'completed' ? 'done' : r.state === 'failed' ? 'failed' : r.state === 'running' ? 'working' : ''}`}>
                {r.state === 'running' ? '运行中' : r.state === 'completed' ? '完成 ✅' : r.state === 'failed' ? '失败 ❌' : '已取消'}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{elapsed}s</span>
              {runCostLabel(r) && (
                <span className="run-cost-chip" title="成本账：时长/重试/tokens（unknown = agent 未自报，不估算）">{runCostLabel(r)}</span>
              )}
              <div className="run-card-ops">
                <button
                  className={open ? 'active' : ''}
                  title={`事件时间线：谁在何时做了什么${eventCount ? `（${eventCount} 条）` : ''}`}
                  onClick={() => void toggleTimeline(r.runId, !!liveEvents?.length)}
                >
                  ⏱{eventCount ? ` ${eventCount}` : ''}
                </button>
                <button title="导出完整记录 JSON" onClick={() => {
                  const a = document.createElement('a');
                  a.href = `/api/runs/${r.runId}/export`;
                  a.download = `${r.runId}.json`;
                  a.click();
                }}>⤓</button>
                {r.state !== 'running' && (
                  <button title="归档（移出主列表，记录保留）" onClick={() => {
                    void fetchJson<{ archived: boolean }>('POST', `/api/runs/${r.runId}/archive`)
                      .then(() => {
                        useStore.setState((s) => {
                          const runs = { ...s.runs };
                          delete runs[r.runId];
                          return { ...s, runs };
                        });
                      })
                      .catch((e: Error) => useStore.getState().log('error', `归档失败：${e.message}`));
                  }}>📦</button>
                )}
                {r.state === 'failed' && (
                  <button title="从断点续跑（已完成节点直接继承，失败/未跑节点重执行）" onClick={() => void resume(r)}>⤴</button>
                )}
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
            {open && (
              <RunTimeline
                compact
                events={events}
                startedAt={r.startedAt}
                running={r.state === 'running'}
                loading={loadingTl === r.runId}
                emptyHint="这条运行没有事件记录（可能是埋点上线前的历史运行）。"
              />
            )}
          </div>
        );
      })}
        </>
      )}
    </div>
  );
}
