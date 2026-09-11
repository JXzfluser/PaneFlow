import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';

type Tab = 'console' | 'approval' | 'terminal' | 'summary';

export function Console() {
  const logs = useStore((s) => s.logs);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const nodes = useStore((s) => s.nodes);
  const [tab, setTab] = useState<Tab>('console');
  const [terminal, setTerminal] = useState('');
  const [terminalNode, setTerminalNode] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const run = activeRunId ? runs[activeRunId] : null;
  const blockedNodes = run
    ? Object.values(run.nodes).filter((n) => n.state === 'blocked')
    : [];

  useEffect(() => {
    if (blockedNodes.length > 0) setTab('approval');
  }, [blockedNodes.length]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [logs.length, tab]);

  // poll selected node terminal output
  useEffect(() => {
    if (tab !== 'terminal' || !run || !terminalNode) return;
    let alive = true;
    const pull = () => {
      api
        .nodeLog(run.runId, terminalNode)
        .then((r) => {
          if (alive) setTerminal(r.text);
        })
        .catch(() => {
          if (alive) setTerminal('(无法读取终端输出 — agent 可能已结束)');
        });
    };
    pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab, run, terminalNode]);

  return (
    <div className="console">
      <div className="console-tabs">
        {(
          [
            ['console', `运行日志${logs.length ? ` (${logs.length})` : ''}`],
            ['approval', `审批${blockedNodes.length ? ` ⛔${blockedNodes.length}` : ''}`],
            ['terminal', '终端预览'],
            ['summary', '产物汇总'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="console-body" ref={bodyRef}>
        {tab === 'console' &&
          logs.map((l, i) => (
            <div key={i} className={`log-line ${l.level}`}>
              <span className="ts">{l.ts}</span>
              {l.text}
            </div>
          ))}
        {tab === 'approval' &&
          (blockedNodes.length === 0 ? (
            <div className="log-line">当前没有等待人工审批的节点。</div>
          ) : (
            blockedNodes.map((n) => <ApprovalCard key={n.nodeId} runId={run!.runId} nodeId={n.nodeId} />)
          ))}
        {tab === 'terminal' && (
          <TerminalTab
            runId={run?.runId ?? null}
            nodes={nodes.filter((n) => n.data.dagNode.type === 'agent')}
            value={terminalNode}
            onChange={setTerminalNode}
            text={terminal}
          />
        )}
        {tab === 'summary' && (
          <SummaryView />
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ runId, nodeId }: { runId: string; nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const approve = useStore((s) => s.approve);
  const [terminal, setTerminal] = useState('(加载中…)');
  const [freeText, setFreeText] = useState('');

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.nodeLog(runId, nodeId).then((r) => alive && setTerminal(r.text || '(空)')).catch(() => alive && setTerminal('(无法读取)'));
    pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, nodeId]);

  return (
    <div className="approval-card">
      <div className="t">⛔ 节点「{node?.data.dagNode.label ?? nodeId}」等待人工审批</div>
      <div className="pre">{terminal.slice(-1200)}</div>
      <div className="actions">
        <button className="primary" onClick={() => approve(runId, nodeId, 'approve')}>✓ 放行</button>
        <button className="danger" onClick={() => approve(runId, nodeId, 'reject')}>✗ 终止任务</button>
        <input
          placeholder="或向 Agent 发送补充指令…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && freeText.trim()) {
              approve(runId, nodeId, 'input', freeText.trim());
              setFreeText('');
            }
          }}
        />
      </div>
    </div>
  );
}

function TerminalTab({
  runId,
  nodes,
  value,
  onChange,
  text,
}: {
  runId: string | null;
  nodes: ReturnType<typeof useStore.getState>['nodes'];
  value: string | null;
  onChange: (v: string | null) => void;
  text: string;
}) {
  const log = useStore((s) => s.log);
  const [freeText, setFreeText] = useState('');
  const sendKeys = (keys: string[]) => {
    if (!runId || !value) return;
    void api
      .nodeKeys(runId, value, keys)
      .then(() => log('info', `已发送按键 ${keys.join(',')} → ${value}`))
      .catch((e) => log('error', `发送失败：${String(e.message ?? e)}`));
  };
  return (
    <>
      <div style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        选择节点：
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px' }}
        >
          <option value="">（未选择）</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.data.dagNode.label}</option>
          ))}
        </select>
        {runId && value && (
          <>
            <button onClick={() => sendKeys(['escape'])}>esc</button>
            <button onClick={() => sendKeys(['ctrl+c'])}>ctrl+c</button>
            <button onClick={() => sendKeys(['enter'])}>enter</button>
            <input
              placeholder="向终端输入文本后回车…"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeText) {
                  void api
                    .nodeInput(runId, value, freeText)
                    .then(() => log('info', '已发送终端输入'))
                    .catch((err) => log('error', `发送失败：${String(err.message ?? err)}`));
                  setFreeText('');
                }
              }}
              style={{ flex: 1, minWidth: 160, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', font: 'inherit' }}
            />
          </>
        )}
      </div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{text || '（无输出）'}</pre>
    </>
  );
}

function SummaryView() {
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const nodes = useStore((s) => s.nodes);
  const run = activeRunId ? runs[activeRunId] : null;
  if (!run) return <div className="log-line">尚无运行记录。</div>;
  return (
    <div>
      {Object.values(run.nodes)
        .filter((n) => n.artifact)
        .map((n) => {
          const label = nodes.find((x) => x.id === n.nodeId)?.data.dagNode.label ?? n.nodeId;
          const a = n.artifact!;
          return (
            <div key={n.nodeId} className="run-summary">
              <span className="nid">{label}</span>{' '}
              <span style={{ color: 'var(--text-dim)' }}>
                [{a.source === 'file' ? '结果文件' : a.source === 'output-fallback' ? '输出回退' : '无产物'}]
              </span>
              {a.summary && <div>{a.summary}</div>}
              {a.files && a.files.length > 0 && <div style={{ color: 'var(--text-dim)' }}>文件：{a.files.join('、')}</div>}
              {a.errors && a.errors.length > 0 && <div style={{ color: 'var(--err)' }}>错误：{a.errors.join('；')}</div>}
            </div>
          );
        })}
      {Object.values(run.nodes).every((n) => !n.artifact) && <div className="log-line">尚无节点产物。</div>}
    </div>
  );
}
