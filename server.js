const express = require("express");
const path = require("path");

const app = express();
const KEY = process.env.CRICAPI_KEY;      // Render ke Environment me daalna, yahan nahi
const TTL = 16 * 60 * 1000;               // 16 min: free plan ke 100 hits/din me rehne ke liye
const RETRY_AFTER_ERROR = 2 * 60 * 1000;  // error aaye to 2 min tak dobara try nahi

let cache = { data: null, at: 0 };
let nextTry = 0;
let pending = null;

async function refresh() {
  const r = await fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${KEY}&offset=0`);
  const j = await r.json();
  if (j.status !== "success") throw new Error(j.reason || "Cricket API se data nahi mila");
  cache = { data: j.data || [], at: Date.now() };
}

app.get("/api/matches", async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "CRICAPI_KEY set nahi hai" });
  const stale = !cache.data || Date.now() - cache.at > TTL;
  if (stale && Date.now() >= nextTry) {
    pending = pending || refresh().finally(() => { pending = null; });
    try { await pending; }
    catch (e) {
      nextTry = Date.now() + RETRY_AFTER_ERROR;
      if (!cache.data) return res.status(502).json({ error: e.message });
    }
  }
  if (!cache.data) return res.status(502).json({ error: "Data abhi available nahi hai, thodi der baad try karo" });
  res.set("Cache-Control", "public, max-age=60");
  res.json(cache.data);
});

const fs = require("fs");

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
  if (!page) return res.status(404).send("HTML file repository me nahi mili. GitHub me check karo ki file ka naam index.html hai.");
  res.sendFile(page);
});

app.listen(process.env.PORT || 3000, () => console.log("Server chalu hai"));
