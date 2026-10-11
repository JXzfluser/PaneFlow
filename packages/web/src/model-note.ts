/**
 * v19 打磨：「这枚模型值会不会被注进启动参数」的起单前可见面（纯函数）。
 * 判据住在 server（/api/health 的 agentModelDialects，方言账单源现算），这里只做**消费与措辞陈列**：
 * 拿不到读数（旧 server 缺键 / kind 不在册 / 岗或节点没解析出引擎）一律回 null 不画判词——
 * 前端不猜引擎行为（铁律 R4），运行时那句「⚠ 模型没注入」才是权威读数。
 */

export type ModelDialectRead = { dialect: 'flag' | 'levels' | 'none'; levels?: string[] };

export function modelCoverNote(
  model: string | undefined,
  kind: string | undefined,
  dialects: Record<string, ModelDialectRead> | undefined,
): string | null {
  const m = model?.trim();
  if (!m) return null;
  const read = kind && dialects ? dialects[kind] : undefined;
  if (!read) return null;
  if (read.dialect === 'flag') return null;
  if (read.dialect === 'levels') {
    const levels = read.levels ?? [];
    if (levels.includes(m)) return null;
    return `「${kind}」只认档位（${levels.join('/')}）——「${m}」不会注入，运行时只披露`;
  }
  return `「${kind}」的模型通道本机未实探——这值不会注入启动参数（网关 env 或统一覆盖旗标 agentArgs 才是真路）`;
}
