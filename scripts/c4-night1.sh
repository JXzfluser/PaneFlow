#!/usr/bin/env bash
# =============================================================================
# c4-night1.sh — C4 实验「第一夜」执行包
# =============================================================================
# 用途：把 C4 第一夜的全部操作固化成一个可原样执行的脚本，开夜时不再翻文档拼命令。
#       选题=JXzfluser/PaneFlow #8/#9/#10 三条同类文档小修（issue 派发路，绿单才过沉淀门）。
#
# 子命令：
#   dry      （默认，无参同 dry）只打印将要执行的每一步（带编号与说明），零副作用零网络。
#   night1   真执行第一夜序列：前置检查 → 模板片生效检查 → 逐单起单 → 逐单 watch → status 存档。
#   collect  跑 `paneflow experiments --suite c4` 并原样透传输出（纯只读收数表）。
#
# 护栏（硬约定，脚本自身行为即承诺）：
#   - 绝不自动 approve 审批门：watch 退出码 3 时只列待批节点 + 指路，等人回车后重进 watch。
#   - 绝不写/删 dataDir（~/.paneflow）任何文件：模板片检查仅 [ -f ] + grep -c 两步只读探测
#     （R4 精神下的运维仪式），发现问题只打印处置指路，动手由人。
#   - dry 分支零 curl / 零 paneflow 真调用，全部只 echo。
#   - 失败即停（set -euo pipefail + 每步显式检查），回显原因不回滚。
#
# 第一夜预期读数（诚实口径，见 docs/iteration-v11-requirements.md C4 清单）：
#   零/薄语料基线——A/B 都基本无页可读，差值≈0 也是合法 gate0 读数；
#   当晚真正要验的是三本新账能不能落：harness 实发配置账（v12-V1）、
#   副作用账（v12-S1a sideEffects）、人等分账（v12-V2 attention）。
#   点赞沉淀（C5 预览推绿单上 wiki）是人工网页动作，不在本脚本内。
#   A/B 双臂与 replay --suite c4 --arm 是第二/三夜的事（每臂换 env 重启 server 仪式另做）。
# =============================================================================

set -euo pipefail

# ---- 头变量（选题与题面微调处） ------------------------------------------------
ISSUES=(8 9 10)                          # C4 第一夜三单：#8 网关旋钮 / #9 SESSION / #10 三开关
REPO="JXzfluser/PaneFlow"                # --repo 必须配 --issue（规范 issue URL 给服务端识别）
SPACE="default"
TASK="按 Issue 要求完成文档补全"          # 一句话派活，题面细节以 issue 正文为准（机器可检 grep 验收）
WATCH_TIMEOUT="45m"                      # AGENTS.md 简写口径（60s/30m/2h）；单跑预期 20~40 分钟量级
BASE_URL="http://127.0.0.1:4310"
DATADIR="${PANEFLOW_DATA_DIR:-$HOME/.paneflow}"
TEMPLATES=(builtin-generic-issue-delivery builtin-issue-triage)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${ROOT_DIR}/.tmp/c4-night1-$(date +%Y%m%d).log"

MODE="${1:-dry}"

die() { printf '✘ %s\n' "$*" >&2; exit 1; }

# ---- runId 解析：dispatch --json 输出（或原始 JSON 负载）→ 纯 runId，提不到输出空 ----
parse_run_id() {
  # 用法：run_id=$(printf '%s' "$json" | parse_run_id)
  # 主路：jq 提 .runId；兜底：从人读输出里抠「run <id>」段（两路都空即解析失败）
  local input
  input="$(cat)"
  local via_jq=""
  if command -v jq >/dev/null 2>&1; then
    via_jq="$(printf '%s' "$input" | jq -r '.runId // empty' 2>/dev/null || true)"
  fi
  if [ -n "$via_jq" ]; then
    printf '%s' "$via_jq"
    return
  fi
  printf '%s' "$input" | grep -oE 'run [A-Za-z0-9_-]+' | head -1 | sed 's/^run //' || true
}

# ---- dry：只打印，零副作用零网络 ------------------------------------------------
run_dry() {
  echo "C4 第一夜 dry-run：以下每一步都将执行（night1 子命令真跑），当前零副作用零网络。"
  echo
  echo "【0】配置回显（纯本地变量，不触任何外部进程）"
  echo "    ISSUES=(${ISSUES[*]})  REPO=${REPO}  SPACE=${SPACE}"
  echo "    TASK=\"${TASK}\"  WATCH_TIMEOUT=${WATCH_TIMEOUT}"
  echo "    BASE_URL=${BASE_URL}  DATADIR=${DATADIR}  日志=${LOG_FILE}"
  echo
  echo "【1】前置检查（三项，任一失败即停）"
  echo "    1a. 确认 paneflow CLI 在 PATH：command -v paneflow"
  echo "        （不在则报错指路：release 安装 shim 在 ~/.local/bin/paneflow，或仓库内 pnpm paneflow）"
  echo "    1b. 确认 server 在监听并回显 PID："
  echo "        lsof -nP -iTCP:4310 -sTCP:LISTEN"
  echo "    1c. 确认 health 端点可用（看 agentKinds 字段存在）："
  echo "        curl --noproxy '*' -s ${BASE_URL}/api/health"
  echo
  echo "【2】模板片生效检查（只读探测，脚本绝不写/删 dataDir）"
  for t in "${TEMPLATES[@]}"; do
    echo "    探测 ${DATADIR}/graphs/${t}.json："
    echo "      [ -f 存在 ] 且 grep -c 'runId' ≥1 → 新「runId 携账」措辞已生效（落盘是 JSON 序列化形态，引号带转义，探测式只匹配裸 runId）"
    echo "      文件存在但不含 \"runId\" → 警告：内置模板落盘副本是旧措辞，seed 幂等不覆盖用户编辑，"
    echo "        副作用归因账（v12-S1a）在这两模板上不会兑现。"
    echo "        处置（人来动手）：mv ${DATADIR}/graphs/${t}.json{,.bak} && 重启 server 触发重播 seed"
    echo "      文件不存在 → 跳过（未落盘=每次用内置最新措辞，无需处置）"
  done
  echo
  echo "【3】起单（${#ISSUES[@]} 单顺序派发，每单解析 runId，解析不到即停）"
  for n in "${ISSUES[@]}"; do
    echo "    paneflow dispatch \"${TASK}\" --repo ${REPO} --issue ${n} --space ${SPACE} --json"
    echo "      → jq -r .runId 提取 runId 入列"
  done
  echo
  echo "【4】逐单盯到终态（每单循环 watch --timeout ${WATCH_TIMEOUT} 直到 0/1 收口）"
  echo "    paneflow watch <runId> --timeout ${WATCH_TIMEOUT}"
  echo "    退出码：0 全绿继续下一单 / 1 有红即停（去 status 看失败节点）/"
  echo "            2 超时→提示后回车重进 watch / 3 停在审批门→本脚本绝不自动 approve："
  echo "              打印 paneflow status <runId> --json | jq -r '.awaitingApproval.nodeIds[]'"
  echo "              人去批：paneflow approve <runId> <nodeId>，回车后重进 watch 循环"
  echo
  echo "【5】收单存档（三单全终态后）"
  echo "    逐单 paneflow status <runId> 输出追加到 ${LOG_FILE}"
  echo "    （核对三本新账：harness 实发配置 · sideEffects 副作用 · attention 人等分）"
  echo
  echo "【6】当晚人工动作（脚本不做，提醒）"
  echo "    绿单在网页走 C5 预览→点赞沉淀（喂第二/三夜读回语料）；"
  echo "    收数：paneflow experiments --suite c4（本脚本 collect 子命令）"
}

# ---- night1：真执行 -------------------------------------------------------------
run_night1() {
  command -v paneflow >/dev/null 2>&1 || die "paneflow 不在 PATH。release 安装 shim 在 ~/.local/bin/paneflow（确认 ~/.local/bin 在 PATH，或重跑 install.sh）；仓库内开发可用 pnpm paneflow。"
  command -v jq >/dev/null 2>&1 || die "jq 不在 PATH（runId 解析与审批门节点提取依赖 jq）。brew install jq。"

  echo "【1】前置检查"
  echo "  1a. paneflow: $(command -v paneflow)"
  local pid_line
  pid_line="$(lsof -nP -iTCP:4310 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}' || true)"
  [ -n "$pid_line" ] || die "4310 无监听进程——server 没起。先起 server 再开夜。"
  echo "  1b. server 监听 PID=${pid_line}"
  local health
  health="$(curl --noproxy '*' -s "${BASE_URL}/api/health")" || die "health 端点请求失败（curl ${BASE_URL}/api/health）"
  printf '%s' "$health" | grep -q '"agentKinds"' || die "health 响应缺 agentKinds 字段，server 版本或状态可疑：${health}"
  echo "  1c. health OK（agentKinds 在场）"

  echo "【2】模板片生效检查（只读；本步绝不写/删 dataDir）"
  local stale=0
  for t in "${TEMPLATES[@]}"; do
    local f="${DATADIR}/graphs/${t}.json"
    if [ ! -f "$f" ]; then
      echo "  ${t}: 未落盘（用内置最新措辞），跳过"
      continue
    fi
    local hits
    hits="$(grep -c 'runId' "$f" || true)"
    if [ "${hits:-0}" -ge 1 ]; then
      echo "  ${t}: 落盘副本含 \"runId\" 携账措辞（${hits} 处），OK"
    else
      stale=1
      echo "  ⚠ ${t}: 落盘副本不含 \"runId\"——旧措辞，seed 幂等不覆盖用户编辑，副作用归因账（v12-S1a）不会兑现。"
      echo "    处置（人工执行，脚本只读不动手）："
      echo "      mv ${f} ${f}.bak"
      echo "      然后重启 server（PID=${pid_line}，先确认 /api/queue 无活跃单）触发内置模板重播 seed。"
    fi
  done
  if [ "$stale" = 1 ]; then
    die "存在旧措辞模板落盘副本（见上）。先按指路人肉处置再重跑 night1，否则第一夜副作用账收空且说不清原因。"
  fi

  echo "【3】起单（${#ISSUES[@]} 单）"
  local run_ids=()
  for n in "${ISSUES[@]}"; do
    echo "  派发 Issue #${n} ..."
    local out run_id
    out="$(paneflow dispatch "${TASK}" --repo "${REPO}" --issue "${n}" --space "${SPACE}" --json)" \
      || die "dispatch #${n} 失败（CLI 非零退出）。上行输出/报错即原因。"
    run_id="$(printf '%s' "$out" | parse_run_id)"
    [ -n "$run_id" ] || die "dispatch #${n} 输出解析不到 runId，原文如下：$(printf '\n%s\n' "$out")"
    run_ids+=("${n}:${run_id}")
    echo "  #${n} → runId=${run_id}"
  done

  echo "【4】逐单盯到终态（审批门靠人批，脚本绝不代批）"
  for entry in "${run_ids[@]}"; do
    local n="${entry%%:*}" run_id="${entry#*:}"
    echo "  ── Issue #${n} · run ${run_id} ──"
    while true; do
      local rc=0
      paneflow watch "${run_id}" --timeout "${WATCH_TIMEOUT}" || rc=$?
      case "$rc" in
        0) echo "  #${n} 全绿收口"; break ;;
        1) die "#${n} run ${run_id} 有红（failed/cancelled/completed-with-failures）。paneflow status ${run_id} 看失败节点与 error。" ;;
        2) printf '  #%s watch 超时（%s）未达终态——可能还在跑。回车重进 watch 继续等（Ctrl-C 弃夜）: ' "$n" "$WATCH_TIMEOUT"; read -r _ ;;
        3)
          echo "  #${n} 停在审批门，待批节点："
          paneflow status "${run_id}" --json | jq -r '.awaitingApproval.nodeIds[]' | sed 's/^/    - /' || true
          echo "  请人去看产物后批（脚本绝不自动 approve）：paneflow approve ${run_id} <nodeId>"
          printf '  批完回车重进 watch（Ctrl-C 弃夜）: '; read -r _
          ;;
        *) die "#${n} watch 退出码异常：${rc}" ;;
      esac
    done
  done

  echo "【5】收单存档 → ${LOG_FILE}"
  mkdir -p "${ROOT_DIR}/.tmp"
  {
    echo "=== C4 night1 status 存档 $(date '+%F %T') ==="
    echo "ISSUES=(${ISSUES[*]}) REPO=${REPO} SPACE=${SPACE}"
  } >> "$LOG_FILE"
  for entry in "${run_ids[@]}"; do
    local n="${entry%%:*}" run_id="${entry#*:}"
    echo "--- Issue #${n} · run ${run_id} ---" | tee -a "$LOG_FILE"
    paneflow status "${run_id}" 2>&1 | tee -a "$LOG_FILE"
  done
  echo "  核对三本新账（对每个 run 的 status/runs --json 输出）：harness:{graphSha,agentKind,...} ·"
  echo "  sideEffects:{issuesCreated,issuePatched,prUrl,pushedAt} · attention:{waitMs,gates}"
  echo "  当晚人工后续：网页点赞沉淀绿单（C5）喂语料；明早 paneflow experiments --suite c4 收数。"
  echo "✔ 第一夜序列完成"
}

# ---- collect：只读透传收数表 -----------------------------------------------------
run_collect() {
  command -v paneflow >/dev/null 2>&1 || die "paneflow 不在 PATH（~/.local/bin/paneflow 或 pnpm paneflow）。"
  paneflow experiments --suite c4
}

case "$MODE" in
  dry) run_dry ;;
  night1) run_night1 ;;
  collect) run_collect ;;
  *) die "未知子命令：${MODE}（用法：$0 [dry|night1|collect]，默认 dry）" ;;
esac
