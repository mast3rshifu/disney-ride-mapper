// Ride Mapper: live waits from ThemeParks.wiki, ranked by walk + wait for your family.
(function () {
  "use strict";
  const { LANDS, ESPLANADE, RIDES, RESTAURANTS, SHOW_KEYWORDS } = window.DRM_DATA;
  const C = window.DRM_CRITTERS;
  const API = "https://api.themeparks.wiki/v1";
  const TZ = "America/Los_Angeles";
  const REFRESH_MS = 5 * 60 * 1000;
  const WALK_M_PER_MIN = 65;   // a relaxed pace with a 4 and 6 year old
  const PATH_FACTOR = 1.35;    // park paths are not straight lines
  const PARK_NAMES = { DL: "Disneyland", DCA: "California Adventure", BOTH: "Both parks" };

  // Normalized-name fragments used to match our rides to the live feed.
  const MATCH = {
    rise: "riseoftheresistance", smugglers: "smugglersrun", space: "spacemountain", indy: "indianajones",
    matterhorn: "matterhorn", thunder: "bigthunder", tiana: "tiana", pirates: "piratesofthecaribbean",
    mansion: "hauntedmansion", jungle: "junglecruise", pooh: "winniethepooh", railroad: "disneylandrailroad",
    twain: "marktwain", peterpan: "peterpan", alice: "aliceinwonderland", toad: "mrtoad", snowwhite: "snowwhite",
    pinocchio: "pinocchio", dumbo: "dumbo", carrousel: "kingarthur", teacups: "madteaparty", casey: "caseyjr",
    storybook: "storybookland", smallworld: "smallworld", runaway: "runawayrailway", rogerrabbit: "rogerrabbit",
    gadget: "gadgetcoaster", buzz: "buzzlightyear", startours: "startours", autopia: "autopia", nemo: "findingnemo",
    astro: "astroorbitor", guardians: "missionbreakout", webslingers: "webslingers", racers: "radiatorspringsracers",
    luigi: "luigis", mater: "matersjunkyard", incredi: "incredicoaster", toystory: "toystorymidway",
    insideout: "insideout", jessie: "jessiescritter", palaround: "palaround", swings: "sillysymphony",
    zephyr: "goldenzephyr", jellyfish: "jumpinjellyfish", goofy: "skyschool", mermaid: "littlemermaid",
    grizzly: "grizzlyriver", soarin: "soarin", monsters: "monstersinc",
  };

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("drm." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("drm." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const todayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

  const state = {
    park: store.get("park", "DL"),
    ll: store.get("ll", false),
    skipScary: store.get("skipScary", false),
    kids: store.get("kids", [{ name: "4-year-old", h: 40 }, { name: "6-year-old", h: 45 }]),
    trip: store.get("trip", {}),
    alertsOn: store.get("alertsOn", false),
    day: store.get("day", { date: todayKey(), ridden: [], skipped: [], notified: {}, bookings: [] }),
    pos: null,
    live: {},        // rideId -> { status, wait, ll }
    shows: [],       // { name, start, end, park }
    schedule: {},    // "DL" -> [{date, type, openingTime, closingTime}]
    parkIds: {},     // "DL" -> uuid
    sample: false,
    updatedAt: null,
    tab: "now",
    calMonth: null,
  };
  if (state.day.date !== todayKey()) state.day = { date: todayKey(), ridden: [], skipped: [], notified: {}, bookings: [] };
  const today = state.trip[todayKey()];
  if (today) state.park = today;
  const saveDay = () => store.set("day", state.day);

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  // "2026-11-03" + "15:30" in Disneyland time -> ISO string, whatever the phone's time zone.
  function pacificISO(d, hm) {
    const guess = new Date(`${d}T${hm}:00Z`);
    const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
      .formatToParts(guess).find((p) => p.type === "timeZoneName").value;
    const hours = Number(off.replace("GMT", "") || 0);
    return new Date(guess.getTime() - hours * 3600000).toISOString();
  }
  const rideById = Object.fromEntries(RIDES.map((r) => [r.id, r]));

  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function nearestPark(pos) {
    let best = null, bestD = Infinity;
    for (const k in LANDS) { const d = haversine(pos, LANDS[k]); if (d < bestD) { bestD = d; best = LANDS[k].park; } }
    return bestD < 1200 ? best : null;
  }
  function walkMinutes(target) {
    if (!state.pos) return null;
    const here = nearestPark(state.pos);
    const spot = LANDS[target.land];
    if (!here) return null; // not at the resort
    let m = haversine(state.pos, spot);
    if (here !== spot.park) m = haversine(state.pos, ESPLANADE) + haversine(ESPLANADE, spot) + 5 * WALK_M_PER_MIN / PATH_FACTOR;
    return Math.max(1, Math.round((m * PATH_FACTOR) / WALK_M_PER_MIN));
  }
  function kidsWhoFit(r) { return state.kids.filter((k) => !r.heightIn || Number(k.h) >= r.heightIn); }
  function inParks(r) { return state.park === "BOTH" || r.park === state.park; }

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------- live data ----------
  async function getJSON(path) {
    const res = await fetch(API + path, { cache: "no-store" });
    if (!res.ok) throw new Error(path + " " + res.status);
    return res.json();
  }
  async function resolveParks() {
    const cached = store.get("parkIds", null);
    if (cached && cached.DL && cached.DCA) { state.parkIds = cached; return; }
    const { destinations } = await getJSON("/destinations");
    const dest = destinations.find((d) => /disneyland resort/i.test(d.name)) || destinations.find((d) => /disneyland/i.test(d.slug || ""));
    if (!dest) throw new Error("Disneyland Resort not found");
    for (const p of dest.parks) {
      if (/california/i.test(p.name)) state.parkIds.DCA = p.id;
      else if (/disneyland/i.test(p.name)) state.parkIds.DL = p.id;
    }
    store.set("parkIds", state.parkIds);
  }
  function matchRide(entity, parkCode) {
    const n = norm(entity.name);
    return RIDES.find((r) => r.park === parkCode && n.includes(MATCH[r.id]));
  }
  async function loadLive() {
    try {
      await resolveParks();
      const live = {}, shows = [];
      for (const code of ["DL", "DCA"]) {
        const data = await getJSON(`/entity/${state.parkIds[code]}/live`);
        for (const e of data.liveData || []) {
          if (e.entityType === "ATTRACTION") {
            const r = matchRide(e, code);
            if (!r || live[r.id]) continue;
            const q = e.queue || {};
            live[r.id] = {
              entityId: e.id,
              status: e.status || "OPERATING",
              wait: q.STANDBY && typeof q.STANDBY.waitTime === "number" ? q.STANDBY.waitTime : null,
              ll: q.PAID_RETURN_TIME || q.RETURN_TIME || null,
              llPaid: !!q.PAID_RETURN_TIME,
            };
          } else if (e.entityType === "SHOW" && Array.isArray(e.showtimes)) {
            const n = e.name.toLowerCase();
            if (!SHOW_KEYWORDS.some((k) => n.includes(k))) continue;
            for (const s of e.showtimes) if (s.startTime) shows.push({ name: e.name, start: s.startTime, end: s.endTime, park: code });
          }
        }
      }
      if (!Object.keys(live).length) throw new Error("empty feed");
      state.live = live; state.shows = shows.sort((a, b) => a.start.localeCompare(b.start));
      state.sample = false;
    } catch (err) {
      console.warn("Live feed unavailable, using sample waits", err);
      state.live = sampleLive(); state.shows = sampleShows(); state.sample = true;
    }
    state.updatedAt = new Date();
    render();
    checkAlerts();
  }
  async function loadSchedules() {
    try {
      await resolveParks();
      for (const code of ["DL", "DCA"]) {
        const data = await getJSON(`/entity/${state.parkIds[code]}/schedule`);
        state.schedule[code] = data.schedule || [];
      }
      store.set("schedule", state.schedule);
    } catch (e) {
      state.schedule = store.get("schedule", {});
    }
    renderPlan();
  }

  // Sample numbers when the feed can't be reached: typical wait shaped by time of day.
  function sampleLive() {
    const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ }));
    const curve = h < 9 ? 0.4 : h < 11 ? 0.8 : h < 16 ? 1.1 : h < 19 ? 0.9 : 0.6;
    const out = {};
    RIDES.forEach((r, i) => {
      const jitter = 0.6 + ((i * 37) % 9) / 10;
      out[r.id] = { status: "OPERATING", wait: Math.max(5, Math.round((r.typical * curve * jitter) / 5) * 5), ll: null };
    });
    return out;
  }
  function sampleShows() {
    const d = todayKey();
    const at = (hm) => pacificISO(d, hm);
    return [
      { name: "Parade (sample time)", start: at("15:30"), park: "DL" },
      { name: "Fireworks (sample time)", start: at("21:30"), park: "DL" },
      { name: "World of Color (sample time)", start: at("21:00"), park: "DCA" },
    ];
  }

  // ---------- ranking ----------
  function rideInfo(r) {
    const l = state.live[r.id] || {};
    const fit = kidsWhoFit(r);
    const walk = walkMinutes(r);
    const wait = l.wait;
    const open = !l.status || l.status === "OPERATING";
    const deal = wait != null ? Math.max(0, r.typical - wait) * (r.headliner ? 0.5 : 0.25) : 0;
    const total = wait != null ? wait + (walk || 0) : null;
    return { r, l, fit, walk, wait, open, total, score: total == null ? Infinity : total - deal };
  }
  function candidates() {
    return RIDES.filter(inParks).map(rideInfo).filter((x) =>
      x.open && x.wait != null && x.fit.length &&
      !(state.skipScary && x.r.scare === 2) &&
      !state.day.skipped.includes(x.r.id) && !state.day.ridden.includes(x.r.id));
  }

  // ---------- alerts ----------
  async function notify(key, title, body) {
    if (state.day.notified[key] && Date.now() - state.day.notified[key] < 60 * 60 * 1000) return;
    state.day.notified[key] = Date.now(); saveDay();
    toast(title);
    if (!state.alertsOn || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(title, { body, icon: "icon-180.png", tag: key });
      else new Notification(title, { body });
    } catch (e) { /* notifications are optional */ }
  }
  function alertItems() {
    const items = [];
    const now = Date.now();
    for (const x of candidates()) {
      if (!x.r.headliner) continue;
      if (x.wait <= Math.max(10, Math.round(x.r.typical * 0.6))) {
        items.push({ key: "low-" + x.r.id, kind: "ride", rideId: x.r.id,
          text: `${x.r.name} is only ${x.wait} min (usually about ${x.r.typical})${x.walk != null ? `, ${x.walk} min walk` : ""}.` });
      }
    }
    for (const s of state.shows) {
      if (!(state.park === "BOTH" || s.park === state.park)) continue;
      const mins = Math.round((new Date(s.start) - now) / 60000);
      if (mins >= 0 && mins <= 20) items.push({ key: "show-" + s.name + s.start, kind: "show", text: `${s.name} starts at ${fmtTime(s.start)} (in ${mins} min).` });
    }
    for (const b of state.day.bookings) {
      const mins = Math.round((new Date(b.at) - now) / 60000);
      if (mins >= -5 && mins <= 5) items.push({ key: "ll-" + b.rideId + b.at, kind: "show", text: `Lightning Lane return for ${rideById[b.rideId].name} is open now.` });
    }
    return items;
  }
  function checkAlerts() { for (const a of alertItems()) notify(a.key, a.text, "Ride Mapper"); }

  // ---------- rendering ----------
  function factsPills(x) {
    const p = [];
    const r = x.r;
    if (state.park === "BOTH") p.push(`<span class="pill">${r.park === "DL" ? "Disneyland" : "DCA"}</span>`);
    p.push(`<span class="pill">${esc(LANDS[r.land].name)}</span>`);
    if (r.heightIn) {
      if (x.fit.length === state.kids.length) p.push(`<span class="pill good">${r.heightIn} in, everyone rides</span>`);
      else if (x.fit.length) p.push(`<span class="pill warn">${r.heightIn} in, only ${esc(x.fit.map((k) => k.name).join(", "))} · Rider Switch</span>`);
      else p.push(`<span class="pill bad">${r.heightIn} in, too short</span>`);
    }
    if (r.scare === 2) p.push(`<span class="pill bad">Scary/intense</span>`);
    else if (r.scare === 1) p.push(`<span class="pill warn">A bit dark or loud</span>`);
    if (r.kidFave) p.push(`<span class="pill gold">Kid favorite</span>`);
    if (x.wait != null && x.wait <= Math.round(r.typical * 0.6) && r.headliner) p.push(`<span class="pill good">Shorter than usual</span>`);
    return p.join("");
  }

  function renderHeader() {
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.park === state.park)));
    $("#llToggle").checked = state.ll;
    $("#scaryToggle").checked = state.skipScary;
    $("#alertToggle").checked = state.alertsOn;
    $("#locBtn").setAttribute("aria-pressed", String(!!state.pos));
    $("#locBtn").textContent = state.pos ? "Location on" : "Use my location";
    $("#updated").textContent = state.updatedAt ? "Updated " + state.updatedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "Loading waits…";
    const ban = $("#banner");
    ban.hidden = !state.sample;
    ban.textContent = "Live wait times couldn't load, so these are sample numbers. Pull to refresh or try again in a minute.";
  }

  function renderNow() {
    const list = candidates().sort((a, b) => a.score - b.score);
    const here = state.pos ? nearestPark(state.pos) : null;
    $("#nowHint").textContent = !state.pos
      ? "Turn on your location to rank rides by distance. For now, rides are sorted by wait."
      : !here ? "You're not at the parks yet, so rides are sorted by wait. Walk times appear once you're inside."
      : `Ranked by walk time plus wait from where you're standing in ${PARK_NAMES[here]}.`;
    $("#nextList").innerHTML = list.slice(0, 6).map((x, i) => `
      <li class="card" data-ride="${x.r.id}" tabindex="0">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(x.r.name)}</span>
        <span class="total"><b>${x.total}</b><span>min total</span></span>
        <span class="meta"><span class="pill">${x.wait} min wait</span>${x.walk != null ? `<span class="pill">${x.walk} min walk</span>` : ""}${factsPills(x)}</span>
      </li>`).join("") || `<li class="muted">Nothing left that fits. Try the other park or turn off "Skip scary rides".</li>`;

    $("#alerts").innerHTML = alertItems().map((a) =>
      `<div class="alert ${a.kind === "show" ? "show" : ""}" ${a.rideId ? `data-ride="${a.rideId}"` : ""}>${C.svg(a.rideId ? C.forRide(a.rideId) : 6, { size: 34 })}<span>${esc(a.text)}</span></div>`).join("");

    // Lightning Lane
    $("#llBox").hidden = !state.ll;
    if (state.ll) {
      const ll = RIDES.filter(inParks).map(rideInfo)
        .filter((x) => x.open && x.fit.length && x.r.headliner && x.wait != null && !state.day.ridden.includes(x.r.id) && !(state.skipScary && x.r.scare === 2))
        .sort((a, b) => b.wait - a.wait).slice(0, 4);
      $("#llList").innerHTML = ll.map((x) => {
        const q = x.l.ll;
        let ret = "Check return time in the Disneyland app";
        if (q && q.state === "AVAILABLE" && q.returnStart) ret = `Return ${fmtTime(q.returnStart)}`;
        else if (q && q.state && q.state !== "AVAILABLE") ret = "Sold out for today";
        const price = q && q.price && q.price.amount ? ` · $${(q.price.amount / 100).toFixed(0)}` : "";
        return `<li class="card" data-ride="${x.r.id}" tabindex="0"><span class="name">${esc(x.r.name)}</span>
          <span class="total"><b>${x.wait}</b><span>min saved</span></span>
          <span class="meta" style="grid-column:1/3">${esc(ret + price)}</span></li>`;
      }).join("");
      const opts = RIDES.filter(inParks).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
      $("#llBookings").innerHTML = `
        <h2 class="sec">My return times</h2>
        <ul class="plain">${state.day.bookings.map((b, i) => `<li><span>${esc(rideById[b.rideId].name)}</span><span class="when">${fmtTime(b.at)} <button class="chip" data-unbook="${i}" type="button">Remove</button></span></li>`).join("") || `<li class="muted">Add your Lightning Lane return times to get a reminder.</li>`}</ul>
        <div class="filters wrap"><select id="bookRide" aria-label="Ride">${opts}</select><input id="bookTime" type="time" aria-label="Return time"><button class="chip primary" id="bookAdd" type="button">Add</button></div>`;
    }

    // Shows
    const now = Date.now();
    const shows = state.shows.filter((s) => (state.park === "BOTH" || s.park === state.park) && new Date(s.end || s.start).getTime() > now - 10 * 60000);
    $("#showList").innerHTML = shows.map((s) => `<li><span>${esc(s.name)}${state.park === "BOTH" ? ` · ${s.park === "DL" ? "Disneyland" : "DCA"}` : ""}</span><span class="when">${fmtTime(s.start)}</span></li>`).join("")
      || `<li class="muted">No more parades or nighttime shows listed today.</li>`;
    $("#stack").innerHTML = state.day.ridden.length
      ? state.day.ridden.map((id, i) => `<span class="item" title="${esc(rideById[id].name)}">${C.svg(i, { size: 52 })}</span>`).join("")
      : `<div class="empty">${C.svg(0, { size: 52, wink: true })}<span>Every ride you check off adds a plush buddy to your stack.</span></div>`;
    const n = state.day.ridden.length;
    $("#doneLine").textContent = n ? `You've ridden ${n} ride${n === 1 ? "" : "s"} today.` : "";
  }

  function renderRides() {
    const q = norm($("#rideSearch").value || "");
    const sort = $("#rideSort").value;
    let list = RIDES.filter(inParks).map(rideInfo).filter((x) => !q || norm(x.r.name).includes(q));
    const key = { total: (x) => x.score, wait: (x) => x.wait ?? 999, walk: (x) => x.walk ?? 999, name: (x) => x.r.name };
    list.sort((a, b) => { const ka = key[sort](a), kb = key[sort](b); return typeof ka === "string" ? ka.localeCompare(kb) : ka - kb; });
    $("#rideList").innerHTML = list.map((x) => {
      const off = !x.open || !x.fit.length || state.day.skipped.includes(x.r.id) || (state.skipScary && x.r.scare === 2);
      const right = !x.open ? `<span class="wait">–<small>${esc((x.l.status || "").toLowerCase() || "closed")}</small></span>`
        : x.wait == null ? `<span class="wait">–<small>no wait posted</small></span>`
        : `<span class="wait">${x.wait}<small>min${x.walk != null ? ` · ${x.walk} walk` : ""}</small></span>`;
      const tags = [state.day.ridden.includes(x.r.id) ? `<span class="pill good">Rode it</span>` : "", state.day.skipped.includes(x.r.id) ? `<span class="pill">Skipped</span>` : ""].join("");
      return `<li class="row ${off ? "off" : ""}" data-ride="${x.r.id}" tabindex="0"><span class="name">${esc(x.r.name)}</span>${right}<span class="sub">${tags}${factsPills(x)}</span></li>`;
    }).join("");
  }

  function renderEat() {
    const list = RESTAURANTS.filter((e) => state.park === "BOTH" || e.park === state.park || e.park === "Hotel").map((e) => {
      const walk = e.land ? walkMinutes({ land: e.land }) : null;
      return { e, walk };
    }).sort((a, b) => (a.walk ?? 99) - (b.walk ?? 99));
    $("#eatList").innerHTML = list.map(({ e, walk }) => `
      <li class="row"><span class="name">${esc(e.name)}</span><span class="wait">${esc(e.price)}<small>${walk != null ? walk + " min walk" : esc(e.type)}</small></span>
      <span class="sub"><span class="pill">${esc(e.land ? LANDS[e.land].name : "Resort hotel")}</span><span class="pill gold">${esc(e.type)}</span></span>
      <span class="sub" style="color:var(--ink)">Kids: ${esc(e.kids)}</span>
      <span class="sub">${esc(e.why)} (via ${esc(e.src)})</span></li>`).join("");
  }

  // ---------- plan tab ----------
  function renderPlan() {
    const base = state.calMonth || new Date(todayKey() + "T12:00:00");
    state.calMonth = new Date(base.getFullYear(), base.getMonth(), 1, 12);
    const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
    $("#calTitle").textContent = state.calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    const tk = todayKey();
    let html = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span class="dow">${d}</span>`).join("");
    for (let i = 0; i < first; i++) html += "<span></span>";
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cls = [key < tk ? "past" : "", key === tk ? "today" : "", state.trip[key] ? "sel" : ""].join(" ");
      html += `<button type="button" class="${cls}" data-date="${key}" ${key < tk ? "disabled" : ""} aria-pressed="${!!state.trip[key]}">${d}</button>`;
    }
    $("#calGrid").innerHTML = html;

    const keys = Object.keys(state.trip).sort();
    $("#tripList").innerHTML = keys.map((k) => {
      const label = new Date(k + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const hours = ["DL", "DCA"].filter((c) => state.trip[k] === "BOTH" || state.trip[k] === c).map((c) => {
        const s = (state.schedule[c] || []).find((x) => x.date === k && x.type === "OPERATING");
        return s ? `${c === "DL" ? "DL" : "DCA"} ${fmtTime(s.openingTime)}–${fmtTime(s.closingTime)}` : "";
      }).filter(Boolean).join(" · ");
      return `<li class="trip"><span>${label}<br><span class="muted">${hours || "Hours not posted yet"}</span></span>
        <select data-tripday="${k}" aria-label="Park for ${label}">${["DL", "DCA", "BOTH"].map((p) => `<option value="${p}" ${state.trip[k] === p ? "selected" : ""}>${PARK_NAMES[p]}</option>`).join("")}</select></li>`;
    }).join("") || `<li class="muted">No days picked yet.</li>`;

    $("#kidsBox").innerHTML = state.kids.map((k, i) => `
      <div class="kid"><input id="kidName${i}" data-kid="${i}" data-f="name" value="${esc(k.name)}" aria-label="Name">
      <input id="kidH${i}" data-kid="${i}" data-f="h" type="number" min="20" max="80" value="${esc(k.h)}" aria-label="Height in inches"> <span class="muted">inches</span>
      ${state.kids.length > 1 ? `<button class="chip" type="button" data-rmkid="${i}">Remove</button>` : ""}</div>`).join("");
  }

  // ---------- ride sheet with POV guide ----------
  let povStep = 0;
  function openRide(id) {
    const r = rideById[id]; if (!r) return;
    povStep = 0;
    drawRide(r);
    const dlg = $("#rideDlg");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  const FLAG = { dark: "Dark", drop: "Drop", loud: "Loud", splash: "Get wet", spin: "Spins", fast: "Fast", scary: "Scary moment" };
  function drawRide(r) {
    const x = rideInfo(r);
    const b = r.beats[povStep];
    const ridden = state.day.ridden.includes(r.id), skipped = state.day.skipped.includes(r.id);
    const yt = "https://www.youtube.com/results?search_query=" + encodeURIComponent(r.name + " Disneyland POV ride through");
    $("#rideDlgBody").innerHTML = `
      <h3>${esc(r.name)}</h3>
      <div class="muted">${esc(LANDS[r.land].name)} · about ${r.mins} min ride</div>
      <div class="facts">${x.wait != null ? `<span class="pill">${x.wait} min wait</span>` : ""}${x.walk != null ? `<span class="pill">${x.walk} min walk</span>` : ""}${factsPills(x)}</div>
      <p>${esc(r.desc)}</p>
      <div class="pov" aria-live="polite">
        <div class="step-n">Ride guide · step ${povStep + 1} of ${r.beats.length}</div>
        <div class="dots">${r.beats.map((_, i) => `<i class="${i <= povStep ? "on" : ""}"></i>`).join("")}</div>
        <div class="step-t">${esc(b.t)}</div>
        ${b.f ? `<span class="pill ${b.f === "scary" || b.f === "drop" ? "bad" : "warn"}">${FLAG[b.f]}</span>` : `<span class="pill good">Gentle</span>`}
        <div class="pov-nav" style="margin-top:12px">
          <button type="button" class="chip" id="povPrev" ${povStep === 0 ? "disabled" : ""}>Back</button>
          <a class="chip" href="${yt}" target="_blank" rel="noopener">Watch POV video</a>
          <button type="button" class="chip primary" id="povNext" ${povStep === r.beats.length - 1 ? "disabled" : ""}>Next</button>
        </div>
      </div>
      ${r.heightIn && x.fit.length < state.kids.length ? `<p class="muted">Rider Switch: one grown-up waits with the shorter child while the others ride, then swaps without waiting again. Ask the cast member at the entrance.</p>` : ""}
      <div class="actions">
        <button type="button" class="chip primary" id="walkBtn">Walk there</button>
        <button type="button" class="chip" id="rodeBtn">${ridden ? "Undo rode it" : "We rode it"}</button>
        <button type="button" class="chip" id="skipBtn">${skipped ? "Unskip" : "Skip this ride"}</button>
      </div>`;
    $("#povPrev").onclick = () => { povStep = Math.max(0, povStep - 1); drawRide(r); };
    $("#povNext").onclick = () => { povStep = Math.min(r.beats.length - 1, povStep + 1); drawRide(r); };
    $("#rodeBtn").onclick = () => { toggleIn(state.day.ridden, r.id); saveDay(); render(); drawRide(r); if (!ridden) { $("#rideDlg").close(); celebrate(r); } };
    $("#walkBtn").onclick = () => { $("#rideDlg").close(); startWalk(r); };
    $("#skipBtn").onclick = () => { toggleIn(state.day.skipped, r.id); saveDay(); render(); drawRide(r); };
  }
  // ---------- walk mode ----------
  async function rideLocation(r) {
    const cache = store.get("locs", {});
    if (cache[r.id]) return cache[r.id];
    const id = state.live[r.id] && state.live[r.id].entityId;
    if (!id) return null;
    try {
      const e = await getJSON(`/entity/${id}`);
      const loc = e.location && typeof e.location.latitude === "number" ? { lat: e.location.latitude, lng: e.location.longitude } : null;
      if (loc) { cache[r.id] = loc; store.set("locs", cache); }
      return loc;
    } catch (err) { return null; }
  }
  function startWalk(r) {
    if (!window.DRM_WALK) { toast("Walking map isn't available right now."); return; }
    window.DRM_WALK.open(r, {
      esc,
      getPos: () => state.pos,
      landPoint: (x) => ({ lat: LANDS[x.land].lat, lng: LANDS[x.land].lng }),
      landName: (x) => LANDS[x.land].name,
      rideLocation,
      critter: () => C.svg(C.forRide(r.id), { size: 64, wink: true }),
      arrived: (x) => toast(`You made it to ${x.name}!`),
    });
  }

  function celebrate(r) {
    const pop = $("#pop");
    pop.innerHTML = `<div class="bubble">${C.svg(state.day.ridden.length - 1, { size: 110, wink: true })}+1 for your stack!<div class="muted">${esc(r.name)}</div></div>`;
    pop.hidden = false;
    clearTimeout(celebrate._t); celebrate._t = setTimeout(() => { pop.hidden = true; }, 1600);
  }
  function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  function render() { renderHeader(); renderNow(); renderRides(); renderEat(); }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-park],[data-tab],[data-ride],[data-date],[data-rmkid],[data-unbook],#calPrev,#calNext,#addKid,#bookAdd,#resetToday,#locBtn");
    if (!t) return;
    if (t.dataset.park) { state.park = t.dataset.park; store.set("park", state.park); render(); }
    else if (t.dataset.tab) {
      state.tab = t.dataset.tab;
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b === t));
      document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.id !== "tab-" + state.tab; });
      window.scrollTo(0, 0);
    }
    else if (t.dataset.ride) openRide(t.dataset.ride);
    else if (t.dataset.date) { if (state.trip[t.dataset.date]) delete state.trip[t.dataset.date]; else state.trip[t.dataset.date] = state.park; store.set("trip", state.trip); renderPlan(); }
    else if (t.dataset.rmkid) { state.kids.splice(Number(t.dataset.rmkid), 1); store.set("kids", state.kids); renderPlan(); render(); }
    else if (t.dataset.unbook) { state.day.bookings.splice(Number(t.dataset.unbook), 1); saveDay(); renderNow(); }
    else if (t.id === "calPrev" || t.id === "calNext") { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + (t.id === "calNext" ? 1 : -1), 1, 12); renderPlan(); }
    else if (t.id === "addKid") { state.kids.push({ name: "Kid " + (state.kids.length + 1), h: 42 }); store.set("kids", state.kids); renderPlan(); render(); }
    else if (t.id === "bookAdd") {
      const rid = $("#bookRide").value, hm = $("#bookTime").value;
      if (!hm) { toast("Pick the return time first."); return; }
      state.day.bookings.push({ rideId: rid, at: pacificISO(todayKey(), hm) });
      saveDay(); renderNow(); toast("Return time saved. We'll remind you.");
    }
    else if (t.id === "resetToday") { state.day = { date: todayKey(), ridden: [], skipped: [], notified: {}, bookings: [] }; saveDay(); render(); toast("Today's list is cleared."); }
    else if (t.id === "locBtn") startLocation();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset && e.target.dataset.ride) openRide(e.target.dataset.ride); });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "llToggle") { state.ll = t.checked; store.set("ll", state.ll); renderNow(); }
    else if (t.id === "scaryToggle") { state.skipScary = t.checked; store.set("skipScary", state.skipScary); render(); }
    else if (t.id === "alertToggle") {
      state.alertsOn = t.checked; store.set("alertsOn", state.alertsOn);
      if (t.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
      if (t.checked && !("Notification" in window)) toast("Alerts will show inside the app. Add it to your Home Screen for phone notifications.");
    }
    else if (t.dataset.tripday) { state.trip[t.dataset.tripday] = t.value; store.set("trip", state.trip); }
    else if (t.dataset.kid) {
      const k = state.kids[Number(t.dataset.kid)];
      k[t.dataset.f] = t.dataset.f === "h" ? Number(t.value) : t.value;
      store.set("kids", state.kids); render();
    }
    else if (t.id === "rideSort") renderRides();
  });
  $("#rideSearch").addEventListener("input", renderRides);

  function startLocation() {
    if (!navigator.geolocation) { toast("This phone doesn't share location with websites."); return; }
    navigator.geolocation.watchPosition(
      (p) => { state.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; render(); },
      (err) => toast(err.code === 1 ? "Location is off. Allow it in Settings, then Safari, then Location." : "Couldn't find your location. Try again outside."),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
    store.set("locOn", true);
  }

  // ---------- start ----------
  $("#brandCritter").innerHTML = C.svg(0, { size: 34, wink: true });
  render(); renderPlan();
  loadLive(); loadSchedules();
  if (store.get("locOn", false)) startLocation();
  setInterval(loadLive, REFRESH_MS);
  setInterval(() => { renderNow(); checkAlerts(); }, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!state.updatedAt || Date.now() - state.updatedAt > 2 * 60 * 1000)) loadLive();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
