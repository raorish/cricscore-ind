const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const KEY = process.env.CRICAPI_KEY;            // sirf Render ke Environment me
const API = "https://api.cricapi.com/v1";
const LIST_TTL = 16 * 60 * 1000;                // match list: 16 min
const CARD_TTL = 10 * 60 * 1000;                // scorecard: 10 min
const RETRY = 2 * 60 * 1000;                    // error ke baad 2 min wait
const DAILY_MAX = 95;                           // free plan 100/din, 5 bacha ke rakhe

let day = new Date().toISOString().slice(0, 10), hits = 0;
function canHit() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; hits = 0; }
  return hits < DAILY_MAX;
}
async function call(endpoint, params) {
  if (!canHit()) throw new Error("Aaj ki API limit poori ho gayi, purana data dikh raha hai");
  hits++;
  const r = await fetch(`${API}/${endpoint}?apikey=${KEY}&${params}`);
  const j = await r.json();
  if (j.status !== "success") throw new Error(j.reason || "Cricket API se data nahi mila");
  return j.data;
}

let list = { data: null, at: 0 }, nextTry = 0, pending = null;
const cards = new Map();

app.get("/api/matches", async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "CRICAPI_KEY set nahi hai" });
  const stale = !list.data || Date.now() - list.at > LIST_TTL;
  if (stale && Date.now() >= nextTry) {
    pending = pending || call("currentMatches", "offset=0")
      .then(d => { list = { data: d || [], at: Date.now() }; })
      .finally(() => { pending = null; });
    try { await pending; } catch (e) { nextTry = Date.now() + RETRY; if (!list.data) return res.status(502).json({ error: e.message }); }
  }
  if (!list.data) return res.status(502).json({ error: "Data abhi available nahi hai, thodi der baad try karo" });
  res.set("Cache-Control", "public, max-age=60");
  res.json({ updatedAt: list.at, matches: list.data });
});

app.get("/api/match/:id", async (req, res) => {
  const id = req.params.id;
  if (!KEY || !/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: "Galat request" });
  const c = cards.get(id);
  if (c && Date.now() - c.at < CARD_TTL) return res.json(c.data);
  try {
    const data = await call("match_scorecard", `id=${id}`);
    if (cards.size > 200) cards.delete(cards.keys().next().value);
    cards.set(id, { data, at: Date.now() });
    res.json(data);
  } catch (e) {
    if (c) return res.json(c.data);
    res.status(502).json({ error: e.message });
  }
});

let news = { data: null, at: 0 }, newsNext = 0;
app.get("/api/news", async (req, res) => {
  if (!process.env.NEWS_KEY) return res.status(500).json({ error: "NEWS_KEY set nahi hai" });
  const stale = !news.data || Date.now() - news.at > 30 * 60 * 1000;   // 30 min cache
  if (stale && Date.now() >= newsNext) {
    try {
      const r = await fetch(`https://newsdata.io/api/1/latest?apikey=${process.env.NEWS_KEY}&q=cricket&country=in&language=en,hi`);
      const j = await r.json();
      if (j.status !== "success") throw new Error("News nahi mili");
      news = { data: (j.results || []).slice(0, 10).map(n => ({ title: n.title, link: n.link, description: n.description, pubDate: n.pubDate, source: n.source_name })), at: Date.now() };
    } catch (e) { newsNext = Date.now() + RETRY; }
  }
  if (!news.data) return res.status(502).json({ error: "News abhi available nahi hai" });
  res.set("Cache-Control", "public, max-age=300");
  res.json(news.data);
});

function findPage() {
  const dirs = [__dirname, path.join(__dirname, "public"), path.join(__dirname, "src")];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith(".html"));
    const pick = files.find(f => f.toLowerCase() === "index.html") || files[0];
    if (pick) return path.join(d, pick);
  }
  return null;
}
// ---------- AI match summary (optional: ANTHROPIC_API_KEY Render me daalo) ----------
const AI_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "claude-haiku-5-5";
const AI_MAX = 150;                       // roz ki limit, taaki bill na badhe
let aiDay = "", aiN = 0;
const sums = new Map();
app.get("/api/config", (req, res) => res.json({ ai: !!AI_KEY }));
app.get("/api/summary/:id", async (req, res) => {
  if (!AI_KEY) return res.status(503).json({ error: "AI summary on nahi hai" });
  const id = req.params.id;
  if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: "Galat request" });
  const lang = req.query.lang === "hi" ? "hi" : "en";
  const m = (list.data || []).find(x => x.id === id);
  if (!m) return res.status(404).json({ error: "Match abhi list me nahi hai" });
  const key = `${id}|${lang}|${list.at}`;            // list badalte hi naya summary
  if (sums.has(key)) return res.json({ text: sums.get(key) });
  const d = new Date().toISOString().slice(0, 10);
  if (aiDay !== d) { aiDay = d; aiN = 0; }
  if (aiN >= AI_MAX) return res.status(429).json({ error: "Aaj ki AI limit poori ho gayi" });
  aiN++;
  try {
    const data = { name: m.name, format: m.matchType, venue: m.venue, date: m.date, status: m.status, teams: m.teams, score: m.score };
    const prompt = `You write short match updates for an Indian cricket website. Write a 2-3 sentence summary of this match ${lang === "hi" ? "in simple Hindi (Devanagari script)" : "in simple English"}. Use ONLY the facts in the JSON below. Do not mention any player, record or detail that is not in the JSON. If the match has not started, say so briefly. No markdown, no emojis.\n\n${JSON.stringify(data)}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 220, messages: [{ role: "user", content: prompt }] })
    });
    const j = await r.json();
    const text = j.content && j.content[0] && j.content[0].text;
    if (!text) throw new Error("AI se jawab nahi mila");
    if (sums.size > 300) sums.delete(sums.keys().next().value);
    sums.set(key, text.trim());
    res.json({ text: text.trim() });
  } catch (e) { res.status(502).json({ error: "AI summary abhi available nahi hai" }); }
});

const EMAIL = process.env.CONTACT_EMAIL || "your-email@example.com";   // Render Environment me CONTACT_EMAIL daalo
const h = x => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const base = req => `https://${req.get("host")}`;

function shell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} | CricScore India</title><meta name="robots" content="index,follow"><link rel="icon" href="/icon-192.png"><style>body{font:16px/1.7 system-ui,Arial,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#111827}a{color:#1d4ed8}header a{font-weight:700;text-decoration:none;color:#0f172a}h1{margin:14px 0 6px}footer{margin-top:40px;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:.85rem}</style></head><body><header><a href="/">← CricScore India</a></header>${body}<footer><a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms</a></footer></body></html>`;
}
const PAGES = {
  about: ["About Us", `<h1>About CricScore India</h1><p>CricScore India is a free cricket website for fans. We show live scores, scorecards, cricket news, venue weather, player information and handy calculators, with Team India matches shown first. The site is available in English and Hindi.</p><p>Scores and news come from third-party providers and can be delayed by several minutes. For official results, please check the official websites of the match organisers.</p><p>CricScore India is an independent project. It is not affiliated with, endorsed by or connected to the ICC, the BCCI or any cricket team, board or league.</p>`],
  contact: ["Contact Us", `<h1>Contact Us</h1><p>Found a wrong score, a bug, or have a suggestion? Write to us at <a href="mailto:${h(EMAIL)}">${h(EMAIL)}</a>.</p><p>We try to reply within a few days.</p>`],
  privacy: ["Privacy Policy", `<h1>Privacy Policy</h1><p>Last updated: 24 October 2026</p><p>CricScore India does not ask you to create an account and does not collect your name, phone number or email address.</p><h3>Data stored on your device</h3><p>Your choices (language, theme, wallpaper, favourite team) are saved in your browser's local storage. You can clear them any time from your browser settings.</p><h3>Server logs</h3><p>Our hosting provider (Render) may record technical data such as IP address and browser type in standard server logs.</p><h3>Third-party services</h3><p>We use CricketData.org for scores, NewsData.io for news, Open-Meteo for venue weather, Wikipedia for player information and Google Fonts for fonts. When you use these features, your browser or our server contacts those services, and they may receive technical data such as your IP address under their own privacy policies.</p><h3>Advertising</h3><p>We may show ads from Google AdSense. Google and its partners may use cookies to show ads based on your visits to this and other websites. You can manage ad personalisation in Google Ads Settings. Where required by law, we will ask for your consent.</p><h3>Children</h3><p>This site is not directed at children under 13.</p><h3>Contact</h3><p>Questions about this policy: <a href="mailto:${h(EMAIL)}">${h(EMAIL)}</a>.</p>`],
  terms: ["Terms of Use", `<h1>Terms of Use</h1><p>Last updated: 24 October 2026</p><p>By using CricScore India you agree to these terms.</p><ul><li>The site is provided "as is". Scores, news and other information may be delayed, incomplete or wrong. We do not guarantee accuracy.</li><li>Do not use this site for betting, gambling or any financial decision.</li><li>Match data, team logos, news and Wikipedia text belong to their respective owners.</li><li>We are not liable for any loss arising from use of this site.</li><li>We may change or stop the site, and these terms, at any time.</li></ul><p>Contact: <a href="mailto:${h(EMAIL)}">${h(EMAIL)}</a></p>`]
};
for (const k of Object.keys(PAGES)) app.get("/" + k, (req, res) => res.send(shell(PAGES[k][0], PAGES[k][1])));

app.get("/robots.txt", (req, res) => res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${base(req)}/sitemap.xml\n`));
app.get("/sitemap.xml", (req, res) => {
  const urls = ["/", "/about", "/contact", "/privacy", "/terms", ...(list.data || []).map(m => "/match/" + m.id)];
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${h(base(req) + u)}</loc></url>`).join("")}</urlset>`);
});

// Har match ka apna URL: Google aur WhatsApp ko alag title/description milta hai
app.get("/match/:id", (req, res) => {
  const page = findPage();
  if (!page) return res.status(404).send("HTML file repository me nahi mili.");
  let html = fs.readFileSync(page, "utf8");
  const m = (list.data || []).find(x => x.id === req.params.id);
  if (m) {
    const name = m.name || (m.teams || []).join(" vs ");
    const title = `${name} Live Score | CricScore India`;
    const desc = `${name}: ${m.status || "live score"}. Live score, full scorecard and updates on CricScore India.`;
    const url = `${base(req)}/match/${encodeURIComponent(m.id)}`;
    html = html.replace(/<title>.*?<\/title>/, `<title>${h(title)}</title>`)
      .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${h(desc)}">`)
      .replace("</head>", `<link rel="canonical" href="${h(url)}"><meta property="og:type" content="website"><meta property="og:title" content="${h(title)}"><meta property="og:description" content="${h(desc)}"><meta property="og:url" content="${h(url)}"><meta property="og:image" content="${h(base(req))}/icon-512.png"></head>`);
  }
  res.type("html").send(html);
});

app.use(express.static(path.join(__dirname, "public")));   // logo.svg jaisi files ke liye
app.get("/", (req, res) => {
  const page = findPage();
  if (!page) return res.status(404).send("HTML file repository me nahi mili. File ka naam index.html rakho.");
  res.sendFile(page);
});

app.listen(process.env.PORT || 3000, () => console.log("Server chalu hai"));
