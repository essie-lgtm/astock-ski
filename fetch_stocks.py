#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_stocks.py —— 用 AKShare 把 A 股日线拉成本游戏前端要读的静态 JSON。

输出：
  data/index.json            首屏卡片
  data/<6位代码>.json        单条赛道

用法：
  python fetch_stocks.py                 # 拉取 STOCKS 里登记的全部
  python fetch_stocks.py --only 300308   # 只拉一只
  python fetch_stocks.py --start 20200101 --end 20240101

仅供娱乐 / not financial advice。
"""

import os
import sys
import json
import time
import argparse
import datetime as dt

try:
    import akshare as ak
except ImportError:
    ak = None

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# ---------------------------------------------------------------------------
# 赛道登记表：code -> 元数据（人设、难度、星级由策划手填）
# board_limit 由代码自动推断（见 infer_board_limit），这里不填。
# ---------------------------------------------------------------------------
# challenge 挑战目标（前端结束页判定是否达成）：
#   type=survive 滑到终点且没被熊吞 / combo 最高连击≥target / flips 空翻≥target / score 得分≥target
def _ch(type_, label, target=None):
    c = {"type": type_, "label": label}
    if target is not None:
        c["target"] = target
    return c

STOCKS = {
    "300308": {
        "name": "中际旭创", "category": "光模块/CPO",
        "personality": "妖股 · 上蹿下跳的过山车", "difficulty": "地狱", "star": 5,
        "challenge": _ch("combo", "连击 x8 不断", 8),
    },
    "688981": {
        "name": "中芯国际", "category": "半导体",
        "personality": "国之重器 · 稳中带刺", "difficulty": "困难", "star": 4,
        "challenge": _ch("score", "得分破 8000", 8000),
    },
    "600519": {
        "name": "贵州茅台", "category": "白酒",
        "personality": "白马 · 缓坡长牛偶尔塌方", "difficulty": "中等", "star": 3,
        "challenge": _ch("flips", "空翻 5 次", 5),
    },
    "601127": {
        "name": "赛力斯", "category": "新能源车",
        "personality": "翻倍妖 · 连板发射器", "difficulty": "地狱", "star": 5,
        "challenge": _ch("flips", "踩发射墙空翻 6 次", 6),
    },
    # —— 下跌趋势 / 套牢名场面（一路俯冲，挑战多为"活着到终点不被熊吞"）——
    "601888": {
        "name": "中国中免", "category": "免税/消费",
        "personality": "白马崩盘 · 从云端套牢", "difficulty": "地狱", "star": 5,
        "challenge": _ch("survive", "活着滑到终点"),
    },
    "000002": {
        "name": "万科A", "category": "房地产",
        "personality": "地产塌方 · 套牢之王", "difficulty": "困难", "star": 4,
        "challenge": _ch("survive", "套牢盘别殉葬，活到终点"),
    },
    "601012": {
        "name": "隆基绿能", "category": "光伏",
        "personality": "光伏茅崩了 · 高位跳水", "difficulty": "困难", "star": 4,
        "challenge": _ch("survive", "躲过雪崩滑到终点"),
    },
    # —— 扩充：热门票库（让"搜索/卡片墙"更丰富）——
    "002594": {
        "name": "比亚迪", "category": "新能源车",
        "personality": "龙头巨震 · 上下都凶", "difficulty": "困难", "star": 4,
        "challenge": _ch("combo", "连击 x6", 6),
    },
    "300750": {
        "name": "宁德时代", "category": "动力电池",
        "personality": "宁王 · 高位大开大合", "difficulty": "困难", "star": 4,
        "challenge": _ch("survive", "高位震荡活下来"),
    },
    "600036": {
        "name": "招商银行", "category": "银行",
        "personality": "白马银行 · 稳坡慢牛", "difficulty": "中等", "star": 3,
        "challenge": _ch("score", "得分破 6000", 6000),
    },
    "000858": {
        "name": "五粮液", "category": "白酒",
        "personality": "酒鬼 · 跟着茅台醉", "difficulty": "中等", "star": 3,
        "challenge": _ch("flips", "空翻 4 次", 4),
    },
    "002230": {
        "name": "科大讯飞", "category": "AI/软件",
        "personality": "AI妖 · 概念过山车", "difficulty": "地狱", "star": 5,
        "challenge": _ch("combo", "概念妖 连击 x8", 8),
    },
    "688256": {
        "name": "寒武纪", "category": "AI芯片",
        "personality": "AI芯片妖王 · 暴涨暴跌", "difficulty": "地狱", "star": 5,
        "challenge": _ch("survive", "妖王过山车 活到终点"),
    },
    "601899": {
        "name": "紫金矿业", "category": "黄金/有色",
        "personality": "资源周期 · 缓坡大牛", "difficulty": "中等", "star": 3,
        "challenge": _ch("combo", "连击 x6", 6),
    },
    "600900": {
        "name": "长江电力", "category": "水电",
        "personality": "电茅 · 极稳缓坡", "difficulty": "新手", "star": 2,
        "challenge": _ch("score", "稳坡刷分 5000", 5000),
    },
}

# 指数登记（board_limit = None，无涨跌停，danger 恒为 0）
INDEXES = {
    "sh000001": {"name": "上证指数", "category": "宽基指数",
                 "personality": "大盘 · 缓坡管够", "difficulty": "新手", "star": 1,
                 "challenge": _ch("score", "大盘缓坡 刷分 4000", 4000)},
}


def infer_board_limit(code: str, name: str):
    """根据代码段 / ST 推断涨跌停幅度（小数）。指数返回 None。"""
    if code.startswith(("sh", "sz", "0000")) and not code.isdigit():
        return None
    if "ST" in name.upper():
        return 0.05
    if code.startswith(("300", "301", "688", "689")):  # 创业板 / 科创板
        return 0.20
    if code.startswith(("8", "4", "920")):             # 北交所
        return 0.30
    return 0.10                                         # 主板


def _exchange_prefix(code: str) -> str:
    if code.startswith(("6", "9")):
        return "sh"
    if code.startswith(("0", "2", "3")):
        return "sz"
    if code.startswith(("4", "8")):
        return "bj"
    return "sh"


def _load_a_hist(code: str, start: str, end: str):
    """日线：优先东方财富(stock_zh_a_hist)，失败回退新浪(stock_zh_a_daily)。
    统一返回带 日期/开盘/最高/最低/收盘 列的 DataFrame。"""
    try:
        return ak.stock_zh_a_hist(symbol=code, period="daily",
                                  start_date=start, end_date=end, adjust="qfq")
    except Exception as e_em:
        print(f"        东财失败({e_em.__class__.__name__})，改用新浪…", flush=True)
        sym = _exchange_prefix(code) + code
        df = ak.stock_zh_a_daily(symbol=sym, adjust="qfq")
        df = df.rename(columns={"date": "日期", "open": "开盘",
                                "high": "最高", "low": "最低", "close": "收盘"})
        df["日期"] = df["日期"].astype(str).str[:10]
        df = df[(df["日期"] >= _fmt(start)) & (df["日期"] <= _fmt(end))]
        return df


def fetch_one(code: str, meta: dict, start: str, end: str):
    if ak is None:
        raise RuntimeError("akshare 未安装，请先 pip install akshare")

    name = meta["name"]
    board_limit = infer_board_limit(code, name)
    is_index = board_limit is None

    if is_index:
        df = ak.stock_zh_index_daily(symbol=code)
        df = df.rename(columns={"date": "日期", "open": "开盘", "close": "收盘",
                                "high": "最高", "low": "最低"})
        df["日期"] = df["日期"].astype(str)
        df = df[(df["日期"] >= _fmt(start)) & (df["日期"] <= _fmt(end))]
    else:
        df = _load_a_hist(code, start, end)

    rows = []
    prev_close = None
    for _, r in df.iterrows():
        date = str(r["日期"])[:10]
        o, h, l, c = float(r["开盘"]), float(r["最高"]), float(r["最低"]), float(r["收盘"])
        if prev_close is None or prev_close == 0:
            pct = 0.0
        else:
            pct = round((c - prev_close) / prev_close * 100, 2)

        limit_flag = 0
        if board_limit is not None and prev_close:
            # 留 0.3% 容错以吸收四舍五入 / 复权误差
            thr = board_limit * 100 - 0.3
            if pct >= thr:
                limit_flag = 1
            elif pct <= -thr:
                limit_flag = -1

        rows.append([date, round(o, 3), round(h, 3), round(l, 3),
                     round(c, 3), pct, limit_flag])
        prev_close = c

    closes = [row[4] for row in rows]
    stats = _compute_stats(rows, closes)

    category, personality, difficulty, star, challenge, featured = resolve_meta(meta, stats)
    payload = {
        "code": code,
        "name": name,
        "category": category,
        "personality": personality,
        "difficulty": difficulty,
        "star": star,
        "challenge": challenge,
        "featured": featured,
        "board_limit": board_limit,
        "start": rows[0][0] if rows else None,
        "end": rows[-1][0] if rows else None,
        "cols": ["date", "o", "h", "l", "c", "pct", "limit_flag"],
        "stats": stats,
        "rows": rows,
    }
    return payload, stats


def _compute_stats(rows, closes):
    if not closes:
        return {"n": 0}
    first, last = closes[0], closes[-1]
    peak = closes[0]
    max_dd = 0.0
    for c in closes:
        if c > peak:
            peak = c
        dd = (c - peak) / peak * 100 if peak else 0.0
        if dd < max_dd:
            max_dd = dd
    limit_up = sum(1 for r in rows if r[6] == 1)
    limit_down = sum(1 for r in rows if r[6] == -1)
    abspct = [abs(r[5]) for r in rows[1:]]
    vol = round(sum(abspct) / len(abspct), 2) if abspct else 0.0   # 日均|涨跌|%（波动率）
    return {
        "n": len(rows),
        "min": min(closes),
        "max": max(closes),
        "first": first,
        "last": last,
        "return_pct": round((last - first) / first * 100, 2) if first else 0.0,
        "max_drawdown_pct": round(max_dd, 2),
        "vol": vol,
        "limit_up": limit_up,
        "limit_down": limit_down,
    }


# ---------------------------------------------------------------------------
# 元数据：精选票手工填；成分股大票库按行情自动推断（人设/难度/星级/挑战）
# ---------------------------------------------------------------------------
def derive_meta(name, category, stats):
    v = stats.get("vol", 1.5)                 # 日均波动%
    dd = stats.get("max_drawdown_pct", 0.0)   # 最大回撤%（≤0）
    ret = stats.get("return_pct", 0.0)        # 区间涨跌%
    # 难度星级：波动 + 回撤越大越难
    if v >= 3.4 or dd <= -55:   star, diff = 5, "地狱"
    elif v >= 2.6 or dd <= -42: star, diff = 4, "困难"
    elif v >= 1.9 or dd <= -28: star, diff = 3, "中等"
    elif v >= 1.4:              star, diff = 2, "进阶"
    else:                       star, diff = 1, "新手"
    # 人设（按形态自动起）
    if ret >= 80 and dd <= -35:        pers = "妖股 · 暴涨暴跌过山车"
    elif dd <= -45 and ret < 0:        pers = "高位崩盘 · 从云端套牢"
    elif ret <= -25:                   pers = "阴跌 · 一路套牢"
    elif ret >= 40:                    pers = "强势 · 陡坡向上"
    elif v >= 3.0:                     pers = "妖 · 上蹿下跳"
    elif abs(ret) < 15 and v < 1.6:    pers = "白马 · 缓坡横盘"
    else:                              pers = "震荡 · 有起有伏"
    # 挑战（按形态自动派）
    if dd <= -38 or ret <= -18:
        ch = {"type": "survive", "label": "活着滑到终点"}
    elif v >= 2.6:
        t = int(min(10, max(5, round(v * 2))))
        ch = {"type": "combo", "label": f"连击 x{t}", "target": t}
    elif ret >= 35:
        ch = {"type": "flips", "label": "踩坡空翻 5 次", "target": 5}
    else:
        ch = {"type": "score", "label": "得分破 6000", "target": 6000}
    return {"personality": pers, "difficulty": diff, "star": star, "challenge": ch}


def resolve_meta(meta, stats):
    """返回最终 (category, personality, difficulty, star, challenge, featured)。
    auto=True 的成分股按行情自动推断；精选票用手填字段。"""
    if meta.get("auto"):
        dm = derive_meta(meta["name"], meta.get("category", ""), stats)
        return (meta.get("category", ""), dm["personality"], dm["difficulty"],
                dm["star"], dm["challenge"], False)
    return (meta["category"], meta["personality"], meta["difficulty"],
            meta["star"], meta.get("challenge"), True)


def _fmt(s: str) -> str:
    """20200101 -> 2020-01-01（指数比较用）。"""
    s = s.replace("-", "")
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def _card(payload, stats):
    return {
        "code": payload["code"], "name": payload["name"], "category": payload["category"],
        "personality": payload["personality"], "difficulty": payload["difficulty"],
        "star": payload["star"], "challenge": payload.get("challenge"),
        "featured": payload.get("featured", False), "stats": stats,
    }


def _card_from_file(path, meta):
    """跳过已存在时：读旧数据文件的 stats，按当前 registry 重算卡片元数据（保证精选/自动状态正确）。"""
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    stats = p.get("stats", {})
    name = meta.get("name") or p.get("name")        # 名单里的名字优先（修正历史占位名）
    cat, pers, diff, star, ch, feat = resolve_meta({**meta, "name": name}, stats)
    return {
        "code": p["code"], "name": name, "category": cat,
        "personality": pers, "difficulty": diff, "star": star, "challenge": ch,
        "featured": feat, "stats": stats,
    }


def build_csi_registry():
    """精选票(featured) + 沪深300 + 中证500 成分股(auto)。精选优先，不被成分股覆盖。"""
    reg = {}
    for code, m in {**STOCKS, **INDEXES}.items():
        reg[code] = dict(m)
    for idx_name, sym in [("沪深300", "000300"), ("中证500", "000905")]:
        try:
            df = ak.index_stock_cons_csindex(symbol=sym)
        except Exception as e:
            print(f"  取 {idx_name} 成分股失败: {e}", file=sys.stderr)
            continue
        for _, r in df.iterrows():
            c = str(r["成分券代码"]).zfill(6)
            if c in reg:
                continue                      # 精选优先
            reg[c] = {"name": str(r["成分券名称"]), "category": idx_name, "auto": True}
    return reg


def _flush_index(index_path, existing):
    feat = sum(1 for c in existing.values() if c.get("featured"))
    write_json(index_path, {
        "meta": {
            "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "disclaimer": "仅供娱乐 / not financial advice",
            "count": len(existing), "featured": feat,
        },
        "stocks": list(existing.values()),
    })


def main():
    ap = argparse.ArgumentParser()
    # 默认拉最近约 18 个月（≈340 交易日），赛道长度刚好；想更长就把 --start 往前调
    _default_start = (dt.date.today() - dt.timedelta(days=550)).strftime("%Y%m%d")
    ap.add_argument("--only", help="只拉单只代码，如 300308")
    ap.add_argument("--csi", action="store_true", help="拉沪深300+中证500大票库（自动元数据）")
    ap.add_argument("--force", action="store_true", help="已存在的数据也重新拉")
    ap.add_argument("--start", default=_default_start)
    ap.add_argument("--end", default=dt.date.today().strftime("%Y%m%d"))
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)

    if args.only:
        base = {**STOCKS, **INDEXES}
        if args.only in base:
            registry = {args.only: base[args.only]}
        else:
            registry = {args.only: {"name": args.only, "category": "未登记", "auto": True}}
    elif args.csi:
        registry = build_csi_registry()
    else:
        registry = {**STOCKS, **INDEXES}

    index_path = os.path.join(DATA_DIR, "index.json")
    existing = {}
    if os.path.exists(index_path):
        try:
            with open(index_path, encoding="utf-8") as f:
                for c in json.load(f).get("stocks", []):
                    existing[c["code"]] = c
        except Exception:
            pass

    total = len(registry)
    fetched = skipped = failed = 0
    for i, (code, meta) in enumerate(registry.items(), 1):
        jpath = os.path.join(DATA_DIR, f"{code}.json")
        try:
            if (not args.force) and os.path.exists(jpath):
                existing[code] = _card_from_file(jpath, meta)     # 跳过：用旧 stats 重算卡片
                skipped += 1
            else:
                payload = stats = None
                for attempt in range(2):                          # 失败重试一次
                    try:
                        payload, stats = fetch_one(code, meta, args.start, args.end)
                        break
                    except Exception:
                        if attempt == 0:
                            time.sleep(1.2)
                        else:
                            raise
                write_json(jpath, payload)
                existing[code] = _card(payload, stats)
                fetched += 1
                print(f"[{i}/{total}] {code} {payload['name']}  n={stats['n']} ★{payload['star']} "
                      f"{payload['difficulty']} | {payload['personality']}", flush=True)
                time.sleep(0.25)                                  # 轻微限速，别把新浪打挂
        except Exception as e:
            failed += 1
            print(f"[{i}/{total}] FAIL {code}: {e}", file=sys.stderr, flush=True)
        if i % 25 == 0:
            _flush_index(index_path, existing)                    # 增量保存，中断也不白干
            print(f"  …进度 {i}/{total}  新拉{fetched} 跳过{skipped} 失败{failed}  index已保存", flush=True)

    _flush_index(index_path, existing)
    feat = sum(1 for c in existing.values() if c.get("featured"))
    print(f"[done] index.json 现有 {len(existing)} 张卡片（精选 {feat}）"
          f"  本次新拉{fetched} 跳过{skipped} 失败{failed}")


if __name__ == "__main__":
    main()
