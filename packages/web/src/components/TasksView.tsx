import { useEffect, useMemo, useState } from 'react';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { api, fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { deriveSteps, hasParallel, summarizeSteps } from '../steps.js';
import { queuedReasonText } from '../queue-view.js';
import { ADVANCED_FIELDS, ONBOARDING_STEPS } from '../onboarding.js';
import { templateLabel } from '../template-labels.js';
import { addableRoles, type TeamMemberLite, type TeamRoleLite } from '../team-bar.js';

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

/** v9-N1：扩写草稿（可编辑后采纳回任务框） */
type Draft = { title: string; body: string; acceptance: string[]; openQuestions: string[] };

export function TasksView() {
  const cwd = useStore((s) => s.cwd);
  const setCwd = useStore((s) => s.setCwd);
  const log = useStore((s) => s.log);
  const setView = useStore((s) => s.setView);

  const [task, setTask] = useState('');
  const [issueId, setIssueId] = useState('');
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [confirmGate, setConfirmGate] = useState(
    () => localStorage.getItem('pf-dispatch-confirm') !== '0',
  );
  // N4：高级字段默认折叠；缺必填时自动展开（不让错误指向看不见的框）
  const [adv, setAdv] = useState(false);
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
      setAdv(true); // 展开再报错：让「在哪做」字段当场可见
      log('error', '先告诉 PaneFlow 在哪干活：展开下方「高级选项」填工作目录，或在「设 · 设置」里配置项目主仓根');
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
            : r.contract?.mode === 'autofilled'
              ? `输入没写验收标准——AI 已依需求补出 ${r.contract.assertions} 条草案，运行会停在「契约接单门」等你确认；`
              : r.contract?.mode === 'gate'
                ? r.contract.template
                  ? `输入无可机检验收标准——已按契约骨架 ${r.contract.template} 实例化立约，运行会停在「契约接单门」等你确认；`
                  : '输入无可机检验收标准——本单会先停在「契约接单门」立约等你确认；'
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

  /** N1：一句话 → 网关扩写成 issue 草稿（浅=一次；深=两稿择优），草稿可编辑后采纳 */
  const enhance = async (deep: boolean) => {
    if (!task.trim()) {
      log('error', '先写一句原始需求，再点扩写');
      return;
    }
    setDraftBusy(true);
    try {
      const r = await api.enhanceIssue(task.trim(), cwd.trim() || undefined, deep);
      setDraft(r.issue);
      log('info', deep ? '深档扩写完成：两稿择优，可编辑后采纳' : '扩写完成：草稿可编辑，采纳后直接下发');
    } catch (e) {
      log('error', `扩写失败：${(e as Error).message}`);
    } finally {
      setDraftBusy(false);
    }
  };

  const adoptDraft = () => {
    if (!draft) return;
    setTask(`${draft.title}\n\n${draft.body}`);
    setDraft(null);
    log('info', '草稿已采纳进任务框——现在可以下发了');
  };

  return (
    <div className="tasks-view">
      <ProjectTeamBar />
      <div className="tasks-hero">
        <h2>你要做什么？</h2>
        {/* N4 三步路径：首屏只有这三步，其余全部收进「高级选项」 */}
        <div className="tasks-steps">
          {ONBOARDING_STEPS.map((s) => (
            <div className="tasks-step" key={s.no}>
              <b>{s.title}</b>
              <span>{s.hint}</span>
            </div>
          ))}
        </div>
        <textarea
          className="tasks-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="例如：给绿化台账汇总做一次性能优化，并逐条验证结果；或：修复登录页在移动端的布局问题"
        />
        <div className="tasks-enhance-row">
          <button disabled={draftBusy} onClick={() => void enhance(false)}>
            {draftBusy ? '扩写中（约 15-60 秒）…' : '✨ 扩写成完整需求'}
          </button>
          <button disabled={draftBusy} onClick={() => void enhance(true)}>
            ✨✨ 深档（两稿择优，慢一倍）
          </button>
          <span className="tasks-sub">写得不具体也没关系：AI 会结合你的项目补出背景、细节和能逐条核对的验收标准，你改完采纳即可</span>
        </div>
        {draft && (
          <div className="enhance-draft">
            <div className="enhance-draft-head">
              <b>📝 扩写草稿（可直接编辑）</b>
              <button className="link" onClick={() => setDraft(null)}>弃用</button>
            </div>
            <input
              className="enhance-draft-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              className="enhance-draft-body"
              rows={10}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            {draft.openQuestions.length > 0 && (
              <ul className="enhance-draft-q">
                {draft.openQuestions.map((q, i) => (
                  <li key={i}>待确认：{q}</li>
                ))}
              </ul>
            )}
            <div>
              <button className="primary" onClick={adoptDraft}>
                ✔ 采纳进任务框
              </button>
            </div>
          </div>
        )}
        {!adv && cwd.trim() && (
          <p className="tasks-cwd-line">在哪做：<code>{cwd.trim()}</code>（高级选项里可改）</p>
        )}
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
                  评论 {preview.data.comments.length} 条・Issue 正文会自动带给执行方，不用手抄
                </div>
              </>
            ) : null}
          </div>
        )}
        <div className="tasks-actions">
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : confirmGate ? '🎯 开始：先给我看计划再跑' : '🎯 开始执行'}
          </button>
        </div>
        <div className="tasks-advanced">
          <button className="link" onClick={() => setAdv((v) => !v)}>
            {adv ? '▾ 收起高级选项' : `▸ 高级选项（${ADVANCED_FIELDS.join(' / ')}）`}
          </button>
          {adv && (
            <div className="tasks-adv-body">
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
              <label className="tasks-check" title="打开后：规划完成后会先停下来，把步骤计划给你确认">
                <input
                  type="checkbox"
                  checked={confirmGate}
                  onChange={(e) => {
                    setConfirmGate(e.target.checked);
                    localStorage.setItem('pf-dispatch-confirm', e.target.checked ? '1' : '0');
                  }}
                />
                执行前先确认编排（关掉=不预览直接跑，熟练后再关）
              </label>
            </div>
          )}
        </div>
      </div>

      <BatchDispatch />

      <RecentTasks onOpenRuns={() => setView('runs')} />
    </div>
  );
}

/** G3 批量派发：一个模板 × 一列 issue 编号 → N 个 run（并发满了自动排队，去「运」页看位次） */
function BatchDispatch() {
  const cwd = useStore((s) => s.cwd);
  const log = useStore((s) => s.log);
  const templates = useStore((s) => s.templateList);
  const [open, setOpen] = useState(false);
  const [tpl, setTpl] = useState('builtin-generic-issue-delivery');
  const [issues, setIssues] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!issues.trim()) {
      log('error', '批量派发需要一列 issue 编号（换行或逗号分隔）');
      return;
    }
    if (!cwd.trim()) {
      log('error', '请先填写工作目录，或在「设 · 设置」里配置项目主仓根');
      return;
    }
    setBusy(true);
    try {
      const r = await api.dispatchBatch(tpl, issues.trim(), cwd.trim(), repo.trim() || undefined);
      log(
        'info',
        `批量派发 ${tpl}：成功 ${r.dispatched} 单${r.queued ? `（其中 ${r.queued} 单排队中）` : ''}` +
          (r.failed.length ? `；失败 ${r.failed.length}：${r.failed.map((f) => `#${f.issue} ${f.error}`).join('；')}` : ''),
      );
      if (r.dispatched) {
        setIssues('');
        void api.listRuns().then((x) => useStore.getState().mergeRuns(x.runs)).catch(() => undefined);
      }
    } catch (e) {
      log('error', `批量派发失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tasks-batch">
      <button className="link" onClick={() => setOpen((v) => !v)}>
        {open ? '▾ 收起批量派发' : '▸ 批量派发：一个模板 × 一列 issue 编号（一单变一批）'}
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div className="tasks-form-row">
            <div className="tasks-field narrow">
              <label>模板骨架</label>
              <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
                {templates.map((g) => (
                  <option key={g.name} value={g.name}>
                    {templateLabel(g.name, g.metadata?.description).title}
                  </option>
                ))}
              </select>
            </div>
            <div className="tasks-field narrow">
              <label>repo（可选 owner/name）</label>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="留空=默认仓或项目候选仓" />
            </div>
          </div>
          <textarea
            value={issues}
            onChange={(e) => setIssues(e.target.value)}
            placeholder={'issue 编号列：一行一个（162\n163\n165），逗号/空格分隔或整列 URL 粘贴也认'}
            rows={4}
            style={{ width: '100%' }}
          />
          <div>
            <button className="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '批量派发中…' : '📋 批量派发'}
            </button>
            <span className="tasks-sub" style={{ marginLeft: 8 }}>
              每单自动注入 Issue 正文；带「验收标准」小节的直接机检入契约；项目并发满了自动排队不冲垮营地
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function RecentTasks({ onOpenRuns }: { onOpenRuns: () => void }) {
  const runs = useStore((s) => s.runs);
  const templates = useStore((s) => s.templateList);
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof api.queueStatus>> | null>(null);

  const refreshQueue = () => void api.queueStatus().then(setQueue).catch(() => undefined);
  // 有排队单才值得轮询位次/占用者；无排队不产生额外请求
  const anyQueued = Object.values(runs).some((r) => r.state === 'queued');
  useEffect(() => {
    refreshQueue();
    if (!anyQueued) return;
    const t = setInterval(refreshQueue, 5000);
    return () => clearInterval(t);
  }, [anyQueued]);

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
        <TaskCard key={r.runId} run={r} templates={templates} queue={queue} onQueueChanged={refreshQueue} />
      ))}
    </div>
  );
}

function TaskCard({
  run,
  templates,
  queue,
  onQueueChanged,
}: {
  run: RunRecord;
  templates: DagGraph[];
  queue: Awaited<ReturnType<typeof api.queueStatus>> | null;
  onQueueChanged: () => void;
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

  const promote = async () => {
    try {
      await api.promoteRun(run.runId);
      onQueueChanged();
    } catch (e) {
      useStore.getState().log('error', `提队首失败：${(e as Error).message}`);
    }
  };
  const cancelQueued = async () => {
    try {
      await api.stopRun(run.runId);
      onQueueChanged();
    } catch (e) {
      useStore.getState().log('error', `取消失败：${(e as Error).message}`);
    }
  };

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

      {/* N3：排队原因可见 + 可动（提队首/取消）——不再是「⏳ 排队中」死局观感 */}
      {run.state === 'queued' && (
        <div className="task-queued">
          <p className="task-queued-reason">{queuedReasonText(queue, run.runId)}</p>
          <div className="task-queued-actions">
            <button onClick={() => void promote()}>⏫ 提到队首</button>
            <button onClick={() => void cancelQueued()}>✕ 取消排队</button>
          </div>
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
              骨架模板「{targetName}」不在当前项目，将回退到通用交付骨架。
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
  return state === 'completed' ? '已完成' : state === 'failed' ? '失败' : state === 'running' ? '运行中' : state === 'queued' ? '⏳ 排队中' : '已取消';
}

/* ===================== v10-U3b 项目班底条 ===================== */

const TEAM_ICONS: Record<string, string> = {
  'std-planner': '🧭',
  'std-implementer': '⚙️',
  'std-reviewer': '🔍',
  'std-verifier': '✅',
  'std-curator': '📚',
};

/** 班底条：项目带哪些 bot 一眼可见，可直接从全局角色库添加/移除；空班底给首发引导 */
function ProjectTeamBar() {
  const spaceId = useStore((s) => s.space);
  const log = useStore((s) => s.log);
  const [team, setTeam] = useState<TeamMemberLite[] | null>(null);
  const [projName, setProjName] = useState('');
  const [roles, setRoles] = useState<TeamRoleLite[]>([]);
  const [seeding, setSeeding] = useState(false);
  useEffect(() => {
    setTeam(null);
    void fetchJson<{ team?: TeamMemberLite[]; name?: string }>('GET', `/api/spaces/${encodeURIComponent(spaceId)}`)
      .then((p) => {
        setTeam(p.team ?? []);
        setProjName(p.name ?? '');
      })
      .catch(() => setTeam([]));
    void fetchJson<{ roles?: TeamRoleLite[] }>('GET', '/api/roles')
      .then((d) => setRoles(d.roles ?? []))
      .catch(() => undefined);
  }, [spaceId]);
  const save = (next: TeamMemberLite[]) => {
    setTeam(next);
    void fetchJson<unknown>('PUT', `/api/spaces/${encodeURIComponent(spaceId)}`, { team: next }).catch((e: Error) =>
      log('error', `班底保存失败：${e.message}`),
    );
  };
  const seedStandard = async () => {
    setSeeding(true);
    try {
      const r = await fetchJson<{ profile: { team?: TeamMemberLite[] } }>(
        'POST',
        `/api/spaces/${encodeURIComponent(spaceId)}/team/standard`,
      );
      setTeam(r.profile.team ?? []);
      const d = await fetchJson<{ roles?: TeamRoleLite[] }>('GET', '/api/roles');
      setRoles(d.roles ?? []);
      log('info', '首发五连已就位：规划 / 实现 / 评审 / 验收 / 沉淀');
    } catch (e) {
      log('error', `装填首发失败：${(e as Error).message}`);
    } finally {
      setSeeding(false);
    }
  };
  if (team === null) return null;
  const nameOf = (id: string) => roles.find((r) => r.id === id)?.name;
  const addable = addableRoles(roles, team);
  return (
    <div className={team.length ? 'team-bar' : 'team-bar empty'}>
      <span className="team-bar-title" title={`项目 ${spaceId}`}>
        🤖 {(projName || spaceId) + ' 的班底'}
      </span>
      {team.map((m, i) => (
        <span className="team-chip" key={m.roleId} title={m.roleId}>
          {TEAM_ICONS[m.roleId] ?? '🤖'} {nameOf(m.roleId) ?? `⚠️ ${m.roleId}（库中已删）`}
          {m.alias && m.alias !== nameOf(m.roleId) ? ` · ${m.alias}` : ''}
          <button className="team-chip-rm" title="移出班底" onClick={() => save(team.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      {team.length === 0 && (
        <>
          <span className="team-bar-hint">这个项目还没有 bot 在岗——</span>
          <button className="ghost" disabled={seeding} onClick={() => void seedStandard()}>
            {seeding ? '装填中…' : '🚀 一键装填首发五连'}
          </button>
        </>
      )}
      {addable.length > 0 && (
        <select
          className="team-add"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id) save([...team, { roleId: id }]);
          }}
          title="从全局角色库挑一个 bot 加入本项目班底"
        >
          <option value="">＋ 从角色库添加</option>
          {addable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
