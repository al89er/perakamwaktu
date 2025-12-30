// Temporary debug (remove after confirmed)
// window.alert("Script Started");

let supabaseClient = null; // <-- renamed to avoid collision with global `supabase`
let realtimeConnected = false;

// Calendar state
let calYear = null;
let calMonth = null; // 0–11
let skipDaysSet = new Set(); // holds 'YYYY-MM-DD'
let calSwipeDir = null; // 'left' or 'right' or null

// Swipe state for tab switching (global; initTabs has its own local swipe state too)
let touchStartX = 0;
let touchStartY = 0;

// Auto-refresh config
let lastStatusCheck = 0;
const AUTO_REFRESH_COOLDOWN = 60000; // 1 minute

/* ------------------------------
   INIT
------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  // Debug Alert - remove after it works
  // window.alert("Script Loaded Successfully!");

  try {
    initTabs();
  } catch (e) {
    console.error("initTabs failed:", e);
  }

  try {
    initButtons();
  } catch (e) {
    console.error("initButtons failed:", e);
  }

  try {
    initSupabase();
  } catch (e) {
    console.error("initSupabase failed:", e);
  }

  initPullToRefresh();

  // Auto-refresh on visibility change
  document.addEventListener("visibilitychange", handleVisibilityChange);
});

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    const now = Date.now();
    if (now - lastStatusCheck > AUTO_REFRESH_COOLDOWN) {
      console.log("Auto-triggering status check...");
      sendCommand("status");
    }
  }
}

/* ------------------------------
   SUPABASE INIT
------------------------------ */
async function initSupabase() {
  // CDN provides `window.supabase`
  if (!window.supabase) {
    console.error("Supabase JS not loaded");
    return;
  }

  // These must come from config.js (globals)
  if (typeof SUPABASE_URL === "undefined" || typeof SUPABASE_ANON_KEY === "undefined") {
    console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY. Check config.js.");
    return;
  }
  if (typeof DEVICE_ID === "undefined") {
    console.error("Missing DEVICE_ID. Check config.js.");
    return;
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  setStatus("yellow");

  // Realtime: listen to both INSERT and UPDATE (more robust than UPDATE-only)
  supabaseClient
    .channel("commands_realtime")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "commands",
      },
      handleSupabaseEvent
    )
    .subscribe((status) => {
      realtimeConnected = status === "SUBSCRIBED";
      setStatus(realtimeConnected ? "green" : "yellow");
    });

  // Realtime: listen to attendance_logs
  supabaseClient
    .channel("logs_realtime")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "attendance_logs",
      },
      handleLogEvent
    )
    .subscribe();

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

  if (r.device_id && r.device_id !== DEVICE_ID) return;
  if (!r.response) return;

  addHistoryEntry(r.response);
  showToast("info", r.response);
  updateLastResult(r.response, r.updated_at || r.created_at);
}

/* ------------------------------
   HANDLE LOG EVENT (attendance_logs)
------------------------------ */
function handleLogEvent(payload) {
  if (!payload.new) return;
  const log = payload.new;

  if (log.device_id && log.device_id !== DEVICE_ID) return;

  const todayYMD = formatYMD(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  if (log.day === todayYMD) {
    updateProofDisplay(log.clock_in, log.clock_out, log.updated_at);
  }
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
  if (!supabaseClient) {
    showToast("error", "Supabase not ready");
    return;
  }

  showToast("info", `Sent: ${cmd}`);

  const { error } = await supabaseClient.from("commands").insert({
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
  if (!supabaseClient) return;

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString();
  const todayYMD = formatYMD(now.getFullYear(), now.getMonth(), now.getDate());

  const { data, error } = await supabaseClient
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

  // --- FETCH ATTENDANCE LOG FOR TODAY ---
  const { data: logData, error: logError } = await supabaseClient
    .from("attendance_logs")
    .select("clock_in, clock_out, updated_at")
    .eq("device_id", DEVICE_ID)
    .eq("day", todayYMD)
    .maybeSingle();

  if (logError) {
    console.error("Failed to load log:", logError);
  } else if (logData) {
    updateProofDisplay(logData.clock_in, logData.clock_out, logData.updated_at);
  } else {
    // If no log entry, check if the day is marked as skipped in local set
    if (skipDaysSet.has(todayYMD)) {
      updateProofDisplay("Skipped", "Skipped", null, true);
    }
  }
}

/* ------------------------------
   PROOF PANEL UPDATE
------------------------------ */
function updateProofFromText(text) {
  // Legacy support for real-time legacy responses, 
  // but we prefer updateProofDisplay for clean data.
  if (text.includes("(SKIPPED)")) {
    updateProofDisplay("Skipped", "Skipped", null, true);
    return;
  }

  if (!text.includes("Proof")) return;

  const h = text.match(/Hadir=([^ ]+)/);
  const k = text.match(/Keluar=([^ )]+)/);
  const t = text.match(/captured ([0-9:AMP]+)/i);

  updateProofDisplay(h ? h[1] : "—", k ? k[1] : "—", t ? t[1] : null);
}

function updateProofDisplay(hadir, keluar, updatedAt, forceSkipped = false) {
  const elH = document.getElementById("proofHadir");
  const elK = document.getElementById("proofKeluar");
  const elT = document.getElementById("proofUpdated");
  const cardMasuk = document.querySelector(".proof-card.masuk");
  const cardKeluar = document.querySelector(".proof-card.keluar");

  if (!elH || !elK || !elT) return;

  const isSkipped = forceSkipped || (hadir === "Skipped" && keluar === "Skipped");

  if (isSkipped) {
    elH.textContent = "Skipped";
    elK.textContent = "Skipped";
    elT.textContent = "—";
    if (cardMasuk) cardMasuk.classList.add("skipped");
    if (cardKeluar) cardKeluar.classList.add("skipped");
    return;
  }

  if (cardMasuk) cardMasuk.classList.remove("skipped");
  if (cardKeluar) cardKeluar.classList.remove("skipped");

  elH.textContent = hadir || "—";
  elK.textContent = keluar || "—";

  if (updatedAt) {
    try {
      // If it's a full timestamp or just a time string
      if (updatedAt.includes("T") || updatedAt.includes("-")) {
        const dt = new Date(updatedAt);
        elT.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        elT.textContent = updatedAt;
      }
    } catch {
      elT.textContent = updatedAt;
    }
  } else {
    elT.textContent = "—";
  }
}

/* ------------------------------
   LAST COMMAND RESULT BANNER
------------------------------ */
function updateLastResult(text, timestamp) {
  const box = document.querySelector(".last-result-v2") || document.getElementById("lastResult");
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

  if (text.toLowerCase().includes("status") || text.includes("Proof")) {
    lastStatusCheck = Date.now();
  }
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
   TABS + NATIVE SWIPE
------------------------------ */
function initTabs() {
  const viewport = document.getElementById("tabsViewport");
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const tabContents = Array.from(document.querySelectorAll(".tab-content"));

  if (!viewport || tabs.length === 0) return;

  // 1. CLICK TO NAVIGATE
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      // Smooth scroll to the content
      viewport.scrollTo({
        left: viewport.offsetWidth * index,
        behavior: "smooth"
      });
    });
  });

  // 2. SYNC TABS ON SCROLL (INTERSECTION OBSERVER)
  const observerOptions = {
    root: viewport,
    threshold: 0.6 // Update when 60% of the tab is visible
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const index = tabContents.indexOf(entry.target);
        if (index !== -1) {
          updateActiveTabUI(index);
        }
      }
    });
  }, observerOptions);

  tabContents.forEach(content => observer.observe(content));

  function updateActiveTabUI(activeIndex) {
    tabs.forEach((t, i) => {
      t.classList.toggle("active", i === activeIndex);
    });
  }
}

/* ============================================================
   SKIP CALENDAR
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

  document.getElementById("calPrevBtn").addEventListener("click", () => {
    calSwipeDir = "right";
    changeMonth(-1);
  });

  document.getElementById("calNextBtn").addEventListener("click", () => {
    calSwipeDir = "left";
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
  if (!supabaseClient) return;

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

  const { data, error } = await supabaseClient
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

  grid.innerHTML = "";
  renderCalendarGridSkeleton();

  const jsDay = new Date(calYear, calMonth, 1).getDay(); // 0–6
  const firstDay = (jsDay + 6) % 7;

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "calendar-empty";
    grid.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    const ymd = formatYMD(calYear, calMonth, d);

    if (calYear === todayY && calMonth === todayM && d === todayD) {
      cell.classList.add("today");
    }

    const dateObj = new Date(calYear, calMonth, d);
    const dayOfWeek = dateObj.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      cell.classList.add("weekend");
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

  grid.classList.remove("slide-left", "slide-right", "fade-in");
  void grid.offsetWidth;

  if (calSwipeDir === "left") {
    grid.classList.add("slide-left");
  } else if (calSwipeDir === "right") {
    grid.classList.add("slide-right");
  } else {
    grid.classList.add("fade-in");
  }
  calSwipeDir = null;
}

/* Click handler: toggle skip for a date */
async function onDayClick(ymd, cell) {
  if (!supabaseClient) {
    showToast("error", "Supabase not ready");
    return;
  }

  const isSkipped = skipDaysSet.has(ymd);

  if (isSkipped) {
    // Unskip
    const { error } = await supabaseClient
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
    const { error } = await supabaseClient.from("skip_days").upsert({
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

/* ============================================================
   PULL TO REFRESH
   ============================================================ */
function initPullToRefresh() {
  let startY = 0;
  let isPulling = false;
  const threshold = 80;
  const ptrElement = document.getElementById("pullToRefresh");
  const ptrIcon = ptrElement?.querySelector(".ptr-icon");

  window.addEventListener("touchstart", (e) => {
    // Only PTR on the control tab and when at the top
    const activeTab = document.querySelector(".tab-content.active");
    if (!activeTab || activeTab.id !== "control") return;
    if (window.scrollY > 5) return;

    startY = e.touches[0].pageY;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY === 0) return;

    const y = e.touches[0].pageY;
    const diff = y - startY;

    if (diff > 20 && window.scrollY <= 0) {
      isPulling = true;
      document.body.classList.add("ptr-active");

      const rotation = Math.min(diff * 2, 180);
      if (ptrIcon) ptrIcon.style.transform = `rotate(${rotation}deg)`;

      // Prevent scrolling while pulling deep
      if (diff > 30 && e.cancelable) {
        // We can't preventDefault on passive, so we use CSS touch-action if needed
      }
    }
  }, { passive: true });

  window.addEventListener("touchend", async (e) => {
    if (!isPulling) return;

    const y = e.changedTouches[0].pageY;
    const diff = y - startY;

    if (diff >= threshold) {
      document.body.classList.add("ptr-loading");
      sendCommand("status");

      // Keep indicator for at least 1s for visual feedback
      setTimeout(() => {
        resetPTR();
      }, 1500);
    } else {
      resetPTR();
    }

    startY = 0;
    isPulling = false;
  });

  function resetPTR() {
    document.body.classList.remove("ptr-active", "ptr-loading");
    if (ptrIcon) ptrIcon.style.transform = "";
  }
}
