import { useState } from 'react';
import { useStore } from '../store.js';

export function Guide({ onClose }: { onClose: () => void }) {
  const herdrOk = useStore((s) => s.herdrOk);
  const [full, setFull] = useState(false);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>PaneFlow 使用指南</h2>
        <p style={{ color: 'var(--text-dim)' }}>
          每个 <b>Agent 节点</b> 对应一个独立的 Herdr 终端 Pane（独立进程、独立工作目录），
          按你定的编排确定性地串行 / 并行执行，产物经黑板交接，高危操作会被 <b>blocked 审批</b> 拦下等你放行。
          {herdrOk === false && <b style={{ color: 'var(--err)' }}>（当前 Herdr 未连接，请先确认 Herdr server 正在运行）</b>}
        </p>

        <h3>三步跑通</h3>
        <ol>
          <li>
            <span className="step-num">1</span>
            <b>描述任务</b>：在「任务」页用一句话说清要做的事，选好工作目录，点「🎯 下发任务」。
          </li>
          <li>
            <span className="step-num">2</span>
            <b>看编排预告</b>：Planner 选完骨架会停下来，把「将执行哪几步」的清单给你看，
            点「确认，开始执行」才真正跑；不满意就「取消这次下发」。
          </li>
          <li>
            <span className="step-num">3</span>
            <b>处理审批与结果</b>：节点变红 = Agent 停在审批界面，切到<b>下方控制台的「审批」标签</b>
            查看终端快照并放行 / 终止 / 补充指令；结束后在同一个控制台的<b>「产物汇总」标签</b>查看各节点结构化结论。
          </li>
        </ol>

        <p className="guide-more">
          看进度用「运行」页；想改结构就到「编排」页——那里有 <b>清单 / 画布</b> 两种看法，
          清单给人读，画布给结构改。
          <button className="link" onClick={() => setFull((v) => !v)}>
            {full ? '收起完整教程' : '展开完整教程 →'}
          </button>
        </p>

        {full && (
          <>
            <h3>自己从画布搭一条流水线</h3>
            <ol>
              <li><span className="step-num">1</span><b>设置工作目录</b>：顶栏「流水线工作目录」填一个已存在的本地目录（Agent 们的操作根目录）。</li>
              <li><span className="step-num">2</span><b>搭建画布</b>：从左侧「核心」点「⚙ Agent 节点」；并行任务在「高级节点」里加「同时做几件事 / 等全部做完」。从节点右侧圆点<b>拖到</b>下一个节点左侧圆点完成连线（选中连线按 <kbd>Backspace</kbd> 删除）。</li>
              <li><span className="step-num">3</span><b>配置 Agent 节点</b>：点击节点，右侧面板选 Agent 类型（pi / opencode / claude…），填任务指令。指令里可用 <kbd>{'{{上游节点.artifact.summary}}'}</kbd> 引用上游产物；重试 / 超时 / 检查门禁等在「高级设置」里。</li>
              <li><span className="step-num">4</span><b>运行</b>：点「▶ 运行」。节点色条实时反映状态；底部控制台可看运行日志、终端输出、产物汇总。</li>
            </ol>

            <h3>节点状态色标（与 Herdr 原生五态对齐）</h3>
            <table>
              <tbody>
                <tr><td><span className="st-dot st-done" />绿</td><td>done / idle — 本轮任务完成，等待下一步</td></tr>
                <tr><td><span className="st-dot st-working" />黄</td><td>working / starting — Agent 正在干活</td></tr>
                <tr><td><span className="st-dot st-blocked" />红</td><td>blocked — Agent 停在审批/提问界面，需要人工处理</td></tr>
                <tr><td><span className="st-dot st-failed" />红灰</td><td>failed — 重试耗尽后的失败（按失败策略终止或跳过）</td></tr>
                <tr><td><span className="st-dot st-queued" />灰</td><td>pending / queued — 排队等待依赖完成</td></tr>
              </tbody>
            </table>

            <h3>编排语义</h3>
            <ul>
              <li><b>依赖即顺序</b>：连线的上游完成后下游才会启动；无依赖关系的 Agent 节点自动真实并行（受全局并发上限保护）。</li>
              <li><b>扇出</b>（同时做几件事）：一个节点分出多条线 = 分支并行；<b>扇入</b>（等全部做完）：多条线汇入 = 屏障等待全部完成。扇入默认「严格」：任一分支失败整体失败；属性面板可改「宽容」。</li>
              <li><b>失败策略</b>：Agent 节点可配重试次数（重试 = 全新 Pane）与失败时「终止流水线 / 跳过继续」。失败节点的下游会被跳过。</li>
              <li><b>条件边</b>：选中一条连线可挂断言（如 <kbd>aligned = true</kbd>），运行时不满足则该分支被剪枝跳过。</li>
            </ul>

            <h3>黑板产物交接</h3>
            <p>
              每个 Agent 节点的指令会自动附加结果约定：完成后把结构化结论写入
              <kbd>.herdr/artifacts/&lt;节点id&gt;.json</kbd>（summary / files / errors）。
              编排器读取后存入黑板，下游节点用 <kbd>{'{{节点id.artifact.summary}}'}</kbd>（结论）、
              <kbd>{'{{节点id.artifact.files}}'}</kbd>（文件清单）、<kbd>{'{{节点id.output}}'}</kbd>（终端输出尾部）引用。
              若 Agent 没写结果文件，自动回退用终端输出尾部，产物汇总页会标注来源。
            </p>

            <h3>模板与云端沉淀</h3>
            <ul>
              <li><b>保存 / 加载模板</b>：编排页顶栏填模板名 →「💾 保存模板」；左侧模板库点击即载入（含布局与全部配置）。</li>
              <li><b>GitHub 沉淀</b>（可选）：服务端配置 <kbd>PF_GITHUB_REPO</kbd> / <kbd>PF_GITHUB_TOKEN</kbd> 后，顶栏「⋯ 更多」里的「沉淀 / 拉取」可双向同步模板。未配置时功能会提示而不干扰。</li>
              <li><b>项目</b>：左侧栏「项目」视图总览全部项目——点卡片即切换、可新建；「编辑档案」就地配主仓根/约定文档/班底（v10-W 起档案不再在设置页）。模板与运行记录按项目互相隔离。</li>
            </ul>

            <h3>常见问题</h3>
            <ul>
              <li><b>想专心看日志？</b>拖拽底部控制台上边缘可任意调高（双击复位），「⌄ 收起」可把控制台折叠成细条；折叠状态下点任意标签页即恢复。右上角 🌙/☀️ 一键切换明暗主题。</li>
              <li><b>节点一直黄着不动？</b>「终端预览」页选中该节点，实时查看 Agent 界面；若是弹窗/更新提示挡住，用右侧 <kbd>esc</kbd> / <kbd>ctrl+c</kbd> 按钮或输入框直接干预。</li>
              <li><b>产物汇总里显示「输出回退」？</b>Agent 没按约定写结果文件，黑板退回了终端输出尾部；建议在指令里更明确地要求写文件（系统已自动附加约定，通常无需操心）。</li>
              <li><b>启动报「工作目录不存在」？</b>先在本地创建目录再运行——编排器不会替你建根目录。</li>
              <li><b>Herdr 灯变红？</b>确认 Herdr server 在运行（<kbd>herdr status</kbd>）；服务重启后 PaneFlow 会自动重连并回收遗留的流水线 workspace。</li>
            </ul>
          </>
        )}

        <div className="close-row">
          <button className="primary" onClick={onClose}>开始使用</button>
        </div>
      </div>
    </div>
  );
}
