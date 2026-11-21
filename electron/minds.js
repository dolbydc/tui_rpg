// The minds window (a window of its own, minds.html, beside the game's): the player, the narrator and every NPC round the language model they think with, joined by
// who's had to do with whom. As things happen, they're shown: a call to the model runs out along an agent's
// spoke and its answer back; something said, told or seen runs from one agent to another. The panel in the
// sidebar says what the model is doing even while the window is closed.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const W = 900;
const H = 660;
const CENTRE = { x: W / 2, y: H / 2 };
const RADIUS = 255;
const NODE = 34;
const LOG_LIMIT = 80;

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}

/** The minds as last sent, where each is drawn, and what's going on. */
const minds = {
  agents: [],
  links: [],
  /** Pairs who've passed something since the window opened, on top of the links the game sent. */
  live: new Map(),
  at: new Map(),
  /** Model calls under way: call → { agent, task }. */
  calls: new Map(),
  log: [],
};

const nameOf = (id) => minds.agents.find((a) => a.id === id)?.name ?? id;
/** Drawn only where there's a graph to draw on: the minds window, not the game's sidebar. */
const isOpen = () => Boolean($("minds-graph"));
const pairKey = (a, b) => [a, b].sort().join("|");

/** Player at the top, the NPCs round the circle, the narrator at the bottom. */
function layout() {
  const npcs = minds.agents.filter((a) => a.role === "npc");
  const ring = [minds.agents.find((a) => a.role === "player"), ...npcs.slice(0, Math.ceil(npcs.length / 2)), minds.agents.find((a) => a.role === "narrator"), ...npcs.slice(Math.ceil(npcs.length / 2))].filter(Boolean);
  minds.at.clear();
  ring.forEach((agent, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length;
    minds.at.set(agent.id, { x: CENTRE.x + RADIUS * Math.cos(angle), y: CENTRE.y + RADIUS * 0.92 * Math.sin(angle) });
  });
  minds.at.set("llm", CENTRE);
}

export function updateMinds(shapes) {
  minds.agents = shapes?.agents ?? [];
  minds.links = shapes?.links ?? [];
  layout();
  drawStatus();
  if (isOpen()) drawGraph();
}

/** The graph's still part: links, spokes to the model, the model, the agents. Moving things go in #minds-fx. */
function drawGraph() {
  const root = $("minds-graph");
  const weights = new Map(minds.links.map((l) => [pairKey(l.a, l.b), l.weight]));
  for (const [key, n] of minds.live) weights.set(key, (weights.get(key) ?? 0) + n);
  const thinking = new Set([...minds.calls.values()].map((c) => c.agent));

  const defs = svg(
    "defs",
    {},
    svg("radialGradient", { id: "llm-glow" }, svg("stop", { offset: "0", "stop-color": "#bb9af7", "stop-opacity": "0.55" }), svg("stop", { offset: "1", "stop-color": "#bb9af7", "stop-opacity": "0" })),
  );
  const links = [...weights].flatMap(([key, weight]) => {
    const [a, b] = key.split("|");
    const p = minds.at.get(a);
    const q = minds.at.get(b);
    if (!p || !q) return [];
    return [svg("line", { class: "mind-link", x1: p.x, y1: p.y, x2: q.x, y2: q.y, "stroke-width": Math.min(8, 1.2 + Math.log2(1 + weight) * 1.3) })];
  });
  const spokes = minds.agents.map((agent) => {
    const p = minds.at.get(agent.id);
    return svg("line", { class: thinking.has(agent.id) ? "mind-spoke active" : "mind-spoke", x1: p.x, y1: p.y, x2: CENTRE.x, y2: CENTRE.y, "data-agent": agent.id });
  });
  const busy = minds.calls.size > 0;
  const llm = svg(
    "g",
    { class: busy ? "llm busy" : "llm", transform: `translate(${CENTRE.x} ${CENTRE.y})` },
    svg("circle", { class: "llm-glow", r: 92, fill: "url(#llm-glow)" }),
    svg("polygon", { class: "llm-core", points: hexagon(48) }),
    svg("text", { class: "llm-label", y: -4 }, "LLM"),
    svg("text", { class: "llm-sub", y: 16 }, busy ? `${minds.calls.size} thinking` : "idle"),
  );
  let clip = 0;
  const nodes = minds.agents.map((agent) => {
    const p = minds.at.get(agent.id);
    const classes = ["mind", agent.role, agent.withPlayer && agent.role === "npc" ? "with-player" : "", thinking.has(agent.id) ? "thinking" : ""].filter(Boolean).join(" ");
    const g = svg("g", { class: classes, transform: `translate(${p.x} ${p.y})` });
    const id = `mind-clip-${clip++}`;
    g.append(svg("clipPath", { id }, svg("circle", { r: NODE })));
    g.append(svg("circle", { class: "mind-halo", r: NODE + 9 }));
    g.append(svg("circle", { class: "mind-bg", r: NODE }));
    if (agent.url) g.append(svg("image", { href: agent.url, x: -NODE, y: -NODE, width: NODE * 2, height: NODE * 2, "clip-path": `url(#${id})`, preserveAspectRatio: "xMidYMin slice" }));
    else g.append(svg("text", { class: "mind-initial", y: 8 }, agent.role === "narrator" ? "✎" : agent.name.charAt(0).toUpperCase()));
    g.append(svg("circle", { class: "mind-ring", r: NODE }));
    g.append(svg("text", { class: "mind-name", y: NODE + 20 }, agent.name + (agent.companion ? " ·with you" : "")));
    if (agent.place) g.append(svg("text", { class: "mind-place", y: NODE + 36 }, agent.place));
    const call = [...minds.calls.values()].findLast((c) => c.agent === agent.id);
    if (call) g.append(svg("text", { class: "mind-task", y: -NODE - 14 }, `${call.task}…`));
    return g;
  });
  const fx = $("minds-fx") ?? svg("g", { id: "minds-fx" });
  root.replaceChildren(defs, ...links, ...spokes, llm, ...nodes, fx);
}

function hexagon(r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

/** A dot running from one point to another, then fading where it lands. */
function pulse(from, to, kind, duration = 900) {
  if (!isOpen()) return;
  const p = minds.at.get(from);
  const q = minds.at.get(to);
  const fx = $("minds-fx");
  if (!p || !q || !fx) return;
  const trail = svg("line", { class: `fx-trail ${kind}`, x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  const dot = svg("circle", { class: `fx-dot ${kind}`, r: 8, cx: p.x, cy: p.y });
  fx.append(trail, dot);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    dot.setAttribute("cx", String(p.x + (q.x - p.x) * e));
    dot.setAttribute("cy", String(p.y + (q.y - p.y) * e));
    trail.style.opacity = String(0.9 * (1 - t * 0.6));
    if (t < 1) return requestAnimationFrame(step);
    dot.classList.add("landed");
    trail.style.opacity = "0";
    setTimeout(() => {
      dot.remove();
      trail.remove();
    }, 700);
  };
  requestAnimationFrame(step);
}

/** Messages that arrive together run one after another, so each can be seen. */
let queue = Promise.resolve();
function later(fn, gap) {
  queue = queue.then(() => {
    fn();
    return new Promise((resolve) => setTimeout(resolve, isOpen() ? gap : 0));
  });
}

/** What happened before the window opened: listed, and the calls still under way shown, without running it all again. */
export function replayActivity(history) {
  for (const activity of history) {
    if (activity.type === "thinking") {
      if (activity.phase === "start") {
        minds.calls.set(activity.call, { agent: activity.agent, task: activity.task });
        log({ kind: "think", text: `${nameOf(activity.agent)}: ${activity.task}` }, false);
      } else minds.calls.delete(activity.call);
    } else {
      const key = pairKey(activity.from, activity.to);
      minds.live.set(key, (minds.live.get(key) ?? 0) + 1);
      log(messageLine(activity), false);
    }
  }
  drawStatus();
  if (isOpen()) {
    drawGraph();
    drawLog();
  }
}

function messageLine(activity) {
  const verb = { said: "said to", told: "told", seen: "saw" }[activity.kind];
  return activity.kind === "seen"
    ? { kind: "seen", text: `${nameOf(activity.to)} saw ${nameOf(activity.from)}`, detail: activity.text }
    : { kind: activity.kind, text: `${nameOf(activity.from)} ${verb} ${nameOf(activity.to)}`, detail: activity.text };
}

export function showActivity(activity) {
  if (activity.type === "thinking") {
    if (activity.phase === "start") minds.calls.set(activity.call, { agent: activity.agent, task: activity.task });
    else minds.calls.delete(activity.call);
    if (activity.phase === "start") {
      log({ kind: "think", text: `${nameOf(activity.agent)}: ${activity.task}` });
      pulse(activity.agent, "llm", "think", 650);
    } else {
      pulse("llm", activity.agent, "answer", 650);
    }
    drawStatus();
    if (isOpen()) drawGraph();
    return;
  }
  const key = pairKey(activity.from, activity.to);
  minds.live.set(key, (minds.live.get(key) ?? 0) + 1);
  const line = messageLine(activity);
  later(() => {
    log(line);
    if (isOpen()) drawGraph();
    pulse(activity.from, activity.to, activity.kind, 1000);
  }, 450);
}

function log(entry, draw = true) {
  minds.log.unshift({ ...entry, at: new Date() });
  minds.log.length = Math.min(minds.log.length, LOG_LIMIT);
  if (draw && isOpen()) drawLog();
}

function drawLog() {
  $("minds-log").replaceChildren(
    ...minds.log.map((entry) => {
      const li = document.createElement("li");
      li.className = entry.kind;
      const head = document.createElement("div");
      head.className = "head";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      head.append(time, document.createTextNode(entry.text));
      li.append(head);
      if (entry.detail) {
        const detail = document.createElement("div");
        detail.className = "detail";
        detail.textContent = entry.detail;
        li.append(detail);
      }
      return li;
    }),
  );
}

/** The sidebar's line: what the model is doing. */
function drawStatus() {
  const status = $("minds-status");
  if (!status) return;
  const calls = [...minds.calls.values()];
  const npcs = minds.agents.filter((a) => a.role === "npc").length;
  status.classList.toggle("busy", calls.length > 0);
  status.textContent = calls.length
    ? `LLM · ${calls.map((c) => `${nameOf(c.agent)} ${c.task}`).join("; ")}`
    : `LLM idle · ${npcs} NPC${npcs === 1 ? "" : "s"}, the narrator and you`;
}

/** In the game's window: the panel says what the model's doing, and a click opens the minds window. */
export function setUpMindsPanel(open) {
  $("minds-panel").addEventListener("click", open);
  drawStatus();
}

/** In the minds window: the graph and the log, drawn now and as things happen. */
export function setUpMindsWindow() {
  drawGraph();
  drawLog();
}
