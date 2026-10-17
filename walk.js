// Walk mode: a tilted 3D map that follows your GPS and turns with your compass,
// plus a big arrow pointing to the ride. Map tiles from OpenFreeMap (OpenStreetMap data).
window.DRM_WALK = (function () {
  const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
  const STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const ARRIVE_M = 25;

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
          <div class="walk-btns">
            <button type="button" class="chip primary" id="walkCompass">Turn on compass</button>
            <button type="button" class="chip" id="walkRecenter" hidden>Follow me</button>
          </div>
          <div class="muted walk-note" id="walkNote"></div>
        </div>
      </div>`);
    document.body.appendChild(root);
    s = { ride, ctx, root, pos: ctx.getPos(), heading: null, follow: true, map: null, target: null, arrived: false, watch: null, onOrient: null };

    root.querySelector("#walkClose").onclick = close;
    root.querySelector("#walkCompass").onclick = startCompass;
    root.querySelector("#walkRecenter").onclick = () => { s.follow = true; root.querySelector("#walkRecenter").hidden = true; update(); };

    // Exact ride location from the live feed when we can get it; land center otherwise.
    s.target = ctx.landPoint(ride);
    ctx.rideLocation(ride).then((p) => {
      if (!s || s.ride !== ride) return;
      if (p) { s.target = p; root.querySelector("#walkNote").textContent = ""; }
      else root.querySelector("#walkNote").textContent = `Pointing to the middle of ${ctx.landName(ride)}. Follow the ride signs for the last bit.`;
      update();
    });

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

    loadLib().then((lib) => buildMap(lib)).catch(() => {
      root.querySelector("#walkMap").classList.add("nomap");
      root.querySelector("#walkMap").innerHTML = `<div class="nomap-msg">The 3D map couldn't load (weak signal?). The arrow still works.</div>`;
    });
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

  function routeGeo() {
    const coords = s.pos ? [[s.pos.lng, s.pos.lat], [s.target.lng, s.target.lat]] : [];
    return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
  }

  function say(t) { if (s) s.root.querySelector("#walkSay").textContent = t; }

  function update() {
    if (!s) return;
    const head = s.heading != null ? s.heading : s.gpsHeading != null ? s.gpsHeading : null;
    const arrow = s.root.querySelector("#walkArrow");
    if (!s.pos) { s.root.querySelector("#walkDist").textContent = "Finding you…"; return; }
    const d = distance(s.pos, s.target), b = bearing(s.pos, s.target);
    const mins = Math.max(1, Math.round((d * 1.35) / 65));
    const feet = Math.round(d * 3.281);
    s.root.querySelector("#walkDist").textContent = d < 1600
      ? `${feet > 900 ? (feet / 5280).toFixed(1) + " mi" : feet + " ft"} · about ${mins} min walk`
      : "You're not at the parks yet";

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
    s.root.remove();
    s = null;
  }

  return { open, close };
})();
