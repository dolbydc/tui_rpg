// Draws the page around the terminal from the game's view (src/electron/page.ts): the picture of the place,
// and the panels. Everything from the game goes in as text, never as markup.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

/** An element with a class, text and children. */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}

/** "●●○" as spans: `on` filled, the rest empty. */
function pips(on, total, kind, filled, empty) {
  const span = el("span", "pips");
  for (let i = 0; i < total; i++) span.append(el("span", i < on ? `on ${kind}` : "off", i < on ? filled : empty));
  return span;
}

function meter(kind, label, value, max, extraClass = "") {
  const fill = el("div", "fill");
  fill.style.width = `${Math.max(0, Math.min(1, max ? value / max : 0)) * 100}%`;
  return el("div", `meter ${kind} ${extraClass}`, el("span", "", label), el("div", "bar", fill), el("span", "value", `${value}/${max}`));
}

/** The picture across the top: shown when there's one, or one on its way; otherwise the story has the height. */
export function drawScene(player) {
  const scene = $("scene");
  const place = player?.place;
  scene.hidden = !place || (!place.url && !place.drawing);
  if (scene.hidden) return;
  scene.classList.toggle("drawing", !place.url);
  const img = $("scene-image");
  if (place.url && img.getAttribute("src") !== place.url) img.src = place.url;
  if (!place.url) img.removeAttribute("src");
  img.alt = place.name;
  $("scene-name").textContent = place.name;
  // Whoever the player is talking with stands large over the picture, the one who just replied to the fore.
  const talking = player.people.filter((p) => p.talking);
  scene.classList.toggle("talking", talking.length > 0);
  $("scene-talk").style.setProperty("--talkers", String(Math.max(1, talking.length)));
  $("scene-talk").replaceChildren(
    ...talking.map((p) =>
      el(
        "figure",
        ["talker", p.speaking ? "speaking" : "", talking.length > 1 && !p.speaking ? "listening" : ""].filter(Boolean).join(" "),
        // Cut out of their background if that's been done, so it's them standing here, not where they were drawn.
        p.cutout
          ? Object.assign(document.createElement("img"), { className: "cut", src: p.cutout, alt: p.appearance })
          : p.url
          ? Object.assign(document.createElement("img"), { src: p.url, alt: p.appearance })
          : el("div", p.drawing ? "talker-blank drawing" : "talker-blank", p.drawing ? "" : p.label.replace(/^the /i, "").charAt(0).toUpperCase()),
        el("figcaption", "", p.label),
      ),
    ),
  );
  // Portraits of everyone else here, small over the picture: those drawn, or on their way.
  $("scene-people").replaceChildren(
    ...player.people
      .filter((p) => !p.talking && (p.url || p.drawing))
      .map((p) => el("li", "", portrait(p), el("span", "name", p.label))),
  );
}

/** A person's portrait: their picture, a shimmer while it's drawn, or their initial. */
function portrait(person) {
  if (person.url) return Object.assign(document.createElement("img"), { className: "portrait", src: person.url, alt: person.appearance });
  if (person.drawing) return el("div", "portrait drawing");
  return el("div", "portrait", person.label.replace(/^the /i, "").charAt(0).toUpperCase());
}

export function drawSidebar(player) {
  $("sidebar").hidden = !player;
  if (!player) return;
  drawMaps(player);
  drawCharacter(player);
  drawPeople(player.people);
  drawList($("inventory"), player.inventory, (item) => el("li", "", item), "Nothing");
  drawList($("quests"), player.quests, (q) => el("li", q.done ? "done" : "", q.title), "None yet");
}

function drawList(list, items, row, empty) {
  list.replaceChildren(...(items.length ? items.map(row) : [el("li", "empty", empty)]));
}

function drawCharacter({ character: c, turn, time }) {
  $("character").replaceChildren(
    ...[
    el("div", "who", el("strong", "", c.name), el("span", "muted", `(${c.pronouns})`)),
    meter("hp", "HP", c.hp, c.maxHp, c.hp * 3 <= c.maxHp ? "low" : ""),
    meter("xp", `Level ${c.level}`, c.xp, c.nextLevelXp),
    c.canLevelUp ? el("span", "chip", "Level up ready: /levelup <stat>") : undefined,
    el(
      "div",
      "stats",
      ...c.stats.map((s) => el("div", "stat", el("span", "name", s.name), el("span", "value", String(s.value)), el("span", "bonus", s.bonus))),
    ),
    el(
      "div",
      "turn",
      el("span", "", el("span", "label", time.day), time.clock),
      el("span", "", el("span", "label", "Turn"), String(turn.number)),
    ),
    el(
      "div",
      "turn",
      el("span", "", el("span", "label", "Actions"), pips(turn.actionsLeft, turn.actionsPerTurn, "action", "●", "○")),
      el("span", "", el("span", "label", "Drive"), pips(turn.drive, Math.max(turn.drivePerQuest, turn.drive), "drive", "◆", "◇")),
    ),
    ].filter(Boolean),
  );
}

function drawPeople(people) {
  $("people-panel").hidden = people.length === 0;
  $("people").replaceChildren(
    ...people.map((p) =>
      el(
        "li",
        "",
        portrait(p),
        el("div", "", el("div", "label", p.label, ...(p.companion ? [el("span", "with-you", "with you")] : [])), el("div", "appearance", p.appearance)),
      ),
    ),
  );
}

/** Map units to pixels in the panel: the same however much of the map there is (a lone place isn't blown up). */
const MAP_SCALE = 1;

/** The map, in the panel and (when opened) full-size. */
function drawMaps(player) {
  drawMap($("map"), player.map, MAP_SCALE);
  $("map-level").textContent = player.map.level ? `· ${player.map.level}` : "";
  drawMap($("full-map"), player.fullMap, 1.6);
  $("full-map-level").textContent = player.fullMap.level ? `· ${player.fullMap.level}` : "";
}

let clipIds = 0;

/**
 * Places as cards, each with its picture (or a blank where it'll be) and its name, joined by trails; exits to
 * places not yet seen trail off to a question mark. Where you are glows, with who's there and what's lying about.
 */
function drawMap(root, map, scale) {
  const { w, h } = map.box;
  const strip = 26;
  const [x0, y0, width, height] = map.viewBox.split(" ").map(Number);
  root.setAttribute("viewBox", map.viewBox);
  root.setAttribute("width", String(Math.round(width * scale)));
  root.setAttribute("height", String(Math.round(height * scale)));

  const defs = svg(
    "defs",
    {},
    svg("pattern", { id: `dots-${root.id}`, width: 24, height: 24, patternUnits: "userSpaceOnUse" }, svg("circle", { class: "map-grid", cx: 2, cy: 2, r: 1.4 })),
    svg(
      "linearGradient",
      { id: "blank-art", x1: 0, y1: 0, x2: 0, y2: 1 },
      svg("stop", { offset: "0", "stop-color": "#2a2d48" }),
      svg("stop", { offset: "1", "stop-color": "#1c1e30" }),
    ),
  );
  const ground = [
    svg("rect", { class: "map-ground", x: x0, y: y0, width, height, rx: 10 }),
    svg("rect", { x: x0, y: y0, width, height, rx: 10, fill: `url(#dots-${root.id})` }),
  ];

  const trails = map.links.flatMap((l) => {
    const line = (cls) => svg("line", { class: l.stub ? `${cls} stub` : cls, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 });
    return [line("trail"), line("trail-line")];
  });
  // Somewhere not yet seen, at the end of each exit that leads off.
  const unknowns = map.links
    .filter((l) => l.stub)
    .map((l) => svg("g", {}, svg("circle", { class: "unknown", cx: l.x2, cy: l.y2, r: 13 }), svg("text", { class: "unknown-mark", x: l.x2, y: l.y2 + 6, "text-anchor": "middle" }, "?")));

  const cards = map.places.map((p) => {
    const id = `clip-${root.id}-${clipIds++}`;
    const card = svg("g", { class: p.here ? "card here" : "card", transform: `translate(${p.x} ${p.y})` });
    card.append(svg("clipPath", { id }, svg("rect", { width: w, height: h, rx: 12 })));
    if (p.here) card.append(svg("rect", { class: "here-glow", x: -5, y: -5, width: w + 10, height: h + 10, rx: 16 }));
    const inside = svg("g", { "clip-path": `url(#${id})` });
    inside.append(svg("rect", { class: "card-bg", width: w, height: h }));
    if (p.url) inside.append(svg("image", { href: p.url, width: w, height: h - strip + 4, preserveAspectRatio: "xMidYMid slice" }));
    else inside.append(svg("rect", { class: "card-art-blank", width: w, height: h - strip }));
    inside.append(svg("rect", { class: "card-strip", y: h - strip, width: w, height: strip }));
    inside.append(svg("text", { class: "card-label", x: w / 2, y: h - 8 }, p.label));
    card.append(inside, svg("rect", { class: "card-frame", width: w, height: h, rx: 12 }));

    // Who's here (you, and each other person by initial or "?"), top left.
    if (p.people.length) {
      const badgeW = 14 + p.people.length * 15;
      const text = svg("text", { class: "badge-text", x: badgeW / 2, y: 17 });
      p.people.forEach((who, i) => text.append(svg("tspan", { class: who === "@" ? "badge-text me" : "badge-text", dx: i ? 5 : 0 }, who)));
      card.append(svg("g", { transform: "translate(8 8)" }, svg("rect", { class: "badge", width: badgeW, height: 24, rx: 12 }), text));
    }
    // Things lying about, as dots, bottom right of the picture.
    for (let i = 0; i < Math.min(p.items, 4); i++) {
      card.append(svg("circle", { class: "item-dot", cx: w - 12 - i * 13, cy: h - strip - 10, r: 5 }));
    }
    // Stairs, top right.
    const stairs = (p.stairs.up ? "▲" : "") + (p.stairs.down ? "▼" : "");
    if (stairs) card.append(svg("g", { transform: `translate(${w - 8 - 14 * stairs.length - 10} 8)` }, svg("rect", { class: "badge", width: 14 * stairs.length + 10, height: 24, rx: 12 }), svg("text", { class: "stairs-text", x: (14 * stairs.length + 10) / 2, y: 17 }, stairs)));
    return card;
  });

  root.replaceChildren(defs, ...ground, ...trails, ...unknowns, ...cards);
}

/** Clicking the map opens it full-size; a click or Esc closes it (and Esc doesn't reach the game, which it would quit). */
export function setUpMapOverlay(onClose) {
  const overlay = $("map-overlay");
  const close = () => {
    overlay.hidden = true;
    onClose();
  };
  $("map-panel").addEventListener("click", () => (overlay.hidden = false));
  overlay.addEventListener("click", close);
  window.addEventListener(
    "keydown",
    (event) => {
      if (overlay.hidden || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    },
    { capture: true },
  );
}
