#!/usr/bin/env bash
# PaneFlow 免克隆安装：拉 GitHub Release 的自包含发行包，npm 全局安装出 `paneflow` 命令。
# 前置：Node ≥ 22（含 npm）、macOS/Linux；运行期还需要本机 herdr（见 README）。
set -euo pipefail

REPO="JXzfluser/PaneFlow"
# 默认取 GitHub Releases 的最新包；PF_INSTALL_RAW_BASE 可指到镜像/本地 http 服务，
# 用来在发布前真跑一遍下载 + digest 校验路径（不是给终端用户设的）。
RAW_BASE="${PF_INSTALL_RAW_BASE:-https://github.com/${REPO}/releases/latest/download}"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node ≥ 22（https://nodejs.org）。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "错误：PaneFlow 需要 Node ≥ 22，当前 $(node -v)。" >&2
  exit 1
fi

# v13-E1 修 1/3·herdr 前置检查：PaneFlow 运行期靠 herdr api socket 驱动 Pane，
# 没起 herdr 就是「装完即白装」（socket 路径解析与服务端 config.ts detectSocketPath 同序：
# PF_HERDR_SOCKET > PF_HERDR_SESSION 派生路径 > 默认会话）。
SOCKET="${PF_HERDR_SOCKET:-}"
if [ -z "$SOCKET" ] && [ -n "${PF_HERDR_SESSION:-}" ]; then
  SOCKET="$HOME/.config/herdr/sessions/${PF_HERDR_SESSION}/herdr.sock"
fi
if [ -z "$SOCKET" ]; then
  SOCKET="$HOME/.config/herdr/herdr.sock"
fi
if [ "${PF_INSTALL_SKIP_HERDR_CHECK:-0}" = "1" ]; then
  echo "! 已跳过 herdr 前置检查（PF_INSTALL_SKIP_HERDR_CHECK=1）——起服务后请自行确认 herdr 在跑" >&2
elif [ ! -S "$SOCKET" ]; then
  echo "错误：未找到 herdr api socket：$SOCKET" >&2
  echo "      请先安装并启动 Herdr ≥ 0.8.2（https://github.com/herdrdev/herdr）后重试；" >&2
  echo "      socket 不在默认位置就用 PF_HERDR_SOCKET=<路径> 指过来，" >&2
  echo "      或明确知道自己在做什么时 PF_INSTALL_SKIP_HERDR_CHECK=1 跳过。" >&2
  exit 1
else
  echo "✓ herdr socket 就位：$SOCKET"
fi

# v13-E1 修 2/3·临时目录整体进 trap：旧写法 `TMP="$(mktemp -t paneflow-XXXXXX).tgz"` 只删改名后
# 的 .tgz，mktemp 建出来的那个裸文件永远留在 TMPDIR（异常退出时包体也泄漏）。改成建目录 + 清目录。
WORK_DIR="$(mktemp -d -t paneflow-XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT HUP INT TERM
TGZ="$WORK_DIR/paneflow-latest.tgz"

echo "→ 下载最新发行包（${RAW_BASE}/paneflow-latest.tgz）"
curl -fsSL "$RAW_BASE/paneflow-latest.tgz" -o "$TGZ"
if ! curl -fsSL "$RAW_BASE/paneflow-latest.tgz.sha256" -o "$TGZ.sha256"; then
  echo "错误：取不到校验和 ${RAW_BASE}/paneflow-latest.tgz.sha256——拿不到 digest 就拒绝安装" >&2
  echo "      （该 release 发布时未带 sidecar，或镜像不完整）。" >&2
  exit 1
fi

# v13-E1 修 3/3·digest 校验：npm 全局装进去的字节流必须先证等于发布时那一份
# （校验和 sidecar 由 scripts/build-release.mjs 随包产出、release 工作流入册）。
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TGZ" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TGZ" | awk '{print $1}')"
else
  echo "错误：本机既无 sha256sum 也无 shasum，无法校验发行包 digest，拒绝安装。" >&2
  exit 1
fi
EXPECTED="$(awk 'NR == 1 {print $1}' "$TGZ.sha256" | tr 'A-F' 'a-f')"
if ! printf '%s' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "错误：校验和文件不像 sha256（收到：${EXPECTED:-空}），拒绝安装。" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "错误：发行包 digest 不匹配，拒绝安装。" >&2
  echo "       期望 $EXPECTED" >&2
  echo "       实得 $ACTUAL" >&2
  exit 1
fi
echo "✓ digest 校验通过（sha256 $ACTUAL）"

echo "→ npm 全局安装"
npm install -g "$TGZ"

echo "✓ 完成。启动：paneflow（默认 http://127.0.0.1:4310）"
echo "  提示：若提示找不到命令，把 npm 全局 bin 加入 PATH：export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
