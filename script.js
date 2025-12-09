let supabase = null;
let realtimeConnected = false;

// Calendar state
let calYear = null;
let calMonth = null; // 0–11
let skipDaysSet = new Set(); // holds 'YYYY-MM-DD'

/* ------------------------------
   INIT
------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initButtons();
  initSupabase();
});

/* ------------------------------
   SUPABASE INIT
------------------------------ */
async function initSupabase() {
  if (!window.supabase) {
    console.error("Supabase JS not loaded");
    return;
  }

  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  setStatus("yellow");

  // Realtime: watch only commands for this device, on UPDATE (when response is written)
  supabase
    .channel("commands_" + DEVICE_ID)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "commands",
        filter: `device_id=eq.${DEVICE_ID}`,
      },
      handleSupabaseEvent
    )
    .subscribe((status) => {
      realtimeConnected = status === "SUBSCRIBED";
      setStatus(realtimeConnected ? "green" : "yellow");
    });

  // Init calendar once Supabase client exists
  initCalendar();
  await loadSkipDaysForCurrentMonth();
}

/* ------------------------------
   STATUS DOT
------------------------------ */
function setStatus(color) {
  const dot = document.getElementById("statusDot");
  if (dot) dot.style.background = color;
}

/* ------------------------------
   HANDLE SUPABASE RESPONSE (commands)
------------------------------ */
function handleSupabaseEvent(payload) {
  if (!payload.new) return;
  const r = payload.new;

  // Safety: only handle rows with a response
  if (!r.response) return;

  addHistoryEntry(r.response);
  showToast("info", r.response);
  updateProofFromText(r.response);
   updateLastResult(r.response, r.updated_at || r.ack_at || r.created_at);
}

/* ------------------------------
   BUTTON INTERACTIONS
------------------------------ */
function initButtons() {
  document.querySelectorAll(".action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      ripple(e);
      sendCommand(btn.dataset.cmd);
    });
  });
}

/* Ripple Effect (for main buttons) */
function ripple(e) {
  const btn = e.currentTarget;
  btn.classList.remove("ripple-active");
  void btn.offsetWidth; // force reflow
  btn.classList.add("ripple-active");
}

/* ------------------------------
   SEND COMMAND TO SUPABASE (commands table)
------------------------------ */
async function sendCommand(cmd) {
  if (!supabase) {
    showToast("error", "Supabase not ready");
    return;
  }

  showToast("info", `Sent: ${cmd}`);

  const { error } = await supabase.from("commands").insert({
    device_id: DEVICE_ID,
    cmd: cmd,
  });

  if (error) {
    console.error(error);
    showToast("error", "Failed to send command");
  }
}

/* ------------------------------
   HISTORY PANEL
------------------------------ */
function addHistoryEntry(text) {
  const container = document.getElementById("historyList");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "history-item";
  div.textContent = text;
  container.prepend(div);
}

/* ------------------------------
   PROOF PANEL UPDATE
------------------------------ */
function updateProofFromText(text) {
  if (!text.includes("Proof")) return;

  const h = text.match(/Hadir=([^ ]+)/);
  const k = text.match(/Keluar=([^ ]+)/);
  const t = text.match(/captured ([0-9:AMP]+)/i);

  const elH = document.getElementById("proofHadir");
  const elK = document.getElementById("proofKeluar");
  const elT = document.getElementById("proofUpdated");

  if (elH) elH.textContent = h ? h[1] : "—";
  if (elK) elK.textContent = k ? k[1] : "—";
  if (elT) elT.textContent = t ? t[1] : "—";
}

/* ------------------------------
   LAST COMMAND RESULT BANNER
------------------------------ */
function updateLastResult(text, timestamp) {
  const box = document.getElementById("lastResult");
  const msgEl = document.getElementById("lastResultText");
  if (!box || !msgEl) return;

  let suffix = "";
  if (timestamp) {
    try {
      const dt = new Date(timestamp);
      suffix = " · " + dt.toLocaleTimeString();
    } catch {
      // ignore parse errors, just show raw
    }
  }

  msgEl.textContent = text + (suffix || "");
  box.classList.remove("updated");
  void box.offsetWidth; // force reflow
  box.classList.add("updated");
}

/* ------------------------------
   TOASTS
------------------------------ */
function showToast(type, text) {
  const box = document.getElementById("toastContainer");
  if (!box) return;

  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = text;

  box.appendChild(t);

  setTimeout(() => {
    t.style.opacity = 0;
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

/* ------------------------------
   TABS
------------------------------ */
function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const contents = document.querySelectorAll(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      contents.forEach((c) => c.classList.remove("active"));
      document.getElementById(tab.dataset.tab).classList.add("active");
    });
  });
}

/* ============================================================
   SKIP CALENDAR (One UI 8 style)
   Uses Supabase table "skip_days" with columns: device_id, day (date)
=============================================================== */

/* Init calendar skeleton & state */
function initCalendar() {
  const container = document.getElementById("skipCalendar");
  if (!container) return;

  const today = new Date();
  calYear = today.getFullYear();
  calMonth = today.getMonth(); // 0–11

  container.innerHTML = `
    <div class="calendar-header">
      <button class="calendar-nav" id="calPrevBtn">&#x25C0;</button>
      <div class="calendar-title" id="calTitle"></div>
      <button class="calendar-nav" id="calNextBtn">&#x25B6;</button>
    </div>
    <div class="calendar-grid" id="calGrid"></div>
  `;

  document
    .getElementById("calPrevBtn")
    .addEventListener("click", () => changeMonth(-1));
  document
    .getElementById("calNextBtn")
    .addEventListener("click", () => changeMonth(1));

  renderCalendarGridSkeleton();
}

/* Month navigation */
async function changeMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) {
    calMonth = 11;
    calYear -= 1;
  } else if (calMonth > 11) {
    calMonth = 0;
    calYear += 1;
  }
  await loadSkipDaysForCurrentMonth();
}

/* Short weekday headers + container */
function renderCalendarGridSkeleton() {
  const grid = document.getElementById("calGrid");
  if (!grid) return;

  grid.innerHTML = "";
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
  weekdays.forEach((d) => {
    const w = document.createElement("div");
    w.className = "calendar-weekday";
    w.textContent = d;
    grid.appendChild(w);
  });
}

/* Load skip_days for the visible month */
async function loadSkipDaysForCurrentMonth() {
  if (!supabase) return;

  const title = document.getElementById("calTitle");
  if (title) {
    const d = new Date(calYear, calMonth, 1);
    title.textContent = d.toLocaleString("default", {
      month: "long",
      year: "numeric",
    });
  }

  const start = new Date(calYear, calMonth, 1);
  const end = new Date(calYear, calMonth + 1, 0);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("skip_days")
    .select("day")
    .eq("device_id", DEVICE_ID)
    .gte("day", startStr)
    .lte("day", endStr);

  if (error) {
    console.error(error);
    showToast("error", "Failed to load skip days");
    skipDaysSet = new Set();
  } else {
    skipDaysSet = new Set((data || []).map((r) => r.day));
  }

  renderCalendar();
}

/* Render calendar for current calYear/calMonth */
function renderCalendar() {
  const grid = document.getElementById("calGrid");
  if (!grid) return;

  // reset grid (but keep weekday header row)
  grid.innerHTML = "";
  renderCalendarGridSkeleton();

  const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  // Empty slots before 1st
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "calendar-empty";
    grid.appendChild(empty);
  }

  // Actual days
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    const dateObj = new Date(calYear, calMonth, d);
    const ymd = dateObj.toISOString().slice(0, 10);

    if (calYear === todayY && calMonth === todayM && d === todayD) {
      cell.classList.add("today");
    }

    if (skipDaysSet.has(ymd)) {
      cell.classList.add("skipped");
    }

    cell.dataset.date = ymd;

    const label = document.createElement("span");
    label.textContent = d;
    cell.appendChild(label);

    cell.addEventListener("click", () => onDayClick(ymd, cell));

    grid.appendChild(cell);
  }

  // small fade animation
  grid.classList.remove("fade-in");
  void grid.offsetWidth;
  grid.classList.add("fade-in");
}

/* Click handler: toggle skip for a date */
async function onDayClick(ymd, cell) {
  if (!supabase) {
    showToast("error", "Supabase not ready");
    return;
  }

  const isSkipped = skipDaysSet.has(ymd);

  if (isSkipped) {
    // unskip
    const { error } = await supabase
      .from("skip_days")
      .delete()
      .eq("device_id", DEVICE_ID)
      .eq("day", ymd);

    if (error) {
      console.error(error);
      showToast("error", "Failed to unskip day");
      return;
    }

    skipDaysSet.delete(ymd);
    cell.classList.remove("skipped");
    showToast("info", `Unskipped ${ymd}`);
  } else {
    // skip
    const { error } = await supabase.from("skip_days").upsert({
      device_id: DEVICE_ID,
      day: ymd,
    });

    if (error) {
      console.error(error);
      showToast("error", "Failed to mark skip day");
      return;
    }

    skipDaysSet.add(ymd);
    cell.classList.add("skipped");
    showToast("info", `Skipped ${ymd}`);
  }
}
