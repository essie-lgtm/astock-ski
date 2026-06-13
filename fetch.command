#!/bin/bash
# 双击：联网拉最新 A股行情，生成/覆盖 data/<代码>.json
# 跟 start.command 分开：这个只拉数据，start.command 只开游戏

cd "$(dirname "$0")" || exit 1

echo "🏂 A股单板滑雪 · 拉数据"
echo "项目目录: $(pwd)"
echo

# 让你输入代码，直接回车=默认 300308（中际旭创）
read -r -p "输入6位股票代码（回车=300308）: " CODE
CODE="${CODE:-300308}"

echo
echo "正在拉取 ${CODE} 的最近约18个月行情…（联网，稍等）"
echo

# 首次若没装 akshare，自动装一下
python3 -c "import akshare" 2>/dev/null || {
  echo "首次运行，安装 akshare 中…"
  python3 -m pip install --user --quiet akshare
}

python3 fetch_stocks.py --only "$CODE"
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "✅ 完成。data/${CODE}.json 已更新，刷新浏览器或重开 start.command 即可。"
else
  echo "⚠️ 拉取失败（多半是行情服务器临时限流）。过一会儿再双击重试即可。"
fi
echo
echo "（关闭本窗口结束）"
read -r -p "按回车关闭…" _
