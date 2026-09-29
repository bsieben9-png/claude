/* Background worker: runs menu checks on a schedule (and from "Check now"), saves results to
   chrome.storage.local in the shape the app page reads (see shim.js), and shows notifications. */
import * as E from "./engine.js";

const TIMES = ["08:52", "16:20", "00:00"];          // local time on this computer
const OCS_CACHE_HOURS = 6;
const st = chrome.storage.local;
let running = false;

const get = async k => (await st.get(k))[k];
const openApp = () => chrome.tabs.create({url: chrome.runtime.getURL("app.html")});

chrome.runtime.onInstalled.addListener(async () => { await seedIfEmpty(); await arm(); dueCheck(); });
chrome.runtime.onStartup.addListener(async () => { await arm(); dueCheck(); });
chrome.action.onClicked.addListener(openApp);
chrome.notifications.onClicked.addListener(id => { chrome.notifications.clear(id); openApp(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "tick") dueCheck(); });
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.cmd === "check") { const already = running; if (!already) runAll("manual"); reply({ok: true, already}); }
});

async function arm(){
  // one alarm every 5 minutes; each tick checks whether a scheduled time has passed since the last check
  const a = await chrome.alarms.get("tick");
  if (!a) await chrome.alarms.create("tick", {periodInMinutes: 5, delayInMinutes: 1});
}

function lastSlot(now = new Date()){
  // the most recent scheduled time at or before now
  let best = null;
  for (const dayBack of [0, 1]) for (const t of TIMES) {
    const [h, m] = t.split(":").map(Number);
    const d = new Date(now); d.setDate(d.getDate() - dayBack); d.setHours(h, m, 0, 0);
    if (d <= now && (!best || d > best)) best = d;
  }
  return best;
}

async function dueCheck(){
  if (running) return;
  const cfg = await get("config/stores");
  const slugs = ((cfg && cfg.stores) || E.DEFAULT_STORES).map(s => s.slug);
  const metas = await st.get(slugs.map(s => "stores/" + s));
  const last = Math.min(...slugs.map(s => { const m = metas["stores/" + s]; return m && m.last_run ? new Date(m.last_run.replace("Z", ":00Z")).getTime() : 0; }));
  if (last < lastSlot().getTime()) runAll("scheduled");
}

async function seedIfEmpty(){
  // the download can include a copy of the cloud app's data, so the first run continues from it
  if (await get("catalog/calmar")) return;
  try {
    const r = await fetch(chrome.runtime.getURL("seed.json"));
    if (r.ok) await st.set(await r.json());
  } catch (e) { /* no seed file: the first check builds the baseline */ }
}

async function getOCS(){
  const c = await get("ocs_cache");
  if (c && Date.now() - c.at < OCS_CACHE_HOURS * 3600e3) return c.list;
  const list = await E.fetchOCS(() => chrome.runtime.getPlatformInfo());
  await st.set({ocs_cache: {at: Date.now(), list}});
  return list;
}

async function runAll(why){
  if (running) return;
  running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);   // long checks keep the worker awake
  const notes = [];
  try {
    const cfg = await get("config/stores");
    const stores = (cfg && cfg.stores && cfg.stores.length) ? cfg.stores : E.DEFAULT_STORES;
    const slugs = stores.map(s => s.slug);
    const v = await st.get([...slugs.flatMap(s => ["catalog/" + s, "stores/" + s]), "watchlist", "ratings"]);
    const ratings = Object.values(((v.ratings || {}).items) || {}).filter(e => e && e.stars);
    const state = {stores, catalogs: {}, meta: {}, watch: (v.watchlist || {}).items || {}, ratings};
    for (const s of slugs) { state.catalogs[s] = v["catalog/" + s] || []; state.meta[s] = v["stores/" + s] || {}; }
    const out = await E.check(state);
    if (out.failed) throw new Error(Object.values(out.result.stores).map(x => x.error).join("; "));
    if (!cfg) await st.set({"config/stores": {stores}});
    for (const [slug, cat] of Object.entries(out.catalogs)) {
      const runs = (await get("runs/" + slug)) || [];
      await st.set({["catalog/" + slug]: cat, ["stores/" + slug]: out.metas[slug], ["runs/" + slug]: [out.runs[slug], ...runs].slice(0, 90)});
    }
    const last = (await get("checks/last")) || {};
    delete last.failed; delete last.failed_at;               // a good check clears an old failure message
    await st.set({last_report: {at: out.result.stamp, text: out.summary}, "checks/last": last});

    // pictures, then matched photos; a picture problem never fails the check
    for (const slug of Object.keys(out.catalogs)) {
      try {
        const media = (await get("media/" + slug)) || {};
        if (await E.thumbs(out.catalogs[slug], media, 600)) await st.set({["media/" + slug]: media});
      } catch (e) { notes.push("Pictures: " + e.message); }
      try {
        const matches = (await get("matches/" + slug)) || {};
        const ov = ((await get("overrides/" + slug)) || {}).items || {};
        const c = await E.photos(out.catalogs[slug], matches, ov, getOCS, {onStep: () => chrome.runtime.getPlatformInfo()});
        await st.set({["matches/" + slug]: matches});
        if (c.checked && c.line) notes.push(c.line);
      } catch (e) { notes.push("Photo matching: " + e.message); }
    }
    notify(out, why, notes);
  } catch (e) {
    const cur = (await get("checks/last")) || {};
    await st.set({"checks/last": {...cur, failed: e.message || String(e), failed_at: E.stampOf()}});
    chrome.notifications.create({type: "basic", iconUrl: "icons/icon128.png", title: "Calmar menu check failed",
      message: (e.message || String(e)).slice(0, 200) + " It will try again at the next scheduled time."});
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

function notify(out, why, notes){
  const lines = [];
  let changes = 0;
  for (const [slug, r] of Object.entries(out.result.stores)) {
    if (r.error || !r.counts) continue;
    const c = r.counts, bits = [];
    if (c.new) bits.push(`${c.new} new`);
    if (c.returned) bits.push(`${c.returned} back`);
    if (c.price) bits.push(`${c.price} price change${c.price > 1 ? "s" : ""}`);
    if (c.sale) bits.push(`${c.sale} sale change${c.sale > 1 ? "s" : ""}`);
    if (c.removed) bits.push(`${c.removed} gone`);
    changes += c.new + c.returned + c.price + c.sale;
    lines.push(bits.length ? bits.join(", ") : "No changes");
    if (r.new && r.new.length) lines.push("New: " + r.new.slice(0, 3).map(x => x.replace(/^ — /, "")).join("; ") + (r.new.length > 3 ? "…" : ""));
  }
  // only interrupt for something worth knowing: alerts, changes, or a check you asked for
  if (!out.alerts.length && !changes && why !== "manual") return;
  const msg = [...out.alerts.slice(0, 3), ...lines, ...(why === "manual" ? notes : [])].join("\n");
  chrome.notifications.create({type: "basic", iconUrl: "icons/icon128.png", priority: out.alerts.length ? 2 : 0,
    title: out.alerts.length ? `Calmar: ${out.alerts.length} alert${out.alerts.length > 1 ? "s" : ""} for you` : "Calmar menu checked",
    message: msg.slice(0, 400) || "Done."});
}
