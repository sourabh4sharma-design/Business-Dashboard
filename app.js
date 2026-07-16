// ============================================================
// Collections Dashboard
// Private, paytm.com-restricted Google Sheet → Apps Script (JSONP).
// Two views: Overview (Summary tab, many tables) and POD Level Details
// (one POD sheet at a time, chosen from a dropdown). Auto-refreshes
// in place every REFRESH_INTERVAL_MS, only touching the DOM when the
// underlying data actually changed.
// ============================================================
const APPS_SCRIPT_URL =
  "https://script.google.com/a/macros/paytm.com/s/AKfycbxZ8X5E9AgVCf4PYoU198JW1sDCMOa_RjJmlPJbHHN8jTzGOUW-N4LIkAv_tv2OcnPE/exec";
const APPS_SCRIPT_KEY = "eFZYQGevyYbeiRxswugbkF7YI4BLAcN3";
const REFRESH_INTERVAL_MS = 7000; // Overview auto-refresh cadence
const POD_REFRESH_MS = 30000; // POD auto-refresh cadence (data is large)
const PAGE_SIZE = 1000; // rows fetched per JSONP chunk

// Gemini AI (Overview "Ask about this data") is proxied through the Apps
// Script (server-side), so the Gemini API key lives in the Apps Script and
// is NEVER exposed in this public file. The client just sends the question.

const SUMMARY_SHEET = "Summary";
const PODS = [
  { label: "D2C & Auto", sheetName: "D2C & Auto POD" },
  { label: "Govt + Telco", sheetName: "Govt + Telco" },
  { label: "CDIT + BFSI", sheetName: "CDIT+BFSI POD" },
  { label: "FMCG North", sheetName: "FMCG North POD" },
  { label: "FMCG South", sheetName: "FMCG - South POD" },
  { label: "FMCG West", sheetName: "FMCG West POD" },
  { label: "Gaming", sheetName: "Gaming POD" },
];

// ---- State ---------------------------------------------------------------
let currentView = "overview"; // "overview" | "pod"
let currentPodIndex = 0;
let podRows = [];
let podColumns = []; // every column from the sheet (used for search + summary panels)
let podMainColumns = []; // podColumns minus the detail fields — what the main table shows
let podDetailFields = []; // [{label, col}] shown only when a row is expanded
let expandedRowKeys = new Set(); // row keys currently expanded, persists across refresh ticks
let extraFilterState = {}; // column -> selected value, for the auto-generated filter dropdowns
let sortCol = null;
let sortDir = 1;
let lastSnapshotByKey = {};
let lastPodRenderKey = null;
let summaryRowsCache = null; // last Summary rows, for the AI panel
let loadSeq = 0; // guards against overlapping/stale loads
let inFlight = false; // a fetch is currently running
let lastBgAt = 0; // timestamp of the last completed load
const rendered = { overview: false, pod: false };

// ---- Number helpers ------------------------------------------------------
function parseNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || s === "#N/A" || s === "N/A" || s === "#DIV/0!") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Amount in ₹ Lakhs → readable string.
function fmtLakh(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const a = Math.abs(n);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : 2;
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

// Amount in ₹ Lakhs → ₹ Crore figure string (value only).
function fmtCrore(lakhs) {
  if (lakhs === null || isNaN(lakhs)) return "—";
  return (lakhs / 100).toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function fmtPercent(fraction) {
  if (fraction === null || isNaN(fraction)) return "—";
  return (fraction * 100).toFixed(1) + "%";
}

// Raw rupees → auto-scaled ₹ figure (Cr / L / plain).
function fmtRupees(r) {
  if (r === null || isNaN(r)) return "—";
  const a = Math.abs(r);
  if (a >= 1e7) return "₹" + (r / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " Cr";
  if (a >= 1e5) return "₹" + (r / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " L";
  return "₹" + Math.round(r).toLocaleString("en-IN");
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function slug(s) {
  return "sec-" + String(s || "details").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function setBusy(on) {
  const b = document.getElementById("busy");
  if (b) b.hidden = !on;
}

let dotsTimer = null;
function startLoadingDots() {
  const el = document.getElementById("loadingDots");
  if (!el) return;
  let n = 0;
  if (dotsTimer) clearInterval(dotsTimer);
  dotsTimer = setInterval(() => {
    n = (n + 1) % 4;
    el.textContent = ".".repeat(n);
  }, 450);
}
function stopLoadingDots() {
  if (dotsTimer) clearInterval(dotsTimer);
  dotsTimer = null;
  const el = document.getElementById("loadingDots");
  if (el) el.textContent = "";
}

let pctRafHandle = null;
let pctDisplayed = 0;
let pctTarget = 0;
const PCT_SPEED = 45; // %/second — one constant climb rate, no easing/deceleration

// Chunk-completion progress arrives in uneven bursts; rather than tweening
// toward each new value (which restarts and looks like a series of jumps),
// a single persistent loop chases the latest target at a fixed speed, so the
// big loading percentage always climbs at the same steady rate.
function startLoadingPct() {
  pctDisplayed = 0;
  pctTarget = 0;
  const el = document.getElementById("loadingPct");
  if (el) el.textContent = "";
  if (pctRafHandle) cancelAnimationFrame(pctRafHandle);
  let last = performance.now();
  function step(now) {
    const dt = (now - last) / 1000;
    last = now;
    if (pctDisplayed < pctTarget) {
      pctDisplayed = Math.min(pctTarget, pctDisplayed + PCT_SPEED * dt);
      const val = Math.round(pctDisplayed);
      if (el) el.textContent = val + "%";
      const fillEl = document.getElementById("loadingFill");
      if (fillEl) fillEl.style.width = val + "%";
    }
    pctRafHandle = requestAnimationFrame(step);
  }
  pctRafHandle = requestAnimationFrame(step);
}

function setLoadingPctTarget(target) {
  pctTarget = Math.max(pctTarget, target);
}

function stopLoadingPct() {
  if (pctRafHandle) cancelAnimationFrame(pctRafHandle);
  pctRafHandle = null;
}

function setProgress(frac) {
  const bar = document.getElementById("loadBar");
  if (!bar) return;
  if (frac === null || frac === undefined) {
    bar.hidden = true;
    bar.style.width = "0%";
    return;
  }
  bar.hidden = false;
  bar.style.width = Math.round(frac * 100) + "%";
}

function findColumnIndex(headerRow, keyword) {
  const kw = keyword.toLowerCase();
  return headerRow.findIndex((h) => (h || "").toLowerCase().includes(kw));
}

// ---- Data fetch (JSONP) --------------------------------------------------
function jsonpFetch(url, params, timeoutMs) {
  const timeout = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const cbName = "jsonp_cb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    let done = false;
    const cleanup = () => {
      delete window[cbName];
      script.remove();
    };
    window[cbName] = (data) => {
      done = true;
      resolve(data);
      cleanup();
    };
    script.onerror = () => {
      if (!done) {
        reject(new Error("Couldn't reach the data source (JSONP load failed)."));
        cleanup();
      }
    };
    const qs = new URLSearchParams({ ...params, callback: cbName }).toString();
    script.src = url + (url.includes("?") ? "&" : "?") + qs;
    document.body.appendChild(script);
    setTimeout(() => {
      if (!done) {
        reject(new Error("Timed out. Make sure you're signed into your paytm.com Google account."));
        cleanup();
      }
    }, timeout);
  });
}

// Fetch a whole tab in PAGE_SIZE chunks so large POD sheets don't time out
// and we can report real progress. Backward-compatible with an Apps Script
// that ignores start/limit (it returns everything in the first chunk).
async function fetchTabRows(sheetName, onProgress) {
  let start = 1;
  let total = null;
  let all = [];
  // Safety cap: 200 chunks (200k rows) prevents any infinite loop.
  for (let guard = 0; guard < 200; guard++) {
    const data = await jsonpFetch(
      APPS_SCRIPT_URL,
      {
        key: APPS_SCRIPT_KEY,
        tab: sheetName,
        start: String(start),
        limit: String(PAGE_SIZE),
      },
      90000
    );
    if (data && data.error) throw new Error(data.error);
    const vals = (data && data.values) || [];
    total = data && data.total != null ? Number(data.total) : all.length + vals.length;
    all = all.concat(vals);
    if (onProgress && total > 0) onProgress(Math.min(1, all.length / total));
    start += vals.length;
    if (vals.length === 0 || all.length >= total || vals.length < PAGE_SIZE) break;
  }
  if (onProgress) onProgress(1);
  return all;
}

// ============================================================
// SUMMARY PARSING
// The Summary sheet stacks several tables. Split it into sections:
// a section starts at a single-cell title row, may carry a subtitle
// ("Outstanding amount…"), one header row (detected by keyword), and
// the data rows that follow.
// ============================================================
const HEADER_KEYWORDS = ["3m+ overdue", "target collections", "balance-month start"];

function nonEmptyCount(r) {
  return r.filter((c) => String(c ?? "").trim() !== "").length;
}
function firstText(r) {
  return String(r[0] ?? "").trim();
}
function joinedLower(r) {
  return r.map((c) => String(c ?? "").toLowerCase()).join(" | ");
}

function parseSummarySections(rows) {
  const sections = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.header || cur.rows.length)) sections.push(cur);
    cur = null;
  };

  for (const r of rows) {
    const jl = joinedLower(r);
    const isSubtitle = jl.includes("outstanding amount");
    const isTitle =
      nonEmptyCount(r) === 1 && firstText(r) !== "" && parseNumber(firstText(r)) === null && !isSubtitle;
    const isHeader = nonEmptyCount(r) >= 3 && HEADER_KEYWORDS.some((k) => jl.includes(k));
    const isBlank = nonEmptyCount(r) === 0;

    if (isSubtitle) {
      if (!cur) cur = { title: "", subtitle: "", header: null, rows: [] };
      cur.subtitle = "₹ Lakhs";
      continue;
    }
    if (isTitle) {
      flush();
      cur = { title: firstText(r), subtitle: "", header: null, rows: [] };
      continue;
    }
    if (!cur) cur = { title: "", subtitle: "", header: null, rows: [] };
    if (isHeader) {
      cur.header = r;
      continue;
    }
    if (isBlank) continue;
    cur.rows.push(r);
  }
  flush();

  // Disambiguate repeated titles (two "Summary - All Debtors" tables).
  const seen = {};
  sections.forEach((s) => {
    if (!s.title) return;
    if (seen[s.title]) s.title = s.title + " (grouped)";
    else seen[s.title] = true;
  });
  return sections;
}

function findSection(sections, keyword) {
  const kw = keyword.toLowerCase();
  return sections.find((s) => s.title.toLowerCase().includes(kw));
}

// ============================================================
// OVERVIEW RENDER
// ============================================================
function renderOverview(rows) {
  document.getElementById("podView").hidden = true;
  document.getElementById("overviewView").hidden = false;
  summaryRowsCache = rows;

  const sections = parseSummarySections(rows);

  renderKpis(sections);
  renderCategoryChart(sections);
  renderPodChart(sections);
  renderTargetMeters(sections);
  renderSummaryTables(sections);
}

function renderKpis(sections) {
  const el = document.getElementById("kpiRow");
  const s = findSection(sections, "summary - all debtors");
  if (!s || !s.header) {
    el.innerHTML = "";
    return;
  }
  const h = s.header;
  const totalRow = s.rows.find((r) => /^total/i.test(firstText(r)));
  if (!totalRow) {
    el.innerHTML = "";
    return;
  }

  const iMonthStart = findColumnIndex(h, "total os");
  const iCollected = findColumnIndex(h, "collected this month");
  const iCurrent = findColumnIndex(h, "current balance");

  const monthStart = parseNumber(totalRow[iMonthStart]);
  const collected = parseNumber(totalRow[iCollected]);
  const current = parseNumber(totalRow[iCurrent]);
  const overdue3m = parseNumber(totalRow[iCurrent + 1]);
  const underCredit = parseNumber(totalRow[iCurrent + 3]);

  const tiles = [];

  // Total outstanding, delta vs month start (a drop is good).
  let foot = "";
  if (monthStart) {
    const pct = ((current - monthStart) / monthStart) * 100;
    const down = pct <= 0;
    foot = `<span class="delta ${down ? "up-good" : "down-bad"}">${down ? "▼" : "▲"} ${Math.abs(pct).toFixed(1)}%</span> vs month start`;
  }
  tiles.push(kpiTile("Total outstanding", fmtCrore(current), "Cr", "", foot));

  tiles.push(kpiTile("Collected this month", fmtCrore(collected), "Cr", "accent-good", "month to date"));

  const share = current ? Math.round((overdue3m / current) * 100) : null;
  tiles.push(
    kpiTile("3M+ overdue", fmtCrore(overdue3m), "Cr", "accent-crit", share != null ? `${share}% of the book` : "")
  );

  tiles.push(kpiTile("Under credit", fmtCrore(underCredit), "Cr", "accent-warn", "not yet due"));

  el.innerHTML = tiles.join("");
}

function kpiTile(label, value, unit, accentClass, footHtml) {
  return `<div class="kpi ${accentClass}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">₹${value}<span class="unit">${unit}</span></div>
    <div class="kpi-foot">${footHtml || ""}</div>
  </div>`;
}

// Extract {labels, values} of the "Current Balance" column for the
// non-total, non-auxiliary data rows of a section.
function balanceSeries(section) {
  if (!section || !section.header) return { labels: [], values: [] };
  const iCurrent = findColumnIndex(section.header, "current balance");
  const col = iCurrent === -1 ? section.header.length - 4 : iCurrent;
  const labels = [];
  const values = [];
  section.rows.forEach((r) => {
    const label = firstText(r);
    if (!label) return;
    if (/^total/i.test(label)) return;
    if (/salience|cohort|% collection/i.test(label)) return;
    const v = parseNumber(r[col]);
    if (v === null) return;
    labels.push(label);
    values.push(v);
  });
  return { labels, values };
}

function upsertChart(refKey, canvasId, config) {
  if (window[refKey]) {
    window[refKey].data = config.data;
    window[refKey].options = config.options;
    window[refKey].update();
  } else {
    window[refKey] = new Chart(document.getElementById(canvasId), config);
  }
}

function baseBarOptions({ horizontal }) {
  const muted = cssVar("--muted");
  const grid = cssVar("--grid");
  const line = cssVar("--line");
  const valueAxis = {
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    ticks: { color: muted, callback: (v) => fmtLakh(v) },
  };
  const catAxis = {
    grid: { display: false },
    border: { color: line },
    ticks: { color: muted, autoSkip: false },
  };
  return {
    indexAxis: horizontal ? "y" : "x",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => " ₹" + fmtLakh(horizontal ? c.parsed.x : c.parsed.y) + " L",
        },
      },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

function renderCategoryChart(sections) {
  const s = findSection(sections, "category wise");
  const { labels, values } = balanceSeries(s);
  const colors = [cssVar("--s1"), cssVar("--s2"), cssVar("--s3"), cssVar("--s4"), cssVar("--s5")];
  upsertChart("_categoryChart", "categoryChart", {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderRadius: 4, maxBarThickness: 40 }],
    },
    options: baseBarOptions({ horizontal: false }),
  });
}

function renderPodChart(sections) {
  const s = findSection(sections, "direct advertiser");
  const { labels, values } = balanceSeries(s);
  upsertChart("_podChart", "podChart", {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: cssVar("--s1"), borderRadius: 4, maxBarThickness: 22 }],
    },
    options: baseBarOptions({ horizontal: true }),
  });
}

function renderTargetMeters(sections) {
  const panel = document.getElementById("targetPanel");
  const el = document.getElementById("targetMeters");
  const s = findSection(sections, "collection target");
  if (!s || !s.header) {
    panel.hidden = true;
    return;
  }
  const iAch = findColumnIndex(s.header, "% ach");
  if (iAch === -1) {
    panel.hidden = true;
    return;
  }
  const meters = [];
  s.rows.forEach((r) => {
    const label = firstText(r);
    if (!label || /^total/i.test(label)) return;
    const frac = parseNumber(r[iAch]);
    if (frac === null) return;
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    const cls = frac >= 0.75 ? "good" : frac >= 0.4 ? "" : frac >= 0.2 ? "warn" : "low";
    meters.push(`<div class="meter">
      <span class="meter-label">${label}</span>
      <span class="meter-track"><span class="meter-fill ${cls}" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="meter-val">${(frac * 100).toFixed(0)}%</span>
    </div>`);
  });
  if (!meters.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  el.innerHTML = meters.join("");
}

function renderSummaryTables(sections) {
  const container = document.getElementById("summaryTables");
  const nav = document.getElementById("tableNav");
  container.innerHTML = "";
  nav.innerHTML = "";

  const label = document.createElement("span");
  label.className = "table-nav-label";
  label.textContent = "Jump to:";
  nav.appendChild(label);

  sections.forEach((s) => {
    if (!s.header && s.rows.length === 0) return;
    const id = slug(s.title);
    const card = buildSummaryCard(s);
    card.id = id;
    container.appendChild(card);

    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = s.title || "Details";
    chip.addEventListener("click", () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(chip);
  });
}

function buildSummaryCard(section) {
  const card = document.createElement("div");
  card.className = "panel summary-card";

  const head = document.createElement("div");
  head.className = "panel-head";
  head.innerHTML =
    `<h3 class="panel-title">${section.title || "Details"}</h3>` +
    (section.subtitle ? `<span class="panel-sub">${section.subtitle}</span>` : "");
  card.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "summary-scroll";

  const header = section.header || [];
  // Drop the duplicated label column (e.g. "Status","Status").
  const dropDupCol =
    header.length > 1 && String(header[0] ?? "").trim() === String(header[1] ?? "").trim() && header[0];
  const keep = header.map((_, i) => i).filter((i) => !(dropDupCol && i === 1));

  // Per-column percent flag (columns whose header contains "%").
  const pctCol = keep.map((i) => /%/.test(String(header[i] ?? "")));

  const table = buildSortableSummaryTable(header, keep, pctCol, section.rows);
  scroll.appendChild(table);
  card.appendChild(scroll);
  return card;
}

function summaryCellText(r, colIdx, k, pctCol, isTotal, isAux) {
  const raw = r[colIdx];
  if (k === 0) {
    return { text: raw === undefined || raw === "" ? (isTotal ? "Total" : "") : String(raw), neg: false };
  }
  const n = parseNumber(raw);
  if (n === null) {
    return { text: raw === undefined ? "" : String(raw).trim() === "#DIV/0!" ? "—" : String(raw), neg: false };
  }
  if (pctCol[k] || isAux) return { text: fmtPercent(n), neg: false };
  return { text: fmtLakh(n), neg: n < 0 };
}

// Builds a <table> whose headers sort the rows (numeric-aware) on click,
// re-rendering the body in place; column 0 (the label) sorts alphabetically.
function buildSortableSummaryTable(header, keep, pctCol, rows) {
  const table = document.createElement("table");
  table.className = "summary-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);

  let sortK = null;
  let sortDir = 1;

  function renderHead() {
    thead.innerHTML = "";
    if (!header.length) return;
    const tr = document.createElement("tr");
    keep.forEach((i, k) => {
      const th = document.createElement("th");
      const label = String(header[i] ?? "").replace(/\n/g, " ").trim();
      const isSorted = sortK === k;
      th.textContent = label + (isSorted ? (sortDir === 1 ? " ▲" : " ▼") : "");
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.setAttribute("aria-sort", isSorted ? (sortDir === 1 ? "ascending" : "descending") : "none");
      const doSort = () => {
        sortDir = sortK === k ? -sortDir : 1;
        sortK = k;
        renderHead();
        renderBody();
      };
      th.addEventListener("click", doSort);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          doSort();
        }
      });
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  }

  function renderBody() {
    let ordered = rows;
    if (sortK !== null) {
      const colIdx = keep[sortK];
      ordered = [...rows].sort((a, b) => {
        const av = a[colIdx];
        const bv = b[colIdx];
        const an = parseNumber(av);
        const bn = parseNumber(bv);
        let cmp;
        if (sortK !== 0 && an !== null && bn !== null) cmp = an - bn;
        else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        return cmp * sortDir;
      });
    }
    tbody.innerHTML = "";
    ordered.forEach((r) => {
      const label = firstText(r);
      const isTotal = /^total/i.test(label) || label === "";
      const isAux = /salience|cohort|% collection/i.test(label);
      const tr = document.createElement("tr");
      if (isTotal) tr.className = "is-total";
      else if (isAux) tr.className = "is-aux";

      keep.forEach((colIdx, k) => {
        const td = document.createElement("td");
        const { text, neg } = summaryCellText(r, colIdx, k, pctCol, isTotal, isAux);
        td.textContent = text;
        if (neg) td.className = "num-neg";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  renderHead();
  renderBody();
  return table;
}

// ============================================================
// POD DETAIL RENDER
// ============================================================
function renderPodCards(rows, columns) {
  const findCol = (kw) => columns.find((c) => c.toLowerCase().includes(kw.toLowerCase()));
  const amountCol = findCol("amount");
  const collectedCol = columns.find((c) => c.toLowerCase() === "collected");
  const balanceCol = findCol("balance");
  const statusCol = findCol("collected/not collected") || findCol("collected/ not collected");
  const sum = (col) => rows.reduce((acc, r) => acc + (parseNumber(r[col]) ?? 0), 0);

  const cards = [{ label: "Invoices", value: rows.length.toLocaleString("en-IN"), accent: "" }];
  if (amountCol) cards.push({ label: "Total amount", value: fmtRupees(sum(amountCol)), accent: "" });
  if (balanceCol) cards.push({ label: "Balance outstanding", value: fmtRupees(sum(balanceCol)), accent: "accent-crit" });
  if (collectedCol) cards.push({ label: "Collected", value: fmtRupees(sum(collectedCol)), accent: "accent-good" });
  if (statusCol) {
    const pending = rows.filter((r) => (r[statusCol] || "").trim() && !/^collected$/i.test((r[statusCol] || "").trim())).length;
    cards.push({ label: "Pending items", value: pending.toLocaleString("en-IN"), accent: "accent-warn" });
  }

  document.getElementById("podCards").innerHTML = cards
    .map((c) => `<div class="kpi ${c.accent}"><div class="kpi-label">${c.label}</div><div class="kpi-value" style="font-size:22px">${c.value}</div></div>`)
    .join("");
  return statusCol;
}

function podFindCol(columns, ...keywords) {
  for (const kw of keywords) {
    const c = columns.find((col) => col.toLowerCase().includes(kw.toLowerCase()));
    if (c) return c;
  }
  return null;
}

// The reference fields that only show up in a row's expanded detail panel —
// kept out of the main table so it stays scannable. Matched by keyword since
// the sheet's exact header text can vary.
const DETAIL_FIELD_SPECS = [
  { label: "Unique Number", keywords: ["unique number", "unique no", "uid"] },
  { label: "Invoice", keywords: ["invoice number", "invoice no", "invoice"] },
  { label: "Document Number", keywords: ["document number", "doc number", "document no"] },
  { label: "Service", keywords: ["service"] },
  { label: "Material Description", keywords: ["material description", "material desc"] },
  { label: "PO", keywords: ["po number", "po no", "purchase order", "po"] },
];

function normalizeHeader(s) {
  return " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}
function headerMatchesKeyword(header, keyword) {
  return normalizeHeader(header).includes(normalizeHeader(keyword));
}

// Resolve each spec to at most one real column, first-match-wins, so no
// column is claimed by two detail fields.
function pickDetailFields(columns) {
  const used = new Set();
  const fields = [];
  DETAIL_FIELD_SPECS.forEach((spec) => {
    for (const kw of spec.keywords) {
      const found = columns.find((c) => !used.has(c) && headerMatchesKeyword(c, kw));
      if (found) {
        used.add(found);
        fields.push({ label: spec.label, col: found });
        break;
      }
    }
  });
  return fields;
}

// Any remaining (main-table) column whose values cluster into a small,
// bounded set of options is worth a filter dropdown — this is what makes
// "as many useful filters as possible" adapt to whatever the sheet has.
const MAX_FILTER_UNIQUE = 30;
const MAX_EXTRA_FILTERS = 6;
function computeFilterableColumns(rows, mainColumns, excludeCol) {
  const candidates = [];
  mainColumns.forEach((col) => {
    if (col === excludeCol) return;
    const values = new Set();
    for (const r of rows) {
      const v = (r[col] || "").toString().trim();
      if (v) values.add(v);
      if (values.size > MAX_FILTER_UNIQUE) break;
    }
    if (values.size >= 2 && values.size <= MAX_FILTER_UNIQUE) {
      candidates.push({ col, values: [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
    }
  });
  return candidates.slice(0, MAX_EXTRA_FILTERS);
}

function renderExtraFilters(rows, mainColumns, excludeCol) {
  const host = document.getElementById("extraFilters");
  if (!host) return;
  const filterable = computeFilterableColumns(rows, mainColumns, excludeCol);
  const keepCols = new Set(filterable.map((f) => f.col));
  Object.keys(extraFilterState).forEach((c) => {
    if (!keepCols.has(c)) delete extraFilterState[c];
  });

  host.innerHTML = "";
  filterable.forEach(({ col, values }) => {
    const wrap = document.createElement("label");
    wrap.className = "extra-filter";
    const span = document.createElement("span");
    span.className = "extra-filter-label";
    span.textContent = col;
    const select = document.createElement("select");
    select.innerHTML =
      `<option value="">All ${escapeHtml(col)}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    const prev = extraFilterState[col];
    if (prev && values.includes(prev)) select.value = prev;
    select.addEventListener("change", () => {
      extraFilterState[col] = select.value;
      renderPodTable();
    });
    wrap.appendChild(span);
    wrap.appendChild(select);
    host.appendChild(wrap);
  });
}

// A stable per-transaction key so expand/collapse state survives refresh
// ticks. Prefers the Unique Number detail field; falls back to a composite
// of the other detail fields, then row position as a last resort.
function rowKey(r, idx) {
  const uf = podDetailFields.find((f) => f.label === "Unique Number");
  if (uf && String(r[uf.col] ?? "").trim()) return "u:" + String(r[uf.col]).trim();
  const composite = podDetailFields.map((f) => String(r[f.col] ?? "").trim()).join("|");
  if (composite.replace(/\|/g, "")) return "c:" + composite;
  return "i:" + idx;
}

const AGING_BUCKETS = [
  { key: "Under credit", re: /under\s*credit/i, color: "--s1" },
  { key: "1–30 days", re: /1\s*-\s*30/, color: "--good" },
  { key: "31–60 days", re: /31\s*-\s*60/, color: "--s4" },
  { key: "61–90 days", re: /61\s*-\s*90/, color: "--warning" },
  { key: "91–180 days", re: /91\s*-\s*180/, color: "--serious" },
  { key: "181–365 days", re: /181\s*-\s*365/, color: "--critical" },
  { key: "365+ days", re: /more than 365|365\s*\+|>\s*365/i, color: "--critical" },
];

function miniPanel(title, bodyHtml) {
  return `<div class="panel"><div class="panel-head"><h3 class="panel-title">${title}</h3></div>${bodyHtml}</div>`;
}

function renderPodSummary(rows, columns) {
  const host = document.getElementById("podSummary");
  const panels = [];
  const sum = (col) => rows.reduce((a, r) => a + (parseNumber(r[col]) ?? 0), 0);

  const balanceCol = podFindCol(columns, "balance");
  const statusCol = podFindCol(columns, "collected/not collected", "collected/ not collected");
  const customerCol = podFindCol(columns, "customer name");
  const etaMonthCol = columns.find((c) => /eta.*month/i.test(c));
  const valueCol = columns.find((c) => /^value$/i.test(c.trim())) || null;

  // Aging profile (bar per bucket)
  const buckets = [];
  AGING_BUCKETS.forEach((b) => {
    const col = columns.find((c) => b.re.test(c));
    if (col) buckets.push({ label: b.key, color: b.color, amount: sum(col) });
  });
  if (buckets.length >= 2) {
    const max = Math.max(1, ...buckets.map((b) => Math.abs(b.amount)));
    const body = buckets
      .map((b) => {
        const w = Math.max(0, (Math.abs(b.amount) / max) * 100);
        return `<div class="aging-row">
          <span class="aging-label">${b.label}</span>
          <span class="aging-track"><span class="aging-fill" style="width:${w.toFixed(1)}%;background:var(${b.color})"></span></span>
          <span class="aging-val">${fmtRupees(b.amount)}</span>
        </div>`;
      })
      .join("");
    panels.push(miniPanel("Aging profile", body));
  }

  // Status breakdown
  if (statusCol) {
    const groups = {};
    rows.forEach((r) => {
      const k = (r[statusCol] || "").trim() || "—";
      if (!groups[k]) groups[k] = { count: 0, bal: 0 };
      groups[k].count++;
      if (balanceCol) groups[k].bal += parseNumber(r[balanceCol]) ?? 0;
    });
    const entries = Object.entries(groups).sort((a, b) => b[1].bal - a[1].bal);
    const body = entries
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.count}</td><td>${balanceCol ? fmtRupees(v.bal) : "—"}</td></tr>`)
      .join("");
    panels.push(
      miniPanel(
        "Status breakdown",
        `<table class="mini-table"><thead><tr><th>Status</th><th>Invoices</th><th>Balance</th></tr></thead><tbody>${body}</tbody></table>`
      )
    );
  }

  // Expected collections by ETA month
  if (etaMonthCol) {
    const groups = {};
    rows.forEach((r) => {
      const k = (r[etaMonthCol] || "").trim();
      if (!k) return;
      if (!groups[k]) groups[k] = { count: 0, val: 0 };
      let add = parseNumber(r[valueCol]);
      if (add === null) add = balanceCol ? parseNumber(r[balanceCol]) ?? 0 : 0;
      groups[k].count++;
      groups[k].val += add;
    });
    const entries = Object.entries(groups).sort((a, b) => b[1].val - a[1].val).slice(0, 10);
    if (entries.length) {
      const body = entries
        .map(([k, v]) => `<tr><td>${k}</td><td>${v.count}</td><td>${fmtRupees(v.val)}</td></tr>`)
        .join("");
      panels.push(
        miniPanel(
          "Expected collections by ETA",
          `<table class="mini-table"><thead><tr><th>ETA month</th><th>Invoices</th><th>Expected</th></tr></thead><tbody>${body}</tbody></table>`
        )
      );
    }
  }

  // Top debtors by balance
  if (customerCol && balanceCol) {
    const byCust = {};
    rows.forEach((r) => {
      const k = (r[customerCol] || "").trim();
      if (!k) return;
      byCust[k] = (byCust[k] || 0) + (parseNumber(r[balanceCol]) ?? 0);
    });
    const top = Object.entries(byCust).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      const body = top.map(([k, v]) => `<tr><td title="${k}">${k}</td><td>${fmtRupees(v)}</td></tr>`).join("");
      panels.push(
        miniPanel(
          "Top debtors by balance",
          `<table class="mini-table"><thead><tr><th>Customer</th><th>Balance</th></tr></thead><tbody>${body}</tbody></table>`
        )
      );
    }
  }

  host.innerHTML = panels.join("");
}

function cellContent(r, c, statusColName) {
  const val = r[c] ?? "";
  if (c === statusColName && val) {
    const isCollected = /^collected$/i.test(String(val).trim());
    return { html: `<span class="status-pill ${isCollected ? "status-collected" : "status-pending"}">${val}</span>`, isHtml: true };
  }
  return { html: String(val), isHtml: false };
}

// Main row: a leading expand toggle cell, then one cell per main column.
// The toggle is a real <button> (not just a clickable <tr>) so keyboard and
// screen-reader users can open the detail panel, not only mouse users.
function buildMainRow(r, columns, statusColName, key, expanded) {
  const tr = document.createElement("tr");
  tr.className = "pod-row" + (expanded ? " expanded" : "");
  tr.dataset.key = key;
  const toggleTd = document.createElement("td");
  toggleTd.className = "expand-toggle";
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "expand-btn";
  toggleBtn.textContent = expanded ? "▾" : "▸";
  toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggleBtn.setAttribute("aria-label", expanded ? "Hide transaction details" : "Show transaction details");
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // avoid double-toggling via the row's own click handler
    toggleExpand(key);
  });
  toggleTd.appendChild(toggleBtn);
  tr.appendChild(toggleTd);
  columns.forEach((c) => {
    const td = document.createElement("td");
    const { html, isHtml } = cellContent(r, c, statusColName);
    if (isHtml) td.innerHTML = html;
    else td.textContent = html;
    tr.appendChild(td);
  });
  tr.addEventListener("click", () => toggleExpand(key));
  return tr;
}

// Sub-row shown only while expanded: the reference/detail fields as
// label:value pairs, spanning under the main row's columns.
function buildDetailRow(r, detailFields, columns) {
  const tr = document.createElement("tr");
  tr.className = "pod-detail-row";
  const td = document.createElement("td");
  td.colSpan = columns.length + 1;
  const items = detailFields
    .map(
      (f) =>
        `<div class="dd-item"><span class="dd-label">${escapeHtml(f.label)}</span><span class="dd-value">${
          escapeHtml(String(r[f.col] ?? "").trim() || "—")
        }</span></div>`
    )
    .join("");
  td.innerHTML = `<div class="pod-detail-grid">${items || '<span class="muted">No additional details</span>'}</div>`;
  tr.appendChild(td);
  return tr;
}

function toggleExpand(key) {
  if (expandedRowKeys.has(key)) expandedRowKeys.delete(key);
  else expandedRowKeys.add(key);
  renderPodTable();
}

function flashCell(td) {
  td.classList.remove("cell-flash");
  void td.offsetWidth;
  td.classList.add("cell-flash");
}

function updateRowInPlace(tr, r, columns, statusColName) {
  const cells = tr.children; // cells[0] is the expand toggle, columns start at 1
  columns.forEach((c, i) => {
    const td = cells[i + 1];
    if (!td) return;
    const { html, isHtml } = cellContent(r, c, statusColName);
    if (isHtml) {
      if (td.innerHTML !== html) {
        td.innerHTML = html;
        flashCell(td);
      }
    } else if (td.textContent !== html) {
      td.textContent = html;
      flashCell(td);
    }
  });
}

function renderPodTable() {
  const tableWrap = document.querySelector(".table-wrap");
  const prevScrollTop = tableWrap.scrollTop;
  const searchTerm = document.getElementById("searchBox").value.trim().toLowerCase();
  const statusVal = document.getElementById("statusFilter").value;
  const statusCol = document.getElementById("statusFilter").dataset.col;

  let filtered = podRows.filter((r) => {
    if (statusVal && statusCol && (r[statusCol] || "").trim() !== statusVal) return false;
    for (const col in extraFilterState) {
      const val = extraFilterState[col];
      if (val && (r[col] || "").trim() !== val) return false;
    }
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

  // Rebuild the whole table when the POD, columns, sort, filters, or expanded
  // rows change; otherwise diff cells in place so the periodic refresh
  // doesn't flicker.
  const extraFilterKey = Object.keys(extraFilterState)
    .map((c) => c + "=" + extraFilterState[c])
    .join("&");
  const expandedKey = [...expandedRowKeys].sort().join(",");
  const renderKey =
    currentPodIndex + "" + podMainColumns.join("") + sortCol + sortDir + statusVal + searchTerm + extraFilterKey + expandedKey;
  const structuralChange = lastPodRenderKey !== renderKey;
  lastPodRenderKey = renderKey;

  const statusColName = statusCol;
  const visibleRows = filtered.slice(0, 2000);
  const tbody = document.querySelector("#podTable tbody");
  const existingMainTrs = tbody.querySelectorAll("tr.pod-row");

  if (structuralChange || existingMainTrs.length !== visibleRows.length) {
    const thead = document.querySelector("#podTable thead");
    thead.innerHTML = "";
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th")); // expand-toggle column
    podMainColumns.forEach((c) => {
      const th = document.createElement("th");
      const isSorted = sortCol === c;
      th.textContent = c + (isSorted ? (sortDir === 1 ? " ▲" : " ▼") : "");
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.setAttribute("aria-sort", isSorted ? (sortDir === 1 ? "ascending" : "descending") : "none");
      const doSort = () => {
        sortDir = sortCol === c ? -sortDir : 1;
        sortCol = c;
        renderPodTable();
      };
      th.addEventListener("click", doSort);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          doSort();
        }
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    tbody.innerHTML = "";
    if (visibleRows.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty-state";
      const td = document.createElement("td");
      td.colSpan = podMainColumns.length + 1;
      td.textContent = podRows.length === 0 ? "This POD has no transactions." : "No transactions match the current filters.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      visibleRows.forEach((r, idx) => {
        const key = rowKey(r, idx);
        const expanded = expandedRowKeys.has(key);
        tbody.appendChild(buildMainRow(r, podMainColumns, statusColName, key, expanded));
        if (expanded) tbody.appendChild(buildDetailRow(r, podDetailFields, podMainColumns));
      });
    }
  } else {
    visibleRows.forEach((r, i) => {
      const tr = existingMainTrs[i];
      updateRowInPlace(tr, r, podMainColumns, statusColName);
      if (expandedRowKeys.has(tr.dataset.key)) {
        const detailTr = tr.nextElementSibling;
        if (detailTr && detailTr.classList.contains("pod-detail-row")) {
          detailTr.innerHTML = buildDetailRow(r, podDetailFields, podMainColumns).innerHTML;
        }
      }
    });
  }

  tableWrap.scrollTop = prevScrollTop;
}

function renderPod(rows) {
  document.getElementById("overviewView").hidden = true;
  document.getElementById("podView").hidden = false;
  document.getElementById("podHeading").textContent = PODS[currentPodIndex].label + " POD";

  if (!rows.length) throw new Error("This POD returned no data.");
  podColumns = rows[0].map((c) => (c || "").trim()).filter((c) => c !== "");
  const numCols = rows[0].length;
  podRows = rows
    .slice(1)
    .filter((r) => r.some((cell) => (cell || "").trim() !== ""))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < numCols; i++) {
        const key = (rows[0][i] || "").trim();
        if (key) obj[key] = r[i];
      }
      return obj;
    });

  podDetailFields = pickDetailFields(podColumns);
  const detailColSet = new Set(podDetailFields.map((f) => f.col));
  podMainColumns = podColumns.filter((c) => !detailColSet.has(c));

  const statusCol = renderPodCards(podRows, podColumns);
  renderPodSummary(podRows, podColumns);

  const statusFilter = document.getElementById("statusFilter");
  const previousSelection = statusFilter.value;
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
    if (uniqueVals.includes(previousSelection)) statusFilter.value = previousSelection;
  }

  renderExtraFilters(podRows, podMainColumns, statusCol);
  renderPodTable();
}

// ============================================================
// LOAD / REFRESH
// ============================================================
function currentKey() {
  return currentView === "overview" ? SUMMARY_SHEET : PODS[currentPodIndex].sheetName;
}

async function loadCurrent(opts = {}) {
  const background = !!opts.background;
  const key = currentKey();
  const seq = ++loadSeq;
  inFlight = true;
  const loadingEl = document.getElementById("loadingMsg");
  const loadingLabelEl = document.getElementById("loadingLabel");
  const loadingFillEl = document.getElementById("loadingFill");
  const loadingNoteEl = document.getElementById("loadingNote");
  const errorEl = document.getElementById("errorMsg");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  const isPodLoad = currentView === "pod";
  const loadTitle = isPodLoad ? PODS[currentPodIndex].label : "Overview";

  // First paint of a view shows the big centered card; after that we keep
  // the current content on screen and only show a small "busy" spinner, so a
  // refresh or a view/POD switch never blanks the dashboard.
  const firstPaint = !rendered[currentView];
  if (!background) {
    errorEl.hidden = true;
    if (firstPaint) {
      document.getElementById("overviewView").hidden = true;
      document.getElementById("podView").hidden = true;
      loadingFillEl.style.width = "0%";
      loadingLabelEl.textContent = isPodLoad ? `Loading POD Level Details — ${loadTitle}` : "Loading " + loadTitle;
      loadingNoteEl.hidden = !isPodLoad;
      loadingEl.hidden = false;
      startLoadingDots();
      startLoadingPct();
    } else {
      setBusy(true);
    }
  }

  // Progress UI only for foreground loads (never flash it on background ticks).
  const onProgress = background
    ? null
    : (frac) => {
        if (seq !== loadSeq) return;
        setProgress(frac);
        const pct = Math.round(frac * 100);
        if (firstPaint) {
          setLoadingPctTarget(pct);
        } else {
          lastUpdatedEl.textContent = `Loading… ${pct}%`;
        }
      };

  try {
    const rows = await fetchTabRows(key, onProgress);
    if (seq !== loadSeq) return; // a newer load superseded this one

    const snapshot = JSON.stringify(rows);
    if (background && lastSnapshotByKey[key] === snapshot) {
      lastUpdatedEl.textContent = "Live · checked " + nowTime();
      return;
    }
    lastSnapshotByKey[key] = snapshot;

    if (currentView === "overview") renderOverview(rows);
    else renderPod(rows);
    rendered[currentView] = true;

    errorEl.hidden = true;
    lastUpdatedEl.textContent = "Live · updated " + nowTime();
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    if (!background) {
      errorEl.hidden = false;
      errorEl.textContent = "Couldn't load data.\n\n" + (err && err.message ? err.message : err);
    }
  } finally {
    if (seq === loadSeq) {
      inFlight = false;
      lastBgAt = Date.now();
      if (!background) {
        loadingEl.hidden = true;
        setBusy(false);
        setProgress(null);
        stopLoadingDots();
        stopLoadingPct();
      }
    }
  }
}

// ---- View switching ------------------------------------------------------
function showView(view) {
  currentView = view;
  document.querySelectorAll(".viewnav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("podPicker").hidden = view !== "pod";
  loadCurrent({ background: false });
}

// ---- Auto refresh --------------------------------------------------------
let refreshTimer = null;
let autoRefreshPaused = false;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  // Tick often, but only actually refresh once the view's cadence has elapsed
  // (Overview is light and refreshes at 7s; POD data is heavy — every 30s).
  refreshTimer = setInterval(() => {
    if (autoRefreshPaused || inFlight || document.visibilityState !== "visible") return;
    const gap = currentView === "overview" ? REFRESH_INTERVAL_MS : POD_REFRESH_MS;
    if (Date.now() - lastBgAt < gap) return;
    loadCurrent({ background: true });
  }, 2000);
}

function setPaused(paused) {
  autoRefreshPaused = paused;
  document.getElementById("pauseBtn").textContent = paused ? "▶ Resume" : "⏸ Pause";
  document.getElementById("liveDot").classList.toggle("paused", paused);
}

// ---- Gemini AI (answers only from the Summary tab) -----------------------
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal, safe Markdown → HTML for Gemini's answers: escapes everything
// first (so no raw HTML/script can slip through), then only recognizes
// **bold**, "* "/"- " bullet lists, and paragraph breaks.
function mdToHtml(raw) {
  const lines = escapeHtml(raw).split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (/^[*-]\s+/.test(trimmed)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += "<li>" + trimmed.replace(/^[*-]\s+/, "") + "</li>";
    } else if (trimmed === "") {
      closeList();
    } else {
      closeList();
      html += "<p>" + trimmed + "</p>";
    }
  });
  closeList();
  return html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

async function askGemini(question) {
  const answerEl = document.getElementById("aiAnswer");
  answerEl.hidden = false;
  answerEl.textContent = "Thinking…";
  try {
    const data = await jsonpFetch(APPS_SCRIPT_URL, { key: APPS_SCRIPT_KEY, ai: question }, 45000);
    if (data && data.error) throw new Error(data.error);
    const answer = (data && data.answer ? data.answer : "").trim();
    answerEl.innerHTML = answer ? mdToHtml(answer) : "No answer returned.";
  } catch (err) {
    answerEl.textContent = "AI error: " + (err && err.message ? err.message : err);
  }
}

function initAi() {
  document.getElementById("aiForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("aiInput").value.trim();
    if (q) askGemini(q);
  });
}

// ---- Init ----------------------------------------------------------------
function init() {
  const podSelect = document.getElementById("podSelect");
  PODS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.label;
    podSelect.appendChild(opt);
  });
  podSelect.addEventListener("change", () => {
    currentPodIndex = Number(podSelect.value);
    sortCol = null;
    sortDir = 1;
    expandedRowKeys.clear();
    loadCurrent({ background: false });
  });

  document.querySelectorAll(".viewnav-btn").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });

  document.getElementById("refreshBtn").addEventListener("click", () => loadCurrent({ background: false }));
  document.getElementById("pauseBtn").addEventListener("click", () => setPaused(!autoRefreshPaused));
  document.getElementById("searchBox").addEventListener("input", renderPodTable);
  document.getElementById("statusFilter").addEventListener("change", renderPodTable);

  initAi();
  showView("overview");
  startAutoRefresh();
}

init();
