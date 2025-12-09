let supabase = null;
let realtimeConnected = false;

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
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  setStatus("yellow");

  supabase
    .channel("commands")
    .on("postgres_changes", { event: "*", schema: "public" }, handleSupabaseEvent)
    .subscribe((status) => {
      realtimeConnected = (status === "SUBSCRIBED");
      setStatus(realtimeConnected ? "green" : "yellow");
    });
}

function setStatus(color) {
  const dot = document.getElementById("statusDot");
  dot.style.background = color;
}

/* ------------------------------
   HANDLE SUPABASE RESPONSE
------------------------------ */
function handleSupabaseEvent(payload) {
  if (!payload.new) return;
  const r = payload.new;

  if (r.response) {
    addHistoryEntry(r.response);
    showToast("info", r.response);
    updateProofFromText(r.response);
  }
}

/* ------------------------------
   BUTTON INTERACTIONS
------------------------------ */
function initButtons() {
  document.querySelectorAll(".action-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      ripple(e);
      sendCommand(btn.dataset.cmd);
    });
  });
}

/* Ripple Effect */
function ripple(e) {
  const btn = e.currentTarget;
  btn.classList.remove("ripple-active");
  void btn.offsetWidth;
  btn.classList.add("ripple-active");
}

/* ------------------------------
   SEND COMMAND TO SUPABASE
------------------------------ */
async function sendCommand(cmd) {
  showToast("info", `Sent: ${cmd}`);

  await supabase.from("commands").insert({
    device_id: DEVICE_ID,
    cmd: cmd,
  });
}

/* ------------------------------
   HISTORY PANEL
------------------------------ */
function addHistoryEntry(text) {
  const container = document.getElementById("historyList");
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

  document.getElementById("proofHadir").textContent = h ? h[1] : "—";
  document.getElementById("proofKeluar").textContent = k ? k[1] : "—";
  document.getElementById("proofUpdated").textContent = t ? t[1] : "—";
}

/* ------------------------------
   TOASTS
------------------------------ */
function showToast(type, text) {
  const box = document.getElementById("toastContainer");

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
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      contents.forEach(c => c.classList.remove("active"));
      document.getElementById(tab.dataset.tab).classList.add("active");
    });
  });
}
