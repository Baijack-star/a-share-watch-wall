const WATCHLIST_KEY = "a_share_sector_watchlist_codes_v1";
const STOCK_SELECTION_PREFIX = "a_share_component_selected_codes_v1:";

let data = null;
let watchlist = [];
let currentView = "watchlist";
let activeSector = null;
let componentData = null;
const componentCache = {};

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
    <article class="card">
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
      <img
        src="${images.daily}?v=${version}"
        data-daily="${images.daily}?v=${version}"
        data-weekly="${images.weekly}?v=${version}"
        data-monthly="${images.monthly}?v=${version}"
        alt="${sector.name} 日K图"
        loading="lazy"
      >
      <div class="metrics">
        <span>收盘<b>${sector.close}</b></span>
        <span>5日<b>${formatPct(sector.ret5_pct)}</b></span>
        <span>距60低<b>${formatPct(sector.dist_low60_pct)}</b></span>
        <span>趋势距<b>${formatPct(sector.trend_dist_pct)}</b></span>
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
  grid.innerHTML = items.map(renderCard).join("");
  emptyState.hidden = items.length !== 0;
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
  const height = 210;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

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
          <article class="stock-card">
            <div class="stock-head">
              <label class="stock-check">
                <input type="checkbox" data-stock-code="${stock.code}" ${checked}>
                <span>${stock.name} ${stock.code}</span>
              </label>
              <small>权重 ${stock.weight ?? "--"}%</small>
            </div>
            <canvas class="stock-chart" data-rows='${JSON.stringify(rows)}'></canvas>
            <div class="metrics">
              <span>收盘<b>${stock.close}</b></span>
              <span>5日<b>${formatPct(stock.ret5_pct)}</b></span>
              <span>距60低<b>${formatPct(stock.dist_low60_pct)}</b></span>
              <span>形态<b>${stock.setup}</b></span>
            </div>
          </article>
        `;
      })
      .join("")}
  `;
  grid.querySelectorAll("canvas.stock-chart").forEach((canvas) => {
    const rows = JSON.parse(canvas.dataset.rows || "[]");
    if (rows.length) drawKline(canvas, rows);
  });
  emptyState.hidden = stocks.length !== 0;
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
  const chartTab = event.target.closest("button[data-chart]");
  if (chartTab) {
    const card = chartTab.closest(".card");
    const image = card.querySelector("img");
    const chart = chartTab.dataset.chart;
    image.src = image.dataset[chart];
    const label = chart === "daily" ? "日" : chart === "weekly" ? "周" : "月";
    image.alt = `${card.querySelector(".title strong").textContent} ${label}K图`;
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
}

init().catch((error) => {
  metaText.textContent = "数据加载失败";
  console.error(error);
});
