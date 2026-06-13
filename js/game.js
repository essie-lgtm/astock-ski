/* =====================================================================
 * game.js —— A股单板滑雪
 * 读 data/<code>.json → 生成地形 → 单板能滑/跳/特技/摔/计分
 * 含：大事件渲染(涨停发射墙/跌停悬崖) · 跳水段(连续阴跌陡化) · 熊市雪崩追杀
 * 仅供娱乐 / not financial advice
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.CONFIG;

  // ---- 画布 / DPI ----
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- HUD 元素 ----
  var hud = {
    date:  document.getElementById('hud-date'),
    price: document.getElementById('hud-price'),
    pct:   document.getElementById('hud-pct'),
    pos:   document.getElementById('hud-pos'),
    speed: document.getElementById('hud-speed'),
    score: document.getElementById('hud-score'),
    combo: document.getElementById('hud-combo'),
    flips: document.getElementById('hud-flips'),
    progress: document.getElementById('hud-progress'),
    name:  document.getElementById('hud-name'),
    peak:  document.getElementById('hud-peak'),
    toast: document.getElementById('toast'),
  };

  // =====================================================================
  // 地形：把收盘价曲线变成赛道
  // =====================================================================
  var Track = {
    data: null, rows: null,
    dayCount: 0,                 // 交易日数
    xs: null, ys: null,          // 平滑重采样后的稠密地形顶点
    n: 0, step: 0,               // 稠密点数 / 稠密点间距(px)
    priceMin: 0, priceMax: 0,
    minY: 0, maxY: 0,            // 世界纵向范围（用于渲染天空/填充）
    length: 0,                   // 赛道总长(px)
  };

  // 普通日做三角权重均线压日间抖动；大事件日(涨跌停/大波动)保留原值=保住陡墙
  function smoothCloses(closes, big, win) {
    var out = new Array(closes.length);
    for (var i = 0; i < closes.length; i++) {
      if (big[i]) { out[i] = closes[i]; continue; }
      var sum = 0, wsum = 0;
      for (var k = -win; k <= win; k++) {
        var j = i + k;
        if (j < 0 || j >= closes.length) continue;
        if (big[j] && k !== 0) continue;            // 不让大事件污染普通日均线，保住陡墙
        var w = win + 1 - Math.abs(k);              // 三角权重
        sum += closes[j] * w; wsum += w;
      }
      out[i] = wsum ? sum / wsum : closes[i];
    }
    return out;
  }

  // 单调三次(Fritsch–Carlson)切线：保证不过冲，不会凭空造出假坑/假包
  function monotoneTangents(ys, h) {
    var n = ys.length, d = new Array(n - 1), m = new Array(n);
    for (var i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / h;
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (var k = 1; k < n - 1; k++) m[k] = (d[k - 1] + d[k]) / 2;
    for (var s = 0; s < n - 1; s++) {
      if (d[s] === 0) { m[s] = 0; m[s + 1] = 0; continue; }
      var a = m[s] / d[s], b = m[s + 1] / d[s];
      if (a < 0) { m[s] = 0; a = 0; }
      if (b < 0) { m[s + 1] = 0; b = 0; }
      var q = a * a + b * b;
      if (q > 9) { var tt = 3 / Math.sqrt(q); m[s] = tt * a * d[s]; m[s + 1] = tt * b * d[s]; }
    }
    return m;
  }

  function buildTrack(data) {
    Track.data = data;
    Track.rows = data.rows;
    var n = data.rows.length;
    Track.dayCount = n;

    var closes = [], big = [];
    var board = (data.board_limit && data.board_limit > 0) ? data.board_limit * 100 : 10;
    Track.evType = new Int8Array(n);    // +1 涨事件 / -1 跌事件 / 0 无
    Track.evRel = new Float32Array(n);  // 幅度强度（|pct|/板幅，封顶）
    Track.evLimit = new Uint8Array(n);  // 是否涨跌停
    for (var i = 0; i < n; i++) {
      closes.push(data.rows[i][4]);
      var pct = data.rows[i][5], flag = data.rows[i][6];
      var isBig = flag !== 0 || Math.abs(pct) >= C.BIG_EVENT_PCT;
      big.push(isBig);
      if (isBig) {
        Track.evType[i] = pct >= 0 ? 1 : -1;
        Track.evRel[i] = Math.min(C.BIG_EVENT_REL_CAP, Math.abs(pct) / board);
        Track.evLimit[i] = flag !== 0 ? 1 : 0;
      }
    }
    Track.priceMin = Math.min.apply(null, closes);
    Track.priceMax = Math.max.apply(null, closes);

    // A) 跳水段识别：从近峰深度回撤(≥DIVE_DD_PCT)且最近 DIVE_FALL_WIN 日仍在走低 的连续阴跌区。
    //    把"千刀万剐"式的白马崩盘(无数小阴跌、单日都不达大事件)圈成一片，后面对它局部陡化+染色。
    Track.evDive = new Uint8Array(n);
    var peak = closes[0];
    for (var dvi = 0; dvi < n; dvi++) {
      if (closes[dvi] > peak) peak = closes[dvi];
      var dd = closes[dvi] / peak - 1;
      var pj = Math.max(0, dvi - C.DIVE_FALL_WIN);
      if (dd <= -C.DIVE_DD_PCT / 100 && closes[dvi] < closes[pj]) Track.evDive[dvi] = 1;
    }

    // 1) 取对数价格：让“涨跌%”在任何价位都看得见（低价区那段长长的"假平地"会变成有起伏的缓坡）
    var lg = new Array(n);
    for (var c = 0; c < n; c++) lg[c] = Math.log(Math.max(0.01, closes[c]));

    // 2) 普通日均线平滑（大事件保留原值，不被抹平）
    var sl = C.TERRAIN_SMOOTH_WINDOW > 0 ? smoothCloses(lg, big, C.TERRAIN_SMOOTH_WINDOW) : lg;

    // 3) 大事件纵向夸张 = 放大当天真实涨跌落差，并【持续累积保留】：
    //    涨上去就一直待在高处（不再是对称小包滑回来假装没涨），只有遇到真·下跌日才下坡 → 解决“没有跌幅”的问题
    var tv = new Array(n); tv[0] = sl[0];
    for (var k = 1; k < n; k++) {
      var d = sl[k] - sl[k - 1];
      if (big[k]) d *= C.BIG_EVENT_GAIN;                       // 单日大事件：放大当天落差，且持续
      else if (Track.evDive[k] && d < 0) d *= C.DIVE_GAIN;     // A) 跳水段的下跌日：把缓阴跌坡陡化成可俯冲的长崖（不与大事件叠加）
      tv[k] = tv[k - 1] + d;
    }

    // 3.5) 去趋势：扣掉整体涨/跌的大斜坡，让赛道在水平线附近起伏（показ波动，而不是一路爬坡）
    //      —— 妖股 +516% 否则就是一条没完没了的上坡；去趋势后变成有起有伏、能冲能跳的雪道。
    //      整体盈亏仍在 HUD 显示。DETREND_STRENGTH: 1=完全拉平 / <1 保留些净坡 / >1 反向(净下坡).
    var trend = (tv[n - 1] - tv[0]) / Math.max(1, n - 1);
    // C) 非对称去趋势：净下跌票(trend<0)只少量去趋势，保住"一路俯冲"的套牢长坡；净上涨妖股仍照常去趋势，免得无尽爬坡
    var ds = trend < 0 ? C.DETREND_DOWN_STRENGTH : C.DETREND_STRENGTH;
    for (var dt2 = 0; dt2 < n; dt2++) tv[dt2] -= trend * dt2 * ds;

    // 4) 对数单位 → 世界 y（越高 y 越小）
    var tvMin = Math.min.apply(null, tv), scale = C.LOG_TO_PX * C.TERRAIN_AMP;
    var yc = new Array(n);
    for (var q = 0; q < n; q++) yc[q] = -(tv[q] - tvMin) * scale;

    // 5) 日线 OHLC：每天不再是收盘一个点，而是把当天的「高点/低点」也变成地形起伏。
    //    在每一天的格子内放 3 个控制点：先探一侧影线、再探另一侧、最后落到收盘(锚点 x=d*W)。
    //    阳线(收≥开)走「低→高」、阴线走「高→低」，模拟当日真实上下影。OHLC_AMP 控制影线起伏的夸张程度。
    var h = C.SEGMENT_WIDTH, h3 = h / 3;
    var oa = (C.OHLC_AMP != null ? C.OHLC_AMP : 1);
    var hiY = new Array(n), loY = new Array(n);
    for (var w = 0; w < n; w++) {
      var cl = closes[w], hg = data.rows[w][2], lw = data.rows[w][3];
      // 当日高/低相对收盘的对数偏移 → 世界 y（高点更小=更高，低点更大=更低）
      hiY[w] = yc[w] - (Math.log(Math.max(0.01, hg)) - Math.log(Math.max(0.01, cl))) * scale * oa;
      loY[w] = yc[w] - (Math.log(Math.max(0.01, lw)) - Math.log(Math.max(0.01, cl))) * scale * oa;
    }
    // 控制折线（均匀间距 h3=h/3，收盘点恰好落在 x=d*h）
    var cxs = [0], cys = [yc[0]];
    for (var d = 1; d < n; d++) {
      var up = closes[d] >= data.rows[d][1];        // 收≥开=阳线
      var bx = (d - 1) * h;
      cxs.push(bx + h3);     cys.push(up ? loY[d] : hiY[d]);  // 阳线先探低
      cxs.push(bx + 2 * h3); cys.push(up ? hiY[d] : loY[d]);  // 再冲高
      cxs.push(bx + h);      cys.push(yc[d]);                 // 收盘锚点
    }
    var sub = Math.max(1, C.TERRAIN_SUBSTEPS | 0);
    Track.sub = sub;
    Track.ptsPerDay = 3 * sub;       // 每天 3 个控制段 × sub → 稠密点；第 d 天收盘 = 稠密点 d*ptsPerDay
    Track.step = h3 / sub;
    var cm = monotoneTangents(cys, h3);
    var xs = [], ys = [];
    for (var seg = 0; seg < cys.length - 1; seg++) {
      for (var k2 = 0; k2 < sub; k2++) {
        var t = k2 / sub, t2 = t * t, t3 = t2 * t;
        var h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
        var h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        var y = h00 * cys[seg] + h10 * h3 * cm[seg] + h01 * cys[seg + 1] + h11 * h3 * cm[seg + 1];
        xs.push(cxs[seg] + t * h3); ys.push(y);
      }
    }
    xs.push(cxs[cys.length - 1]); ys.push(cys[cys.length - 1]);   // 末点 = 末日收盘

    Track.xs = Float64Array.from(xs);
    Track.ys = Float64Array.from(ys);
    Track.n = Track.xs.length;
    Track.length = Track.xs[Track.n - 1];
    Track.minY = Math.min.apply(null, ys);
    Track.maxY = Math.max.apply(null, ys);

    // 收盘线的逐日世界 y（不含 OHLC 影线）→ 测速/起跳用的"宏观坡度"，避免影线把速度泵飞、把空格起跳吃掉
    Track.closeY = Float64Array.from(yc);
    // 运行最高点：地形最高处(peakY=最小y) 与 最高收盘价(peakPrice) → 水位线 + "距高点 -X%"
    Track.peakY = new Float64Array(n);
    Track.peakPrice = new Float64Array(n);
    var pkY = yc[0], pkP = closes[0];
    for (var pi = 0; pi < n; pi++) {
      if (yc[pi] < pkY) pkY = yc[pi];
      if (closes[pi] > pkP) pkP = closes[pi];
      Track.peakY[pi] = pkY; Track.peakPrice[pi] = pkP;
    }
  }

  // 给定世界 x，返回地面 y（稠密点线性插值=已是平滑曲线）
  function groundY(x) {
    var st = Track.step;
    if (x <= 0) return Track.ys[0];
    if (x >= Track.length) return Track.ys[Track.n - 1];
    var i = Math.floor(x / st);
    if (i >= Track.n - 1) return Track.ys[Track.n - 1];
    var t = (x - i * st) / st;
    return Track.ys[i] * (1 - t) + Track.ys[i + 1] * t;
  }
  // 坡度角（弧度），下坡(屏幕y增大)为正
  function slopeAt(x) {
    var d = Track.step;
    return Math.atan2(groundY(x + d) - groundY(x - d), 2 * d);
  }
  // 凸度 dθ/dx：>0=凸起山顶(可能起跳)，<0=凹谷(永不起跳)
  function convexity(x) {
    var d = Track.step * 2;
    return (slopeAt(x + d) - slopeAt(x - d)) / (2 * d);
  }
  // 宏观坡度/凸度：只看收盘线(逐日)，不含 OHLC 影线。用于测速与起跳判定——
  // 这样日内影线只负责"视觉起伏"，不会把速度泵飞，也不会在影线小凸起处误判离地把空格起跳吃掉。
  function macroSlopeAt(x) {
    var Wd = C.SEGMENT_WIDTH, i = Math.floor(x / Wd);
    if (i < 0) i = 0; if (i > Track.dayCount - 2) i = Track.dayCount - 2;
    return Math.atan2(Track.closeY[i + 1] - Track.closeY[i], Wd);
  }
  function macroConvexityAt(x) {
    var Wd = C.SEGMENT_WIDTH;
    return (macroSlopeAt(x + Wd) - macroSlopeAt(x - Wd)) / (2 * Wd);
  }
  // 起跳判定（贴地的关键）：必须是“够陡的凸起跳台(真·陡崖/发射墙)”+ 速度够快才离地；
  // 用宏观凸度，小起伏(含日内影线)无论多快都贴地滑过，不弹。
  function shouldLaunch(x, speed, slope) {
    var dth = macroConvexityAt(x);
    if (dth < C.LAUNCH_CONVEXITY_MIN) return false;   // 凹谷/缓坡小包 → 贴地滑过
    var kappa = Math.cos(slope) * dth;                // 路径曲率
    var gN = C.GRAVITY * Math.cos(slope);             // 重力法向分量
    return speed * speed * kappa > gN * C.LAUNCH_SENSITIVITY;
  }
  // 世界 x → 交易日索引
  function indexAt(x) {
    var i = Math.floor(x / C.SEGMENT_WIDTH);
    return Math.max(0, Math.min(Track.dayCount - 1, i));
  }

  // =====================================================================
  // 骑手
  // =====================================================================
  var rider = {
    x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, angVel: 0,
    grounded: true,
    crashTimer: 0,
    // 滞空 / 特技
    airTime: 0, takeoffAngle: 0, spinAccum: 0,
  };

  var game = {
    started: false, over: false,
    score: 0, combo: 0, flips: 0,
    bestCombo: 0,
    camX: 0, camY: 0, camZoom: 1,   // camX/camY=相机聚焦点(世界坐标)，camZoom=缩放
    holding: false,
    time: 0,
    lastDay: -1,                    // 上一帧所在交易日（用于触发大事件反馈）
    punch: 0, shake: 0,             // 镜头猛推 / 抖动（衰减）
    flashA: 0, flashColor: '255,255,255', // 闪色
    slowmoT: 0,                     // 微慢动作剩余时间(真实秒)
  };

  // 熊市雪崩（自成模块：只读 rider.x / 当天pct / groundY，跑自己的 update+draw+被抓判定）
  var avalanche = { on: true, x: 0, danger: 0, caughtFrames: 0, caught: false };

  function resetAvalanche() {
    avalanche.x = -C.AVALANCHE_START_BACK;
    avalanche.danger = 0;
    avalanche.caughtFrames = 0;
    avalanche.caught = false;
  }

  function resetRider() {
    rider.x = 0;
    rider.y = groundY(0);
    var s0 = slopeAt(0);
    rider.vx = C.START_SPEED * Math.cos(s0);
    rider.vy = C.START_SPEED * Math.sin(s0);
    rider.angle = s0; rider.angVel = 0;
    rider.grounded = true; rider.crashTimer = 0;
    rider.airTime = 0; rider.spinAccum = 0;
    game.score = 0; game.combo = 0; game.flips = 0; game.bestCombo = 0;
    game.over = false;
    game.camX = rider.x; game.camY = rider.y; game.camZoom = 1;
    game.lastDay = -1; game.punch = 0; game.shake = 0; game.flashA = 0; game.slowmoT = 0;
    toastQueue.length = 0; toastTimer = 0; hud.toast.className = '';
    resetAvalanche();
  }

  // ---- 角度工具 ----
  function angDiff(a, b) {
    var d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function lerpAngle(a, b, t) { return a + angDiff(b, a) * t; }

  // ---- toast 提示（屏幕固定 + 排队，滑多快都停够时间读清；多条事件逐条显示，不互相覆盖）----
  var toastTimer = 0, toastQueue = [];
  function toast(msg, cls) {
    var last = toastQueue[toastQueue.length - 1];
    if (last && last.msg === msg) return;             // 去重相邻重复
    toastQueue.push({ msg: msg, cls: cls });
    if (toastQueue.length > 3) toastQueue.shift();    // 最多排 3 条，防刷屏
    if (toastTimer <= 0) nextToast();
  }
  function nextToast() {
    var t = toastQueue.shift();
    if (!t) { hud.toast.className = ''; toastTimer = 0; return; }
    hud.toast.textContent = t.msg;
    hud.toast.className = 'show ' + (t.cls || '');
    toastTimer = C.TOAST_DURATION || 2.0;
  }

  // =====================================================================
  // 物理更新
  // =====================================================================
  function update(dt) {
    if (!game.started || game.over) return;
    game.time += dt;

    // 终点判定
    if (rider.x >= Track.length) { finish(); return; }

    if (rider.crashTimer > 0)      updateCrash(dt);   // 摔倒翻滚中
    else if (rider.grounded)       updateGround(dt);  // 贴地滑行
    else                           updateAir(dt);     // 腾空

    // 计分（按水平推进距离）
    if (rider.crashTimer <= 0 && rider.vx > 0) {
      game.score += rider.vx * dt * C.SCORE_PER_PX;
    }
    // 熊市雪崩追杀
    updateAvalanche(dt);
    if (game.over) return;

    // 相机：聚焦点 = 骑手 + 前瞻（速度越高看得越远）；速度越高镜头越拉远
    var spd = Math.hypot(rider.vx, rider.vy);
    var fx = rider.x + spd * C.CAM_LOOKAHEAD;
    game.camX += (fx - game.camX) * C.CAM_LERP;
    game.camY += (rider.y - game.camY) * C.CAM_LERP;
    var sf = Math.max(0, Math.min(1, (spd - C.CRUISE_SPEED) / (C.MAX_SPEED - C.CRUISE_SPEED)));
    var zt = 1 - sf * (1 - C.CAM_MIN_ZOOM);
    game.camZoom += (zt - game.camZoom) * C.CAM_LERP;

    // 经过大事件 → 镜头猛推 + 抖动 + 闪色，让你“感觉到”大起大落
    var day = indexAt(rider.x);
    if (day !== game.lastDay) {
      game.lastDay = day;
      if (Track.evType[day] && rider.crashTimer <= 0 && Math.abs(Track.rows[day][5]) >= C.FEEDBACK_PCT) {
        var rel = Track.evRel[day];
        game.punch = C.FEEDBACK_PUNCH * rel;
        game.shake = C.FEEDBACK_SHAKE * rel;
        game.flashA = C.FEEDBACK_FLASH * Math.min(1, rel);
        game.flashColor = Track.evType[day] > 0 ? '255,207,58' : '51,224,138';
        toast((Track.evType[day] > 0 ? '🚀 ' : '📉 ') +
              Track.rows[day][0] + '　' + (Track.rows[day][5] > 0 ? '+' : '') + Track.rows[day][5] + '%' +
              (Track.evLimit[day] ? (Track.evType[day] > 0 ? ' 涨停发射！' : ' 跌停悬崖！') : ''),
              Track.evType[day] > 0 ? 'good' : 'bad');
        // 路过涨停/跌停 → 微慢动作，看清字 + 高光戏剧性
        if (Track.evLimit[day]) game.slowmoT = C.HITSTOP_DUR;
      }
    }
    var dk = Math.max(0, 1 - C.FEEDBACK_DECAY * dt);
    game.punch *= dk; game.shake *= dk; game.flashA *= dk;

    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) nextToast(); }
  }

  // ---------- 贴地滑行 ----------
  // 顺着地形轮廓走：自动前进 + 上坡不卡死；小起伏不弹起，只有够陡够快才离地
  function updateGround(dt) {
    var mslope = macroSlopeAt(rider.x);               // 测速用宏观坡度(收盘线，不含影线)
    var speed = Math.hypot(rider.vx, rider.vy);
    // 自限速：引擎(维持巡航) + 沿坡重力(坡度增速) − 二次阻力(随速度增大→终端速度)
    var thrust = C.DRAG_QUAD * C.CRUISE_SPEED * C.CRUISE_SPEED;  // 使平地终端速度==巡航速度
    var aGrav = C.GRAVITY * Math.sin(mslope) * C.SLOPE_ACCEL_K;  // 下坡+ / 上坡−（宏观坡度，影线不泵速）
    var aDrag = C.DRAG_QUAD * speed * speed;                     // 速度越大阻力越大
    speed += (thrust + aGrav - aDrag) * dt;
    speed = Math.max(C.MIN_SPEED, Math.min(C.MAX_SPEED, speed)); // 硬上限

    rider.x += speed * Math.cos(mslope) * dt;         // 沿宏观坡前进
    var nm = macroSlopeAt(rider.x);

    if (shouldLaunch(rider.x, speed, nm)) {
      // 冲上够陡的跳台/陡崖(真·发射墙) → 自然离地
      rider.grounded = false;
      rider.vx = speed * Math.cos(nm);
      rider.vy = speed * Math.sin(nm);
      rider.takeoffAngle = rider.angle;
      rider.spinAccum = 0;
      rider.airTime = 0;
    } else {
      // 贴地：吸附到 OHLC 细节地形轮廓(视觉起伏)，板面顺细节坡
      rider.y = groundY(rider.x);
      var vslope = slopeAt(rider.x);                  // 板面角度用细节坡度，贴坡好看
      rider.vx = speed * Math.cos(nm);
      rider.vy = speed * Math.sin(nm);
      rider.angle = lerpAngle(rider.angle, vslope, Math.min(1, C.GROUND_ANGLE_EASE * dt));
      rider.airTime = 0;
    }
  }

  // ---------- 腾空 ----------
  function updateAir(dt) {
    rider.vy += C.GRAVITY * dt;
    // 腾空也守住硬上限：整体速度超过 maxSpeed 就等比缩回，防止砸落时冲飞失控
    var asp = Math.hypot(rider.vx, rider.vy);
    if (asp > C.MAX_SPEED) {
      var sc = C.MAX_SPEED / asp;
      rider.vx *= sc; rider.vy *= sc;
    }
    rider.x += rider.vx * dt;
    rider.y += rider.vy * dt;
    rider.airTime += dt;

    if (game.holding) {
      // 空中按住 = 后空翻（持续向后翻）
      var dang = C.AIR_SPIN_SPEED * C.AIR_SPIN_DIR * dt;
      rider.angle += dang;
      rider.spinAccum += dang;
    } else {
      // 松手 = 停止旋转、自然平衡回正，准备落地
      var look = slopeAt(rider.x + Math.max(40, rider.vx * 0.15));
      rider.angle = lerpAngle(rider.angle, look, Math.min(1, C.AIR_BALANCE_EASE * dt));
    }

    // 落地判定
    var gy = groundY(rider.x);
    if (rider.y >= gy) {
      rider.y = gy;
      var slope = slopeAt(rider.x);
      handleLanding(slope);                           // 干净落地 or 摔倒
      if (rider.crashTimer <= 0) {                    // 干净落地 → 转回贴地滑行
        var sp = Math.hypot(rider.vx, rider.vy);
        rider.vx = Math.cos(slope) * sp;
        rider.vy = Math.sin(slope) * sp;
        rider.grounded = true;
      }
    }
  }

  // ---------- 摔倒翻滚 ----------
  // 强制贴地 + 掉速到爬行，约 CRASH_DURATION 秒后自动爬起继续滑，不依赖按键、不结束游戏
  function updateCrash(dt) {
    rider.crashTimer -= dt;
    rider.angle += rider.angVel * dt;
    var slope = slopeAt(rider.x);
    var spc = Math.hypot(rider.vx, rider.vy);
    spc += (C.CRASH_CRAWL_SPEED - spc) * Math.min(1, C.CRASH_DRAG * dt);
    spc = Math.max(C.CRASH_CRAWL_SPEED, spc);
    rider.x += spc * Math.cos(slope) * dt;
    var ns = slopeAt(rider.x);
    rider.y = groundY(rider.x);
    rider.vx = Math.cos(ns) * spc;
    rider.vy = Math.sin(ns) * spc;
    rider.grounded = true;
    if (rider.crashTimer <= 0) {                      // 自动爬起
      rider.crashTimer = 0;
      rider.angVel = 0;
      rider.angle = ns;
    }
  }

  function handleLanding(slope) {
    var spin = Math.abs(rider.spinAccum);
    var flips = Math.floor(spin / (Math.PI * 2));
    var diff = Math.abs(angDiff(rider.angle, slope)) * 180 / Math.PI;
    var bigAir = rider.airTime >= C.COMBO_AIRTIME;
    // 没在做特技(几乎没转)的腾空/小跳 → 永远干净落地：地形颠簸绝不害你摔
    var trickAttempt = spin >= C.NO_TRICK_SPIN;

    if (!trickAttempt || diff <= C.LAND_TOLERANCE_DEG) {
      // 干净落地
      if (flips > 0) {
        game.flips += flips;
        game.score += flips * C.SCORE_PER_FLIP * (1 + game.combo * 0.15);
      }
      if (flips > 0 || (bigAir && trickAttempt)) {
        game.combo += 1 + flips;
        game.bestCombo = Math.max(game.bestCombo, game.combo);
        game.score += C.SCORE_CLEAN_LAND * game.combo;
        var msg = flips > 0 ? (flips + ' 圈空翻 · 连击 x' + game.combo) : ('稳！连击 x' + game.combo);
        toast(msg, 'good');
      }
      rider.angle = slope;
    } else {
      // 摔倒（只有真的在转又没摆正落地才摔）
      crash(slope, flips);
    }
  }

  function crash(slope, flips) {
    // 约 0.8~1.2 秒翻滚，到点自动爬起（见 update 摔倒分支），不会无限翻、不会 game over
    rider.crashTimer = C.CRASH_DURATION * (0.85 + Math.random() * 0.35);
    var sp = Math.hypot(rider.vx, rider.vy) * C.CRASH_SPEED_KEEP;
    rider.vx = Math.cos(slope) * sp;
    rider.vy = Math.sin(slope) * sp;
    rider.angVel = (rider.spinAccum >= 0 ? 1 : -1) * 8;
    var lost = game.combo;
    game.combo = 0;
    var quips = ['一字千金跌停板把你拍飞', '套牢盘踏空，摔！', '稳健型选手当场表演劈叉', '又是被市场教育的一天'];
    toast(quips[flips % quips.length] + (lost > 1 ? '（断了 x' + lost + ' 连击）' : ''), 'bad');
  }

  // ---------- 熊市雪崩追杀 ----------
  function updateAvalanche(dt) {
    if (!avalanche.on) return;
    // danger = 相对板幅的跌幅，最近 N 根K线平滑；指数(board=null)恒为 0
    var board = Track.data.board_limit, d = 0;
    if (board && board > 0) {
      var day = indexAt(rider.x), n = Math.max(1, C.DANGER_SMOOTH_WINDOW | 0), sum = 0, cnt = 0;
      for (var i = day - n + 1; i <= day; i++) {
        if (i < 0) continue;
        sum += Math.max(0, Math.min(1, -Track.rows[i][5] / (board * 100)));
        cnt++;
      }
      d = cnt ? sum / cnt : 0;
    }
    avalanche.danger = d;
    // 1) 基础前压（相对巡航）：决定你停下/摔倒时多快被吞
    var spd = (C.AVALANCHE_BASE_FRAC + C.AVALANCHE_SURGE_FRAC * d) * C.CRUISE_SPEED;
    avalanche.x += spd * dt;
    // 2) 牵引绳：danger 越高允许落后越小 → 下跌日把熊拽进视野，上涨/普通日放绳甩开
    var maxGap = C.AVALANCHE_FAR_GAP + (C.AVALANCHE_NEAR_GAP - C.AVALANCHE_FAR_GAP) * Math.pow(d, C.DANGER_GAP_CURVE);
    if (rider.x - avalanche.x > maxGap) {
      avalanche.x += (rider.x - maxGap - avalanche.x) * Math.min(1, C.AVALANCHE_LEASH_RATE * dt);
    }
    // 3) 被抓判定（容错帧）
    if (avalanche.x >= rider.x - C.AVALANCHE_CATCH_MARGIN) {
      avalanche.caughtFrames++;
      if (avalanche.caughtFrames >= C.CAUGHT_GRACE_FRAMES) caught();
    } else if (avalanche.caughtFrames > 0) {
      avalanche.caughtFrames--;                        // 逃开了，容错回血
    }
  }

  function caught() {
    if (game.over) return;
    avalanche.caught = true;
    var pnl = (Track.rows[indexAt(rider.x)][4] / Track.rows[0][4] - 1) * 100;
    showEndOverlay('🐻 被熊市雪崩吞了！到 ' + (rider.x / Track.length * 100).toFixed(0) + '%　' +
      (pnl < 0 ? '浮亏 ' + pnl.toFixed(0) + '%，套牢盘殉葬' : '居然浮盈也没能跑掉'), 'bad', false);
  }

  // 判定本关挑战是否达成（所有挑战都要求"滑到终点"，被熊吞=失败）
  function evalChallenge(reachedFinish) {
    var ch = Track.data && Track.data.challenge;
    if (!ch) return null;
    var met = false, detail = '';
    if (ch.type === 'combo')      { met = game.bestCombo >= ch.target; detail = '最高连击 x' + game.bestCombo; }
    else if (ch.type === 'flips') { met = game.flips >= ch.target;     detail = '空翻 ' + game.flips + ' 次'; }
    else if (ch.type === 'score') { met = Math.floor(game.score) >= ch.target; detail = '得分 ' + Math.floor(game.score); }
    else                          { met = true; }                       // survive：到终点即达成
    return { ok: reachedFinish && met, label: ch.label, detail: detail };
  }
  // 挑战栏：开始页显示目标(result=null)，结束页显示达成/失败
  function updateChallengeBox(result) {
    var el = document.getElementById('challenge-result');
    var ch = Track.data && Track.data.challenge;
    if (!el) return;
    if (!ch) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (!result) { el.className = 'ch-goal'; el.textContent = '🔥 本关挑战 · ' + ch.label; return; }
    if (result.ok) { el.className = 'ch-win'; el.textContent = '🏆 挑战达成 · ' + ch.label; }
    else { el.className = 'ch-lose'; el.textContent = '✗ 挑战失败 · ' + ch.label + (result.detail ? '（' + result.detail + '）' : ''); }
  }

  function showEndOverlay(msg, cls, reachedFinish) {
    game.over = true;
    toastQueue.length = 0; toastTimer = 0;       // 结束语优先，不排在事件提示后面
    toast(msg, cls || 'finish');
    document.querySelector('.cta').style.display = 'none';
    document.getElementById('control-hint').classList.remove('show');
    document.getElementById('btn-restart').style.display = 'inline-block';
    document.getElementById('overlay').classList.remove('hidden');
    drawSummaryCandle();                  // 结尾汇总：把整段行情画成一根 K 线
    updateChallengeBox(evalChallenge(!!reachedFinish));   // 挑战达成判定
  }

  // 结尾汇总 K 线：用区间 峰/谷/开/收 画一根大蜡烛 + 总涨跌/最大回撤，一眼读懂这票的命运
  function drawSummaryCandle() {
    var cv = document.getElementById('summary-candle'); if (!cv) return;
    var st = Track.data.stats; if (!st) return;
    cv.style.display = 'block';
    var g = cv.getContext('2d'), Wc = cv.width, Hc = cv.height;
    g.clearRect(0, 0, Wc, Hc);
    var hi = st.max, lo = st.min, op = st.first, cl = st.last;
    var top = 20, bot = Hc - 28, span = Math.max(0.01, hi - lo);
    function Y(p) { return top + (hi - p) / span * (bot - top); }
    var cx = Wc * 0.27, bw = 30, up = cl >= op, col = up ? '#ff5d5d' : '#1fd17d';
    // 影线 高→低
    g.strokeStyle = col; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, Y(hi)); g.lineTo(cx, Y(lo)); g.stroke();
    // 实体 开→收
    var yo = Y(op), yc2 = Y(cl);
    g.fillStyle = col; g.fillRect(cx - bw / 2, Math.min(yo, yc2), bw, Math.max(2, Math.abs(yc2 - yo)));
    // 峰/谷 标注（蜡烛左侧）
    g.fillStyle = '#9fb2d6'; g.font = '11px -apple-system, sans-serif'; g.textAlign = 'right';
    g.fillText('峰 ¥' + hi.toFixed(1), cx - bw / 2 - 8, Y(hi) + 4);
    g.fillText('谷 ¥' + lo.toFixed(1), cx - bw / 2 - 8, Y(lo) + 4);
    // 右侧总结大字
    var rx = Wc * 0.50;
    g.textAlign = 'left';
    g.fillStyle = '#8aa0c8'; g.font = '11px -apple-system, sans-serif';
    g.fillText('区间走势 · 一根 K 线', rx, Hc * 0.40 - 20);
    g.fillStyle = st.return_pct >= 0 ? '#ff7a7a' : '#1fd17d';
    g.font = 'bold 24px -apple-system, sans-serif';
    g.fillText((st.return_pct >= 0 ? '+' : '') + st.return_pct + '%', rx, Hc * 0.40 + 8);
    g.fillStyle = '#ffb0b0'; g.font = 'bold 13px -apple-system, sans-serif';
    g.fillText('最大回撤 ' + st.max_drawdown_pct + '%', rx, Hc * 0.40 + 30);
    g.fillStyle = '#7d8eae'; g.font = '11px -apple-system, sans-serif';
    g.fillText(st.n + ' 个交易日', rx, Hc * 0.40 + 50);
  }

  function finish() {
    var ret = Track.data.stats.return_pct;
    showEndOverlay('到达终点！全程得分 ' + Math.floor(game.score) +
          '　这票区间' + (ret >= 0 ? '+' : '') + ret + '%，' +
          (ret >= 0 ? '你居然活着下来了' : '难怪你套牢'), 'finish', true);
  }

  // =====================================================================
  // 渲染
  // =====================================================================
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawSky();                                   // 天空/星星：屏幕空间，不受相机缩放影响
    ctx.save();
    // 聚焦点(game.camX,camY)落在屏幕锚点(Ax,Ay)，按 camZoom 缩放；叠加大事件的猛推+抖动
    var Ax = W * C.CAM_X_RATIO, Ay = H * C.CAM_Y_RATIO;
    var shx = game.shake ? (Math.random() * 2 - 1) * game.shake : 0;
    var shy = game.shake ? (Math.random() * 2 - 1) * game.shake : 0;
    ctx.translate(Ax + shx, Ay + shy);
    ctx.scale(game.camZoom * (1 + game.punch), game.camZoom * (1 + game.punch));
    ctx.translate(-game.camX, -game.camY);
    drawTerrain();
    drawAvalanche();        // 在地形之上、骑手之下
    drawRider();
    ctx.restore();

    // 大事件闪色
    if (game.flashA > 0.01) {
      ctx.fillStyle = 'rgba(' + game.flashColor + ',' + game.flashA + ')';
      ctx.fillRect(0, 0, W, H);
    }
    drawAvalancheWarning();
    updateHUD();
  }

  // 红色熊市雪崩浪体 + 前沿大熊（世界坐标，随相机缩放）
  function drawAvalanche() {
    if (!avalanche.on) return;
    var z = game.camZoom, Ax = W * C.CAM_X_RATIO;
    var leftX = game.camX - Ax / z - 80;
    var ax = avalanche.x;
    if (ax < leftX) return;                       // 还在屏幕外，不画（仍在追）
    var wh = C.AVALANCHE_WAVE_HEIGHT, bottom = Track.maxY + C.GROUND_FILL_DEPTH, T = game.time;
    ctx.beginPath();
    ctx.moveTo(ax, bottom);
    ctx.lineTo(ax, groundY(ax) - wh * 0.35);      // 前脸
    var x = ax;
    while (x > leftX) {                            // 翻滚顶边
      var churn = Math.sin(x * 0.018 + T * 7) * 16 + Math.sin(x * 0.006 - T * 3.5) * 26;
      ctx.lineTo(x, groundY(x) - wh - churn);
      x -= 26;
    }
    ctx.lineTo(leftX, groundY(leftX) - wh);
    ctx.lineTo(leftX, bottom);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, groundY(ax) - wh - 60, 0, groundY(ax) + 160);
    g.addColorStop(0, 'rgba(255,90,80,0.78)');
    g.addColorStop(0.45, 'rgba(214,30,30,0.92)');
    g.addColorStop(1, 'rgba(120,8,12,0.96)');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(255,40,40,0.6)'; ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;
    drawBear(ax - wh * 0.30, groundY(ax) - wh * 0.72, wh * 0.42);
  }

  function drawBear(cx, cy, r) {
    function disc(x, y, rr) { ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#7a0d10';                                   // 耳朵
    disc(cx - r * 0.62, cy - r * 0.66, r * 0.42);
    disc(cx + r * 0.62, cy - r * 0.66, r * 0.42);
    ctx.fillStyle = '#9c1418'; disc(cx, cy, r);                  // 头
    ctx.fillStyle = '#ffe14d';                                   // 怒眼
    disc(cx - r * 0.36, cy - r * 0.10, r * 0.17);
    disc(cx + r * 0.36, cy - r * 0.10, r * 0.17);
    ctx.fillStyle = '#1a0000';
    disc(cx - r * 0.33, cy - r * 0.05, r * 0.08);
    disc(cx + r * 0.39, cy - r * 0.05, r * 0.08);
    ctx.fillStyle = '#c75055'; disc(cx, cy + r * 0.42, r * 0.42);// 吻部
    ctx.fillStyle = '#1a0000'; disc(cx, cy + r * 0.30, r * 0.12);
  }

  // 雪崩逼近预警：屏幕左侧红色脉冲 + 提示语（屏幕空间）
  function drawAvalancheWarning() {
    if (!avalanche.on || game.over) return;
    var gap = rider.x - avalanche.x;
    if (gap >= C.AVALANCHE_WARN_DIST) return;
    var t = Math.max(0, Math.min(1, 1 - gap / C.AVALANCHE_WARN_DIST));
    var pulse = 0.55 + 0.45 * Math.sin(game.time * 14);
    var a = (0.10 + 0.32 * t) * pulse;
    var vg = ctx.createLinearGradient(0, 0, W * 0.45, 0);
    vg.addColorStop(0, 'rgba(255,30,30,' + a.toFixed(3) + ')');
    vg.addColorStop(1, 'rgba(255,30,30,0)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (t > 0.35) {
      ctx.fillStyle = 'rgba(255,180,180,' + (0.7 * pulse).toFixed(3) + ')';
      ctx.font = 'bold 19px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🐻 熊市雪崩逼近！冲！', W * 0.5, H - 62);
      ctx.textAlign = 'left';
    }
  }

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#070b16');
    g.addColorStop(0.55, '#0d1426');
    g.addColorStop(1, '#161f38');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 星星（伪随机、固定）
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (var i = 0; i < 70; i++) {
      var sx = (i * 113 % W);
      var sy = (i * 197 % (H * 0.6));
      var tw = (i % 5 === 0) ? 1.6 : 1;
      ctx.globalAlpha = 0.25 + (i % 7) / 12;
      ctx.fillRect(sx, sy, tw, tw);
    }
    ctx.globalAlpha = 1;
  }

  function drawTerrain() {
    var w = Track.step, z = game.camZoom, Ax = W * C.CAM_X_RATIO;
    // 可见 x 范围（世界坐标，考虑缩放后视野更宽）
    var x0 = game.camX - Ax / z - 60;
    var x1 = game.camX + (W - Ax) / z + 60;
    var i0 = Math.max(0, Math.floor(x0 / w));
    var i1 = Math.min(Track.n - 1, Math.ceil(x1 / w));
    if (i1 <= i0) return;

    var bottom = Track.maxY + C.GROUND_FILL_DEPTH;

    // 雪面填充
    ctx.beginPath();
    ctx.moveTo(Track.xs[i0], bottom);
    for (var i = i0; i <= i1; i++) ctx.lineTo(Track.xs[i], Track.ys[i]);
    ctx.lineTo(Track.xs[i1], bottom);
    ctx.closePath();
    var gg = ctx.createLinearGradient(0, Track.minY, 0, Track.maxY + 300);
    gg.addColorStop(0, '#2b3550');
    gg.addColorStop(0.5, '#1c2438');
    gg.addColorStop(1, '#11172a');
    ctx.fillStyle = gg; ctx.fill();

    // 雪面亮线
    ctx.beginPath();
    ctx.moveTo(Track.xs[i0], Track.ys[i0]);
    for (var k = i0 + 1; k <= i1; k++) ctx.lineTo(Track.xs[k], Track.ys[k]);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#dfe9ff';
    ctx.shadowColor = 'rgba(150,190,255,0.6)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 高点水位线：历史最高处的水平虚线 → 全程直观看见自己被埋多深（套牢主题）
    drawPeakLine(x0, x1);
    // 跳水段(连续阴跌)：冷色俯冲长坡（先画，单日绿崖叠在它上面）
    drawDiveSegments(x0, x1);
    // 大事件：金色发射墙(涨) / 绿色悬崖(跌)
    drawBigEvents(x0, x1);

    // 起点 / 终点旗
    drawFlag(Track.xs[0], Track.ys[0], '#7fd1ff', '出发');
    drawFlag(Track.xs[Track.n - 1], Track.ys[Track.n - 1], '#ffd27f', '终点');
  }

  // 把连续阴跌的"跳水段"整段染成冷色俯冲坡，够长的段打"跳水段·没有底"标签
  function drawDiveSegments(x0, x1) {
    if (!Track.evDive) return;
    var h = C.SEGMENT_WIDTH, ppd = Track.ptsPerDay;
    var d0 = Math.max(0, Math.floor(x0 / h));
    var d1 = Math.min(Track.dayCount - 1, Math.ceil(x1 / h));
    var d = d0;
    while (d <= d1) {
      if (!Track.evDive[d]) { d++; continue; }
      var s = d; while (d <= d1 && Track.evDive[d]) d++;      // 当前连续段 [s, d-1]
      var e = d - 1;
      var lo = Math.max(0, s * ppd), hi = Math.min(Track.n - 1, e * ppd);
      ctx.beginPath();
      ctx.moveTo(Track.xs[lo], Track.ys[lo]);
      for (var i = lo + 1; i <= hi; i++) ctx.lineTo(Track.xs[i], Track.ys[i]);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(124,176,255,0.55)';            // 冷蓝=越滑越深的俯冲坡
      ctx.shadowColor = 'rgba(80,140,255,0.7)';
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 跳水段只用冷蓝坡体表达，不画图标/文字（图标易误解，已按需求去掉）
    }
  }

  // 把大事件那几天的地形段染成金墙/绿崖，并给涨跌停打标
  function drawBigEvents(x0, x1) {
    var h = C.SEGMENT_WIDTH, ppd = Track.ptsPerDay;
    var d0 = Math.max(0, Math.floor(x0 / h));
    var d1 = Math.min(Track.dayCount - 1, Math.ceil(x1 / h));
    for (var d = d0; d <= d1; d++) {
      if (!Track.evType[d]) continue;
      var up = Track.evType[d] > 0;
      var rel = Track.evRel[d];
      var color = up ? '#ffcf3a' : '#33e08a';        // 涨=金 / 跌=绿
      // 该日对应的稠密点范围（多取半天让墙体连续）
      var lo = Math.max(0, Math.round(d * ppd - ppd * 0.5));
      var hi = Math.min(Track.n - 1, Math.round(d * ppd + ppd * 0.5));
      ctx.beginPath();
      ctx.moveTo(Track.xs[lo], Track.ys[lo]);
      for (var i = lo + 1; i <= hi; i++) ctx.lineTo(Track.xs[i], Track.ys[i]);
      ctx.lineWidth = 4 + 4 * rel;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 + 18 * rel;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 涨跌停 → A 风格徽章图标当"位置标记"（文字走屏幕 toast，不在滚动地形上画长句）
      if (Track.evLimit[d]) {
        drawBadge(d * h, Track.ys[d * ppd], color, up ? '🚀' : '📉');
      }
    }
  }

  // A 风格图标：彩底圆牌 + emoji，插在事件位置当"地标"
  function drawBadge(px, py, color, emoji) {
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 34);
    ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py - 56, 21, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#10131c'; ctx.font = '21px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(emoji, px, py - 55);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // 历史最高点水平虚线 + 标注；骑手离它越远=套得越深
  function drawPeakLine(x0, x1) {
    if (!Track.peakY) return;
    var day = indexAt(rider.x), py = Track.peakY[day];
    if (rider.y - py < 40) return;                    // 还没明显低于山顶就不画，免得糊在脚下
    ctx.save();
    ctx.setLineDash([14, 12]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,210,127,0.5)';        // 暖金=曾经的高点
    ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x1, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,210,127,0.8)';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.fillText('— 你的山顶 —', x0 + 16, py - 6);
    ctx.restore();
  }

  function drawFlag(x, y, color, label) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 46); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y - 46); ctx.lineTo(x + 22, y - 39);
    ctx.lineTo(x, y - 32); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '11px sans-serif';
    ctx.fillText(label, x + 3, y - 50);
  }

  function drawRider() {
    var sx = rider.x, sy = rider.y;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rider.angle);

    var crashing = rider.crashTimer > 0;
    // 雪板
    ctx.fillStyle = crashing ? '#ff6b6b' : '#ffce4d';
    roundRect(-22, 4, 44, 7, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-2, 4, 4, 7);
    // 身体
    ctx.fillStyle = crashing ? '#c0392b' : '#2e3a5a';
    roundRect(-7, -22, 14, 26, 6); ctx.fill();
    // 头
    ctx.fillStyle = '#f1d3a8';
    ctx.beginPath(); ctx.arc(0, -28, 7, 0, Math.PI * 2); ctx.fill();
    // 头盔
    ctx.fillStyle = crashing ? '#e74c3c' : '#5aa0ff';
    ctx.beginPath(); ctx.arc(0, -29, 7.5, Math.PI, 0); ctx.fill();
    ctx.restore();

    // 速度尾迹
    if (rider.grounded && !crashing) {
      ctx.strokeStyle = 'rgba(200,225,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - 18, sy + 8);
      ctx.lineTo(sx - 50 - Math.hypot(rider.vx, rider.vy) * 0.03, sy + 9);
      ctx.stroke();
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // =====================================================================
  // HUD
  // =====================================================================
  function updateHUD() {
    var idx = indexAt(rider.x);
    var row = Track.rows[idx];          // [date,o,h,l,c,pct,flag]
    hud.date.textContent = row[0];
    hud.price.textContent = '¥' + row[4].toFixed(2);
    var pct = row[5];
    hud.pct.textContent = (pct >= 0 ? '+' : '') + pct + '%';
    hud.pct.className = pct > 0 ? 'up' : (pct < 0 ? 'down' : '');
    // 相对出发的浮盈亏（黑色幽默）
    var pnl = (row[4] / Track.rows[0][4] - 1) * 100;
    hud.pos.textContent = (pnl >= 0 ? '浮盈 +' : '浮亏 ') + pnl.toFixed(1) + '%';
    hud.pos.className = pnl >= 0 ? 'up' : 'down';
    // 距历史高点（套牢深度）
    var ddp = (row[4] / Track.peakPrice[idx] - 1) * 100;
    hud.peak.textContent = '距高点 ' + ddp.toFixed(0) + '%';
    hud.peak.className = ddp < -0.5 ? 'pos down' : 'pos';

    var kmh = Math.round(Math.hypot(rider.vx, rider.vy) * 0.12);
    hud.speed.textContent = kmh + ' km/h';
    hud.score.textContent = Math.floor(game.score).toLocaleString();
    hud.combo.textContent = game.combo > 0 ? ('x' + game.combo) : '—';
    hud.flips.textContent = game.flips;
    var prog = Math.min(100, rider.x / Track.length * 100);
    hud.progress.style.width = prog.toFixed(1) + '%';
  }

  // =====================================================================
  // 主循环
  // =====================================================================
  var last = 0;
  function loop(ts) {
    if (!last) last = ts;
    var real = Math.min((ts - last) / 1000, 1 / 30);
    last = ts;
    var dt = real;
    if (game.slowmoT > 0) {                  // 微慢动作：按真实时间倒计时，但游戏时间放慢
      game.slowmoT -= real;
      dt = real * (C.HITSTOP_SCALE != null ? C.HITSTOP_SCALE : 0.35);
    }
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // =====================================================================
  // 输入
  // =====================================================================
  // 一键控制（Ski Safari 式）：
  //  · 点按 = 即时跳跃   · 空中按住 = 后空翻   · 松手 = 停转准备落地
  function press() {
    if (!game.started) { startGame(); return; }
    if (game.over) return;                 // 结束后只用 R / 按钮重开，空格不再混用
    game.holding = true;
    if (rider.grounded && rider.crashTimer <= 0) doJump();
  }
  function release() { game.holding = false; }

  function doJump() {
    rider.vy = -C.JUMP_FORCE;              // 即时起跳，跟手
    rider.grounded = false;
    rider.takeoffAngle = rider.angle;
    rider.spinAccum = 0;
    rider.airTime = 0;
    if (!game.hasJumped) {                 // 第一次跳过后把操作提示淡下去
      game.hasJumped = true;
      var ch = document.getElementById('control-hint');
      if (ch) ch.classList.add('dim');
    }
  }

  function restart() { location.reload(); }

  window.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;   // 正在输入代码，别抢键
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); press(); }
    else if (e.key === 'r' || e.key === 'R') restart();
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); release(); }
  });
  // 绑在 window 上：开始遮罩盖住 canvas 时，点任意处也能开滑；游戏中点屏=跳
  window.addEventListener('pointerdown', function () { press(); });
  window.addEventListener('pointerup', function () { release(); });
  // 防止移动端长按选中 / 滚动
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  var restartBtn = document.getElementById('btn-restart');
  if (restartBtn) restartBtn.addEventListener('click', function (e) { e.stopPropagation(); restart(); });

  function startGame() {
    game.started = true;
    document.getElementById('overlay').classList.add('hidden');
    var ch = document.getElementById('control-hint');
    if (ch) ch.classList.add('show');
  }

  // =====================================================================
  // 启动：读数据
  // =====================================================================
  function getCode() {
    var m = location.search.match(/[?&]code=([a-zA-Z0-9]{6,9})/);
    return m ? m[1] : '300308';
  }

  var currentCode = '';        // 当前已加载的票代码
  var indexData = null;        // data/index.json 缓存
  function bearOff() { return /[?&]bear=0\b/.test(location.search); }
  function loadIndex() {       // 拉一次 index.json 并缓存（卡片 + 下拉共用）
    if (indexData) return Promise.resolve(indexData);
    return fetch('data/index.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) { indexData = idx; return idx; }).catch(function () { return null; });
  }

  // 快速换票：URL ?code=000687（输入框用，可能是 index 之外的票，需整页重载换数据文件）
  function switchCode(code) {
    code = (code || '').trim();
    if (!code) return;
    location.href = location.pathname + '?code=' + encodeURIComponent(code);
  }

  // 加载某只票的数据并重建地形（不重载页面，供卡片选择用）
  function loadStock(code) {
    return fetch('data/' + code + '.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        buildTrack(data);
        avalanche.on = C.AVALANCHE_ENABLED && !bearOff();
        resetRider();
        currentCode = data.code;
        hud.name.textContent = data.name + ' · ' + data.code + ' · ' + (data.personality || '');
        return data;
      });
  }

  // 点卡片 = 选中并加载该票（顶部预览换成它的区间K线 + 高亮），回到"未开滑"预备态；开滑仍按空格/点屏幕
  function selectStock(code) {
    if (game.started && !game.over) return;          // 游戏进行中不允许切票
    loadStock(code).then(function () {
      try { history.replaceState(null, '', location.pathname + '?code=' + code + (bearOff() ? '&bear=0' : '')); } catch (e) {}
      game.started = false;                          // resetRider 已把 over 置 false，这里回到开始态
      // 若从结束页过来，恢复开始页 UI
      document.querySelector('.cta').style.display = '';
      document.getElementById('btn-restart').style.display = 'none';
      document.getElementById('control-hint').classList.remove('show');
      drawSummaryCandle();          // 顶部预览换成这只票
      updateChallengeBox(null);     // 显示这只票的挑战目标
      renderCards();                // 刷新高亮
    }).catch(function () {});
  }

  // 迷你区间 K 线（卡片左侧缩略图）：峰/谷影线 + 开/收实体
  function drawMiniCandle(cv, st) {
    if (!cv || !st || st.max == null || st.min == null || st.max <= st.min) return;
    var g = cv.getContext('2d'), Wc = cv.width, Hc = cv.height;
    g.clearRect(0, 0, Wc, Hc);
    var hi = st.max, lo = st.min, op = st.first, cl = st.last;
    var top = 12, bot = Hc - 12, span = hi - lo;
    function Y(p) { return top + (hi - p) / span * (bot - top); }
    var cx = Wc / 2, bw = Math.max(12, Wc * 0.4), up = cl >= op, col = up ? '#ff5d5d' : '#1fd17d';
    g.strokeStyle = col; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx, Y(hi)); g.lineTo(cx, Y(lo)); g.stroke();
    var yo = Y(op), yc2 = Y(cl);
    g.fillStyle = col; g.fillRect(cx - bw / 2, Math.min(yo, yc2), bw, Math.max(3, Math.abs(yc2 - yo)));
  }

  // 造一张卡片 DOM
  function buildCard(s) {
    var st = s.stats || {}, ch = s.challenge;
    var up = (st.return_pct || 0) >= 0;
    var stars = '★'.repeat(s.star || 0) + '☆'.repeat(Math.max(0, 5 - (s.star || 0)));
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick-card' + (s.code === currentCode ? ' current' : '') + (s.featured ? ' featured' : '');
    card.innerHTML =
      '<canvas class="mini" width="96" height="120"></canvas>' +
      '<div class="pc-info">' +
        '<div class="pc-top"><span class="pc-name"></span><span class="pc-code"></span>' +
          (s.featured ? '<span class="pc-star-tag">⭐精选</span>' : '') + '</div>' +
        '<div class="pc-cat"></div>' +
        '<div class="pc-pers"></div>' +
        '<div class="pc-badge"><span class="stars"></span> <span class="diff"></span></div>' +
        '<div class="pc-stats"><span class="' + (up ? 'st-up' : 'st-down') + '">本期 ' +
          (up ? '+' : '') + (st.return_pct != null ? st.return_pct : '—') + '%</span>' +
          '<span class="st-dd">回撤 ' + (st.max_drawdown_pct != null ? st.max_drawdown_pct : '—') + '%</span></div>' +
        (ch ? '<div class="pc-chal">🔥 挑战 · <span class="chl"></span></div>' : '') +
      '</div>';
    card.querySelector('.pc-name').textContent = s.name || s.code;
    card.querySelector('.pc-code').textContent = s.code;
    card.querySelector('.pc-cat').textContent = s.category || '';
    card.querySelector('.pc-pers').textContent = s.personality || '';
    card.querySelector('.stars').textContent = stars;
    card.querySelector('.diff').textContent = s.difficulty || '';
    if (ch) card.querySelector('.chl').textContent = ch.label || '';
    drawMiniCandle(card.querySelector('canvas.mini'), st);
    card.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    card.addEventListener('click', function (e) { e.stopPropagation(); selectStock(s.code); });
    return card;
  }

  // 渲染首屏选票卡片：默认只铺"精选名场面"，其余大票库靠搜索（最多渲染 CAP 张，避免上百画布卡顿）
  var CARD_CAP = 80;
  function renderCards() {
    var grid = document.getElementById('card-grid');
    if (!grid || !indexData || !indexData.stocks) return;
    var sb = document.getElementById('card-search');
    var q = (sb && sb.value ? sb.value : '').trim().toLowerCase();
    var all = indexData.stocks, list, note = '';
    if (!q) {
      var featured = all.filter(function (s) { return s.featured; });
      list = featured.length ? featured : all.slice(0, CARD_CAP);
      var rest = all.length - list.length;
      note = '⭐ 精选名场面 · 另有 ' + rest + ' 只大票库，搜索代码/名称/「沪深300」「中证500」查看';
    } else {
      var matched = all.filter(function (s) {
        return (s.code + ' ' + (s.name || '') + ' ' + (s.category || '') + ' ' + (s.personality || '')).toLowerCase().indexOf(q) >= 0;
      });
      matched.sort(function (a, b) { return (b.featured ? 1 : 0) - (a.featured ? 1 : 0); });  // 精选优先
      list = matched.slice(0, CARD_CAP);
      note = matched.length ? ('找到 ' + matched.length + ' 只' + (matched.length > CARD_CAP ? '（显示前 ' + CARD_CAP + '，再缩小关键词）' : '')) : '';
    }
    grid.innerHTML = '';
    if (note) { var nd = document.createElement('div'); nd.className = 'card-note'; nd.textContent = note; grid.appendChild(nd); }
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'no-result';
      empty.textContent = '没有匹配的票。换个关键词，或用下面输入框按 6 位代码生成新票。';
      grid.appendChild(empty);
      return;
    }
    list.forEach(function (s) { grid.appendChild(buildCard(s)); });
  }

  function setupSwitcher(curCode) {
    var input = document.getElementById('code-input');
    var go = document.getElementById('code-go');
    var list = document.getElementById('code-list');
    if (!input) return;
    input.value = curCode;
    // 阻止开始遮罩上的点击/空格被当成“开滑”
    var box = document.getElementById('switcher');
    if (box) box.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    go.addEventListener('click', function (e) { e.stopPropagation(); switchCode(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') switchCode(input.value); });
    // 从 index.json 填充下拉
    loadIndex().then(function (idx) {
      if (!idx || !idx.stocks || !list) return;
      list.innerHTML = '';
      idx.stocks.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.code; o.label = s.code + ' ' + s.name + (s.difficulty ? ' · ' + s.difficulty : '');
        list.appendChild(o);
      });
    });
  }

  // 调试/测试钩子：控制台 __GS() 看内部状态
  window.__GS = function () {
    return {
      x: rider.x, y: rider.y, vx: rider.vx, vy: rider.vy,
      angle: rider.angle, grounded: rider.grounded, airTime: rider.airTime,
      crashTimer: rider.crashTimer, spinAccum: rider.spinAccum,
      score: game.score, combo: game.combo, flips: game.flips,
      started: game.started, over: game.over,
      zoom: game.camZoom, flashA: game.flashA, punch: game.punch,
      avX: avalanche.x, avGap: rider.x - avalanche.x, danger: avalanche.danger,
      avOn: avalanche.on, caught: avalanche.caught,
      progress: rider.x / Track.length,
    };
  };
  // 测试/调试控制：强制按住、瞬移到指定进度并给定速度
  window.__hold = function (b) { game.holding = !!b; };
  window.__warp = function (frac, speed) {
    rider.x = Track.length * frac;
    rider.y = groundY(rider.x);
    var sl = slopeAt(rider.x);
    var sp = speed || 1200;
    rider.vx = Math.cos(sl) * sp; rider.vy = Math.sin(sl) * sp;
    rider.angle = sl; rider.grounded = true; rider.crashTimer = 0;
  };
  window.__aval = function (x) { avalanche.x = x; avalanche.caughtFrames = 0; };
  // 改完 CONFIG 后免刷新用当前参数重建地形(回到起点)：例 CONFIG.TERRAIN_SMOOTH_WINDOW=0; __rebuild()
  window.__rebuild = function () {
    if (!Track.data) return '还没加载数据';
    buildTrack(Track.data);
    resetRider();
    return '已用当前 CONFIG 重建地形 (SMOOTH_WINDOW=' + C.TERRAIN_SMOOTH_WINDOW + ', DIVE_GAIN=' + C.DIVE_GAIN + ')';
  };

  function boot() {
    var code = getCode();
    loadStock(code)
      .then(function (data) {
        setupSwitcher(data.code);
        document.getElementById('overlay').classList.add('ready');
        document.getElementById('overlay').classList.remove('hidden');
        loadIndex().then(function () { renderCards(); });   // 首屏选票卡片
        drawSummaryCandle();                                 // 顶部预览当前票的区间K线
        updateChallengeBox(null);                            // 显示本关挑战目标
        var sb = document.getElementById('card-search');     // 搜索框过滤卡片
        if (sb) {
          sb.addEventListener('input', renderCards);
          sb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        }
        requestAnimationFrame(loop);
      })
      .catch(function (err) {
        var msg = String((err && err.message) || err);
        var html;
        if (/^HTTP\b/.test(msg)) {
          // 服务器在跑，但这个代码没有对应数据文件（多半是代码输错/还没生成）
          html = '没找到 <code>data/' + code + '.json</code>（' + msg + '）<br><br>' +
            '多半是<b>代码输错了</b>，或这只票还没生成数据：<br>' +
            '· 检查代码（注意别把 <b>601888</b> 打成 061888）<br>' +
            '· 生成数据：<code>python3 fetch_stocks.py --only ' + code + '</code><br>' +
            '· 或换一只已有的：<code>?code=300308</code> 、 <code>?code=601888</code>';
        } else {
          html = '读取 data/' + code + '.json 失败：' + msg + '<br><br>' +
            '多半是直接用 file:// 打开导致浏览器拦截了 fetch。<br>' +
            '请在项目目录下起个本地服务器：<br>' +
            '<code>python3 -m http.server 8000</code><br>' +
            '然后访问 <code>http://localhost:8000/</code>';
        }
        document.getElementById('loading').innerHTML = html;
      });
  }

  boot();
})();
