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

// Player selection: {backend: "lyrion"|"local", id, name} or null.
// Migrated from the old `lab.player` string (which held a Lyrion MAC).
function loadStoredPlayer() {
  try {
    const raw = localStorage.getItem("tapestry.player.v2");
    if (raw) return JSON.parse(raw);
  } catch {}
  const legacyMac = localStorage.getItem("lab.player");
  if (legacyMac) return { backend: "lyrion", id: legacyMac, name: "" };
  return null;
}
function storePlayer(p) {
  if (p) localStorage.setItem("tapestry.player.v2", JSON.stringify(p));
  else localStorage.removeItem("tapestry.player.v2");
  localStorage.removeItem("lab.player");
}
function playerKey(p) {
  return p ? `${p.backend}:${p.id}` : "";
}

const state = {
  player: loadStoredPlayer(),     // {backend, id, name} | null
  results: [],
  items: new Map(),               // identifier → item metadata
  fetchingItems: new Set(),       // in-flight identifiers
  pollTimer: null,
  lastQuery: null,
  searchOpen: false,
  drawerOpen: false,
  currentItem: null,              // item currently loaded on the deck
  currentTrackUrl: null,
  // Playback context for predicting time between status polls (smooth spools)
  spoolCtx: null, // { consumedBefore, total, timeAtPoll, atMs, isPlaying }
  spoolTicker: null,
  // Mix-tape build state. null until the user adds the first track.
  // tracks: [{url, title, length, lengthSec, source_id, source_title}, ...]
  mix: null,
};

const MIX_MAX_SECONDS = 90 * 60;

// Populated from /api/health at boot; used in the colophon + settings header.
let appVersion = "";

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
  search: (q, year, fmt, source, creatorOnly) => {
    const p = new URLSearchParams({ q });
    if (year) p.set("year", year);
    if (fmt)  p.set("fmt", fmt);
    if (source) p.set("source", source);
    if (creatorOnly) p.set("creator_only", "true");
    p.set("rows", "100");
    return api(`/api/search?${p}`);
  },
  item: (id) => api(`/api/item/${encodeURIComponent(id)}`),
  players: () => api(`/api/players`),
  rescan:  () => post(`/api/players/rescan`, {}),
  getSettings: () => api(`/api/settings`),
  saveSettings: (patch) => post(`/api/settings`, patch),
  discoverLyrion: () => api(`/api/lyrion/discover`),
  checkUpdates: () => api(`/api/updates/check`),
  autoCheckUpdates: () => api(`/api/updates/auto`),
  installUpdate: (downloadUrl) => post(`/api/updates/install`, { download_url: downloadUrl }),
  exportTape: (id, { cover = "embed" } = {}) =>
    api(`/api/tape/${encodeURIComponent(id)}/export?cover=${cover}`),
  importTape: (payload) => post(`/api/tape/import`, { payload }),
};
function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

// ---------- per-backend drivers ----------
// Server-side backends (Lyrion, DLNA, future AirPlay/Chromecast) all hit the
// unified /api/players/{backend}/{id}/{action} surface. The local backend
// drives an HTML <audio> element directly — the server doesn't see it.

function apiPath(p, action) {
  return `/api/players/${p.backend}/${encodeURIComponent(p.id)}/${action}`;
}

const apiDriver = {
  status:   (p)        => api(apiPath(p, "status")),
  play:     (p, url)   => post(apiPath(p, "play"),       { url }),
  add:      (p, url)   => post(apiPath(p, "add"),        { url }),
  insert:   (p, url)   => post(apiPath(p, "insert"),     { url }),
  playShow: (p, urls)  => post(apiPath(p, "play_show"),  { urls }),
  loadShow: (p, urls)  => post(apiPath(p, "load_show"),  { urls }),
  start:    (p)        => post(apiPath(p, "start"),      {}),
  pause:    (p)        => post(apiPath(p, "pause"),      {}),
  stop:     (p)        => post(apiPath(p, "stop"),       {}),
  next:     (p)        => post(apiPath(p, "next"),       {}),
  prev:     (p)        => post(apiPath(p, "prev"),       {}),
  eject:    (p)        => post(apiPath(p, "eject"),      {}),
  seek:     (p, delta) => post(apiPath(p, "seek_by"),    { delta }),
};

// `started` distinguishes "armed but never played" (mode=stop, no keys
// pressed) from "user pressed play, then paused" (mode=pause, PLAY+PAUSE
// both depressed — the piano-key behavior). Without this, loadShow leaves
// the `<audio>` element paused-with-src and the deck reads as paused.
const localCtx = { queue: [], idx: 0, started: false };
let localAudio = null;
function localMode() {
  const a = localAudio;
  const has = !!(a && a.currentSrc);
  if (!has) return "stop";
  if (a.ended) return "stop";
  if (!a.paused) return "play";
  return localCtx.started ? "pause" : "stop";
}
function ensureLocalAudio() {
  if (localAudio) return localAudio;
  localAudio = $("#localAudio");
  if (!localAudio) return null;
  localAudio.addEventListener("ended", () => {
    if (localCtx.idx + 1 < localCtx.queue.length) localPlayAt(localCtx.idx + 1, true);
    else localCtx.started = false;
  });
  // Once the audio actually starts playing, we're past "armed" — future
  // pauses should show as mode=pause, not mode=stop.
  localAudio.addEventListener("play", () => { localCtx.started = true; });
  // Reflect transport-key state without waiting for the next poll.
  const reflect = () => {
    updateKeyStates(localMode());
    refreshStatus();
  };
  ["play", "pause", "ended", "loadedmetadata"].forEach((ev) =>
    localAudio.addEventListener(ev, reflect),
  );
  return localAudio;
}
function localPlayAt(i, autoplay) {
  const a = ensureLocalAudio();
  if (!a) return;
  if (i < 0 || i >= localCtx.queue.length) return;
  localCtx.idx = i;
  a.src = localCtx.queue[i];
  applySinkId(a).then(() => {
    if (autoplay) a.play().catch(() => {});
  });
}

// ---------- audio output routing (setSinkId) ----------
// Lets the user pick which macOS audio output the local backend renders to
// (built-in speakers, BT speaker, AirPods, HDMI, USB DAC, ...). We expand
// the server-side "This Mac" entry into one entry per output device on the
// frontend, then route via HTMLMediaElement.setSinkId. WKWebView's support
// is patchy; if either enumerateDevices() or setSinkId is missing we fall
// back to the single "This Mac" entry routed to the default output.
const sinkSupport = {
  canList: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
  // setSinkId is on HTMLMediaElement.prototype — feature-detect lazily so
  // we don't trip on the first ensureLocalAudio() call.
  canRoute: typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function",
};

let audioOutputs = [];  // [{deviceId, label}]

async function listAudioOutputs() {
  if (!sinkSupport.canList) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audiooutput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "" }));
  } catch {
    return [];
  }
}

async function applySinkId(audioEl) {
  if (!sinkSupport.canRoute) return;
  if (state.player?.backend !== "local") return;
  // The "this-device" id is the default-output entry — leave sink unset.
  const id = state.player.id;
  if (!id || id === "this-device" || id === "default") return;
  try {
    await audioEl.setSinkId(id);
  } catch (e) {
    // Permission revoked / device gone — fall back to default, surface once.
    if (!applySinkId._warned) {
      applySinkId._warned = true;
      toast(`couldn't route to ${state.player.name} · ${e.message}`, "error");
    }
  }
}

// Unlock device labels by requesting and immediately releasing a mic
// stream. Browsers return empty `label` strings from enumerateDevices()
// until the user has granted at least one media-device permission this
// session; this is the cheapest way to flip that switch.
async function unlockOutputLabels() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not available");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

const localDriver = {
  status: async () => {
    const a = ensureLocalAudio();
    const has = !!(a && a.currentSrc);
    const url = localCtx.queue[localCtx.idx] || "";
    return {
      mode: localMode(),
      power: true,
      volume: a ? Math.round((a.volume || 1) * 100) : 100,
      time: a ? (a.currentTime || 0) : 0,
      duration: a ? (a.duration || 0) : 0,
      playlist_index: has ? localCtx.idx : null,
      playlist_tracks: localCtx.queue.length,
      current: has ? { url, title: "", artist: "", album: "", duration: a.duration || 0 } : null,
    };
  },
  play: async (_p, url) => {
    localCtx.queue = [url];
    localPlayAt(0, true);
    return {};
  },
  add: async (_p, url) => {
    localCtx.queue.push(url);
    if (localCtx.queue.length === 1) localPlayAt(0, true);
    return {};
  },
  insert: async (_p, url) => {
    localCtx.queue.splice(localCtx.idx + 1, 0, url);
    return {};
  },
  playShow: async (_p, urls) => {
    localCtx.queue = (urls || []).slice();
    if (localCtx.queue.length) localPlayAt(0, true);
    return { queued: localCtx.queue.length };
  },
  loadShow: async (_p, urls) => {
    const a = ensureLocalAudio();
    localCtx.queue = (urls || []).slice();
    localCtx.idx = 0;
    localCtx.started = false;
    if (a && localCtx.queue.length) {
      a.src = localCtx.queue[0];   // armed but not playing
      await applySinkId(a);
      a.pause();
    }
    return { queued: localCtx.queue.length, playing: false };
  },
  start: async () => {
    const a = ensureLocalAudio();
    if (!a) return {};
    if (!a.currentSrc && localCtx.queue.length) localPlayAt(localCtx.idx, true);
    else {
      await applySinkId(a);
      a.play().catch(() => {});
    }
    return {};
  },
  pause: async () => {
    const a = ensureLocalAudio();
    if (!a) return {};
    if (a.paused) a.play().catch(() => {}); else a.pause();
    return {};
  },
  stop: async () => {
    const a = ensureLocalAudio();
    if (a) { a.pause(); a.currentTime = 0; }
    localCtx.started = false;
    return {};
  },
  next: async () => {
    const a = ensureLocalAudio();
    if (localCtx.idx + 1 < localCtx.queue.length) {
      localPlayAt(localCtx.idx + 1, !!(a && !a.paused));
    }
    return {};
  },
  prev: async () => {
    const a = ensureLocalAudio();
    if (localCtx.idx > 0) localPlayAt(localCtx.idx - 1, !!(a && !a.paused));
    else if (a) a.currentTime = 0;
    return {};
  },
  eject: async () => {
    const a = ensureLocalAudio();
    if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
    localCtx.queue = [];
    localCtx.idx = 0;
    localCtx.started = false;
    return {};
  },
  seek: async (_p, delta) => {
    const a = ensureLocalAudio();
    if (!a || !a.currentSrc) return {};
    const dur = a.duration || 0;
    const t = Math.max(0, (a.currentTime || 0) + delta);
    a.currentTime = dur > 0 ? Math.min(t, dur - 0.1) : t;
    return {};
  },
};

const drivers = { lyrion: apiDriver, dlna: apiDriver, local: localDriver };
function driver() {
  return drivers[state.player?.backend] || apiDriver;
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

function handlePlayerError(e) {
  const isLyrion = state.player?.backend === "lyrion";
  if (e.status === 502 && isLyrion) {
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
  // Tick the four-digit counter alongside the spools so it doesn't depend
  // on the every-three-seconds status poll alone.
  updateCounter(t);
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

  // Per-tape style: deck cassette matches the drawer cassette for the same
  // item. Start with the deterministic hash-based style; if we can pull a
  // palette out of the artwork, override with that.
  if (itemChanged) {
    const baseStyle = randomTapeStyle(item.identifier);
    item._style = { ...baseStyle };
    applyDeckStyle(item._style);
  }

  // Album artwork as deck backdrop + palette source.
  const rack = document.querySelector(".rack");
  if (rack) {
    const url = item.image_url || "";
    if (itemChanged) rack.style.removeProperty("--album-art");
    if (url) {
      const probe = new Image();
      probe.decoding = "async";
      probe.onload = () => {
        if (state.currentItem === item) {
          rack.style.setProperty("--album-art", `url("${url}")`);
        }
      };
      probe.src = url;

      if (itemChanged) {
        extractPaletteFromImage(item.identifier, url).then((extracted) => {
          if (!extracted || state.currentItem !== item) return;
          item._style = { ...item._style, ...extracted, font: item._style.font };
          applyDeckStyle(item._style);
        });
      }
    }
  }

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
  const rack = document.querySelector(".rack");
  if (rack) rack.style.removeProperty("--album-art");
  clearDeckStyle();
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

// Apply per-tape colors to the playing cassette so the deck and the drawer
// spine for the same item look like the same tape.
function applyDeckStyle(style) {
  const cassette = $("#deck");
  if (!cassette || !style) return;
  const band = style.band_color || "#d97e2d";
  const band2 = style.band_color_2 || band;
  cassette.style.setProperty("--tape-band", band);
  cassette.style.setProperty("--tape-band-2", band2);
  cassette.style.setProperty("--tape-band-hi", lighten(band, 0.12));
  cassette.style.setProperty("--tape-paper", style.label_color || "#ecdcb8");
  cassette.style.setProperty("--tape-paper-2", style.label_color_2 || "#e0d0a4");
  cassette.style.setProperty("--tape-ink", style.ink_color || "#2a2858");
  cassette.style.setProperty("--tape-font", style.font || '"Caveat", cursive');
}
function clearDeckStyle() {
  const cassette = $("#deck");
  if (!cassette) return;
  ["--tape-band", "--tape-band-2", "--tape-band-hi",
   "--tape-paper", "--tape-paper-2", "--tape-ink", "--tape-font"]
    .forEach((v) => cassette.style.removeProperty(v));
}

// ---------- artwork → palette extraction ----------
// Sample the album artwork on a small canvas, group similar pixels into
// HSL buckets, and pick the most-saturated cluster as the band color.
// archive.org doesn't send CORS headers on /services/img, so we route
// archive.org images through our own /api/artwork/<id> proxy — same
// origin, canvas reads cleanly. Uploaded /covers/* are already same-origin.
const _paletteCache = new Map(); // cache key -> style

function paletteFetchUrl(rawUrl) {
  if (!rawUrl) return "";
  const m = rawUrl.match(/^https?:\/\/archive\.org\/services\/img\/([^?#]+)/i);
  if (m) return `/api/artwork/${m[1]}`;
  return rawUrl;
}

async function extractPaletteFromImage(identifier, url) {
  if (_paletteCache.has(identifier)) return _paletteCache.get(identifier);
  const fetchUrl = paletteFetchUrl(url);
  const style = await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        const W = 48, H = 48;
        cv.width = W; cv.height = H;
        const ctx = cv.getContext("2d");
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;
        finish(paletteFromPixels(data));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    setTimeout(() => finish(null), 6000);
    img.src = fetchUrl;
  });
  if (style) _paletteCache.set(identifier, style);
  return style;
}

// Bucket pixels by hue and pick the most populous saturated bucket as the
// band color; derive paper + ink from value/saturation siblings.
function paletteFromPixels(data) {
  const buckets = new Array(12).fill(0).map(() => ({ count: 0, r: 0, g: 0, b: 0, s: 0 }));
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 200) continue;
    const [h, s, l] = rgb2hsl(r, g, b);
    if (l < 0.08 || l > 0.94) continue; // skip near-black/white
    if (s < 0.18) continue;              // skip washed-out greys
    const bucket = Math.min(11, Math.floor(h / 30));
    const b0 = buckets[bucket];
    b0.count++; b0.r += r; b0.g += g; b0.b += b; b0.s += s;
    total++;
  }
  if (total < 30) return null;
  buckets.sort((a, b) => b.count - a.count);
  const top = buckets[0];
  if (!top.count) return null;
  const r = Math.round(top.r / top.count);
  const g = Math.round(top.g / top.count);
  const b = Math.round(top.b / top.count);
  const band = rgb2hex(r, g, b);
  return {
    band_color: band,
    band_color_2: darken(band, 0.22),
    // Warm cream paper, slightly tinted toward the band hue.
    label_color: tintTowards(band, "#ecdcb8", 0.14),
    label_color_2: tintTowards(band, "#d8c8a4", 0.14),
    // Deep complement-ish ink.
    ink_color: contrastInk(band),
  };
}

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}
function rgb2hex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function hex2rgb(hex) {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function darken(hex, amt) {
  const [r, g, b] = hex2rgb(hex);
  return rgb2hex(Math.round(r * (1 - amt)), Math.round(g * (1 - amt)), Math.round(b * (1 - amt)));
}
function lighten(hex, amt) {
  const [r, g, b] = hex2rgb(hex);
  return rgb2hex(
    Math.min(255, Math.round(r + (255 - r) * amt)),
    Math.min(255, Math.round(g + (255 - g) * amt)),
    Math.min(255, Math.round(b + (255 - b) * amt)),
  );
}
function tintTowards(srcHex, dstHex, srcWeight) {
  const [r1, g1, b1] = hex2rgb(srcHex);
  const [r2, g2, b2] = hex2rgb(dstHex);
  const w = Math.max(0, Math.min(1, srcWeight));
  return rgb2hex(
    Math.round(r1 * w + r2 * (1 - w)),
    Math.round(g1 * w + g2 * (1 - w)),
    Math.round(b1 * w + b2 * (1 - w)),
  );
}
function contrastInk(bandHex) {
  const [r, g, b] = hex2rgb(bandHex);
  const [h] = rgb2hsl(r, g, b);
  // Pick a saturated dark hue roughly opposite the band.
  const dh = (h + 180) % 360;
  return rgb2hex(...hsl2rgb(dh, 0.55, 0.18));
}
function hsl2rgb(h, s, l) {
  h /= 360;
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)]
    .map((v) => Math.round(v * 255));
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
  // Otherwise prefer the live deck style (which may include
  // artwork-extracted colors) over the deterministic hash fallback.
  const prior = drawerCache.get(item.identifier);
  const style = prior?.band_color
    ? prior
    : (item._style || randomTapeStyle(item.identifier));
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

// ---------- settings modal ----------
// Latest release info captured by the most recent check, so the "Download
// & install" button has a download URL to POST without re-hitting the
// GitHub API.
let lastUpdateInfo = null;

async function openSettings() {
  $("#settingsModal").hidden = false;
  document.body.classList.add("modal-open");
  try {
    const s = await API.getSettings();
    $("#settingsLyrionUrl").value = s.lyrion_url || "";
    const src = s.lyrion_url_source;
    const note = $("#settingsLyrionSource");
    if (src === "env") note.textContent = "set via $LYRION_URL env var — saving here won't override it";
    else if (src === "settings") note.textContent = "from your saved settings";
    else note.textContent = "default · localhost:9000";
    $("#settingsAutoUpdate").checked = !!s.auto_check_updates;
    // If we already auto-checked at boot, the result is in lastUpdateInfo;
    // otherwise render whatever we know from settings without a network hit.
    if (lastUpdateInfo) {
      renderUpdateStatus(lastUpdateInfo);
    } else {
      $("#settingsVersion").textContent = `tapestry · v${appVersion || "—"}`;
      $("#settingsUpdateStatus").textContent = s.last_known_latest
        ? `last seen: v${s.last_known_latest}`
        : "";
    }
  } catch {}
}

function renderUpdateStatus(info) {
  const versionEl = $("#settingsVersion");
  const statusEl = $("#settingsUpdateStatus");
  const installBtn = $("#installUpdateBtn");
  const releaseLink = $("#updateReleasePage");
  if (!info) return;
  versionEl.textContent = `tapestry · v${info.current || appVersion || "—"}`;
  if (info.available) {
    statusEl.textContent = `update available · v${info.latest}`;
    statusEl.style.color = "var(--amber)";
    installBtn.hidden = !info.can_install;
    releaseLink.hidden = false;
    if (info.html_url) releaseLink.href = info.html_url;
  } else {
    statusEl.style.color = "";
    statusEl.textContent = info.reason
      ? info.reason
      : `up to date · last checked ${info.checked_at ? fmtRelTime(info.checked_at) : "just now"}`;
    installBtn.hidden = true;
    releaseLink.hidden = true;
  }
}

function fmtRelTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function checkForUpdates({ silent = false } = {}) {
  const statusEl = $("#settingsUpdateStatus");
  if (statusEl && !silent) statusEl.textContent = "checking…";
  try {
    const info = await API.checkUpdates();
    lastUpdateInfo = info;
    setGearUpdateBadge(!!info.available);
    renderUpdateStatus(info);
    return info;
  } catch (e) {
    if (statusEl) statusEl.textContent = `check failed · ${e.message}`;
    if (!silent) toast(`update check failed · ${e.message}`, "error");
    return null;
  }
}

// Mirrors the backend's updater._ver_tuple so the throttle-skip path
// here and is_newer() on the server agree on which tag is newer.
function compareVersions(a, b) {
  const parse = (v) => (String(v || "").match(/\d+/g) || []).map(Number);
  const av = parse(a), bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function setGearUpdateBadge(available) {
  const badge = $("#gearUpdateBadge");
  const btn = $("#openSettings");
  if (!badge || !btn) return;
  badge.hidden = !available;
  btn.title = available ? "Settings · update available" : "Settings";
}

async function runAutoUpdateCheck() {
  // Fire-and-forget on boot. Server throttles via last_update_check_at,
  // so this is safe to call on every page load.
  try {
    let info = await API.autoCheckUpdates();
    // When the 6h throttle skips the GitHub poll, the server still
    // returns cached current/latest. If a known-newer version is
    // pending, run an explicit re-check so we have full install info
    // (download_url, html_url, can_install) to drive the badge → CTA.
    if (info.skipped && info.latest && compareVersions(info.latest, info.current) > 0) {
      try {
        info = await API.checkUpdates();
      } catch {
        // Re-check failed; keep the skipped payload so the badge still
        // shows. We know an update is pending — we just don't have the
        // install URL handy. Settings re-fetches when opened.
        lastUpdateInfo = info;
        setGearUpdateBadge(true);
        return;
      }
    }
    if (!info || info.skipped) {
      lastUpdateInfo = null;
      setGearUpdateBadge(false);
      return;
    }
    lastUpdateInfo = info;
    setGearUpdateBadge(!!info.available);
    if (info.available) {
      const verb = info.can_install ? "open settings to install" : "see release notes";
      toast(`▸ update available · v${info.latest} · ${verb}`);
    }
  } catch (e) {
    // Silent at the UI layer — boot-time check failures shouldn't
    // toast. Log to console so devtools triage still works.
    console.warn("auto-update check failed:", e);
  }
}

async function installUpdate() {
  const info = lastUpdateInfo;
  if (!info || !info.available) return;
  if (!info.can_install) {
    // Dev mode or non-writable bundle — fall back to opening release page.
    window.open(info.html_url, "_blank", "noopener");
    return;
  }
  if (!window.confirm(`Install Tapestry v${info.latest}?\n\nTapestry will quit, the new version will be installed, then it will relaunch.`)) {
    return;
  }
  const btn = $("#installUpdateBtn");
  const statusEl = $("#settingsUpdateStatus");
  btn.disabled = true;
  btn.textContent = "▸ downloading…";
  if (statusEl) statusEl.textContent = "downloading installer…";
  try {
    await API.installUpdate(info.download_url);
    if (statusEl) statusEl.textContent = "installer launched · Tapestry will quit shortly";
    btn.textContent = "▸ quitting…";
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "▸ Download & install";
    if (statusEl) statusEl.textContent = "";
    toast(`install failed · ${e.message}`, "error");
  }
}
function closeSettings() {
  $("#settingsModal").hidden = true;
  if (!state.searchOpen && !state.drawerOpen) document.body.classList.remove("modal-open");
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
  if (state.openTapeId) closeTapeCase();
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

function sortTapes(tapes, mode) {
  const t = tapes.slice();
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  switch (mode) {
    case "saved-asc":   t.sort((a, b) => cmp(a.saved_at || 0, b.saved_at || 0)); break;
    case "title-asc":   t.sort((a, b) => cmp((a.title || "").toLowerCase(), (b.title || "").toLowerCase())); break;
    case "creator-asc": t.sort((a, b) => cmp((a.creator || "").toLowerCase(), (b.creator || "").toLowerCase())); break;
    case "date-asc":    t.sort((a, b) => cmp(a.date || "", b.date || "")); break;
    case "date-desc":   t.sort((a, b) => cmp(b.date || "", a.date || "")); break;
    case "saved-desc":
    default:            t.sort((a, b) => cmp(b.saved_at || 0, a.saved_at || 0));
  }
  return t;
}

function renderDrawer() {
  const sortMode = $("#drawerSort")?.value || "saved-desc";
  const tapes = sortTapes(getTapesSync(), sortMode);
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
      openTapeCase(t.identifier),
    );
    tpl.querySelector(".tape__delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteTape(t.identifier);
      renderDrawer();
    });
    grid.appendChild(tpl);
  }
}

// Open the tape case in the drawer (the "flip the case open" view): shows
// the track list with per-track actions (play, queue, mix) plus a single
// "Load whole tape" action. Replaces the old behavior of clicking a
// drawer cassette and immediately loading it on the deck.
async function openTapeCase(identifier) {
  const drawerEntry = drawerCache.get(identifier);
  if (!drawerEntry) return;

  // Switch the drawer modal into case-open mode.
  $("#drawerGrid").hidden = true;
  $("#drawerEmpty").hidden = true;
  $("#drawerSort")?.parentElement && ($("#drawerSort").parentElement.style.display = "none");
  $("#drawerCase").hidden = false;
  state.openTapeId = identifier;

  // Spine header — match the drawer cassette style for this tape.
  const spine = $("#caseSpine");
  applyTapeStyle(spine, drawerEntry);
  $("#caseCreator").textContent = (drawerEntry.creator || "—").toUpperCase();
  $("#caseTitle").textContent = drawerEntry.title || identifier;
  $("#caseDate").textContent = drawerEntry.date ? drawerEntry.date.replace(/-/g, "·") : "";

  // Album / mix-tape cover art. Mix tapes carry their cover URL on the
  // entry; archive items use archive.org's services/img endpoint.
  const art = $("#caseArt");
  const artUrl = drawerEntry.image_url ||
    (drawerEntry.is_mix
      ? ""
      : `https://archive.org/services/img/${encodeURIComponent(drawerEntry.identifier)}`);
  if (artUrl) {
    art.classList.remove("is-empty");
    art.style.backgroundImage = `url("${artUrl}")`;
  } else {
    art.classList.add("is-empty");
    art.style.backgroundImage = "";
  }

  // Resolve tracks: mix tapes carry them inline; archive items get fetched.
  const box = $("#caseTracks");
  let item;
  if (drawerEntry.is_mix && Array.isArray(drawerEntry.tracks)) {
    item = {
      identifier,
      title: drawerEntry.title || "Mix tape",
      creator: drawerEntry.creator || "Mix tape",
      date: drawerEntry.date || "",
      tracks: drawerEntry.tracks,
      is_mix: true,
      image_url: "",
    };
    state.items.set(identifier, item);
  } else {
    box.innerHTML = `<div class="tracks-loading">FETCHING METADATA · · ·</div>`;
    try {
      item = state.items.get(identifier);
      if (!item) {
        item = await API.item(identifier);
        state.items.set(identifier, item);
      }
    } catch (e) {
      box.innerHTML = `<div class="tracks-error">ERROR — ${e.message}</div>`;
      return;
    }
  }
  $("#caseCount").textContent = `${(item.tracks || []).length} track${(item.tracks || []).length === 1 ? "" : "s"}`;
  renderTracks(box, item);
}

function closeTapeCase() {
  state.openTapeId = null;
  $("#drawerCase").hidden = true;
  $("#drawerGrid").hidden = false;
  const sortBar = $("#drawerSort")?.parentElement;
  if (sortBar) sortBar.style.display = "";
  // Re-render in case the user discarded a tape from the case view.
  renderDrawer();
}

async function loadCurrentCaseTape() {
  if (state.openTapeId) {
    const id = state.openTapeId;
    closeTapeCase();
    await loadTapeOntoDeck(id);
    closeDrawer();
  }
}

async function discardCurrentCaseTape() {
  if (!state.openTapeId) return;
  if (!window.confirm("Discard this tape?")) return;
  await deleteTape(state.openTapeId);
  closeTapeCase();
}

async function loadTapeOntoDeck(identifier) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  let item = state.items.get(identifier);
  if (!item) {
    // Mix tapes are self-contained (their tracks are stored on the drawer
    // entry itself); skip the archive.org fetch.
    const drawerEntry = drawerCache.get(identifier);
    if (drawerEntry?.is_mix && Array.isArray(drawerEntry.tracks)) {
      item = {
        identifier,
        title: drawerEntry.title || "Mix tape",
        creator: drawerEntry.creator || "Mix tape",
        date: drawerEntry.date || "",
        description: "",
        image_url: "",
        tracks: drawerEntry.tracks,
        is_mix: true,
      };
      state.items.set(identifier, item);
    } else {
      try {
        item = await API.item(identifier);
        state.items.set(identifier, item);
      } catch (e) {
        toast(`couldn't load tape · ${e.message}`, "error");
        return;
      }
    }
  }
  if (!item.tracks || !item.tracks.length) {
    toast("this tape has no playable tracks", "error");
    return;
  }
  try {
    const urls = item.tracks.map((t) => t.url);
    // Load without auto-play — user presses PLAY when ready.
    await driver().loadShow(state.player, urls);
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
    handlePlayerError(e);
  }
}

// Save a tape directly from a search row without loading it on the deck.
// Lazy-fetches item metadata so the drawer entry has a real track count.
async function grabTape(searchRow, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "▤ saving…"; }
  try {
    let item = state.items.get(searchRow.identifier);
    if (!item) {
      item = await API.item(searchRow.identifier);
      state.items.set(searchRow.identifier, item);
    }
    const isNew = await saveTape(item);
    toast(isNew
      ? `▤ grabbed · ${(item.title || "").slice(0, 50)}`
      : `▤ already in drawer · ${(item.title || "").slice(0, 50)}`);
  } catch (e) {
    toast(`couldn't grab · ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "▤ Grab"; }
  }
}

// REC key: dub the currently-playing track onto the mix tape under
// construction. (Saving the whole tape to the drawer is now the ▤ Grab
// button on the cassette insert.)
function recordTape() {
  if (!state.currentItem || !state.currentTrackUrl) {
    toast("no track is playing to record", "error");
    return;
  }
  const track = (state.currentItem.tracks || []).find((t) => t.url === state.currentTrackUrl);
  if (!track) {
    toast("can't identify current track", "error");
    return;
  }
  // visual REC flash
  const deck = $("#deck");
  deck.classList.add("is-recording");
  setTimeout(() => deck.classList.remove("is-recording"), 900);
  const recBtn = document.querySelector('.key[data-action="rec"]');
  if (recBtn) {
    recBtn.classList.add("is-pressed");
    setTimeout(() => recBtn.classList.remove("is-pressed"), 500);
  }
  addToMix(track, state.currentItem);
}

// ▤ Grab button on the cassette insert — saves the loaded tape to the
// drawer (the old REC behavior).
async function grabCurrentTape() {
  if (!state.currentItem) {
    toast("no tape loaded to grab", "error");
    return;
  }
  const isNew = await saveTape(state.currentItem);
  toast(isNew
    ? `▤ grabbed · ${(state.currentItem.title || "").slice(0, 50)}`
    : `▤ already in drawer · ${(state.currentItem.title || "").slice(0, 50)}`);
}

// ---------- tape sharing (.tape files + share-link blobs) ----------
// Wire format is defined server-side in app/main.py. The frontend just
// has to encode/decode the JSON blob for URL transport, render preview
// UI, and POST it back through the import endpoint.
const TAPE_FORMAT_NAME = "tapestry-tape";

function encodeBlob(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // URL-safe base64: +/= → -_ (no padding).
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBlob(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isTapePayload(p) {
  return !!(p && typeof p === "object" && p._format === TAPE_FORMAT_NAME);
}

// Pretty "X tracks · M:SS" line for the preview modals.
function tapePreviewMeta(tape) {
  const bits = [];
  if (tape.date) bits.push(tape.date.replace(/-/g, "·"));
  const count = tape.track_count || (tape.tracks || []).length;
  if (count) bits.push(`${count} track${count === 1 ? "" : "s"}`);
  if (tape.is_mix) {
    const total = (tape.tracks || []).reduce((a, t) => a + (t.lengthSec || 0), 0);
    if (total > 0) bits.push(fmtMMSS(total));
  }
  return bits.join(" · ").toUpperCase();
}

let _shareIdentifier = null;

async function openShareModal(identifier) {
  _shareIdentifier = identifier;
  const tape = drawerCache.get(identifier);
  if (!tape) {
    toast("tape not in drawer", "error");
    return;
  }
  $("#shareTapeTitle").textContent = tape.title || identifier;
  $("#shareTapeMeta").textContent = `${(tape.creator || "—").toUpperCase()} · ${tapePreviewMeta(tape)}`;
  $("#shareLink").value = "loading…";
  $("#shareLinkNote").textContent = "";
  $("#shareModal").hidden = false;
  document.body.classList.add("modal-open");

  // Build the URL with cover stripped — keeps grabbed-tape links short
  // and avoids hundreds of KB of base64 in a URL for mix tapes.
  try {
    const payload = await API.exportTape(identifier, { cover: "skip" });
    const blob = encodeBlob(payload);
    const link = `${location.origin}${location.pathname}?import=${blob}`;
    $("#shareLink").value = link;
    const kb = (link.length / 1024).toFixed(1);
    if (link.length > 6000) {
      $("#shareLinkNote").textContent =
        `link is ${kb} kb — large mixes share better as a .tape file`;
    } else {
      $("#shareLinkNote").textContent = `${kb} kb · paste into a friend's tapestry`;
    }
  } catch (e) {
    $("#shareLink").value = "";
    $("#shareLinkNote").textContent = `couldn't build link · ${e.message}`;
  }
}

function closeShareModal() {
  $("#shareModal").hidden = true;
  _shareIdentifier = null;
  if (!state.searchOpen && !state.drawerOpen) document.body.classList.remove("modal-open");
}

async function copyShareLink() {
  const link = $("#shareLink").value;
  if (!link || link === "loading…") return;
  try {
    await navigator.clipboard.writeText(link);
    toast("✓ link copied");
  } catch {
    // Fall back to select-all so the user can ⌘C manually.
    $("#shareLink").select();
    document.execCommand?.("copy");
    toast("✓ link selected · ⌘C to copy");
  }
}

function downloadShareFile() {
  if (!_shareIdentifier) return;
  // mode=file sets Content-Disposition + the .tape extension server-side.
  // A real anchor click is the most reliable way to trigger a download in
  // pywebview's WKWebView; window.open won't always honor it.
  const a = document.createElement("a");
  a.href = `/api/tape/${encodeURIComponent(_shareIdentifier)}/export?mode=file&cover=embed`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
  toast("▤ .tape file downloaded");
}

let _pendingImport = null;

function showImportPreview(payload) {
  if (!isTapePayload(payload)) {
    toast("not a tapestry-tape file", "error");
    return;
  }
  _pendingImport = payload;
  const tape = payload.tape || {};

  $("#importPreviewTitle").textContent = tape.title || tape.identifier || "Untitled tape";
  $("#importPreviewCreator").textContent = (tape.creator || "—").toUpperCase();
  $("#importPreviewMeta").textContent = [
    tape.is_mix ? "mix tape" : "archive.org tape",
    tapePreviewMeta(tape),
  ].filter(Boolean).join(" · ");

  // Cover: embedded data, then external URL, then archive.org service/img.
  const art = $("#importPreviewArt");
  let coverUrl = "";
  if (payload.cover?.data_b64 && payload.cover.mime) {
    coverUrl = `data:${payload.cover.mime};base64,${payload.cover.data_b64}`;
  } else if (tape.image_url) {
    coverUrl = tape.image_url;
  } else if (!tape.is_mix && tape.identifier) {
    coverUrl = `https://archive.org/services/img/${encodeURIComponent(tape.identifier)}`;
  }
  if (coverUrl) {
    art.classList.remove("is-empty");
    art.style.backgroundImage = `url("${coverUrl}")`;
  } else {
    art.classList.add("is-empty");
    art.style.backgroundImage = "";
  }

  $("#importError").hidden = true;
  $("#importError").textContent = "";
  $("#importModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeImportModal() {
  $("#importModal").hidden = true;
  _pendingImport = null;
  if (!state.searchOpen && !state.drawerOpen) document.body.classList.remove("modal-open");
  // If more .tape files were opened in the background while this modal
  // was up (e.g. user selected several files), show the next one.
  setTimeout(pollPendingOpens, 100);
}

async function confirmImport() {
  if (!_pendingImport) return;
  const btn = $("#importConfirm");
  btn.disabled = true;
  btn.textContent = "▤ adding…";
  try {
    const { tape } = await API.importTape(_pendingImport);
    drawerCache.set(tape.identifier, tape);
    refreshDrawerCount();
    if (state.drawerOpen) await renderDrawer();
    closeImportModal();  // closeImportModal will poll for any next queued open-file
    toast(`▤ filed · ${(tape.title || "").slice(0, 50)}`);
  } catch (e) {
    $("#importError").hidden = false;
    $("#importError").textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "▤ Add to drawer";
  }
}

async function importTapeFromFile(file) {
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    toast("file too large", "error");
    return;
  }
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    showImportPreview(payload);
  } catch (e) {
    toast(`couldn't read file · ${e.message}`, "error");
  }
}

// Poll the server-side queue of .tape files opened via Finder double-
// click. The desktop entry point's NSApp delegate drops parsed payloads
// there. We pop one at a time so the import-preview modal handles them
// sequentially when several .tape files were opened in quick succession.
async function pollPendingOpens() {
  // Don't stack import previews on top of each other.
  if (!$("#importModal").hidden) return;
  try {
    const { item } = await api("/api/tape/pending-open");
    if (item) showImportPreview(item);
  } catch {}
}

// On boot: if the URL carries an `?import=<blob>` parameter, decode it
// and offer to file the tape. Strip the param afterwards so refresh
// doesn't re-trigger the prompt.
function handleBootImport() {
  const params = new URLSearchParams(location.search);
  const blob = params.get("import");
  if (!blob) return;
  try {
    const payload = decodeBlob(blob);
    showImportPreview(payload);
  } catch (e) {
    toast(`bad share link · ${e.message}`, "error");
  } finally {
    params.delete("import");
    const search = params.toString();
    history.replaceState(null, "", location.pathname + (search ? `?${search}` : ""));
  }
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
    tpl.querySelector(".card__grab").addEventListener("click", async (e) => {
      e.stopPropagation();
      await grabTape(r, e.currentTarget);
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
      <button class="track__btn" data-act="mix"    title="Add to mix tape"      aria-label="add to mix">▤</button>
    `;
    actions.querySelector('[data-act="play"]')  .addEventListener("click", () => sendTrack("play",   t, item));
    actions.querySelector('[data-act="insert"]').addEventListener("click", () => sendTrack("insert", t, item));
    actions.querySelector('[data-act="add"]')   .addEventListener("click", () => sendTrack("add",    t, item));
    actions.querySelector('[data-act="mix"]')   .addEventListener("click", () => addToMix(t, item));

    row.appendChild(num);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(actions);
    wrap.appendChild(row);
  });

  box.appendChild(wrap);
}

// ---------- mix tape ----------
function fmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function mixTotal() {
  return (state.mix?.tracks || []).reduce((a, t) => a + (t.lengthSec || 0), 0);
}

function renderMixTray() {
  const tray = $("#mixTray");
  if (!tray) return;
  if (!state.mix || !state.mix.tracks.length) {
    tray.hidden = true;
    return;
  }
  tray.hidden = false;
  const total = mixTotal();
  const full = total >= MIX_MAX_SECONDS - 1;
  $("#mixCount").textContent = `${state.mix.tracks.length} track${state.mix.tracks.length === 1 ? "" : "s"}`;
  $("#mixTime").textContent = `${fmtMMSS(total)} / ${fmtMMSS(MIX_MAX_SECONDS)}`;
  $("#mixProgress").value = Math.min(total, MIX_MAX_SECONDS);
  tray.classList.toggle("is-full", full);
}

function addToMix(track, item) {
  const lenSec = parseLength(track.length || "");
  if (!state.mix) state.mix = { tracks: [] };
  const total = mixTotal();
  if (total + (lenSec || 0) > MIX_MAX_SECONDS) {
    toast(`tape full · ${fmtMMSS(total)} / ${fmtMMSS(MIX_MAX_SECONDS)}`, "error");
    return false;
  }
  state.mix.tracks.push({
    url: track.url,
    title: track.title || track.name,
    name: track.name,
    length: track.length || "",
    lengthSec: lenSec,
    format: track.format || "",
    source_id: item?.identifier || "",
    source_title: item?.title || "",
    source_creator: item?.creator || "",
  });
  renderMixTray();
  toast(`✚ added · ${(track.title || track.name || "").slice(0, 50)}`);
  return true;
}

function openMixSaveModal() {
  if (!state.mix || !state.mix.tracks.length) return;
  $("#mixSaveModal").hidden = false;
  $("#mixSaveName").value = `Mix · ${new Date().toLocaleDateString()}`;
  $("#mixSaveCover").value = "";
  $("#mixSavePreview").hidden = true;
  $("#mixSavePreview").style.backgroundImage = "";
  $("#mixSaveStatus").textContent = "";
  document.body.classList.add("modal-open");
  setTimeout(() => $("#mixSaveName").focus(), 30);
}
function closeMixSaveModal() {
  $("#mixSaveModal").hidden = true;
  if (!state.searchOpen && !state.drawerOpen) document.body.classList.remove("modal-open");
}

async function uploadMixCover(file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/mix-cover", { method: "POST", body: fd });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return (await r.json()).url; // e.g. "/covers/xxx.jpg"
}

async function saveMixToDrawer({ title, coverUrl } = {}) {
  if (!state.mix || !state.mix.tracks.length) return;
  const id = `mix:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tracks = state.mix.tracks.slice();
  const totalSec = mixTotal();
  // Default to deterministic colors; if a cover image was provided,
  // override with its extracted palette.
  let style = randomTapeStyle(id);
  if (coverUrl) {
    const palette = await extractPaletteFromImage(`mix-cover:${coverUrl}`, coverUrl);
    if (palette) style = { ...style, ...palette, font: style.font };
  }
  const body = {
    identifier: id,
    title,
    creator: "Mix tape",
    date: new Date().toISOString().slice(0, 10),
    track_count: tracks.length,
    band_color: style.band_color,
    label_color: style.label_color,
    ink_color: style.ink_color,
    font: style.font,
    is_mix: true,
    tracks,
    image_url: coverUrl || "",
  };
  const r = await post("/api/drawer", body);
  drawerCache.set(id, r.tape || body);
  refreshDrawerCount();
  state.mix = null;
  renderMixTray();
  toast(`▸ mix recorded · ${title} · ${fmtMMSS(totalSec)}`);
}

// ---------- artwork backfill ----------
// Re-extract colors for every drawer tape from its archive.org artwork
// (or stored cover image for mix tapes). One-shot — surfaces in Settings.
async function refreshAllArtworkColors() {
  await fetchTapes();
  const tapes = getTapesSync();
  let updated = 0, skipped = 0;
  for (const t of tapes) {
    const url = t.image_url ||
      (t.is_mix ? "" : `https://archive.org/services/img/${encodeURIComponent(t.identifier)}`);
    if (!url) { skipped++; continue; }
    const palette = await extractPaletteFromImage(`refresh:${t.identifier}`, url);
    if (!palette) { skipped++; continue; }
    const body = {
      ...t,
      band_color: palette.band_color,
      label_color: palette.label_color,
      ink_color: palette.ink_color,
      // Preserve font choice and existing image_url.
      font: t.font || '"Caveat", cursive',
      image_url: t.image_url || (t.is_mix ? "" : url),
    };
    try {
      const r = await post("/api/drawer", body);
      drawerCache.set(t.identifier, r.tape || body);
      updated++;
    } catch {
      skipped++;
    }
  }
  if (state.drawerOpen) renderDrawer();
  toast(`refreshed ${updated} tape${updated === 1 ? "" : "s"}` + (skipped ? ` · ${skipped} skipped` : ""));
}

function clearMix() {
  if (!state.mix || !state.mix.tracks.length) return;
  if (!window.confirm("Discard this mix tape?")) return;
  state.mix = null;
  renderMixTray();
  toast("◂ mix discarded");
}

// ---------- play actions ----------
async function sendTrack(action, t, item) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  try {
    if (action === "play")        await driver().play(state.player, t.url);
    else if (action === "add")    await driver().add(state.player, t.url);
    else if (action === "insert") await driver().insert(state.player, t.url);
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
    handlePlayerError(e);
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
    await driver().loadShow(state.player, urls);
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
    handlePlayerError(e);
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
  const source = ($('input[name="source"]:checked') || {}).value || "live";
  const creatorOnly = $("#creatorOnly").checked;
  state.lastQuery = { q, year, fmt, source, creatorOnly };

  $("#loading").hidden = false;
  $("#results").innerHTML = "";
  $("#empty").hidden = true;

  try {
    const data = await API.search(q, year, fmt, source, creatorOnly);
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

// Expand the server-side "This Mac" entry into one entry per detected
// macOS audio output (BT speaker, AirPods, HDMI, built-in, USB DAC, ...).
// Each expanded entry's `id` is the browser's deviceId, which we pass to
// `audio.setSinkId()` before playback. Falls back to the single "This
// Mac · Default output" entry when feature detection fails.
async function expandLocalPlayer(players) {
  if (!sinkSupport.canRoute) return players;
  const outputs = await listAudioOutputs();
  if (!outputs.length) return players;
  const idx = players.findIndex((p) => p.backend === "local");
  if (idx < 0) return players;
  audioOutputs = outputs;

  // Browsers expose the system default with deviceId === "default" (or
  // "" on some implementations). We map that to the legacy "this-device"
  // id so player selections stored before this feature still resolve;
  // every other output keeps its deviceId, which we hand to setSinkId.
  // If no entry self-identifies as default we don't synthesize one — the
  // user picks an explicit output and "Default output" simply doesn't
  // appear.
  const expanded = outputs.map((o, i) => {
    const isDefault = o.deviceId === "default" || o.deviceId === "";
    const label = o.label || (isDefault ? "Default output" : `Output ${i + 1}`);
    return {
      backend: "local",
      id: isDefault ? "this-device" : o.deviceId,
      mac: "",
      name: `This Mac · ${label}`,
      model: "in-app playback",
      power: true,
      connected: true,
      current_track: "",
    };
  });
  return [...players.slice(0, idx), ...expanded, ...players.slice(idx + 1)];
}

// ---------- players + now-playing ----------
async function loadPlayers() {
  const sel = $("#player");
  try {
    const resp = await API.players();
    const { errors } = resp;
    const players = await expandLocalPlayer(resp.players || []);
    state.playerList = players || [];
    sel.innerHTML = "";
    if (!players.length) {
      sel.innerHTML = `<option value="">(no players)</option>`;
      setTransportEnabled(false);
      return;
    }
    // Label format: "name · backend [· off]". The backend tag is essential
    // when the same physical device exposes itself through multiple
    // protocols (e.g. ultraRendu can appear as both Lyrion/Squeezelite and
    // DLNA at the same time depending on what's registered).
    const backendLabel = { lyrion: "lyrion", local: "this mac", dlna: "dlna", airplay: "airplay" };
    sel.innerHTML =
      `<option value="">— select —</option>` +
      players
        .map((p) => {
          const key = `${p.backend}:${p.id}`;
          const tag = backendLabel[p.backend] || p.backend;
          const off = p.power === false ? " · off" : "";
          return `<option value="${key}">${escapeHTML(p.name)} · ${tag}${off}</option>`;
        })
        .join("");

    const stored = state.player &&
      players.find((p) => p.backend === state.player.backend && p.id === state.player.id);
    if (stored) {
      sel.value = playerKey(stored);
      state.player = { backend: stored.backend, id: stored.id, name: stored.name };
    } else if (players.length === 1) {
      const only = players[0];
      sel.value = playerKey(only);
      state.player = { backend: only.backend, id: only.id, name: only.name };
      storePlayer(state.player);
    }
    setTransportEnabled(!!state.player);
    // Surface a Lyrion outage even when the local player is still available.
    if (errors && errors.lyrion) {
      setBanner("Lyrion server unreachable — check that LMS is running, or pick another player.");
    } else {
      setBanner("");
    }
  } catch (e) {
    sel.innerHTML = `<option value="">— error —</option>`;
    setTransportEnabled(false);
  }
}

// When the user switches player, treat it like ejecting the tape from one
// deck and dropping it into another: the old player stops + clears, the new
// player loads the same tape paused at track 1, ready for PLAY. Avoids the
// "two decks playing at once" footgun.
async function handOffPlayer(prev, next) {
  const samePlayer = prev && next && prev.backend === next.backend && prev.id === next.id;
  if (samePlayer) return;

  const item = state.currentItem;

  // 1. Stop + clear the old deck (best-effort).
  if (prev) {
    try { await drivers[prev.backend]?.eject(prev); } catch {}
  }

  // 2. Switch.
  state.player = next;
  storePlayer(next);
  setTransportEnabled(!!next);

  // 3. Reload the tape on the new deck, paused.
  if (next && item && item.tracks && item.tracks.length) {
    try {
      const urls = item.tracks.map((t) => t.url);
      await drivers[next.backend].loadShow(next, urls);
      setNowPlaying({
        album: showAlbumLabel(item),
        track: item.tracks[0].title || item.tracks[0].name,
        side: "A",
      });
      $("#deck").classList.remove("is-playing");
      showInsertFor(item, item.tracks[0].url);
      setSpools(0);
      toast(`▸ tape moved to ${next.name} · press PLAY`);
    } catch (e) {
      handlePlayerError(e);
    }
  } else if (!next) {
    // Switched to "no player" — clear the deck UI.
    hideInsert();
    setNowPlaying({ album: "no player selected", track: "— slot empty —" });
  }

  refreshStatus();
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
    const s = await driver().status(state.player);
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
  // counter format: MM·SS so listeners see minute count rolling
  const txt = String(m).padStart(3, "0") + String(s).padStart(2, "0");
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
    if (action === "play")       await driver().start(state.player);
    else if (action === "pause") await driver().pause(state.player);
    else if (action === "stop")  await driver().stop(state.player);
    else if (action === "next") {
      // Lyrion's `playlist jump +1` loops back to the same track when at the
      // end of a single-item queue, which reads as "FF restarted my track."
      // Suppress the no-op call when we know there's nowhere to go.
      const last = await currentQueuePosition();
      if (last && last.idx != null && last.idx + 1 >= last.total) {
        toast("end of tape", "ok");
      } else {
        await driver().next(state.player);
      }
    }
    else if (action === "prev") {
      // Standard cassette/cd behavior: REW restarts the current track if
      // we're more than a few seconds in, otherwise jumps to the previous.
      const elapsed = state.spoolCtx
        ? (state.spoolCtx.timeAtPoll + (state.spoolCtx.isPlaying ? (Date.now() - state.spoolCtx.atMs) / 1000 : 0))
        : 0;
      if (elapsed > 3) await driver().seek(state.player, -Math.max(1, Math.round(elapsed)));
      else await driver().prev(state.player);
    }
    setTimeout(refreshStatus, 350);
  } catch (e) {
    handlePlayerError(e);
  }
}

// Single click → track skip / restart. Double click within 240ms → ±30s seek.
let _ffRewClick = null;
function handleFfRew(action, btn) {
  Sound.keyDown();
  if (_ffRewClick && _ffRewClick.action === action) {
    clearTimeout(_ffRewClick.timer);
    _ffRewClick = null;
    btn.classList.add("is-pressed");
    setTimeout(() => btn.classList.remove("is-pressed"), 240);
    seekBy(action === "next" ? 30 : -30);
    return;
  }
  if (_ffRewClick) clearTimeout(_ffRewClick.timer);
  _ffRewClick = {
    action,
    timer: setTimeout(() => { _ffRewClick = null; transport(action); }, 240),
  };
}

// Best-effort current queue position so we can avoid the Lyrion "jump +1
// loops back to the same track" behavior on a single-item queue.
async function currentQueuePosition() {
  try {
    const s = await driver().status(state.player);
    const idx = (s && typeof s.playlist_index === "number") ? s.playlist_index : null;
    const total = (s && typeof s.playlist_tracks === "number") ? s.playlist_tracks : null;
    if (idx == null || total == null) return null;
    return { idx, total };
  } catch {
    return null;
  }
}

async function seekBy(deltaSeconds) {
  if (!state.player) { toast("pick a player first", "error"); return; }
  try {
    await driver().seek(state.player, deltaSeconds);
    toast(deltaSeconds > 0 ? `▸▸ +${deltaSeconds}s` : `◂◂ ${deltaSeconds}s`);
    setTimeout(refreshStatus, 200);
  } catch (e) {
    handlePlayerError(e);
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
    await driver().eject(state.player);
  } catch (e) {
    handlePlayerError(e);
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
    const key = e.target.value;
    const prev = state.player;
    let next = null;
    if (key) {
      const match = (state.playerList || []).find((p) => `${p.backend}:${p.id}` === key);
      if (match) next = { backend: match.backend, id: match.id, name: match.name };
    }
    handOffPlayer(prev, next);
  });

  $$('input[name="fmt"], input[name="source"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (state.lastQuery) doSearch();
    })
  );
  $("#creatorOnly").addEventListener("change", () => {
    if (state.lastQuery) doSearch();
  });

  $$(".key").forEach((b) =>
    b.addEventListener("click", () => {
      const action = b.dataset.action;
      if (action === "rec")                         { Sound.keyDown(); recordTape(); }
      else if (action === "eject")                  { Sound.keyDown(); ejectTape(); }
      else if (action === "next" || action === "prev") handleFfRew(action, b);
      else                                          { Sound.keyDown(); transport(action); }
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
  $("#drawerSort").addEventListener("change", renderDrawer);
  $("#caseBack").addEventListener("click", closeTapeCase);
  $("#caseLoad").addEventListener("click", loadCurrentCaseTape);
  $("#caseShare").addEventListener("click", () => {
    if (state.openTapeId) openShareModal(state.openTapeId);
  });
  $("#caseDiscard").addEventListener("click", discardCurrentCaseTape);

  // Share modal
  $("#shareClose").addEventListener("click", closeShareModal);
  $("#shareBackdrop").addEventListener("click", closeShareModal);
  $("#shareDone").addEventListener("click", closeShareModal);
  $("#shareCopyLink").addEventListener("click", copyShareLink);
  $("#shareDownloadFile").addEventListener("click", downloadShareFile);

  // Import preview modal
  $("#importClose").addEventListener("click", closeImportModal);
  $("#importBackdrop").addEventListener("click", closeImportModal);
  $("#importCancel").addEventListener("click", closeImportModal);
  $("#importConfirm").addEventListener("click", confirmImport);

  // Import-tape entry points: button (file picker), drag-drop onto the
  // drawer modal panel, and the ?import=<blob> URL parameter handled below.
  $("#importTapeBtn").addEventListener("click", () => $("#importTapeFile").click());
  $("#importTapeFile").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importTapeFromFile(f);
    e.target.value = "";  // allow re-selecting the same file
  });
  const drawerPanel = $("#drawerModal .modal__panel");
  if (drawerPanel) {
    ["dragenter", "dragover"].forEach((ev) =>
      drawerPanel.addEventListener(ev, (e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          e.preventDefault();
          drawerPanel.classList.add("is-drop-target");
        }
      }),
    );
    ["dragleave", "dragend", "drop"].forEach((ev) =>
      drawerPanel.addEventListener(ev, () => drawerPanel.classList.remove("is-drop-target")),
    );
    drawerPanel.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      importTapeFromFile(f);
    });
  }

  // ▤ Grab button on the cassette insert (deck) — saves loaded tape to drawer.
  $("#insertGrab").addEventListener("click", grabCurrentTape);

  // mix tape tray
  $("#mixSave").addEventListener("click", openMixSaveModal);
  $("#mixClear").addEventListener("click", clearMix);
  renderMixTray();

  // mix-save modal
  $("#mixSaveBackdrop").addEventListener("click", closeMixSaveModal);
  $("#mixSaveClose").addEventListener("click", closeMixSaveModal);
  $("#mixSaveCancel").addEventListener("click", closeMixSaveModal);
  $("#mixSaveCover").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    const preview = $("#mixSavePreview");
    if (!f) { preview.hidden = true; return; }
    const reader = new FileReader();
    reader.onload = () => {
      preview.style.backgroundImage = `url("${reader.result}")`;
      preview.hidden = false;
    };
    reader.readAsDataURL(f);
  });
  $("#mixSaveForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = ($("#mixSaveName").value || "").trim()
      || `Mix · ${new Date().toLocaleDateString()}`;
    const file = $("#mixSaveCover").files?.[0] || null;
    const status = $("#mixSaveStatus");
    try {
      let coverUrl = "";
      if (file) {
        status.textContent = "uploading cover…";
        coverUrl = await uploadMixCover(file);
      }
      status.textContent = "recording…";
      await saveMixToDrawer({ title: name, coverUrl });
      closeMixSaveModal();
    } catch (err) {
      status.textContent = "";
      toast(`couldn't save mix · ${err.message}`, "error");
    }
  });

  // settings modal
  $("#openSettings").addEventListener("click", openSettings);
  $("#closeSettings").addEventListener("click", closeSettings);
  $("#settingsBackdrop").addEventListener("click", closeSettings);
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("#settingsLyrionUrl").value.trim();
    try {
      await API.saveSettings({ lyrion_url: url || null });
      toast("settings saved · refreshing players");
      await loadPlayers();
      closeSettings();
    } catch (err) {
      toast(`couldn't save · ${err.message}`, "error");
    }
  });
  $("#rescanPlayers").addEventListener("click", async () => {
    try {
      await API.rescan();
      await loadPlayers();
      toast("↻ rescanned");
    } catch (err) {
      toast(`rescan failed · ${err.message}`, "error");
    }
  });
  $("#discoverLyrion").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "↻ scanning…";
    try {
      const { servers } = await API.discoverLyrion();
      if (!servers || !servers.length) {
        toast("no LMS found on the network", "error");
        return;
      }
      // If only one server: auto-fill. If multiple: prompt to pick.
      let pick = servers[0];
      if (servers.length > 1) {
        const choices = servers.map((s, i) => `${i + 1}. ${s.name} → ${s.jsonrpc_url}`).join("\n");
        const ans = window.prompt(`Found ${servers.length} servers — pick one:\n${choices}`, "1");
        const n = parseInt(ans || "0", 10);
        if (!n || n < 1 || n > servers.length) return;
        pick = servers[n - 1];
      }
      $("#settingsLyrionUrl").value = pick.jsonrpc_url;
      toast(`✓ found ${pick.name} at ${pick.hostname || pick.host}`);
    } catch (err) {
      toast(`discovery failed · ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $("#refreshArtwork").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "↻ refreshing…";
    try {
      await refreshAllArtworkColors();
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Audio output routing (per-output picker for "This Mac")
  const outputsNote = $("#settingsOutputsNote");
  if (!sinkSupport.canRoute) {
    if (outputsNote) outputsNote.textContent =
      "this build of webkit doesn't expose per-output routing · the local backend uses the system default";
    $("#revealOutputs").disabled = true;
    $("#refreshOutputs").disabled = true;
  }
  $("#revealOutputs").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "↻ asking…";
    try {
      await unlockOutputLabels();
      await loadPlayers();
      toast("✓ output names revealed");
    } catch (err) {
      toast(`couldn't reveal · ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $("#refreshOutputs").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "↻ refreshing…";
    try {
      await loadPlayers();
      toast(`↻ outputs refreshed · ${audioOutputs.length} found`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  // React to OS-level output changes (BT speaker connects/disconnects, etc.).
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => loadPlayers());
  }

  // Updates
  $("#settingsAutoUpdate").addEventListener("change", async (e) => {
    try {
      await API.saveSettings({ auto_check_updates: e.target.checked });
    } catch (err) {
      toast(`couldn't save · ${err.message}`, "error");
    }
  });
  $("#checkUpdatesBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "↻ checking…";
    try {
      await checkForUpdates();
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $("#installUpdateBtn").addEventListener("click", installUpdate);

  // App version → colophon + boot-time update check.
  api("/api/health").then((h) => {
    appVersion = h.version || "";
    $("#colophonVersion").textContent = appVersion ? `v${appVersion}` : "";
    runAutoUpdateCheck();
  }).catch(() => {});

  // If someone opened a tapestry share link, show the import preview.
  handleBootImport();

  // .tape files double-clicked in Finder land in the server-side queue;
  // pull them on boot and whenever we regain focus (covers the "Tapestry
  // already running, user opens another .tape" case).
  pollPendingOpens();
  window.addEventListener("focus", pollPendingOpens);

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
