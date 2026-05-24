const WATCHLIST_KEY = "a_share_sector_watchlist_codes_v1";

let data = null;
let watchlist = [];
let currentView = "watchlist";

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
  if (currentView === "watchlist") {
    return `<button class="danger" data-action="remove" data-code="${sector.code}" type="button">移除</button>`;
  }
  if (inWatchlist) {
    return `<button data-action="remove" data-code="${sector.code}" type="button">已跟踪</button>`;
  }
  return `<button class="primary" data-action="add" data-code="${sector.code}" type="button">加入</button>`;
}

function renderCard(sector) {
  const version = encodeURIComponent(data.generated_at);
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
      <img src="${sector.image}?v=${version}" alt="${sector.name} 日K图" loading="lazy">
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
  const items = filteredSectors();
  renderSummary(items);
  grid.innerHTML = items.map(renderCard).join("");
  emptyState.hidden = items.length !== 0;
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
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const code = button.dataset.code;
  if (button.dataset.action === "add") addSector(code);
  if (button.dataset.action === "remove") removeSector(code);
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
