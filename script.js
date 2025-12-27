window.alert("Script Started");

let supabase = null;
let realtimeConnected = false;

// Calendar state
let calYear = null;
let calMonth = null; // 0–11
let skipDaysSet = new Set(); // holds 'YYYY-MM-DD'
let calSwipeDir = null; // 'left' or 'right' or null

// Swipe state for tab switching
let touchStartX = 0;
let touchStartY = 0;
let touchActive = false;

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

  // Realtime: watch UPDATE on commands, filter by device_id in JS
  supabase
    .channel("commands_realtime")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "commands",
      },
      handleSupabaseEvent
    )
    .subscribe((status) => {
      realtimeConnected = status === "SUBSCRIBED";
      setStatus(realtimeConnected ? "green" : "yellow");
    });

  // Load last 24h history + proof on startup
  await loadInitialHistoryAndProof();

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

  // Ignore other devices
  if (r.device_id && r.device_id !== DEVICE_ID) return;
  if (!r.response) return;

  addHistoryEntry(r.response);
  showToast("info", r.response);
  updateProofFromText(r.response);
  updateLastResult(r.response, r.updated_at || r.created_at);
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

/* Load last 24h history + proof for today */
async function loadInitialHistoryAndProof() {
  if (!supabase) return;

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString();
  const todayYMD = formatYMD(now.getFullYear(), now.getMonth(), now.getDate());

  const { data, error } = await supabase
    .from("commands")
    .select("cmd,response,device_id,created_at")
    .eq("device_id", DEVICE_ID)
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    showToast("error", "Failed to load history");
    return;
  }
  if (!data || !data.length) return;

  // History: newest → oldest
  data.forEach((row) => {
    if (row.response) addHistoryEntry(row.response);
  });

  // Last result banner: newest row with response
  const latest = data.find((row) => row.response);
  if (latest) {
    updateLastResult(latest.response, latest.created_at);
  }

  // Proof: newest row for TODAY that has "Proof"
  for (const row of data) {
    if (!row.response || !row.response.includes("Proof")) continue;
    const rowYMD = ymdFromTimestamp(row.created_at);
    if (rowYMD === todayYMD) {
      updateProofFromText(row.response);
      break;
    }
  }
}

/* ------------------------------
   PROOF PANEL UPDATE
------------------------------ */
function updateProofFromText(text) {
  const elH = document.getElementById("proofHadir");
  const elK = document.getElementById("proofKeluar");
  const elT = document.getElementById("proofUpdated");
  const cardMasuk = document.querySelector(".proof-card.masuk");
  const cardKeluar = document.querySelector(".proof-card.keluar");

  if (!elH || !elK || !elT) return;

  const isSkipped = text.includes("(SKIPPED)");

  if (isSkipped) {
    // 🔘 Grey "Skipped" state
    elH.textContent = "Skipped";
    elK.textContent = "Skipped";
    elT.textContent = "—";

    if (cardMasuk) cardMasuk.classList.add("skipped");
    if (cardKeluar) cardKeluar.classList.add("skipped");
    return;
  }

  // Not skipped → normal proof. Remove any previous skipped styling
  if (cardMasuk) cardMasuk.classList.remove("skipped");
  if (cardKeluar) cardKeluar.classList.remove("skipped");

  // For non-skipped days, only update if the response has Proof block
  if (!text.includes("Proof")) return;

  const h = text.match(/Hadir=([^ ]+)/);
  const k = text.match(/Keluar=([^ )]+)/);
  const t = text.match(/captured ([0-9:AMP]+)/i);

  elH.textContent = h ? h[1] : "—";
  elK.textContent = k ? k[1] : "—";
  elT.textContent = t ? t[1] : "—";
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
      // ignore parse errors
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
   TABS + SWIPE
------------------------------ */

function initTabs() {
  // 1. Helper to get fresh elements (Solves Stale DOM issue)
  const getTabs = () => Array.from(document.querySelectorAll(".tab"));
  const getContents = () => Array.from(document.querySelectorAll(".tab-content"));

  function activateTab(targetIndex) {
    const tabs = getTabs();
    const contents = getContents();
    
    // 2. Elegant Clamping (Prevents Out-of-Bounds errors)
    // Ensures index is never < 0 and never > last index
    const safeIndex = Math.max(0, Math.min(targetIndex, tabs.length - 1));

    // Update Tab UI
    tabs.forEach((t, i) => {
      const isActive = i === safeIndex;
      t.classList.toggle("active", isActive);
      
      // Update Content UI (Sync by index or ID)
      const targetId = t.dataset.tab;
      const contentEl = document.getElementById(targetId);
      if (contentEl) {
        contentEl.classList.toggle("active", isActive);
      }
    });
  }

  // 3. Event Delegation (Cleaner than looping listeners)
  // We attach ONE listener to the container instead of N listeners
  const tabContainer = document.querySelector(".tabs");
  if (tabContainer) {
    tabContainer.addEventListener("click", (e) => {
      const clickedTab = e.target.closest(".tab");
      if (!clickedTab) return;
      
      const tabs = getTabs();
      const index = tabs.indexOf(clickedTab);
      if (index !== -1) activateTab(index);
    });
  }

  // 4. Initialization
  // Ensure we start with a valid state
  const tabs = getTabs();
  const activeIndex = tabs.findIndex((t) => t.classList.contains("active"));
  activateTab(activeIndex === -1 ? 0 : activeIndex);

  // 5. Swipe Logic (Unchanged but uses the dynamic activateTab)
  const swipeTarget = document.body;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchActive = false;

  swipeTarget.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchActive = true;
  }, { passive: true });

  swipeTarget.addEventListener("touchend", (e) => {
    if (!touchActive) return;
    touchActive = false;
    if (e.changedTouches.length !== 1) return;

    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    
    // Ignore small swipes or vertical scrolls
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;

    const currentTabs = getTabs();
    const currentIndex = currentTabs.findIndex(t => t.classList.contains("active"));
    
    if (dx < 0) {
      // Swipe Left -> Next Tab
      activateTab(currentIndex + 1);
    } else {
      // Swipe Right -> Prev Tab
      activateTab(currentIndex - 1);
    }
  }, { passive: true });
}


/* ============================================================
   SKIP CALENDAR (One UI 8 style)
   Uses Supabase table "skip_days" with columns: device_id, day (date)
=============================================================== */

/* Helper: format YYYY-MM-DD in local time */
function formatYMD(year, month0, day) {
  const m = String(month0 + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/* Helper: YMD from ISO timestamp, in local time */
function ymdFromTimestamp(ts) {
  const d = new Date(ts);
  return formatYMD(d.getFullYear(), d.getMonth(), d.getDate());
}

/* Init calendar shell & state */
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
    .addEventListener("click", () => {
      calSwipeDir = "right"; // moving to previous month → swipe right
      changeMonth(-1);
    });

  document
    .getElementById("calNextBtn")
    .addEventListener("click", () => {
      calSwipeDir = "left"; // moving to next month → swipe left
      changeMonth(1);
    });

  const grid = document.getElementById("calGrid");
  if (grid) {
    grid.addEventListener("animationend", () => {
      grid.classList.remove("slide-left", "slide-right", "fade-in");
    });
  }

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

/* Weekday header + base structure */
function renderCalendarGridSkeleton() {
  const grid = document.getElementById("calGrid");
  if (!grid) return;

  grid.innerHTML = "";
  const weekdays = ["M", "T", "W", "T", "F", "S", "S"]; // Monday-first
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

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const startStr = formatYMD(calYear, calMonth, 1);
  const endStr = formatYMD(calYear, calMonth, daysInMonth);

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

  // Start clean with weekday header row
  grid.innerHTML = "";
  renderCalendarGridSkeleton();

  // Monday-first offset:
  // JS getDay(): 0=Sun,1=Mon,...6=Sat → convert so 0=Mon,...6=Sun
  const jsDay = new Date(calYear, calMonth, 1).getDay(); // 0–6
  const firstDay = (jsDay + 6) % 7;

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  // Empty slots before the 1st
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "calendar-empty";
    grid.appendChild(empty);
  }

  // Actual days
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    const ymd = formatYMD(calYear, calMonth, d);

    // Today highlight
    if (calYear === todayY && calMonth === todayM && d === todayD) {
      cell.classList.add("today");
    }

    // Weekend (JS: 0=Sun, 6=Sat)
    const dateObj = new Date(calYear, calMonth, d);
    const dayOfWeek = dateObj.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      cell.classList.add("weekend");
    }

    // Skipped state
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

  // Smooth month animation
  grid.classList.remove("slide-left", "slide-right", "fade-in");
  void grid.offsetWidth; // force reflow

  if (calSwipeDir === "left") {
    grid.classList.add("slide-left");
  } else if (calSwipeDir === "right") {
    grid.classList.add("slide-right");
  } else {
    // initial load / no explicit swipe → gentle fade
    grid.classList.add("fade-in");
  }

  // Reset direction after applying
  calSwipeDir = null;
}

/* Click handler: toggle skip for a date */
async function onDayClick(ymd, cell) {
  if (!supabase) {
    showToast("error", "Supabase not ready");
    return;
  }

  const isSkipped = skipDaysSet.has(ymd);

  if (isSkipped) {
    // Unskip
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
    // Skip
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
