import { isChecked, type ModalRequest } from './components/PromptModal.jsx';

/** 读数辅助住在 PromptModal（形状是它定的），这里转口一份，让调用侧只认 dialogs 一个入口 */
export { isChecked };

/**
 * 确认类对话框的**文案与形状**收在一处（v14 better-ui：原生 `window.confirm` 归位 D3 统一小模态）。
 *
 * 为什么要单开一个文件：packages/web 没有组件渲染测试，只有纯函数测试。模态的「长什么样、默认勾哪一侧、
 * 提交时把哪个开关传下去」全是判断，留在组件里就等于这部分逻辑永远不会被跑到——搬到这里就能断言。
 * 每个 builder 只吃原始值 + 一个 `onConfirm`，不碰 store、不碰 fetch，因此 node 环境直接可测。
 */

export const ARTIFACT_PURGE_KEY = 'purgeArtifacts';

/**
 * v8-H2 归档真删除。原本这是两次连排的原生 confirm（第二次问要不要连带清产物），
 * 搬进模态后合并成一次：产物清理降级成一个**默认不勾**的勾选框——
 * 「不可恢复」那一侧永远不当默认值，旧文案里的「点取消=保留产物（默认）」的口径就落在这枚勾上。
 */
export function purgeRunRequest(
  runId: string,
  onConfirm: (alsoArtifacts: boolean) => void | Promise<void>,
): ModalRequest {
  return {
    title: `真删除 ${runId}`,
    message: '记录文件将从磁盘移除，不可恢复。',
    checks: [
      {
        key: ARTIFACT_PURGE_KEY,
        label: '一并清理该 run 的产物文件（工作区 .herdr/artifacts 下与本 run 节点同名的结果文件 + 产物架上的整份副本；不勾则保留）',
      },
    ],
    confirmText: '真删除',
    danger: true,
    onSubmit: (values) => onConfirm(isChecked(values, ARTIFACT_PURGE_KEY)),
  };
}

/** 断点续跑（v7-A5）：把「继承哪几格」摊开说清，别让人按一个「确定」赌拓扑 */
export function resumeRunRequest(
  run: { runId: string; nodes: Record<string, { nodeId: string; state: string }> },
  onConfirm: () => void | Promise<void>,
): ModalRequest {
  const all = Object.values(run.nodes);
  const done = all.filter((n) => n.state === 'done');
  return {
    title: `从断点续跑 #${run.runId}`,
    message:
      `继承已完成节点 ${done.length}/${all.length}${done.length ? `：${done.map((n) => n.nodeId).join('、')}` : '（没有可继承的格，等于整单重跑）'}，` +
      '失败与未执行节点将重新执行；产物黑板从源 run 载入。',
    confirmText: '续跑',
    onSubmit: () => onConfirm(),
  };
}

/** U2 解绑 PAT：只清本机存的 token，不动仓库配置，gh 登录态还能兜底 */
export function unlinkPatRequest(onConfirm: () => void | Promise<void>): ModalRequest {
  return {
    title: '清除本机存储的 PAT',
    message: '默认仓库等配置会保留；本机 gh 登录态仍可当兜底凭据。',
    confirmText: '清除',
    danger: true,
    onSubmit: () => onConfirm(),
  };
}

/**
 * M4 接单模板 409 二次确认。原本这段是「catch → 判 message 含 overwrite → 原生 confirm → 递归重发」，
 * 搬进模态后那句 server 原文直接当说明文字（`msg` 原样透传，不在前端重述判据）。
 */
export function overwriteIntakeRequest(
  serverMessage: string,
  onConfirm: () => void | Promise<void>,
): ModalRequest {
  return {
    title: '覆盖已有接单模板',
    message: `${serverMessage} 确定要用 PaneFlow 模板覆盖它吗？`,
    confirmText: '覆盖',
    danger: true,
    onSubmit: () => onConfirm(),
  };
}

/**
 * 删网关档（v14-A5-5a 的删除面之一）：被项目钉着的档会被 server 400 拦下并列出出处，
 * 那句拒答现在显示在这枚模态内部（不关窗），而不是弹一条会自己消失的 toast。
 */
export function removeGatewayProfileRequest(
  profileName: string,
  onConfirm: () => void | Promise<void>,
): ModalRequest {
  return {
    title: `删除网关档「${profileName}」`,
    message: '密钥与地址会一并从本地移除。还被客户项目钉着的档会被拦下并点名出处——先改掉那几处再来。',
    confirmText: '删除',
    danger: true,
    onSubmit: () => onConfirm(),
  };
}
