import { useState } from 'react';
import type { DagGraph } from '@paneflow/shared';
import type { DryRunResult } from './dry-run.js';
import { api } from '../api.js';
import { useActionNote } from '../action-note.js';
import { useStore } from '../store.js';
import { writeFailureNote } from '../write-outcome.js';

/** 两枚按钮撞同一面墙就说同一句话（两处两张脸是新的坑） */
const NO_CWD_NOTE = '请先填写流水线工作目录（须已存在）';

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
  /** 两枚按钮共一份在飞读数（它们抢同一份图与目录），但各说各在干什么：原来「预演」只有 disabled，没有一句话 */
  const [dlgOp, setDlgOp] = useState<'' | 'dry' | 'start'>('');
  const [issueId, setIssueId] = useState('');
  const [preview, setPreview] = useState<DryRunResult | null>(null);

  const missing = variables.filter((v) => v.required && !values[v.key]?.trim());
  // 这一位上的两句前置检查描的是「此刻这个目录 + 此刻这几格必填值」。打包**逐格现值**而不是
  // 「缺哪几格」那串：只填掉两格缺参里的一格，那句「缺少必填参数：A、B」就成了半旧的话，
  // 宁可当场撤下让人再按一次（再按得到的才是当下那份名单）。
  const note = useActionNote(
    `${cwd.trim()}|${variables
      .filter((v) => v.required)
      .map((v) => `${v.key}=${values[v.key]?.trim() ?? ''}`)
      .join('&')}`,
  );

  const dryRun = async () => {
    if (!cwd.trim()) {
      log('error', NO_CWD_NOTE);
      note.notePrecheck(NO_CWD_NOTE);
      return;
    }
    note.clearNote();
    setDlgOp('dry');
    try {
      setPreview(await api.dryRun(graph, cwd.trim(), values));
    } catch (e) {
      // 预演是只读的，没成就是这份清单没生成——旧的那份还挂在上面，所以说清「上面那份是上一次的」
      log('error', `预演失败：${(e as Error).message}`);
      note.noteResult(
        writeFailureNote(preview ? '预演没成（上面那份还是上一次点出来的）' : '预演没成', e),
      );
    } finally {
      setDlgOp((cur) => (cur === 'dry' ? '' : cur));
    }
  };

  const submit = async () => {
    if (!cwd.trim()) {
      const why = NO_CWD_NOTE;
      log('error', why);
      note.notePrecheck(why);
      return;
    }
    if (missing.length) {
      const why = `缺少必填参数：${missing.map((v) => v.label).join('、')}`;
      log('error', why);
      note.notePrecheck(why);
      return;
    }
    note.clearNote();
    setDlgOp('start');
    try {
      const { run } = await api.startRun(graph, cwd.trim(), values, issueId.trim() || undefined);
      onStarted(run.runId);
      log('info', `流水线已启动：${run.runId}`);
      onClose();
    } catch (e) {
      setDlgOp((cur) => (cur === 'start' ? '' : cur));
      log('error', `启动失败：${(e as Error).message}`);
      note.noteResult(writeFailureNote('这单没起', e, '这单起没起不确定，刷新看单列的读数'));
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
        <label style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12, margin: '10px 0 4px' }}>
          关联 Issue（可选，用于运行中心检索与展示）
        </label>
        <input
          value={issueId}
          onChange={(e) => setIssueId(e.target.value)}
          placeholder="如 162"
          style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit' }}
        />
        {variables.length > 0 && (
          <>
            <h3>运行参数</h3>
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
        {preview && (
          <div className="dryrun" style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', maxHeight: 260, overflowY: 'auto' }}>
            <b style={{ fontSize: 12, color: 'var(--accent)' }}>预演（运行时以实际产物为准）</b>
            {preview.warnings.map((w, i) => (
              <div key={i} style={{ color: 'var(--warn)', fontSize: 11.5 }}>⚠ {w}</div>
            ))}
            <ol style={{ paddingLeft: 20, margin: '8px 0', fontSize: 11.5 }}>
              {preview.nodes.map((n) => (
                <li key={n.id} style={{ marginBottom: 4 }}>
                  <b>{n.label}</b>
                  {n.type === 'agent' && <span style={{ color: 'var(--text-dim)' }}> · {n.agentKind ?? '⚠ 未配置'} · {n.cwd}</span>}
                  {n.role && <span style={{ color: 'var(--text-dim)' }}> · 角色 {n.role}</span>}
                  {n.checks.length > 0 && <span style={{ color: 'var(--text-dim)' }}> · {n.checks.length} 项检查</span>}
                  {n.promptPreview && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>{n.promptPreview}…</div>}
                </li>
              ))}
            </ol>
            {preview.edges.filter((e) => e.condition && !e.rejectNote).length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                条件边：{preview.edges.filter((e) => e.condition && !e.rejectNote).map((e) => `${e.source}→${e.target} [${e.condition}]`).join('；')}
              </div>
            )}
            {/* v13-K2 打回线单独说：它不是「往下走的条件」，是「不满意就退回去」——混进条件边会说反 */}
            {preview.edges.some((e) => e.rejectNote) && (
              <div style={{ fontSize: 11, color: 'var(--err)', marginTop: 4 }}>
                打回线：{preview.edges.filter((e) => e.rejectNote).map((e) => `${e.source}→${e.target} ${e.rejectNote}`).join('；')}
              </div>
            )}
          </div>
        )}
        {note.note && (
          <p className="dlg-fail" role="status">
            {note.note.text}
          </p>
        )}
        <div className="close-row">
          <button onClick={onClose}>取消</button>
          <button disabled={dlgOp !== ''} onClick={() => void dryRun()}>
            {dlgOp === 'dry' ? '预演中…' : '🔍 预演'}
          </button>
          <button className="primary" disabled={dlgOp !== ''} onClick={() => void submit()}>
            {dlgOp === 'start' ? '启动中…' : '▶ 启动'}
          </button>
        </div>
      </div>
    </div>
  );
}
