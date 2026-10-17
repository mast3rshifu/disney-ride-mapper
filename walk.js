// Walk mode: a tilted 3D map that follows your GPS and turns with your compass,
// plus a big arrow pointing to the ride. Map tiles from OpenFreeMap (OpenStreetMap data).
window.DRM_WALK = (function () {
  const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
  const STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const ARRIVE_M = 25;
  const SAT_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

  // ---------- walkway routing over paths.json (OpenStreetMap footpaths) ----------
  const CELL = 0.0005; // about 50 m grid for nearest-path lookups
  let graphPromise = null;
  function loadGraph() {
    if (!graphPromise) graphPromise = fetch("paths.json").then((r) => (r.ok ? r.json() : null)).then((g) => {
      if (!g || !g.nodes) return null;
      const n = g.nodes.length, adj = Array.from({ length: n }, () => []), grid = new Map();
      const pts = g.nodes.map(([lat, lng]) => ({ lat, lng }));
      for (const [a, b] of g.edges) { const d = distance(pts[a], pts[b]); adj[a].push([b, d]); adj[b].push([a, d]); }
      pts.forEach((p, i) => { if (!adj[i].length) return; const k = cellKey(p.lat, p.lng); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
      return { pts, adj, grid };
    }).catch(() => null);
    return graphPromise;
  }
  const cellKey = (lat, lng) => Math.floor(lat / CELL) + ":" + Math.floor(lng / CELL);
  function nearest(g, p) {
    let best = -1, bestD = Infinity;
    const cy = Math.floor(p.lat / CELL), cx = Math.floor(p.lng / CELL);
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        for (const i of g.grid.get(y + ":" + x) || []) { const d = distance(p, g.pts[i]); if (d < bestD) { bestD = d; best = i; } }
      }
    }
    return { i: best, d: bestD };
  }
  function astar(g, src, dst) {
    const n = g.pts.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = [[distance(g.pts[src], g.pts[dst]), src]];
    const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    dist[src] = 0;
    while (heap.length) {
      const [, u] = pop();
      if (u === dst) break;
      for (const [v, w] of g.adj[u]) {
        const nd = dist[u] + w;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd + distance(g.pts[v], g.pts[dst]), v]); }
      }
    }
    if (dist[dst] === Infinity) return null;
    const path = []; for (let u = dst; u !== -1; u = prev[u]) path.push(g.pts[u]);
    return path.reverse();
  }
  function routeAlongPaths(g, from, to) {
    const a = nearest(g, from), b = nearest(g, to);
    if (a.i < 0 || b.i < 0 || a.d > 80 || b.d > 150) return null;
    const mid = a.i === b.i ? [g.pts[a.i]] : astar(g, a.i, b.i);
    if (!mid) return null;
    const coords = [from, ...mid, to];
    let length = 0; for (let i = 1; i < coords.length; i++) length += distance(coords[i - 1], coords[i]);
    return { coords, length };
  }
  // A point a little way along the route, for the arrow to aim at.
  function lookahead(coords, meters) {
    let left = meters;
    for (let i = 1; i < coords.length; i++) {
      const d = distance(coords[i - 1], coords[i]);
      if (d >= left) { const t = left / d; return { lat: coords[i - 1].lat + (coords[i].lat - coords[i - 1].lat) * t, lng: coords[i - 1].lng + (coords[i].lng - coords[i - 1].lng) * t }; }
      left -= d;
    }
    return coords[coords.length - 1];
  }
  // The next real turn along the route: "In 120 ft, turn left".
  function nextTurn(coords) {
    let along = 0;
    for (let i = 1; i < coords.length - 1; i++) {
      along += distance(coords[i - 1], coords[i]);
      if (distance(coords[i], coords[i + 1]) < 4) continue;
      const turn = rel(bearing(coords[i], coords[i + 1]) - bearing(coords[i - 1], coords[i]));
      if (Math.abs(turn) > 35 && along > 6) return { along, turn };
    }
    return null;
  }

  let libPromise = null;
  function loadLib() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = MAPLIBRE + ".css";
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = MAPLIBRE + ".js"; s.async = true;
      s.onload = () => resolve(window.maplibregl);
      s.onerror = () => { libPromise = null; reject(new Error("map library failed")); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  const toR = Math.PI / 180;
  function distance(a, b) {
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(x));
  }
  function bearing(a, b) {
    const y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
    const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }
  const rel = (deg) => ((deg % 360) + 540) % 360 - 180; // -180..180
  function turnWords(r) {
    const a = Math.abs(r);
    if (a < 20) return "Straight ahead";
    if (a > 150) return "Turn around";
    if (a < 60) return r < 0 ? "Bear left" : "Bear right";
    return r < 0 ? "Turn left" : "Turn right";
  }

  // ---------- Google photorealistic 3D (Maps JavaScript API, maps3d library) ----------
  let googlePromise = null;
  function loadGoogle(key) {
    if (window.google && google.maps && google.maps.importLibrary) return google.maps.importLibrary("maps3d");
    if (googlePromise) return googlePromise;
    googlePromise = new Promise((resolve, reject) => {
      window.__drmGoogleReady = () => google.maps.importLibrary("maps3d").then(resolve, reject);
      window.gm_authFailure = () => { googlePromise = null; reject(new Error("Google key refused")); if (s && s.g3d) fallbackFrom3D(); };
      const sc = document.createElement("script");
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=beta&libraries=maps3d&callback=__drmGoogleReady`;
      sc.async = true;
      sc.onerror = () => { googlePromise = null; reject(new Error("Google failed to load")); };
      document.head.appendChild(sc);
    });
    return googlePromise;
  }
  function build3D(lib) {
    if (!s) return;
    const start = s.pos || s.target;
    const host = s.root.querySelector("#walkMap");
    const opts = { center: { lat: start.lat, lng: start.lng, altitude: 0 }, range: 180, tilt: 67, heading: s.heading || 0, defaultUIHidden: true };
    if (lib.MapMode) opts.mode = lib.MapMode.HYBRID || lib.MapMode.SATELLITE;
    const map = new lib.Map3DElement(opts);
    map.style.width = "100%"; map.style.height = "100%";
    host.appendChild(map);
    const line = new lib.Polyline3DElement({ strokeColor: "#e5a12ee6", outerColor: "#ffffff", outerWidth: 0.3, strokeWidth: 12, altitudeMode: "CLAMP_TO_GROUND", drawsOccludedSegments: true });
    map.append(line);
    const mk = new lib.Marker3DElement({ position: { lat: s.target.lat, lng: s.target.lng }, label: s.ride.name });
    map.append(mk);
    s.g3d = { map, line, mk, lastCam: 0 };
    s.root.querySelector("#walkSat").hidden = true;
    const stopFollow = () => { if (!s) return; s.follow = false; s.root.querySelector("#walkRecenter").hidden = false; };
    map.addEventListener("pointerdown", stopFollow);
    update();
  }
  function fallbackFrom3D() {
    if (!s || !s.g3d) return;
    s.g3d.map.remove(); s.g3d = null;
    s.root.querySelector("#walkSat").hidden = false;
    s.root.querySelector("#walkNote").textContent = "The 3D park view couldn't load, so this is the regular map.";
    startFlatMap();
  }
  function startFlatMap() {
    loadLib().then((lib) => buildMap(lib)).catch(() => {
      s.root.querySelector("#walkMap").classList.add("nomap");
      s.root.querySelector("#walkMap").innerHTML = `<div class="nomap-msg">The 3D map couldn't load (weak signal?). The arrow still works.</div>`;
    });
  }

  let s = null; // the active walk session

  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  function open(ride, ctx) {
    close();
    const root = el(`
      <div class="walk" role="dialog" aria-label="Walk to ${ctx.esc(ride.name)}">
        <div id="walkMap" class="walk-map"></div>
        <div class="walk-top">
          <button type="button" class="chip" id="walkClose">Done</button>
          <div class="walk-title"><strong>${ctx.esc(ride.name)}</strong><span id="walkDist" class="muted">Finding you…</span></div>
        </div>
        <div class="walk-bottom">
          <div class="walk-arrow" id="walkArrow" aria-hidden="true">
            <svg viewBox="0 0 100 100"><path d="M50 6 L84 80 L50 64 L16 80 Z"/></svg>
          </div>
          <div class="walk-say" id="walkSay">Hold your phone flat and face forward.</div>
          <div class="walk-next muted" id="walkNext"></div>
          <div class="walk-btns">
            <button type="button" class="chip" id="walkSat" aria-pressed="true">Satellite</button>
            <button type="button" class="chip primary" id="walkCompass">Turn on compass</button>
            <button type="button" class="chip" id="walkRecenter" hidden>Follow me</button>
          </div>
          <div class="muted walk-note" id="walkNote"></div>
        </div>
      </div>`);
    document.body.appendChild(root);
    s = { ride, ctx, root, sat: true, route: null, routedAt: 0, pos: ctx.getPos(), heading: null, follow: true, map: null, target: null, arrived: false, watch: null, onOrient: null };

    root.querySelector("#walkClose").onclick = close;
    root.querySelector("#walkCompass").onclick = startCompass;
    root.querySelector("#walkSat").onclick = () => setSatellite(!s.sat);
    root.querySelector("#walkRecenter").onclick = () => { s.follow = true; root.querySelector("#walkRecenter").hidden = true; update(); };

    // Exact ride location from the live feed when we can get it; land center otherwise.
    s.target = ctx.landPoint(ride);
    ctx.rideLocation(ride).then((p) => {
      if (!s || s.ride !== ride) return;
      if (p) { s.target = p; root.querySelector("#walkNote").textContent = ""; }
      else root.querySelector("#walkNote").textContent = `Pointing to the middle of ${ctx.landName(ride)}. Follow the ride signs for the last bit.`;
      update();
    });

    loadGraph().then(() => update());

    if (navigator.geolocation) {
      s.watch = navigator.geolocation.watchPosition((p) => {
        if (!s) return;
        s.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        // Use the direction you're walking when there's no compass yet.
        if (s.heading == null && typeof p.coords.heading === "number" && !isNaN(p.coords.heading) && p.coords.speed > 0.5) s.gpsHeading = p.coords.heading;
        update();
      }, () => say("Location is off. Allow location for this site to use walking directions."), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    }

    // Android Chrome gives compass without asking.
    if (typeof DeviceOrientationEvent === "undefined" || typeof DeviceOrientationEvent.requestPermission !== "function") startCompass();

    const key = ctx.googleKey && ctx.googleKey();
    if (key) loadGoogle(key).then(build3D).catch(() => { if (s && !s.g3d && !s.map) startFlatMap(); });
    else startFlatMap();
    update();
  }

  function buildMap(lib) {
    if (!s) return;
    const start = s.pos || s.target;
    const map = new lib.Map({
      container: s.root.querySelector("#walkMap"), style: STYLE,
      center: [start.lng, start.lat], zoom: 18, pitch: 62, bearing: s.heading || 0,
      maxPitch: 75, attributionControl: { compact: true },
    });
    s.map = map;
    const stopFollow = () => { if (!s) return; s.follow = false; s.root.querySelector("#walkRecenter").hidden = false; };
    map.on("dragstart", stopFollow);
    map.on("rotatestart", (e) => { if (e.originalEvent) stopFollow(); });

    map.on("load", () => {
      if (!s || s.map !== map) return;
      // Make buildings stand up even if the style hides them at this zoom.
      const hasBuildings = map.getStyle().layers.some((l) => l.type === "fill-extrusion");
      if (!hasBuildings && map.getSource("openmaptiles")) {
        map.addLayer({ id: "drm-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 15,
          paint: { "fill-extrusion-color": "#d9cfe8", "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8], "fill-extrusion-opacity": 0.85 } });
      }
      // Real overhead photo of the park, under the 3D buildings and labels.
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol" || l.type === "fill-extrusion");
      map.addSource("drm-sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
      map.addLayer({ id: "drm-sat", type: "raster", source: "drm-sat", layout: { visibility: s.sat ? "visible" : "none" } }, firstSymbol && firstSymbol.id);
      setSatellite(s.sat);
      map.addSource("drm-route", { type: "geojson", data: routeGeo() });
      map.addLayer({ id: "drm-route", type: "line", source: "drm-route",
        layout: { "line-cap": "round" }, paint: { "line-color": "#e5a12e", "line-width": 7, "line-dasharray": [1.2, 1.4] } });
      update();
    });

    const tgt = document.createElement("div");
    tgt.className = "walk-target"; tgt.innerHTML = s.ctx.critter();
    s.targetMarker = new lib.Marker({ element: tgt, anchor: "bottom" }).setLngLat([s.target.lng, s.target.lat]).addTo(map);
    const me = document.createElement("div"); me.className = "walk-me";
    s.meMarker = new lib.Marker({ element: me, rotationAlignment: "map" });
  }

  function setSatellite(on) {
    if (!s) return;
    s.sat = on;
    const btn = s.root.querySelector("#walkSat");
    btn.setAttribute("aria-pressed", String(on)); btn.textContent = on ? "Satellite" : "Map";
    const m = s.map;
    if (!m || !m.getLayer || !m.getLayer("drm-sat")) return;
    m.setLayoutProperty("drm-sat", "visibility", on ? "visible" : "none");
    for (const l of m.getStyle().layers) if (l.type === "fill-extrusion") m.setPaintProperty(l.id, "fill-extrusion-opacity", on ? 0.55 : 0.85);
  }

  function routeGeo() {
    const line = s.route ? s.route.coords : s.pos ? [s.pos, s.target] : [];
    const coords = line.map((p) => [p.lng, p.lat]);
    return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
  }

  function say(t) { if (s) s.root.querySelector("#walkSay").textContent = t; }

  function update() {
    if (!s) return;
    const head = s.heading != null ? s.heading : s.gpsHeading != null ? s.gpsHeading : null;
    const arrow = s.root.querySelector("#walkArrow");
    if (!s.pos) { s.root.querySelector("#walkDist").textContent = "Finding you…"; return; }
    // Re-plan along the walkways every few seconds as you move.
    graphPromise && graphPromise.then((g) => {
      if (!g || !s || performance.now() - s.routedAt < 3000) return;
      s.routedAt = performance.now();
      s.route = routeAlongPaths(g, s.pos, s.target);
      update();
    });
    const straight = distance(s.pos, s.target);
    const onRoute = s.route && straight >= ARRIVE_M;
    const d = onRoute ? s.route.length : straight;
    const b = bearing(s.pos, onRoute ? lookahead(s.route.coords, 15) : s.target);
    const turn = onRoute ? nextTurn(s.route.coords) : null;
    s.root.querySelector("#walkNext").textContent = turn
      ? `In ${Math.max(10, Math.round((turn.along * 3.281) / 10) * 10)} ft, ${turnWords(turn.turn).toLowerCase()}`
      : onRoute ? "Follow the path to the ride" : "";
    const mins = Math.max(1, Math.round((d * (onRoute ? 1 : 1.35)) / 65));
    const feet = Math.round(d * 3.281);
    s.root.querySelector("#walkDist").textContent = d < 1600
      ? `${feet > 900 ? (feet / 5280).toFixed(1) + " mi" : feet + " ft"} · about ${mins} min walk`
      : "You're not at the parks yet";
    if (straight < 1600 && !onRoute && straight >= ARRIVE_M) s.root.querySelector("#walkNext").textContent = "Walkway map unavailable, pointing straight at the ride";

    if (d < ARRIVE_M) {
      arrow.classList.add("here");
      say("You made it! Look for the ride entrance.");
      if (!s.arrived) { s.arrived = true; s.ctx.arrived(s.ride); }
    } else {
      arrow.classList.remove("here");
      if (head == null) { arrow.style.transform = `rotate(${b}deg)`; say(`Head ${compassWord(b)}. Turn on the compass for turn-by-turn arrows.`); }
      else { const r = rel(b - head); arrow.style.transform = `rotate(${r}deg)`; say(turnWords(r)); }
    }
    if (s.pos.acc > 40) s.root.querySelector("#walkNote").textContent = `GPS is fuzzy right now (about ${Math.round(s.pos.acc * 3.281)} ft). Tall buildings can do that.`;

    if (s.g3d) {
      const g = s.g3d, line = s.route ? s.route.coords : [s.pos, s.target];
      const path = line.map((p) => ({ lat: p.lat, lng: p.lng }));
      if ("path" in g.line) g.line.path = path; else g.line.coordinates = path;
      g.mk.position = { lat: s.target.lat, lng: s.target.lng };
      const now = performance.now();
      if (s.follow && now - g.lastCam > 400) {
        g.lastCam = now;
        g.map.center = { lat: s.pos.lat, lng: s.pos.lng, altitude: 0 };
        g.map.heading = head != null ? head : b;
        g.map.tilt = 67; g.map.range = 180;
      }
    }
    if (s.map) {
      if (s.meMarker) s.meMarker.setLngLat([s.pos.lng, s.pos.lat]).addTo(s.map);
      const src = s.map.getSource && s.map.getSource("drm-route");
      if (src) src.setData(routeGeo());
      if (s.targetMarker) s.targetMarker.setLngLat([s.target.lng, s.target.lat]);
      if (s.follow) s.map.easeTo({ center: [s.pos.lng, s.pos.lat], bearing: head != null ? head : b, pitch: 62, zoom: 18.2, duration: 600 });
    }
  }
  function compassWord(b) { return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(b / 45) % 8]; }

  let lastDraw = 0;
  function onOrient(e) {
    if (!s) return;
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;            // iPhone
    else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;          // Android
    if (h == null) return;
    // Correct for holding the phone sideways.
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    s.heading = (h + so + 360) % 360;
    const now = performance.now();
    if (now - lastDraw > 150) { lastDraw = now; update(); }
  }
  async function startCompass() {
    if (!s) return;
    const btn = s.root.querySelector("#walkCompass");
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") { say("Compass is off. The arrow will use north instead."); return; }
      }
      s.onOrient = onOrient;
      window.addEventListener("deviceorientationabsolute", onOrient, true);
      window.addEventListener("deviceorientation", onOrient, true);
      btn.hidden = true;
    } catch (e) {
      say("This phone didn't share its compass. The arrow will use north instead.");
    }
  }

  function close() {
    if (!s) return;
    if (s.watch != null) navigator.geolocation.clearWatch(s.watch);
    if (s.onOrient) { window.removeEventListener("deviceorientationabsolute", s.onOrient, true); window.removeEventListener("deviceorientation", s.onOrient, true); }
    if (s.map) s.map.remove();
    if (s.g3d) s.g3d.map.remove();
    s.root.remove();
    s = null;
  }

  return { open, close };
})();
