import { create } from 'zustand';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { DagGraph, DagNode, DagNodeType, NodeRunState, RunRecord } from '@paneflow/shared';
import { validateDag } from '@paneflow/shared';

export interface PfNodeData extends Record<string, unknown> {
  dagNode: DagNode;
  runState?: NodeRunState;
  agentStatus?: string;
  blocked?: boolean;
}

export type PfNode = Node<PfNodeData>;

export interface ConsoleLog {
  ts: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface PfStore {
  graphName: string;
  nodes: PfNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  logs: ConsoleLog[];
  runs: Record<string, RunRecord>;
  activeRunId: string | null;
  wsOk: boolean;
  herdrOk: boolean | null;
  cwd: string;
  agentKinds: string[];
  templateList: DagGraph[];

  setCwd: (cwd: string) => void;
  setHealth: (herdrOk: boolean | null, wsOk: boolean) => void;
  setAgentKinds: (kinds: string[]) => void;
  setTemplates: (graphs: DagGraph[]) => void;
  log: (level: ConsoleLog['level'], text: string) => void;
  select: (id: string | null) => void;

  onNodesChange: (changes: NodeChange<PfNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;

  addNode: (type: DagNodeType, position: { x: number; y: number }) => void;
  updateNodeConfig: (nodeId: string, patch: Partial<DagNode['config']>) => void;
  renameGraph: (name: string) => void;
  loadGraph: (graph: DagGraph) => void;
  toGraph: () => DagGraph;
  clearCanvas: () => void;

  applyRun: (run: RunRecord) => void;
  setActiveRun: (runId: string | null) => void;
  approve: (runId: string, nodeId: string, action: 'approve' | 'reject' | 'input', text?: string) => void;
}

let nodeSeq = 1;

function dagToRf(graph: DagGraph): { nodes: PfNode[]; edges: Edge[] } {
  const nodes = graph.nodes.map((n, i) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 80 + (i % 4) * 240, y: 60 + Math.floor(i / 4) * 140 },
    data: { dagNode: n },
  }));
  const edges = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
  }));
  return { nodes, edges };
}

export const useStore = create<PfStore>((set, get) => ({
  graphName: '未命名流水线',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  logs: [],
  runs: {},
  activeRunId: null,
  wsOk: false,
  herdrOk: null,
  cwd: '',
  agentKinds: ['opencode'],
  templateList: [],

  setCwd: (cwd) => set({ cwd }),
  setHealth: (herdrOk, wsOk) => set({ herdrOk, wsOk }),
  setAgentKinds: (agentKinds) => set({ agentKinds }),
  setTemplates: (templateList) => set({ templateList }),
  log: (level, text) =>
    set((s) => ({
      logs: [...s.logs.slice(-400), { ts: new Date().toLocaleTimeString(), level, text }],
    })),
  select: (id) => set({ selectedNodeId: id }),

  onNodesChange: (changes) =>
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) })),
  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),
  onConnect: (conn) =>
    set((s) => ({
      edges: addEdge({ ...conn, id: `e-${conn.source}-${conn.target}` }, s.edges),
    })),

  addNode: (type, position) => {
    const s0 = get();
    // start / end are unique — replace any existing one
    if (type === 'start' || type === 'end') {
      const existing = s0.nodes.find((n) => n.data.dagNode.type === type);
      if (existing) {
        set({ selectedNodeId: existing.id });
        return;
      }
    }
    const id = type === 'start' || type === 'end' ? type : `${type}-${nodeSeq++}`;
    const defaults: Record<DagNodeType, Partial<DagNode['config']>> = {
      start: {},
      end: {},
      agent: { agentKind: get().agentKinds[0], prompt: '', retryCount: 0, timeoutMs: 0, onFail: 'abort' },
      fanout: {},
      fanin: {},
    };
    const dagNode: DagNode = {
      id,
      type,
      label: { start: '开始', end: '结束', agent: `Agent ${nodeSeq}`, fanout: '并行 Fan-out', fanin: '汇总 Fan-in' }[type],
      position,
      config: defaults[type],
    };
    set((s) => ({ nodes: [...s.nodes, { id, type, position, data: { dagNode } }] }));
    set({ selectedNodeId: id });
  },

  updateNodeConfig: (nodeId, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, dagNode: { ...n.data.dagNode, config: { ...n.data.dagNode.config, ...patch } } } } : n,
      ),
    })),

  renameGraph: (name) => set({ graphName: name }),

  loadGraph: (graph) => {
    const { nodes, edges } = dagToRf(graph);
    set({ graphName: graph.name, nodes, edges, selectedNodeId: null });
    get().log('info', `已加载模板「${graph.name}」（${graph.nodes.length} 节点）`);
  },

  toGraph: () => {
    const { graphName, nodes, edges } = get();
    return {
      version: 1,
      name: graphName,
      nodes: nodes.map((n) => ({
        ...n.data.dagNode,
        position: n.position,
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  },

  clearCanvas: () => {
    set({ nodes: [], edges: [], selectedNodeId: null, graphName: '未命名流水线' });
    get().log('info', '画布已清空');
  },

  applyRun: (run) => {
    const isActive = get().activeRunId === null || get().activeRunId === run.runId;
    set((s) => ({ runs: { ...s.runs, [run.runId]: run } }));
    if (!isActive) return;
    if (get().activeRunId === null && run.state === 'running') set({ activeRunId: run.runId });
    // mirror run state onto canvas nodes
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const rec = run.nodes[n.id];
        if (!rec) return n;
        return {
          ...n,
          data: {
            ...n.data,
            runState: rec.state,
            agentStatus: rec.agentStatus,
            blocked: rec.state === 'blocked',
          },
        };
      }),
    }));
    const finished = ['completed', 'failed', 'cancelled'].includes(run.state);
    if (finished) {
      get().log(
        run.state === 'completed' ? 'info' : 'error',
        `流水线 ${run.runId} ${run.state === 'completed' ? '已完成 ✅' : run.state === 'failed' ? '失败 ❌' : '已取消'}`,
      );
    }
  },

  setActiveRun: (runId) => {
    set({ activeRunId: runId });
    const run = runId ? get().runs[runId] : null;
    if (run) get().applyRun(run);
  },

  approve: (runId, nodeId, action, text) => {
    void import('./api.js').then(({ api }) =>
      api
        .approve(runId, nodeId, text ? { action, text } : { action })
        .then(() => get().log('info', `已提交审批动作「${action}」：${nodeId}`))
        .catch((e) => get().log('error', `审批提交失败：${String(e.message ?? e)}`)),
    );
  },
}));

export function graphIssues(): string[] {
  const { toGraph } = useStore.getState();
  return validateDag(toGraph())
    .filter((i) => i.level === 'error')
    .map((i) => i.message);
}
