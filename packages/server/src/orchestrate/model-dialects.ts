/**
 * v19-M1 模型方言表：把「岗位/节点配的那枚模型」翻译成各引擎启动参数。
 *
 * 单一事实源=本机 `--help` 实探（M0，六枚在册已装引擎逐枚拿到的原文方言）：
 *  · claude    `--model <model>`（env 侧 ANTHROPIC_MODEL 也通，网关注入一直在走那条路）
 *  · codex     `-m, --model <MODEL>`（统一用长旗标）
 *  · opencode  `-m, --model provider/model`
 *  · pi        `--model <pattern>`（provider/id，可带 :thinking 后缀）
 *  · hermes    `-m, --model MODEL`
 *  · qodercli  `--model auto|efficient|lite|performance|ultimate`——**档位语义，不是型号语义**，
 *               枚举外的值不注、只披露（把 gpt-4o 塞给它不等于换模型）
 * 其余 12 枚在册 kind 本机未装、未实探：不猜测方言，不注、只披露。
 *
 * 姿态与 v13-W1 装备槽同款：**只披露不拦**——配了模型但引擎不吃这格，起单照起、
 * 事件里说清「这一格没生效」，绝不静默失效。
 */

/** 吃 `--model <值>` 长旗标的 kind（M0 实探证毕） */
const FLAG_MODEL_KINDS = new Set(['claude', 'codex', 'opencode', 'pi', 'hermes']);

/** qodercli 的档位枚举（它只认这五枚，型号名塞进去是假换） */
const QODERCLI_LEVELS = ['auto', 'efficient', 'lite', 'performance', 'ultimate'] as const;

export interface ModelArgsResult {
  /** 注进 startArgs 的参数对；没通道=整键省略 */
  args?: string[];
  /** 没通道时 server 算好的一句人话（CLI/网页只渲，不自造判据） */
  disclosure?: string;
}

/**
 * 一 kind 的模型通道读数（v19 打磨·外发给 `/api/health.agentModelDialects`）：
 * flag=吃 `--model <型号>`；levels=只吃档位枚举（levels 给出值域）；none=未实探，不猜。
 * 与 buildModelArgs 同住这一张表——起单前的可见与起单后的注入永不两把尺。
 */
export type ModelDialectRead = { dialect: 'flag' } | { dialect: 'levels'; levels: string[] } | { dialect: 'none' };

export function describeModelDialect(kind: string): ModelDialectRead {
  if (FLAG_MODEL_KINDS.has(kind)) return { dialect: 'flag' };
  if (kind === 'qodercli') return { dialect: 'levels', levels: [...QODERCLI_LEVELS] };
  return { dialect: 'none' };
}

export function buildModelArgs(kind: string, model: string): ModelArgsResult {
  const read = describeModelDialect(kind);
  if (read.dialect === 'flag') return { args: ['--model', model] };
  if (read.dialect === 'levels') {
    if (read.levels.includes(model)) return { args: ['--model', model] };
    return {
      disclosure: `「${kind}」只认档位枚举（${read.levels.join('/')}），型号名「${model}」没注进启动参数（引擎自己按账号默认跑；要档位就填枚举值）`,
    };
  }
  return {
    disclosure: `「${kind}」的模型旗标未经本机实探，不猜测方言、没注进启动参数（要真换可先配网关 env 或统一覆盖旗标 agentArgs）`,
  };
}
