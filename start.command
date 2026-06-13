#!/bin/bash
# 双击启动 A股单板滑雪 demo
# cd 到本脚本所在目录（即项目根），起静态服务器并打开浏览器

cd "$(dirname "$0")" || exit 1

# 先找一个空闲端口（8000 被占就自动 +1），再打印真实地址，避免误导
PORT=8000
while lsof -i :"$PORT" >/dev/null 2>&1; do
  echo "端口 ${PORT} 被占用，换 $((PORT+1))"
  PORT=$((PORT+1))
done
URL="http://localhost:${PORT}/"

echo "🏂 A股单板滑雪 · 启动中…"
echo "项目目录: $(pwd)"
echo "👉 打开地址: ${URL}"
echo "（关闭本窗口或按 Ctrl+C 即可停止服务器）"
echo

# 等服务器起来后再打开浏览器
( sleep 1; open "$URL" ) &

python3 -m http.server "$PORT"
