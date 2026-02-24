function parseDateTime(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeSpaces(line) {
  if (line.includes("\t")) return line;
  return line.replace(/\s{2,}/g, "\t");
}

function isStatus(action) {
  return String(action || "").trim().startsWith("Статус");
}

function parsePasted(raw) {
  const lines = (raw || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];

  for (const line0 of lines) {
    const line = normalizeSpaces(line0);
    const parts = line.split("\t").map(p => p.trim()).filter(p => p !== "");

    const dtStr = parts[parts.length - 1];
    const dt = parseDateTime(dtStr);
    if (!dt) continue;

    const action = parts[1] || "";
    const operator = parts[2] || "";
    rows.push({ action, operator, dt });
  }

  rows.sort((a, b) => a.dt - b.dt);
  return rows;
}

function calculate(rows, opts) {
  const {
    operator,
    startStr,
    endStr,
    minGapSec,
    gapWarnMin,
    acwModeB
  } = opts;

  let r = rows.slice();
  if (operator !== "__ALL__") r = r.filter(x => x.operator === operator);
  r.sort((a, b) => a.dt - b.dt);

  const windowStart = startStr ? parseDateTime(startStr) : (r[0]?.dt || null);
  const windowEnd = endStr ? parseDateTime(endStr) : (r[r.length - 1]?.dt || null);

  if (!windowStart || !windowEnd || windowEnd <= windowStart || r.length < 2) {
    return { totals: new Map(), intervals: [], windowStart, windowEnd, used: r.length };
  }

  const totals = new Map();
  const intervals = [];

  const minGapMs = Math.max(0, Number(minGapSec || 0)) * 1000;
  const gapWarnMs = Math.max(0, Number(gapWarnMin || 0)) * 60 * 1000;

  let currentStatus = null;
  let inOrder = false;

  // init state before window start
  for (let i = 0; i < r.length; i++) {
    if (r[i].dt <= windowStart) {
      const act0 = (r[i].action || "").trim();
      if (isStatus(act0)) currentStatus = act0;
      if (act0 === "Открытие заказа") inOrder = true;
      if (act0 === "Закрытие заказа") inOrder = false;
    }
    if (r[i].dt > windowStart) break;
  }

  for (let i = 0; i < r.length - 1; i++) {
    const cur = r[i];
    const next = r[i + 1];

    const act = (cur.action || "").trim();

    if (act === "Открытие заказа") inOrder = true;
    if (act === "Закрытие заказа") inOrder = false;

    if (isStatus(act)) {
      currentStatus = act;
    }

    // Вариант B: после закрытия время идёт в "Статус в работе"
    if (acwModeB && act === "Закрытие заказа") {
      currentStatus = "Статус в работе";
    }

    let a = cur.dt;
    let b = next.dt;

    if (b <= windowStart || a >= windowEnd) continue;
    if (a < windowStart) a = windowStart;
    if (b > windowEnd) b = windowEnd;
    if (b <= a) continue;

    const ms = b - a;
    if (ms < minGapMs) continue;

    let credited = Boolean(currentStatus);

    // Пост-обработка засчитывается только внутри заказа
    if (currentStatus === "Статус пост-обработка" && !inOrder) {
      credited = false;
    }

    if (credited) {
      totals.set(currentStatus, (totals.get(currentStatus) || 0) + ms);
    }

    const nextAct = (next.action || "").trim();

    const warnBigGap =
      gapWarnMs > 0 &&
      currentStatus === "Статус в работе" &&
      nextAct === "Открытие заказа" &&
      ms >= gapWarnMs;

    intervals.push({
      from: a,
      to: b,
      event: act,
      status: currentStatus || "(нет статуса)",
      ms,
      credited,
      warnBigGap
    });
  }

  return { totals, intervals, windowStart, windowEnd, used: r.length };
}


// ===== UI =====

const input = document.getElementById("input");
const calcBtn = document.getElementById("calcBtn");
const clearBtn = document.getElementById("clearBtn");

const operatorSelect = document.getElementById("operatorSelect");
const minGapSecEl = document.getElementById("minGapSec");
const gapWarnMinEl = document.getElementById("gapWarnMin");
const shiftStart = document.getElementById("shiftStart");
const shiftEnd = document.getElementById("shiftEnd");
const acwModeBEl = document.getElementById("acwModeB");

const kpiTotal = document.getElementById("kpiTotal");
const kpiRows = document.getElementById("kpiRows");
const summaryWrap = document.getElementById("summaryWrap");
const intervalsWrap = document.getElementById("intervalsWrap");
const messages = document.getElementById("messages");

function refreshOperators(rows) {
  const ops = [...new Set(rows.map(r => r.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const current = operatorSelect.value || "__ALL__";

  operatorSelect.innerHTML =
    `<option value="__ALL__">Все</option>` +
    ops.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");

  operatorSelect.value = ops.includes(current) ? current : "__ALL__";
}

function setMessage(text) {
  messages.textContent = text || "";
}

function render(result) {
  if (!result.windowStart || !result.windowEnd) {
    kpiTotal.textContent = "—";
    kpiRows.textContent = "—";
    summaryWrap.innerHTML = "Нет данных.";
    intervalsWrap.innerHTML = "Нет данных.";
    return;
  }

  const totalWindow = result.windowEnd - result.windowStart;
  kpiTotal.textContent = formatDuration(totalWindow);
  kpiRows.textContent = String(result.used);

  const entries = Array.from(result.totals.entries())
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);

  summaryWrap.innerHTML = `
    <table>
      <tr><th>Статус</th><th>Время</th><th>%</th></tr>
      ${
        entries.length
          ? entries.map(e => `
              <tr>
                <td>${escapeHtml(e.k)}</td>
                <td>${formatDuration(e.v)}</td>
                <td>${((e.v / totalWindow) * 100).toFixed(1)}%</td>
              </tr>
            `).join("")
          : `<tr><td colspan="3">Нет интервалов для подсчёта.</td></tr>`
      }
    </table>
  `;

  intervalsWrap.innerHTML = `
    <table>
      <tr>
        <th>От</th>
        <th>До</th>
        <th>Событие</th>
        <th>Засчитанный статус</th>
        <th>Длительность</th>
        <th>Учтено</th>
      </tr>
      ${
        result.intervals.map(i => `
          <tr class="${i.warnBigGap ? "warn" : ""}">
            <td>${escapeHtml(i.from.toLocaleString())}</td>
            <td>${escapeHtml(i.to.toLocaleString())}</td>
            <td>${escapeHtml(i.event)}</td>
            <td>${escapeHtml(i.status)}</td>
            <td>
              ${formatDuration(i.ms)}
              ${i.warnBigGap ? ` <span class="badge-warn">⚠️ большой разрыв</span>` : ""}
            </td>
            <td>${i.credited ? "да" : "нет"}</td>
          </tr>
        `).join("")
      }
    </table>
  `;
}

function run() {
  const rows = parsePasted(input.value || "");
  refreshOperators(rows);

  const result = calculate(rows, {
    operator: operatorSelect.value,
    startStr: shiftStart.value.trim() || null,
    endStr: shiftEnd.value.trim() || null,
    minGapSec: minGapSecEl.value || 0,
    gapWarnMin: gapWarnMinEl.value || 0,
    acwModeB: Boolean(acwModeBEl.checked)
  });

  render(result);
}

calcBtn.addEventListener("click", run);

clearBtn.addEventListener("click", () => {
  input.value = "";
  shiftStart.value = "";
  shiftEnd.value = "";
  minGapSecEl.value = "0";
  gapWarnMinEl.value = "30";
  acwModeBEl.checked = true;

  kpiTotal.textContent = "—";
  kpiRows.textContent = "—";
  summaryWrap.innerHTML = "Нет данных.";
  intervalsWrap.innerHTML = "Нет данных.";
  refreshOperators([]);
});

input.addEventListener("input", () => {
  const rows = parsePasted(input.value || "");
  refreshOperators(rows);
});

refreshOperators([]);
