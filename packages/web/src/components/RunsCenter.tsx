import { useEffect, useState } from 'react';
import type { RunEvent, RunRecord } from '@paneflow/shared';
import { useStore } from '../store.js';
import { api, fetchJson } from '../api.js';
import { runCostLabel } from '../cost.js';
import { RunTimeline } from './RunTimeline.js';

/** v8-H2 产物货架的单个文件条目（<nodeId>.json 会挂上对应节点信息） */
type ArtifactFile = {
  name: string;
  size: number;
  mtime: string;
  nodeId?: string;
  nodeLabel?: string;
  nodeState?: string;
  unverified?: boolean;
};

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

/** v7-A2 归档面板：反归档回主列表 / 真删除（v8-H2：可选一并清理本 run 产物，默认保留）。 */
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
    if (!window.confirm(`真删除 ${runId}？\n\n记录文件将从磁盘移除，不可恢复。`)) return;
    const alsoArtifacts = window.confirm(
      '一并清理该 run 的产物文件？\n\n只删工作区 .herdr/artifacts 下与本 run 节点同名的结果文件，其它文件不动。\n点「取消」= 保留产物（默认）。',
    );
    try {
      await fetchJson<{ deleted: boolean; purgedArtifacts: number }>(
        'DELETE',
        `/api/runs/${encodeURIComponent(runId)}/archive${alsoArtifacts ? '?purgeArtifacts=1' : ''}`,
      ).then((d) => {
        if (d.purgedArtifacts) log('info', `已连带清理 ${d.purgedArtifacts} 个产物文件`);
      });
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
              <button className="danger" title="真删除（不可恢复；可选一并清理本 run 产物，默认保留）" onClick={() => void purge(r.runId)}>🗑</button>
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

  // v8-H2 产物货架：展开时拉一次文件列表，查看按需拉单文件内容
  const [openArts, setOpenArts] = useState<string | null>(null);
  const [artLists, setArtLists] = useState<Record<string, { dir: string; exists: boolean; files: ArtifactFile[] }>>({});
  const [artView, setArtView] = useState<Record<string, string>>({});

  const toggleArtifacts = async (runId: string) => {
    if (openArts === runId) {
      setOpenArts(null);
      return;
    }
    setOpenArts(runId);
    if (artLists[runId]) return;
    try {
      const d = await fetchJson<{ dir: string; exists: boolean; files: ArtifactFile[] }>('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`);
      setArtLists((c) => ({ ...c, [runId]: d }));
    } catch (e) {
      log('error', `读取产物列表失败：${(e as Error).message}`);
    }
  };

  const viewArtifact = async (runId: string, name: string) => {
    const key = `${runId}:${name}`;
    if (artView[key]) {
      setArtView((c) => {
        const next = { ...c };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const d = await fetchJson<{ content: string; truncated: boolean }>(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/artifacts/file?path=${encodeURIComponent(name)}`,
      );
      setArtView((c) => ({ ...c, [key]: d.content + (d.truncated ? '\n…（内容过大，已截断——用 ⤓ 下载看全文）' : '') }));
    } catch (e) {
      setArtView((c) => ({ ...c, [key]: `（无法内联预览：${(e as Error).message}——试 ⤓ 下载）` }));
    }
  };

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
  const queuedCount = list.filter((r) => r.state === 'queued').length;

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
        {queuedCount > 0 && <span><b>{queuedCount}</b> 排队中</span>}
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
                {r.state === 'running' ? '运行中' : r.state === 'queued' ? '⏳ 排队中' : r.state === 'completed' ? '完成 ✅' : r.state === 'failed' ? '失败 ❌' : '已取消'}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.state === 'queued' ? `已等 ${elapsed}s` : `${elapsed}s`}</span>
              {runCostLabel(r) && (
                <span className="run-cost-chip" title="成本账：时长/重试/tokens（unknown = agent 未自报，不估算）">{runCostLabel(r)}</span>
              )}
              {Object.values(r.nodes).some((n) => n.unverified) && (
                <span className="run-cost-chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} title="部分节点结果文件缺失，产物取自终端尾部兜底（未经文件验证，结论可信度打折）">
                  ⚠ 未验证产物
                </span>
              )}
              {r.contract && (
                <span
                  className="run-cost-chip"
                  title={[
                    `这单按以下约定在干（${r.contract.source === 'input' ? '需求自带' : '契约门谈定'}${r.contract.template ? `・骨架 ${r.contract.template}` : ''}${r.contract.confirmedAt ? `・${r.contract.confirmedAt.slice(0, 19).replace('T', ' ')} 已确认` : '・待确认'}）：`,
                    ...r.contract.assertions.map((a) => `${a.id}: ${a.assertion}`),
                    ...(r.contract.scopeNotes ? [`边界：${r.contract.scopeNotes}`] : []),
                  ].join('\n')}
                >
                  📜 契约 {r.contract.assertions.length} 条{r.contract.source === 'generated' && !r.contract.confirmedAt ? '·待确认' : ''}
                </span>
              )}
              {r.prUrl && (
                <a
                  className="run-cost-chip"
                  href={r.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderColor: 'var(--ok, var(--accent))', color: 'var(--ok, var(--accent))', textDecoration: 'none' }}
                  title={`交付出口：${r.prUrl}（人类可 review 的东西已经出网）`}
                >
                  🔗 PR
                </a>
              )}
              <div className="run-card-ops">
                <button
                  className={open ? 'active' : ''}
                  title={`事件时间线：谁在何时做了什么${eventCount ? `（${eventCount} 条）` : ''}`}
                  onClick={() => void toggleTimeline(r.runId, !!liveEvents?.length)}
                >
                  ⏱{eventCount ? ` ${eventCount}` : ''}
                </button>
                <button
                  className={openArts === r.runId ? 'active' : ''}
                  title={artLists[r.runId] ? `产物货架：这单落下了 ${artLists[r.runId]!.files.length} 个文件（可点开/下载）` : '产物货架：这单落下的交付文件（点开看清单）'}
                  onClick={() => void toggleArtifacts(r.runId)}
                >
                  🗂{artLists[r.runId] ? ` ${artLists[r.runId]!.files.length}` : ''}
                </button>
                <button title="导出完整记录 JSON" onClick={() => {
                  const a = document.createElement('a');
                  a.href = `/api/runs/${r.runId}/export`;
                  a.download = `${r.runId}.json`;
                  a.click();
                }}>⤓</button>
                {!['running', 'queued'].includes(r.state) && (
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
                {r.state === 'queued' && <button className="danger" title="取消排队（尚未开跑，撤回即终态）" onClick={() => void stop(r.runId)}>✕</button>}
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
            {openArts === r.runId && (
              <div className="artifact-shelf">
                {!artLists[r.runId] && <div className="artifact-row dim">产物列表加载中…</div>}
                {artLists[r.runId]?.exists === false && (
                  <div className="artifact-row dim">这单还没有产物文件（期望位置：{artLists[r.runId]!.dir}）。</div>
                )}
                {artLists[r.runId]?.files.map((f) => {
                  const viewKey = `${r.runId}:${f.name}`;
                  return (
                    <div key={f.name} className="artifact-item">
                      <div className="artifact-row">
                        <b>{f.name}</b>
                        {f.nodeLabel && (
                          <span className="artifact-chip">
                            {f.nodeLabel}
                            {f.nodeState ? `·${f.nodeState}` : ''}
                          </span>
                        )}
                        {f.unverified && (
                          <span className="artifact-chip warn" title="该节点产物取自终端尾部兜底，未经文件验证">
                            ⚠ 未验证
                          </span>
                        )}
                        <span className="dim">
                          {(f.size / 1024).toFixed(1)} KB · {f.mtime.slice(0, 19).replace('T', ' ')}
                        </span>
                        <button onClick={() => void viewArtifact(r.runId, f.name)}>{artView[viewKey] ? '收起' : '查看'}</button>
                        <a
                          className="artifact-dl"
                          href={`/api/runs/${encodeURIComponent(r.runId)}/artifacts/file?path=${encodeURIComponent(f.name)}&raw=1`}
                          download={f.name}
                          title="下载原文件"
                        >
                          ⤓
                        </a>
                      </div>
                      {artView[viewKey] && <pre className="artifact-content">{artView[viewKey]}</pre>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
        </>
      )}
    </div>
  );
}
