// Shown at the bottom of Settings; bumped with every change (matches the ?v= on app.js).
const WEB_BUILD = "20261120e";
const DEFAULT_FEED_SESSION_OPTIONS = ["02:00", "06:00", "08:30", "11:00", "14:00", "17:00", "19:30", "22:00"];
const page = document.body.dataset.page;
const LOGIN_PATH = "/login";

let entriesCache = [];
let measurementsCache = [];
let settingsCache = {
  feedingTimes: [...DEFAULT_FEED_SESSION_OPTIONS],
  babyWeightGrams: null,
  babyDob: null,
  babySex: null,
  quickFeedMl: 120,
  babyWeightUpdatedAt: null,
  latestWeightGrams: null,
  latestWeightDate: null,
  units: "metric"
};
const PULL_REFRESH_THRESHOLD = 72;
const PULL_REFRESH_MAX_DISTANCE = 112;
const PULL_REFRESH_HOLD_DISTANCE = 58;

let pullRefreshHandler = null;
let pullRefreshIndicator = null;
let pullRefreshStartY = null;
let pullRefreshDistance = 0;
let pullRefreshArmed = false;
let pullRefreshPending = false;
let pullRefreshBound = false;

// ---------------------------------------------------------------------------
// Local data cache (stale-while-revalidate)
// Each page renders the last data it saw straight away, then refreshes from the
// server and re-renders. Per-device only; cleared on logout or when auth expires.
// ---------------------------------------------------------------------------
const DATA_CACHE_PREFIX = "littletrack-cache:";

function cacheRead(key) {
  try {
    const raw = localStorage.getItem(DATA_CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheWrite(key, value) {
  try {
    localStorage.setItem(DATA_CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota/private mode: drop the stale copy rather than keep showing it.
    try {
      localStorage.removeItem(DATA_CACHE_PREFIX + key);
    } catch {
      // Ignore.
    }
  }
}

function cacheClearAll() {
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith(DATA_CACHE_PREFIX))
      .forEach(key => localStorage.removeItem(key));
  } catch {
    // Ignore.
  }
}

function redirectToLogin() {
  cacheClearAll();
  if (window.location.pathname !== LOGIN_PATH) {
    window.location.href = LOGIN_PATH;
  }
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("Authentication required");
  }
  return response;
}

async function fetchAuthStatus() {
  const response = await fetch("/api/auth/status");
  if (!response.ok) {
    throw new Error("Failed to fetch auth status");
  }
  return response.json();
}

async function loginWithPassword(password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Could not log in");
  }
}

async function setupPassword(password, setupCode) {
  const response = await fetch("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, setupCode })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Could not save password");
  }
}

async function logout() {
  const response = await fetch("/api/auth/logout", {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Could not log out");
  }
  cacheClearAll();
}

function isTouchCapable() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function ensurePullRefreshIndicator() {
  if (pullRefreshIndicator || !isTouchCapable()) {
    return;
  }

  const indicator = document.createElement("div");
  indicator.className = "pull-refresh-indicator";
  indicator.setAttribute("aria-live", "polite");
  indicator.textContent = "Pull to refresh";
  document.body.appendChild(indicator);
  pullRefreshIndicator = indicator;
}

function setPullRefreshLabel(message) {
  ensurePullRefreshIndicator();
  if (pullRefreshIndicator) {
    pullRefreshIndicator.textContent = message;
  }
}

function setPullRefreshDistance(distance) {
  pullRefreshDistance = Math.max(0, Math.min(PULL_REFRESH_MAX_DISTANCE, distance));
  document.body.style.setProperty("--pull-refresh-offset", `${pullRefreshDistance}px`);
}

function resetPullRefreshState() {
  pullRefreshStartY = null;
  pullRefreshArmed = false;
  setPullRefreshDistance(0);
  document.body.classList.remove("pull-refresh-active", "pull-refresh-visible", "pull-refresh-armed", "pull-refresh-refreshing");
  setPullRefreshLabel("Pull to refresh");
}

function finishPullRefresh(message, delayMs = 500) {
  setPullRefreshLabel(message);
  window.setTimeout(() => {
    pullRefreshPending = false;
    resetPullRefreshState();
  }, delayMs);
}

function shouldStartPullRefresh(target) {
  if (pullRefreshPending || typeof pullRefreshHandler !== "function") {
    return false;
  }
  if (window.scrollY > 0 || document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) {
    return false;
  }
  return !target.closest("input, textarea, select, button, a, label");
}

function bindPullToRefresh() {
  if (pullRefreshBound || !isTouchCapable()) {
    return;
  }

  ensurePullRefreshIndicator();

  window.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) {
      resetPullRefreshState();
      return;
    }
    if (!shouldStartPullRefresh(event.target)) {
      pullRefreshStartY = null;
      return;
    }
    pullRefreshStartY = event.touches[0].clientY;
  }, { passive: true });

  window.addEventListener("touchmove", event => {
    if (pullRefreshStartY === null || pullRefreshPending) {
      return;
    }
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) {
      resetPullRefreshState();
      return;
    }

    const deltaY = event.touches[0].clientY - pullRefreshStartY;
    if (deltaY <= 0) {
      resetPullRefreshState();
      return;
    }

    event.preventDefault();

    const distance = Math.min(PULL_REFRESH_MAX_DISTANCE, Math.round(deltaY * 0.45));
    const isArmed = distance >= PULL_REFRESH_THRESHOLD;

    document.body.classList.add("pull-refresh-active", "pull-refresh-visible");
    document.body.classList.toggle("pull-refresh-armed", isArmed);
    setPullRefreshDistance(distance);
    pullRefreshArmed = isArmed;
    setPullRefreshLabel(isArmed ? "Release to refresh" : "Pull to refresh");
  }, { passive: false });

  const completeGesture = async () => {
    if (pullRefreshStartY === null) {
      return;
    }
    pullRefreshStartY = null;

    if (!pullRefreshArmed || typeof pullRefreshHandler !== "function") {
      resetPullRefreshState();
      return;
    }

    pullRefreshPending = true;
    document.body.classList.remove("pull-refresh-active", "pull-refresh-armed");
    document.body.classList.add("pull-refresh-visible", "pull-refresh-refreshing");
    setPullRefreshDistance(PULL_REFRESH_HOLD_DISTANCE);
    setPullRefreshLabel("Refreshing...");

    try {
      await pullRefreshHandler();
      finishPullRefresh("Updated");
    } catch {
      finishPullRefresh("Could not refresh", 900);
    }
  };

  window.addEventListener("touchend", completeGesture);
  window.addEventListener("touchcancel", () => {
    if (pullRefreshPending) {
      return;
    }
    resetPullRefreshState();
  });

  pullRefreshBound = true;
}

function registerPullToRefresh(handler) {
  pullRefreshHandler = handler;
  bindPullToRefresh();
}

function calculateAgeInDays(dateOfBirth) {
  if (typeof dateOfBirth !== "string" || !dateOfBirth) {
    return null;
  }

  const birthDate = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(birthDate.getTime())) {
    return null;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const birthLocal = new Date(birthDate.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  const diffMs = today.getTime() - birthLocal.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  return diffDays >= 0 ? diffDays : null;
}

function formatAgeSummary(ageDays) {
  if (!Number.isInteger(ageDays) || ageDays < 0) {
    return null;
  }
  if (ageDays < 14) {
    return ageDays === 1 ? "1 day old" : `${ageDays} days old`;
  }

  const weeks = Math.floor(ageDays / 7);
  if (ageDays < 56) {
    return weeks === 1 ? "1 week old" : `${weeks} weeks old`;
  }

  const months = Math.floor(ageDays / 30.4375);
  return months <= 1 ? "1 month old" : `${months} months old`;
}

function getGrowthBand(ageDays) {
  if (!Number.isInteger(ageDays) || ageDays < 0) {
    return null;
  }
  if (ageDays <= 91) {
    return "0-3-months";
  }
  if (ageDays <= 183) {
    return "3-6-months";
  }
  if (ageDays <= 274) {
    return "6-9-months";
  }
  if (ageDays <= 366) {
    return "9-12-months";
  }
  return "9-12-months";
}

function normalizeTimeValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) {
    return null;
  }
  const [hours, minutes] = trimmed.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function compareTimeValues(left, right) {
  return left.localeCompare(right);
}

function sanitizeFeedingTimes(values) {
  const normalized = values
    .map(normalizeTimeValue)
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  unique.sort(compareTimeValues);
  return unique.length ? unique : [...DEFAULT_FEED_SESSION_OPTIONS];
}

function getFeedingTimes() {
  return sanitizeFeedingTimes(settingsCache.feedingTimes || DEFAULT_FEED_SESSION_OPTIONS);
}

async function fetchEntries(range = null) {
  const params = new URLSearchParams();
  if (range?.from) {
    params.set("from", range.from);
  }
  if (range?.to) {
    params.set("to", range.to);
  }
  const query = params.toString();
  const response = await apiFetch(`/api/entries${query ? `?${query}` : ""}`);
  if (!response.ok) {
    throw new Error("Failed to fetch entries");
  }
  entriesCache = await response.json();
  if (range) {
    cacheWrite("entries-range", { from: range.from || null, to: range.to || null, data: entriesCache });
  } else {
    cacheWrite("entries-all", entriesCache);
  }
  return entriesCache;
}

function entryInRange(entry, range) {
  return (!range?.from || entry.timestamp >= range.from) && (!range?.to || entry.timestamp < range.to);
}

// Load cached entries into entriesCache. Returns true if a usable copy was found.
function applyCachedEntries(range = null) {
  if (range) {
    const cached = cacheRead("entries-range");
    if (cached && cached.from === (range.from || null) && cached.to === (range.to || null) && Array.isArray(cached.data)) {
      entriesCache = cached.data;
      return true;
    }
    // Fall back to the full list (cached by the Log page), filtered to the range.
    const all = cacheRead("entries-all");
    if (Array.isArray(all)) {
      entriesCache = all.filter(entry => entryInRange(entry, range));
      return true;
    }
    return false;
  }
  const all = cacheRead("entries-all");
  if (Array.isArray(all)) {
    entriesCache = all;
    return true;
  }
  return false;
}

// Keep cached lists in step with local saves/deletes so other tabs don't flash old data.
function cacheUpsertEntry(entry) {
  const all = cacheRead("entries-all");
  if (Array.isArray(all)) {
    cacheWrite("entries-all", sortEntries([entry, ...all.filter(item => item.id !== entry.id)]));
  }
  const ranged = cacheRead("entries-range");
  if (ranged && Array.isArray(ranged.data)) {
    const others = ranged.data.filter(item => item.id !== entry.id);
    ranged.data = entryInRange(entry, ranged) ? sortEntries([entry, ...others]) : others;
    cacheWrite("entries-range", ranged);
  }
}

function cacheRemoveEntry(id) {
  const all = cacheRead("entries-all");
  if (Array.isArray(all)) {
    cacheWrite("entries-all", all.filter(item => item.id !== id));
  }
  const ranged = cacheRead("entries-range");
  if (ranged && Array.isArray(ranged.data)) {
    ranged.data = ranged.data.filter(item => item.id !== id);
    cacheWrite("entries-range", ranged);
  }
}

async function fetchEntryById(id) {
  const response = await apiFetch(`/api/entries/${encodeURIComponent(id)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Failed to fetch entry");
  }
  return response.json();
}

async function createEntry(entry) {
  const response = await apiFetch("/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry)
  });
  if (!response.ok) {
    throw new Error("Failed to save entry");
  }
}

async function createPumpedEntry(entry) {
  const response = await apiFetch("/api/pumped", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry)
  });
  if (!response.ok) {
    throw new Error("Failed to save pumped entry");
  }
}

// ---- Running timers (breastfeed / nap), shared with every device via the server ----
let timersCache = { breast: null, nap: null };

function setTimersFromList(list) {
  timersCache = { breast: null, nap: null };
  (Array.isArray(list) ? list : []).forEach(timer => {
    if (timer && timer.kind in timersCache) {
      timersCache[timer.kind] = timer;
    }
  });
  cacheWrite("timers", timersCache);
  return timersCache;
}

function applyCachedTimers() {
  const cached = cacheRead("timers");
  if (cached && typeof cached === "object") {
    timersCache = { breast: cached.breast || null, nap: cached.nap || null };
    return true;
  }
  return false;
}

async function fetchTimers() {
  const response = await apiFetch("/api/timers");
  if (!response.ok) {
    throw new Error("Failed to fetch timers");
  }
  return setTimersFromList(await response.json());
}

// Start or update (switch side). Resolves to { ok, timer, conflict }.
async function putTimer(timer) {
  const response = await apiFetch(`/api/timers/${timer.kind}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: timer.id, startedAt: timer.startedAt, segments: timer.segments })
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 409 && body.timer) {
    return { ok: false, conflict: true, timer: body.timer };
  }
  if (!response.ok) {
    throw new Error(body.error || "Failed to save timer");
  }
  return { ok: true, timer: body.timer };
}

async function stopTimerRequest(timer) {
  const now = new Date().toISOString();
  const response = await apiFetch(`/api/timers/${timer.kind}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: timer.id, endedAt: now, entryId: createId(), createdAt: now })
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 409) {
    return { ok: false, gone: true };
  }
  if (!response.ok) {
    throw new Error(body.error || "Failed to stop timer");
  }
  return { ok: true, entry: body.entry || null };
}

async function cancelTimerRequest(timer) {
  const response = await apiFetch(`/api/timers/${timer.kind}?id=${encodeURIComponent(timer.id)}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error("Failed to discard timer");
  }
}

async function deleteEntry(id) {
  const response = await apiFetch(`/api/entries/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("Failed to delete entry");
  }
}

async function fetchMeasurements() {
  const response = await apiFetch("/api/measurements");
  if (!response.ok) {
    throw new Error("Failed to fetch measurements");
  }
  measurementsCache = await response.json();
  cacheWrite("measurements", measurementsCache);
  return measurementsCache;
}

function applyCachedMeasurements() {
  const cached = cacheRead("measurements");
  if (Array.isArray(cached)) {
    measurementsCache = cached;
    return true;
  }
  return false;
}

async function saveMeasurement(entry) {
  const response = await apiFetch("/api/measurements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to save measurement");
  }
}

async function deleteMeasurement(id) {
  const response = await apiFetch(`/api/measurements/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("Failed to delete measurement");
  }
}

async function fetchSettings() {
  const response = await apiFetch("/api/settings");
  if (!response.ok) {
    throw new Error("Failed to fetch settings");
  }
  const payload = await response.json();
  cacheWrite("settings", payload);
  settingsCache = normalizeSettings(payload);
  return settingsCache;
}

function normalizeSettings(payload) {
  return {
    feedingTimes: sanitizeFeedingTimes(payload.feedingTimes || DEFAULT_FEED_SESSION_OPTIONS),
    babyWeightGrams: Number.isFinite(payload.babyWeightGrams) ? payload.babyWeightGrams : null,
    babyDob: typeof payload.babyDob === "string" && payload.babyDob ? payload.babyDob : null,
    babySex: payload.babySex === "boy" || payload.babySex === "girl" ? payload.babySex : null,
    babyName: typeof payload.babyName === "string" && payload.babyName.trim() ? payload.babyName.trim() : null,
    quickFeedMl: Number.isInteger(payload.quickFeedMl) && payload.quickFeedMl > 0 ? payload.quickFeedMl : 120,
    hiddenQuickButtons: Array.isArray(payload.hiddenQuickButtons) ? payload.hiddenQuickButtons : [],
    quickButtonOrder: Array.isArray(payload.quickButtonOrder) ? payload.quickButtonOrder : [],
    babyWeightUpdatedAt: typeof payload.babyWeightUpdatedAt === "string" && payload.babyWeightUpdatedAt ? payload.babyWeightUpdatedAt : null,
    latestWeightGrams: Number.isFinite(payload.latestWeightGrams) ? payload.latestWeightGrams : null,
    latestWeightDate: typeof payload.latestWeightDate === "string" && payload.latestWeightDate ? payload.latestWeightDate : null,
    units: payload.units === "imperial" ? "imperial" : "metric"
  };
}

function applyCachedSettings() {
  const cached = cacheRead("settings");
  if (cached && typeof cached === "object") {
    settingsCache = normalizeSettings(cached);
    return true;
  }
  return false;
}

async function saveSettings(settings) {
  const response = await apiFetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!response.ok) {
    throw new Error("Failed to save settings");
  }
}

function sortEntries(entries) {
  // Timestamps are uniform toISOString() strings, so string order == time order.
  return [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

function formatDay(timestamp) {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(timestamp));
}

function formatDateLabel(dateText) {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(`${dateText}T00:00:00`));
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function formatDateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function currentLocalDateTimeParts(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return {
    date: local.toISOString().slice(0, 10),
    time: local.toISOString().slice(11, 16)
  };
}

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function groupByDay(entries) {
  return entries.reduce((groups, entry) => {
    const key = localDayKey(entry.timestamp);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(entry);
    return groups;
  }, {});
}

function sumFeedMilk(entries) {
  return entries.reduce((sum, entry) => {
    if (entry.entryType === "pumped") {
      return sum;
    }
    return sum + (entry.milkMl || 0);
  }, 0);
}

function sumPumpedMilk(entries) {
  return entries.reduce((sum, entry) => {
    if (entry.entryType !== "pumped") {
      return sum;
    }
    return sum + (entry.milkMl || 0);
  }, 0);
}

// ---------------------------------------------------------------------------
// Units and wording. Data is always stored metric (ml, grams, cm); "imperial" only
// changes what's shown and typed, plus US terms (Poop, Pee, Diaper, food spellings).
// ---------------------------------------------------------------------------
const ML_PER_OZ = 29.5735;
const G_PER_OZ = 28.3495;
const CM_PER_IN = 2.54;

function isImperial() {
  return settingsCache.units === "imperial";
}

function volumeUnit() {
  return isImperial() ? "oz" : "ml";
}

function formatVolume(ml) {
  if (!Number.isFinite(Number(ml))) {
    return "";
  }
  return isImperial() ? `${(Number(ml) / ML_PER_OZ).toFixed(1)} oz` : `${Math.round(Number(ml))} ml`;
}

function formatWeightKg(weightGrams) {
  if (!Number.isFinite(weightGrams)) {
    return "";
  }
  if (isImperial()) {
    const ounces = Math.round((weightGrams / G_PER_OZ) * 10) / 10;
    const pounds = Math.floor(ounces / 16);
    return `${pounds} lb ${(ounces - pounds * 16).toFixed(1)} oz`;
  }
  return `${(weightGrams / 1000).toFixed(2)} kg`;
}

function formatLength(cm) {
  return isImperial() ? `${(Number(cm) / CM_PER_IN).toFixed(1)} in` : `${Number(cm).toFixed(1)} cm`;
}

// Small weight changes, e.g. "+150 g" / "+5.3 oz".
function formatGrams(grams) {
  return isImperial() ? `${(grams / G_PER_OZ).toFixed(1)} oz` : `${Math.round(grams)} g`;
}

const US_TERMS = { Poo: "Poop", poo: "poop", Wee: "Pee", wee: "pee", Nappy: "Diaper", nappy: "diaper", Nappies: "Diapers", nappies: "diapers" };

function term(word) {
  return isImperial() && US_TERMS[word] ? US_TERMS[word] : word;
}

// Australian -> US food names. Either spelling counts as the same food.
const US_FOOD_NAMES = {
  "Rockmelon": "Cantaloupe", "Sultanas": "Golden raisins", "Butternut pumpkin": "Butternut squash",
  "Capsicum": "Bell pepper", "Beetroot": "Beets", "Swede": "Rutabaga", "Beef mince": "Ground beef",
  "Prawns": "Shrimp", "Yoghurt": "Yogurt", "Porridge": "Oatmeal", "Wheat biscuits": "Wheat cereal",
  "Kiwi fruit": "Kiwi", "Biscuit": "Cookie", "Jelly": "Jello"
};
const AU_FOOD_NAMES = Object.fromEntries(Object.entries(US_FOOD_NAMES).map(([au, us]) => [us.toLowerCase(), au]));
const US_FOOD_BY_AU = Object.fromEntries(Object.entries(US_FOOD_NAMES).map(([au, us]) => [au.toLowerCase(), us]));

// The food's name in the current wording (stored names are shown either way).
function regionFoodName(name) {
  const text = String(name || "").trim();
  const key = text.toLowerCase();
  if (isImperial()) {
    return US_FOOD_BY_AU[key] || text;
  }
  return AU_FOOD_NAMES[key] || text;
}

// Same key for "Yoghurt" and "Yogurt", for one-per-day and counting.
function foodKey(name) {
  const key = String(name || "").trim().toLowerCase();
  return (AU_FOOD_NAMES[key] || key).toLowerCase();
}

// Number typed in the current unit -> ml. Unchanged edits keep the stored value exactly.
function volumeInputValue(ml) {
  return isImperial() ? (Number(ml) / ML_PER_OZ).toFixed(1) : String(ml);
}

function setVolumeInput(input, ml) {
  const label = input.closest("label")?.querySelector("span");
  if (label) {
    label.textContent = label.textContent.replace(/\((ml|oz)\)/, `(${volumeUnit()})`);
  }
  input.step = isImperial() ? "0.1" : "1";
  input.inputMode = isImperial() ? "decimal" : "numeric";
  input.placeholder = isImperial() ? "4" : input.dataset.mlPlaceholder || input.placeholder;
  const value = Number.isFinite(Number(ml)) && ml !== null && ml !== "" ? volumeInputValue(ml) : "";
  input.value = value;
  input.dataset.original = value;
  input.dataset.originalMl = value === "" ? "" : String(ml);
}

function volumeFromInput(input) {
  const text = input.value.trim();
  if (text !== "" && text === input.dataset.original && input.dataset.originalMl) {
    return Number(input.dataset.originalMl);
  }
  const value = Number(text);
  if (text === "" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return isImperial() ? Math.round(value * ML_PER_OZ) : Math.round(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// ---- Food diary catalog (same list as the iOS app) ----
const FOODS = [
  { name: "Apple", emoji: "🍎", category: "Fruit" },
  { name: "Pear", emoji: "🍐", category: "Fruit" },
  { name: "Banana", emoji: "🍌", category: "Fruit" },
  { name: "Orange", emoji: "🍊", category: "Fruit" },
  { name: "Mandarin", emoji: "🍊", category: "Fruit" },
  { name: "Grapefruit", emoji: "🍊", category: "Fruit" },
  { name: "Lemon", emoji: "🍋", category: "Fruit" },
  { name: "Lime", emoji: "🍋", category: "Fruit" },
  { name: "Grapes", emoji: "🍇", category: "Fruit" },
  { name: "Strawberries", emoji: "🍓", category: "Fruit" },
  { name: "Blueberries", emoji: "🫐", category: "Fruit" },
  { name: "Raspberries", emoji: "", category: "Fruit" },
  { name: "Blackberries", emoji: "", category: "Fruit" },
  { name: "Watermelon", emoji: "🍉", category: "Fruit" },
  { name: "Rockmelon", emoji: "🍈", category: "Fruit" },
  { name: "Honeydew melon", emoji: "🍈", category: "Fruit" },
  { name: "Mango", emoji: "🥭", category: "Fruit" },
  { name: "Pineapple", emoji: "🍍", category: "Fruit" },
  { name: "Kiwi fruit", emoji: "🥝", category: "Fruit" },
  { name: "Peach", emoji: "🍑", category: "Fruit" },
  { name: "Nectarine", emoji: "🍑", category: "Fruit" },
  { name: "Apricot", emoji: "", category: "Fruit" },
  { name: "Plum", emoji: "", category: "Fruit" },
  { name: "Cherries", emoji: "🍒", category: "Fruit" },
  { name: "Avocado", emoji: "🥑", category: "Fruit" },
  { name: "Coconut", emoji: "🥥", category: "Fruit" },
  { name: "Papaya", emoji: "", category: "Fruit" },
  { name: "Fig", emoji: "", category: "Fruit" },
  { name: "Dates", emoji: "", category: "Fruit" },
  { name: "Prunes", emoji: "", category: "Fruit" },
  { name: "Passionfruit", emoji: "", category: "Fruit" },
  { name: "Pomegranate", emoji: "", category: "Fruit" },
  { name: "Lychee", emoji: "", category: "Fruit" },
  { name: "Persimmon", emoji: "", category: "Fruit" },
  { name: "Dragon fruit", emoji: "", category: "Fruit" },
  { name: "Guava", emoji: "", category: "Fruit" },
  { name: "Rhubarb", emoji: "", category: "Fruit" },
  { name: "Sultanas", emoji: "🍇", category: "Fruit" },
  { name: "Cranberries", emoji: "", category: "Fruit" },
  { name: "Carrot", emoji: "🥕", category: "Vegetables" },
  { name: "Broccoli", emoji: "🥦", category: "Vegetables" },
  { name: "Cauliflower", emoji: "", category: "Vegetables" },
  { name: "Potato", emoji: "🥔", category: "Vegetables" },
  { name: "Sweet potato", emoji: "🍠", category: "Vegetables" },
  { name: "Pumpkin", emoji: "🎃", category: "Vegetables" },
  { name: "Butternut pumpkin", emoji: "🎃", category: "Vegetables" },
  { name: "Zucchini", emoji: "🥒", category: "Vegetables" },
  { name: "Cucumber", emoji: "🥒", category: "Vegetables" },
  { name: "Peas", emoji: "🫛", category: "Vegetables" },
  { name: "Green beans", emoji: "🫛", category: "Vegetables" },
  { name: "Snow peas", emoji: "🫛", category: "Vegetables" },
  { name: "Edamame", emoji: "🫛", category: "Vegetables" },
  { name: "Corn", emoji: "🌽", category: "Vegetables" },
  { name: "Tomato", emoji: "🍅", category: "Vegetables" },
  { name: "Capsicum", emoji: "🫑", category: "Vegetables" },
  { name: "Spinach", emoji: "🥬", category: "Vegetables" },
  { name: "Kale", emoji: "🥬", category: "Vegetables" },
  { name: "Lettuce", emoji: "🥬", category: "Vegetables" },
  { name: "Cabbage", emoji: "🥬", category: "Vegetables" },
  { name: "Bok choy", emoji: "🥬", category: "Vegetables" },
  { name: "Brussels sprouts", emoji: "", category: "Vegetables" },
  { name: "Asparagus", emoji: "", category: "Vegetables" },
  { name: "Eggplant", emoji: "🍆", category: "Vegetables" },
  { name: "Mushroom", emoji: "🍄", category: "Vegetables" },
  { name: "Onion", emoji: "🧅", category: "Vegetables" },
  { name: "Garlic", emoji: "🧄", category: "Vegetables" },
  { name: "Leek", emoji: "", category: "Vegetables" },
  { name: "Celery", emoji: "", category: "Vegetables" },
  { name: "Beetroot", emoji: "", category: "Vegetables" },
  { name: "Parsnip", emoji: "", category: "Vegetables" },
  { name: "Turnip", emoji: "", category: "Vegetables" },
  { name: "Swede", emoji: "", category: "Vegetables" },
  { name: "Artichoke", emoji: "", category: "Vegetables" },
  { name: "Olives", emoji: "🫒", category: "Vegetables" },
  { name: "Ginger", emoji: "🫚", category: "Vegetables" },
  { name: "Chicken", emoji: "🍗", category: "Meat" },
  { name: "Beef", emoji: "🥩", category: "Meat" },
  { name: "Beef mince", emoji: "🥩", category: "Meat" },
  { name: "Lamb", emoji: "🍖", category: "Meat" },
  { name: "Pork", emoji: "🍖", category: "Meat" },
  { name: "Turkey", emoji: "🦃", category: "Meat" },
  { name: "Bacon", emoji: "🥓", category: "Meat" },
  { name: "Ham", emoji: "🍖", category: "Meat" },
  { name: "Sausage", emoji: "🌭", category: "Meat" },
  { name: "Meatballs", emoji: "", category: "Meat" },
  { name: "Liver", emoji: "", category: "Meat" },
  { name: "Kangaroo", emoji: "🦘", category: "Meat" },
  { name: "Salmon", emoji: "🐟", category: "Fish & seafood" },
  { name: "Tuna", emoji: "🐟", category: "Fish & seafood" },
  { name: "White fish", emoji: "🐟", category: "Fish & seafood" },
  { name: "Barramundi", emoji: "🐟", category: "Fish & seafood" },
  { name: "Sardines", emoji: "🐟", category: "Fish & seafood" },
  { name: "Prawns", emoji: "🦐", category: "Fish & seafood" },
  { name: "Crab", emoji: "🦀", category: "Fish & seafood" },
  { name: "Lobster", emoji: "🦞", category: "Fish & seafood" },
  { name: "Mussels", emoji: "", category: "Fish & seafood" },
  { name: "Oysters", emoji: "🦪", category: "Fish & seafood" },
  { name: "Squid", emoji: "🦑", category: "Fish & seafood" },
  { name: "Egg", emoji: "🥚", category: "Dairy & eggs" },
  { name: "Scrambled egg", emoji: "🍳", category: "Dairy & eggs" },
  { name: "Milk", emoji: "🥛", category: "Dairy & eggs" },
  { name: "Yoghurt", emoji: "🥛", category: "Dairy & eggs" },
  { name: "Cheese", emoji: "🧀", category: "Dairy & eggs" },
  { name: "Cream cheese", emoji: "🧀", category: "Dairy & eggs" },
  { name: "Ricotta", emoji: "🧀", category: "Dairy & eggs" },
  { name: "Cottage cheese", emoji: "🧀", category: "Dairy & eggs" },
  { name: "Butter", emoji: "🧈", category: "Dairy & eggs" },
  { name: "Custard", emoji: "🍮", category: "Dairy & eggs" },
  { name: "Rice", emoji: "🍚", category: "Grains & bread" },
  { name: "Rice cereal", emoji: "🥣", category: "Grains & bread" },
  { name: "Oats", emoji: "🥣", category: "Grains & bread" },
  { name: "Porridge", emoji: "🥣", category: "Grains & bread" },
  { name: "Wheat biscuits", emoji: "🥣", category: "Grains & bread" },
  { name: "Bread", emoji: "🍞", category: "Grains & bread" },
  { name: "Toast", emoji: "🍞", category: "Grains & bread" },
  { name: "Pasta", emoji: "🍝", category: "Grains & bread" },
  { name: "Noodles", emoji: "🍜", category: "Grains & bread" },
  { name: "Couscous", emoji: "", category: "Grains & bread" },
  { name: "Quinoa", emoji: "", category: "Grains & bread" },
  { name: "Barley", emoji: "", category: "Grains & bread" },
  { name: "Polenta", emoji: "🌽", category: "Grains & bread" },
  { name: "Pancakes", emoji: "🥞", category: "Grains & bread" },
  { name: "Muffin", emoji: "🧁", category: "Grains & bread" },
  { name: "Crackers", emoji: "", category: "Grains & bread" },
  { name: "Rice cakes", emoji: "🍘", category: "Grains & bread" },
  { name: "Bagel", emoji: "🥯", category: "Grains & bread" },
  { name: "Croissant", emoji: "🥐", category: "Grains & bread" },
  { name: "Wrap", emoji: "🫓", category: "Grains & bread" },
  { name: "Rusks", emoji: "", category: "Grains & bread" },
  { name: "Lentils", emoji: "🫘", category: "Legumes, nuts & seeds" },
  { name: "Chickpeas", emoji: "🫘", category: "Legumes, nuts & seeds" },
  { name: "Kidney beans", emoji: "🫘", category: "Legumes, nuts & seeds" },
  { name: "Baked beans", emoji: "🫘", category: "Legumes, nuts & seeds" },
  { name: "Black beans", emoji: "🫘", category: "Legumes, nuts & seeds" },
  { name: "Tofu", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Hummus", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Peanut butter", emoji: "🥜", category: "Legumes, nuts & seeds" },
  { name: "Almond butter", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Cashew butter", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Tahini", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Chia seeds", emoji: "", category: "Legumes, nuts & seeds" },
  { name: "Soup", emoji: "🍲", category: "Meals & other" },
  { name: "Bone broth", emoji: "🍲", category: "Meals & other" },
  { name: "Spaghetti bolognese", emoji: "🍝", category: "Meals & other" },
  { name: "Curry", emoji: "🍛", category: "Meals & other" },
  { name: "Stir fry", emoji: "🥘", category: "Meals & other" },
  { name: "Risotto", emoji: "🍚", category: "Meals & other" },
  { name: "Pizza", emoji: "🍕", category: "Meals & other" },
  { name: "Sushi", emoji: "🍣", category: "Meals & other" },
  { name: "Dumplings", emoji: "🥟", category: "Meals & other" },
  { name: "Fritters", emoji: "", category: "Meals & other" },
  { name: "Puree", emoji: "🥣", category: "Meals & other" },
  { name: "Smoothie", emoji: "🥤", category: "Meals & other" },
  { name: "Water", emoji: "💧", category: "Meals & other" },
  { name: "Ice cream", emoji: "🍨", category: "Meals & other" },
  { name: "Jelly", emoji: "", category: "Meals & other" },
  { name: "Cake", emoji: "🍰", category: "Meals & other" },
  { name: "Biscuit", emoji: "🍪", category: "Meals & other" },
  { name: "Chocolate", emoji: "🍫", category: "Meals & other" }
];
// Add page buttons (keys shared with the server and iOS app), default order.
const QUICK_BUTTONS = [
  { key: "quickFeed", label: "Quick feed" },
  { key: "pumped", label: "Pumped" },
  { key: "customFeed", label: "Custom feed" },
  { key: "breastfeed", label: "Breastfeed" },
  { key: "poo", label: "Poo", term: true },
  { key: "wee", label: "Wee", term: true },
  { key: "nap", label: "Nap" },
  { key: "food", label: "Add food" },
  { key: "note", label: "Note" },
  { key: "medicine", label: "Medicine" }
];

// Shown under the search box when nothing is typed.
const COMMON_FOOD_GROUPS = [
  { title: "Fruits", foods: ["Banana", "Apple", "Pear", "Avocado", "Mango", "Blueberries", "Strawberries", "Watermelon"] },
  { title: "Vegetables", foods: ["Carrot", "Sweet potato", "Pumpkin", "Broccoli", "Peas", "Zucchini", "Potato", "Corn"] },
  { title: "Proteins", foods: ["Chicken", "Beef mince", "Lamb", "Salmon", "White fish", "Egg", "Lentils", "Tofu"] },
  { title: "Dairy", foods: ["Yoghurt", "Cheese", "Milk", "Ricotta", "Cottage cheese", "Butter"] },
  { title: "Grains", foods: ["Oats", "Rice", "Toast", "Pasta", "Rice cereal", "Wheat biscuits", "Pancakes", "Crackers"] }
];

const FOOD_EMOJI = new Map(FOODS.map(item => [item.name.toLowerCase(), item.emoji]));

// Emoji for a food, or "" when there isn't a fitting one (incl. foods typed in by hand).
function foodEmoji(name) {
  return FOOD_EMOJI.get(String(name || "").trim().toLowerCase()) || "";
}

// Each food once (first time it was had that day first), with every entry id for it.
function uniqueFoods(entries) {
  const byName = new Map();
  [...entries]
    .filter(entry => entryKind(entry) === "food")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .forEach(entry => {
      const key = foodKey(entry.food);
      if (!byName.has(key)) {
        byName.set(key, { name: entry.food.trim(), ids: [] });
      }
      byName.get(key).ids.push(entry.id);
    });
  return [...byName.values()];
}

// Foods are shown as plain names (no emoji) everywhere.
function foodLabel(name) {
  return regionFoodName(name);
}

const POO_EMOJI = { wee: "💧", 1: "💩", 2: "💩💩", 3: "💩💩💩", gun: "🔫" };

// What an entry represents. Feeds, notes, poos and naps share the entries table;
// pumped sessions come from their own table.
function entryKind(entry) {
  if (entry.entryType === "pumped") {
    return "pumped";
  }
  if (typeof entry.milkMl === "number") {
    return "feed";
  }
  if (breastTotalSeconds(entry) > 0) {
    return "breast";
  }
  if (entry.medicine) {
    return "medicine";
  }
  if (entry.food) {
    return "food";
  }
  if (entry.poo) {
    return "poo";
  }
  if (typeof entry.napMinutes === "number") {
    return "nap";
  }
  return "note";
}

function formatNapMinutes(minutes) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
}

const BREAST_SIDE_LABELS = { left: "Left", right: "Right", both: "Both" };

function breastTotalSeconds(entry) {
  return (entry.breastLeftSeconds || 0) + (entry.breastRightSeconds || 0) + (entry.breastBothSeconds || 0);
}

// 45s, 8m, 1h 5m
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.round(total / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
}

// "14m (L 8m · R 6m)", "8m (Left)", "20m (Both)"
function breastSummary(entry) {
  const parts = [
    ["L", entry.breastLeftSeconds, "Left"],
    ["R", entry.breastRightSeconds, "Right"],
    ["Both", entry.breastBothSeconds, "Both"]
  ].filter(([, seconds]) => seconds > 0);
  const detail = parts.length === 1
    ? parts[0][2]
    : parts.map(([label, seconds]) => `${label} ${formatDuration(seconds)}`).join(" · ");
  return `${formatDuration(breastTotalSeconds(entry))} (${detail})`;
}

function entrySummary(entry) {
  switch (entryKind(entry)) {
    case "pumped":
      return `${escapeHtml(formatVolume(entry.milkMl))} Pumped`;
    case "breast":
      return `Breastfed ${escapeHtml(breastSummary(entry))}`;
    case "food":
      return escapeHtml(foodLabel(entry.food));
    case "medicine":
      return escapeHtml(medicineLabel(entry));
    case "feed":
      return escapeHtml(formatVolume(entry.milkMl));
    case "poo":
      return escapeHtml(POO_EMOJI[entry.poo] || "💩");
    case "nap":
      return `Napped ${escapeHtml(formatNapMinutes(entry.napMinutes))}`;
    default:
      return escapeHtml((entry.notes || "").trim());
  }
}

// "Vitamin D · 400 IU"
function medicineLabel(entry) {
  return entry.medicineDose ? `${entry.medicine} \u00b7 ${entry.medicineDose}` : entry.medicine;
}

function createEntryCard(entry, { plainFood = false } = {}) {
  const wrapper = document.createElement("article");
  const kind = entryKind(entry);
  const visibleTime = formatTime(entry.timestamp || entry.createdAt);
  const safeId = escapeHtml(entry.id);
  // Only free-text notes get the wrapping layout; poo/nap are short like feeds.
  wrapper.className = `entry-card${kind === "note" ? " note-entry" : ""}`;
  wrapper.innerHTML = `
    <div class="entry-main">
      <p class="entry-summary"><span class="entry-when">${visibleTime}</span> • ${plainFood && entry.food ? escapeHtml(entry.food) : entrySummary(entry)}</p>
    </div>
    <div class="entry-actions">
      <button class="edit-button" type="button" data-edit-id="${safeId}">Edit</button>
      <button class="delete-button" type="button" data-delete-id="${safeId}">Delete</button>
    </div>
  `;
  return wrapper;
}

// Log row listing the day's food (edited on the Food Diary page).
function createFoodDayCard(foods) {
  const wrapper = document.createElement("article");
  wrapper.className = "entry-card note-entry food-day-entry";
  wrapper.innerHTML = `
    <div class="entry-main">
      <p class="entry-summary entry-hanging"><span class="entry-when">Foods</span><span>•</span><span>${foods.map(item => escapeHtml(foodLabel(item.name))).join(", ")}</span></p>
    </div>
  `;
  return wrapper;
}

function timestampToLocalParts(timestamp) {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return {
    date: local.toISOString().slice(0, 10),
    time: local.toISOString().slice(11, 16)
  };
}

function buildTimestamp(dateValue, timeValue) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hours, minutes] = timeValue.split(":").map(Number);
  const timestamp = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid date");
  }
  return timestamp.toISOString();
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join("")
    ].join("-");
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function clearLegacyServiceWorkers() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
  } catch {
    // Ignore cleanup failures and keep the app usable.
  }
  if (!("caches" in window)) {
    return;
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("littletrack-")).map(key => caches.delete(key)));
  } catch {
    // Ignore cleanup failures and keep the app usable.
  }
}


function openDialog(dialog) {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

// Current time rounded down to the minute, matching entries made with a time picker
// (so editing later and saving without changes keeps the same timestamp).
function nowTimestamp() {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.toISOString();
}

// Build a timestamp for "today at HH:MM". If that time is still in the future
// (e.g. logging a 23:40 feed at 00:20), assume it was yesterday.
function timestampForRecentTime(timeValue, now = new Date()) {
  const today = currentLocalDateTimeParts(now).date;
  const candidate = new Date(buildTimestamp(today, timeValue));
  if (candidate.getTime() - now.getTime() > 5 * 60000) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate.toISOString();
}

function isToday(timestamp) {
  return localDayKey(timestamp) === localDayKey(new Date().toISOString());
}

// Popups + toast shared by the Add and Log pages. Markup is injected so both
// pages use exactly the same dialogs.
const ENTRY_UI_HTML = `
  <div id="toast" class="toast" role="status" aria-live="polite" hidden>
    <span id="toast-message"></span>
    <button id="toast-undo" class="toast-undo" type="button" hidden>Undo</button>
  </div>

  <dialog id="feed-dialog" class="entry-dialog" aria-labelledby="feed-dialog-title">
    <form id="feed-dialog-form" class="entry-form" novalidate>
      <h2 id="feed-dialog-title">Custom feed</h2>
      <label class="field">
        <span>Amount (ml)</span>
        <input id="feed-dialog-ml" type="number" min="0" max="2000" step="1" inputmode="numeric" placeholder="120" />
      </label>
      <div class="field-pair">
        <label id="feed-dialog-date-field" class="field" hidden>
          <span>Date</span>
          <input id="feed-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="feed-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="feed-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="feed-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="pumped-dialog" class="entry-dialog" aria-labelledby="pumped-dialog-title">
    <form id="pumped-dialog-form" class="entry-form" novalidate>
      <h2 id="pumped-dialog-title">Pumped</h2>
      <label class="field">
        <span>Amount (ml)</span>
        <input id="pumped-dialog-ml" type="number" min="0" max="2000" step="1" inputmode="numeric" placeholder="90" />
      </label>
      <div class="field-pair">
        <label id="pumped-dialog-date-field" class="field" hidden>
          <span>Date</span>
          <input id="pumped-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="pumped-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="pumped-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="pumped-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="note-dialog" class="entry-dialog" aria-labelledby="note-dialog-title">
    <form id="note-dialog-form" class="entry-form" novalidate>
      <h2 id="note-dialog-title">Note</h2>
      <label class="field">
        <span>Note</span>
        <textarea id="note-dialog-text" rows="3" maxlength="5000" placeholder="Add a note"></textarea>
      </label>
      <div id="note-dialog-when" class="field-pair" hidden>
        <label class="field">
          <span>Date</span>
          <input id="note-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="note-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="note-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="note-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="medicine-dialog" class="entry-dialog" aria-labelledby="medicine-dialog-title">
    <form id="medicine-dialog-form" class="entry-form" novalidate>
      <h2 id="medicine-dialog-title">Medicine</h2>
      <div id="medicine-dialog-saved-wrap" hidden>
        <p class="food-results-label">Saved</p>
        <div id="medicine-dialog-saved" class="food-chips"></div>
      </div>
      <div class="field-pair">
        <label class="field">
          <span>Medicine</span>
          <input id="medicine-dialog-name" type="text" maxlength="80" placeholder="e.g. Vitamin D" autocomplete="off" />
        </label>
        <label class="field">
          <span>Dose</span>
          <input id="medicine-dialog-dose" type="text" maxlength="40" placeholder="e.g. 400 IU" autocomplete="off" />
        </label>
      </div>
      <div id="medicine-dialog-when" class="field-pair">
        <label class="field">
          <span>Date</span>
          <input id="medicine-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="medicine-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="medicine-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="medicine-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="poo-dialog" class="entry-dialog" aria-labelledby="poo-dialog-title">
    <div class="entry-form">
      <h2 id="poo-dialog-title">Poo</h2>
      <div class="poo-options">
        <button class="quick-add-button poo-option" type="button" data-poo="1" aria-label="1 poo">💩</button>
        <button class="quick-add-button poo-option" type="button" data-poo="2" aria-label="2 poos">💩💩</button>
        <button class="quick-add-button poo-option" type="button" data-poo="3" aria-label="3 poos">💩💩💩</button>
      </div>
      <div id="poo-dialog-when" class="field-pair" hidden>
        <label class="field">
          <span>Date</span>
          <input id="poo-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="poo-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="poo-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </div>
  </dialog>

  <dialog id="breast-start-dialog" class="entry-dialog" aria-labelledby="breast-start-title">
    <div class="entry-form">
      <h2 id="breast-start-title">Breastfeed</h2>
      <p class="field-hint">Which side? The timer starts straight away.</p>
      <div class="side-options">
        <button class="quick-add-button side-option" type="button" data-breast-side="left">Left</button>
        <button class="quick-add-button side-option" type="button" data-breast-side="right">Right</button>
        <button class="quick-add-button side-option" type="button" data-breast-side="both">Both</button>
      </div>
      <div class="form-actions">
        <button class="ghost-button" type="button" data-breast-manual>Enter a past feed</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </div>
  </dialog>

  <dialog id="food-dialog" class="entry-dialog" aria-labelledby="food-dialog-title">
    <form id="food-dialog-form" class="entry-form" novalidate>
      <h2 id="food-dialog-title">Edit food</h2>
      <label class="field">
        <span>Food</span>
        <input id="food-dialog-name" type="text" maxlength="80" list="food-dialog-options" autocomplete="off" />
        <datalist id="food-dialog-options"></datalist>
      </label>
      <div class="field-pair">
        <label class="field">
          <span>Date</span>
          <input id="food-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Time</span>
          <input id="food-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="food-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="food-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="nap-start-dialog" class="entry-dialog" aria-labelledby="nap-start-title">
    <div class="entry-form">
      <h2 id="nap-start-title">Nap</h2>
      <button class="primary-button" type="button" data-nap-start>Start nap timer</button>
      <div class="form-actions">
        <button class="ghost-button" type="button" data-nap-manual>Enter a past nap</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </div>
  </dialog>

  <dialog id="breast-dialog" class="entry-dialog" aria-labelledby="breast-dialog-title">
    <form id="breast-dialog-form" class="entry-form" novalidate>
      <h2 id="breast-dialog-title">Breastfeed</h2>
      <div class="field-pair">
        <label class="field">
          <span>Left (min)</span>
          <input id="breast-dialog-left" type="number" min="0" max="360" step="1" inputmode="numeric" placeholder="10" />
        </label>
        <label class="field">
          <span>Right (min)</span>
          <input id="breast-dialog-right" type="number" min="0" max="360" step="1" inputmode="numeric" placeholder="10" />
        </label>
      </div>
      <label class="field">
        <span>Both / not tracked (min)</span>
        <input id="breast-dialog-both" type="number" min="0" max="360" step="1" inputmode="numeric" placeholder="20" />
      </label>
      <div class="field-pair">
        <label id="breast-dialog-date-field" class="field" hidden>
          <span>Date</span>
          <input id="breast-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Started at</span>
          <input id="breast-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="breast-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="breast-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="nap-dialog" class="entry-dialog" aria-labelledby="nap-dialog-title">
    <form id="nap-dialog-form" class="entry-form" novalidate>
      <h2 id="nap-dialog-title">Nap</h2>
      <div class="field-pair">
        <label class="field">
          <span>Hours</span>
          <input id="nap-dialog-hours" type="number" min="0" max="23" step="1" inputmode="numeric" placeholder="0" />
        </label>
        <label class="field">
          <span>Minutes</span>
          <input id="nap-dialog-minutes" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="45" />
        </label>
      </div>
      <div class="field-pair">
        <label id="nap-dialog-date-field" class="field" hidden>
          <span>Date</span>
          <input id="nap-dialog-date" type="date" />
        </label>
        <label class="field">
          <span>Woke up at</span>
          <input id="nap-dialog-time" type="time" step="60" />
        </label>
      </div>
      <p id="nap-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="nap-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="measure-dialog" class="entry-dialog" aria-labelledby="measure-dialog-title">
    <form id="measure-dialog-form" class="entry-form" novalidate>
      <h2 id="measure-dialog-title">Measurement</h2>
      <label class="field" id="measure-weight-metric">
        <span>Weight (grams)</span>
        <input id="measure-dialog-weight" type="number" min="1" max="30000" step="1" inputmode="numeric" placeholder="4200" />
      </label>
      <div class="field-pair" id="measure-weight-imperial" hidden>
        <label class="field">
          <span>Weight (lb)</span>
          <input id="measure-dialog-lb" type="number" min="0" max="66" step="1" inputmode="numeric" placeholder="9" />
        </label>
        <label class="field">
          <span>(oz)</span>
          <input id="measure-dialog-oz" type="number" min="0" max="15.9" step="0.1" inputmode="decimal" placeholder="4.5" />
        </label>
      </div>
      <div class="field-pair">
        <label class="field">
          <span>Length (cm)</span>
          <input id="measure-dialog-length" type="number" min="30" max="130" step="0.1" inputmode="decimal" placeholder="62.5" />
        </label>
        <label class="field">
          <span>Head (cm)</span>
          <input id="measure-dialog-head" type="number" min="20" max="60" step="0.1" inputmode="decimal" placeholder="41.0" />
        </label>
      </div>
      <label class="field">
        <span>Date</span>
        <input id="measure-dialog-date" type="date" />
      </label>
      <p class="field-hint">Leave any field blank if it wasn't measured.</p>
      <p id="measure-dialog-error" class="form-error" hidden></p>
      <div class="form-actions">
        <button class="primary-button" id="measure-dialog-save" type="submit">Save</button>
        <button class="ghost-button" type="button" data-dialog-cancel>Cancel</button>
      </div>
    </form>
  </dialog>
`;

function createEntryUi({ onEntrySaved = () => {}, onEntryRemoved = () => {}, onMeasurementSaved = () => {} } = {}) {
  document.body.insertAdjacentHTML("beforeend", ENTRY_UI_HTML);
  const $ = id => document.getElementById(id);

  const toast = $("toast");
  const toastMessage = $("toast-message");
  const toastUndo = $("toast-undo");
  let toastTimer = null;

  function hideToast() {
    window.clearTimeout(toastTimer);
    toast.hidden = true;
    toastUndo.hidden = true;
    toastUndo.onclick = null;
  }

  function showToast(message, onUndo = null) {
    window.clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toastUndo.hidden = !onUndo;
    toastUndo.disabled = false;
    toastUndo.onclick = onUndo
      ? async () => {
        toastUndo.disabled = true;
        try {
          await onUndo();
          showToast("Removed.");
        } catch {
          showToast("Could not undo.");
        }
      }
      : null;
    toast.hidden = false;
    toastTimer = window.setTimeout(hideToast, onUndo ? 6000 : 2500);
  }

  // ---- persistence helpers ----

  async function saveEntry(entry, kind) {
    if (kind === "pumped") {
      await createPumpedEntry(entry);
    } else {
      await createEntry(entry);
    }
    const cachedEntry = kind === "pumped"
      ? { ...entry, notes: "", feedSession: null, entryType: "pumped" }
      : {
        ...entry,
        notes: entry.notes || "",
        feedSession: entry.feedSession ?? null,
        poo: entry.poo ?? null,
        napMinutes: entry.napMinutes ?? null,
        breastLeftSeconds: entry.breastLeftSeconds ?? null,
        breastRightSeconds: entry.breastRightSeconds ?? null,
        breastBothSeconds: entry.breastBothSeconds ?? null,
        food: entry.food ?? null,
        medicine: entry.medicine ?? null,
        medicineDose: entry.medicineDose ?? null,
        entryType: "feed"
      };
    entriesCache = [cachedEntry, ...entriesCache.filter(existing => existing.id !== entry.id)];
    cacheUpsertEntry(cachedEntry);
    onEntrySaved(cachedEntry);
    return cachedEntry;
  }

  function undoEntry(id) {
    return async () => {
      await deleteEntry(id);
      entriesCache = entriesCache.filter(entry => entry.id !== id);
      cacheRemoveEntry(id);
      onEntryRemoved(id);
    };
  }

  function undoMeasurement(id) {
    return async () => {
      await deleteMeasurement(id);
      await Promise.all([fetchMeasurements(), fetchSettings()]);
      onMeasurementSaved();
    };
  }


  function addedAt(timestamp) {
    return `${formatTime(timestamp)}${isToday(timestamp) ? "" : ` on ${formatDay(timestamp)}`}`;
  }

  // ---- dialog plumbing ----

  function setError(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  function wireDialog(dialog, onClose) {
    dialog.addEventListener("click", event => {
      if (event.target === dialog || event.target.closest("[data-dialog-cancel]")) {
        closeDialog(dialog);
      }
    });
    dialog.addEventListener("close", onClose);
  }

  function parseMl(input) {
    return volumeFromInput(input);
  }

  function editTimestamp(dateInput, timeInput) {
    const timeValue = normalizeTimeValue(timeInput.value);
    if (!dateInput.value || !timeValue) {
      throw new Error("Invalid date/time");
    }
    return buildTimestamp(dateInput.value, timeValue);
  }

  // ---- feed ----
  const feedDialog = $("feed-dialog");
  const feedMl = $("feed-dialog-ml");
  const feedDateField = $("feed-dialog-date-field");
  const feedDate = $("feed-dialog-date");
  const feedTime = $("feed-dialog-time");
  const feedError = $("feed-dialog-error");
  const feedSave = $("feed-dialog-save");
  let feedEditing = null;

  function openFeed(entry = null) {
    feedEditing = entry;
    setError(feedError, "");
    feedSave.disabled = false;
    $("feed-dialog-title").textContent = entry ? "Edit feed" : "Custom feed";
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      setVolumeInput(feedMl, typeof entry.milkMl === "number" ? entry.milkMl : null);
      feedDate.value = parts.date;
      feedTime.value = parts.time;
    } else {
      setVolumeInput(feedMl, null);
      feedDate.value = "";
      feedTime.value = currentLocalDateTimeParts().time;
    }
    feedDateField.hidden = !entry;
    openDialog(feedDialog);
    feedMl.focus();
  }

  wireDialog(feedDialog, () => {
    feedEditing = null;
  });

  $("feed-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = feedEditing;
    const milkMl = parseMl(feedMl);
    if (milkMl === null) {
      setError(feedError, "Add a milk amount.");
      return;
    }
    let timestamp;
    try {
      if (editing) {
        timestamp = editTimestamp(feedDate, feedTime);
      } else {
        const timeValue = normalizeTimeValue(feedTime.value);
        if (!timeValue) {
          throw new Error("Invalid time");
        }
        timestamp = timestampForRecentTime(timeValue);
      }
    } catch {
      setError(feedError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl,
      notes: editing?.notes || "",
      feedSession: editing?.feedSession || null,
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    feedSave.disabled = true;
    try {
      await saveEntry(entry, "feed");
      closeDialog(feedDialog);
      showToast(editing ? "Feed updated." : `${formatVolume(milkMl)} feed added at ${addedAt(timestamp)}.`, editing ? null : undoEntry(entry.id));
    } catch {
      feedSave.disabled = false;
      setError(feedError, "Could not save feed.");
    }
  });

  // ---- pumped ----
  const pumpedDialog = $("pumped-dialog");
  const pumpedMl = $("pumped-dialog-ml");

  const pumpedDateField = $("pumped-dialog-date-field");
  const pumpedDate = $("pumped-dialog-date");
  const pumpedTime = $("pumped-dialog-time");
  const pumpedError = $("pumped-dialog-error");
  const pumpedSave = $("pumped-dialog-save");
  let pumpedEditing = null;

  function openPumped(entry = null) {
    pumpedEditing = entry;
    setError(pumpedError, "");
    pumpedSave.disabled = false;
    $("pumped-dialog-title").textContent = entry ? "Edit pumped" : "Pumped";
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      setVolumeInput(pumpedMl, typeof entry.milkMl === "number" ? entry.milkMl : null);
      pumpedDate.value = parts.date;
      pumpedTime.value = parts.time;
    } else {
      setVolumeInput(pumpedMl, null);
      pumpedDate.value = "";
      pumpedTime.value = currentLocalDateTimeParts().time;
    }
    pumpedDateField.hidden = !entry;
    openDialog(pumpedDialog);
    pumpedMl.focus();
  }

  wireDialog(pumpedDialog, () => {
    pumpedEditing = null;
  });

  $("pumped-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = pumpedEditing;
    const milkMl = parseMl(pumpedMl);
    if (!milkMl) {
      setError(pumpedError, "Add a pumped amount.");
      return;
    }
    let timestamp;
    try {
      if (editing) {
        timestamp = editTimestamp(pumpedDate, pumpedTime);
      } else {
        const timeValue = normalizeTimeValue(pumpedTime.value);
        if (!timeValue) {
          throw new Error("Invalid time");
        }
        timestamp = timestampForRecentTime(timeValue);
      }
    } catch {
      setError(pumpedError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl,
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    pumpedSave.disabled = true;
    try {
      await saveEntry(entry, "pumped");
      closeDialog(pumpedDialog);
      showToast(editing ? "Pumped entry updated." : `${formatVolume(milkMl)} pumped added at ${addedAt(timestamp)}.`, editing ? null : undoEntry(entry.id));
    } catch {
      pumpedSave.disabled = false;
      setError(pumpedError, "Could not save pumped entry.");
    }
  });

  // ---- note ----
  const noteDialog = $("note-dialog");
  const noteText = $("note-dialog-text");
  const noteWhen = $("note-dialog-when");
  const noteDate = $("note-dialog-date");
  const noteTime = $("note-dialog-time");
  const noteError = $("note-dialog-error");
  const noteSave = $("note-dialog-save");
  let noteEditing = null;

  function openNote(entry = null) {
    noteEditing = entry;
    setError(noteError, "");
    noteSave.disabled = false;
    $("note-dialog-title").textContent = entry ? "Edit note" : "Note";
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      noteText.value = entry.notes || "";
      noteDate.value = parts.date;
      noteTime.value = parts.time;
    } else {
      noteText.value = "";
    }
    noteWhen.hidden = !entry;
    openDialog(noteDialog);
    noteText.focus();
  }

  wireDialog(noteDialog, () => {
    noteEditing = null;
  });

  $("note-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = noteEditing;
    const notes = noteText.value.trim();
    if (!notes) {
      setError(noteError, "Add a note.");
      return;
    }
    let timestamp;
    try {
      timestamp = editing ? editTimestamp(noteDate, noteTime) : nowTimestamp();
    } catch {
      setError(noteError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl: null,
      notes,
      feedSession: null,
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    noteSave.disabled = true;
    try {
      await saveEntry(entry, "note");
      closeDialog(noteDialog);
      showToast(editing ? "Note updated." : `Note added at ${addedAt(timestamp)}.`, editing ? null : undoEntry(entry.id));
    } catch {
      noteSave.disabled = false;
      setError(noteError, "Could not save note.");
    }
  });

  // ---- medicine (saved list = recent name + dose combinations) ----
  const medicineDialog = $("medicine-dialog");
  const medicineName = $("medicine-dialog-name");
  const medicineDose = $("medicine-dialog-dose");
  const medicineDate = $("medicine-dialog-date");
  const medicineTime = $("medicine-dialog-time");
  const medicineError = $("medicine-dialog-error");
  const medicineSave = $("medicine-dialog-save");
  const medicineSavedWrap = $("medicine-dialog-saved-wrap");
  const medicineSaved = $("medicine-dialog-saved");
  let medicineEditing = null;

  function savedMedicines(entries) {
    const seen = new Set();
    const list = [];
    sortEntries(entries.filter(item => item.medicine)).forEach(item => {
      const key = `${item.medicine.trim().toLowerCase()}|${(item.medicineDose || "").trim().toLowerCase()}`;
      if (!seen.has(key) && list.length < 8) {
        seen.add(key);
        list.push({ name: item.medicine, dose: item.medicineDose || "" });
      }
    });
    return list;
  }

  function drawSavedMedicines(list) {
    medicineSavedWrap.hidden = !list.length;
    medicineSaved.innerHTML = list.map(item => `
      <button class="food-chip" type="button" data-medicine-name="${escapeHtml(item.name)}" data-medicine-dose="${escapeHtml(item.dose)}">
        ${escapeHtml(medicineLabel({ medicine: item.name, medicineDose: item.dose }))}</button>`).join("");
  }

  async function openMedicine(entry = null) {
    medicineEditing = entry;
    setError(medicineError, "");
    medicineSave.disabled = false;
    $("medicine-dialog-title").textContent = entry ? "Edit medicine" : "Medicine";
    const parts = timestampToLocalParts(entry ? entry.timestamp : nowTimestamp());
    medicineName.value = entry?.medicine || "";
    medicineDose.value = entry?.medicineDose || "";
    medicineDate.value = parts.date;
    medicineTime.value = parts.time;
    drawSavedMedicines(savedMedicines(entriesCache));
    openDialog(medicineDialog);
    if (!entry) {
      // The Add page only loads today, so look further back for the saved list.
      try {
        const from = new Date(Date.now() - 180 * 864e5).toISOString();
        const response = await apiFetch(`/api/entries?from=${encodeURIComponent(from)}`);
        if (response.ok && medicineDialog.open) {
          drawSavedMedicines(savedMedicines(await response.json()));
        }
      } catch {}
    }
  }

  medicineSaved.addEventListener("click", event => {
    const chip = event.target.closest("[data-medicine-name]");
    if (chip) {
      medicineName.value = chip.getAttribute("data-medicine-name");
      medicineDose.value = chip.getAttribute("data-medicine-dose");
    }
  });

  wireDialog(medicineDialog, () => {
    medicineEditing = null;
  });

  $("medicine-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = medicineEditing;
    const medicine = medicineName.value.trim();
    if (!medicine) {
      setError(medicineError, "Add the medicine name.");
      return;
    }
    let timestamp;
    try {
      timestamp = editTimestamp(medicineDate, medicineTime);
    } catch {
      setError(medicineError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl: null,
      notes: "",
      feedSession: null,
      medicine,
      medicineDose: medicineDose.value.trim() || null,
      timestamp,
      createdAt: editing?.createdAt || new Date().toISOString()
    };
    medicineSave.disabled = true;
    try {
      await saveEntry(entry, "medicine");
      closeDialog(medicineDialog);
      showToast(editing ? "Medicine updated." : `${medicineLabel(entry)} logged at ${addedAt(timestamp)}.`, editing ? null : undoEntry(entry.id));
    } catch {
      medicineSave.disabled = false;
      setError(medicineError, "Could not save.");
    }
  });

  // ---- poo (tap an option to save; when editing, date/time are shown too) ----
  const pooDialog = $("poo-dialog");
  const pooError = $("poo-dialog-error");
  const pooWhen = $("poo-dialog-when");
  const pooDate = $("poo-dialog-date");
  const pooTime = $("poo-dialog-time");
  let pooSaving = false;
  let pooEditing = null;

  function openPoo(entry = null) {
    pooEditing = entry;
    setError(pooError, "");
    pooSaving = false;
    $("poo-dialog-title").textContent = entry ? `Edit ${term("poo")}` : term("Poo");
    pooDialog.querySelectorAll("[data-poo]").forEach(option => {
      option.classList.toggle("poo-option-selected", Boolean(entry) && option.getAttribute("data-poo") === entry.poo);
    });
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      pooDate.value = parts.date;
      pooTime.value = parts.time;
    }
    pooWhen.hidden = !entry;
    openDialog(pooDialog);
  }

  wireDialog(pooDialog, () => {
    pooEditing = null;
  });

  pooDialog.addEventListener("click", async event => {
    const option = event.target.closest("[data-poo]");
    if (!option || pooSaving) {
      return;
    }
    const editing = pooEditing;
    const poo = option.getAttribute("data-poo");
    let timestamp;
    try {
      timestamp = editing ? editTimestamp(pooDate, pooTime) : nowTimestamp();
    } catch {
      setError(pooError, "Pick a valid date and time.");
      return;
    }
    pooSaving = true;
    const entry = {
      id: editing?.id || createId(),
      milkMl: null,
      notes: "",
      feedSession: null,
      poo,
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    try {
      await saveEntry(entry, "poo");
      closeDialog(pooDialog);
      showToast(editing ? `${term("Poo")} updated.` : `${POO_EMOJI[poo]} logged at ${formatTime(timestamp)}.`, editing ? null : undoEntry(entry.id));
    } catch {
      setError(pooError, "Could not save. Check your connection and try again.");
    } finally {
      pooSaving = false;
    }
  });

  // ---- nap (duration in minutes; time = when the nap ended) ----
  const napDialog = $("nap-dialog");
  const napHours = $("nap-dialog-hours");
  const napMinutes = $("nap-dialog-minutes");
  const napDateField = $("nap-dialog-date-field");
  const napDate = $("nap-dialog-date");
  const napTime = $("nap-dialog-time");
  const napError = $("nap-dialog-error");
  const napSave = $("nap-dialog-save");
  let napEditing = null;

  function openNap(entry = null) {
    napEditing = entry;
    setError(napError, "");
    napSave.disabled = false;
    $("nap-dialog-title").textContent = entry ? "Edit nap" : "Nap";
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      const total = entry.napMinutes ?? 0;
      napHours.value = total >= 60 ? String(Math.floor(total / 60)) : "";
      napMinutes.value = String(total % 60);
      napDate.value = parts.date;
      napTime.value = parts.time;
    } else {
      napHours.value = "";
      napMinutes.value = "";
      napDate.value = "";
      napTime.value = currentLocalDateTimeParts().time;
    }
    napDateField.hidden = !entry;
    openDialog(napDialog);
    napMinutes.focus();
  }

  wireDialog(napDialog, () => {
    napEditing = null;
  });

  $("nap-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = napEditing;
    const hoursText = napHours.value.trim();
    const minutesText = napMinutes.value.trim();
    const hours = hoursText === "" ? 0 : Number(hoursText);
    const mins = minutesText === "" ? 0 : Number(minutesText);
    const minutes = Math.round(hours * 60 + mins);
    if (!Number.isFinite(hours) || !Number.isFinite(mins) || hours < 0 || mins < 0 || mins > 59 || minutes < 1 || minutes > 1440) {
      setError(napError, "Add how long the nap lasted (hours and minutes).");
      return;
    }
    let timestamp;
    try {
      if (editing) {
        timestamp = editTimestamp(napDate, napTime);
      } else {
        const timeValue = normalizeTimeValue(napTime.value);
        if (!timeValue) {
          throw new Error("Invalid time");
        }
        timestamp = timestampForRecentTime(timeValue);
      }
    } catch {
      setError(napError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl: null,
      notes: "",
      feedSession: null,
      napMinutes: Math.round(minutes),
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    napSave.disabled = true;
    try {
      await saveEntry(entry, "nap");
      closeDialog(napDialog);
      showToast(
        editing ? "Nap updated." : `${formatNapMinutes(entry.napMinutes)} nap added (woke ${addedAt(timestamp)}).`,
        editing ? null : undoEntry(entry.id)
      );
    } catch {
      napSave.disabled = false;
      setError(napError, "Could not save nap.");
    }
  });

  // ---- breastfeed: side picker (starts the timer) and manual/edit popup ----
  const breastStartDialog = $("breast-start-dialog");
  let onBreastSidePicked = null;

  function openBreastStart(onPick) {
    onBreastSidePicked = onPick;
    openDialog(breastStartDialog);
  }

  wireDialog(breastStartDialog, () => {
    onBreastSidePicked = null;
  });

  breastStartDialog.addEventListener("click", event => {
    const option = event.target.closest("[data-breast-side]");
    if (option) {
      const pick = onBreastSidePicked;
      closeDialog(breastStartDialog);
      pick?.(option.getAttribute("data-breast-side"));
      return;
    }
    if (event.target.closest("[data-breast-manual]")) {
      closeDialog(breastStartDialog);
      openBreast();
    }
  });

  // ---- food (edit only; foods are added from the Food Diary page) ----
  const foodDialog = $("food-dialog");
  const foodName = $("food-dialog-name");
  const foodDate = $("food-dialog-date");
  const foodTime = $("food-dialog-time");
  const foodError = $("food-dialog-error");
  const foodSave = $("food-dialog-save");
  let foodEditing = null;
  $("food-dialog-options").innerHTML = FOODS.map(item => `<option value="${escapeHtml(item.name)}"></option>`).join("");

  function openFood(entry) {
    foodEditing = entry;
    setError(foodError, "");
    foodSave.disabled = false;
    const parts = timestampToLocalParts(entry.timestamp);
    foodName.value = entry.food || "";
    foodDate.value = parts.date;
    foodTime.value = parts.time;
    openDialog(foodDialog);
    foodName.focus();
  }

  wireDialog(foodDialog, () => {
    foodEditing = null;
  });

  $("food-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = foodEditing;
    const food = foodName.value.trim();
    if (!food) {
      setError(foodError, "Add a food.");
      return;
    }
    let timestamp;
    try {
      timestamp = editTimestamp(foodDate, foodTime);
    } catch {
      setError(foodError, "Pick a valid date and time.");
      return;
    }
    foodSave.disabled = true;
    try {
      await saveEntry({ ...editing, food, timestamp }, "food");
      closeDialog(foodDialog);
      showToast("Food updated.");
    } catch {
      foodSave.disabled = false;
      setError(foodError, "Could not save food.");
    }
  });

  const napStartDialog = $("nap-start-dialog");
  let onNapStart = null;

  function openNapStart(onStart) {
    onNapStart = onStart;
    openDialog(napStartDialog);
  }

  wireDialog(napStartDialog, () => {
    onNapStart = null;
  });

  napStartDialog.addEventListener("click", event => {
    if (event.target.closest("[data-nap-start]")) {
      const startNap = onNapStart;
      closeDialog(napStartDialog);
      startNap?.();
    } else if (event.target.closest("[data-nap-manual]")) {
      closeDialog(napStartDialog);
      openNap();
    }
  });

  const breastDialog = $("breast-dialog");
  const breastInputs = { left: $("breast-dialog-left"), right: $("breast-dialog-right"), both: $("breast-dialog-both") };
  const breastDateField = $("breast-dialog-date-field");
  const breastDate = $("breast-dialog-date");
  const breastTime = $("breast-dialog-time");
  const breastError = $("breast-dialog-error");
  const breastSave = $("breast-dialog-save");
  const BREAST_FIELDS = { left: "breastLeftSeconds", right: "breastRightSeconds", both: "breastBothSeconds" };
  let breastEditing = null;

  function openBreast(entry = null) {
    breastEditing = entry;
    setError(breastError, "");
    breastSave.disabled = false;
    $("breast-dialog-title").textContent = entry ? "Edit breastfeed" : "Breastfeed";
    Object.entries(BREAST_FIELDS).forEach(([side, field]) => {
      const seconds = entry?.[field];
      breastInputs[side].value = seconds ? String(Math.round(seconds / 60)) : "";
    });
    if (entry) {
      const parts = timestampToLocalParts(entry.timestamp);
      breastDate.value = parts.date;
      breastTime.value = parts.time;
    } else {
      breastDate.value = "";
      breastTime.value = currentLocalDateTimeParts().time;
    }
    breastDateField.hidden = !entry;
    openDialog(breastDialog);
    breastInputs.left.focus();
  }

  wireDialog(breastDialog, () => {
    breastEditing = null;
  });

  $("breast-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = breastEditing;
    const seconds = {};
    for (const [side, field] of Object.entries(BREAST_FIELDS)) {
      const minutes = parseMl(breastInputs[side]);
      if (minutes !== null && minutes > 360) {
        setError(breastError, "Each side must be 360 minutes or less.");
        return;
      }
      // Keep the exact seconds when editing and the rounded minutes weren't changed.
      const original = editing?.[field];
      seconds[field] = !minutes ? null
        : original && Math.round(original / 60) === minutes ? original : minutes * 60;
    }
    if (!Object.values(seconds).some(Boolean)) {
      setError(breastError, "Add how long the feed lasted.");
      return;
    }
    let timestamp;
    try {
      if (editing) {
        timestamp = editTimestamp(breastDate, breastTime);
      } else {
        const timeValue = normalizeTimeValue(breastTime.value);
        if (!timeValue) {
          throw new Error("Invalid time");
        }
        timestamp = timestampForRecentTime(timeValue);
      }
    } catch {
      setError(breastError, "Pick a valid date and time.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      milkMl: null,
      notes: "",
      feedSession: null,
      ...seconds,
      timestamp,
      createdAt: editing?.createdAt || timestamp
    };
    breastSave.disabled = true;
    try {
      const saved = await saveEntry(entry, "breast");
      closeDialog(breastDialog);
      showToast(
        editing ? "Breastfeed updated." : `Breastfed ${breastSummary(saved)} added at ${addedAt(timestamp)}.`,
        editing ? null : undoEntry(entry.id)
      );
    } catch {
      breastSave.disabled = false;
      setError(breastError, "Could not save breastfeed.");
    }
  });

  // ---- measurement (weight / length / head; any may be blank) ----
  const measureDialog = $("measure-dialog");
  const measureWeight = $("measure-dialog-weight");
  const measureLength = $("measure-dialog-length");
  const measureHead = $("measure-dialog-head");
  const measureDate = $("measure-dialog-date");
  const measureError = $("measure-dialog-error");
  const measureSave = $("measure-dialog-save");
  let measureEditing = null;

  const measureLb = $("measure-dialog-lb");
  const measureOz = $("measure-dialog-oz");

  // Imperial: lb + oz and inches on screen; stored as grams and cm. Unchanged values are kept exactly.
  function openMeasurement(entry = null) {
    measureEditing = entry;
    setError(measureError, "");
    measureSave.disabled = false;
    $("measure-dialog-title").textContent = entry ? "Edit measurement" : "Add measurement";
    const imperial = isImperial();
    $("measure-weight-metric").hidden = imperial;
    $("measure-weight-imperial").hidden = !imperial;
    measureLength.closest("label").querySelector("span").textContent = imperial ? "Length (in)" : "Length (cm)";
    measureHead.closest("label").querySelector("span").textContent = imperial ? "Head (in)" : "Head (cm)";
    [measureLength, measureHead].forEach(input => {
      input.min = imperial ? "8" : input === measureLength ? "30" : "20";
      input.max = imperial ? "52" : input === measureLength ? "130" : "60";
    });
    measureWeight.value = entry?.weightGrams ?? "";
    if (entry?.weightGrams) {
      const ounces = Math.round((entry.weightGrams / G_PER_OZ) * 10) / 10;
      measureLb.value = String(Math.floor(ounces / 16));
      measureOz.value = (ounces - Math.floor(ounces / 16) * 16).toFixed(1);
    } else {
      measureLb.value = "";
      measureOz.value = "";
    }
    const inches = cm => (cm === null || cm === undefined ? "" : (cm / CM_PER_IN).toFixed(1));
    measureLength.value = imperial ? inches(entry?.lengthCm) : entry?.lengthCm ?? "";
    measureHead.value = imperial ? inches(entry?.headCm) : entry?.headCm ?? "";
    measureDialog.dataset.original = JSON.stringify([measureLb.value, measureOz.value, measureLength.value, measureHead.value]);
    measureDate.value = entry?.date || formatDateInputValue();
    openDialog(measureDialog);
    measureWeight.focus();
  }

  wireDialog(measureDialog, () => {
    measureEditing = null;
  });

  function readOptionalNumber(input) {
    const text = input.value.trim();
    if (text === "") {
      return { value: null, ok: true };
    }
    const value = Number(text);
    return { value, ok: Number.isFinite(value) };
  }

  $("measure-dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    const editing = measureEditing;
    let weight = readOptionalNumber(measureWeight);
    let length = readOptionalNumber(measureLength);
    let head = readOptionalNumber(measureHead);
    if (isImperial()) {
      const original = JSON.parse(measureDialog.dataset.original || "[]");
      const lb = readOptionalNumber(measureLb);
      const oz = readOptionalNumber(measureOz);
      if (measureLb.value === original[0] && measureOz.value === original[1] && editing) {
        weight = { value: editing.weightGrams ?? null, ok: true };
      } else if (lb.value === null && oz.value === null) {
        weight = { value: null, ok: true };
      } else {
        const total = (lb.value || 0) * 16 + (oz.value || 0);
        weight = { value: Math.round(total * G_PER_OZ), ok: lb.ok && oz.ok && total > 0 };
      }
      const toCm = (input, item, index, originalCm) => {
        if (input.value === original[index] && editing) {
          return { value: originalCm ?? null, ok: true };
        }
        return item.value === null ? item : { value: Math.round(item.value * CM_PER_IN * 10) / 10, ok: item.ok };
      };
      length = toCm(measureLength, length, 2, editing?.lengthCm);
      head = toCm(measureHead, head, 3, editing?.headCm);
    }
    if (!weight.ok || (weight.value !== null && (!Number.isInteger(weight.value) || weight.value <= 0 || weight.value > 30000))) {
      setError(measureError, isImperial() ? "Check the weight in pounds and ounces." : "Weight must be in whole grams.");
      return;
    }
    if (!length.ok || (length.value !== null && (length.value < 30 || length.value > 130))) {
      setError(measureError, isImperial() ? "Length should be between 12 and 51 in." : "Length should be between 30 and 130 cm.");
      return;
    }
    if (!head.ok || (head.value !== null && (head.value < 20 || head.value > 60))) {
      setError(measureError, isImperial() ? "Head circumference should be between 8 and 23 in." : "Head circumference should be between 20 and 60 cm.");
      return;
    }
    if (weight.value === null && length.value === null && head.value === null) {
      setError(measureError, "Add at least one measurement.");
      return;
    }
    if (!measureDate.value) {
      setError(measureError, "Pick a date.");
      return;
    }
    const entry = {
      id: editing?.id || createId(),
      date: measureDate.value,
      weightGrams: weight.value,
      lengthCm: length.value === null ? null : Math.round(length.value * 10) / 10,
      headCm: head.value === null ? null : Math.round(head.value * 10) / 10,
      createdAt: editing?.createdAt || new Date().toISOString()
    };
    measureSave.disabled = true;
    try {
      await saveMeasurement(entry);
      await Promise.all([fetchMeasurements(), fetchSettings()]).catch(() => null);
      onMeasurementSaved();
      closeDialog(measureDialog);
      showToast(editing ? "Measurement updated." : "Measurement added.", editing ? null : undoMeasurement(entry.id));
    } catch (error) {
      measureSave.disabled = false;
      setError(measureError, error.message && !error.message.startsWith("Failed") ? error.message : "Could not save measurement.");
    }
  });

  // Open the right editor for an existing entry.
  function editEntry(entry) {
    const openers = { pumped: openPumped, feed: openFeed, breast: openBreast, food: openFood, poo: openPoo, nap: openNap, note: openNote, medicine: openMedicine };
    openers[entryKind(entry)](entry);
  }

  return {
    openFeed, openPumped, openNote, openMedicine, openPoo, openNap, openNapStart, openBreast, openBreastStart, openFood, openMeasurement,
    editEntry, showToast, saveEntry, undoEntry, addedAt
  };
}

// ---------------------------------------------------------------------------
// Feed reminders (per browser): next feed = latest feed + fixed or learned gap
// ---------------------------------------------------------------------------
const REMINDER_KEY = "mlkbar.feedReminder";

function readReminderPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(REMINDER_KEY) || "{}") || {};
  } catch {}
  return {
    enabled: saved.enabled === true,
    mode: saved.mode === "learned" ? "learned" : "fixed",
    gapMinutes: Number.isInteger(saved.gapMinutes) && saved.gapMinutes > 0 ? saved.gapMinutes : 180
  };
}

function writeReminderPrefs(prefs) {
  try {
    window.localStorage.setItem(REMINDER_KEY, JSON.stringify(prefs));
  } catch {}
}

// Average gap over the last 48h, ignoring top-ups under 30 min. Needs 2+ gaps; clamped to 1-6h.
function learnedGapMinutes(feedTimes, now = Date.now()) {
  const recent = feedTimes.filter(t => now - t <= 48 * 3600000 && t <= now + 300000).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const minutes = (recent[i] - recent[i - 1]) / 60000;
    if (minutes >= 30) {
      gaps.push(minutes);
    }
  }
  if (gaps.length < 2) {
    return null;
  }
  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return Math.round(Math.min(360, Math.max(60, average)));
}

function reminderGap(feedTimes, prefs, now = Date.now()) {
  const learned = prefs.mode === "learned" ? learnedGapMinutes(feedTimes, now) : null;
  return learned ? { minutes: learned, learned: true } : { minutes: prefs.gapMinutes, learned: false };
}

function nextFeedDue(feedTimes, prefs, now = Date.now()) {
  const past = feedTimes.filter(t => t <= now + 300000);
  if (!past.length) {
    return null;
  }
  return Math.max(...past) + reminderGap(feedTimes, prefs, now).minutes * 60000;
}

function feedTimesOf(entries) {
  const seen = new Set();
  return entries
    .filter(entry => {
      const kind = entryKind(entry);
      if ((kind !== "feed" && kind !== "breast") || seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    })
    .map(entry => new Date(entry.timestamp).getTime());
}

function renderHome() {
  const todayTotal = document.getElementById("today-total");
  const todayPumpedTotal = document.getElementById("today-pumped-total");
  const quickError = document.getElementById("quick-error");
  let appWasHidden = false;

  const lastFeedTime = document.getElementById("last-feed-time");
  const lastFeedMeta = document.getElementById("last-feed-meta");

  // Home loads yesterday + today so "Last feed" still works just after midnight.
  function homeRange(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  function formatAgo(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000));
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h${rest ? ` ${rest}m` : ""} ago`;
  }

  function renderLastFeed(entries) {
    const cutoff = new Date(Date.now() + 5 * 60000).toISOString();
    const lastFeed = entries
      .filter(entry => ["feed", "breast"].includes(entryKind(entry)) && entry.timestamp <= cutoff)
      .reduce((latest, entry) => (!latest || entry.timestamp > latest.timestamp ? entry : latest), null);
    if (!lastFeed) {
      lastFeedTime.textContent = "None";
      lastFeedMeta.textContent = "No feed in the last 2 days";
      return;
    }
    lastFeedTime.textContent = `${isToday(lastFeed.timestamp) ? "" : "Yesterday "}${formatTime(lastFeed.timestamp)}`;
    const what = entryKind(lastFeed) === "breast"
      ? `Breastfed ${formatDuration(breastTotalSeconds(lastFeed))}`
      : formatVolume(lastFeed.milkMl);
    lastFeedMeta.textContent = `${what} · ${formatAgo(lastFeed.timestamp)}`;
  }

  // Feeds from the last 48h (the page itself only loads today) for "Next feed due".
  const nextFeed = document.getElementById("next-feed");
  let recentFeedEntries = [];

  function renderNextFeed() {
    if (!nextFeed) {
      return;
    }
    const prefs = readReminderPrefs();
    const due = prefs.enabled ? nextFeedDue(feedTimesOf([...entriesCache, ...recentFeedEntries]), prefs) : null;
    nextFeed.hidden = due === null;
    if (due === null) {
      return;
    }
    const minutes = Math.round((due - Date.now()) / 60000);
    const when = minutes >= 0 ? `in ${formatDuration(Math.max(minutes, 1) * 60)}` : `${formatDuration(-minutes * 60)} ago`;
    nextFeed.textContent = `Next feed due ~${formatTime(new Date(due).toISOString())} \u00b7 ${when}`;
    nextFeed.classList.toggle("overdue", minutes < 0);
  }

  async function loadRecentFeeds() {
    if (!readReminderPrefs().enabled) {
      return;
    }
    try {
      const from = new Date(Date.now() - 48 * 3600000).toISOString();
      const response = await apiFetch(`/api/entries?from=${encodeURIComponent(from)}`);
      if (response.ok) {
        recentFeedEntries = await response.json();
        renderNextFeed();
      }
    } catch {}
  }

  function renderEntries(entries) {
    const todaysEntries = entries.filter(entry => isToday(entry.timestamp));
    todayTotal.textContent = formatVolume(sumFeedMilk(todaysEntries));
    todayPumpedTotal.textContent = formatVolume(sumPumpedMilk(todaysEntries));
    renderLastFeed(entries);
    renderNextFeed();
  }
  loadRecentFeeds();

  // Keep "x min ago" current while the page is open.
  window.setInterval(() => renderEntries(entriesCache), 60000);

  const ui = createEntryUi({
    onEntrySaved: () => renderEntries(entriesCache),
    onEntryRemoved: entryId => {
      recentFeedEntries = recentFeedEntries.filter(entry => entry.id !== entryId);
      renderEntries(entriesCache);
    }
  });

  function showQuickError(message) {
    quickError.textContent = message;
    quickError.hidden = !message;
  }

  async function quickSave(button, entry, kind, message) {
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    showQuickError("");
    try {
      await ui.saveEntry(entry, kind);
      ui.showToast(message, ui.undoEntry(entry.id));
    } catch {
      showQuickError("Could not save. Check your connection and try again.");
    } finally {
      // Short lock to stop accidental double taps.
      window.setTimeout(() => {
        button.disabled = false;
      }, 800);
    }
  }

  // One-tap feed amount comes from Settings (shared with the iOS app).
  const quickFeedButton = document.getElementById("quick-feed");
  const quickFeedLabel = quickFeedButton.querySelector(".quick-add-label");
  const quickFeedMl = () => settingsCache.quickFeedMl || 120;
  const renderQuickFeedLabel = () => {
    quickFeedLabel.textContent = `${formatVolume(quickFeedMl())} feed`;
  };
  quickFeedButton.addEventListener("click", () => {
    const timestamp = nowTimestamp();
    const ml = quickFeedMl();
    quickSave(quickFeedButton, {
      id: createId(),
      milkMl: ml,
      notes: "",
      feedSession: null,
      timestamp,
      createdAt: timestamp
    }, "feed", `${formatVolume(ml)} feed added at ${formatTime(timestamp)}.`);
  });
  // Buttons turned off in Settings are hidden; an odd last button spans the row.
  function applyQuickButtons() {
    const hidden = new Set(settingsCache.hiddenQuickButtons || []);
    const grid = document.querySelector(".quick-add-grid");
    (settingsCache.quickButtonOrder || []).forEach(key => {
      const item = grid.querySelector(`:scope > [data-quick="${key}"]`);
      if (item) {
        grid.appendChild(item);
      }
    });
    const items = [...grid.querySelectorAll(":scope > [data-quick]")];
    items.forEach(item => {
      item.hidden = hidden.has(item.getAttribute("data-quick"));
      item.classList.remove("span-full");
    });
    const visible = items.filter(item => !item.hidden);
    if (visible.length % 2 === 1) {
      visible[visible.length - 1].classList.add("span-full");
    }
    document.getElementById("quick-none").hidden = visible.length > 0;
  }
  if (applyCachedSettings()) {
    renderQuickFeedLabel();
    applyQuickButtons();
  }
  fetchSettings().then(() => {
    renderQuickFeedLabel();
    applyQuickButtons();
  }).catch(() => null);

  document.getElementById("quick-poo").addEventListener("click", () => ui.openPoo());
  document.querySelector("#quick-poo .quick-add-label").textContent = term("Poo");
  document.querySelector("#quick-wee .quick-add-label").textContent = term("Wee");
  // Wee: one tap, no popup.
  const quickWeeButton = document.getElementById("quick-wee");
  quickWeeButton.addEventListener("click", () => {
    const timestamp = nowTimestamp();
    quickSave(quickWeeButton, {
      id: createId(),
      milkMl: null,
      notes: "",
      feedSession: null,
      poo: "wee",
      timestamp,
      createdAt: timestamp
    }, "poo", `💧 ${term("Wee")} logged at ${formatTime(timestamp)}.`);
  });
  document.getElementById("quick-custom-feed").addEventListener("click", () => ui.openFeed());
  document.getElementById("quick-pumped").addEventListener("click", () => ui.openPumped());
  document.getElementById("quick-note").addEventListener("click", () => ui.openNote());
  document.getElementById("quick-medicine")?.addEventListener("click", () => ui.openMedicine());
  setupTimers(ui, () => renderEntries(entriesCache));

  async function loadTodayEntries() {
    await fetchEntries(homeRange());
    return entriesCache;
  }
  refreshHomeEntries = loadTodayEntries;

  registerPullToRefresh(async () => {
    await loadTodayEntries();
    await loadRecentFeeds();
    renderEntries(entriesCache);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      appWasHidden = true;
      return;
    }
    if (appWasHidden) {
      appWasHidden = false;
      // Cheap (today only): picks up entries added on another device and day rollover.
      loadTodayEntries().then(renderEntries).catch(() => null);
    }
  });

  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      loadTodayEntries().then(renderEntries).catch(() => null);
    }
  });

  // Show cached data immediately, then refresh from the server.
  const renderedFromCache = applyCachedEntries(homeRange());
  if (renderedFromCache) {
    renderEntries(entriesCache);
  }

  loadTodayEntries()
    .then(renderEntries)
    .catch(() => {
      if (!renderedFromCache) {
        showQuickError("Could not load today's totals.");
      }
    });
}

// Timer cards on the Add page. Polls the server so a timer started on another
// device (e.g. the iOS app) shows up here too.
const TIMER_ICONS = {
  breast: `<svg class="quick-add-icon" viewBox="0 0 32 32" aria-hidden="true" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="11" cy="9" r="4"/><path d="M5 28V22Q5 15.5 11 15.5Q14.5 15.5 16.5 18"/><circle cx="20.5" cy="18.5" r="3"/><path d="M14 21.5Q14 28 21 28Q27.5 28 27.5 22.5Q27.5 21 26.5 20"/></svg>`,
  nap: `<svg class="quick-add-icon" viewBox="0 0 32 32" aria-hidden="true" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M14 9A8 8 0 0 0 25 21A11 11 0 1 1 14 9Z"/><path d="M19 4H24L19 9.5H24" stroke-width="1.1"/><path d="M26 11.5H29L26 15H29" stroke-width="1"/></svg>`
};
const TIMER_NAMES = { breast: "Breastfeed", nap: "Nap" };

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

// Seconds per side so far, from the switch points.
function timerSideSeconds(timer, now = Date.now()) {
  const totals = { left: 0, right: 0, both: 0 };
  const segments = timer.segments?.length ? timer.segments : [{ side: "both", start: timer.startedAt }];
  segments.forEach((segment, index) => {
    const start = new Date(segment.start).getTime();
    const end = index + 1 < segments.length ? new Date(segments[index + 1].start).getTime() : now;
    totals[segment.side] += Math.max(0, (end - start) / 1000);
  });
  return totals;
}

function setupTimers(ui, onEntriesChanged) {
  const error = document.getElementById("timer-error");
  const cards = { breast: document.getElementById("timer-breast"), nap: document.getElementById("timer-nap") };
  if (!cards.breast || !cards.nap) {
    return;
  }
  let busy = false;

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function currentSide(timer) {
    return timer.segments?.[timer.segments.length - 1]?.side || null;
  }

  function render() {
    ["breast", "nap"].forEach(kind => {
      const timer = timersCache[kind];
      const card = cards[kind];
      card.classList.toggle("timer-card-running", Boolean(timer));
      if (!timer) {
        card.innerHTML = `
          <button class="quick-add-button timer-start" type="button" data-timer-start="${kind}">
            ${TIMER_ICONS[kind]}
            <span class="quick-add-label">${TIMER_NAMES[kind]}</span>
          </button>`;
        return;
      }
      const side = currentSide(timer);
      const title = kind === "breast" ? `Breastfeeding · ${BREAST_SIDE_LABELS[side] || ""}` : "Napping";
      const switchTo = side === "left" ? "right" : side === "right" ? "left" : null;
      card.innerHTML = `
        <div class="timer-running">
          <span class="timer-title">${escapeHtml(title)}</span>
          <strong class="timer-clock" data-timer-clock="${kind}">0:00</strong>
          <span class="timer-sides" data-timer-sides="${kind}"></span>
          <button class="primary-button timer-stop" type="button" data-timer-stop="${kind}">Stop</button>
          ${switchTo ? `<button class="ghost-button" type="button" data-timer-switch="${kind}">Switch to ${switchTo}</button>` : ""}
          <button class="link-button" type="button" data-timer-cancel="${kind}">Discard</button>
        </div>`;
    });
    tick();
  }

  function tick() {
    const now = Date.now();
    ["breast", "nap"].forEach(kind => {
      const timer = timersCache[kind];
      if (!timer) {
        return;
      }
      const clock = cards[kind].querySelector("[data-timer-clock]");
      if (clock) {
        clock.textContent = formatClock((now - new Date(timer.startedAt).getTime()) / 1000);
      }
      const sides = cards[kind].querySelector("[data-timer-sides]");
      if (sides && kind === "breast") {
        const totals = timerSideSeconds(timer, now);
        const used = ["left", "right"].filter(side => totals[side] > 0);
        sides.textContent = used.length > 1
          ? used.map(side => `${side === "left" ? "L" : "R"} ${formatClock(totals[side])}`).join(" · ")
          : "";
      }
    });
  }

  async function refresh() {
    try {
      await fetchTimers();
      render();
    } catch {
      // Keep showing what we have; the next poll will try again.
    }
  }

  async function start(kind, side = null) {
    const startedAt = new Date().toISOString();
    const timer = {
      kind,
      id: createId(),
      startedAt,
      segments: kind === "breast" ? [{ side, start: startedAt }] : []
    };
    timersCache[kind] = timer;
    render();
    try {
      const result = await putTimer(timer);
      timersCache[kind] = result.timer;
      if (result.conflict) {
        ui.showToast(`A ${kind === "breast" ? "breastfeed" : "nap"} timer was already running on another device.`);
      }
      cacheWrite("timers", timersCache);
      render();
    } catch {
      timersCache[kind] = null;
      render();
      showError("Could not start the timer. Check your connection and try again.");
    }
  }

  async function switchSide(kind) {
    const timer = timersCache[kind];
    const side = currentSide(timer);
    const next = side === "left" ? "right" : "left";
    const updated = { ...timer, segments: [...timer.segments, { side: next, start: new Date().toISOString() }] };
    timersCache[kind] = updated;
    render();
    try {
      const result = await putTimer(updated);
      timersCache[kind] = result.timer;
      cacheWrite("timers", timersCache);
    } catch {
      timersCache[kind] = timer;
      showError("Could not switch side.");
    }
    render();
  }

  async function stop(kind) {
    const timer = timersCache[kind];
    try {
      const result = await stopTimerRequest(timer);
      timersCache[kind] = null;
      cacheWrite("timers", timersCache);
      render();
      if (!result.ok) {
        ui.showToast("That timer was already stopped on another device.");
        await fetchEntriesForToday();
        return;
      }
      if (!result.entry) {
        ui.showToast("Too short to log.");
        return;
      }
      const entry = result.entry;
      entriesCache = [entry, ...entriesCache.filter(item => item.id !== entry.id)];
      cacheUpsertEntry(entry);
      onEntriesChanged();
      const message = kind === "breast"
        ? `Breastfed ${breastSummary(entry)} logged.`
        : `${formatNapMinutes(entry.napMinutes)} nap logged.`;
      ui.showToast(message, async () => {
        await ui.undoEntry(entry.id)();
        onEntriesChanged();
      });
    } catch {
      showError("Could not stop the timer. Check your connection and try again.");
    }
  }

  async function fetchEntriesForToday() {
    await refreshHomeEntries?.();
    onEntriesChanged();
  }

  async function discard(kind) {
    if (!window.confirm(`Discard this ${kind === "breast" ? "breastfeed" : "nap"} timer without logging it?`)) {
      return;
    }
    const timer = timersCache[kind];
    try {
      await cancelTimerRequest(timer);
      timersCache[kind] = null;
      cacheWrite("timers", timersCache);
      render();
    } catch {
      showError("Could not discard the timer.");
    }
  }

  document.querySelector(".quick-add-grid").addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button || busy) {
      return;
    }
    showError("");
    const kind = ["start", "manual", "stop", "switch", "cancel"]
      .map(action => [action, button.getAttribute(`data-timer-${action}`)])
      .find(([, value]) => value);
    if (!kind) {
      return;
    }
    const [action, timerKind] = kind;
    if (action === "manual") {
      (timerKind === "breast" ? ui.openBreast : ui.openNap)();
      return;
    }
    // Both open a small popup first: pick a side / start, or enter a past one instead.
    if (action === "start" && timerKind === "breast") {
      ui.openBreastStart(side => start("breast", side));
      return;
    }
    if (action === "start" && timerKind === "nap") {
      ui.openNapStart(() => start("nap"));
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      if (action === "start") {
        await start(timerKind);
      } else if (action === "stop") {
        await stop(timerKind);
      } else if (action === "switch") {
        await switchSide(timerKind);
      } else if (action === "cancel") {
        await discard(timerKind);
      }
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  applyCachedTimers();
  render();
  refresh();
  window.setInterval(tick, 1000);
  window.setInterval(() => {
    if (!document.hidden && !busy) {
      refresh();
    }
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh();
    }
  });
}

let refreshHomeEntries = null;

function renderLog() {
  const container = document.getElementById("daily-log");
  const ui = createEntryUi({
    onEntrySaved: () => drawLog(container, entriesCache)
  });
  registerPullToRefresh(async () => {
    const entries = await fetchEntries();
    drawLog(container, entries);
  });

  container.onclick = async event => {
    const monthToggle = event.target.closest("[data-month-toggle]");
    if (monthToggle) {
      const group = monthToggle.closest(".month-group");
      const monthKey = monthToggle.getAttribute("data-month-toggle");
      const willExpand = group.classList.contains("collapsed");
      if (willExpand) {
        renderMonthDays(container, group, monthKey);
        logExpandedMonths.add(monthKey);
      } else {
        logExpandedMonths.delete(monthKey);
      }
      group.classList.toggle("collapsed", !willExpand);
      monthToggle.setAttribute("aria-expanded", String(willExpand));
      return;
    }

    const toggle = event.target.closest("[data-day-toggle]");
    if (toggle) {
      const card = toggle.closest(".day-card");
      const dayKey = toggle.getAttribute("data-day-toggle");
      const willExpand = card.classList.contains("collapsed");
      if (willExpand) {
        renderDayEntries(container, card, dayKey);
        logExpandedDays.add(dayKey);
      } else {
        logExpandedDays.delete(dayKey);
      }
      card.classList.toggle("collapsed", !willExpand);
      toggle.setAttribute("aria-expanded", String(willExpand));
      return;
    }

    const editButton = event.target.closest("[data-edit-id]");
    if (editButton) {
      // Edit in place: open the same popup used on the Add page.
      const id = editButton.getAttribute("data-edit-id");
      const entry = entriesCache.find(item => item.id === id);
      if (entry) {
        ui.editEntry(entry);
      }
      return;
    }

    const button = event.target.closest("[data-delete-id]");
    if (!button) {
      return;
    }
    const id = button.getAttribute("data-delete-id");
    if (!window.confirm("Delete this entry?")) {
      return;
    }
    try {
      await deleteEntry(id);
      entriesCache = entriesCache.filter(entry => entry.id !== id);
      cacheRemoveEntry(id);
      drawLog(container, entriesCache);
    } catch {
      container.className = "daily-log empty-state";
      container.textContent = "Could not delete entry.";
    }
  };

  // Show cached data immediately, then refresh from the server.
  const renderedFromCache = applyCachedEntries();
  if (renderedFromCache) {
    drawLog(container, entriesCache);
  }

  fetchEntries()
    .then(entries => {
      drawLog(container, entries);
    })
    .catch(() => {
      if (!renderedFromCache) {
        container.className = "daily-log empty-state";
        container.textContent = "Could not load entries.";
      }
    });
}

// Log page state. Entries are grouped month -> day. Collapsed months and days only
// render their header; their contents are built the first time they are expanded.
let logDayGroups = {};
let logMonthGroups = {};
const logExpandedDays = new Set([localDayKey(new Date().toISOString())]);
let logExpandedMonths = null; // initialised on first draw to the newest month

function countEntries(entries) {
  const counts = { feeds: 0, breastfeeds: 0, pumps: 0, foods: 0, wees: 0, poos: 0, naps: 0, notes: 0, medicines: 0 };
  const keys = { feed: "feeds", breast: "breastfeeds", pumped: "pumps", food: "foods", poo: "poos", nap: "naps", note: "notes", medicine: "medicines" };
  const foodsSeen = new Set();
  entries.forEach(entry => {
    const kind = entryKind(entry);
    if (kind === "food") {
      // Each food counts once per day.
      const key = `${localDayKey(entry.timestamp)}|${foodKey(entry.food)}`;
      if (foodsSeen.has(key)) {
        return;
      }
      foodsSeen.add(key);
    }
    if (kind === "poo" && entry.poo === "wee") {
      counts.wees += 1;
      return;
    }
    counts[keys[kind]] += 1;
  });
  return counts;
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Counts shown two per line, e.g. "3 feeds • 1 pump" / "2 poos • 1 nap".
function countGrid(items) {
  const lines = [];
  for (let index = 0; index < items.length; index += 2) {
    lines.push(items.slice(index, index + 2).map(escapeHtml).join(" • "));
  }
  return `<div class="count-lines">${lines.map(line => `<span>${line}</span>`).join("")}</div>`;
}

function formatMonthLabel(monthKey) {
  return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" })
    .format(new Date(`${monthKey}-01T00:00:00`));
}

function renderDayEntries(container, card, dayKey) {
  if (card.querySelector(".day-entry-list")) {
    return;
  }
  const entryList = document.createElement("div");
  entryList.className = "day-entry-list";
  const dayEntries = logDayGroups[dayKey] || [];
  // All of the day's food in one row at the top of the day.
  const foods = uniqueFoods(dayEntries);
  if (foods.length) {
    entryList.appendChild(createFoodDayCard(foods));
  }
  dayEntries.forEach(entry => {
    if (entryKind(entry) !== "food") {
      entryList.appendChild(createEntryCard(entry));
    }
  });
  card.appendChild(entryList);
}

function createDayCard(container, dayKey) {
  const dayEntries = logDayGroups[dayKey];
  const isExpanded = logExpandedDays.has(dayKey);
  const card = document.createElement("section");
  card.className = "day-card";
  if (!isExpanded) {
    card.classList.add("collapsed");
  }

  const header = document.createElement("button");
  header.className = "day-header";
  header.type = "button";
  header.setAttribute("data-day-toggle", dayKey);
  header.setAttribute("aria-expanded", String(isExpanded));
  header.innerHTML = `
    <div>
      <h3>${formatDay(dayEntries[0].timestamp)}</h3>
      ${countGrid((counts => [
        pluralize(counts.feeds, "feed"),
        ...(counts.breastfeeds ? [pluralize(counts.breastfeeds, "breastfeed")] : []),
        pluralize(counts.pumps, "pump"),
        ...(counts.foods ? [pluralize(counts.foods, "food")] : []),
        ...(counts.wees ? [pluralize(counts.wees, term("wee"))] : []),
        pluralize(counts.poos, term("poo")), pluralize(counts.naps, "nap"),
        ...(counts.medicines ? [pluralize(counts.medicines, "medicine")] : [])
      ])(countEntries(dayEntries)))}
    </div>
    <div class="day-header-side">
      <div class="day-total-stack">
        <strong class="day-total">${formatVolume(sumFeedMilk(dayEntries))} feed</strong>
        <p class="day-total-sub">${formatVolume(sumPumpedMilk(dayEntries))} pumped</p>
      </div>
      <span class="day-toggle-indicator" aria-hidden="true"></span>
    </div>
  `;
  card.appendChild(header);

  if (isExpanded) {
    renderDayEntries(container, card, dayKey);
  }
  return card;
}

function renderMonthDays(container, group, monthKey) {
  if (group.querySelector(".month-day-list")) {
    return;
  }
  const dayList = document.createElement("div");
  dayList.className = "month-day-list";
  (logMonthGroups[monthKey] || []).forEach(dayKey => {
    dayList.appendChild(createDayCard(container, dayKey));
  });
  group.appendChild(dayList);
}

function createMonthGroup(container, monthKey, todayKey) {
  const dayKeys = logMonthGroups[monthKey];
  const monthEntries = dayKeys.flatMap(dayKey => logDayGroups[dayKey]);
  // Averages skip today, which is still in progress.
  const completeDays = dayKeys.filter(dayKey => dayKey !== todayKey);
  const avgFeed = completeDays.length
    ? Math.round(completeDays.reduce((sum, dayKey) => sum + sumFeedMilk(logDayGroups[dayKey]), 0) / completeDays.length)
    : null;
  const avgPumped = completeDays.length
    ? Math.round(completeDays.reduce((sum, dayKey) => sum + sumPumpedMilk(logDayGroups[dayKey]), 0) / completeDays.length)
    : null;

  const isExpanded = logExpandedMonths.has(monthKey);
  const group = document.createElement("section");
  group.className = "month-group";
  if (!isExpanded) {
    group.classList.add("collapsed");
  }

  const header = document.createElement("button");
  header.className = "day-header month-header";
  header.type = "button";
  header.setAttribute("data-month-toggle", monthKey);
  header.setAttribute("aria-expanded", String(isExpanded));
  header.innerHTML = `
    <div class="month-header-top">
      <h3>${formatMonthLabel(monthKey)}</h3>
      <span class="day-toggle-indicator" aria-hidden="true"></span>
    </div>
    <div class="month-insights">
      <span class="month-insights-title">Monthly Insights</span>
      <div class="month-insights-body">
      <div>
      ${countGrid((counts => [
        pluralize(dayKeys.length, "day"), pluralize(counts.feeds, "feed"),
        ...(counts.breastfeeds ? [pluralize(counts.breastfeeds, "breastfeed")] : []),
        pluralize(counts.pumps, "pump"),
        ...(counts.foods ? [pluralize(counts.foods, "food")] : []),
        ...(counts.wees ? [pluralize(counts.wees, term("wee"))] : []),
        pluralize(counts.poos, term("poo")),
        pluralize(counts.naps, "nap"), pluralize(counts.notes, "note"),
        ...(counts.medicines ? [pluralize(counts.medicines, "medicine")] : [])
      ])(countEntries(monthEntries)))}
      </div>
      <div class="day-total-stack">
        <strong class="day-total">${avgFeed === null ? "–" : formatVolume(avgFeed)}/day feed</strong>
        <p class="day-total-sub">${avgPumped === null ? "–" : formatVolume(avgPumped)}/day pumped</p>
      </div>
      </div>
    </div>
  `;
  group.appendChild(header);

  if (isExpanded) {
    renderMonthDays(container, group, monthKey);
  }
  return group;
}

function drawLog(container, entries) {
  const sortedEntries = sortEntries(entries);
  container.innerHTML = "";

  if (!sortedEntries.length) {
    logDayGroups = {};
    logMonthGroups = {};
    container.className = "daily-log empty-state";
    container.textContent = "No entries yet.";
    return;
  }

  container.className = "daily-log";
  logDayGroups = groupByDay(sortedEntries);
  logMonthGroups = {};
  Object.keys(logDayGroups)
    .sort((a, b) => b.localeCompare(a))
    .forEach(dayKey => {
      const monthKey = dayKey.slice(0, 7);
      (logMonthGroups[monthKey] ||= []).push(dayKey);
    });

  const monthKeys = Object.keys(logMonthGroups).sort((a, b) => b.localeCompare(a));
  if (!logExpandedMonths) {
    logExpandedMonths = new Set([monthKeys[0]]);
  }

  const todayKey = localDayKey(new Date().toISOString());
  const fragment = document.createDocumentFragment();
  monthKeys.forEach(monthKey => {
    fragment.appendChild(createMonthGroup(container, monthKey, todayKey));
  });
  container.appendChild(fragment);
}

function renderReminderSettings() {
  const enabled = document.getElementById("reminder-enabled");
  if (!enabled) {
    return;
  }
  const options = document.getElementById("reminder-options");
  const mode = document.getElementById("reminder-mode");
  const gap = document.getElementById("reminder-gap");
  const gapLabel = document.getElementById("reminder-gap-label");
  const prefs = readReminderPrefs();
  enabled.checked = prefs.enabled;
  mode.value = prefs.mode;
  gap.value = String(prefs.gapMinutes);
  function sync() {
    options.hidden = !enabled.checked;
    gapLabel.textContent = mode.value === "learned" ? "Gap until learned" : "Gap between feeds";
    writeReminderPrefs({ enabled: enabled.checked, mode: mode.value, gapMinutes: Number(gap.value) || 180 });
  }
  [enabled, mode, gap].forEach(input => input.addEventListener("change", sync));
  options.hidden = !enabled.checked;
  gapLabel.textContent = mode.value === "learned" ? "Gap until learned" : "Gap between feeds";
}

function renderThemeSetting() {
  const select = document.getElementById("theme-select");
  if (!select) {
    return;
  }
  let value = "system";
  try {
    value = window.localStorage.getItem("mlkbar.theme") || "system";
  } catch {}
  select.value = value;
  select.addEventListener("change", () => {
    try {
      window.localStorage.setItem("mlkbar.theme", select.value);
    } catch {}
    if (select.value === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", select.value);
    }
  });
}

// Metric / imperial (shared with every device). Saves the full settings so nothing else changes.
function renderUnitsSetting() {
  const select = document.getElementById("units-select");
  if (!select) {
    return;
  }
  const error = document.getElementById("units-error");
  select.value = settingsCache.units || "metric";
  fetchSettings().then(settings => {
    if (document.activeElement !== select) {
      select.value = settings.units;
    }
  }).catch(() => null);
  select.addEventListener("change", async () => {
    select.disabled = true;
    error.hidden = true;
    try {
      const current = await fetchSettings();
      await saveSettings({ ...current, units: select.value });
      await fetchSettings();
      window.location.reload();
    } catch {
      error.textContent = "Could not save. Check your connection and try again.";
      error.hidden = false;
      select.value = settingsCache.units || "metric";
      select.disabled = false;
    }
  });
}

function renderSettings() {
  const buildInfo = document.getElementById("build-info");
  if (buildInfo) {
    buildInfo.textContent = `mlkbar web · build ${WEB_BUILD}`;
  }
  renderReminderSettings();
  renderThemeSetting();
  renderUnitsSetting();
  const form = document.getElementById("settings-form");
  const babyDobInput = document.getElementById("baby-dob");
  const babySexInput = document.getElementById("baby-sex");
  const babyNameInput = document.getElementById("baby-name");
  const quickFeedInput = document.getElementById("quick-feed-ml");
  const errorElement = document.getElementById("settings-error");
  const feedbackElement = document.getElementById("settings-feedback");
  const submitButton = document.getElementById("settings-submit");
  const logoutButton = document.getElementById("logout-button");
  const quickList = document.getElementById("quick-order-list");

  // Customise page: one row per Quick Add button with up/down arrows and an on/off switch.
  function renderQuickToggles(settings) {
    if (!quickList) {
      return;
    }
    const hidden = new Set(settings.hiddenQuickButtons || []);
    const order = (settings.quickButtonOrder || []).length ? settings.quickButtonOrder : QUICK_BUTTONS.map(item => item.key);
    const arrow = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    quickList.innerHTML = order
      .map(key => QUICK_BUTTONS.find(item => item.key === key))
      .filter(Boolean)
      .map(item => `
        <div class="toggle-row" data-quick-row="${item.key}">
          <label for="quick-toggle-${item.key}">${escapeHtml(item.term ? term(item.label) : item.label)}</label>
          <span class="order-buttons">
            <button type="button" class="order-button" data-move="up" aria-label="Move ${escapeHtml(item.label)} up">${arrow("M6 15L12 9L18 15")}</button>
            <button type="button" class="order-button" data-move="down" aria-label="Move ${escapeHtml(item.label)} down">${arrow("M6 9L12 15L18 9")}</button>
          </span>
          <input id="quick-toggle-${item.key}" type="checkbox" data-quick-toggle="${item.key}" ${hidden.has(item.key) ? "" : "checked"} />
        </div>`).join("");
  }

  quickList?.addEventListener("click", event => {
    const button = event.target.closest("[data-move]");
    if (!button) {
      return;
    }
    const row = button.closest("[data-quick-row]");
    if (button.getAttribute("data-move") === "up" && row.previousElementSibling) {
      row.parentNode.insertBefore(row, row.previousElementSibling);
    } else if (button.getAttribute("data-move") === "down" && row.nextElementSibling) {
      row.parentNode.insertBefore(row.nextElementSibling, row);
    }
    button.focus();
  });

  function clearMessages() {
    errorElement.hidden = true;
    feedbackElement.hidden = true;
  }

  function showError(message) {
    clearMessages();
    errorElement.hidden = false;
    errorElement.textContent = message;
  }

  function showFeedback(message) {
    clearMessages();
    feedbackElement.hidden = false;
    feedbackElement.textContent = message;
  }

  registerPullToRefresh(async () => {
    const settings = await fetchSettings();
    if (!form) {
      return;
    }
    if (document.activeElement !== babyDobInput) {
      babyDobInput.value = settings.babyDob ?? "";
    }
    if (document.activeElement !== babySexInput) {
      babySexInput.value = settings.babySex ?? "";
    }
  });

  form?.addEventListener("submit", async event => {
    event.preventDefault();
    clearMessages();
    const babyDob = babyDobInput.value.trim() || null;
    const babySex = babySexInput.value || null;
    const babyName = babyNameInput.value.trim() || null;
    const quickFeedMl = volumeFromInput(quickFeedInput);
    if (!Number.isInteger(quickFeedMl) || quickFeedMl < 1 || quickFeedMl > 2000) {
      showError(isImperial() ? "Quick feed amount must be between 0.1 and 67 oz." : "Quick feed amount must be a whole number of ml (1 to 2000).");
      return;
    }

    submitButton.disabled = true;
    try {
      const nextSettings = {
        feedingTimes: getFeedingTimes(),
        babyWeightGrams: settingsCache.babyWeightGrams,
        babyDob,
        babySex,
        babyName,
        quickFeedMl,
        hiddenQuickButtons: [...quickList.querySelectorAll("[data-quick-toggle]")]
          .filter(toggle => !toggle.checked).map(toggle => toggle.getAttribute("data-quick-toggle")),
        quickButtonOrder: [...quickList.querySelectorAll("[data-quick-row]")].map(row => row.getAttribute("data-quick-row"))
      };
      await saveSettings(nextSettings);
      settingsCache = await fetchSettings();
      applyBrandName();
      showFeedback("Saved.");
    } catch {
      showError("Could not save settings.");
    } finally {
      submitButton.disabled = false;
    }
  });

  // Show cached value immediately; only overwrite it if the user hasn't started editing.
  const renderedFromCache = form ? applyCachedSettings() : false;
  const cachedDob = renderedFromCache ? (settingsCache.babyDob ?? "") : null;
  const cachedSex = renderedFromCache ? (settingsCache.babySex ?? "") : null;
  if (renderedFromCache) {
    babyDobInput.value = cachedDob;
    babySexInput.value = cachedSex;
    babyNameInput.value = settingsCache.babyName ?? "";
    setVolumeInput(quickFeedInput, settingsCache.quickFeedMl);
    renderQuickToggles(settingsCache);
  }
  const cachedQuickFeed = renderedFromCache ? quickFeedInput.value : null;

  (form ? fetchSettings() : Promise.resolve(null))
    .then(settings => {
      if (!settings) {
        return;
      }
      renderQuickToggles(settings);
      const untouched = !renderedFromCache || (babyDobInput.value === cachedDob && document.activeElement !== babyDobInput);
      if (untouched) {
        babyDobInput.value = settings.babyDob ?? "";
      }
      if (!renderedFromCache || babySexInput.value === cachedSex) {
        babySexInput.value = settings.babySex ?? "";
      }
      if (document.activeElement !== babyNameInput) {
        babyNameInput.value = settings.babyName ?? "";
      }
      if (!renderedFromCache || (quickFeedInput.value === cachedQuickFeed && document.activeElement !== quickFeedInput)) {
        setVolumeInput(quickFeedInput, settings.quickFeedMl);
      }
    })
    .catch(() => {
      if (!renderedFromCache) {
        showError("Could not load settings.");
      }
    });

  // Export / import (full JSON backup).
  const exportButton = document.getElementById("export-button");
  const importButton = document.getElementById("import-button");
  const importFile = document.getElementById("import-file");
  const backupFeedback = document.getElementById("backup-feedback");
  const backupError = document.getElementById("backup-error");
  function backupMessage(message, isError = false) {
    backupFeedback.hidden = isError || !message;
    backupError.hidden = !isError || !message;
    (isError ? backupError : backupFeedback).textContent = message;
  }
  // CSV for spreadsheets (entries + measurements).
  const exportCsvButton = document.getElementById("export-csv-button");
  exportCsvButton?.addEventListener("click", async () => {
    exportCsvButton.disabled = true;
    backupMessage("");
    try {
      const response = await apiFetch("/api/export.csv");
      if (!response.ok) {
        throw new Error("Failed");
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `mlkbar-${formatDateInputValue()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      backupMessage("CSV exported.");
    } catch {
      backupMessage("Could not export the CSV.", true);
    } finally {
      exportCsvButton.disabled = false;
    }
  });

  exportButton?.addEventListener("click", async () => {
    exportButton.disabled = true;
    backupMessage("");
    try {
      const response = await apiFetch("/api/export");
      if (!response.ok) {
        throw new Error("Failed");
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `mlkbar-export-${formatDateInputValue()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      backupMessage("Export downloaded.");
    } catch {
      backupMessage("Could not export.", true);
    } finally {
      exportButton.disabled = false;
    }
  });
  // PDF report: open it so it can be saved or shared (Share sheet on iPhone).
  const reportButton = document.getElementById("report-button");
  const reportFeedback = document.getElementById("report-feedback");
  const reportError = document.getElementById("report-error");
  function reportMessage(message, isError = false) {
    reportFeedback.hidden = isError || !message;
    reportError.hidden = !isError || !message;
    (isError ? reportError : reportFeedback).textContent = message;
  }
  reportButton?.addEventListener("click", async () => {
    reportButton.disabled = true;
    reportMessage("");
    try {
      const days = document.getElementById("report-days").value;
      const response = await apiFetch(`/api/report.pdf?days=${encodeURIComponent(days)}`);
      if (!response.ok) {
        throw new Error("Failed");
      }
      const blob = await response.blob();
      const file = new File([blob], `mlkbar-report-${formatDateInputValue()}.pdf`, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "mlkbar report" }).catch(() => null);
      } else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      }
      reportMessage("PDF report ready.");
    } catch {
      reportMessage("Could not create the PDF.", true);
    } finally {
      reportButton.disabled = false;
    }
  });
  importButton?.addEventListener("click", () => importFile.click());
  importFile?.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) {
      return;
    }
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      backupMessage("That file isn't a valid export.", true);
      return;
    }
    if (data?.app !== "mlkbar") {
      backupMessage("That isn't an mlkbar export file.", true);
      return;
    }
    if (!window.confirm(`Import ${data.entries?.length || 0} entries and ${data.measurements?.length || 0} measurements? Nothing will be deleted.`)) {
      return;
    }
    importButton.disabled = true;
    backupMessage("Importing…");
    try {
      const response = await apiFetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Failed");
      }
      cacheClearAll();
      backupMessage(`Imported ${pluralize(result.entries, "entry").replace("entrys", "entries")}, ${pluralize(result.measurements, "measurement")}`
        + `${result.skipped ? ` (${result.skipped} skipped)` : ""}.`);
    } catch (error) {
      backupMessage(error.message && error.message !== "Failed" ? error.message : "Could not import.", true);
    } finally {
      importButton.disabled = false;
    }
  });

  // iOS app sign-ins (bearer tokens). Lets you cut off a lost phone.
  const revokeButton = document.getElementById("revoke-ios-button");
  const devicesSummary = document.getElementById("ios-devices-summary");
  async function refreshDevices() {
    if (!devicesSummary) {
      return;
    }
    try {
      const response = await apiFetch("/api/auth/tokens");
      const devices = response.ok ? await response.json() : [];
      devicesSummary.textContent = devices.length
        ? `iOS app signed in on: ${devices.map(device => device.deviceName).join(", ")}.`
        : "No iOS devices signed in.";
      if (revokeButton) {
        revokeButton.hidden = !devices.length;
      }
    } catch {
      devicesSummary.textContent = "";
    }
  }
  if (revokeButton) {
    revokeButton.addEventListener("click", async () => {
      if (!window.confirm("Sign out the iOS app on every device?")) {
        return;
      }
      try {
        const response = await apiFetch("/api/auth/tokens/revoke-all", { method: "POST" });
        if (!response.ok) {
          throw new Error("Failed");
        }
        showFeedback("All iOS devices signed out.");
        refreshDevices();
      } catch {
        showError("Could not sign out iOS devices.");
      }
    });
  }
  refreshDevices();

  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      logoutButton.disabled = true;
      clearMessages();
      try {
        await logout();
        redirectToLogin();
      } catch {
        logoutButton.disabled = false;
        showError("Could not log out.");
      }
    });
  }
}

function renderLogin() {
  const form = document.getElementById("login-form");
  const title = document.getElementById("auth-title");
  const copy = document.getElementById("auth-copy");
  const confirmField = document.getElementById("confirm-password-field");
  const setupCodeField = document.getElementById("setup-code-field");
  const setupCodeInput = document.getElementById("setup-code");
  const passwordInput = document.getElementById("password");
  const confirmPasswordInput = document.getElementById("confirm-password");
  const submitButton = document.getElementById("auth-submit");
  const errorElement = document.getElementById("auth-error");
  const feedbackElement = document.getElementById("auth-feedback");

  function clearMessages() {
    errorElement.hidden = true;
    feedbackElement.hidden = true;
  }

  function showError(message) {
    clearMessages();
    errorElement.hidden = false;
    errorElement.textContent = message;
  }

  function showFeedback(message) {
    clearMessages();
    feedbackElement.hidden = false;
    feedbackElement.textContent = message;
  }

  fetchAuthStatus()
    .then(status => {
      if (status.authenticated) {
        window.location.replace("/");
        return null;
      }

      const isSetup = !status.passwordConfigured;
      title.textContent = isSetup ? "Set mlkbar password" : "Unlock mlkbar";
      copy.textContent = isSetup
        ? "Enter the setup code from the server logs (or data/setup-code.txt), then create one shared password for the app."
        : "Enter the shared password. You will stay signed in for about 90 days on this device.";
      confirmField.hidden = !isSetup;
      setupCodeField.hidden = !isSetup;
      submitButton.textContent = isSetup ? "Save Password" : "Log In";

      form.addEventListener("submit", async event => {
        event.preventDefault();
        clearMessages();

        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        if (isSetup && !setupCodeInput.value.trim()) {
          showError("Enter the setup code.");
          return;
        }
        if (password.length < 8) {
          showError("Use at least 8 characters.");
          return;
        }
        if (isSetup && password !== confirmPassword) {
          showError("Passwords do not match.");
          return;
        }

        submitButton.disabled = true;
        try {
          if (isSetup) {
            await setupPassword(password, setupCodeInput.value);
            showFeedback("Password saved. Opening mlkbar...");
          } else {
            await loginWithPassword(password);
            showFeedback("Signed in. Opening mlkbar...");
          }
          window.location.replace("/");
        } catch (error) {
          submitButton.disabled = false;
          showError(error.message || "Could not sign in.");
        }
      });

      return null;
    })
    .catch(() => {
      showError("Could not load login.");
    });
}

// ---------------------------------------------------------------------------
// WHO growth percentiles (data in who-growth.js)
// ---------------------------------------------------------------------------
const MEASURE_LABELS = {
  weight: { name: "Weight", ageLimitMonths: 60 },
  length: { name: "Length", ageLimitMonths: 24 },
  head: { name: "Head", ageLimitMonths: 60 }
};
const DAYS_PER_MONTH = 30.4375;

// Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function ageInDaysOn(dateText, dobText) {
  if (!dateText || !dobText) {
    return null;
  }
  const days = Math.round((new Date(`${dateText}T00:00:00`) - new Date(`${dobText}T00:00:00`)) / 86400000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

// WHO LMS z-score. LMS values are interpolated linearly between monthly rows.
function whoZScore(indicator, sex, ageDays, value) {
  const table = window.WHO_GROWTH?.[indicator]?.[sex === "girl" ? "girls" : "boys"];
  if (!table || !Number.isFinite(value) || value <= 0 || ageDays === null) {
    return null;
  }
  const months = ageDays / DAYS_PER_MONTH;
  if (months < 0 || months > table.length - 1) {
    return null;
  }
  const index = Math.min(Math.floor(months), table.length - 2);
  const fraction = months - index;
  const [L, M, S] = [0, 1, 2].map(k => table[index][k] + (table[index + 1][k] - table[index][k]) * fraction);
  let z = Math.abs(L) < 1e-9 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);

  // WHO's restricted application for weight beyond +/-3 SD (skewed distribution tail).
  if (indicator === "weight" && Math.abs(z) > 3) {
    const sdAt = zz => M * Math.pow(1 + L * S * zz, 1 / L);
    if (z > 3) {
      z = 3 + (value - sdAt(3)) / (sdAt(3) - sdAt(2));
    } else {
      z = -3 + (value - sdAt(-3)) / (sdAt(-2) - sdAt(-3));
    }
  }
  return z;
}

// ---------------------------------------------------------------------------
// Growth charts: WHO percentile curves with the logged measurements as dots
// ---------------------------------------------------------------------------
const GROWTH_CURVES = [
  { label: "97%", z: 1.881, cls: "growth-curve-outer" },
  { label: "85%", z: 1.036, cls: "growth-curve-dotted" },
  { label: "50%", z: 0, cls: "growth-curve-mid" },
  { label: "15%", z: -1.036, cls: "growth-curve-dotted" },
  { label: "3%", z: -1.881, cls: "growth-curve-outer" }
];

// Value at a given z for an LMS row.
function lmsValue([L, M, S], z) {
  return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

function renderGrowthCharts(container) {
  if (!container) {
    return;
  }
  const sex = settingsCache.babySex;
  const dob = settingsCache.babyDob;
  if (!sex || !dob) {
    container.className = "growth-charts empty-state";
    container.textContent = "Add the date of birth and sex in Build Your Profile to see the charts.";
    return;
  }
  container.className = "growth-charts";
  const ageNow = ageInDaysOn(formatDateInputValue(), dob) ?? 0;
  const indicators = [
    { key: "weight", field: "weightGrams", name: "Weight", unit: isImperial() ? "lb" : "kg",
      toDisplay: kg => (isImperial() ? kg * 1000 / G_PER_OZ / 16 : kg), fromEntry: e => e.weightGrams / 1000 },
    { key: "length", field: "lengthCm", name: "Length", unit: isImperial() ? "in" : "cm",
      toDisplay: cm => (isImperial() ? cm / CM_PER_IN : cm), fromEntry: e => e.lengthCm },
    { key: "head", field: "headCm", name: "Head circumference", unit: isImperial() ? "in" : "cm",
      toDisplay: cm => (isImperial() ? cm / CM_PER_IN : cm), fromEntry: e => e.headCm }
  ];
  container.innerHTML = indicators.map(ind => {
    const table = window.WHO_GROWTH?.[ind.key]?.[sex === "girl" ? "girls" : "boys"];
    if (!table) {
      return "";
    }
    const points = measurementsCache
      .filter(m => m[ind.field] !== null && m[ind.field] !== undefined)
      .map(m => ({ days: ageInDaysOn(m.date, dob), value: ind.toDisplay(ind.fromEntry(m)), date: m.date }))
      .filter(p => p.days !== null && p.days >= 0);
    // Range: the next 6-month step past the oldest of today / last measurement, within the WHO table.
    const lastDays = Math.max(ageNow, ...points.map(p => p.days), 0);
    const maxMonths = Math.min(table.length - 1, Math.max(6, Math.ceil((lastDays / DAYS_PER_MONTH + 1) / 6) * 6));
    const rows = table.slice(0, maxMonths + 1);
    const curves = GROWTH_CURVES.map(curve => ({ ...curve, values: rows.map(row => ind.toDisplay(lmsValue(row, curve.z))) }));
    const shown = points.filter(p => p.days <= maxMonths * DAYS_PER_MONTH);
    const all = [...curves.flatMap(c => c.values), ...shown.map(p => p.value)];
    const step = niceStep((Math.max(...all) - Math.min(...all)) / 6);
    const yMin = Math.floor(Math.min(...all) / step) * step;
    const yMax = Math.ceil(Math.max(...all) / step) * step;

    // Plot area inside a 340 x 230 viewBox (labels left, bottom and right).
    const left = 34, right = 300, top = 10, bottom = 196;
    const x = days => left + (days / (maxMonths * DAYS_PER_MONTH)) * (right - left);
    const y = value => bottom - ((value - yMin) / (yMax - yMin)) * (bottom - top);
    const monthStep = maxMonths <= 6 ? 1 : maxMonths <= 12 ? 2 : maxMonths <= 24 ? 3 : 6;
    let grid = "";
    for (let m = 0; m <= maxMonths; m += monthStep) {
      const gx = x(m * DAYS_PER_MONTH);
      grid += `<line class="growth-grid" x1="${gx}" x2="${gx}" y1="${top}" y2="${bottom}"></line>`
        + `<text class="growth-axis" x="${gx}" y="${bottom + 13}" text-anchor="middle">${m}</text>`;
    }
    for (let v = yMin; v <= yMax + step / 2; v += step) {
      const gy = y(v);
      grid += `<line class="growth-grid" x1="${left}" x2="${right}" y1="${gy}" y2="${gy}"></line>`
        + `<text class="growth-axis" x="${left - 4}" y="${gy + 3}" text-anchor="end">${Number(v.toFixed(2))}</text>`;
    }
    const lines = curves.map(curve => {
      const d = curve.values.map((v, m) => `${m ? "L" : "M"}${x(m * DAYS_PER_MONTH).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
      const last = curve.values[curve.values.length - 1];
      return `<path class="growth-curve ${curve.cls}" d="${d}"></path>`
        + `<text class="growth-curve-label" x="${right + 4}" y="${y(last) + 3}">${curve.label}</text>`;
    }).join("");
    const dots = shown.map(p => `<circle class="growth-dot" cx="${x(p.days).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5"><title>${escapeHtml(formatDateLabel(p.date))}: ${escapeHtml(p.value.toFixed(ind.unit === "kg" ? 2 : 1))} ${ind.unit}</title></circle>`).join("");
    return `
      <figure class="growth-chart">
        <figcaption>${escapeHtml(ind.name)} <span>(${ind.unit})</span></figcaption>
        <svg viewBox="0 0 340 230" role="img" aria-label="${escapeHtml(ind.name)} growth chart">
          ${grid}${lines}${dots}
          <text class="growth-axis" x="${(left + right) / 2}" y="${bottom + 28}" text-anchor="middle">Age (months)</text>
        </svg>
        ${shown.length ? "" : `<p class="field-hint">No ${escapeHtml(ind.name.toLowerCase())} measurements yet.</p>`}
      </figure>`;
  }).join("");
}

// 1, 2, 2.5 or 5 x a power of ten.
function niceStep(raw) {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) {
    return `${n}th`;
  }
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

function formatPercentile(z) {
  if (z === null) {
    return null;
  }
  const p = normalCdf(z) * 100;
  if (p < 0.1) {
    return "<0.1st";
  }
  if (p > 99.9) {
    return ">99.9th";
  }
  if (p < 1 || p > 99) {
    return `${p.toFixed(1)}th`;
  }
  return ordinal(Math.round(p));
}

// Value + percentile text for each measured field of one entry.
function measurementParts(entry) {
  const sex = settingsCache.babySex;
  const ageDays = ageInDaysOn(entry.date, settingsCache.babyDob);
  const parts = [];
  const add = (indicator, raw, valueForWho, text) => {
    if (raw === null || raw === undefined) {
      return;
    }
    let percentile = null;
    let note = null;
    if (sex && ageDays !== null) {
      const z = whoZScore(indicator, sex, ageDays, valueForWho);
      percentile = formatPercentile(z);
      if (z === null && ageDays / DAYS_PER_MONTH > MEASURE_LABELS[indicator].ageLimitMonths) {
        note = `WHO table ends at ${MEASURE_LABELS[indicator].ageLimitMonths} months`;
      }
    }
    parts.push({ indicator, label: MEASURE_LABELS[indicator].name, text, percentile, note });
  };
  add("weight", entry.weightGrams, entry.weightGrams / 1000, formatWeightKg(entry.weightGrams));
  add("length", entry.lengthCm, entry.lengthCm, formatLength(entry.lengthCm));
  add("head", entry.headCm, entry.headCm, formatLength(entry.headCm));
  return parts;
}

function percentileHint() {
  if (!settingsCache.babyDob && !settingsCache.babySex) {
    return "Add date of birth and boy/girl in Settings to see WHO percentiles.";
  }
  if (!settingsCache.babyDob) {
    return "Add date of birth in Settings to see WHO percentiles.";
  }
  if (!settingsCache.babySex) {
    return "Set boy or girl in Settings to see WHO percentiles.";
  }
  return null;
}

function createMeasurementCard(entry) {
  const wrapper = document.createElement("article");
  const safeId = escapeHtml(entry.id);
  wrapper.className = "entry-card measurement-entry";
  const lines = measurementParts(entry).map(part => `
      <p class="measurement-line">
        <span class="measurement-label">${escapeHtml(part.label)}</span>
        <span>${escapeHtml(part.text)}${part.percentile ? ` • ${escapeHtml(part.percentile)}` : ""}</span>
      </p>`).join("");
  wrapper.innerHTML = `
    <div class="entry-main">
      <p class="entry-summary">${formatDateLabel(entry.date)}</p>
      ${lines}
    </div>
    <div class="entry-actions">
      <button class="edit-button" type="button" data-measure-edit-id="${safeId}">Edit</button>
      <button class="delete-button" type="button" data-measure-delete-id="${safeId}">Delete</button>
    </div>
  `;
  return wrapper;
}

function sortMeasurementsNewestFirst(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date < b.date ? 1 : -1;
    }
    return (a.createdAt || "") < (b.createdAt || "") ? 1 : -1;
  });
}

// Latest value of each measurement, with its own date and percentile.
function renderLatestMeasurements(container) {
  const sorted = sortMeasurementsNewestFirst(measurementsCache);
  const fields = [["weight", "weightGrams"], ["length", "lengthCm"], ["head", "headCm"]];
  const cards = fields.map(([indicator, key]) => {
    const entry = sorted.find(item => item[key] !== null && item[key] !== undefined);
    if (!entry) {
      return `
        <div class="stat-card stat-card-wide">
          <span class="stat-label">${MEASURE_LABELS[indicator].name}</span>
          <strong>–</strong>
        </div>`;
    }
    const only = { date: entry.date, weightGrams: null, lengthCm: null, headCm: null, [key]: entry[key] };
    const part = measurementParts(only)[0];
    const meta = escapeHtml(formatDateLabel(entry.date))
      + (part.percentile
        ? ` • <span class="percentile">${escapeHtml(part.percentile)} percentile</span>`
        : part.note ? ` • ${escapeHtml(part.note)}` : "");
    return `
      <div class="stat-card stat-card-wide stat-card-detail">
        <div class="stat-copy">
          <span class="stat-label">${MEASURE_LABELS[indicator].name}</span>
          <p class="stat-meta stat-meta-inline">${meta}</p>
        </div>
        <strong>${escapeHtml(part.text)}</strong>
      </div>`;
  });
  const hint = percentileHint();
  container.innerHTML = `<div class="stats-grid">${cards.join("")}</div>${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ""}`;
}

// Typical weight gain by age band (same figures as the Normal Weight Gain table).
const WEIGHT_GAIN_GUIDE = {
  "0-3-months": { label: "0 to 3 months", min: 25, max: 30, text: "25 to 30 g/day" },
  "3-6-months": { label: "3 to 6 months", min: 20, max: 20, text: "20 g/day" },
  "6-9-months": { label: "6 to 9 months", min: 10, max: 15, text: "10 to 15 g/day" },
  "9-12-months": { label: "9 to 12 months", min: 8, max: 10, text: "8 to 10 g/day" }
};

function daysBetween(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00`) - new Date(`${fromDate}T00:00:00`)) / 86400000);
}

// Plain-language insights from logged measurements. Descriptive only, not medical advice.
function renderGrowthInsights(container) {
  const dob = settingsCache.babyDob;
  const sex = settingsCache.babySex;
  const ageDays = calculateAgeInDays(dob);
  const lines = [];
  const asc = [...measurementsCache].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1));
  const weights = asc.filter(item => Number.isFinite(item.weightGrams));
  const today = formatDateInputValue();

  const ageSummary = formatAgeSummary(ageDays);
  if (ageSummary) {
    lines.push(`Age today: ${ageSummary}.`);
  }

  // Recent weight gain vs the typical range for the age at that time.
  if (weights.length >= 2) {
    const last = weights[weights.length - 1];
    const prev = weights[weights.length - 2];
    const span = Math.max(1, daysBetween(prev.date, last.date));
    const perDay = (last.weightGrams - prev.weightGrams) / span;
    const midAge = ageInDaysOn(prev.date, dob);
    const guide = midAge === null ? null : WEIGHT_GAIN_GUIDE[getGrowthBand(midAge + Math.round(span / 2))];
    let comparison = "";
    if (guide && ageInDaysOn(last.date, dob) <= 366) {
      const position = perDay < guide.min ? "below" : perDay > guide.max ? "above" : "within";
      const guideText = isImperial()
        ? (guide.min === guide.max
          ? `${(guide.min / G_PER_OZ).toFixed(1)} oz/day`
          : `${(guide.min / G_PER_OZ).toFixed(1)} to ${(guide.max / G_PER_OZ).toFixed(1)} oz/day`)
        : guide.text;
      comparison = `, ${position} the typical ${guideText} for ${guide.label}`;
    }
    const perDayText = isImperial() ? `${(perDay / G_PER_OZ).toFixed(2)} oz/day` : `${perDay.toFixed(1)} g/day`;
    const gain = last.weightGrams - prev.weightGrams;
    lines.push(`Recent gain: ${gain >= 0 ? "+" : "-"}${formatGrams(Math.abs(gain))} over ${span} days (${perDayText}${comparison}).`);
  } else if (weights.length === 1) {
    lines.push("Add a second weight to see the recent gain.");
  }

  // Birth weight milestones, if the first weight was taken in the first week.
  if (weights.length >= 2 && dob) {
    const first = weights[0];
    const firstAge = ageInDaysOn(first.date, dob);
    if (firstAge !== null && firstAge <= 7) {
      const latest = weights[weights.length - 1];
      const multiple = latest.weightGrams / first.weightGrams;
      lines.push(`Weight is ${multiple.toFixed(1)}× the first-week weight of ${formatWeightKg(first.weightGrams)} (babies often double by about 5 months and triple by 1 year).`);
    }
  }

  // Percentile movement since the previous measurement of each type.
  if (sex && dob) {
    [["weight", "weightGrams", v => v / 1000], ["length", "lengthCm", v => v], ["head", "headCm", v => v]].forEach(([indicator, key, toWho]) => {
      const series = asc.filter(item => item[key] !== null && item[key] !== undefined);
      if (series.length < 2) {
        return;
      }
      const prev = series[series.length - 2];
      const last = series[series.length - 1];
      const zPrev = whoZScore(indicator, sex, ageInDaysOn(prev.date, dob), toWho(prev[key]));
      const zLast = whoZScore(indicator, sex, ageInDaysOn(last.date, dob), toWho(last[key]));
      if (zPrev === null || zLast === null) {
        return;
      }
      const change = zLast - zPrev;
      const direction = Math.abs(change) < 0.2 ? "steady" : change > 0 ? "up" : "down";
      let line = `${MEASURE_LABELS[indicator].name} percentile ${direction}: ${formatPercentile(zPrev)} → ${formatPercentile(zLast)} since ${formatDateLabel(prev.date)}.`;
      if (Math.abs(change) >= 1.34) {
        line += " That's a large shift across percentile lines, worth mentioning at the next check-up.";
      }
      lines.push(line);
    });
  }

  // How long since each measurement type was last taken.
  if (weights.length) {
    const sinceWeigh = daysBetween(weights[weights.length - 1].date, today);
    if (sinceWeigh > 28) {
      lines.push(`Last weighed ${sinceWeigh} days ago. Weighing every 2 to 4 weeks is typical unless advised otherwise.`);
    } else if (sinceWeigh >= 0) {
      lines.push(`Last weighed ${sinceWeigh === 0 ? "today" : `${sinceWeigh} day${sinceWeigh === 1 ? "" : "s"} ago`}.`);
    }
  }

  if (!lines.length) {
    lines.push("Add measurements to see growth insights.");
  }
  container.innerHTML = lines.map(line => `<p class="insight-line">${escapeHtml(line)}</p>`).join("");

  // Highlight the current age band in the Normal Weight Gain table.
  const band = ageDays === null || ageDays > 366 ? null : getGrowthBand(ageDays);
  document.querySelectorAll("[data-growth-band]").forEach(row => {
    row.classList.toggle("chart-row-active", row.getAttribute("data-growth-band") === band);
  });
}

function renderMeasurementsPage() {
  const latestContainer = document.getElementById("measure-latest");
  const logContainer = document.getElementById("measure-log");

  const insightsContainer = document.getElementById("growth-insights");

  const chartsContainer = document.getElementById("growth-charts");

  function renderAll() {
    renderLatestMeasurements(latestContainer);
    renderGrowthCharts(chartsContainer);
    renderGrowthInsights(insightsContainer);
    const sorted = sortMeasurementsNewestFirst(measurementsCache);
    logContainer.innerHTML = "";
    if (!sorted.length) {
      logContainer.className = "entry-list empty-state";
      logContainer.textContent = "No measurements yet.";
      return;
    }
    logContainer.className = "entry-list";
    sorted.forEach(entry => logContainer.appendChild(createMeasurementCard(entry)));
  }

  const ui = createEntryUi({ onMeasurementSaved: renderAll });
  document.getElementById("measure-add-button").addEventListener("click", () => ui.openMeasurement());

  logContainer.addEventListener("click", async event => {
    const editButton = event.target.closest("[data-measure-edit-id]");
    if (editButton) {
      const entry = measurementsCache.find(item => item.id === editButton.getAttribute("data-measure-edit-id"));
      if (entry) {
        ui.openMeasurement(entry);
      }
      return;
    }
    const deleteButton = event.target.closest("[data-measure-delete-id]");
    if (!deleteButton || !window.confirm("Delete this measurement?")) {
      return;
    }
    try {
      await deleteMeasurement(deleteButton.getAttribute("data-measure-delete-id"));
      await Promise.all([fetchMeasurements(), fetchSettings()]);
      renderAll();
      ui.showToast("Measurement deleted.");
    } catch {
      ui.showToast("Could not delete measurement.");
    }
  });

  registerPullToRefresh(async () => {
    await Promise.all([fetchSettings(), fetchMeasurements()]);
    renderAll();
  });

  // Show cached data immediately, then refresh from the server.
  const renderedFromCache = applyCachedSettings() && applyCachedMeasurements();
  if (renderedFromCache) {
    renderAll();
  }
  Promise.all([fetchSettings(), fetchMeasurements()])
    .then(renderAll)
    .catch(() => {
      if (!renderedFromCache) {
        logContainer.className = "entry-list empty-state";
        logContainer.textContent = "Could not load measurements.";
      }
    });
}

// ---- Food diary page: search the catalog (or type your own), tap to log ----
function renderFoodDiary() {
  const search = document.getElementById("food-search");
  const daySelect = document.getElementById("food-day");
  const results = document.getElementById("food-results");
  const resultsLabel = document.getElementById("food-results-label");
  const groupsBox = document.getElementById("food-groups");
  const suggested = document.getElementById("food-suggested");
  const diary = document.getElementById("food-diary");
  const more = document.getElementById("food-more");
  const error = document.getElementById("food-error");
  let daysShown = 7;

  const ui = createEntryUi({
    onEntrySaved: () => drawDiary(),
    onEntryRemoved: () => drawDiary()
  });

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function foodEntries() {
    return sortEntries(entriesCache.filter(entry => entryKind(entry) === "food"));
  }

  // Chosen day as YYYY-MM-DD (never in the future).
  function chosenDay() {
    const today = formatDateInputValue();
    return daySelect.value && daySelect.value <= today ? daySelect.value : today;
  }

  function eatenOnChosenDay(name) {
    const dayKey = localDayKey(buildTimestamp(chosenDay(), "00:00"));
    const key = foodKey(name);
    return foodEntries().filter(item => localDayKey(item.timestamp) === dayKey && foodKey(item.food) === key);
  }

  // Allergens-style row: name (+ optional hint) and one pink dot, filled when had that day.
  function row(name, { label = null, hint = null } = {}) {
    const done = eatenOnChosenDay(name).length > 0;
    return `<button class="allergen-row food-row" type="button" data-food="${escapeHtml(name)}" aria-pressed="${done}">
      <span class="allergen-name"><span>${escapeHtml(label || name)}</span>${hint ? `<span class="allergen-hint">${escapeHtml(hint)}</span>` : ""}</span>
      <span class="allergen-dot${done ? " checked" : ""}" aria-hidden="true"></span>
    </button>`;
  }

  function drawGroups() {
    groupsBox.innerHTML = COMMON_FOOD_GROUPS.map(group => `
      <div class="food-group">
        <p class="food-results-label">${escapeHtml(group.title)}</p>
        <div class="food-rows">${group.foods.map(name => row(regionFoodName(name))).join("")}</div>
      </div>`).join("");
  }

  async function toggleFood(name) {
    const had = eatenOnChosenDay(name);
    if (!had.length) {
      await addFood(name);
      return;
    }
    showError("");
    try {
      for (const item of had) {
        await deleteEntry(item.id);
        entriesCache = entriesCache.filter(entry => entry.id !== item.id);
        cacheRemoveEntry(item.id);
      }
      const timestamp = had[0].timestamp;
      drawDiary();
      ui.showToast(`${foodLabel(name)} removed from ${isToday(timestamp) ? "today" : formatDay(timestamp)}.`);
    } catch {
      showError("Could not remove.");
    }
  }

  function drawResults() {
    const query = search.value.trim().toLowerCase();
    if (!query) {
      const seen = new Set();
      const recent = [];
      foodEntries().forEach(entry => {
        const key = foodKey(entry.food);
        if (!seen.has(key) && recent.length < 8) {
          seen.add(key);
          recent.push(entry);
        }
      });
      resultsLabel.textContent = recent.length ? "Recent" : "";
      resultsLabel.hidden = !recent.length;
      results.innerHTML = recent.map(entry => row(foodLabel(entry.food))).join("");
      suggested.hidden = false;
      drawGroups();
      return;
    }
    suggested.hidden = true;
    resultsLabel.hidden = false;
    const named = FOODS.map(item => ({ ...item, name: regionFoodName(item.name) }));
    const matches = named
      .filter(item => item.name.toLowerCase().includes(query) || item.category.toLowerCase().includes(query))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
      .slice(0, 30);
    const exact = named.some(item => foodKey(item.name) === foodKey(query));
    const typed = search.value.trim();
    resultsLabel.textContent = matches.length ? "Results" : "Not in the list";
    results.innerHTML = matches.map(item => row(item.name)).join("")
      + (exact ? "" : row(typed.slice(0, 80), { label: `Add “${typed.slice(0, 80)}”` }));
  }

  function drawDiary() {
    const groups = groupByDay(foodEntries());
    const dayKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    if (!dayKeys.length) {
      diary.className = "food-diary empty-state";
      diary.textContent = "No foods logged yet.";
      more.hidden = true;
      drawResults();
      return;
    }
    diary.className = "food-diary";
    diary.innerHTML = "";
    dayKeys.slice(0, daysShown).forEach(dayKey => {
      const section = document.createElement("section");
      section.className = "food-day";
      const foods = uniqueFoods(groups[dayKey]);
      section.innerHTML = `<h3>${formatDay(groups[dayKey][0].timestamp)} <span>${pluralize(foods.length, "food")}</span></h3>`;
      const list = document.createElement("div");
      list.className = "food-day-list";
      list.innerHTML = foods.map(item => `
        <div class="food-day-item">
          <span>${escapeHtml(foodLabel(item.name))}</span>
          <button class="delete-button" type="button" data-remove-food="${escapeHtml(item.ids.join(","))}" data-food-name="${escapeHtml(item.name)}">Remove</button>
        </div>`).join("");
      section.appendChild(list);
      diary.appendChild(section);
    });
    more.hidden = dayKeys.length <= daysShown;
    drawResults();
  }

  async function addFood(name) {
    const food = name.trim().slice(0, 80);
    if (!food) {
      return;
    }
    // Foods have a day, not a time: stored at the start of the chosen day.
    const today = formatDateInputValue();
    const dayValue = daySelect.value && daySelect.value <= today ? daySelect.value : today;
    const timestamp = buildTimestamp(dayValue, "00:00");
    // One of each food per day.
    const dayKey = localDayKey(timestamp);
    if (foodEntries().some(item => localDayKey(item.timestamp) === dayKey && foodKey(item.food) === foodKey(food))) {
      search.value = "";
      drawResults();
      ui.showToast(`${foodLabel(food)} is already in ${isToday(timestamp) ? "today's" : "that day's"} diary.`);
      return;
    }
    const entry = { id: createId(), milkMl: null, notes: "", feedSession: null, food, timestamp, createdAt: new Date().toISOString() };
    showError("");
    try {
      await ui.saveEntry(entry, "food");
      search.value = "";
      drawResults();
      ui.showToast(`${foodLabel(food)} added to ${isToday(timestamp) ? "today" : formatDay(timestamp)}.`, ui.undoEntry(entry.id));
    } catch {
      showError("Could not save. Check your connection and try again.");
    }
  }

  groupsBox.addEventListener("click", event => {
    const button = event.target.closest("[data-food]");
    if (button) {
      toggleFood(button.getAttribute("data-food"));
    }
  });

  // Day defaults to today (and rolls over at midnight unless a day was picked).
  let dayPicked = false;
  function refreshDay() {
    daySelect.max = formatDateInputValue();
    if (!dayPicked) {
      daySelect.value = formatDateInputValue();
    }
  }
  daySelect.addEventListener("change", () => {
    dayPicked = daySelect.value !== formatDateInputValue();
    drawResults();
  });
  refreshDay();
  window.setInterval(refreshDay, 60000);

  search.addEventListener("input", drawResults);
  search.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = results.querySelector("[data-food]");
      if (first && search.value.trim()) {
        addFood(first.getAttribute("data-food"));
      }
    }
  });
  results.addEventListener("click", event => {
    const button = event.target.closest("[data-food]");
    if (button) {
      toggleFood(button.getAttribute("data-food"));
    }
  });

  more.addEventListener("click", () => {
    daysShown += 14;
    drawDiary();
  });

  diary.addEventListener("click", async event => {
    const button = event.target.closest("[data-remove-food]");
    if (!button || !window.confirm(`Remove ${button.getAttribute("data-food-name")} from this day?`)) {
      return;
    }
    const ids = button.getAttribute("data-remove-food").split(",");
    try {
      for (const id of ids) {
        await deleteEntry(id);
        entriesCache = entriesCache.filter(entry => entry.id !== id);
        cacheRemoveEntry(id);
      }
      drawDiary();
    } catch {
      showError("Could not remove.");
    }
  });

  registerPullToRefresh(async () => {
    await fetchEntries();
    drawDiary();
  });

  const fromCache = applyCachedEntries();
  drawDiary();
  fetchEntries().then(drawDiary).catch(() => {
    if (!fromCache) {
      showError("Could not load the diary.");
    }
  });
}

// ---- Allergen introduction checklist (keys shared with the server and iOS app) ----
const ALLERGENS = [
  { key: "peanut", name: "Peanut", hint: "Smooth peanut butter or paste, thinned" },
  { key: "egg", name: "Egg", hint: "Well-cooked egg, e.g. hard-boiled and mashed" },
  { key: "dairy", name: "Dairy", hint: "Cow's milk, yoghurt or cheese" },
  { key: "wheat", name: "Wheat", hint: "Wheat cereal, pasta or bread" },
  { key: "soy", name: "Soy", hint: "Tofu or soy yoghurt" },
  { key: "sesame", name: "Sesame", hint: "Tahini or hummus" },
  { key: "treenuts", name: "Tree nuts", hint: "Smooth cashew, almond or hazelnut butter" },
  { key: "fish", name: "Fish", hint: "Well-cooked, boneless fish" },
  { key: "shellfish", name: "Shellfish", hint: "Well-cooked prawns, finely chopped" }
];
const ALLERGEN_TRIES = 3;
let allergensCache = {};

function allergenTries(key) {
  const tries = allergensCache[key]?.tries;
  return Array.from({ length: ALLERGEN_TRIES }, (_, index) => (Array.isArray(tries) ? tries[index] : null) || null);
}

async function fetchAllergens() {
  const response = await apiFetch("/api/allergens");
  if (!response.ok) {
    throw new Error("Failed to fetch allergens");
  }
  allergensCache = Object.fromEntries((await response.json()).map(row => [row.key, row]));
  cacheWrite("allergens", allergensCache);
  return allergensCache;
}

async function saveAllergen(key, tries) {
  const response = await apiFetch(`/api/allergens/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tries })
  });
  if (!response.ok) {
    throw new Error("Failed to save allergen");
  }
}

function formatShortDate(dateText) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" })
    .format(new Date(`${dateText}T00:00:00`));
}

function renderAllergensPage() {
  const list = document.getElementById("allergen-list");
  const progress = document.getElementById("allergen-progress");
  const error = document.getElementById("allergen-error");
  const tick = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5L10 17.5L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function draw() {
    const done = ALLERGENS.filter(item => allergenTries(item.key).every(Boolean)).length;
    progress.innerHTML = `
      <div class="allergen-progress-label"><strong>${done} of ${ALLERGENS.length}</strong> done</div>
      <div class="allergen-bar"><span style="width:${Math.round((done / ALLERGENS.length) * 100)}%"></span></div>`;
    list.innerHTML = ALLERGENS.map(item => {
      const tries = allergenTries(item.key);
      const complete = tries.every(Boolean);
      const dots = tries.map((date, index) => {
        const label = `${item.name} try ${index + 1}${date ? `, ${formatShortDate(date)}` : ""}`;
        return `<button class="allergen-dot${date ? " checked" : ""}" type="button" data-allergen="${item.key}" data-try="${index}"
          aria-pressed="${Boolean(date)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></button>`;
      }).join("");
      return `
        <div class="allergen-row${complete ? " allergen-done" : ""}">
          <span class="allergen-name">${escapeHtml(item.name)}<small class="allergen-hint">${escapeHtml(item.hint)}</small></span>
          <span class="allergen-dots">${dots}</span>
          <span class="allergen-check">${complete ? tick : ""}</span>
        </div>`;
    }).join("");
  }

  list.addEventListener("click", async event => {
    const button = event.target.closest("[data-allergen]");
    if (!button) {
      return;
    }
    const key = button.getAttribute("data-allergen");
    const index = Number(button.getAttribute("data-try"));
    const before = allergenTries(key);
    const tries = [...before];
    if (tries[index]) {
      const name = ALLERGENS.find(item => item.key === key)?.name || "this allergen";
      if (!window.confirm(`Untick try ${index + 1} for ${name}?`)) {
        return;
      }
      tries[index] = null;
    } else {
      tries[index] = formatDateInputValue();
    }
    showError("");
    allergensCache[key] = { ...(allergensCache[key] || { key }), tries };
    draw();
    try {
      await saveAllergen(key, tries);
      cacheWrite("allergens", allergensCache);
    } catch {
      allergensCache[key] = { ...(allergensCache[key] || { key }), tries: before };
      draw();
      showError("Could not save. Check your connection and try again.");
    }
  });

  registerPullToRefresh(async () => {
    await fetchAllergens();
    draw();
  });

  const cached = cacheRead("allergens");
  if (cached && typeof cached === "object") {
    allergensCache = cached;
  }
  draw();
  fetchAllergens().then(draw).catch(() => {
    if (!cached) {
      showError("Could not load allergens.");
    }
  });
}

// Units/wording are needed before anything renders.
if (page !== "login") {
  applyCachedSettings();
}
const renderedUnits = settingsCache.units || "metric";

if (page === "home") {
  renderHome();
}

if (page === "log") {
  renderLog();
}

if (page === "measurements") {
  renderMeasurementsPage();
}

if (page === "settings" || page === "customise") {
  renderSettings();
}

if (page === "allergens") {
  renderAllergensPage();
}

if (page === "food") {
  renderFoodDiary();
}


if (page === "login") {
  renderLogin();
}

if (page === "trends") {
  renderTrends();
}

// ---------------------------------------------------------------------------
// Trends: one bar per day for the last 7 / 14 / 30 / 60 days
// ---------------------------------------------------------------------------
function trendDays(entries, count) {
  const days = [];
  const byKey = new Map();
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const day = {
      key: formatDateInputValue(date), date, isToday: offset === 0, hasData: false,
      milkMl: 0, feeds: 0, sleepMinutes: 0, poos: 0, wees: 0, breastMinutes: 0, pumpedMl: 0, gapMinutes: null, feedTimes: []
    };
    days.push(day);
    byKey.set(day.key, day);
  }
  entries.forEach(entry => {
    const day = byKey.get(localDayKey(entry.timestamp));
    if (!day) {
      return;
    }
    day.hasData = true;
    const kind = entryKind(entry);
    if (kind === "feed") {
      day.feeds += 1;
      day.milkMl += entry.milkMl || 0;
      day.feedTimes.push(new Date(entry.timestamp).getTime());
    } else if (kind === "breast") {
      day.feeds += 1;
      day.breastMinutes += breastTotalSeconds(entry) / 60;
      day.feedTimes.push(new Date(entry.timestamp).getTime());
    } else if (kind === "pumped") {
      day.pumpedMl += entry.milkMl || 0;
    } else if (kind === "nap") {
      day.sleepMinutes += entry.napMinutes || 0;
    } else if (kind === "poo") {
      if (entry.poo === "wee") {
        day.wees += 1;
      } else {
        day.poos += 1;
      }
    }
  });
  days.forEach(day => {
    const times = day.feedTimes.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      const minutes = (times[i] - times[i - 1]) / 60000;
      if (minutes >= 30) {
        gaps.push(minutes);
      }
    }
    day.gapMinutes = gaps.length ? gaps.reduce((sum, v) => sum + v, 0) / gaps.length : null;
  });
  return days;
}

function renderTrends() {
  const box = document.getElementById("trend-charts");
  const error = document.getElementById("trends-error");
  const buttons = [...document.querySelectorAll("[data-range]")];
  let range = 30;
  try {
    range = [7, 14, 30, 60].includes(Number(localStorage.getItem("mlkbar.trendsDays"))) ? Number(localStorage.getItem("mlkbar.trendsDays")) : 30;
  } catch {}
  let entries = [];

  const dayLabel = date => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(date);
  const volume = ml => (isImperial() ? ml / ML_PER_OZ : ml);

  // Complete days from the first logged day on (no today, no empty lead-in days).
  function averageOf(days, value) {
    const first = days.findIndex(day => day.hasData);
    if (first < 0) {
      return null;
    }
    const complete = days.slice(first).filter(day => !day.isToday);
    const values = complete.map(value).filter(v => v !== null);
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  }

  function chart({ title, days, value, format, average, stacked = null, perDay = true }) {
    const totals = days.map(day => (stacked ? stacked.reduce((sum, part) => sum + part.value(day), 0) : value(day) || 0));
    const max = Math.max(...totals, average || 0) || 1;
    const width = days.length * 10;
    const bar = (day, i, height, y, cls, label) =>
      `<rect class="${cls}${day.isToday ? " trend-today" : ""}" x="${i * 10 + 1.5}" y="${y}" width="7" height="${Math.max(height, 0)}"><title>${escapeHtml(label)}</title></rect>`;
    const bars = days.map((day, i) => {
      const when = day.isToday ? "Today" : formatDay(day.date.toISOString()).replace(/ \d{4}$/, "");
      if (stacked) {
        let y = 100;
        return stacked.map(part => {
          const h = (part.value(day) / max) * 85;
          y -= h;
          return bar(day, i, h, y, part.cls, `${when}: ${part.value(day)} ${part.label}`);
        }).join("");
      }
      const v = value(day);
      if (v === null) {
        return "";
      }
      const h = (v / max) * 85;
      return bar(day, i, h, 100 - h, "trend-bar", `${when}: ${format(v)}`);
    }).join("");
    const avgY = average === null ? null : 100 - (average / max) * 85;
    const mid = days[Math.floor((days.length - 1) / 2)];
    const legend = stacked
      ? `<div class="trend-legend">${stacked.map(part => `<span><i class="${part.cls}"></i>${escapeHtml(part.label)}</span>`).join("")}</div>`
      : "";
    return `
      <section class="panel trend-card">
        <div class="trend-head">
          <h3>${escapeHtml(title)}</h3>
          <span class="trend-avg">${average === null ? "No data yet" : `Avg ${escapeHtml(format(average))}${perDay ? " a day" : ""}`}</span>
        </div>
        ${legend}
        <div class="trend-plot">
          <span class="trend-max">${escapeHtml(format(max))}</span>
          <svg viewBox="0 0 ${width} 100" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)} per day">
            ${bars}
            ${avgY === null ? "" : `<line class="trend-avg-line" x1="0" x2="${width}" y1="${avgY}" y2="${avgY}" vector-effect="non-scaling-stroke"></line>`}
          </svg>
        </div>
        <div class="trend-axis"><span>${dayLabel(days[0].date)}</span><span>${dayLabel(mid.date)}</span><span>Today</span></div>
      </section>`;
  }

  function draw() {
    buttons.forEach(button => button.classList.toggle("active", Number(button.dataset.range) === range));
    const days = trendDays(entries, range);
    const hours = minutes => formatDuration(Math.round(minutes * 60));
    const milk = day => volume(day.milkMl);
    const pumped = day => volume(day.pumpedMl);
    const volumeText = v => formatVolume(isImperial() ? v * ML_PER_OZ : v);
    const charts = [
      { title: "Milk", value: milk, format: volumeText },
      { title: "Feeds", value: day => day.feeds, format: v => (Number.isInteger(v) ? String(v) : v.toFixed(1)) },
      { title: "Sleep", value: day => day.sleepMinutes, format: hours },
      {
        title: term("Nappies"), value: day => day.poos + day.wees, format: v => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
        stacked: [
          { label: term("wee") + "s", cls: "trend-bar-soft", value: day => day.wees },
          { label: term("poo") + "s", cls: "trend-bar", value: day => day.poos }
        ]
      },
      { title: "Breastfeeding", value: day => day.breastMinutes, format: hours },
      { title: "Pumped", value: pumped, format: volumeText },
      { title: "Time between feeds", value: day => day.gapMinutes, format: hours, perDay: false }
    ];
    box.innerHTML = charts.map(item => chart({ ...item, days, average: averageOf(days, item.value) }))
      .join("");
  }

  buttons.forEach(button => button.addEventListener("click", () => {
    range = Number(button.dataset.range);
    try {
      localStorage.setItem("mlkbar.trendsDays", String(range));
    } catch {}
    draw();
  }));

  async function load() {
    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 59);
      const response = await apiFetch(`/api/entries?from=${encodeURIComponent(from.toISOString())}`);
      if (!response.ok) {
        throw new Error("Failed");
      }
      entries = await response.json();
      error.hidden = true;
      draw();
    } catch {
      error.textContent = "Could not load trends.";
      error.hidden = false;
    }
  }

  draw();
  load();
  registerPullToRefresh(load);
}

// Child's name (Child Details page) replaces "mlkbar" next to the logo, a little smaller.
function applyBrandName() {
  const name = (cacheRead("settings") || settingsCache || {}).babyName;
  document.querySelectorAll(".brand-name").forEach(element => {
    element.textContent = name || "mlkbar";
    element.classList.toggle("brand-name-child", Boolean(name));
  });
}

if (page !== "login") {
  applyBrandName();
  fetchSettings().then(() => {
    applyBrandName();
    // Changed on another device: redraw everything in the new units.
    if ((settingsCache.units || "metric") !== renderedUnits) {
      window.location.reload();
    }
  }).catch(() => null);
}

clearLegacyServiceWorkers();

// Burger menu (top right on every page).
(function setupMenu() {
  const button = document.getElementById("menu-button");
  const menu = document.getElementById("site-menu");
  if (!button || !menu) return;
  // The header is transformed by pull-to-refresh, which would trap a position:fixed
  // child inside it; move the full-screen menu to the body.
  document.body.appendChild(menu);
  const setOpen = open => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("menu-open", open);
    if (open) {
      menu.querySelector("[data-menu-close]")?.focus();
    }
  };
  menu.addEventListener("click", event => {
    if (event.target.closest("[data-menu-close]") || event.target === menu) {
      setOpen(false);
      button.focus();
    }
  });
  button.addEventListener("click", event => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener("click", event => {
    if (!menu.hidden && !menu.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
})();
