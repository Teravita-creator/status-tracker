// ===== Helpers =====
function parseDateTime(s) {
  // expects: YYYY-MM-DD HH:MM:SS
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, se] = m;
  // local time
  return new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(se)
  );
}

function fmt2(n) { return String(n).padStart(2, "0"); }

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
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
  // Try to support cases where copy-paste becomes "multi spaces" instead of tabs
  // Keep tabs as primary delimiter, else collapse multiple spaces.
  if (line.includes("\t")) return line;
  return line.replace(/\s{2,}/g, "\t");
}

// ===== Parsing pasted table =====
function parsePastedText(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  // Remove obvious UI garbage lines
  const filtered = lines.filter(l => {
    const low = l.toLowerCase();
    if (low.startsWith("показать")) return false;
    if (low.includes("записей с")) return false;
    if (low.includes("version")) return false;
    if (low === "действие") return false;
    if (low === "id заказа") return false;
    if (low === "предыдущая") return false;
    if (low === "следующая") return false;
    if (/^\d+$/.test(low)) return false; // lone page numbers
    return true;
  });

  if (filtered.length === 0) return { rows: [], warnings: ["Немає рядків для обробки."] };

  // Drop header line if present
  const headerIdx = filtered.findIndex(l =>
    /id\s+действие\s+оператор\s+заказ\s+дата/i.test(l.replace(/\t/g, " "))
  );

  let contentLines = filtered;
  if (headerIdx !== -1) {
    contentLines = filtered.slice(headerIdx + 1);
  }

  const rows = [];
  const warnings = [];
  for (const line0 of contentLines) {
    const line = normalizeSpaces(line0);
    const parts = line.split("\t").map(p => p.trim()).filter(p => p !== "");

    // Expected (best case): Id, Действие, Оператор, Заказ(optional), Дата
    // But sometimes Заказ may be empty, and columns shift.
    // We'll locate the datetime at the end.
    const dtStr = parts.findLast?.(p => parseDateTime(p)) || parts[parts.length - 1];
    const dt = parseDateTime(dtStr);
    if (!dt) {
      // ignore non-data lines
      continue;
    }

    // Remove dt from parts
    const partsNoDt = parts.slice(0, parts.lastIndexOf(dtStr));

    // Heuristic:
    // first token numeric => id
    const id = partsNoDt.length > 0 && /^\d+$/.test(partsNoDt[0]) ? partsNoDt[0] : "";

    // action is next token after id
    const action = partsNoDt.length > 1 ? partsNoDt[1] : (partsNoDt[0] && !/^\d+$/.test(partsNoDt[0]) ? partsNoDt[0] : "");

    // operator often contains spaces; in your copy it's one chunk (because it’s a single cell)
    // We'll assume operator is everything between action and last optional order id.
    let operator = "";
    let orderId = "";

    // If we have 4 columns before dt: [id, action, operator, orderId]
    // If 3 columns before dt: [id, action, operator] (order empty)
    // If something else: best effort
    if (partsNoDt.length >= 4) {
      operator = partsNoDt.slice(2, partsNoDt.length - 1).join(" ");
      orderId = partsNoDt[partsNoDt.length - 1];
      if (!/^\d+$/.test(orderId)) {
        // Probably there was no order id, and it leaked into operator
        operator = partsNoDt.slice(2).join(" ");
        orderId = "";
      }
    } else if (partsNoDt.length === 3) {
      operator = partsNoDt[2];
    } else if (partsNoDt.length === 2) {
      operator = "";
    } else if (partsNoDt.length === 1) {
      operator = "";
    }

    rows.push({
      id,
      action: action || "",
      operator: operator || "",
      orderId: orderId || "",
      dt,
      dtStr: dtStr
    });
  }

  if (rows.length === 0) {
    warnings.push("Не вдалося знайти жодного рядка з датою формату YYYY-MM-DD HH:MM:SS.");
  }

  return { rows, warnings };
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

// ===== Calculation =====
function calculate(rows, opts) {
  const { operatorFilter, statusMode, shiftStart, shiftEnd, dedupeSameTime } = opts;

  let r = rows.slice();

  if (operatorFilter && operatorFilter !== "__ALL__") {
    r = r.filter(x => x.operator === operatorFilter);
  }

  if (statusMode === "startsWithStatus") {
    r = r.filter(x => x.action.trim().toLowerCase().startsWith("статус"));
  }

  // Sort ascending by dt
  r.sort((a, b) => a.dt - b.dt);

  // Dedupe same timestamp
  if (dedupeSameTime) {
    const byTime = new Map();
    for (const e of r) {
      byTime.set(e.dt.getTime(), e); // last wins
    }
    r = Array.from(byTime.values()).sort((a, b) => a.dt - b.dt);
  }

  const intervals = [];
  const totals = new Map();

  // Determine calculation window
  let windowStart = shiftStart ? parseDateTime(shiftStart) : null;
  let windowEnd = shiftEnd ? parseDateTime(shiftEnd) : null;

  // If no manual shift times, default to min/max of used events
  if (!windowStart && r.length > 0) windowStart = r[0].dt;
  if (!windowEnd && r.length > 0) windowEnd = r[r.length - 1].dt;

  if (!windowStart || !windowEnd || windowEnd < windowStart) {
    return { intervals: [], totals: new Map(), windowStart: null, windowEnd: null, usedEvents: r };
  }

  // We compute durations between events, clipped to [windowStart, windowEnd]
  // Add synthetic boundary events so first/last interval handles properly
  // Rule: interval is attributed to the current event's action until next event
  // For manual windowStart that is earlier than first event, we won't know status before first event -> ignore that gap.
  // For manual windowEnd later than last event, gap after last event also unknown -> ignore.
  for (let i = 0; i < r.length - 1; i++) {
    const cur = r[i];
    const next = r[i + 1];

    let a = cur.dt;
    let b = next.dt;

    // Clip to window
    if (b <= windowStart || a >= windowEnd) continue;
    if (a < windowStart) a = windowStart;
    if (b > windowEnd) b = windowEnd;
    if (b <= a) continue;

    const ms = b - a;
    const key = cur.action || "(без назви)";

    totals.set(key, (totals.get(key) || 0) + ms);

    intervals.push({
      from: a,
      to: b,
      ms,
      action: key
    });
  }

  return { intervals, totals, windowStart, windowEnd, usedEvents: r };
}

// ===== UI wiring =====
const elInput = document.getElementById("input");
const elCalc = document.getElementById("calcBtn");
const elDemo = document.getElementById("demoBtn");
const elClear = document.getElementById("clearBtn");
const elOperator = document.getElementById("operatorSelect");
const elStatusMode = document.getElementById("statusMode");
const elShiftStart = document.getElementById("shiftStart");
const elShiftEnd = document.getElementById("shiftEnd");
const elDedupe = document.getElementById("dedupeSameTime");
const elMsg = document.getElementById("messages");

const elKpiTotal = document.getElementById("kpiTotal");
const elKpiRows = document.getElementById("kpiRows");
const elSummaryWrap = document.getElementById("summaryWrap");
const elIntervalsWrap = document.getElementById("intervalsWrap");

let lastParsed = { rows: [], warnings: [] };

function setMessages(msgs, type = "muted") {
  if (!msgs || msgs.length === 0) {
    elMsg.innerHTML = "";
    return;
  }
  const cls = type === "err" ? "err" : (type === "ok" ? "ok" : "warn");
  elMsg.innerHTML = `<div class="${cls}" style="margin-top:10px">${msgs.map(escapeHtml).join("<br/>")}</div>`;
}

function refreshOperators(rows) {
  const ops = uniqueSorted(rows.map(r => r.operator).filter(Boolean));
  const current = elOperator.value || "__ALL__";

  elOperator.innerHTML = `<option value="__ALL__">Всі</option>` +
    ops.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");

  // restore selection if possible
  if (ops.includes(current)) elOperator.value = current;
  else elOperator.value = "__ALL__";
}

function renderSummary(result) {
  const { totals, windowStart, windowEnd } = result;
  if (!windowStart || !windowEnd) {
    elSummaryWrap.innerHTML = `<div class="muted">Немає валідного інтервалу для підрахунку (перевір дати/формат).</div>`;
    return;
  }

  const totalWindowMs = windowEnd - windowStart;

  const entries = Array.from(totals.entries())
    .map(([action, ms]) => ({ action, ms }))
    .sort((a, b) => b.ms - a.ms);

  if (entries.length === 0) {
    elSummaryWrap.innerHTML = `<div class="muted">Немає інтервалів для підрахунку. (Мало статусних подій або тільки 1 подія)</div>`;
    return;
  }

  const table = `
    <table>
      <thead>
        <tr>
          <th>Статус / Дія</th>
          <th>Тривалість</th>
          <th>% від вікна</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(e => {
          const pct = totalWindowMs > 0 ? (e.ms / totalWindowMs) * 100 : 0;
          return `
            <tr>
              <td><span class="pill">${escapeHtml(e.action)}</span></td>
              <td>${formatDuration(e.ms)}</td>
              <td>${pct.toFixed(1)}%</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    <div class="muted" style="margin-top:10px">
      Вікно підрахунку: <code>${escapeHtml(windowStart.toISOString().replace("T"," ").slice(0,19))}</code>
      → <code>${escapeHtml(windowEnd.toISOString().replace("T"," ").slice(0,19))}</code>
      (ISO показує UTC; сам підрахунок робиться коректно по локальному часу)
    </div>
  `;

  elSummaryWrap.innerHTML = table;
}

function renderIntervals(result) {
  const { intervals } = result;
  if (!intervals || intervals.length === 0) {
    elIntervalsWrap.innerHTML = `<div class="muted">Поки немає інтервалів.</div>`;
    return;
  }

  const rows = intervals
    .slice()
    .sort((a, b) => a.from - b.from)
    .map(it => {
      const from = it.from.toLocaleString("sv-SE").replace("T", " ");
      const to = it.to.toLocaleString("sv-SE").replace("T", " ");
      return `
        <tr>
          <td>${escapeHtml(from)}</td>
          <td>${escapeHtml(to)}</td>
          <td><span class="pill">${escapeHtml(it.action)}</span></td>
          <td>${formatDuration(it.ms)}</td>
        </tr>
      `;
    }).join("");

  elIntervalsWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Від</th>
          <th>До</th>
          <th>Статус / Дія</th>
          <th>Тривалість</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function run() {
  const raw = elInput.value || "";
  lastParsed = parsePastedText(raw);

  refreshOperators(lastParsed.rows);

  if (lastParsed.warnings.length) {
    setMessages(lastParsed.warnings, "warn");
  } else {
    setMessages(["Дані зчитано ✅"], "ok");
  }

  const res = calculate(lastParsed.rows, {
    operatorFilter: elOperator.value,
    statusMode: elStatusMode.value,
    shiftStart: elShiftStart.value.trim() || null,
    shiftEnd: elShiftEnd.value.trim() || null,
    dedupeSameTime: elDedupe.checked
  });

  // KPI
  if (res.windowStart && res.windowEnd) {
    elKpiTotal.textContent = formatDuration(res.windowEnd - res.windowStart);
  } else {
    elKpiTotal.textContent = "—";
  }
  elKpiRows.textContent = String(res.usedEvents.length);

  renderSummary(res);
  renderIntervals(res);
}

// Update operators immediately when user pastes
elInput.addEventListener("input", () => {
  const p = parsePastedText(elInput.value || "");
  lastParsed = p;
  refreshOperators(p.rows);
});

elCalc.addEventListener("click", run);

elClear.addEventListener("click", () => {
  elInput.value = "";
  elShiftStart.value = "";
  elShiftEnd.value = "";
  setMessages([]);
  elKpiTotal.textContent = "—";
  elKpiRows.textContent = "—";
  elSummaryWrap.textContent = "Поки немає даних.";
  elIntervalsWrap.textContent = "Поки немає даних.";
  refreshOperators([]);
});

elDemo.addEventListener("click", () => {
  elInput.value = [
    "Id\tДействие\tОператор\tЗаказ\tДата",
    "1474424\tСтатус пост-обработка\t2964-Мебагишвили Теона 5072 ГП\t\t2026-02-13 19:55:34",
    "1474422\tОткрытие заказа\t2964-Мебагишвили Теона 5072 ГП\t393470\t2026-02-13 19:46:53",
    "1474409\tСтатус в работе\t2964-Мебагишвили Теона 5072 ГП\t\t2026-02-13 19:20:28",
    "1474408\tЗакрытие заказа\t2964-Мебагишвили Теона 5072 ГП\t393441\t2026-02-13 19:20:20",
    "1474404\tСтатус пост-обработка\t2964-Мебагишвили Теона 5072 ГП\t\t2026-02-13 19:11:53",
    "1474403\tОткрытие заказа\t2964-Мебагишвили Теона 5072 ГП\t393441\t2026-02-13 19:11:46",
    "1474402\tСтатус в работе\t2964-Мебагишвили Теона 5072 ГП\t\t2026-02-13 19:11:23",
    "1472234\tСтатус в работе\t2964-Мебагишвили Теона 5072 ГП\t\t2026-02-13 11:52:11"
  ].join("\n");
  run();
});

// Initial
refreshOperators([]);
