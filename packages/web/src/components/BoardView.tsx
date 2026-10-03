import { useEffect, useMemo, useState } from 'react';
import type { RunRecord } from '@paneflow/shared';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { runCostLabel } from '../cost.js';
import { templateLabel } from '../template-labels.js';
import { Icon } from './Icon.js';
import { RunsCenter } from './RunsCenter.jsx';

/**
 * 看板（v16-B1）：进行情况的一块板——统计牌 + 审阅队列 + 五列看板。
 *   主流工具的读法：状态一眼可扫（列），要人拍板的事永远浮在最上面（审阅条）。
 *   数据零新接口：全部从 runs store 纯读推导；审批动作走既有 approve 通道（人是审批者，
 *   本页只是把散在各画布里的门集中成一排放满）。
 */
const BOARD_KEY = 'pf-board-mode';
type BoardMode = 'board' | 'list';

type ReviewItem = { run: RunRecord; nodeId: string; nodeName: string; prompt?: string; since?: string };

/** 等你拍板的门：所有 run 的 blocked 节点收集成一排（blockedAt 给等待时长，宁缺毋假） */
function collectReviews(runs: Record<string, RunRecord>): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const run of Object.values(runs)) {
    const nameOf = (id: string) => run.graph.nodes.find((n) => n.id === id)?.label ?? id;
    for (const rec of Object.values(run.nodes)) {
      if (rec.state !== 'blocked') continue;
      items.push({
        run,
        nodeId: rec.nodeId,
        nodeName: nameOf(rec.nodeId),
        prompt: rec.blockedPrompt,
        since: rec.blockedAt,
      });
    }
  }
  return items.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? '')); // 等最久的排最前
}

function runTitle(run: RunRecord): string {
  return (
    run.graph.metadata?.description?.trim() ||
    (run.issueId ? `Issue #${run.issueId}` : templateLabel(run.dagName).title)
  );
}

function sinceLabel(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60 ? `${m % 60} 分` : ''}`.trim();
}

function progressOf(run: RunRecord): { done: number; total: number; pct: number } {
  const all = Object.values(run.nodes);
  const done = all.filter((n) => ['done', 'failed', 'skipped', 'cancelled'].includes(n.state)).length;
  return { done, total: all.length, pct: all.length ? Math.round((done / all.length) * 100) : 0 };
}

type Bucket = 'review' | 'queued' | 'running' | 'done' | 'ended';

function bucketOf(run: RunRecord): Bucket {
  if (Object.values(run.nodes).some((n) => n.state === 'blocked')) return 'review';
  if (run.state === 'queued') return 'queued';
  if (run.state === 'running') return 'running';
  if (run.state === 'completed' || run.state === 'completed-with-failures') return 'done';
  return 'ended'; // failed / cancelled
}

const BUCKETS: { id: Bucket; label: string; hint: string }[] = [
  { id: 'review', label: '等你审批', hint: '卡在人工门的单——批准或驳回都在这张卡上' },
  { id: 'queued', label: '排队中', hint: '并发满员在等位' },
  { id: 'running', label: '运行中', hint: 'Agent 正在干活' },
  { id: 'done', label: '已完成', hint: '终态：完成（含带失败收口）' },
  { id: 'ended', label: '失败/取消', hint: '终态：失败或主动取消' },
];

const BADGE: Record<string, string> = {
  completed: 'done',
  'completed-with-failures': 'failed',
  failed: 'failed',
  running: 'working',
};

export function BoardView() {
  const runs = useStore((s) => s.runs);
  const openRun = useStore((s) => s.openRun);
  const setView = useStore((s) => s.setView);
  const approve = useStore((s) => s.approve);
  const [mode, setMode] = useState<BoardMode>(() =>
    localStorage.getItem(BOARD_KEY) === 'list' ? 'list' : 'board',
  );
  const [acting, setActing] = useState<Set<string>>(new Set());

  // 打开看板先拉一次全量运行账（不依赖 WS 推送是否齐全）
  useEffect(() => {
    void api
      .listRuns()
      .then((r) => useStore.getState().mergeRuns(r.runs))
      .catch(() => undefined);
  }, []);

  const list = useMemo(() => Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [runs]);
  const reviews = useMemo(() => collectReviews(runs), [runs]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    return {
      review: reviews.length,
      running: list.filter((r) => bucketOf(r) === 'running').length,
      queued: list.filter((r) => r.state === 'queued').length,
      dispatchedToday: list.filter((r) => new Date(r.startedAt).toDateString() === today).length,
      done: list.filter((r) => r.state === 'completed' || r.state === 'completed-with-failures').length,
      failed: list.filter((r) => r.state === 'failed').length,
    };
  }, [list, reviews]);

  const switchMode = (m: BoardMode) => {
    localStorage.setItem(BOARD_KEY, m);
    setMode(m);
  };

  const act = (runId: string, nodeId: string, action: 'approve' | 'reject') => {
    const key = `${runId}:${nodeId}`;
    setActing((s) => new Set(s).add(key));
    approve(runId, nodeId, action);
    // 放门后 WS 会推新状态；只把「在发」读数保留一小段，防连点
    setTimeout(() => setActing((s) => { const n = new Set(s); n.delete(key); return n; }), 1500);
  };

  const openCanvas = (runId: string) => {
    openRun(runId);
    setView('orchestrate');
  };

  const buckets = useMemo(() => {
    const map: Record<Bucket, RunRecord[]> = { review: [], queued: [], running: [], done: [], ended: [] };
    for (const r of list) map[bucketOf(r)].push(r);
    return map;
  }, [list]);

  return (
    <div className="board-view">
      {/* 统计牌：进行情况的五个数——数字下不说谎，N 就是 N */}
      <div className="board-stats">
        <div className={`stat-card${stats.review ? ' hot' : ''}`}>
          <b>{stats.review}</b>
          <span>等你审批</span>
        </div>
        <div className="stat-card">
          <b>{stats.running}</b>
          <span>运行中</span>
        </div>
        <div className="stat-card">
          <b>{stats.queued}</b>
          <span>排队中</span>
        </div>
        <div className="stat-card">
          <b>{stats.dispatchedToday}</b>
          <span>今日下发</span>
        </div>
        <div className="stat-card">
          <b>{stats.done}<i className="stat-sub">/ {stats.failed}</i></b>
          <span>完成 / 失败</span>
        </div>
      </div>

      {/* 审阅队列：要人拍板的门集中成一排，批准/驳回不出这页 */}
      {mode === 'board' && reviews.length > 0 && (
        <div className="review-strip">
          <div className="review-strip-head">
            <Icon name="bell" size={13} /> 审阅队列 · {reviews.length} 项等你拍板
          </div>
          <div className="review-cards">
            {reviews.map((it) => {
              const key = `${it.run.runId}:${it.nodeId}`;
              const wait = sinceLabel(it.since);
              return (
                <div className="review-card" key={key}>
                  <div className="review-card-head">
                    <b title={runTitle(it.run)}>{runTitle(it.run)}</b>
                    <span className="review-node">{it.nodeName}</span>
                  </div>
                  {it.prompt && <p className="review-prompt">{it.prompt.slice(0, 120)}{it.prompt.length > 120 ? '…' : ''}</p>}
                  <div className="review-ops">
                    {wait && <span className="review-wait">等了 {wait}</span>}
                    <span className="spacer" />
                    <button className="link" onClick={() => openCanvas(it.run.runId)}>详情</button>
                    <button disabled={acting.has(key)} onClick={() => act(it.run.runId, it.nodeId, 'reject')}>驳回</button>
                    <button className="primary" disabled={acting.has(key)} onClick={() => act(it.run.runId, it.nodeId, 'approve')}>
                      {acting.has(key) ? '放门中…' : '✓ 批准'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="board-mode-row">
        <div className="board-mode-switch" title="同一份运行账的两种看法：看板扫进度，清单查细节">
          <button className={mode === 'board' ? 'on' : ''} onClick={() => switchMode('board')}>看板</button>
          <button className={mode === 'list' ? 'on' : ''} onClick={() => switchMode('list')}>清单</button>
        </div>
        <span className="board-mode-hint">共 {list.length} 条运行记录</span>
      </div>

      {mode === 'list' ? (
        <RunsCenter />
      ) : (
        <div className="board-cols">
          {BUCKETS.map((col) => {
            const cards = buckets[col.id];
            return (
              <div className={`board-col${col.id === 'review' && cards.length ? ' hot' : ''}`} key={col.id} title={col.hint}>
                <div className="board-col-head">
                  <b>{col.label}</b>
                  <span className="board-col-count">{cards.length}</span>
                </div>
                {col.id === 'review' && cards.length > 0 && (
                  <button className="link board-col-jump" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                    ↑ 到审阅队列处理
                  </button>
                )}
                <div className="board-col-cards">
                  {cards.length === 0 && <div className="board-col-empty">空</div>}
                  {cards.map((r) => (
                    <BoardCard key={r.runId} run={r} onOpen={() => openCanvas(r.runId)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BoardCard({ run, onOpen }: { run: RunRecord; onOpen: () => void }) {
  const state = run.state;
  const prog = progressOf(run);
  const cost = runCostLabel(run);
  const active = state === 'running' || state === 'queued';
  return (
    <div className="board-card" onClick={onOpen} title="打开画布查看这条编排">
      <div className="board-card-top">
        <span className={`badge ${BADGE[state] ?? ''}`}>{state === 'completed-with-failures' ? '完成（有失败）' : state === 'queued' ? '排队中' : state === 'running' ? '运行中' : state === 'completed' ? '完成' : state === 'failed' ? '失败' : '已取消'}</span>
        <span className="board-card-id">{run.runId.slice(0, 8)}</span>
      </div>
      <b className="board-card-title">{runTitle(run)}</b>
      {active && prog.total > 0 && (
        <div className="run-progress">
          <div className="run-progress-bar">
            <div className="run-progress-fill" style={{ width: `${prog.pct}%` }} />
          </div>
          <span className="task-progress-text">{prog.done}/{prog.total} 步</span>
        </div>
      )}
      {cost && <span className="board-card-cost">{cost}</span>}
    </div>
  );
}
