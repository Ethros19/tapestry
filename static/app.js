// Tapestry — vanilla module. No build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Web Audio sounds (synthesized clunks/whooshes) ----------
// Modeled on a piano-key cassette deck: a chunky low-pass-filtered noise burst
// for the keys, layered transients + bandpass-swept noise for tape insert/eject.
const Sound = (() => {
  let ctx = null;
  let master = null;
  let enabled = true;

  function ensure() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function noiseBuf(durSec) {
    const c = ensure();
    if (!c) return null;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * durSec), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Filtered noise burst — used for clunks and clicks.
  function clunk(when = 0, vol = 0.4, freq = 700, dur = 0.06) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + when;
    const buf = noiseBuf(dur);
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = freq;
    filter.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
  }

  // Bandpass-swept noise — used for whooshes (slide / spring release).
  function whoosh(when, dur, fStart, fEnd, vol) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + when;
    const buf = noiseBuf(dur);
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(fStart, t0);
    filter.frequency.exponentialRampToValueAtTime(fEnd, t0 + dur);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.04, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
  }

  return {
    keyDown:   () => clunk(0, 0.42, 600, 0.07),
    click:     () => clunk(0, 0.30, 1100, 0.04),
    tapeLoad: () => {
      // door-open click → slide whoosh → seat clunk
      clunk(0,    0.30, 1500, 0.04);
      whoosh(0.05, 0.28, 2400, 480, 0.18);
      clunk(0.34, 0.50, 480, 0.09);
    },
    eject: () => {
      // spring release → pop click
      whoosh(0,   0.20, 600, 2400, 0.18);
      clunk(0.20, 0.40, 1600, 0.05);
    },
    setEnabled: (v) => { enabled = !!v; },
  };
})();

const SUGGESTIONS = [
  "pink floyd 1973 rainbow",
  "grateful dead 1977-05-08 cornell",
  "miles davis 1973",
  "jimi hendrix monterey",
  "led zeppelin 1975 earls court",
  "john coltrane village vanguard",
  "talking heads 1980",
  "nirvana 1993 unplugged",
];

const ARCHIVE_DL_RE = /^https?:\/\/archive\.org\/download\/([^/]+)\//i;

const state = {
  player: localStorage.getItem("lab.player") || "",
  results: [],
  items: new Map(),           // identifier → item metadata
  fetchingItems: new Set(),   // in-flight identifiers
  pollTimer: null,
  lastQuery: null,
  searchOpen: false,
  drawerOpen: false,
  currentItem: null,          // item currently loaded on the deck
  currentTrackUrl: null,
  // Playback context for predicting time between status polls (smooth spools)
  spoolCtx: null, // { consumedBefore, total, timeAtPoll, atMs, isPlaying }
  spoolTicker: null,
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const API = {
  search: (q, year, fmt) => {
    const p = new URLSearchParams({ q });
    if (year) p.set("year", year);
    if (fmt)  p.set("fmt", fmt);
    p.set("rows", "40");
    return api(`/api/search?${p}`);
  },
  item: (id) => api(`/api/item/${encodeURIComponent(id)}`),
  players: () => api(`/api/lyrion/players`),
  status: (mac) => api(`/api/lyrion/status?player_mac=${encodeURIComponent(mac)}`),
  play:    (mac, url)  => post("/api/lyrion/play",       { player_mac: mac, url }),
  add:     (mac, url)  => post("/api/lyrion/add",        { player_mac: mac, url }),
  insert:  (mac, url)  => post("/api/lyrion/insert",     { player_mac: mac, url }),
  playShow:(mac, urls) => post("/api/lyrion/play_show",  { player_mac: mac, urls }),
  loadShow:(mac, urls) => post("/api/lyrion/load_show",  { player_mac: mac, urls }),
  start:   (mac)       => post("/api/lyrion/start",      { player_mac: mac }),
  pause:   (mac)       => post("/api/lyrion/pause",      { player_mac: mac }),
  stop:    (mac)       => post("/api/lyrion/stop",       { player_mac: mac }),
  eject:   (mac)       => post("/api/lyrion/eject",      { player_mac: mac }),
  next:    (mac)       => post("/api/lyrion/next",       { player_mac: mac }),
  prev:    (mac)       => post("/api/lyrion/prev",       { player_mac: mac }),
};
function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

// ---------- toasts / banner ----------
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " is-error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

let bannerActive = false;
function setBanner(msg) {
  const b = $("#banner");
  if (!msg) {
    b.hidden = true;
    b.textContent = "";
    bannerActive = false;
    return;
  }
  if (bannerActive && b.textContent === msg) return;
  b.hidden = false;
  b.textContent = msg;
  bannerActive = true;
}

function handleLyrionError(e) {
  if (e.status === 502) {
    setBanner("Lyrion server unreachable — check that LMS is running, then refresh players.");
    toast("lyrion unreachable", "error");
  } else {
    toast(`error · ${e.message}`, "error");
  }
}

// ---------- formatters ----------
const fmtDate = (d) => (!d ? "—" : d.replace(/-/g, " · "));

function fmtDownloads(n) {
  n = Number(n) || 0;
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M dl`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k dl`;
  return `${n} dl`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- archive item resolution ----------
function identifierFromUrl(url) {
  const m = (url || "").match(ARCHIVE_DL_RE);
  return m ? decodeURIComponent(m[1]) : null;
}

// Match a Lyrion-reported URL to a known track. Lyrion sometimes returns
// mangled URLs (e.g. `%2C%20` → `,20`), so we resolve via identifier + the
// trailing filename (which both sides preserve correctly).
function findTrackByUrl(url) {
  if (!url) return null;

  // Pass 1: exact match
  for (const item of state.items.values()) {
    for (const t of item.tracks || []) {
      if (t.url === url) return { item, track: t };
    }
  }

  const id = identifierFromUrl(url);
  if (!id) return null;
  const item = state.items.get(id);
  if (!item) return null;

  const probeFile = (() => {
    const last = url.split("?")[0].split("/").pop() || "";
    try { return decodeURIComponent(last); } catch { return last; }
  })();

  for (const t of item.tracks || []) {
    const trackFile = (t.name || "").split("/").pop();
    if (trackFile && probeFile && trackFile === probeFile) return { item, track: t };
    if (trackFile && probeFile && trackFile.toLowerCase() === probeFile.toLowerCase()) return { item, track: t };
  }
  return null;
}

async function ensureItemForUrl(url) {
  const id = identifierFromUrl(url);
  if (!id) return null;
  if (state.items.has(id)) return state.items.get(id);
  if (state.fetchingItems.has(id)) return null;
  state.fetchingItems.add(id);
  try {
    const item = await API.item(id);
    state.items.set(id, item);
    return item;
  } catch {
    return null;
  } finally {
    state.fetchingItems.delete(id);
  }
}

// ---------- now-playing cassette label ----------
function setNowPlaying({ album, track, side } = {}) {
  $("#deckAlbum").textContent = album || "—";
  $("#deckTrack").textContent = track || "—";
  if (side) $("#deckSide").textContent = side;
}

function showAlbumLabel(item) {
  if (!item) return "—";
  const creator = (item.creator || "").trim();
  const date = item.date ? item.date.replace(/-/g, "·") : "";
  if (creator && date) return `${creator} · ${date}`.toUpperCase();
  if (creator) return creator.toUpperCase();
  if (date) return date;
  return (item.title || "—").toUpperCase();
}

function urlBasename(u) {
  try {
    const last = u.split("?")[0].split("/").pop() || "";
    return decodeURIComponent(last).replace(/\.[^.]+$/, "");
  } catch {
    return "";
  }
}

function parseLength(s) {
  if (!s) return 0;
  const parts = String(s).split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// ---------- tape spools ----------
// Hub diameter range: supply reel goes from MAX (full reel of tape) →
// MIN (bare hub gear), takeup goes the opposite way. Hubs are LARGER than
// the window so the top + bottom arcs of the reels get clipped — same
// trick a real cassette uses.
const HUB_MIN = 22;
const HUB_MAX = 88;

function setSpools(progress) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const supply = HUB_MAX - (HUB_MAX - HUB_MIN) * p;
  const takeup = HUB_MIN + (HUB_MAX - HUB_MIN) * p;
  const cassette = $("#deck");
  cassette.style.setProperty("--hub-supply", `${supply.toFixed(2)}px`);
  cassette.style.setProperty("--hub-takeup", `${takeup.toFixed(2)}px`);
}

function tickSpools() {
  const ctx = state.spoolCtx;
  if (!ctx || !ctx.total) {
    // Fresh tape if one's loaded (full supply, empty takeup).
    // Empty deck → mid-position so it doesn't look like any state in particular.
    setSpools(state.currentItem ? 0 : 0.5);
    return;
  }
  let t = ctx.timeAtPoll;
  if (ctx.isPlaying) t += (Date.now() - ctx.atMs) / 1000;
  setSpools((ctx.consumedBefore + t) / ctx.total);
}

function startSpoolTicker() {
  if (state.spoolTicker) return;
  state.spoolTicker = setInterval(tickSpools, 250);
}

// ---------- J-card insert (tracklist) ----------
function showInsertFor(item, currentUrl) {
  const itemChanged = state.currentItem !== item;
  state.currentItem = item;
  state.currentTrackUrl = currentUrl || null;
  setTransportEnabled(!!state.player);

  // Reset spools to "fresh tape" (full supply / empty takeup) on a new load.
  if (itemChanged) setSpools(0);

  $("#insert").hidden = false;
  $("#welcome").hidden = true;

  $("#insertDate").textContent = item.date ? item.date.replace(/-/g, "·") : "—";
  $("#insertTitle").textContent = item.title || item.identifier || "Untitled";
  $("#insertCreator").textContent = item.creator || "—";
  $("#insertId").textContent = item.identifier || "—";

  const ol = $("#insertTracks");
  ol.innerHTML = "";
  (item.tracks || []).forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "insert__track";
    if (currentUrl && t.url === currentUrl) li.classList.add("is-playing");

    const num = document.createElement("span");
    num.className = "insert__num";
    num.textContent = String(i + 1).padStart(2, "0") + ".";

    const name = document.createElement("span");
    name.className = "insert__name";
    name.textContent = t.title || t.name;

    const time = document.createElement("span");
    time.className = "insert__time";
    time.textContent = t.length || "—";

    li.appendChild(num);
    li.appendChild(name);
    li.appendChild(time);

    li.addEventListener("click", () => sendTrack("play", t, item));
    ol.appendChild(li);
  });
}

function hideInsert() {
  $("#insert").hidden = true;
  state.currentItem = null;
  state.currentTrackUrl = null;
  setTransportEnabled(!!state.player);
  $("#welcome").hidden = false;
}

function updateInsertHighlight(currentUrl) {
  if (!state.currentItem) return;
  state.currentTrackUrl = currentUrl;
  $$("#insertTracks .insert__track").forEach((li, i) => {
    const t = state.currentItem.tracks[i];
    li.classList.toggle("is-playing", currentUrl && t && t.url === currentUrl);
  });
}

// ---------- search modal ----------
function openSearch() {
  if (state.searchOpen) return;
  state.searchOpen = true;
  $("#searchModal").hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => $("#q").focus(), 50);
}
function closeSearch() {
  state.searchOpen = false;
  $("#searchModal").hidden = true;
  if (!state.drawerOpen) document.body.classList.remove("modal-open");
}

// ---------- tape drawer (saved cassettes) ----------
// Server-side persistence at /api/drawer — survives across browsers/devices.
// In-memory cache of the latest server state, keyed by identifier.
const drawerCache = new Map();

// Curated palette of vintage cassette label colors. Always readable.
const TAPE_BANDS = [
  { band: "#d97e2d", band2: "#a85618" }, // orange
  { band: "#c84a3a", band2: "#8a2d22" }, // crimson
  { band: "#5a7080", band2: "#384a5c" }, // slate blue
  { band: "#7a8540", band2: "#535a28" }, // olive
  { band: "#cf8d2c", band2: "#9c6418" }, // mustard
  { band: "#3a5878", band2: "#1f3550" }, // navy
  { band: "#a85a4a", band2: "#723a2c" }, // brick
  { band: "#5a8240", band2: "#374f25" }, // forest
  { band: "#8a4860", band2: "#5a2c3e" }, // burgundy
  { band: "#5a4a30", band2: "#332813" }, // walnut
  { band: "#7a4060", band2: "#502238" }, // plum
  { band: "#b8773a", band2: "#7a4818" }, // amber
];
const TAPE_PAPERS = [
  { p: "#ecdcb8", p2: "#d4c094" }, // manila cream
  { p: "#f0e2c0", p2: "#dac9a4" }, // ivory
  { p: "#e8d8a8", p2: "#c8b888" }, // aged paper
  { p: "#f4e6c8", p2: "#d8c8a4" }, // pale cream
  { p: "#e0d4b0", p2: "#bca888" }, // tan
];
const TAPE_FONTS = [
  '"Caveat", cursive',
  '"Permanent Marker", cursive',
  '"Kalam", cursive',
  '"Indie Flower", cursive',
  '"Architects Daughter", cursive',
  '"Reenie Beanie", cursive',
  '"Shadows Into Light", cursive',
];
const TAPE_INKS = [
  "#1a2858", // dark navy
  "#3a1a1a", // dark crimson
  "#1a3a1a", // forest
  "#28282c", // soft black
  "#3a2a14", // sepia
  "#321a3a", // dark plum
];

// Deterministic hash so the same tape always picks the same color/font
// (until the user explicitly resaves).
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function pickFromHash(arr, seed, salt = 0) {
  return arr[(seed + salt) % arr.length];
}
function randomTapeStyle(identifier) {
  const seed = hashStr(identifier || String(Math.random()));
  const band = pickFromHash(TAPE_BANDS, seed);
  const paper = pickFromHash(TAPE_PAPERS, seed, 7);
  const ink = pickFromHash(TAPE_INKS, seed, 13);
  const font = pickFromHash(TAPE_FONTS, seed, 23);
  return {
    band_color: band.band,
    band_color_2: band.band2,
    label_color: paper.p,
    label_color_2: paper.p2,
    ink_color: ink,
    font,
  };
}

async function fetchTapes() {
  try {
    const data = await api("/api/drawer");
    drawerCache.clear();
    for (const t of data.tapes || []) drawerCache.set(t.identifier, t);
    return Array.from(drawerCache.values());
  } catch {
    return Array.from(drawerCache.values());
  }
}

function getTapesSync() {
  return Array.from(drawerCache.values());
}

async function saveTape(item) {
  if (!item || !item.identifier) return false;
  // Preserve previously-assigned style if the user is re-saving.
  const prior = drawerCache.get(item.identifier);
  const style = prior?.band_color ? prior : randomTapeStyle(item.identifier);
  const body = {
    identifier: item.identifier,
    title: item.title || "",
    creator: item.creator || "",
    date: item.date || "",
    track_count: (item.tracks || []).length,
    band_color: style.band_color,
    label_color: style.label_color,
    ink_color: style.ink_color,
    font: style.font,
  };
  try {
    const r = await post("/api/drawer", body);
    drawerCache.set(item.identifier, r.tape || { ...body, ...style });
    refreshDrawerCount();
    return !prior;
  } catch (e) {
    toast(`couldn't save tape · ${e.message}`, "error");
    return false;
  }
}

async function deleteTape(identifier) {
  try {
    await api(`/api/drawer/${encodeURIComponent(identifier)}`, { method: "DELETE" });
  } catch (e) {
    toast(`couldn't discard · ${e.message}`, "error");
    return;
  }
  drawerCache.delete(identifier);
  refreshDrawerCount();
}

function refreshDrawerCount() {
  const badge = $("#drawerCount");
  if (badge) badge.textContent = String(drawerCache.size);
}

async function openDrawer() {
  if (state.drawerOpen) return;
  state.drawerOpen = true;
  $("#drawerModal").hidden = false;
  document.body.classList.add("modal-open");
  await fetchTapes();
  renderDrawer();
}
function closeDrawer() {
  state.drawerOpen = false;
  $("#drawerModal").hidden = true;
  if (!state.searchOpen) document.body.classList.remove("modal-open");
}

function applyTapeStyle(el, t) {
  // Backfill style for legacy tapes saved before colors were a thing.
  if (!t.band_color) {
    const style = randomTapeStyle(t.identifier);
    Object.assign(t, style);
  }
  // Find a matching shade-2 if the saved entry only has the primary band.
  const match = TAPE_BANDS.find((b) => b.band === t.band_color);
  const band2 = match ? match.band2 : t.band_color_2 || t.band_color;
  const paperMatch = TAPE_PAPERS.find((p) => p.p === t.label_color);
  const paper2 = paperMatch ? paperMatch.p2 : t.label_color_2 || t.label_color;
  el.style.setProperty("--tape-band",   t.band_color);
  el.style.setProperty("--tape-band-2", band2);
  el.style.setProperty("--tape-paper",  t.label_color || "#ecdcb8");
  el.style.setProperty("--tape-paper-2", paper2 || "#d4c094");
  el.style.setProperty("--tape-ink",    t.ink_color || "#2a2858");
  el.style.setProperty("--tape-font",   t.font || '"Caveat", cursive');
}

function renderDrawer() {
  const tapes = getTapesSync();
  const grid = $("#drawerGrid");
  const empty = $("#drawerEmpty");
  grid.innerHTML = "";
  if (!tapes.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const t of tapes) {
    const tpl = $("#tapeTemplate").content.cloneNode(true);
    const tape = tpl.querySelector(".tape");
    tape.dataset.id = t.identifier;
    applyTapeStyle(tape, t);

    tpl.querySelector(".tape__creator").textContent = (t.creator || "—").toUpperCase();
    tpl.querySelector(".tape__title").textContent = t.title || t.identifier;
    tpl.querySelector(".tape__date").textContent = t.date ? t.date.replace(/-/g, "·") : "";
    const tc = t.track_count || t.trackCount;
    tpl.querySelector(".tape__count").textContent = tc
      ? `${tc} track${tc === 1 ? "" : "s"}`
      : "";

    tpl.querySelector(".tape__shell").addEventListener("click", () =>
      loadTapeOntoDeck(t.identifier),
    );
    tpl.querySelector(".tape__delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteTape(t.identifier);
      renderDrawer();
    });
    grid.appendChild(tpl);
  }
}

async function loadTapeOntoDeck(identifier) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  let item = state.items.get(identifier);
  if (!item) {
    try {
      item = await API.item(identifier);
      state.items.set(identifier, item);
    } catch (e) {
      toast(`couldn't load tape · ${e.message}`, "error");
      return;
    }
  }
  if (!item.tracks || !item.tracks.length) {
    toast("this tape has no playable tracks", "error");
    return;
  }
  try {
    const urls = item.tracks.map((t) => t.url);
    // Load without auto-play — user presses PLAY when ready.
    await API.loadShow(state.player, urls);
    Sound.tapeLoad();
    setNowPlaying({
      album: showAlbumLabel(item),
      track: item.tracks[0].title || item.tracks[0].name,
      side: "A",
    });
    $("#deck").classList.remove("is-playing");
    showInsertFor(item, item.tracks[0].url);
    closeDrawer();
    toast(`▸ tape loaded · ${urls.length} tracks · press PLAY`);
    setTimeout(refreshStatus, 700);
  } catch (e) {
    handleLyrionError(e);
  }
}

async function recordTape() {
  if (!state.currentItem) {
    toast("no tape loaded to record", "error");
    return;
  }
  // visual REC flash
  const deck = $("#deck");
  deck.classList.add("is-recording");
  setTimeout(() => deck.classList.remove("is-recording"), 900);
  // brief key press
  const recBtn = document.querySelector('.key[data-action="rec"]');
  if (recBtn) {
    recBtn.classList.add("is-pressed");
    setTimeout(() => recBtn.classList.remove("is-pressed"), 500);
  }
  const isNew = await saveTape(state.currentItem);
  toast(isNew
    ? `● woven into the tapestry · ${(state.currentItem.title || "").slice(0, 50)}`
    : `● rewoven · ${(state.currentItem.title || "").slice(0, 50)}`);
}

// ---------- suggestions ----------
function renderSuggestions() {
  const ul = $("#suggestions");
  ul.innerHTML = "";
  for (const s of SUGGESTIONS) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `▸ ${s}`;
    btn.addEventListener("click", () => {
      $("#q").value = s;
      doSearch();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

// ---------- results (in modal) ----------
function renderResults() {
  const ol = $("#results");
  ol.innerHTML = "";
  $("#empty").hidden = state.results.length > 0;

  state.results.forEach((r, i) => {
    const tpl = $("#cardTemplate").content.cloneNode(true);
    const card = tpl.querySelector(".card");
    card.dataset.id = r.identifier;
    card.style.animationDelay = `${Math.min(i * 35, 350)}ms`;

    tpl.querySelector(".card__index").textContent = String(i + 1).padStart(3, "0");
    tpl.querySelector(".card__title").textContent = r.title || "Untitled";
    tpl.querySelector(".card__creator").textContent = r.creator || "—";
    tpl.querySelector(".card__date").textContent = fmtDate(r.date);
    tpl.querySelector(".card__downloads").textContent = fmtDownloads(r.downloads);
    tpl.querySelector(".card__snippet").textContent = r.description_snippet || "";
    tpl.querySelector(".card__id").textContent = r.identifier;

    tpl.querySelector(".card__expand").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCard(card, r.identifier);
    });
    tpl.querySelector(".card__play-show").addEventListener("click", async (e) => {
      e.stopPropagation();
      await playShow(r.identifier, e.currentTarget);
    });
    card.addEventListener("click", () => {
      if (!card.classList.contains("is-open")) toggleCard(card, r.identifier);
    });
    card.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === card) {
        e.preventDefault();
        toggleCard(card, r.identifier);
      }
    });

    ol.appendChild(tpl);
  });
}

async function toggleCard(cardEl, id) {
  const expandBtn = cardEl.querySelector(".card__expand");
  const trackBox = cardEl.querySelector(".card__tracks");
  if (cardEl.classList.contains("is-open")) {
    cardEl.classList.remove("is-open");
    trackBox.hidden = true;
    expandBtn.textContent = "Tracks ▾";
    return;
  }
  cardEl.classList.add("is-open");
  expandBtn.textContent = "Hide ▴";
  trackBox.hidden = false;

  let item = state.items.get(id);
  if (!item) {
    trackBox.innerHTML = `<div class="tracks-loading">FETCHING METADATA · · ·</div>`;
    try {
      item = await API.item(id);
      state.items.set(id, item);
    } catch (e) {
      trackBox.innerHTML = `<div class="tracks-error">ERROR — ${e.message}</div>`;
      return;
    }
  }
  renderTracks(trackBox, item);
}

function renderTracks(box, item) {
  box.innerHTML = "";
  if (!item.tracks || !item.tracks.length) {
    box.innerHTML = `<div class="tracks-empty">no streamable audio files found in this item</div>`;
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "tracks";

  item.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track";

    const num = document.createElement("div");
    num.className = "track__num";
    num.textContent = String(i + 1).padStart(2, "0");

    const title = document.createElement("div");
    title.className = "track__title";
    title.textContent = t.title || t.name;
    title.title = t.name;

    const meta = document.createElement("div");
    meta.className = "track__meta";
    const length = document.createElement("span");
    length.className = "track__length";
    length.textContent = t.length || "—";
    const fmt = document.createElement("span");
    fmt.className = "track__fmt";
    fmt.textContent = t.format || "";
    meta.appendChild(length);
    meta.appendChild(fmt);
    if (t.size_h) {
      const size = document.createElement("span");
      size.className = "track__size";
      size.textContent = t.size_h;
      meta.appendChild(size);
    }

    const actions = document.createElement("div");
    actions.className = "track__actions";
    actions.innerHTML = `
      <button class="track__btn" data-act="play"   title="Play (replace queue)" aria-label="play">▸</button>
      <button class="track__btn" data-act="insert" title="Play next"            aria-label="play next">⤓</button>
      <button class="track__btn" data-act="add"    title="Add to queue"         aria-label="add to queue">＋</button>
    `;
    actions.querySelector('[data-act="play"]')  .addEventListener("click", () => sendTrack("play",   t, item));
    actions.querySelector('[data-act="insert"]').addEventListener("click", () => sendTrack("insert", t, item));
    actions.querySelector('[data-act="add"]')   .addEventListener("click", () => sendTrack("add",    t, item));

    row.appendChild(num);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(actions);
    wrap.appendChild(row);
  });

  box.appendChild(wrap);
}

// ---------- play actions ----------
async function sendTrack(action, t, item) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  try {
    if (action === "play")        await API.play(state.player, t.url);
    else if (action === "add")    await API.add(state.player, t.url);
    else if (action === "insert") await API.insert(state.player, t.url);
    const verb = { play: "▸ playing", add: "＋ queued", insert: "⤓ up next" }[action];
    toast(`${verb} · ${t.title || t.name}`);
    if (action === "play" && item) {
      setNowPlaying({
        album: showAlbumLabel(item),
        track: t.title || t.name,
        side: "A",
      });
      $("#deck").classList.add("is-playing");
      showInsertFor(item, t.url);
      closeSearch();
    } else if ((action === "add" || action === "insert") && item && !state.currentItem) {
      // queue is filling but nothing's loaded yet — stage the insert
      showInsertFor(item, null);
    }
    setTimeout(refreshStatus, 700);
  } catch (e) {
    handleLyrionError(e);
  }
}

async function playShow(id, btn) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "▸ loading…"; }
  try {
    let item = state.items.get(id);
    if (!item) {
      item = await API.item(id);
      state.items.set(id, item);
    }
    const urls = (item.tracks || []).map((t) => t.url);
    if (!urls.length) { toast("nothing playable in this item", "error"); return; }
    // Load the queue but DON'T start playing — user has to press PLAY.
    await API.loadShow(state.player, urls);
    Sound.tapeLoad();
    toast(`▸ tape loaded · ${urls.length} tracks · press PLAY`);
    setNowPlaying({
      album: showAlbumLabel(item),
      track: item.tracks[0].title || item.tracks[0].name,
      side: "A",
    });
    $("#deck").classList.remove("is-playing");
    showInsertFor(item, item.tracks[0].url);
    closeSearch();
    setTimeout(refreshStatus, 700);
  } catch (e) {
    handleLyrionError(e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "▸ Load tape"; }
  }
}

// ---------- search ----------
async function doSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  const year = $("#year").value.trim();
  const fmt = $('input[name="fmt"]:checked').value;
  state.lastQuery = { q, year, fmt };

  $("#loading").hidden = false;
  $("#results").innerHTML = "";
  $("#empty").hidden = true;

  try {
    const data = await API.search(q, year, fmt);
    state.results = data.results || [];
    renderResults();
    if (!state.results.length) {
      $("#empty").hidden = false;
      $("#emptyTitle").innerHTML =
        `<em>“${escapeHTML(q)}”</em> turned up nothing.<br>Try fewer words, or drop the year.`;
    }
  } catch (e) {
    toast(`search failed · ${e.message}`, "error");
  } finally {
    $("#loading").hidden = true;
  }
}

// ---------- players + now-playing ----------
async function loadPlayers() {
  const sel = $("#player");
  try {
    const { players } = await API.players();
    sel.innerHTML = "";
    if (!players.length) {
      sel.innerHTML = `<option value="">(no players)</option>`;
      setTransportEnabled(false);
      return;
    }
    sel.innerHTML =
      `<option value="">— select —</option>` +
      players
        .map((p) => `<option value="${p.mac}">${escapeHTML(p.name)}${p.power ? "" : " · off"}</option>`)
        .join("");

    const stored = state.player && players.some((p) => p.mac === state.player);
    if (stored) {
      sel.value = state.player;
    } else if (players.length === 1) {
      sel.value = players[0].mac;
      state.player = players[0].mac;
      localStorage.setItem("lab.player", state.player);
    }
    setTransportEnabled(!!state.player);
    setBanner("");
  } catch (e) {
    if (e.status === 502) {
      setBanner("Lyrion server unreachable — check that LMS is running, then refresh players.");
      sel.innerHTML = `<option value="">— offline —</option>`;
    } else {
      sel.innerHTML = `<option value="">— error —</option>`;
    }
    setTransportEnabled(false);
  }
}

function setTransportEnabled(enabled) {
  $$(".key").forEach((b) => {
    const a = b.dataset.action;
    if (a === "rec" || a === "eject") {
      // REC + EJECT only make sense when a tape is loaded.
      b.disabled = !enabled || !state.currentItem;
      return;
    }
    b.disabled = !enabled;
  });
}

// Set which keys are locked down based on Lyrion's playback mode.
// `play`  → PLAY depressed
// `pause` → PLAY + PAUSE both depressed (classic piano-key behavior)
// `stop`  → all keys release
function updateKeyStates(mode) {
  const playKey  = document.querySelector('.key[data-action="play"]');
  const pauseKey = document.querySelector('.key[data-action="pause"]');
  const stopKey  = document.querySelector('.key[data-action="stop"]');
  if (!playKey) return;
  // Don't touch momentary keys (prev/next/rec) — they manage their own brief flash.
  playKey.classList.toggle("is-pressed",  mode === "play"  || mode === "pause");
  pauseKey.classList.toggle("is-pressed", mode === "pause");
  stopKey.classList.toggle("is-pressed",  mode === "stop");
}

async function refreshStatus() {
  const deck = $("#deck");

  if (!state.player) {
    setNowPlaying({ album: "no player selected", track: "— slot empty —" });
    deck.classList.remove("is-playing");
    state.spoolCtx = null;
    return;
  }

  try {
    const s = await API.status(state.player);
    const isPlaying = s.mode === "play";
    deck.classList.toggle("is-playing", isPlaying);
    updateKeyStates(s.mode || "stop");

    // Update tape counter from playback time
    if (s.time != null) updateCounter(s.time);

    const probeUrl =
      (s.current && s.current.url) ||
      (s.current && s.current.title && /^https?:\/\//.test(s.current.title) ? s.current.title : "");

    // Try cache, then auto-fetch from the URL identifier.
    if (probeUrl) {
      let match = findTrackByUrl(probeUrl);
      if (!match) {
        const item = await ensureItemForUrl(probeUrl);
        if (item) match = findTrackByUrl(probeUrl);
      }
      if (match) {
        setNowPlaying({
          album: showAlbumLabel(match.item),
          track: match.track.title || match.track.name,
          side: "A",
        });
        if (state.currentItem !== match.item) {
          showInsertFor(match.item, probeUrl);
        } else {
          updateInsertHighlight(probeUrl);
        }
        // Album-relative spool progress
        const idx = match.item.tracks.indexOf(match.track);
        const consumedBefore = match.item.tracks.slice(0, idx).reduce(
          (a, t) => a + parseLength(t.length), 0,
        );
        const total = match.item.tracks.reduce(
          (a, t) => a + parseLength(t.length), 0,
        );
        state.spoolCtx = {
          consumedBefore,
          total: total > 0 ? total : (s.duration || 0),
          timeAtPoll: s.time || 0,
          atMs: Date.now(),
          isPlaying,
        };
        setBanner("");
        return;
      }
    }

    // Fall back to whatever Lyrion gave us.
    if (s.current && (s.current.title || s.current.artist)) {
      const t = s.current.title || "";
      if (/^https?:\/\//.test(t)) {
        setNowPlaying({
          album: "(streaming · unknown)",
          track: urlBasename(t) || "—",
        });
      } else {
        setNowPlaying({
          album: (s.current.artist || s.current.album || "—").toUpperCase(),
          track: t || "—",
        });
      }
      state.spoolCtx = {
        consumedBefore: 0,
        total: s.duration || 0,
        timeAtPoll: s.time || 0,
        atMs: Date.now(),
        isPlaying,
      };
      if (!state.currentItem) hideInsert();
    } else if (state.currentItem) {
      // Tape is loaded but the queue is paused/stopped — keep cassette + insert.
      // (User loaded a show and hasn't pressed PLAY yet, or pressed STOP.)
    } else {
      setNowPlaying({ album: "queue empty", track: "— slot empty —" });
      state.spoolCtx = null;
      hideInsert();
    }
    setBanner("");
  } catch (e) {
    if (e.status === 502) {
      setBanner("Lyrion server unreachable — check that LMS is running, then refresh players.");
    }
  }
}

// tape counter rolls with playback time (h:mm:ss → 4 digits, minutes scale)
function updateCounter(seconds) {
  const counter = $("#counter");
  if (!counter) return;
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  // counter format: MMM·SS so listeners see minute count rolling
  const txt = String(m).padStart(3, "0") + String(s).padStart(1, "0");
  const digits = txt.slice(-4);
  counter.querySelectorAll("span").forEach((sp, i) => {
    sp.textContent = digits[i] || "0";
  });
}

function startStatusPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshStatus, 3000);
  refreshStatus();
  startSpoolTicker();
}

// ---------- transport keys ----------
async function transport(action) {
  if (!state.player) { toast("pick a player first", "error"); return; }

  // Optimistic visual press — the next status poll will reconcile.
  const pauseKey = document.querySelector('.key[data-action="pause"]');
  if (action === "play") {
    updateKeyStates("play");
  } else if (action === "pause") {
    const wasPaused = pauseKey.classList.contains("is-pressed");
    updateKeyStates(wasPaused ? "play" : "pause");
  } else if (action === "stop") {
    updateKeyStates("stop");
  } else if (action === "prev" || action === "next") {
    const btn = document.querySelector(`.key[data-action="${action}"]`);
    btn.classList.add("is-pressed");
    setTimeout(() => btn.classList.remove("is-pressed"), 240);
  }

  try {
    if (action === "play")       await API.start(state.player);
    else if (action === "pause") await API.pause(state.player);
    else if (action === "stop")  await API.stop(state.player);
    else if (action === "next")  await API.next(state.player);
    else if (action === "prev")  await API.prev(state.player);
    setTimeout(refreshStatus, 350);
  } catch (e) {
    handleLyrionError(e);
  }
}

async function ejectTape() {
  if (!state.player) { toast("pick a player first", "error"); return; }
  Sound.eject();
  // Immediate visual: flash eject key, clear cassette + insert
  const ejectKey = document.querySelector('.key[data-action="eject"]');
  if (ejectKey) {
    ejectKey.classList.add("is-pressed");
    setTimeout(() => ejectKey.classList.remove("is-pressed"), 320);
  }
  try {
    await API.eject(state.player);
  } catch (e) {
    handleLyrionError(e);
    return;
  }
  hideInsert();
  setNowPlaying({ album: "no tape loaded", track: "— slot empty —" });
  $("#deck").classList.remove("is-playing");
  updateKeyStates("stop");
  state.spoolCtx = null;
  setSpools(0);
  toast("▲ tape ejected");
  setTimeout(refreshStatus, 350);
}

// ---------- wire-up ----------
function init() {
  renderSuggestions();
  loadPlayers().then(startStatusPolling);

  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch();
  });

  $("#player").addEventListener("change", (e) => {
    state.player = e.target.value;
    if (state.player) localStorage.setItem("lab.player", state.player);
    else localStorage.removeItem("lab.player");
    setTransportEnabled(!!state.player);
    refreshStatus();
  });

  $$('input[name="fmt"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (state.lastQuery) doSearch();
    })
  );

  $$(".key").forEach((b) =>
    b.addEventListener("click", () => {
      Sound.keyDown();
      const action = b.dataset.action;
      if (action === "rec")         recordTape();
      else if (action === "eject")  ejectTape();
      else                          transport(action);
    })
  );

  // search modal
  $("#openSearch").addEventListener("click", openSearch);
  $("#welcomeSearch").addEventListener("click", openSearch);
  $("#closeSearch").addEventListener("click", closeSearch);
  $("#modalBackdrop").addEventListener("click", closeSearch);

  // tape drawer modal
  fetchTapes().then(refreshDrawerCount);
  $("#openDrawer").addEventListener("click", openDrawer);
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.searchOpen) { e.preventDefault(); closeSearch(); return; }
      if (state.drawerOpen) { e.preventDefault(); closeDrawer(); return; }
    }
    const inField =
      document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "SELECT" ||
      document.activeElement.tagName === "TEXTAREA";
    if (inField) return;
    if (e.key === "/" && !state.searchOpen) {
      e.preventDefault();
      openSearch();
    } else if ((e.key === "t" || e.key === "T") && !state.drawerOpen) {
      e.preventDefault();
      openDrawer();
    } else if ((e.key === "r" || e.key === "R") && state.currentItem) {
      e.preventDefault();
      recordTape();
    } else if ((e.key === "e" || e.key === "E") && state.currentItem) {
      e.preventDefault();
      ejectTape();
    }
  });
}

init();
