// Builds paths.json: the walkable path network of the Disneyland Resort from OpenStreetMap.
// Run at deploy time: node scripts/build-paths.mjs [overpass.json]
// Output: { nodes: [[lat, lng], ...], edges: [[a, b], ...] } with ids as array indexes.
import { readFileSync, writeFileSync } from "node:fs";

const BBOX = [33.8025, -117.9265, 33.8185, -117.9145]; // south, west, north, east
const WALK = "footway|path|pedestrian|steps|living_street|corridor|service|track|residential|unclassified";
const QUERY = `[out:json][timeout:60];
way["highway"~"^(${WALK})$"]["access"!~"^(private|no)$"]["foot"!~"^(no)$"](${BBOX.join(",")});
(._;>;);
out body;`;

async function fetchOverpass() {
  const urls = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": "disney-ride-mapper/1.0 (https://github.com/mast3rshifu/disney-ride-mapper)",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const u of urls) {
      try {
        const res = await fetch(u, { method: "POST", body: "data=" + encodeURIComponent(QUERY), headers });
        if (res.ok) return await res.json();
        console.warn(u, res.status, (await res.text()).slice(0, 200));
      } catch (e) { console.warn(u, e.message); }
    }
    await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
  }
  throw new Error("Overpass unavailable");
}

const data = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : await fetchOverpass();
const coords = new Map();
for (const el of data.elements) if (el.type === "node") coords.set(el.id, [+el.lat.toFixed(6), +el.lon.toFixed(6)]);

const index = new Map(), nodes = [], edges = [], seen = new Set();
const idx = (id) => { if (!index.has(id)) { index.set(id, nodes.length); nodes.push(coords.get(id)); } return index.get(id); };
for (const el of data.elements) {
  if (el.type !== "way" || !el.nodes) continue;
  for (let i = 1; i < el.nodes.length; i++) {
    const a = el.nodes[i - 1], b = el.nodes[i];
    if (!coords.has(a) || !coords.has(b) || a === b) continue;
    const ia = idx(a), ib = idx(b);
    const key = ia < ib ? ia + "," + ib : ib + "," + ia;
    if (seen.has(key)) continue;
    seen.add(key); edges.push([ia, ib]);
  }
}
if (edges.length < 50) throw new Error("Too few paths found: " + edges.length);
writeFileSync("paths.json", JSON.stringify({ built: new Date().toISOString(), nodes, edges }));
console.log(`paths.json: ${nodes.length} nodes, ${edges.length} edges`);
