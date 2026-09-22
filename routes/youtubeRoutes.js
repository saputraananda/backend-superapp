import express from "express";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const CHANNEL_URL = "https://www.youtube.com/@Cocokids_WorldFun/videos";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PAGES = 30;

// ponytail: cache in-memory per-process. Pindah ke redis kalau backend multi-instance.
let cache = { at: 0, data: [] };

const collect = (node, out) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));

  const lv = node.lockupViewModel;
  if (lv?.contentId && !out.has(lv.contentId)) {
    const meta = lv.metadata?.lockupMetadataViewModel;
    const parts = (meta?.metadata?.contentMetadataViewModel?.metadataRows || [])
      .flatMap((r) => (r.metadataParts || []).map((p) => p.text?.content))
      .filter(Boolean);
    out.set(lv.contentId, {
      id: lv.contentId,
      title: meta?.title?.content || "",
      views: parts.find((p) => /view/i.test(p)) || null,
      published: parts.find((p) => /ago|lalu/i.test(p)) || null,
      duration:
        JSON.stringify(lv.contentImage || {}).match(/"text":"(\d+:\d+(?::\d+)?)"/)?.[1] || null,
    });
  }
  Object.values(node).forEach((v) => collect(v, out));
};

const findToken = (node) => {
  let token = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || token) return;
    const t = n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (t) return void (token = t);
    Object.values(n).forEach(walk);
  };
  walk(node);
  return token;
};

const scrapeChannel = async () => {
  const html = await fetch(CHANNEL_URL, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(10000),
  }).then((r) => {
    if (!r.ok) throw new Error(`channel page ${r.status}`);
    return r.text();
  });

  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const initial = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/)?.[1];
  if (!key || !ver || !initial) throw new Error("layout YouTube berubah");

  const out = new Map();
  const data = JSON.parse(initial);
  collect(data, out);

  let token = findToken(data);
  for (let i = 0; token && i < MAX_PAGES; i++) {
    const json = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: ver, hl: "en", gl: "US" } },
        continuation: token,
      }),
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json());

    const before = out.size;
    collect(json, out);
    if (out.size === before) break;
    token = findToken(json);
  }

  return [...out.values()];
};

router.get("/videos", requireAuth, async (req, res) => {
  try {
    if (Date.now() - cache.at < TTL_MS && cache.data.length) {
      return res.json({ success: true, data: cache.data });
    }

    const data = await scrapeChannel();
    if (data.length) cache = { at: Date.now(), data };
    res.json({ success: true, data: data.length ? data : cache.data });
  } catch (err) {
    console.error("[youtube] scrape gagal:", err.message);
    // fallback ke cache lama — jangan bikin portal error
    res.json({ success: true, data: cache.data, stale: true });
  }
});

export default router;
