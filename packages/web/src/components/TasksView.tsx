import { useEffect, useMemo, useState } from 'react';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { deriveSteps, hasParallel, summarizeSteps } from '../steps.js';
import { templateLabel } from '../template-labels.js';

/**
 * 任务视图（A 组）：把"按要求驱动编排"变成主路径。
 *   ① 一句话输入 → 下发
 *   ② 执行前先生成「编排预告」（Planner 选骨架 + 该骨架的步骤清单），确认才真正跑
 *   ③ 最近任务卡片，可展开看编排（进画布）
 */
/** G1：与服务端 parseIssueRef 同规则——URL 带 repo，#123 走默认 repo；issueId 框里允许裸数字 */
function detectIssueRef(text: string, allowBareNumber: boolean): { number: number; repo?: string } | null {
  const t = text.trim();
  const url = t.match(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const hash = t.match(/(?:^|\s)#(\d{1,7})(?=$|\s)/);
  if (hash) return { number: Number(hash[1]) };
  if (allowBareNumber && /^\d{1,7}$/.test(t)) return { number: Number(t) };
  return null;
}

type IssuePreview =
  | { key: string; loading: true }
  | { key: string; loading: false; error?: string; data?: Awaited<ReturnType<typeof api.getIssue>> };

export function TasksView() {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const log = useStore((s) => s.log);
  const setView = useStore((s) => s.setView);

  const [task, setTask] = useState('');
  const [issueId, setIssueId] = useState('');
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [confirmGate, setConfirmGate] = useState(
    () => localStorage.getItem('pf-dispatch-confirm') !== '0',
  );
  const [busy, setBusy] = useState(false);

  // 打开任务视图先拉一次历史（不依赖 WS 是否已推送）
  useEffect(() => {
    void api
      .listRuns()
      .then((r) => useStore.getState().mergeRuns(r.runs))
      .catch(() => undefined);
  }, []);

  // G1：识别 Issue 引用（编号框优先，任务文本里的 URL/#N 兜底）并预览正文
  const ref = detectIssueRef(issueId, true) ?? detectIssueRef(task, false);
  const refKey = ref ? `${ref.repo ?? ''}:${ref.number}` : '';
  useEffect(() => {
    if (!ref) {
      setPreview(null);
      return;
    }
    const key = refKey;
    setPreview({ key, loading: true });
    let alive = true;
    api
      .getIssue(ref.number, ref.repo)
      .then((d) => alive && setPreview({ key, loading: false, data: d }))
      .catch((e: Error) => alive && setPreview({ key, loading: false, error: e.message }));
    return () => {
      alive = false;
    };
  }, [refKey]);

  const submit = async () => {
    if (!task.trim()) {
      log('error', '先用一句话描述要做的事');
      return;
    }
    if (!cwd.trim()) {
      log('error', '请先填写工作目录（须已存在），或在「设 · 设置」里配置空间主仓根');
      return;
    }
    setBusy(true);
    try {
      const r = await api.dispatch(task.trim(), cwd.trim(), ref ? String(ref.number) : undefined, confirmGate);
      log(
        'info',
        (r.issueFetched
          ? `已注入 Issue #${r.issueId} 正文（零手抄）；`
          : r.note
            ? `${r.note}；`
            : '') +
          (r.contract?.mode === 'extracted'
            ? `已机检验收标准 ${r.contract.assertions} 条，直接作为本单契约；`
            : r.contract?.mode === 'gate'
              ? '输入无可机检验收标准——本单会先停在「契约接单门」立约等你确认；'
              : '') +
          (confirmGate
            ? `已下发 ${r.runId}：Planner 正在规划，完成后会在这里给你「编排预告」等你确认`
            : `已下发 ${r.runId}：Planner 正在路由并直接执行`),
      );
      setTask('');
      setIssueId('');
      void api.listRuns().then((x) => useStore.getState().mergeRuns(x.runs)).catch(() => undefined);
    } catch (e) {
      log('error', `下发失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tasks-view">
      <div className="tasks-hero">
        <h2>你要做什么？</h2>
        <p className="tasks-sub">
          用一句话描述任务。PaneFlow 会让 Planner 从你的骨架库里挑一条最合适的编排，
          <b>先给你看步骤计划</b>，你确认后才真正跑。
        </p>
        <textarea
          className="tasks-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="例如：给绿化台账汇总做一次性能优化，并逐条验证结果；或：修复登录页在移动端的布局问题"
        />
        <div className="tasks-form-row">
          <div className="tasks-field">
            <label>
              工作目录<span className="req-mark">*</span>
            </label>
            <input
              className={cwd ? '' : 'needs-attn'}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="须已存在的本地目录"
            />
          </div>
          <div className="tasks-field narrow">
            <label>关联 Issue（可选）</label>
            <input
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              placeholder="#162 或 GitHub 链接"
            />
          </div>
        </div>
        {ref && (
          <div className="issue-preview" aria-busy={preview?.loading}>
            {preview?.loading ? (
              <span>正在读取 Issue #{ref.number}…</span>
            ) : preview && !preview.loading && preview.error ? (
              <span className="issue-preview-warn">
                ⚠ Issue #{ref.number} 读取失败：{preview.error}（下发仍会尝试，失败则只按任务描述执行）
              </span>
            ) : preview && !preview.loading && preview.data ? (
              <>
                <div className="issue-preview-head">
                  <b>📌 #{preview.data.number} {preview.data.title}</b>
                  <span className="issue-preview-meta">
                    {preview.data.repo}・{preview.data.state}
                    {preview.data.labels.length > 0 && `・${preview.data.labels.join(', ')}`}
                  </span>
                </div>
                <div className="issue-preview-body">
                  {preview.data.body.slice(0, 240)}
                  {preview.data.body.length > 240 && '…'}
                </div>
                <div className="issue-preview-foot">
                  评论 {preview.data.comments.length} 条・启动时正文注入 Planner，执行前零手抄
                </div>
              </>
            ) : null}
          </div>
        )}
        <div className="tasks-actions">
          <label className="tasks-check" title="打开后：Planner 选完骨架会先停下来，把步骤计划给你确认">
            <input
              type="checkbox"
              checked={confirmGate}
              onChange={(e) => {
                setConfirmGate(e.target.checked);
                localStorage.setItem('pf-dispatch-confirm', e.target.checked ? '1' : '0');
              }}
            />
            执行前先确认编排
          </label>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '下发中…' : '🎯 下发任务'}
          </button>
        </div>
      </div>

      <RecentTasks onOpenRuns={() => setView('runs')} />
    </div>
  );
}

function RecentTasks({ onOpenRuns }: { onOpenRuns: () => void }) {
  const runs = useStore((s) => s.runs);
  const templates = useStore((s) => s.templateList);

  const list = useMemo(
    () => Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs],
  );
  const shown = list.slice(0, 8);

  return (
    <div className="tasks-recent">
      <div className="tasks-recent-head">
        <b>最近任务</b>
        {list.length > shown.length && (
          <button className="link" onClick={onOpenRuns}>
            查看全部 {list.length} 条 →
          </button>
        )}
      </div>
      {shown.length === 0 && (
        <div className="tasks-empty">还没有任务。在上面描述一句要做的事，或从「编」里的模板库载入骨架手动运行。</div>
      )}
      {shown.map((r) => (
        <TaskCard key={r.runId} run={r} templates={templates} />
      ))}
    </div>
  );
}

function TaskCard({
  run,
  templates,
}: {
  run: RunRecord;
  templates: DagGraph[];
}) {
  const openRun = useStore((s) => s.openRun);
  const setView = useStore((s) => s.setView);
  const approve = useStore((s) => s.approve);
  const [showPlan, setShowPlan] = useState(true);

  const all = Object.values(run.nodes);
  const done = all.filter((n) => ['done', 'failed', 'skipped', 'cancelled'].includes(n.state)).length;
  const blockedNodes = all.filter((n) => n.state === 'blocked');
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  // 编排预告：下发链路的 planner 停在人工门禁上
  const planner = run.nodes['planner'];
  const gateOpen = Boolean(planner && planner.state === 'blocked' && isManualGated(run));
  const extra = (planner?.artifact?.extra ?? {}) as {
    taskBrief?: string;
    suggestedTemplate?: string;
  };
  const targetName = extra.suggestedTemplate || 'builtin-generic-issue-delivery';
  const target = templates.find((t) => t.name === targetName);
  const steps = useMemo(() => (target ? deriveSteps(target) : []), [target]);

  const title =
    run.graph.metadata?.description?.trim() ||
    (run.issueId ? `Issue #${run.issueId}` : templateLabel(run.dagName).title);

  const openCanvas = () => {
    openRun(run.runId);
    setView('orchestrate');
  };

  return (
    <div className={`task-card${gateOpen ? ' gated' : ''}`}>
      <div className="task-card-head">
        <span className={`badge ${stateBadge(run.state)}`}>{stateText(run.state)}</span>
        <b className="task-title">{title}</b>
        <span className="task-meta">
          {run.issueId ? `#${run.issueId} · ` : ''}
          {run.runId}
          {run.spaceId ? ` · ${run.spaceId}` : ''}
        </span>
        <div className="task-ops">
          <button title="在画布中查看这条编排" onClick={openCanvas}>查看编排</button>
        </div>
      </div>

      {(run.state === 'running' || blockedNodes.length > 0) && (
        <div className="run-progress">
          <div className="run-progress-bar">
            <div className="run-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="task-progress-text">
            {done}/{all.length} 步
          </span>
        </div>
      )}

      {gateOpen && planner && (
        <div className="plan-gate">
          <div className="plan-gate-head">
            <span className="plan-gate-eyebrow">编排预告 · 等你确认</span>
            <button className="link" onClick={() => setShowPlan((v) => !v)}>
              {showPlan ? '收起计划' : '展开计划'}
            </button>
          </div>
          {extra.taskBrief && <p className="plan-brief">理解的任务：{extra.taskBrief}</p>}
          <p className="plan-skeleton">
            将用骨架：<b>{templateLabel(targetName, target?.metadata.description).title}</b>
            <span className="plan-use"> · {templateLabel(targetName, target?.metadata.description).use}</span>
          </p>
          {showPlan && steps.length > 0 && (
            <ol className="plan-steps">
              {steps.map((s) => (
                <li key={s.id}>
                  <span className="plan-step-no">{s.no}</span>
                  <span className="plan-step-label">{s.label}</span>
                  <span className="plan-step-note">{s.note}</span>
                </li>
              ))}
            </ol>
          )}
          {showPlan && steps.length > 0 && (
            <p className="plan-summary">
              {summarizeSteps(steps)}　共 {steps.length - 2} 步
              {hasParallel(steps) ? ' · 含并行分支' : ''}
            </p>
          )}
          {steps.length === 0 && (
            <p className="plan-summary">
              骨架模板「{targetName}」不在当前空间，将回退到通用交付骨架。
            </p>
          )}
          <div className="plan-gate-actions">
            <button onClick={() => approve(run.runId, 'planner', 'reject')}>取消这次下发</button>
            <button className="primary" onClick={() => approve(run.runId, 'planner', 'approve')}>
              ✔ 确认，开始执行
            </button>
          </div>
          {planner.blockedPrompt && <div className="plan-gate-prompt">{planner.blockedPrompt}</div>}
        </div>
      )}

      {!gateOpen && blockedNodes.length > 0 && (
        <div className="task-blocked">
          有 {blockedNodes.length} 个节点等待你处理（{blockedNodes.map((n) => n.nodeId).join('、')}）。
          <button className="link" onClick={openCanvas}>
            去处理 →
          </button>
        </div>
      )}
    </div>
  );
}

/** planner 节点上挂了 manual 检查 = 这条 run 是"先确认再执行"的下发 */
function isManualGated(run: RunRecord): boolean {
  const node = run.graph.nodes.find((n) => n.id === 'planner');
  return Boolean(node?.config.checks?.some((c) => c.type === 'manual'));
}

function stateBadge(state: RunRecord['state']): string {
  return state === 'completed' ? 'done' : state === 'failed' ? 'failed' : state === 'running' ? 'working' : '';
}

function stateText(state: RunRecord['state']): string {
  return state === 'completed' ? '已完成' : state === 'failed' ? '失败' : state === 'running' ? '运行中' : '已取消';
}
