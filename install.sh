#!/usr/bin/env bash
# PaneFlow 免克隆安装：拉 GitHub Release 的自包含发行包，npm 全局安装出 `paneflow` 命令。
# 前置：Node ≥ 22（含 npm）、macOS/Linux；运行期还需要本机 herdr（见 README）。
set -euo pipefail

REPO="JXzfluser/PaneFlow"
RAW_BASE="https://github.com/${REPO}/releases/latest/download"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node ≥ 22（https://nodejs.org）。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "错误：PaneFlow 需要 Node ≥ 22，当前 $(node -v)。" >&2
  exit 1
fi

TMP="$(mktemp -t paneflow-XXXXXX).tgz"
trap 'rm -f "$TMP"' EXIT

echo "→ 下载最新发行包（${RAW_BASE}/paneflow-latest.tgz）"
curl -fsSL "$RAW_BASE/paneflow-latest.tgz" -o "$TMP"

echo "→ npm 全局安装"
npm install -g "$TMP"

echo "✓ 完成。启动：paneflow（默认 http://127.0.0.1:4310）"
echo "  提示：若提示找不到命令，把 npm 全局 bin 加入 PATH：export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
