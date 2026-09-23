import { useMemo } from 'react';
import { useStore } from '../store.js';
import { deriveSteps, hasParallel, isParallelBranch, stateLabel, stepKindTag } from '../steps.js';

/**
 * 步骤清单视图（C）：同一份 DAG 的"人话"呈现。
 * 点击任一步 = 选中画布上对应节点（右侧属性面板随之切换）。
 */
export function StepList() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const toGraph = useStore((s) => s.toGraph);
  const select = useStore((s) => s.select);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);

  const graph = useMemo(() => toGraph(), [toGraph, nodes, edges]);
  const runNodes = activeRunId ? runs[activeRunId]?.nodes : undefined;
  const steps = useMemo(() => deriveSteps(graph, runNodes), [graph, runNodes]);

  if (steps.length === 0) {
    return (
      <div className="canvas-wrap">
        <div className="steplist">
          <div className="steplist-empty">
            还没有步骤。先「描述任务，自动编排」，或从左侧模板库载入一个骨架。
          </div>
        </div>
      </div>
    );
  }

  const executable = steps.filter((s) => s.kind !== 'start' && s.kind !== 'end');

  return (
    <div className="canvas-wrap">
      <div className="steplist">
        <div className="steplist-head">
          <b>这条编排会做这几件事</b>
          <span className="steplist-meta">
            共 {executable.length} 步{hasParallel(steps) ? ' · 含并行分支' : ''}
          </span>
        </div>
        <ol className="steplist-body">
          {steps.map((s) => {
            const st = stateLabel(s.state);
            return (
              <li
                key={s.id}
                className={`step ${selectedNodeId === s.id ? 'sel' : ''}`}
                onClick={() => select(s.id)}
              >
                <span className="step-no">{s.no}</span>
                <div className="step-main">
                  <div className="step-title">
                    <span className="step-label">{s.label}</span>
                    <span className="step-tag">{stepKindTag(s.kind)}</span>
                    {isParallelBranch(s, steps) && <span className="step-tag parallel">并行分支</span>}
                    <span className={`step-state ${st.cls}`}>{st.text}</span>
                  </div>
                  <div className="step-note">{s.note}</div>
                  {s.condition && <div className="step-cond">满足条件才执行：{s.condition}</div>}
                  {s.blockedPrompt && (
                    <div className="step-cond blocked">等待你处理：{s.blockedPrompt}</div>
                  )}
                  {s.summary && <div className="step-summary">{s.summary}</div>}
                  {s.node.config.prompt && (
                    <details className="step-prompt" onClick={(e) => e.stopPropagation()}>
                      <summary>提示词</summary>
                      <pre>{s.node.config.prompt}</pre>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
