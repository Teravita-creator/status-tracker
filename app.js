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

/**
 * Алгоритм (B):
 * - Интервалы считаются между всеми событиями.
 * - Базово “статус держится” на последнем "Статус ..."
 * - Если включён режим B:
 *   после события "Закрытие заказа" статус принудительно становится "Статус пост-обработка"
 *   и держится до следующего "Открытие заказа" (или до явной смены статуса).
 *
 * ДОП. ПРАВИЛО (как ты просила):
 * - "Статус пост-обработка" засчитывается ТОЛЬКО внутри окна заказа:
 *   между "Открытие заказа" -> "Закрытие заказа"
 */
function calculate(rows, opts) {
  const { operator, startStr, endStr, minGapSec, acwModeB } = opts;

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

  // last explicit status
  let currentStatus = null;

  // B-mode flag: we are currently in inferred ACW until next open
  let inAcwUntilOpen = false;

  // NEW: are we inside an order session (Открытие -> Закрытие)?
  let inOrder = false;

  // init status & inOrder at/before windowStart
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

    // --- update "state" at cur moment ---
    const act = (cur.action || "").trim();

    // track order window
    if (act === "Открытие заказа") inOrder = true;
    if (act === "Закрытие заказа") inOrder = false;

    // explicit status always wins
    if (isStatus(act)) {
      currentStatus = act;
      inAcwUntilOpen = false; // explicit status ends inferred ACW
    }

    if (acwModeB) {
  // Новый смысл: после "Закрытие заказа" время до следующего "Открытие заказа"
  // относится к "Статус в работе"
  if (act === "Закрытие заказа") {
    currentStatus = "Статус в работе";
  }
}


    // --- compute interval cur->next ---
    let a = cur.dt;
    let b = next.dt;

    // clip to window
    if (b <= windowStart || a >= windowEnd) continue;
    if (a < windowStart) a = windowStart;
    if (b > windowEnd) b = windowEnd;
    if (b <= a) continue;

    const ms = b - a;
    if (ms < minGapMs) continue;

    // default: if we have a status -> count it
    let credited = Boolean(currentStatus);

    // IMPORTANT RULE:
    // Post-processing counts ONLY inside Открытие -> Закрытие
    if (currentStatus === "Статус пост-обработка" && !inOrder) {
      credited = false;
    }

    if (credited) {
      totals.set(currentStatus, (totals.get(currentStatus) || 0) + ms);
    }

    intervals.push({
      from: a,
      to: b,
      event: act,
      status: currentStatus || "(нет статуса)",
      ms,
      credited
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
        <th>От</th><th>До</th><th>Событие</th><th>Засчитанный статус</th><th>Длительность</th><th>Учтено</th>
      </tr>
      ${
        result.intervals.map(i => `
          <tr>
            <td>${escapeHtml(i.from.toLocaleString())}</td>
            <td>${escapeHtml(i.to.toLocaleString())}</td>
            <td>${escapeHtml(i.event)}</td>
            <td>${escapeHtml(i.status)}</td>
            <td>${formatDuration(i.ms)}</td>
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

  if (!rows.length) {
    setMessage("Не найдено строк с датой формата YYYY-MM-DD HH:MM:SS.");
  } else {
    setMessage("");
  }

  const result = calculate(rows, {
    operator: operatorSelect.value,
    startStr: shiftStart.value.trim() || null,
    endStr: shiftEnd.value.trim() || null,
    minGapSec: minGapSecEl.value || 0,
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
  acwModeBEl.checked = true;
  setMessage("");

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
