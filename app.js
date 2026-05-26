const WATCHLIST_KEY = "a_share_sector_watchlist_codes_v1";
const STOCK_SELECTION_PREFIX = "a_share_component_selected_codes_v1:";

let data = null;
let watchlist = [];
let currentView = "watchlist";
let activeSector = null;
let componentData = null;
const componentCache = {};
const sectorHistoryCache = {};
let componentRenderToken = 0;
let sectorRenderToken = 0;
let sectorRefreshTimer = null;

const grid = document.querySelector("#grid");
const emptyState = document.querySelector("#emptyState");
const metaText = document.querySelector("#metaText");
const summary = document.querySelector("#summary");
const searchInput = document.querySelector("#searchInput");
const setupFilter = document.querySelector("#setupFilter");
const stateFilter = document.querySelector("#stateFilter");
const toast = document.querySelector("#toast");

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

function loadWatchlist(defaultCodes) {
  const raw = localStorage.getItem(WATCHLIST_KEY);
  if (!raw) return [...defaultCodes];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch (_) {}
  return [...defaultCodes];
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
}

function selectedStockCodes(sectorCode) {
  const raw = localStorage.getItem(`${STOCK_SELECTION_PREFIX}${sectorCode}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function saveSelectedStockCodes(sectorCode, codes) {
  localStorage.setItem(`${STOCK_SELECTION_PREFIX}${sectorCode}`, JSON.stringify([...new Set(codes)]));
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function stockSymbol(code) {
  const text = String(code).padStart(6, "0");
  if (/^[569]/.test(text)) return `sh${text}`;
  if (/^[48]/.test(text)) return `bj${text}`;
  return `sz${text}`;
}

function sectorSymbol(code) {
  const text = String(code).padStart(6, "0");
  return `pt018${text.slice(1)}`;
}

function computeStockMetrics(rows) {
  if (!rows.length) return null;
  const close = rows[rows.length - 1][2];
  const low60 = Math.min(...rows.slice(-60).map((row) => row[4]));
  const ret5 = rows.length > 5 ? (close / rows[rows.length - 6][2] - 1) * 100 : null;
  const distLow60 = low60 ? (close / low60 - 1) * 100 : null;
  return {
    close: Number(close.toFixed(2)),
    ret5_pct: ret5 === null ? null : Number(ret5.toFixed(2)),
    dist_low60_pct: distLow60 === null ? null : Number(distLow60.toFixed(2)),
  };
}

function mergeRealtimeRow(rows, row) {
  if (!row || !rows.length) return rows;
  const next = rows.slice();
  const last = next[next.length - 1];
  if (row[0] === last[0]) {
    next[next.length - 1] = row;
  } else if (row[0] > last[0]) {
    next.push(row);
  }
  return next;
}

function parseTencentSectorQuote(code, text) {
  if (!text || !text.includes('"')) return null;
  const fields = text.split('"')[1].split("~");
  if (fields.length < 38 || !fields[30]) return null;
  const stamp = fields[30];
  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const row = [
    date,
    Number(fields[5]),
    Number(fields[3]),
    Number(fields[33]),
    Number(fields[34]),
    Number(fields[36] || 0),
  ];
  return row.slice(1).every((value) => Number.isFinite(value)) ? row : null;
}

async function fetchTencentSectorQuote(code) {
  const symbol = sectorSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,10,qfq&_=${Date.now()}`;
  const response = await fetch(url);
  const payload = await response.json();
  const sector = payload.data && payload.data[symbol];
  const sourceRows = (sector && (sector.qfqday || sector.day)) || [];
  const row = sourceRows[sourceRows.length - 1];
  if (!row || row.length < 6) return null;
  const parsed = [
    row[0],
    Number(row[1]),
    Number(row[2]),
    Number(row[3]),
    Number(row[4]),
    Number(row[5]),
  ];
  return parsed.slice(1).every((value) => Number.isFinite(value)) ? parsed : null;
}

async function fetchStockRows(code) {
  const symbol = stockSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,520,qfq`;
  const response = await fetch(url);
  const payload = await response.json();
  const stock = payload.data && payload.data[symbol];
  const sourceRows = (stock && (stock.qfqday || stock.day)) || [];
  return sourceRows
    .filter((row) => row.length >= 6)
    .map((row) => [
      row[0],
      Number(row[1]),
      Number(row[2]),
      Number(row[3]),
      Number(row[4]),
      Number(row[5]),
    ])
    .filter((row) => row.slice(1).every((value) => Number.isFinite(value)));
}

function resampleRows(rows, period) {
  if (period === "daily") return rows;
  const groups = new Map();
  rows.forEach((row) => {
    const date = new Date(`${row[0]}T00:00:00`);
    let key;
    if (period === "monthly") {
      key = row[0].slice(0, 7);
    } else {
      const monday = new Date(date);
      const day = monday.getDay() || 7;
      monday.setDate(monday.getDate() - day + 1);
      key = monday.toISOString().slice(0, 10);
    }
    if (!groups.has(key)) {
      groups.set(key, {
        date: row[0],
        open: row[1],
        close: row[2],
        high: row[3],
        low: row[4],
        volume: row[5],
      });
    } else {
      const group = groups.get(key);
      group.date = row[0];
      group.close = row[2];
      group.high = Math.max(group.high, row[3]);
      group.low = Math.min(group.low, row[4]);
      group.volume += row[5];
    }
  });
  return Array.from(groups.values()).map((group) => [
    group.date,
    group.open,
    group.close,
    group.high,
    group.low,
    group.volume,
  ]);
}

function displayRowsForPeriod(rows, period) {
  const periodRows = resampleRows(rows, period);
  if (period === "daily") return periodRows.slice(-100);
  if (period === "weekly") return periodRows.slice(-120);
  if (period === "monthly") return periodRows.slice(-72);
  return periodRows;
}

function isTradingRefreshWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const weekday = value("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  return (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 35) || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5);
}

function periodLabel(period) {
  if (period === "weekly") return "周";
  if (period === "monthly") return "月";
  return "日";
}

function filteredSectors() {
  const keyword = searchInput.value.trim().toLowerCase();
  const setup = setupFilter.value;
  const state = stateFilter.value;
  return data.sectors.filter((sector) => {
    if (currentView === "watchlist" && !watchlist.includes(sector.code)) return false;
    if (setup && sector.setup !== setup) return false;
    if (state && sector.state !== state) return false;
    if (!keyword) return true;
    return [sector.code, sector.name, sector.upper]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

function renderSummary(items) {
  if (currentView === "components" && componentData && activeSector) {
    const selected = selectedStockCodes(activeSector.code);
    summary.innerHTML = [
      `${activeSector.name} 成分股 ${componentData.stocks.length} 只`,
      `已复选 ${selected.length} 只`,
      `数据日期 ${componentData.generated_at}`,
      `错误 ${componentData.errors.length} 个`,
    ]
      .map((text) => `<span>${text}</span>`)
      .join("");
    return;
  }

  const tracked = watchlist.filter((code) => data.sectors.some((sector) => sector.code === code));
  const danger = tracked.filter((code) => {
    const sector = data.sectors.find((item) => item.code === code);
    return sector && sector.level === "danger";
  }).length;
  const watch = tracked.filter((code) => {
    const sector = data.sectors.find((item) => item.code === code);
    return sector && sector.level === "watch";
  }).length;
  summary.innerHTML = [
    `当前显示 ${items.length} 个`,
    `跟踪池 ${tracked.length} 个`,
    `仍在观察 ${watch} 个`,
    `支撑失败 ${danger} 个`,
    `全市场板块 ${data.sectors.length} 个`,
  ]
    .map((text) => `<span>${text}</span>`)
    .join("");
}

function cardButton(sector) {
  const inWatchlist = watchlist.includes(sector.code);
  const componentButton = sector.components
    ? `<button data-action="components" data-code="${sector.code}" type="button">成分股</button>`
    : "";
  if (currentView === "watchlist") {
    return `<div class="card-actions">${componentButton}<button class="danger" data-action="remove" data-code="${sector.code}" type="button">移除</button></div>`;
  }
  if (inWatchlist) {
    return `<div class="card-actions">${componentButton}<button data-action="remove" data-code="${sector.code}" type="button">已跟踪</button></div>`;
  }
  return `<div class="card-actions">${componentButton}<button class="primary" data-action="add" data-code="${sector.code}" type="button">加入</button></div>`;
}

function renderCard(sector) {
  const version = encodeURIComponent(data.generated_at);
  const images = sector.images || { daily: sector.image, weekly: sector.image, monthly: sector.image };
  return `
    <article class="card" data-code="${sector.code}" data-history="${sector.history || ""}" data-period="daily">
      <div class="card-head">
        <div class="title">
          <strong>${sector.name} ${sector.code}</strong>
          <small>${sector.upper}</small>
          <div class="badges">
            <span class="badge">${sector.setup}</span>
            <span class="badge ${sector.level}">${sector.state}</span>
          </div>
        </div>
        ${cardButton(sector)}
      </div>
      <div class="chart-tabs" aria-label="${sector.name}周期切换">
        <button class="chart-tab active" data-chart="daily" type="button">日</button>
        <button class="chart-tab" data-chart="weekly" type="button">周</button>
        <button class="chart-tab" data-chart="monthly" type="button">月</button>
      </div>
      <canvas class="sector-chart" data-chart-height="230"></canvas>
      <img class="sector-fallback" src="${images.daily}?v=${version}" alt="${sector.name} 日K图" loading="lazy" hidden>
      <div class="metrics">
        <span>收盘<b data-sector-metric="close">${sector.close}</b></span>
        <span>5日<b data-sector-metric="ret5">${formatPct(sector.ret5_pct)}</b></span>
        <span>距60低<b data-sector-metric="dist">${formatPct(sector.dist_low60_pct)}</b></span>
        <span>趋势距<b data-sector-metric="trend">${formatPct(sector.trend_dist_pct)}</b></span>
      </div>
      <div class="refresh-line">
        <span data-sector-refresh>等待刷新</span>
      </div>
      <p class="reason">${sector.reason}</p>
    </article>
  `;
}

function render() {
  if (currentView === "components") {
    renderComponents();
    return;
  }

  const items = filteredSectors();
  renderSummary(items);
  sectorRenderToken += 1;
  const renderToken = sectorRenderToken;
  grid.innerHTML = items.map(renderCard).join("");
  emptyState.hidden = items.length !== 0;
  loadSectorCharts(renderToken, true);
}

function movingAverage(rows, index, windowSize) {
  if (index + 1 < windowSize) return null;
  let sum = 0;
  for (let i = index - windowSize + 1; i <= index; i += 1) {
    sum += rows[i][2];
  }
  return sum / windowSize;
}

function drawKline(canvas, rows) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 340;
  const height = Number(canvas.dataset.chartHeight || 210);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!rows.length) return;

  const pad = { top: 12, right: 10, bottom: 18, left: 10 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const highs = rows.map((row) => row[3]);
  const lows = rows.map((row) => row[4]);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || 1;
  const y = (price) => pad.top + (max - price) / span * plotH;
  const step = plotW / rows.length;
  const candleW = Math.max(2, Math.min(7, step * 0.58));

  ctx.strokeStyle = "#e6e9ed";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const gy = pad.top + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
  }

  rows.forEach((row, index) => {
    const [, open, close, high, low] = row;
    const x = pad.left + step * index + step / 2;
    const color = close >= open ? "#d93938" : "#21a957";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y(high));
    ctx.lineTo(x, y(low));
    ctx.stroke();
    const top = y(Math.max(open, close));
    const bottom = y(Math.min(open, close));
    const bodyH = Math.max(1, bottom - top);
    ctx.fillRect(x - candleW / 2, top, candleW, bodyH);
  });

  [
    [5, "#d04bd4"],
    [20, "#1f9cf0"],
    [60, "#f0a000"],
  ].forEach(([windowSize, color]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    rows.forEach((_, index) => {
      const ma = movingAverage(rows, index, windowSize);
      if (ma === null) return;
      const x = pad.left + step * index + step / 2;
      const py = y(ma);
      if (index === windowSize - 1) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.stroke();
  });

  ctx.fillStyle = "#667085";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(String(rows[0][0]).slice(5), pad.left, height - 5);
  ctx.fillText(String(rows[rows.length - 1][0]).slice(5), width - 46, height - 5);
}

async function fetchSectorRows(sector) {
  if (sectorHistoryCache[sector.code]) return sectorHistoryCache[sector.code];
  if (!sector.history) return [];
  if (!sectorHistoryCache[sector.code]) {
    const response = await fetch(`${sector.history}?v=${data.generated_at}`);
    const payload = await response.json();
    sectorHistoryCache[sector.code] = payload.rows || [];
  }
  return sectorHistoryCache[sector.code];
}

function updateSectorMetrics(card, sector, rows) {
  const metrics = computeStockMetrics(rows);
  if (!metrics) return;
  const trend = sector.trend_support ? (metrics.close / Number(sector.trend_support) - 1) * 100 : null;
  card.querySelector('[data-sector-metric="close"]').textContent = metrics.close;
  card.querySelector('[data-sector-metric="ret5"]').textContent = formatPct(metrics.ret5_pct);
  card.querySelector('[data-sector-metric="dist"]').textContent = formatPct(metrics.dist_low60_pct);
  card.querySelector('[data-sector-metric="trend"]').textContent = formatPct(trend);
}

function refreshTimeLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function setSectorRefreshStatus(card, text, state = "neutral") {
  const status = card.querySelector("[data-sector-refresh]");
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

async function drawSectorCard(card, renderToken, includeRealtime) {
  const sector = data.sectors.find((item) => item.code === card.dataset.code);
  if (!sector) return;
  const canvas = card.querySelector(".sector-chart");
  const fallback = card.querySelector(".sector-fallback");
  try {
    if (includeRealtime) {
      setSectorRefreshStatus(card, `刷新中 ${refreshTimeLabel()}`, "loading");
    } else {
      setSectorRefreshStatus(card, "加载历史K线", "neutral");
    }
    let rows = await fetchSectorRows(sector);
    let realtimeRow = null;
    if (includeRealtime) {
      realtimeRow = await fetchTencentSectorQuote(sector.code);
      rows = mergeRealtimeRow(rows, realtimeRow);
    }
    if (!rows.length) throw new Error("empty sector rows");
    if (renderToken !== sectorRenderToken) return;
    const period = card.dataset.period || "daily";
    canvas.hidden = false;
    fallback.hidden = true;
    drawKline(canvas, displayRowsForPeriod(rows, period));
    updateSectorMetrics(card, sector, rows);
    if (realtimeRow) {
      setSectorRefreshStatus(card, `盘中已刷新 ${refreshTimeLabel()} / ${realtimeRow[0]}`, "live");
    } else if (includeRealtime) {
      setSectorRefreshStatus(card, `未取到盘中行情 ${refreshTimeLabel()}`, "warn");
    } else {
      setSectorRefreshStatus(card, `历史K线 ${rows[rows.length - 1][0]}`, "neutral");
    }
  } catch (_) {
    canvas.hidden = true;
    fallback.hidden = false;
    setSectorRefreshStatus(card, "静态图显示", "warn");
  }
}

async function loadSectorCharts(renderToken, includeRealtime) {
  const cards = [...grid.querySelectorAll(".card[data-code]")];
  let cursor = 0;
  async function worker() {
    while (cursor < cards.length && renderToken === sectorRenderToken) {
      const card = cards[cursor];
      cursor += 1;
      await drawSectorCard(card, renderToken, includeRealtime);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, cards.length) }, worker));
}

function refreshVisibleSectorCharts(includeRealtime) {
  if (currentView === "components") return;
  sectorRenderToken += 1;
  const renderToken = sectorRenderToken;
  loadSectorCharts(renderToken, includeRealtime);
  const now = refreshTimeLabel();
  metaText.textContent = `${data.source} 生成时间：${data.generated_at}；盘中刷新：${now}`;
}

async function openComponents(code) {
  const sector = data.sectors.find((item) => item.code === code);
  if (!sector || !sector.components) {
    showToast("这个板块暂未生成成分股数据");
    return;
  }
  activeSector = sector;
  currentView = "components";
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  if (!componentCache[code]) {
    const response = await fetch(`${sector.components.path}?v=${Date.now()}`);
    componentCache[code] = await response.json();
  }
  componentData = componentCache[code];
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderComponents() {
  componentRenderToken += 1;
  const renderToken = componentRenderToken;
  const selected = selectedStockCodes(activeSector.code);
  const keyword = searchInput.value.trim().toLowerCase();
  const stocks = componentData.stocks.filter((stock) => {
    if (!keyword) return true;
    return [stock.code, stock.name].join(" ").toLowerCase().includes(keyword);
  });

  renderSummary(stocks);
  grid.innerHTML = `
    <article class="component-toolbar">
      <button data-action="back" type="button">返回板块墙</button>
      <strong>${activeSector.name} ${activeSector.code}</strong>
    </article>
    ${stocks
      .map((stock) => {
        const rows = componentData.histories[stock.code] || [];
        const checked = selected.includes(stock.code) ? "checked" : "";
        return `
          <article class="stock-card" data-code="${stock.code}">
            <div class="stock-head">
              <label class="stock-check">
                <input type="checkbox" data-stock-code="${stock.code}" ${checked}>
                <span>${stock.name} ${stock.code}</span>
              </label>
              <small>权重 ${stock.weight ?? "--"}%</small>
            </div>
            <div class="chart-tabs stock-period-tabs" aria-label="${stock.name}周期切换">
              <button class="chart-tab active" data-stock-chart="daily" type="button">日</button>
              <button class="chart-tab" data-stock-chart="weekly" type="button">周</button>
              <button class="chart-tab" data-stock-chart="monthly" type="button">月</button>
            </div>
            <canvas class="stock-chart" data-rows='${JSON.stringify(rows)}'></canvas>
            <div class="metrics">
              <span>收盘<b data-metric="close">加载中</b></span>
              <span>5日<b data-metric="ret5">--</b></span>
              <span>距60低<b data-metric="dist">--</b></span>
              <span>状态<b data-metric="status">拉取K线</b></span>
            </div>
          </article>
        `;
      })
      .join("")}
  `;
  loadComponentCharts(stocks, renderToken);
  emptyState.hidden = stocks.length !== 0;
}

async function loadComponentCharts(stocks, renderToken, forceRefresh = false) {
  let cursor = 0;
  async function worker() {
    while (cursor < stocks.length && renderToken === componentRenderToken) {
      const stock = stocks[cursor];
      cursor += 1;
      const card = grid.querySelector(`.stock-card[data-code="${stock.code}"]`);
      if (!card) continue;
      const canvas = card.querySelector("canvas");
      const status = card.querySelector('[data-metric="status"]');
      try {
        let rows = componentData.histories[stock.code] || [];
        if (forceRefresh) status.textContent = "刷新中";
        if (forceRefresh || !rows.length) rows = await fetchStockRows(stock.code);
        if (renderToken !== componentRenderToken) return;
        if (!rows.length) throw new Error("empty rows");
        componentData.histories[stock.code] = rows;
        canvas.dataset.rows = JSON.stringify(rows);
        const period = canvas.dataset.period || "daily";
        canvas.dataset.period = period;
        drawKline(canvas, displayRowsForPeriod(rows, period));
        const metrics = computeStockMetrics(rows);
        card.querySelector('[data-metric="close"]').textContent = metrics.close;
        card.querySelector('[data-metric="ret5"]').textContent = formatPct(metrics.ret5_pct);
        card.querySelector('[data-metric="dist"]').textContent = formatPct(metrics.dist_low60_pct);
        status.textContent = forceRefresh ? "已刷新" : `${periodLabel(period)}K`;
      } catch (_) {
        status.textContent = "拉取失败";
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, stocks.length) }, worker));
}

function refreshVisibleComponentCharts() {
  if (currentView !== "components" || !componentData) return;
  const visibleCodes = [...grid.querySelectorAll(".stock-card[data-code]")].map((card) => card.dataset.code);
  const stocks = visibleCodes
    .map((code) => componentData.stocks.find((stock) => stock.code === code))
    .filter(Boolean);
  if (!stocks.length) return;
  componentRenderToken += 1;
  const renderToken = componentRenderToken;
  loadComponentCharts(stocks, renderToken, true);
  const now = refreshTimeLabel();
  metaText.textContent = `${data.source} 生成时间：${data.generated_at}；成份股盘中刷新：${now}`;
}

function addSector(code) {
  if (!watchlist.includes(code)) {
    watchlist.push(code);
    saveWatchlist();
    const sector = data.sectors.find((item) => item.code === code);
    showToast(`${sector ? sector.name : code} 已加入跟踪池`);
    render();
  }
}

function removeSector(code) {
  watchlist = watchlist.filter((item) => item !== code);
  saveWatchlist();
  const sector = data.sectors.find((item) => item.code === code);
  showToast(`${sector ? sector.name : code} 已移除`);
  render();
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    currentView = button.dataset.view;
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    render();
  });
});

grid.addEventListener("click", (event) => {
  const stockChartTab = event.target.closest("button[data-stock-chart]");
  if (stockChartTab) {
    const card = stockChartTab.closest(".stock-card");
    const canvas = card.querySelector("canvas");
    const rows = JSON.parse(canvas.dataset.rows || "[]");
    const period = stockChartTab.dataset.stockChart;
    if (!rows.length) return;
    const periodRows = displayRowsForPeriod(rows, period);
    drawKline(canvas, periodRows);
    canvas.dataset.period = period;
    card.querySelectorAll(".chart-tab").forEach((tab) => tab.classList.toggle("active", tab === stockChartTab));
    card.querySelector('[data-metric="status"]').textContent = `${periodLabel(period)}K`;
    return;
  }

  const chartTab = event.target.closest("button[data-chart]");
  if (chartTab) {
    const card = chartTab.closest(".card");
    const chart = chartTab.dataset.chart;
    card.dataset.period = chart;
    drawSectorCard(card, sectorRenderToken, true);
    card.querySelectorAll(".chart-tab").forEach((tab) => tab.classList.toggle("active", tab === chartTab));
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const code = button.dataset.code;
  if (button.dataset.action === "back") {
    currentView = "watchlist";
    activeSector = null;
    componentData = null;
    document.querySelector('.tab[data-view="watchlist"]').classList.add("active");
    render();
    return;
  }
  if (button.dataset.action === "components") {
    openComponents(code);
    return;
  }
  if (button.dataset.action === "add") addSector(code);
  if (button.dataset.action === "remove") removeSector(code);
});

grid.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-stock-code]");
  if (!checkbox || !activeSector) return;
  const code = checkbox.dataset.stockCode;
  const selected = selectedStockCodes(activeSector.code);
  const next = checkbox.checked ? [...selected, code] : selected.filter((item) => item !== code);
  saveSelectedStockCodes(activeSector.code, next);
  renderSummary(componentData.stocks);
});

[searchInput, setupFilter, stateFilter].forEach((control) => {
  control.addEventListener("input", render);
});

document.querySelector("#resetBtn").addEventListener("click", () => {
  if (!window.confirm("恢复默认27个跟踪板块？当前本机观察池会被覆盖。")) return;
  watchlist = [...data.default_watchlist];
  saveWatchlist();
  showToast("已恢复默认观察池");
  render();
});

document.querySelector("#exportBtn").addEventListener("click", async () => {
  const text = JSON.stringify(watchlist, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showToast("观察池代码已复制");
  } catch (_) {
    window.prompt("复制观察池代码：", text);
  }
});

document.querySelector("#importBtn").addEventListener("click", () => {
  const raw = window.prompt("粘贴导出的观察池代码 JSON：");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not array");
    const valid = parsed.map(String).filter((code) => data.sectors.some((sector) => sector.code === code));
    watchlist = [...new Set(valid)];
    saveWatchlist();
    showToast(`已导入 ${watchlist.length} 个板块`);
    render();
  } catch (_) {
    showToast("导入失败，请检查格式");
  }
});

async function init() {
  const response = await fetch(`data/sectors.json?v=${Date.now()}`);
  data = await response.json();
  watchlist = loadWatchlist(data.default_watchlist);
  metaText.textContent = `${data.source} 生成时间：${data.generated_at}`;
  render();
  sectorRefreshTimer = window.setInterval(() => {
    if (!document.hidden && isTradingRefreshWindow()) {
      if (currentView === "components") {
        refreshVisibleComponentCharts();
      } else {
        refreshVisibleSectorCharts(true);
      }
    }
  }, 60000);
}

init().catch((error) => {
  metaText.textContent = "数据加载失败";
  console.error(error);
});
