// Original plush "stack critters" drawn in SVG. Each ride you check off adds one to your stack.
window.DRM_CRITTERS = (function () {
  const KINDS = [
    { id: "bear",  body: "#c98b5a", belly: "#efd2b4", ear: "round" },
    { id: "bunny", body: "#f3e7ee", belly: "#ffffff", ear: "long", inner: "#f6b8cf" },
    { id: "cat",   body: "#f2a54a", belly: "#fde1b8", ear: "point", inner: "#f7c58a" },
    { id: "panda", body: "#fafafa", belly: "#ffffff", ear: "round", earColor: "#2b2b2b", patch: "#2b2b2b" },
    { id: "frog",  body: "#7ccf7a", belly: "#cdeec2", ear: "eyes" },
    { id: "pig",   body: "#f7b6c2", belly: "#fcd8de", ear: "point", inner: "#ee97a8", snout: "#ee97a8" },
    { id: "chick", body: "#ffd84d", belly: "#fff0a8", ear: "tuft", beak: "#f59a2c" },
    { id: "blue",  body: "#8fb8f2", belly: "#d6e6fb", ear: "round", inner: "#c4d9f8" },
  ];

  function ears(k) {
    const c = k.earColor || k.body, i = k.inner || k.belly;
    switch (k.ear) {
      case "round": return `<circle cx="22" cy="20" r="11" fill="${c}"/><circle cx="78" cy="20" r="11" fill="${c}"/>
        <circle cx="22" cy="20" r="5.5" fill="${k.patch ? c : i}"/><circle cx="78" cy="20" r="5.5" fill="${k.patch ? c : i}"/>`;
      case "long": return `<ellipse cx="34" cy="10" rx="8" ry="20" fill="${c}"/><ellipse cx="66" cy="10" rx="8" ry="20" fill="${c}"/>
        <ellipse cx="34" cy="11" rx="4" ry="14" fill="${i}"/><ellipse cx="66" cy="11" rx="4" ry="14" fill="${i}"/>`;
      case "point": return `<path d="M14 34 L22 6 L42 22 Z" fill="${c}"/><path d="M86 34 L78 6 L58 22 Z" fill="${c}"/>
        <path d="M20 28 L23 14 L33 23 Z" fill="${i}"/><path d="M80 28 L77 14 L67 23 Z" fill="${i}"/>`;
      case "eyes": return `<circle cx="30" cy="22" r="12" fill="${c}"/><circle cx="70" cy="22" r="12" fill="${c}"/>`;
      case "tuft": return `<path d="M44 20 Q50 0 56 20 Q50 12 44 20Z" fill="${k.body}"/>`;
      default: return "";
    }
  }

  // A squishy oval plush, wider than tall, with tiny face low on the body.
  function svg(kindIndex, opts) {
    const k = KINDS[((kindIndex % KINDS.length) + KINDS.length) % KINDS.length];
    const o = Object.assign({ size: 56, wink: false }, opts || {});
    const eyesY = k.ear === "eyes" ? 22 : 50;
    const eyeL = k.ear === "eyes" ? `<circle cx="30" cy="22" r="5" fill="#222"/>` : `<ellipse cx="38" cy="${eyesY}" rx="3.2" ry="4" fill="#222"/>`;
    const eyeR = o.wink
      ? `<path d="M58 ${eyesY} q4 -4 8 0" stroke="#222" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
      : k.ear === "eyes" ? `<circle cx="70" cy="22" r="5" fill="#222"/>` : `<ellipse cx="62" cy="${eyesY}" rx="3.2" ry="4" fill="#222"/>`;
    const patches = k.patch ? `<ellipse cx="37" cy="51" rx="7" ry="8" fill="${k.patch}" transform="rotate(-20 37 51)"/><ellipse cx="63" cy="51" rx="7" ry="8" fill="${k.patch}" transform="rotate(20 63 51)"/>
      <circle cx="38" cy="50" r="2.4" fill="#fff"/><circle cx="62" cy="50" r="2.4" fill="#fff"/>` : "";
    const nose = k.snout ? `<ellipse cx="50" cy="60" rx="7" ry="5" fill="${k.snout}"/><circle cx="47.5" cy="60" r="1.3" fill="#a5566a"/><circle cx="52.5" cy="60" r="1.3" fill="#a5566a"/>`
      : k.beak ? `<path d="M45 57 L55 57 L50 64 Z" fill="${k.beak}"/>`
      : `<ellipse cx="50" cy="58" rx="3" ry="2.2" fill="#3a2a2a"/><path d="M46 62 q4 4 8 0" stroke="#3a2a2a" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
    return `<svg class="critter" width="${o.size}" height="${Math.round(o.size * 0.86)}" viewBox="0 0 100 86" aria-hidden="true">
      ${ears(k)}
      <ellipse cx="50" cy="52" rx="44" ry="32" fill="${k.body}"/>
      <ellipse cx="50" cy="66" rx="24" ry="14" fill="${k.belly}" opacity=".85"/>
      ${patches}${k.patch ? "" : eyeL + eyeR}${k.patch ? `<ellipse cx="38" cy="51" rx="2.6" ry="3.2" fill="#111"/>${o.wink ? `<path d="M58 51 q4 -4 8 0" stroke="#fff" stroke-width="2.4" fill="none"/>` : `<ellipse cx="62" cy="51" rx="2.6" ry="3.2" fill="#111"/>`}` : ""}
      <circle cx="28" cy="60" r="5" fill="#ff8fa3" opacity=".45"/><circle cx="72" cy="60" r="5" fill="#ff8fa3" opacity=".45"/>
      ${nose}
    </svg>`;
  }

  // Stable critter for a ride, so the same ride always gives the same buddy.
  function forRide(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % KINDS.length; }

  return { svg, forRide, count: KINDS.length };
})();
