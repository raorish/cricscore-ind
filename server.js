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
app.get("/", (req, res) => {
  const page = findPage();
  if (!page) return res.status(404).send("HTML file repository me nahi mili. File ka naam index.html rakho.");
  res.sendFile(page);
});

app.listen(process.env.PORT || 3000, () => console.log("Server chalu hai"));
