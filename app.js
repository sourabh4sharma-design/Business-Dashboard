// ---- Configuration -----------------------------------------------------
// The sheet is private, so a scheduled GitHub Action (see
// .github/workflows/refresh-data.yml) fetches it server-side using a
// Google service account and commits the result into data/*.json. This
// page just reads those committed files — never talks to Google directly.
const TABS = [
  { label: "Summary", slug: "summary", type: "summary" },
  { label: "D2C & Auto POD", slug: "d2c-auto", type: "pod" },
  { label: "Govt + Telco", slug: "govt-telco", type: "pod" },
  { label: "CDIT+BFSI POD", slug: "cdit-bfsi", type: "pod" },
  { label: "FMCG North POD", slug: "fmcg-north", type: "pod" },
  { label: "FMCG - South POD", slug: "fmcg-south", type: "pod" },
  { label: "FMCG West POD", slug: "fmcg-west", type: "pod" },
  { label: "Gaming POD", slug: "gaming", type: "pod" },
];

// ---- State ---------------------------------------------------------------
let currentTabIndex = 0;
let podRows = [];
let podColumns = [];
let sortCol = null;
let sortDir = 1;

// ---- Helpers ---------------------------------------------------------------
function parseNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || s === "#N/A" || s === "N/A") return null;
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function findColumnIndex(headerRow, keyword) {
  const kw = keyword.toLowerCase();
  return headerRow.findIndex((h) => (h || "").toLowerCase().includes(kw));
}

function findColumnName(columns, keyword) {
  const kw = keyword.toLowerCase();
  return columns.find((c) => c.toLowerCase().includes(kw));
}

async function fetchJsonRows(slug) {
  const res = await fetch(`data/${slug}.json?_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `data/${slug}.json not found yet (HTTP ${res.status}). The scheduled Action may not have run yet — ` +
      `you can trigger it manually from the repo's Actions tab.`
    );
  }
  const body = await res.json();
  return body.values || [];
}

// ---- Rendering: tabs -----------------------------------------------------
function renderTabNav() {
  const nav = document.getElementById("tabNav");
  nav.innerHTML = "";
  TABS.forEach((tab, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (i === currentTabIndex ? " active" : "");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => selectTab(i));
    nav.appendChild(btn);
  });
}

async function selectTab(i) {
  currentTabIndex = i;
  renderTabNav();
  await loadCurrentTab();
}

// ---- Summary tab -----------------------------------------------------------
function renderSummary(rows) {
  document.getElementById("podView").style.display = "none";
  const view = document.getElementById("summaryView");
  view.style.display = "block";

  const headerRowIdx = rows.findIndex((r) =>
    r.some((c) => (c || "").toLowerCase().includes("total os"))
  );
  if (headerRowIdx === -1 || !rows[headerRowIdx + 1]) {
    throw new Error("Could not find the summary table inside the 'Summary' tab.");
  }
  const header = rows[headerRowIdx];
  const data = rows[headerRowIdx + 1];

  const monthStartIdx = findColumnIndex(header, "total os");
  const collectedIdx = findColumnIndex(header, "collected this month");
  const currentIdx = findColumnIndex(header, "current balance");

  const sections = [
    { key: "Total O/S – Month Start", start: monthStartIdx },
    { key: "Collected this Month", start: collectedIdx },
    { key: "Current Balance", start: currentIdx },
  ].filter((s) => s.start !== -1);

  const cardsEl = document.getElementById("summaryCards");
  cardsEl.innerHTML = "";
  sections.forEach((s) => {
    const total = parseNumber(data[s.start]);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label">${s.key} (₹ Lakhs)</div><div class="value ${total < 0 ? "neg" : ""}">${formatNumber(total)}</div>`;
    cardsEl.appendChild(card);
  });

  const labels = ["3M+ Overdue", "0-3M Overdue", "Under Credit"];
  const datasets = sections.map((s, i) => ({
    label: s.key,
    data: [1, 2, 3].map((offset) => parseNumber(data[s.start + offset]) ?? 0),
    backgroundColor: ["#2563eb", "#16a34a", "#f59e0b"][i % 3],
  }));

  const ctx = document.getElementById("agingChart").getContext("2d");
  if (window._agingChart) window._agingChart.destroy();
  window._agingChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { title: { display: true, text: "Aging buckets by section (₹ Lakhs)" } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// ---- POD tab -----------------------------------------------------------
function renderPodCards(rows, columns) {
  const amountCol = findColumnName(columns, "amount");
  const collectedCol = findColumnName(columns, "collected") && columns.find(c => c.toLowerCase() === "collected");
  const balanceCol = findColumnName(columns, "balance");
  const statusCol = findColumnName(columns, "collected/not collected") || findColumnName(columns, "collected/ not collected");

  const sum = (col) => rows.reduce((acc, r) => acc + (parseNumber(r[col]) ?? 0), 0);

  const cards = [
    { label: "Invoices", value: formatNumber(rows.length) },
  ];
  if (amountCol) cards.push({ label: "Total Amount", value: formatNumber(sum(amountCol)) });
  if (collectedCol) cards.push({ label: "Total Collected", value: formatNumber(sum(collectedCol)) });
  if (balanceCol) cards.push({ label: "Total Balance", value: formatNumber(sum(balanceCol)) });
  if (statusCol) {
    const pending = rows.filter((r) => (r[statusCol] || "").trim() && !/^collected$/i.test((r[statusCol] || "").trim())).length;
    cards.push({ label: "Pending Items", value: formatNumber(pending) });
  }

  const cardsEl = document.getElementById("podCards");
  cardsEl.innerHTML = "";
  cards.forEach((c) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `<div class="label">${c.label}</div><div class="value">${c.value}</div>`;
    cardsEl.appendChild(el);
  });

  return statusCol;
}

function renderPodTable() {
  const searchTerm = document.getElementById("searchBox").value.trim().toLowerCase();
  const statusVal = document.getElementById("statusFilter").value;
  const statusCol = document.getElementById("statusFilter").dataset.col;

  let filtered = podRows.filter((r) => {
    if (statusVal && statusCol && (r[statusCol] || "").trim() !== statusVal) return false;
    if (!searchTerm) return true;
    return podColumns.some((c) => (r[c] || "").toLowerCase().includes(searchTerm));
  });

  if (sortCol) {
    filtered = [...filtered].sort((a, b) => {
      const av = parseNumber(a[sortCol]);
      const bv = parseNumber(b[sortCol]);
      let cmp;
      if (av !== null && bv !== null) cmp = av - bv;
      else cmp = String(a[sortCol] || "").localeCompare(String(b[sortCol] || ""));
      return cmp * sortDir;
    });
  }

  document.getElementById("rowCount").textContent = `${filtered.length} of ${podRows.length} rows`;

  const thead = document.querySelector("#podTable thead");
  thead.innerHTML = "";
  const headRow = document.createElement("tr");
  podColumns.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c + (sortCol === c ? (sortDir === 1 ? " ▲" : " ▼") : "");
    th.addEventListener("click", () => {
      sortDir = sortCol === c ? -sortDir : 1;
      sortCol = c;
      renderPodTable();
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.querySelector("#podTable tbody");
  tbody.innerHTML = "";
  const statusColName = document.getElementById("statusFilter").dataset.col;
  filtered.slice(0, 2000).forEach((r) => {
    const tr = document.createElement("tr");
    podColumns.forEach((c) => {
      const td = document.createElement("td");
      if (c === statusColName && r[c]) {
        const isCollected = /^collected$/i.test(r[c].trim());
        td.innerHTML = `<span class="status-pill ${isCollected ? "status-collected" : "status-pending"}">${r[c]}</span>`;
      } else {
        td.textContent = r[c] ?? "";
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function renderPod(rows) {
  document.getElementById("summaryView").style.display = "none";
  const view = document.getElementById("podView");
  view.style.display = "block";

  if (!rows.length) throw new Error("This tab returned no data.");
  podColumns = rows[0].map((c) => (c || "").trim()).filter((c) => c !== "");
  const numCols = rows[0].length;
  podRows = rows.slice(1)
    .filter((r) => r.some((cell) => (cell || "").trim() !== ""))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < numCols; i++) {
        const key = (rows[0][i] || "").trim();
        if (key) obj[key] = r[i];
      }
      return obj;
    });

  sortCol = null;
  sortDir = 1;

  const statusCol = renderPodCards(podRows, podColumns);

  const statusFilter = document.getElementById("statusFilter");
  statusFilter.innerHTML = '<option value="">All statuses</option>';
  statusFilter.dataset.col = statusCol || "";
  if (statusCol) {
    const uniqueVals = [...new Set(podRows.map((r) => (r[statusCol] || "").trim()).filter(Boolean))].sort();
    uniqueVals.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      statusFilter.appendChild(opt);
    });
  }

  renderPodTable();
}

// ---- Load / refresh -----------------------------------------------------
async function loadCurrentTab() {
  const tab = TABS[currentTabIndex];
  const loadingEl = document.getElementById("loadingMsg");
  const errorEl = document.getElementById("errorMsg");
  document.getElementById("summaryView").style.display = "none";
  document.getElementById("podView").style.display = "none";
  errorEl.style.display = "none";
  loadingEl.style.display = "block";
  loadingEl.textContent = `Loading “${tab.label}”…`;

  try {
    const rows = await fetchJsonRows(tab.slug);
    if (tab.type === "summary") renderSummary(rows);
    else renderPod(rows);
    document.getElementById("lastUpdated").textContent = "Data refreshed on a schedule — page loaded " + new Date().toLocaleTimeString();
  } catch (err) {
    console.error(err);
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't load this tab.\n\n" + (err && err.message ? err.message : err);
  } finally {
    loadingEl.style.display = "none";
  }
}

document.getElementById("refreshBtn").addEventListener("click", loadCurrentTab);
document.getElementById("searchBox").addEventListener("input", renderPodTable);
document.getElementById("statusFilter").addEventListener("change", renderPodTable);

renderTabNav();
loadCurrentTab();
