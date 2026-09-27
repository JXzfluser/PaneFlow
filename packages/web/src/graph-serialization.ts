import type { DagGraph, DagNode, EdgeCondition, GraphRequirement, NodeRunState, TemplateVariable } from '@paneflow/shared';
import { forwardEdges } from '@paneflow/shared';
import type { Edge, Node } from '@xyflow/react';

/**
 * 画布 ↔ DAG 的序列化层（R1 数据完整性）：
 * 图级字段（variables / metadata）与边条件在此层透传，
 * 杜绝"画布只认识 UI 能渲染的字段，其余静默丢弃"。
 */

export type PfNodeData = Record<string, unknown> & {
  dagNode: DagNode;
  /** 运行状态镜像（由运行推送写入，非模板数据） */
  runState?: NodeRunState;
  agentStatus?: string;
  blocked?: boolean;
};

export type PfNode = Node<PfNodeData>;

export interface PfEdgeData extends Record<string, unknown> {
  condition?: EdgeCondition;
  /** v13-K2 否决回边标记：画布要认它，否则「打开→保存」把作者画的打回线洗成普通依赖 */
  reject?: boolean;
}

export type PfEdge = Edge<PfEdgeData>;

export interface GraphMeta {
  createdAt?: string;
  description?: string;
}

/** 进入自动保存载荷的六个字段（G3：守卫此前只比较其中四个，变量/描述改动漏判） */
export interface AutosaveFields {
  graphName: string;
  cwd: string;
  nodes: unknown;
  edges: unknown;
  graphVariables: unknown;
  graphMeta: unknown;
}

/**
 * 自动保存变更检测：zustand 每次 set 对改动字段产生新引用，六字段引用级比较即可；
 * 放纯模块是因为 store.ts 模块级 localStorage 无法在 node 环境的 vitest 导入。
 */
export function autosaveChanged(prev: AutosaveFields, next: AutosaveFields): boolean {
  return (
    prev.nodes !== next.nodes ||
    prev.edges !== next.edges ||
    prev.graphName !== next.graphName ||
    prev.cwd !== next.cwd ||
    prev.graphVariables !== next.graphVariables ||
    prev.graphMeta !== next.graphMeta
  );
}

export interface RfParts {
  nodes: PfNode[];
  edges: PfEdge[];
  variables: TemplateVariable[];
  meta: GraphMeta;
  /** v14-T3 能力槽声明（不进画布渲染，只为「打开→保存」不把作者声明的东西抹掉） */
  requires: GraphRequirement[];
}

let nodeSeq = 1;
export function nextNodeSeq(): number {
  return nodeSeq++;
}

/** 层级兜底布局：拓扑深度排 x，分支纵向居中（模板无位置或位置塌缩时使用） */
export function autoLayout(graph: DagGraph): Record<string, { x: number; y: number }> {
  const ids = graph.nodes.map((n) => n.id);
  const hasSpread = (() => {
    const pos = graph.nodes.filter((n) => n.position);
    if (pos.length < ids.length || pos.length === 0) return false;
    const xs = pos.map((n) => n.position!.x);
    return Math.max(...xs) - Math.min(...xs) >= Math.max(240, ids.length * 12);
  })();
  const out: Record<string, { x: number; y: number }> = {};
  if (hasSpread) {
    for (const n of graph.nodes) out[n.id] = n.position ?? { x: 80, y: 80 };
    return out;
  }
  const depth: Record<string, number> = {};
  // 只按前向边算深度：这里取的是「最大深度」并且持续放宽，回边会把图变成环，
  // 于是深度可以无限增大——布局直接转不出来（页面卡死）。回边不是依赖，不算层。
  const fwd = forwardEdges(graph.edges);
  for (const n of graph.nodes) {
    const stack: { id: string; d: number }[] = [{ id: n.id, d: 0 }];
    while (stack.length) {
      const { id, d } = stack.pop()!;
      if ((depth[id] ?? -1) >= d) continue;
      depth[id] = d;
      for (const e of fwd) if (e.source === id) stack.push({ id: e.target, d: d + 1 });
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth[id] ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }
  const LEVEL_W = 300;
  const ROW_H = 130;
  for (const [d, levelIds] of byDepth) {
    levelIds.forEach((id, i) => {
      const width = graph.nodes.find((n) => n.id === id)?.type === 'agent' ? 220 : 150;
      out[id] = {
        x: 60 + d * LEVEL_W,
        y: 320 + (i - (levelIds.length - 1) / 2) * ROW_H - width / 4,
      };
    });
  }
  return out;
}

export function graphToRfParts(graph: DagGraph): RfParts {
  const layout = autoLayout(graph);
  const nodes: PfNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? layout[n.id] ?? { x: 80, y: 80 },
    data: { dagNode: n },
  }));
  const edges: PfEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
    ...(e.condition || e.reject ? { data: { ...(e.condition ? { condition: e.condition } : {}), ...(e.reject ? { reject: true } : {}) } } : {}),
  }));
  return {
    nodes,
    edges,
    variables: graph.variables ?? [],
    // v14-T3：requires 与 variables 同级——画布不画它，但它在场就得活着（R1 的老教训：
    // 「画布只认识 UI 能渲染的字段，其余静默丢弃」会把作者手写的槽声明洗成没有）
    requires: graph.requires ?? [],
    // metadata 在类型上必填、在运行期未必存在：API 客户端或旧版本落盘的 graph
    // 可能没有 metadata，此处必须兜底，否则「在画布中打开」会整页崩溃。
    meta: {
      createdAt: graph.metadata?.createdAt,
      description: graph.metadata?.description,
    },
  };
}

export function rfToGraph(args: {
  name: string;
  nodes: PfNode[];
  edges: PfEdge[];
  variables: TemplateVariable[];
  meta: GraphMeta;
  requires?: GraphRequirement[];
}): DagGraph {
  const { name, nodes, edges, variables, meta, requires = [] } = args;
  const now = new Date().toISOString();
  return {
    version: 1,
    name,
    nodes: nodes.map((n) => ({
      ...n.data.dagNode,
      position: n.position,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.data?.condition ? { condition: e.data.condition } : {}),
      // 只回写 true：false/缺省都落成「没这键」，与 DagEdge 的省略语义一致
      ...(e.data?.reject === true ? { reject: true } : {}),
    })),
    metadata: {
      // 保真：createdAt 不因保存重置；description 不丢（R1.3）
      createdAt: meta.createdAt || now,
      updatedAt: now,
      description: meta.description,
    },
    ...(variables.length ? { variables } : {}),
    ...(requires.length ? { requires } : {}),
  };
}
