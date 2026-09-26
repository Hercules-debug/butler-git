#!/usr/bin/env bash
# 为**开发/自测**准备 peer deps 的软链。
#
# 为什么需要:插件的 peerDependencies(@deepseek-ai/dsh-tools 等)
# 在**运行时由 DSH 提供**,不在插件的 node_modules 里。
# 但 `node test/run.mjs` 需要能 import 到它们。
#
# 正式安装时不需要这个脚本 —— 装到 profile 后,DSH 会提供 peer。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/node_modules/@deepseek-ai"

find_tree() {
  if [ -n "${DSH_MODULES:-}" ] && [ -d "$DSH_MODULES/@deepseek-ai" ]; then
    echo "$DSH_MODULES"; return 0
  fi
  for p in "$HOME"/.npm/_npx/*/node_modules; do
    if [ -d "$p/@deepseek-ai/dsh-tools" ]; then echo "$p"; return 0; fi
  done
  return 1
}

if ! TREE="$(find_tree)"; then
  echo "找不到 DSH 的 node_modules。设 DSH_MODULES=<路径> 再跑。" >&2
  exit 1
fi

for pkg in cordis dsh-tools; do
  src="$TREE/@deepseek-ai/$pkg"
  dst="$HERE/node_modules/@deepseek-ai/$pkg"
  if [ -d "$src" ]; then
    rm -rf "$dst"
    ln -s "$src" "$dst"
    echo "  linked @deepseek-ai/$pkg"
  fi
done

echo "ok: $TREE"
