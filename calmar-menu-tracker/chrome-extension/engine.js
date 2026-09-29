/* Country Cannabis menu tracker engine, JavaScript port of engine.py for the Chrome extension.
   Pure logic plus fetch; storage is handled by the caller (background.js), so this file also runs in Node for tests.

   check(state)  -> fetches every store's menu, adds computed fields, diffs against the last check
   thumbs(...)   -> small store pictures for products that don't have one yet
   photos(...)   -> real photos from the OCS catalog for products that only have a placeholder picture */

export const API = "https://ecom-api.blaze.me/api";
export const DEFAULT_STORES = [{slug: "calmar", name: "Calmar", site_id: "ca9cba05-b18a-4dda-9c12-a4c5fa378083",
  menu_url: "https://shop.countrycannabisstore.ca/menu/calmar/"}];

const KIND_BY_CATEGORY = [
  ["vape", "vape"], ["infused pre", "infused"], ["pre-roll", "preroll"], ["dried flower", "flower"],
  ["milled flower", "flower"], ["hash", "extract"], ["shatter", "extract"], ["concentrate", "extract"],
  ["edible", "edible"], ["beverage", "beverage"], ["oil or spray", "ingestible"], ["capsule", "ingestible"],
  ["topical", "topical"], ["seed", "seed"], ["accessor", "accessory"], ["apparel", "apparel"],
];
export const KIND_ORDER = ["vape", "flower", "preroll", "infused", "extract", "edible", "beverage", "ingestible",
  "topical", "seed", "accessory", "apparel", "other"];
const GRAM_KINDS = new Set(["vape", "flower", "preroll", "infused", "extract"]);
const CANNABIS_KINDS = new Set([...GRAM_KINDS, "edible", "beverage", "ingestible", "topical"]);

const FRUITY = new RegExp("strawberr|watermelon|melon|grape|berry|berries|peach|cherry|apple|lemonade|lemon|lime|mango|" +
  "raspberr|blueberr|punch|candy|gumm|cheesecake|vanilla|macchiato|\\bjam\\b|\\bbear\\b|orange|pineapple|" +
  "banana|tropical|fruit|coconut|tiger blood|razz|cola|\\bmint\\b|cream|passionfruit|guava|kiwi|" +
  "bubblegum|lemon|citrus|dessert|cookie dough|caramel|hazelnut|coffee|jelly|jolly|soda");
const NATURAL = new RegExp("live resin|live rosin|\\brosin\\b|cured resin|\\bfse\\b|full[- ]spectrum|cannabis[- ]derived terp|" +
  "unflavou?red|no added flavou?r|100% cannabis|all[- ]cannabis|\\bcdt\\b");

const sleep = ms => new Promise(r => setTimeout(r, ms));
function pyRound(x, n){
  // Python's round(): exact value, ties go to the even digit (5.125 -> 5.12), so figures match the cloud engine
  if (!isFinite(x)) return x;
  const [ip, fp] = Math.abs(x).toFixed(n + 25).split(".");
  const rest = fp.slice(n), half = "5" + "0".repeat(rest.length - 1);
  let base = BigInt(ip + fp.slice(0, n));
  if (rest > half || (rest === half && base % 2n === 1n)) base += 1n;
  const str = base.toString().padStart(n + 1, "0");
  const v = Number(n ? str.slice(0, -n) + "." + str.slice(-n) : str);
  return x < 0 ? -v : v;
}
const r1 = x => pyRound(x, 1);
const r2 = x => pyRound(x, 2);
const r3 = x => pyRound(x, 3);

// ---------------------------------------------------------------- fetching
async function getJSON(url, siteId){
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {headers: {"Accept": "application/vnd.api+json", "X-Store": siteId}});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
}

export async function fetchStore(siteId){
  let items = [], off = 0, total = null;
  const inc = new Map();
  const k = (t, id) => t + "|" + id;
  while (total === null || off < total) {
    const d = await getJSON(`${API}/v1/products/?limit=100&offset=${off}&delivery_type=pickup`, siteId);
    total = d.meta.total_count;
    items = items.concat(d.data);
    for (const i of d.included || []) inc.set(k(i.type, i.id), i);
    if (!d.data.length) break;
    off += 100;
  }
  const cats = await getJSON(`${API}/v2/products/categories/?limit=500`, siteId);
  for (const c of [...(cats.data || []), ...(cats.included || [])]) inc.set(k("product_categories", c.id), c);
  const seen = new Set(), out = [];
  for (const p of items) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  return {raw: out, inc, total};
}

// ---------------------------------------------------------------- shaping
const money = p => !p ? null : r2(p.amount / 100);
function num(x){
  if (x === null || x === undefined) return null;
  const v = typeof x === "object" ? parseFloat(x.amount) : parseFloat(x);
  return isNaN(v) ? null : v;
}
export const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function packCount(name){
  const m = /(\d+)\s*x\s*[\d.]+\s*(?:g|mg|ml)\b/i.exec(name) || /\bx\s*(\d+)\b/i.exec(name);
  return m ? parseInt(m[1]) : null;
}
function multipack(name){ const m = /multi-?pack of (\d+)/i.exec(name || ""); return m ? parseInt(m[1]) : 1; }
function nameGrams(name){
  name = name || "";
  let m = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g\b/i.exec(name);
  if (m) return r3(parseInt(m[1]) * parseFloat(m[2]));
  m = /(?<![\d.])(\d+(?:\.\d+)?)\s*g\b/i.exec(name);
  return m ? parseFloat(m[1]) : null;
}
function gramsOf(p, kind){
  if (!GRAM_KINDS.has(kind)) return null;
  const g = nameGrams(p.name);
  if (g) return g;
  if ((p.size_units || "").startsWith("gram") && p.size_amount) return p.size_amount;
  const m = /^([\d.]+)\s*gram/.exec(p.cannabis_weight || "");
  if (m) return r3(parseFloat(m[1]) / (["vape", "extract", "infused"].includes(kind) ? 4 : 1));
  return null;
}

const NUM = "\\d+(?:\\.\\d+)?";
const NAMES = "(?:THC|CBD|CBN|CBG|CBC)";
function nameRatio(name){
  const n = name || "";
  let m = new RegExp(`(${NUM}(?:\\s*:\\s*${NUM})+)\\s*(${NAMES}(?:\\s*[:/|]\\s*${NAMES})+)`, "i").exec(n);
  if (m) {
    const nums = m[1].split(/\s*:\s*/).map(parseFloat), names = m[2].split(/\s*[:/|]\s*/).map(x => x.toUpperCase());
    if (nums.length === names.length) return Object.fromEntries(names.map((k, i) => [k, nums[i]]));
  }
  m = new RegExp(`(${NAMES}(?:\\s*[:/|]\\s*${NAMES})+)\\s*(${NUM}\\s*(?:mg)?(?:\\s*:\\s*${NUM}\\s*(?:mg)?)+)`, "i").exec(n);
  if (m) {
    const names = m[1].split(/\s*[:/|]\s*/).map(x => x.toUpperCase()), nums = (m[2].match(new RegExp(NUM, "g")) || []).map(parseFloat);
    if (nums.length === names.length) return Object.fromEntries(names.map((k, i) => [k, nums[i]]));
  }
  let d = {};
  for (const x of n.matchAll(new RegExp(`\\b(${NAMES})\\s*(${NUM})(?=\\s*[:/|])|(?<=[:/|])\\s*(${NAMES})\\s*(${NUM})\\b`, "gi")))
    d[(x[1] || x[3]).toUpperCase()] = parseFloat(x[2] || x[4]);
  if (Object.keys(d).length >= 2) return d;
  d = {};
  for (const x of n.matchAll(new RegExp(`\\b(${NUM})\\s*(${NAMES})\\b(?=\\s*[:/|+])|(?<=[:/|+])\\s*(${NUM})\\s*(${NAMES})\\b`, "gi")))
    d[(x[2] || x[4]).toUpperCase()] = parseFloat(x[1] || x[3]);
  return Object.keys(d).length >= 2 ? d : null;
}
function nameMg(name, can){
  const n = name || "";
  let m = new RegExp(`(${NUM})\\s*mg\\s*${can}\\s*x\\s*(\\d+)`, "i").exec(n) || new RegExp(`\\b${can}\\s*(${NUM})\\s*mg\\s*x\\s*(\\d+)`, "i").exec(n);
  if (m) return parseFloat(m[1]) * parseInt(m[2]);
  m = new RegExp(`(${NUM})\\s*mg\\s*${can}\\b(?!\\s*[:/|])`, "i").exec(n);
  return m ? parseFloat(m[1]) : null;
}
function midOf(lo, hi, potMid){
  if (potMid) return potMid;
  if (lo || hi) return ((lo || hi) + (hi || lo)) / 2;
  return null;
}

export function derive(p){
  const cat = (p.category || "").toLowerCase();
  const kind = (KIND_BY_CATEGORY.find(([needle]) => cat.includes(needle)) || [null, "other"])[1];
  p.kind = kind;
  p.key = p.sku ? `sku:${p.sku}` : "n:" + norm(`${p.brand || ""} ${p.name || ""}`);
  p.price_eff = p.sale_price ? p.sale_price : p.price;
  const name = p.name || "";
  const lo = p.thc_min, hi = p.thc_max;
  const pot = p.potency || {};
  let mid = pot.thc || ((lo || hi) ? ((lo || hi) + (hi || lo)) / 2 : null);
  p.thc_mid = mid ? r2(mid) : null;
  let units = (p.potency_units || "").toLowerCase();
  const grams = gramsOf(p, kind);
  p.grams = grams;
  p.thc_source = mid ? "store" : null;
  p.thc_est = false;
  if (!mid && GRAM_KINDS.has(kind)) {
    // the store left THC blank: use what the product's own name or description states
    const text = `${name} ${p.description || ""}`;
    const mMg = /(\d{3,4})\s*mg\s*(?:of\s*)?THC\b/i.exec(text);
    const mPct = /(\d{2}(?:\.\d+)?)\s*%\s*THC\b/i.exec(text) || /\bTHC\s*:?\s*(\d{2}(?:\.\d+)?)\s*%/i.exec(text);
    const mPlus = ["vape", "extract"].includes(kind) ? /(?<![\d.])(\d{2})\s*\+(?!\s*\d)/.exec(name) : null;
    if (mMg && grams && 0 < parseFloat(mMg[1]) && parseFloat(mMg[1]) <= grams * 1000) mid = parseFloat(mMg[1]) / grams;
    else if (mPct && parseFloat(mPct[1]) >= 1 && parseFloat(mPct[1]) <= 100) mid = parseFloat(mPct[1]) * 10;
    else if (mPlus && parseInt(mPlus[1]) >= 50 && parseInt(mPlus[1]) <= 99) { mid = parseInt(mPlus[1]) * 10; p.thc_est = true; }
    if (mid) {
      mid = r1(mid); units = "mg/g";
      p.thc_min = p.thc_max = mid; p.potency_units = "mg/g"; p.thc_mid = mid; p.thc_source = "text";
    }
  }
  let total = null;
  if (mid) {
    if (GRAM_KINDS.has(kind)) total = (units === "mg/g" && grams) ? mid * grams : null;
    else if (kind === "edible" || kind === "beverage") {
      const n = multipack(name);
      if (n > 1 && mid <= 10.5) total = mid * n;
      else total = mid <= 10.5 * n ? mid : null;
    } else if (kind === "ingestible") {
      if (units === "mg/g" && p.size_amount) total = mid * p.size_amount;
      else if (units === "mg/unit" || units === "mg/capsule") { const c = packCount(name); total = c ? mid * c : null; }
    }
  }
  if (kind === "ingestible") {  // the name is more reliable than the feed when it states THC outright
    const m = /THC\s*(\d+(?:\.\d+)?)\s*mg\s*x\s*(\d+)/i.exec(name) || /(\d+(?:\.\d+)?)\s*mg\s*x\s*(\d+)\s*(?:softgels?|capsules?|caps)\b.*\bTHC\b/i.exec(name);
    const m2 = /(\d+(?:\.\d+)?)\s*mg\s*THC\b(?!\s*:)/i.exec(name);
    if (m) total = parseFloat(m[1]) * parseInt(m[2]);
    else if (m2) total = parseFloat(m2[1]);
    if (total && total > 1000) total = null;
  }
  p.thc_total_mg = total ? r1(total) : null;

  // --- CBD / CBN / CBG per package: store figures where given, else worked out from the name
  let cbdMid = midOf(p.cbd_min, p.cbd_max, pot.cbd);
  if (cbdMid !== null && cbdMid < 1) cbdMid = null;   // stores list "<1" as 0.1-0.5: trace, not a real amount
  const amounts = {THC: total}, src = {};
  if (cbdMid) {
    let cbdTotal = null;
    if (GRAM_KINDS.has(kind) && units === "mg/g" && grams) cbdTotal = cbdMid * grams;
    else if (["edible", "beverage", "topical"].includes(kind)) { const n = multipack(name); cbdTotal = cbdMid * ((n > 1 && mid && mid <= 10.5) ? n : 1); }
    else if (kind === "ingestible") {
      if (units === "mg/g" && p.size_amount) cbdTotal = cbdMid * p.size_amount;
      else if ((units === "mg/unit" || units === "mg/capsule") && packCount(name)) cbdTotal = cbdMid * packCount(name);
    }
    if (cbdTotal) amounts.CBD = cbdTotal;
  }
  for (const can of ["CBD", "CBN", "CBG", "THC"]) {
    if (can === "THC" && amounts.THC) continue;
    const v = ["edible", "beverage", "ingestible", "topical"].includes(kind) ? nameMg(name, can) : null;
    if (v && v <= 5000) { amounts[can] = v; src[can] = "name"; }
  }
  const ratio = nameRatio(name);
  if (ratio) {
    const base = ["THC", "CBD", "CBN", "CBG"].find(c => amounts[c] && ratio[c]);
    if (base) for (const [can, r] of Object.entries(ratio))
      if (["CBD", "CBN", "CBG"].includes(can) && !amounts[can] && r) { amounts[can] = amounts[base] * r / ratio[base]; src[can] = "name"; }
  }
  const has = ["CBD", "CBN", "CBG"].filter(c => amounts[c] || new RegExp(`\\b${c}\\b`, "i").test(name) || (ratio && ratio[c]));
  if (!p.thc_total_mg && amounts.THC && kind !== "topical") { p.thc_total_mg = r1(amounts.THC); total = amounts.THC; }
  p.cbd_total_mg = amounts.CBD ? r1(amounts.CBD) : null;
  p.cbn_total_mg = amounts.CBN ? r1(amounts.CBN) : null;
  p.cbg_total_mg = amounts.CBG ? r1(amounts.CBG) : null;
  p.cann_from_name = Object.keys(src).length ? Object.keys(src).sort() : null;
  const minor = ["CBN", "CBG"].filter(c => has.includes(c));
  p.minor = minor.length ? minor : null;
  // THC:CBD profile: compare concentrations when the store gives both, else package amounts
  const tAmt = amounts.THC, cAmt = amounts.CBD;
  let tRef, cRef;
  if (mid && cbdMid) { tRef = mid; cRef = cbdMid; }
  else { tRef = tAmt || (!cbdMid ? mid : null); cRef = cAmt; }
  const tiny = ["edible", "beverage", "topical"].includes(kind) && (tAmt || 0) < 2 && (cAmt || 0) < 2;
  let prof;
  if (!CANNABIS_KINDS.has(kind)) prof = null;
  else if (tiny) prof = has.includes("CBD") && !p.minor ? "CBD-dominant" : (p.minor ? "Minor cannabinoids" : null);
  else if (tRef && cRef) { const r = cRef / tRef; prof = r >= 2 ? "CBD-dominant" : (r >= 0.5 ? "Balanced" : "THC-dominant"); }
  else if (tRef) prof = "THC-dominant";
  else if (cRef || has.includes("CBD")) prof = "CBD-dominant";
  else prof = null;
  p.profile = prof;
  // CBD-focused / low-THC products are real but don't belong in a THC-value ranking
  const cbd = Math.max(0, ...[p.cbd_max, pot.max_cbd, pot.cbd].filter(v => v));
  const thcRef = hi || mid || 0;
  let low = false;
  if (["flower", "preroll", "infused"].includes(kind)) low = !!mid && thcRef < 100;
  else if (kind === "vape" || kind === "extract") low = !!mid && thcRef < 300;
  else if (kind === "edible" || kind === "beverage") low = !!mid && (total || 0) < 2;
  else if (kind === "ingestible") low = !!mid && units === "mg/g" && thcRef < 5;
  if (cbd && thcRef && cbd >= thcRef) low = true;
  if (p.profile === "CBD-dominant") low = true;
  if (/\bCBD\b/.test(name) && !/\bTHC\b/.test(name) && (!mid || thcRef < 100)) low = true;
  p.cbd_focused = low;
  if (low && p.profile === "THC-dominant") p.profile = has.includes("CBD") ? "CBD-dominant" : "Low THC";
  const pe = p.price_eff;
  p.per_gram = (pe && grams) ? r2(pe / grams) : null;
  p.per_100mg = (pe && total && total >= 1) ? r2(pe / total * 100) : null;
  for (const can of ["cbd", "cbn"]) {
    const t = p[`${can}_total_mg`];
    p[`per_100mg_${can}`] = (pe && t && t >= 1) ? r2(pe / t * 100) : null;
  }
  if (kind === "vape") {
    const text = `${p.name || ""} ${p.description || ""}`.toLowerCase();
    const sub = (p.subcategory || "").toLowerCase();
    const nm = (p.name || "").toLowerCase();
    p.vape_type = (sub.includes("disp") || nm.includes("disposable") || text.includes("all-in-one")) ? "Disposable" : "Cartridge";
    if (p.vape_type === "Disposable") p.hardware = text.includes("recharg") ? "Disposable (rechargeable)" : "Disposable";
    else if (nm.includes("pax")) p.hardware = "PAX pod";
    else if (text.includes("postless")) p.hardware = "510 (postless)";
    else p.hardware = "510";
    const ex = [[/liquid diamond/, "Liquid diamonds"], [/live rosin/, "Live rosin"], [/live resin/, "Live resin"],
      [/cured resin/, "Cured resin"], [/\bfse\b|full[- ]spectrum/, "Full spectrum"], [/distillate/, "Distillate"]].find(([rx]) => rx.test(text));
    p.extract = ex ? ex[1] : null;
    let fl;
    if (text.includes("botanical terp")) fl = "Added flavour";
    else if (NATURAL.test(text)) fl = "Natural terps";
    else if (FRUITY.test(text) || /flavou?r/.test(text)) fl = "Added flavour";
    else fl = "Unclear";
    p.flavour = fl;
  }
  return p;
}

export function flatten(raw, inc){
  const a = raw.attributes, rel = raw.relationships || {};
  const ref = k => { const d = (rel[k] || {}).data; return (d && typeof d === "object" && !Array.isArray(d)) ? inc.get(d.type + "|" + d.id) || null : null; };
  const cat = ref("category"), brand = ref("brand");
  let parent = null;
  if (cat && cat.attributes.parent_category_id) parent = inc.get("product_categories|" + cat.attributes.parent_category_id) || null;
  const tags = [];
  for (const t of ((rel.tags || {}).data || [])) { const ti = inc.get(t.type + "|" + t.id); tags.push(ti ? ti.attributes.name : t.id); }
  const pot = a.potency || {}, size = a.size || {}, cw = a.cannabis_weight || {};
  const clean = s => (s || "").trim() || null;
  const potency = Object.fromEntries(Object.entries(pot).filter(([, v]) => v));
  const p = {
    id: raw.id, name: clean(a.name), brand: clean(brand && brand.attributes.name),
    brand_id: brand ? brand.id : null,
    category: clean(((parent || cat || {}).attributes || {}).name),
    subcategory: (cat && parent) ? clean(cat.attributes.name) : null,
    flower_type: a.flower_type ?? null, strain: a.strain ?? null,
    size: size.display_text ?? null, size_amount: size.amount ?? null, size_units: size.units ?? null,
    cannabis_weight: cw.display_text ?? null,
    price: money(a.unit_price), sale_price: money(a.discount_price),
    on_sale: a.on_sale ?? null, discount: a.discount ?? null,
    weight_prices: a.weight_prices ?? null, unit_prices: a.unit_prices ?? null,
    thc_min: num(a.min_thc), thc_max: num(a.max_thc), cbd_min: num(a.min_cbd), cbd_max: num(a.max_cbd),
    potency_units: pot.units || (a.max_thc || {}).units || null,
    potency: Object.keys(potency).length ? potency : null,
    terpenoids: a.terpenoids ?? null,
    in_stock: a.in_stock ?? null, stock_qty: a.pos_inventory ?? null,
    sku: a.sku ?? null, external_id: a.external_id ?? null, type: a.type ?? null,
    is_promoted: a.is_promoted ?? null, tags,
    description: clean(a.description),
    image: a.main_image ?? null, url: a.store_url ?? null,
    site_updated_at: a.updated_at ?? null,
  };
  return derive(p);
}

// ---------------------------------------------------------------- diffing
export function localStamp(d){
  // "Tue Sep 29 2026 10:33 PM" in this computer's time zone (same shape as the cloud version)
  const W = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getHours(), pad = n => String(n).padStart(2, "0");
  return `${W[d.getDay()]} ${M[d.getMonth()]} ${pad(d.getDate())} ${d.getFullYear()} ${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
export function stampOf(d = new Date()){ return d.toISOString().slice(0, 16) + "Z"; }
function stampMinusDays(stamp, days){ return new Date(new Date(stamp.replace("Z", ":00Z")).getTime() - days * 864e5).toISOString().slice(0, 16) + "Z"; }

export function diffStore(prev, cur, stamp){
  const first = !Object.keys(prev).length;
  const ch = {new: [], returned: [], price: [], sale: [], removed: []};
  let merged = {};
  for (const [pid, p] of Object.entries(cur)) {
    const old = prev[pid];
    p.status = "listed";
    if (!old) {
      p.first_seen = stamp;
      p.price_history = [[stamp, p.price, p.sale_price]];
      if (!first) ch.new.push(p);
    } else {
      p.first_seen = old.first_seen || stamp;
      const ph = [...(old.price_history || [])];
      if (old.status === "gone") ch.returned.push(p);
      if ((old.price ?? null) !== p.price) { ch.price.push([old.price ?? null, p]); ph.push([stamp, p.price, p.sale_price]); }
      else if ((old.sale_price ?? null) !== p.sale_price) { ch.sale.push([old.sale_price ?? null, p]); ph.push([stamp, p.price, p.sale_price]); }
      p.price_history = ph.slice(-20);
    }
    merged[pid] = p;
  }
  for (const [pid, old0] of Object.entries(prev)) {
    if (pid in cur) continue;
    let old = old0;
    if (old.status !== "gone") { old = {...old, status: "gone", gone_since: stamp, in_stock: false}; ch.removed.push(old); }
    merged[pid] = old;
  }
  const cutoff = stampMinusDays(stamp, 90);
  merged = Object.fromEntries(Object.entries(merged).filter(([, v]) => !(v.status === "gone" && (v.gone_since || stamp) < cutoff)));
  return {merged, ch, first};
}

const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const kindRank = (a, b) => ((KIND_ORDER.indexOf(a.kind) + 1 || 100) - (KIND_ORDER.indexOf(b.kind) + 1 || 100)) || cmp(a.name || "", b.name || "");
const SLIM_KEYS = ["id", "key", "name", "brand", "kind", "category", "subcategory", "price", "sale_price", "thc_min",
  "thc_max", "potency_units", "size", "url", "vape_type", "flavour"];
const slim = (p, extra = {}) => ({...Object.fromEntries(SLIM_KEYS.map(k => [k, p[k] ?? null])), ...extra});
const g = x => String(+Number(x).toPrecision(6));
const usd = x => "$" + Number(x || 0).toFixed(2);

export function fmt(p){
  const head = [p.brand, p.name].filter(Boolean).join(" — ");
  const bits = [];
  if (p.subcategory || p.category) bits.push(p.subcategory || p.category);
  if (p.price !== null && p.price !== undefined) bits.push(usd(p.price) + (p.sale_price ? ` → sale ${usd(p.sale_price)}` : ""));
  if (p.thc_max) {
    const rng = (p.thc_min && p.thc_min !== p.thc_max) ? `${g(p.thc_min)}–${g(p.thc_max)}` : g(p.thc_max);
    bits.push(`THC ${rng} ${p.potency_units || ""}`.trim());
  }
  if (p.kind === "vape" && p.flavour) bits.push(p.flavour.toLowerCase());
  return `${head} [${bits.join(", ")}]`;
}

function watchAlerts(watch, name, ch, merged){
  const out = [];
  if (!watch || !Object.keys(watch).length) return out;
  const byKey = {};
  for (const p of Object.values(merged)) (byKey[p.key] = byKey[p.key] || []).push(p);
  for (const p of [...ch.new, ...ch.returned]) if (watch[p.key]) out.push(`Back on the menu at ${name}: ${fmt(p)}`);
  for (const [old, p] of ch.price) if (watch[p.key] && old !== null && (p.price || 0) < old) out.push(`Price drop at ${name}: ${fmt(p)} (was ${usd(old)})`);
  for (const [old, p] of ch.sale) if (watch[p.key] && p.sale_price && (old === null || p.sale_price < old)) out.push(`On sale at ${name}: ${fmt(p)}`);
  const changed = new Set([...ch.new, ...ch.returned, ...ch.price.map(x => x[1]), ...ch.sale.map(x => x[1])]);
  for (const [key, w] of Object.entries(watch)) {
    const tgt = w && w.target_price;
    if (!tgt) continue;
    for (const p of byKey[key] || [])
      if (p.status === "listed" && p.price_eff && p.price_eff <= tgt && changed.has(p)) out.push(`At or below your ${usd(tgt)} target at ${name}: ${fmt(p)}`);
  }
  return [...new Set(out)];
}

function ratedReturns(ratings, name, ch){
  const out = [];
  const liked = ratings.filter(e => (e.stars || 0) >= 4);
  if (!liked.length) return out;
  for (const p of [...ch.new, ...ch.returned]) {
    const text = norm(`${p.brand || ""} ${p.name || ""}`).replace(/-/g, " ");
    for (const e of liked) {
      let hit = false;
      if (e.key && e.key === p.key) hit = true;
      else if (e.match && (!e.kind || e.kind === p.kind)) hit = e.match.every(m => text.includes(norm(m).replace(/-/g, " ")));
      if (hit) { out.push(`You rated ${e.stars}★ (${e.name}), now on the menu at ${name}: ${fmt(p)}`); break; }
    }
  }
  return out;
}

/* One full check.
   state: {stores, catalogs:{slug:[products]}, meta:{slug:doc}, watch:{key:w}, ratings:[entries with stars]}
   returns {catalogs, metas, runs:{slug:runDoc}, summary, alerts, result} — nothing is saved here. */
export async function check(state, opts = {}){
  const now = opts.now || new Date();
  const stamp = stampOf(now);
  const local = localStamp(now);
  const stores = (state.stores && state.stores.length) ? state.stores : DEFAULT_STORES;
  const out = {catalogs: {}, metas: {}, runs: {}, alerts: [], result: {stores: {}}};
  const sections = [];
  for (const st of stores) {
    const slug = st.slug, sname = st.name || slug;
    let fetched;
    try { fetched = await fetchStore(st.site_id); }
    catch (e) { sections.push(`\n== ${sname}: CHECK FAILED (${e.message}) ==`); out.result.stores[slug] = {error: String(e.message)}; continue; }
    const cur = {};
    for (const r of fetched.raw) cur[String(r.id)] = flatten(r, fetched.inc);
    if (Object.keys(cur).length < Math.max(50, 0.5 * fetched.total)) {
      sections.push(`\n== ${sname}: CHECK FAILED (only ${Object.keys(cur).length} of ${fetched.total} products fetched) ==`);
      out.result.stores[slug] = {error: "partial fetch"}; continue;
    }
    const prev = Object.fromEntries((state.catalogs[slug] || []).map(p => [String(p.id), p]));
    const {merged, ch, first} = diffStore(prev, cur, stamp);
    out.catalogs[slug] = Object.values(merged).sort((a, b) => parseInt(a.id) - parseInt(b.id));
    const counts = Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, v.length]));
    const listedN = Object.keys(cur).length;
    out.runs[slug] = {at: stamp, local, store: slug, first_run: first, total_listed: listedN, api_total: fetched.total, counts,
      new: [...ch.new].sort(kindRank).map(p => slim(p)), returned: [...ch.returned].sort(kindRank).map(p => slim(p)),
      price_changes: ch.price.map(([o, p]) => slim(p, {old_price: o})), sale_changes: ch.sale.map(([o, p]) => slim(p, {old_sale_price: o})),
      removed: [...ch.removed].sort(kindRank).map(p => slim(p))};
    out.metas[slug] = {...(state.meta[slug] || {}), slug, name: sname, menu_url: st.menu_url || null, last_run: stamp,
      last_run_local: local, total_listed: listedN, last_counts: counts};
    out.alerts.push(...watchAlerts(state.watch || {}, sname, ch, merged), ...ratedReturns(state.ratings || [], sname, ch));
    const sec = [`\n== ${sname}: ${listedN} products listed ==`];
    if (first) sec.push("First check for this store: baseline saved.");
    const blocks = [["NEW PRODUCTS", [...ch.new].sort(kindRank), fmt], ["BACK ON THE MENU", [...ch.returned].sort(kindRank), fmt],
      ["PRICE CHANGES", ch.price, t => `${usd(t[0])} → ${usd(t[1].price)}: ${fmt(t[1])}`],
      ["SALE CHANGES", ch.sale, t => `${t[0] ? usd(t[0]) : "no sale"} → ${t[1].sale_price ? usd(t[1].sale_price) : "no sale"}: ${fmt(t[1])}`],
      ["GONE FROM MENU (sold out or delisted)", [...ch.removed].sort(kindRank), fmt]];
    let any = false;
    for (const [title, items, f] of blocks) if (items.length) { any = true; sec.push(`\n${title} (${items.length})`, ...items.map(x => `- ${f(x)}`)); }
    if (!first && !any) sec.push("No changes since the last check.");
    sections.push(...sec);
    out.result.stores[slug] = {listed: listedN, counts, first_run: first,
      new: [...ch.new].sort(kindRank).map(p => `${p.brand || ""} — ${p.name}`).slice(0, 40),
      returned: ch.returned.map(p => `${p.brand || ""} — ${p.name}`).slice(0, 40)};
  }
  const L = [`Country Cannabis menu check — ${local}`];
  out.alerts = [...new Set(out.alerts)];
  if (out.alerts.length) L.push(`\nALERTS FOR YOU (${out.alerts.length})`, ...out.alerts.map(a => `- ${a}`));
  L.push(...sections);
  out.summary = L.join("\n") + "\n";
  out.result.stamp = stamp;
  out.failed = Object.values(out.result.stores).length > 0 && Object.values(out.result.stores).every(v => v.error);
  return out;
}

// ---------------------------------------------------------------- pictures
const THUMB_QS_INLINE = "w=120&h=120&fit=max&fm=webp&q=55";
export const PLACEHOLDER = "/catalogue/categories/defaults/";
export const isPlaceholder = p => (p.image || "").includes(PLACEHOLDER);

async function dataURL(url, maxBytes){
  const r = await fetch(url, {headers: {"Accept": "image/webp,image/*;q=0.8"}});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 200 || buf.length > maxBytes) throw new Error(`picture size ${buf.length}`);
  let ctype = (r.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!ctype.startsWith("image/")) ctype = "image/jpeg";
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${ctype};base64,${btoa(bin)}`;
}

/* Small store pictures for listed products without one (placeholders are left to the photo matcher).
   media: {key: {src, data}} (changed in place). Returns number added. */
export async function thumbs(products, media, limit = 100){
  let n = 0;
  const seen = new Set();
  for (const p of products) {
    if (n >= limit) break;
    if (p.status === "gone" || !p.image || seen.has(p.key) || isPlaceholder(p)) continue;
    seen.add(p.key);
    const m = media[p.key];
    if (m && m.src === p.image && m.data) continue;
    try {
      media[p.key] = {src: p.image, data: await dataURL(p.image + (p.image.includes("?") ? "&" : "?") + THUMB_QS_INLINE, 300000)};
      n++;
    } catch (e) { /* a missing picture never fails a check */ }
  }
  return n;
}

// ---------------------------------------------------------------- photo matcher (see engine.py for the scoring notes)
const OCS_URL = "https://ocs.ca/products.json?limit=250&page=";
const MATCH_AUTO = 80, MATCH_ASK = 50, MATCH_RECHECK_DAYS = 7;
const MATCH_KINDS = new Set([...CANNABIS_KINDS, "seed"]);
const PICK_W = 200, CAND_W = 120;
const FORMAT_WORDS = new Set(`pre roll rolls preroll prerolls joint joints blunt blunts vape vapes cartridge cartridges catridge cart
  carts prefilled prefill disposable pod pods soft chew chews gummy gummies x g mg ml pk pack packs pc pcs piece pieces
  of the and by with a an thc cbd cbn cbg cbc thcv reg regular fem feminized seeds seed dried flower whole milled infused
  edible edibles multipack multi indica sativa hybrid blend bath bomb salts oil capsules caps softgels spray`.split(/\s+/));
const VENDOR_SUFFIX = /\s+(?:cannabis|co|company|inc|ltd|corp|brands?|labs?)$/;
const OCS_KIND_RX = [["infused", /infused/], ["preroll", /pre-?\s?rolls?|preroll|\bjoints?\b|\bblunts?\b/],
  ["vape", /vape|cartridge|\b510\b|disposable|\bpods?\b/],
  ["edible", /gumm|chew|chocolate|edible|cookie|baked|candy|\bmints?\b|\bbites?\b|caramel|lozenge/],
  ["beverage", /beverage|drink|soda|sparkling|seltzer|\btea\b|\bshots?\b/],
  ["ingestible", /\boils?\b|capsule|softgel|spray|tincture|ingestible/],
  ["topical", /topical|\bbath\b|lotion|balm|cream|salve/], ["seed", /\bseeds?\b/],
  ["extract", /hash|rosin|shatter|\bwax\b|kief|concentrate|extract|diamonds?|budder|badder|sauce/],
  ["flower", /flower|dried|whole bud|milled|ground/]];
const OCS_SUBCAT = {"pre-rolls": "preroll", "dried flower": "flower", "seeds": "seed", "510 thread cartridges": "vape",
  "disposable pens": "vape", "soft chews": "edible", "chocolates": "edible", "baked goods": "edible",
  "hard edibles": "edible", "pantry": "edible", "beverages": "beverage", "capsules": "ingestible",
  "oils": "ingestible", "sublingual strips": "ingestible", "distillates": "extract", "hash and kief": "extract",
  "isolates": "extract", "resin": "extract", "rosin": "extract", "shatter": "extract", "wax": "extract",
  "bath and shower": "topical", "creams and lotions": "topical", "intimacy oils": "topical",
  "transdermal": "topical", "vaporizers": "accessory", "bongs pipes and rigs": "accessory",
  "grinders": "accessory", "rolling papers cones and filters": "accessory"};
const COMPAT = {infused: "preroll"};

const toks = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const distinctTokens = s => new Set(toks(s).filter(t => t.length > 1 && !FORMAT_WORDS.has(t) && !/\d/.test(t)));
function near(a, b){
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== b[j]) { if (++diff > 1) return false; if (a.length === b.length) i++; j++; }
    else { i++; j++; }
  }
  return diff + (b.length - j) + (a.length - i) <= 1;
}
const ratios = s => new Set((s || "").match(/\d+(?:\.\d+)?(?:\s*:\s*\d+(?:\.\d+)?)+/g) || []);
function sizes(s){
  s = (s || "").toLowerCase();
  const rx = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g\b/g;
  const out = new Set([...s.matchAll(rx)].map(m => `${parseInt(m[1])}x${g(m[2])}`));
  for (const m of s.replace(rx, " ").matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*g\b/g)) out.add(`${g(m[1])}g`);
  return out;
}
function ocsKind(o){
  for (const t of o.tags || []) if (t.toLowerCase().startsWith("subcategory--")) {
    const k = OCS_SUBCAT[t.slice(13).trim().toLowerCase()];
    if (k) return k === "preroll" && /infused/i.test(o.t || "") ? "infused" : k;
  }
  for (const text of [o.pt || "", o.t || "", (o.tags || []).join(" ")]) {
    const k = OCS_KIND_RX.find(([, rx]) => rx.test(text.toLowerCase()));
    if (k) return k[0];
  }
  return null;
}
function vnorm(v){
  const full = toks(v).join(" ");
  const strip = full.replace(VENDOR_SUFFIX, "");
  return [full, (strip !== full && strip.length >= 4) ? strip : null];
}

/* The OCS public catalog, slimmed to what matching needs. onPage(n) is called after each page (keeps a worker awake). */
export async function fetchOCS(onPage = () => {}, maxPages = 60){
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let batch;
    for (let attempt = 0; ; attempt++) {
      try { const r = await fetch(OCS_URL + page, {headers: {"Accept": "application/json"}}); if (!r.ok) throw new Error(`HTTP ${r.status}`); batch = (await r.json()).products || []; break; }
      catch (e) { if (attempt === 2) throw e; await sleep(3000 * (attempt + 1)); }
    }
    if (!batch.length) break;
    for (const o of batch) {
      const imgs = (o.images || []).map(i => i.src).filter(Boolean);
      if (!imgs.length) continue;
      out.push({h: o.handle, t: o.title || "", v: o.vendor || "", pt: o.product_type || "",
        tags: (o.tags || []).filter(t => /^subcategory--/i.test(t)),
        opts: (o.variants || []).map(v => v.title || "").join(" "), src: imgs[0]});
    }
    await onPage(page);
    await sleep(500);
  }
  return out;
}

function prepOCS(ocs){
  const vendors = new Set();
  for (const o of ocs) {
    [o._vf, o._vs] = vnorm(o.v);
    o._kind = ocsKind(o);
    o._sizes = sizes(`${o.t} ${o.opts || ""}`);
    o._ratios = ratios(o.t);
    o._T = distinctTokens(o.t);
    if (o._vf) vendors.add(o._vf);
    if (o._vs) vendors.add(o._vs);
  }
  return vendors;
}
function vendorHits(p, vendors){
  const hay = " " + toks(`${p.brand || ""} ${p.name || ""}`).join(" ") + " ";
  return new Set([...vendors].filter(v => v && hay.includes(` ${v} `)));
}
function scoreMatch(p, o, vh){
  let b = 0;
  if (vh.size) b = (vh.has(o._vf) || (o._vs && vh.has(o._vs))) ? 35 : -15;
  const drop = new Set([...[...vh].flatMap(v => v.split(" ")), ...o._vf.split(" ")]);
  const D = [...p._D].filter(t => !drop.has(t)), T = [...o._T].filter(t => !drop.has(t));
  const hit = D.filter(d => T.some(t => near(d, t))).length;
  const dice = (D.length && T.length) ? 2 * hit / (D.length + T.length) : 0;
  const clash = (D.length && T.length && !hit) ? -15 : 0;
  let k = 0;
  if (o._kind) k = (COMPAT[o._kind] || o._kind) === (COMPAT[p.kind] || p.kind) ? 10 : -40;
  const ps = sizes(p.name);
  const s = [...ps].some(x => o._sizes.has(x)) ? 10 : 0;
  const pr = ratios(p.name);
  const r = (pr.size && o._ratios.size) ? ([...pr].some(x => o._ratios.has(x)) ? 5 : -15) : 0;
  return [r1(Math.min(100, b + 45 * dice + k + s + r + clash)), dice, k, b];
}
function matchOne(p, ocs, vendors){
  const vh = vendorHits(p, vendors);
  p = {...p, _D: distinctTokens(p.name)};
  const scored = [];
  for (const o of ocs) {
    const [sc, dice, k, b] = scoreMatch(p, o, vh);
    if (k < 0) continue;                      // wrong format (a vape is never matched to a gummy)
    if (sc >= 35 || (dice >= 0.6 && b >= 0)) scored.push([sc, dice, o]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const cands = [], seen = new Set();
  for (const x of scored) {
    const o = x[2], same = o._vf + "|" + toks(o.t).join(" ");   // OCS sometimes lists one product twice
    if (seen.has(o.src) || seen.has(same)) continue;
    seen.add(o.src); seen.add(same);
    cands.push(x);
    if (cands.length === 3) break;
  }
  if (!cands.length) return ["none", 0, []];
  const best = cands[0];
  const ambiguous = cands.length > 1 && cands[1][0] >= MATCH_AUTO && best[0] - cands[1][0] < 5;
  let st;
  if (best[0] >= MATCH_AUTO && best[1] >= 0.6 && !ambiguous) st = "auto";
  else if (best[0] >= MATCH_ASK || cands.some(c => c[1] >= 0.6)) st = "ask";   // includes the strain-only fallback
  else return ["none", best[0], []];
  return [st, best[0], cands];
}
const shopifyThumb = (src, w) => dataURL(src + (src.includes("?") ? "&" : "?") + `width=${w}`, 120000);

/* Match placeholder pictures. matches: {key: entry} and overrides: {key: {h, stock}} (matches changed in place).
   getOCS() returns the (cached) OCS catalog. Returns counts for the report. */
export async function photos(products, matches, overrides, getOCS, opts = {}){
  const now = opts.now || new Date(), stamp = stampOf(now), recheck = stampOf(new Date(now.getTime() - MATCH_RECHECK_DAYS * 864e5));
  const prods = products.filter(p => p.status !== "gone" && MATCH_KINDS.has(p.kind) && (isPlaceholder(p) || (overrides[p.key] || {}).stock));
  const todoMap = new Map();
  for (const p of prods) {
    const e = matches[p.key];
    if (!e || ((e.st === "none" || e.st === "ask") && (e.at || "") < recheck)) todoMap.set(p.key, p);
  }
  const todo = [...todoMap.values()].slice(0, opts.limit || 150);
  const counts = {auto: 0, ask: 0, none: 0, thumb_errors: 0, checked: todo.length};
  if (todo.length) {
    const ocs = await getOCS();
    const vendors = prepOCS(ocs);
    for (const p of todo) {
      const [st, sc, cands] = matchOne(p, ocs, vendors);
      const old = matches[p.key] || {};
      const entry = {st, sc, sku: p.sku, name: p.name, at: stamp, cands: []};
      for (let i = 0; i < cands.length; i++) {
        const o = cands[i][2];
        const c = {h: o.h, t: o.t, v: o.v, s: cands[i][0], src: o.src};
        try { c.th = await shopifyThumb(o.src, (i === 0 && st === "auto") ? PICK_W : CAND_W); }
        catch (e) { counts.thumb_errors++; continue; }
        entry.cands.push(c);
        if (opts.onStep) await opts.onStep();
      }
      if (st === "auto") {
        if (entry.cands.length && entry.cands[0].h === cands[0][2].h) entry.pick = entry.cands[0];
        else entry.st = entry.cands.length ? "ask" : "none";
      }
      if (cands.length && !entry.cands.length) continue;   // pictures couldn't be downloaded: try again next run
      if (old.man) entry.man = old.man;
      counts[entry.st]++;
      matches[p.key] = entry;
    }
  }
  // the owner's manual choices: fetch a full-size picture for the chosen candidate once
  for (const [key, ov] of Object.entries(overrides)) {
    const h = ov && ov.h, e = matches[key];
    if (!e || !h || h === "none" || (e.man && e.man.h === h)) continue;
    const c = (e.cands || []).find(c => c.h === h);
    if (!c) continue;
    try { matches[key] = {...e, man: {h, th: await shopifyThumb(c.src, PICK_W)}}; } catch (err) { counts.thumb_errors++; }
  }
  const live = prods.map(p => matches[p.key] || {});
  counts.placeholders = prods.length;
  counts.totals = Object.fromEntries(["auto", "ask", "none"].map(s => [s, live.filter(e => e.st === s).length]));
  counts.manual = prods.filter(p => (overrides[p.key] || {}).h).length;
  const t = counts.totals;
  counts.line = prods.length ? `Photos: ${prods.length} products have only a placeholder picture; ${t.auto} matched automatically, ${t.ask} waiting for a pick, ${t.none} with no close match${counts.manual ? `, ${counts.manual} picked by hand` : ""}.` : "";
  return counts;
}
