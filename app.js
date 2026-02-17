function parseDateTime(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(m[1], m[2]-1, m[3], m[4], m[5], m[6]);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function parseText(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const rows = [];

  for (const line of lines) {
    if (!line.includes("202")) continue;

    const parts = line.split("\t");
    const dateStr = parts[parts.length - 1];
    const dt = parseDateTime(dateStr);
    if (!dt) continue;

    rows.push({
      action: parts[1] || "",
      operator: parts[2] || "",
      dt
    });
  }

  return rows;
}

function calculate(rows, operator, mode, startStr, endStr) {
  if (operator !== "__ALL__") {
    rows = rows.filter(r => r.operator === operator);
  }

  if (mode === "startsWithStatus") {
    rows = rows.filter(r => r.action.startsWith("Статус"));
  }

  rows.sort((a,b) => a.dt - b.dt);

  const start = startStr ? parseDateTime(startStr) : rows[0]?.dt;
  const end = endStr ? parseDateTime(endStr) : rows[rows.length-1]?.dt;

  const totals = {};
  const intervals = [];

  for (let i=0; i<rows.length-1; i++) {
    const cur = rows[i];
    const next = rows[i+1];

    if (cur.dt < start || next.dt > end) continue;

    const diff = next.dt - cur.dt;
    totals[cur.action] = (totals[cur.action] || 0) + diff;

    intervals.push({
      from: cur.dt,
      to: next.dt,
      action: cur.action,
      ms: diff
    });
  }

  return { totals, intervals, start, end, used: rows.length };
}

const input = document.getElementById("input");
const calcBtn = document.getElementById("calcBtn");
const clearBtn = document.getElementById("clearBtn");
const operatorSelect = document.getElementById("operatorSelect");
const statusMode = document.getElementById("statusMode");
const shiftStart = document.getElementById("shiftStart");
const shiftEnd = document.getElementById("shiftEnd");
const kpiTotal = document.getElementById("kpiTotal");
const kpiRows = document.getElementById("kpiRows");
const summaryWrap = document.getElementById("summaryWrap");
const intervalsWrap = document.getElementById("intervalsWrap");

function refreshOperators(rows) {
  const ops = [...new Set(rows.map(r => r.operator).filter(Boolean))];
  operatorSelect.innerHTML = `<option value="__ALL__">Все</option>` +
    ops.map(o => `<option value="${o}">${o}</option>`).join("");
}

calcBtn.onclick = () => {
  const rows = parseText(input.value);
  refreshOperators(rows);

  const result = calculate(
    rows,
    operatorSelect.value,
    statusMode.value,
    shiftStart.value,
    shiftEnd.value
  );

  if (!result.start || !result.end) return;

  kpiTotal.textContent = formatDuration(result.end - result.start);
  kpiRows.textContent = result.used;

  const totalWindow = result.end - result.start;

  summaryWrap.innerHTML = `
    <table>
      <tr><th>Статус</th><th>Время</th><th>%</th></tr>
      ${
        Object.entries(result.totals)
        .map(([k,v]) => `
          <tr>
            <td>${k}</td>
            <td>${formatDuration(v)}</td>
            <td>${((v/totalWindow)*100).toFixed(1)}%</td>
          </tr>
        `).join("")
      }
    </table>
  `;

  intervalsWrap.innerHTML = `
    <table>
      <tr><th>От</th><th>До</th><th>Статус</th><th>Длительность</th></tr>
      ${
        result.intervals.map(i => `
          <tr>
            <td>${i.from.toLocaleString()}</td>
            <td>${i.to.toLocaleString()}</td>
            <td>${i.action}</td>
            <td>${formatDuration(i.ms)}</td>
          </tr>
        `).join("")
      }
    </table>
  `;
};

clearBtn.onclick = () => {
  input.value = "";
  summaryWrap.innerHTML = "Нет данных.";
  intervalsWrap.innerHTML = "Нет данных.";
  kpiTotal.textContent = "—";
  kpiRows.textContent = "—";
};
