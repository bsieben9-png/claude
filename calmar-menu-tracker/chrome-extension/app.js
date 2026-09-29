/* ============ constants ============ */
const CHECK_TRIGGER = "trig_01GL26Mw1izqanqKiY7opQ6A";
const KIND_LABEL = {vape:"Vapes",flower:"Flower",preroll:"Pre-rolls",infused:"Infused pre-rolls",extract:"Hash & concentrates",edible:"Edibles",beverage:"Beverages",ingestible:"Oils & capsules",topical:"Topicals",seed:"Seeds",accessory:"Accessories",apparel:"Apparel",other:"Other"};
const KIND_ORDER = Object.keys(KIND_LABEL);
const CANNABIS = new Set(["vape","flower","preroll","infused","extract","edible","beverage","ingestible"]);
const GRAMKIND = new Set(["vape","flower","preroll","infused","extract"]);
const PER10 = new Set(["edible","beverage"]);
const PACKAGED = new Set(["edible","beverage","ingestible","topical"]);
const METRICS = {thc: {label: "THC", field: "per_100mg"}, cbd: {label: "CBD", field: "per_100mg_cbd"}, cbn: {label: "CBN", field: "per_100mg_cbn"}};
const VIEWS = [["menu","Menu"],["watch","Watchlist"]];        // the change log is reached from the footer
const ALL_VIEWS = ["menu","watch","changes"];
const BELL = '<svg class="bell" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';

/* ============ state ============ */
const S = {
  stores: [], storesSig: "", slug: null, meta: {}, catalogs: {}, runs: {}, subs: {}, media: {}, matches: {}, pickOpen: new Set(),
  db: null, uid: null, isOwner: false, canSave: false, userResolved: false, mcp: null,
  watch: {items:{}}, ratings: {v:2, items:{}}, ratingsLoaded: false, attachDone: false, checkReq: null,
  view: "menu", open: new Set(), shown: 60,
  f: { q:"", kind:"", sort:"value", fresh:false, gone:false, rated:"", facets:{},
       chHide:true }
};
(function initialView(){
  let v = null; try { v = localStorage.getItem("ccs.view"); } catch(e) {}
  const h = location.hash.slice(1);
  if (h === "vapes") { S.view = "menu"; S.f.kind = "vape"; return; }
  if (h === "ratings") { S.view = "menu"; S.f.rated = "rated"; S.f.sort = "rating"; return; }
  if (h === "value") { S.view = "menu"; return; }
  if (ALL_VIEWS.includes(h)) { S.view = h; return; }
  if (v === "vapes") { S.view = "menu"; S.f.kind = "vape"; }
  else if (v === "ratings") { S.view = "menu"; S.f.rated = "rated"; S.f.sort = "rating"; }
  else if (v === "watch") S.view = v;
})();

/* ============ helpers ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : null;
const money = v => v == null || isNaN(v) ? "—" : "$" + Number(v).toFixed(2);
const toDate = st => new Date(String(st).replace(/T(\d\d)(\d\d)Z$/, "T$1:$2Z"));
const day = st => { const d = st && toDate(st); return d && !isNaN(d) ? d.toLocaleDateString(undefined,{month:"short",day:"numeric"}) : ""; };
const when = st => { const d = st && toDate(st); return d && !isNaN(d) ? d.toLocaleString(undefined,{weekday:"short",hour:"numeric",minute:"2-digit"}) : ""; };
const stampNow = () => new Date().toISOString().slice(0,16) + "Z";
const daysAgo = n => new Date(Date.now() - n*864e5).toISOString().slice(0,16) + "Z";
const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const slugify = s => norm(s).replace(/ /g,"-").slice(0,120) || "item";
const starsText = n => n ? "★".repeat(n) + "☆".repeat(5-n) : "";

/* ============ search: every word must match somewhere (any order), with synonyms and small typos ============ */
const PHRASES = [[/\bpre\s+rolls?\b/g, "preroll"], [/\bsoft\s+chews?\b/g, "gummy"]];
const SYN = {prerolls:"preroll", joint:"preroll", joints:"preroll", cart:"cart", carts:"cart", cartridge:"cart", cartridges:"cart", "510":"cart",
  gummy:"gummy", gummies:"gummy", chew:"gummy", chews:"gummy", disty:"distillate", distillates:"distillate"};
function searchTokens(s){
  let t = norm(String(s ?? "").replace(/['’`]/g, ""));   // shred'ems = shredems
  for (const [rx, to] of PHRASES) t = t.replace(rx, to);
  return t ? t.split(" ").map(w => SYN[w] || w) : [];
}
function editWithin(a, b, max){
  // true when a and b differ by at most max single-letter edits
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}
function wordHits(w, hay){
  const max = /\d/.test(w) ? 0 : w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;   // numbers and SKUs must match exactly
  return hay.some(h => h.includes(w) || (max && editWithin(w, h, max)));
}
const HAY = new WeakMap();
function searchQuery(q){ return [...new Set(searchTokens(q))]; }
function textMatches(words, text){ const hay = searchTokens(text); return words.every(w => wordHits(w, hay)); }
function productMatches(p, words){
  if (!words.length) return true;
  let hay = HAY.get(p);
  if (!hay) { hay = searchTokens([p.name, p.brand, p.sku, p.category, p.subcategory, p.flower_type].join(" ")); HAY.set(p, hay); }
  return words.every(w => wordHits(w, hay));
}

function products(slug = S.slug){ return S.catalogs[slug] || []; }
function listed(slug){ return products(slug).filter(p => p.status !== "gone"); }
function baseline(slug = S.slug){ const r = (S.runs[slug]||[]).find(r => r.first_run); return r ? r.at : null; }
function isNew(p){ return p.status !== "gone" && (p.first_seen||"") >= daysAgo(7) && p.first_seen !== baseline(); }
function watched(key){ return !!S.watch.items[key]; }
/* ============ matched photos (placeholder pictures replaced with an OCS catalog photo) ============ */
const PLACEHOLDER = "/catalogue/categories/defaults/";
function isStockFlagged(p, slug = S.slug){ return !!(((S.matches[slug] || {}).overrides || {})[p.key] || {}).stock; }
function isPlaceholder(p, slug = S.slug){ return !!p && ((p.image || "").includes(PLACEHOLDER) || isStockFlagged(p, slug)); }
function matchEntry(p, slug = S.slug){ return isPlaceholder(p, slug) ? ((S.matches[slug] || {}).items || {})[p.key] || null : null; }
function photoOverride(p, slug = S.slug){ return ((S.matches[slug] || {}).overrides || {})[p.key] || null; }
const okData = u => typeof u === "string" && /^data:image\/(webp|jpeg|png|gif);base64,/.test(u) ? u : null;
function matchedPhoto(p, slug = S.slug){
  // {src, how: "auto"|"manual", c: candidate} or null; the owner's choice wins over the automatic one
  const e = matchEntry(p, slug); if (!e) return null;
  const ov = photoOverride(p, slug);
  if (ov && ov.h) {
    if (ov.h === "none") return null;
    const c = (e.cands || []).find(c => c.h === ov.h);
    const src = okData(e.man && e.man.h === ov.h ? e.man.th : null) || okData(c && c.th);
    return src ? {src, how: "manual", c} : null;
  }
  if (e.st === "auto" && e.pick) { const src = okData(e.pick.th); return src ? {src, how: "auto", c: e.pick} : null; }
  return null;
}
function imgSrc(p, slug = S.slug){
  const mp = matchedPhoto(p, slug); if (mp) return mp.src;
  // pictures are either uploaded files (id -> /_blob/<id>) or kept inline as data: URIs
  const e = p && (S.media[slug] || {})[p.key];
  if (!e) return null;
  if (e.data && /^data:image\//.test(e.data)) return e.data;
  if (e.id && /^[0-9a-f]{32}$/.test(e.id)) return "/_blob/" + e.id;
  return null;
}
function thumbHTML(p, cls = "thumb"){
  const src = imgSrc(p);
  return `<span class="${cls}" aria-hidden="true">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;
}
function productByKey(key, slug = S.slug){ return products(slug).find(p => p.key === key && p.status !== "gone") || products(slug).find(p => p.key === key); }
function effPrice(p){ return p.price_eff ?? p.sale_price ?? p.price; }
function thcText(p){
  if (p.thc_max == null && p.thc_min == null) return "";
  const u = p.potency_units || "";
  if (p.thc_est) return `THC ${p.thc_min}+ ${u}`;
  return (p.thc_min != null && p.thc_min !== p.thc_max) ? `THC ${p.thc_min}–${p.thc_max} ${u}` : `THC ${p.thc_max ?? p.thc_min} ${u}`;
}
function cbdText(p){ return p.cbd_max ? `CBD ${p.cbd_min != null && p.cbd_min !== p.cbd_max ? p.cbd_min + "–" : ""}${p.cbd_max} ${p.potency_units||""}` : ""; }
function gramsText(p){ return p.grams ? `${+Number(p.grams).toFixed(2)} g` : (p.size || ""); }
function valueOf(p, metric = "thc", per10 = PER10.has(p.kind)){
  const v = metric === "gram" ? p.per_gram : p[METRICS[metric].field];
  return v == null ? null : (metric !== "gram" && per10 ? v / 10 : v);
}
function valueUnit(metric, per10){ return metric === "gram" ? "/g" : `${per10 ? "/10mg" : "/100mg"} ${METRICS[metric].label}`; }
function thcValue(p){ return valueOf(p, "thc"); }
function thcValueUnit(p){ return valueUnit("thc", PER10.has(p.kind)); }
const mg = v => v == null ? "" : `${v >= 100 ? Math.round(v) : +Number(v).toFixed(1)} mg`;
function cannMeta(p){
  // per-package amounts for packaged goods; concentrations + minor cannabinoids for smokables/vapes
  if (PACKAGED.has(p.kind)) {
    return [p.thc_total_mg != null ? `THC ${mg(p.thc_total_mg)}` : thcText(p), p.cbd_total_mg != null ? `CBD ${mg(p.cbd_total_mg)}` : "",
            p.cbn_total_mg != null ? `CBN ${mg(p.cbn_total_mg)}` : "", p.cbg_total_mg != null ? `CBG ${mg(p.cbg_total_mg)}` : ""];
  }
  return [thcText(p), p.cbd_max >= 1 ? cbdText(p) : "", p.cbn_total_mg != null ? `CBN ${mg(p.cbn_total_mg)}` : "", p.cbg_total_mg != null ? `CBG ${mg(p.cbg_total_mg)}` : ""];
}
function strainOf(p){
  const t = `${p.flower_type||""} ${p.subcategory||""}`.toLowerCase();
  return /indica/.test(t) ? "Indica" : /sativa/.test(t) ? "Sativa" : /hybrid|blend/.test(t) ? "Hybrid" : /cbd/.test(t) ? "CBD" : null;
}
function packOf(p){ const m = (p.name||"").match(/(\d+)\s*x\s*[\d.]+\s*g/i); return m ? (+m[1] === 1 ? "Single" : `${m[1]}-pack`) : null; }

/* ============ per-category filters ============ */
const PROFILE = ["Cannabinoids", p => p.profile || "Not listed"];
const MINOR = ["CBN / CBG", p => p.minor ? p.minor.join(" + ") : "Neither"];
const FOCUS = PROFILE;
const FACETS = {
  vape: [["Type", p => p.vape_type], ["Hardware", p => p.hardware], ["Extract", p => p.extract || "Not stated"], ["Flavour", p => p.flavour], ["Strain", strainOf], FOCUS, MINOR],
  flower: [["Size", gramsText], ["Strain", strainOf], ["Form", p => /milled/i.test(p.category||"") ? "Milled" : "Whole flower"], FOCUS],
  preroll: [["Pack", packOf], ["Size", gramsText], ["Strain", strainOf], FOCUS],
  infused: [["Pack", packOf], ["Strain", strainOf]],
  extract: [["Type", p => (p.category||"").replace(/\s*-\s*Extracts Inhaled/i,"").replace(/^other /i,"Other ")], ["Size", gramsText], ["Strain", strainOf]],
  edible: [["Type", p => p.subcategory || "Other"], ["Pack", p => /multi-?pack/i.test(p.name||"") ? "Multipack" : "Single package"], FOCUS, MINOR],
  beverage: [["Pack", p => /multi-?pack/i.test(p.name||"") ? "Multipack" : "Single"], FOCUS, MINOR],
  ingestible: [["Form", p => /caps|soft ?gel|tablet/i.test(`${p.name} ${p.category}`) ? "Capsules & tablets" : "Oil or spray"], FOCUS, MINOR],
  topical: [["Type", p => p.subcategory || "Other"], PROFILE, MINOR],
  "": [PROFILE, MINOR],
  accessory: [["Type", p => p.subcategory || "Other"]],
  apparel: [["Type", p => p.subcategory || "Other"]],
};
function facetsFor(kind){ return FACETS[kind] || []; }
const facetTitle = kind => kind ? `${KIND_LABEL[kind]} filters` : "Cannabinoid filters";
function facetMatch(p, kind, sel){
  return facetsFor(kind).every(([label, get]) => !sel[label] || (get(p) ?? "—") === sel[label]);
}
function facetsHTML(kind, sel, pool, prefix){
  const fs = facetsFor(kind); if (!fs.length) return "";
  const parts = fs.map(([label, get], i) => {
    const counts = new Map();
    pool.forEach(p => { const v = get(p) ?? "—"; counts.set(v, (counts.get(v)||0) + 1); });
    if (counts.size < 2 && !sel[label]) return "";
    let vals = [...counts.keys()];
    vals.sort((a,b) => { const na = parseFloat(a), nb = parseFloat(b); return (!isNaN(na) && !isNaN(nb)) ? na - nb : a === "—" ? 1 : b === "—" ? -1 : String(a).localeCompare(String(b)); });
    return `<select id="${prefix}-${i}" data-facet="${esc(label)}" data-scope="${prefix}" aria-label="${esc(label)}"><option value="">Any ${esc(/[A-Z]{2}/.test(label) ? label : label.toLowerCase())}</option>${vals.map(v => `<option value="${esc(v)}" ${sel[label]===v?"selected":""}>${esc(v === "—" ? "Not listed" : v)} (${counts.get(v)})</option>`).join("")}</select>`;
  }).filter(Boolean);
  return parts.length ? `<div class="facets"><span class="flbl">${esc(facetTitle(kind))}</span>${parts.join("")}${Object.values(sel).some(Boolean) ? `<button class="linkbtn" data-act="clearfacets" data-scope="${prefix}">Clear</button>` : ""}</div>` : "";
}

/* ============ ratings (per person, private) ============ */
// items: { id: {stars, notes, name, brand, kind, key|null, match:[phrases]|null, updated} }
let RIDX = null;
function buildRatingIndex(){
  const byKey = new Map(), loose = [];
  for (const [id, e] of Object.entries(S.ratings.items || {})) {
    if (!e || (!e.stars && !(e.notes||"").trim())) continue;
    if (e.key) byKey.set(e.key, id);
    else if (e.match && e.match.length) loose.push([id, e]);
  }
  const prodMatch = new Map();
  for (const st of S.stores) for (const p of products(st.slug)) {
    if (byKey.has(p.key)) { prodMatch.set(p.key, byKey.get(p.key)); continue; }
    const text = norm(`${p.brand||""} ${p.name||""}`);
    const hit = loose.find(([, e]) => (!e.kind || e.kind === p.kind) && e.match.every(m => text.includes(norm(m))));
    if (hit) prodMatch.set(p.key, hit[0]);
  }
  const attached = new Set(prodMatch.values());
  RIDX = {prodMatch, attached};
}
function ratingIdFor(p){ if (!RIDX) buildRatingIndex(); return RIDX.prodMatch.get(p.key) || null; }
function ratingFor(p){ const id = ratingIdFor(p); return id ? S.ratings.items[id] : null; }
function starsFor(p){ return ratingFor(p)?.stars || null; }
function isRated(p){ const r = ratingFor(p); return !!(r && (r.stars || (r.notes||"").trim())); }
function offMenuRatings(){
  if (!RIDX) buildRatingIndex();
  const onMenuNow = new Set();
  for (const p of listed(S.slug)) { const id = RIDX.prodMatch.get(p.key); if (id) onMenuNow.add(id); }
  return Object.entries(S.ratings.items || {}).filter(([id, e]) => e && (e.stars || (e.notes||"").trim()) && !onMenuNow.has(id));
}
function autoAttach(){
  // an off-menu rating that now matches exactly one listed product gets pinned to it
  if (S.attachDone || !S.canSave || !S.ratingsLoaded || !S.stores.length || S.stores.some(st => !S.catalogs[st.slug])) return;
  S.attachDone = true;
  let changed = false;
  for (const [id, e] of Object.entries(S.ratings.items)) {
    if (e.key || !e.match || !e.match.length) continue;
    const hits = S.stores.flatMap(st => listed(st.slug)).filter(p => (!e.kind || e.kind === p.kind) && e.match.every(m => norm(`${p.brand||""} ${p.name||""}`).includes(norm(m))));
    const keys = [...new Set(hits.map(p => p.key))];
    if (keys.length === 1 && !S.ratings.items[keys[0]]) {
      const p = hits[0];
      S.ratings.items[keys[0]] = {...e, key: p.key, name: p.name, brand: p.brand || e.brand, match: null, was: e.name, updated: stampNow()};
      delete S.ratings.items[id]; changed = true;
    }
  }
  if (changed) { RIDX = null; save("ratings"); }
}
function ensureRating(p){
  let id = ratingIdFor(p);
  if (!id) { id = p.key; S.ratings.items[id] = {stars: null, notes: "", name: p.name, brand: p.brand || "", kind: p.kind, key: p.key, match: null, updated: stampNow()}; RIDX = null; }
  return id;
}

/* ============ rendering: rows ============ */
function pills(p){
  const st = starsFor(p);
  return (isNew(p) ? '<span class="pill p-new">New</span>' : "")
    + (p.status === "gone" ? '<span class="pill p-gone">Gone</span>' : "")
    + (p.sale_price ? '<span class="pill p-sale">Sale</span>' : "")
    + (p.profile && p.profile !== "THC-dominant" ? `<span class="pill p-cbd">${esc(p.profile)}</span>` : "")
    + (p.minor && p.minor.includes("CBN") ? '<span class="pill p-cbd">CBN</span>' : "")
    + (st ? `<span class="pill p-rate" title="Your rating">${st}★</span>` : (isRated(p) ? '<span class="pill p-rate">Noted</span>' : ""));
}
function defaultMeta(p){
  if (p.kind === "vape") return [`${p.vape_type || "Vape"}${p.hardware && p.hardware !== "Disposable" ? " · " + p.hardware : ""}`, p.extract,
    {h: `<span class="pill ${p.flavour === "Natural terps" ? "p-nat" : "p-flav"}" style="margin:0">${esc(p.flavour||"Unclear")}</span>`},
    strainOf(p), gramsText(p), p.thc_total_mg ? `${Math.round(p.thc_total_mg)}${p.thc_est ? "+" : ""} mg THC` : thcText(p), p.cbn_total_mg ? `CBN ${mg(p.cbn_total_mg)}` : "", p.cbg_total_mg ? `CBG ${mg(p.cbg_total_mg)}` : ""];
  const sub = p.subcategory || p.category || "";
  const strain = GRAMKIND.has(p.kind) ? strainOf(p) : null;   // stores tag every edible "Hybrid"; only meaningful for smokables
  return [sub, strain && !sub.toLowerCase().includes(strain.toLowerCase()) ? strain : "", GRAMKIND.has(p.kind) ? gramsText(p) : p.size,
          ...cannMeta(p), GRAMKIND.has(p.kind) && p.kind !== "vape" && p.per_gram ? `${money(p.per_gram)}/g` : ""];
}
function priceHTML(p){
  const per10 = PER10.has(p.kind);
  const want = S.f.sort === "cbd" || S.f.sort === "cbn" ? S.f.sort : null;
  const m = want ? (valueOf(p, want) != null ? want : null)
    : (!p.cbd_focused && p.per_100mg != null ? "thc" : p.per_100mg_cbd != null ? "cbd" : p.per_100mg_cbn != null ? "cbn" : null);
  const v = m ? valueOf(p, m) : null;
  const le = m === "thc" && p.thc_est ? "≤" : "";
  return `${p.sale_price ? `<s>${money(p.price)}</s>${money(p.sale_price)}` : money(p.price)}${v != null ? `<small>${le}${money(v)}${valueUnit(m, per10).replace(" THC","")}${le ? " est." : ""}</small>` : ""}`;
}
function rowHTML(p, opt = {}){
  const o = S.open.has(p.id);
  const meta = opt.meta || defaultMeta(p);
  const right = opt.right || priceHTML(p);
  const w = watched(p.key);
  return `<div class="row"><div class="rowhead">
    <button class="rowmain" data-act="toggle" data-id="${p.id}" aria-expanded="${o}">
      ${thumbHTML(p)}
      <span class="nm">${esc(p.name)}${pills(p)}<span class="br">${esc(p.brand||"")}</span></span>
      <span class="price">${right}</span>
      <span class="meta">${meta.filter(Boolean).map(m => `<span>${typeof m === "object" ? m.h : esc(m)}</span>`).join("")}</span>
      ${opt.bar != null ? `<span class="bar" style="width:${Math.max(4, Math.min(100, opt.bar))}%"></span>` : ""}
    </button>
    ${S.canSave ? `<button class="watchbtn" data-act="watch" data-key="${esc(p.key)}" aria-pressed="${w}" title="${w ? "Watching: tap to stop" : "Watch for price drops and restocks"}" aria-label="${w ? "Stop watching" : "Watch"} ${esc(p.name)}">${BELL}</button>` : ""}
  </div>${o ? detailHTML(p) : ""}</div>`;
}
function rateBoxHTML(id, e, p){
  const stars = e?.stars || 0;
  const rid = id || "";
  const dataP = p ? `data-pid="${p.id}"` : "";
  return `<div class="rate">
    <div class="top"><span class="lbl">Your rating</span>
      <span class="stars" role="group" aria-label="Your rating">${[1,2,3,4,5].map(n => `<button class="st" data-act="stars" data-rid="${esc(rid)}" ${dataP} data-n="${n}" aria-pressed="${n <= stars}" aria-label="${n} star${n>1?"s":""}">★</button>`).join("")}</span>
      ${stars ? `<span class="note">${stars} of 5</span>` : ""}
      ${e && (stars || (e.notes||"").trim()) ? `<button class="linkbtn" data-act="clearrate" data-rid="${esc(rid)}">Clear rating</button>` : ""}
      <span class="saved" id="saved-${esc(rid || (p && p.key) || "")}"></span></div>
    <textarea id="note-${esc(rid || (p && p.key) || "")}" data-act="rnote" data-rid="${esc(rid)}" ${dataP} aria-label="Your notes" placeholder="Your notes: taste, hardware, effects, value…">${esc(e?.notes || "")}</textarea>
    ${e?.was ? `<span class="note">Rated as "${esc(e.was)}"</span>` : ""}
  </div>`;
}
function detailHTML(p){
  const pot = p.potency || {};
  const kv = [
    ["Cannabinoids", p.profile],
    ["THC figure", p.thc_source === "text" ? (p.thc_est ? `At least ${p.thc_min} mg/g, from the product name (store left it blank)` : "From the product description (store left it blank)") : (p.thc_source === "store" || p.thc_max != null ? null : (CANNABIS.has(p.kind) ? "Not listed by the store" : null))],
    ...["thc","cbd","cbn","cbg"].map(c => [`${c.toUpperCase()} per package${(p.cann_from_name||[]).includes(c.toUpperCase()) ? " (from name)" : ""}`, p[`${c}_total_mg`] != null ? mg(p[`${c}_total_mg`]).replace(" mg", c === "thc" && p.thc_est ? "+ mg" : " mg") : null]),
    ...["thc","cbd","cbn"].map(m => [`Value (${m.toUpperCase()})`, valueOf(p, m) != null ? `${m === "thc" && p.thc_est ? "≤" : ""}${money(valueOf(p, m))}${valueUnit(m, PER10.has(p.kind))}` : null]),
    ["Price per gram", p.per_gram != null ? money(p.per_gram) : null],
    ["Weight", GRAMKIND.has(p.kind) ? gramsText(p) : null],
    ["Type", p.vape_type], ["Hardware", p.hardware], ["Extract", p.extract], ["Flavour (guess)", p.flavour],
    ["Strain type", GRAMKIND.has(p.kind) ? (strainOf(p) || p.flower_type) : null], ["THCa", pot.thca ? `${pot.thca} ${pot.units||""}` : null], ["CBN (store)", pot.cbn || null],
    ["Stock count", p.stock_qty], ["SKU", p.sku], ["First seen", day(p.first_seen)],
    ["Gone since", p.gone_since ? day(p.gone_since) : null], ["Tags", (p.tags||[]).join(", ") || null]
  ].filter(([,x]) => x != null && x !== "");
  const hist = (p.price_history||[]).length > 1 ? `<div class="note">Price history: ${p.price_history.map(h => `${day(h[0])} ${money(h[1])}${h[2] ? " (sale " + money(h[2]) + ")" : ""}`).map(esc).join(" → ")}</div>` : "";
  const w = S.watch.items[p.key];
  const rid = ratingIdFor(p);
  const url = safeUrl(p.url);
  const big = imgSrc(p);
  return `<div class="detail"><div class="dhead">${big ? `<img class="bigimg" src="${esc(big)}" alt="${esc(p.name)}" loading="lazy">` : ""}${p.description ? `<p>${esc(p.description)}</p>` : ""}${photoInfoHTML(p)}</div>
    ${pickerHTML(p)}
    <div class="kv">${kv.map(([k,x]) => `<div><span>${esc(k)}</span>${esc(x)}</div>`).join("")}</div>${hist}
    ${S.canSave ? rateBoxHTML(rid, rid ? S.ratings.items[rid] : null, p) : ""}
    <div class="actions">
      ${S.canSave ? `<button class="btn small" data-act="watch" data-key="${esc(p.key)}">${w ? "Watching ✓" : "Watch"}</button>` : ""}
      ${S.canSave && w ? `<label>Alert at or below $<input type="number" step="0.25" min="0" inputmode="decimal" id="tgt-${esc(p.key)}" data-act="target" data-key="${esc(p.key)}" value="${w.target_price ?? ""}" aria-label="Target price"></label>` : ""}
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open on store site ↗</a>` : ""}
    </div></div>`;
}
function photoInfoHTML(p){
  const e = matchEntry(p);
  if (!e) {
    // stores sometimes upload a generic "stock photo" box as a normal picture: the owner can flag it for matching
    if (!S.isOwner || !S.db || !(CANNABIS.has(p.kind) || p.kind === "seed") || (p.image || "").includes(PLACEHOLDER)) return "";
    return isStockFlagged(p)
      ? `<div class="photoinfo"><span>Marked as a stock photo. The next menu check looks for the real one.</span><button class="linkbtn" data-act="markstock" data-key="${esc(p.key)}">Undo</button></div>`
      : `<div class="photoinfo"><button class="linkbtn" data-act="markstock" data-key="${esc(p.key)}">Store photo is just a stock image? Find the real one</button></div>`;
  }
  const mp = matchedPhoto(p), ov = photoOverride(p);
  const hasCands = (e.cands || []).length > 0;
  const canPick = S.isOwner && S.db && hasCands;
  const open = S.pickOpen.has(p.key);
  const btn = canPick ? `<button class="linkbtn" data-act="pickphoto" data-key="${esc(p.key)}" aria-expanded="${open}">${open ? "Close photo picker" : mp ? "Change photo" : "Pick photo"}</button>` : "";
  let info = "";
  if (mp) info = `<span class="pill p-match">Matched photo</span><span>${mp.how === "manual" ? "Picked by hand" : "Found automatically"}${mp.c ? ` from the Ontario Cannabis Store: ${esc([mp.c.v, mp.c.t].filter(Boolean).join(" · "))}` : ""}</span>`;
  else if (ov && ov.h === "none") info = S.isOwner ? `<span>You chose no photo for this one.</span>` : "";
  else if (e.st === "ask" && hasCands) info = S.isOwner ? `<span>The store has no photo. ${e.cands.length} possible match${e.cands.length > 1 ? "es" : ""} found.</span>` : "";
  return info || btn ? `<div class="photoinfo">${info}${btn}</div>` : "";
}
function pickerHTML(p){
  if (!S.pickOpen.has(p.key) || !S.isOwner) return "";
  const e = matchEntry(p); if (!e || !(e.cands || []).length) return "";
  const ov = photoOverride(p), mp = matchedPhoto(p);
  const cur = ov && ov.h ? ov.h : (mp ? mp.c.h : null);
  return `<div class="picker" role="group" aria-label="Pick a photo"><span class="note">Pick the photo that shows this product. These come from the Ontario Cannabis Store catalog, closest match first.</span>
    <div class="opts">${e.cands.map(c => okData(c.th) ? `<button class="pick" data-act="setphoto" data-key="${esc(p.key)}" data-h="${esc(c.h)}" aria-pressed="${cur === c.h}">
      <img src="${esc(c.th)}" alt="" loading="lazy"><b>${esc(c.t)}</b><span>${esc(c.v)} · match ${Math.round(c.s)}%</span></button>` : "").join("")}</div>
    <div class="actions"><button class="btn small" data-act="setphoto" data-key="${esc(p.key)}" data-h="none" aria-pressed="${cur === "none"}">No photo</button>
      ${ov ? `<button class="btn small" data-act="setphoto" data-key="${esc(p.key)}" data-h="">Back to automatic</button>` : ""}
      <span class="saved" id="saved-ph-${esc(p.key)}"></span></div></div>`;
}
function setPhoto(key, h){
  if (!S.isOwner || !S.db) return;
  const m = S.matches[S.slug] || (S.matches[S.slug] = {items: {}, overrides: {}});
  const items = {...(m.overrides || {})};
  const cur = {...(items[key] || {})};
  if (h === "stock") { if (cur.stock) delete cur.stock; else cur.stock = true; }
  else if (h) cur.h = h; else delete cur.h;
  cur.at = stampNow();
  if (cur.h || cur.stock) items[key] = cur; else delete items[key];
  m.overrides = items;
  if (h && h !== "stock") S.pickOpen.delete(key);
  render(true);
  S.db.doc(`stores/${S.slug}/imagematches/overrides`).set({items}).then(() => flash("ph-" + key, "Saved"))
    .catch(() => { S.checkErr = "Couldn't save the photo choice. Only the app's owner can change photos."; renderHeader(); });
}
function offRowHTML(id, e){
  const o = S.open.has("r:" + id);
  return `<div class="row"><div class="rowhead">
    <button class="rowmain" data-act="toggle" data-id="r:${esc(id)}" aria-expanded="${o}">
      <span class="thumb" aria-hidden="true"></span>
      <span class="nm">${esc(e.name)}${e.stars ? `<span class="pill p-rate">${e.stars}★</span>` : '<span class="pill p-rate">Noted</span>'}<span class="pill p-gone">Not on the menu now</span><span class="br">${esc(e.brand||"")}${e.kind ? " · " + esc(KIND_LABEL[e.kind]||e.kind) : ""}</span></span>
      <span class="price"></span>
      <span class="meta">${e.notes ? `<span>${esc(e.notes.length > 90 ? e.notes.slice(0,90) + "…" : e.notes)}</span>` : ""}</span>
    </button></div>
    ${o ? `<div class="detail"><div class="note" style="margin-top:10px">${e.match && e.match.length ? "This rating shows up on the product automatically if it comes back to the menu." : "This one can't be matched to a product automatically (the full name wasn't recorded)."}</div>${S.canSave ? rateBoxHTML(id, e, null) : ""}</div>` : ""}</div>`;
}
function listHTML(rows, opt = {}){
  const extra = opt.extraRows || [];
  if (!rows.length && !extra.length) return `<div class="empty">${esc(opt.empty || "No products match these filters.")}</div>`;
  const shown = rows.slice(0, S.shown);
  return `<div class="count">${rows.length} product${rows.length === 1 ? "" : "s"}${extra.length ? ` + ${extra.length} rated item${extra.length>1?"s":""} not on the menu` : ""}${opt.countNote ? " · " + opt.countNote : ""}</div>
    <div class="list" style="margin-top:8px">${shown.map(p => rowHTML(p, opt.row ? opt.row(p) : {})).join("")}${rows.length <= S.shown ? extra.join("") : ""}</div>
    ${rows.length > S.shown ? `<div style="display:flex;justify-content:center;margin-top:10px"><button class="btn more" data-act="more">Show ${Math.min(100, rows.length - S.shown)} more</button></div>` : ""}`;
}
function sorter(s){
  const valueKey = p => p.cbd_focused || p.per_100mg == null ? 1e9 : p.per_100mg;
  const cannKey = f => p => p[f] == null ? 1e9 : p[f];
  const tie = (a,b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name);
  return ({
    first: (a,b) => (b.first_seen||"").localeCompare(a.first_seen||"") || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
    thc: (a,b) => (b.thc_total_mg ?? -1) - (a.thc_total_mg ?? -1) || (b.thc_max ?? 0) - (a.thc_max ?? 0),
    value: (a,b) => valueKey(a) - valueKey(b) || tie(a,b),
    cbd: (a,b) => cannKey("per_100mg_cbd")(a) - cannKey("per_100mg_cbd")(b) || tie(a,b),
    cbn: (a,b) => cannKey("per_100mg_cbn")(a) - cannKey("per_100mg_cbn")(b) || tie(a,b),
    rating: (a,b) => (starsFor(b) ?? (isRated(b) ? 0.5 : 0)) - (starsFor(a) ?? (isRated(a) ? 0.5 : 0)) || a.name.localeCompare(b.name),
    plo: (a,b) => (effPrice(a) ?? 1e9) - (effPrice(b) ?? 1e9), phi: (a,b) => (effPrice(b) ?? 0) - (effPrice(a) ?? 0),
    name: (a,b) => a.name.localeCompare(b.name),
    brand: (a,b) => (a.brand||"").localeCompare(b.brand||"") || a.name.localeCompare(b.name)
  })[s] || (() => 0);
}
const SORTS = [["value","Best value"],["cbd","Cheapest CBD"],["cbn","Cheapest CBN"],["first","Newest first"],["thc","Most THC"],["rating","My rating"],["plo","Price: low to high"],["phi","Price: high to low"],["name","Name A–Z"],["brand","Brand A–Z"]];
const RATED_OPTS = [["","All products"],["rated","Rated by me"],["unrated","Not rated yet"]];

/* ============ views ============ */
const V = {};

V.menu = {
  key(){ return `menu|${S.f.kind}|${products().length > 0}|${S.canSave}`; },
  controls(){
    const kinds = [...new Set(products().map(p => p.kind))].sort((a,b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    return `<input type="search" id="f-q" placeholder="Search, e.g. blue dream preroll" aria-label="Search" value="${esc(S.f.q)}">
      <select id="f-kind" aria-label="Category"><option value="">All categories</option>${kinds.map(k => `<option value="${k}" ${S.f.kind===k?"selected":""}>${KIND_LABEL[k]||k}</option>`).join("")}</select>
      <select id="f-sort" aria-label="Sort">${SORTS.map(([v,l]) => `<option value="${v}" ${S.f.sort===v?"selected":""}>${l}</option>`).join("")}</select>
      ${S.canSave ? `<select id="f-rated" aria-label="My ratings">${RATED_OPTS.map(([v,l]) => `<option value="${v}" ${S.f.rated===v?"selected":""}>${l}</option>`).join("")}</select>` : ""}
      <label class="check"><input type="checkbox" id="f-fresh" ${S.f.fresh?"checked":""}> New this week</label>
      <label class="check"><input type="checkbox" id="f-gone" ${S.f.gone?"checked":""}> Include gone</label>
      <div id="facetbox" style="width:100%"></div>`;
  },
  results(){
    const pool = products().filter(p => (S.f.gone || p.status !== "gone") && (!S.f.kind || p.kind === S.f.kind));
    const fb = $("#facetbox");
    if (fb && !fb.contains(document.activeElement)) fb.innerHTML = facetsHTML(S.f.kind, S.f.facets, S.f.kind ? pool : pool.filter(p => CANNABIS.has(p.kind) || p.kind === "topical"), "fc");
    const words = searchQuery(S.f.q);
    let rows = pool.filter(p => facetMatch(p, S.f.kind, S.f.facets) && (!S.f.fresh || isNew(p))
      && (!S.f.rated || (S.f.rated === "rated") === isRated(p))
      && productMatches(p, words));
    rows.sort(sorter(S.f.sort));
    let extra = [];
    if (S.f.rated === "rated" && !S.f.fresh && !Object.values(S.f.facets).some(Boolean)) {
      extra = offMenuRatings().filter(([, e]) => (!S.f.kind || e.kind === S.f.kind) && (!words.length || textMatches(words, `${e.name} ${e.brand}`)))
        .sort((a,b) => (b[1].stars||0) - (a[1].stars||0)).map(([id, e]) => offRowHTML(id, e));
    }
    const empty = !products().length ? "The menu shows up here after the first check."
      : S.f.rated === "rated" ? "You haven't rated anything that matches. Open any product to give it stars and notes." : "No products match these filters.";
    const noteFor = {value: ["per_100mg", "THC", p => p.per_100mg == null || p.cbd_focused], cbd: ["per_100mg_cbd", "CBD", p => p.per_100mg_cbd == null], cbn: ["per_100mg_cbn", "CBN", p => p.per_100mg_cbn == null]}[S.f.sort];
    let countNote = "";
    if (noteFor && rows.length) {
      const without = rows.filter(p => CANNABIS.has(p.kind) && noteFor[2](p)).length;
      countNote = `cheapest ${noteFor[1]} per mg first${without ? ` · ${without} without ${noteFor[1]} data at the end` : ""}`;
    }
    return listHTML(rows, {empty, extraRows: extra, countNote});
  }
};

function watchActivity(days = 30){
  const since = daysAgo(days), out = [];
  for (const st of S.stores) for (const r of (S.runs[st.slug]||[])) {
    if (r.at < since || r.first_run) continue;
    const add = (list, kind, fmt) => (list||[]).forEach(x => { if (x.key && S.watch.items[x.key]) out.push({at:r.at, key:x.key, store:st.name, kind, text:fmt(x)}); });
    add(r.new, "back", x => `Back on the menu at ${money(x.sale_price ?? x.price)}`);
    add(r.returned, "back", x => `Back on the menu at ${money(x.sale_price ?? x.price)}`);
    add(r.price_changes, "price", x => `Price ${money(x.old_price)} → ${money(x.price)}`);
    add(r.sale_changes, "sale", x => x.sale_price ? `On sale for ${money(x.sale_price)}` : `Sale ended, back to ${money(x.price)}`);
    add(r.removed, "gone", () => `Left the menu (sold out or delisted)`);
  }
  return out.sort((a,b) => b.at.localeCompare(a.at));
}
function targetHits(){
  const out = [];
  for (const [key, w] of Object.entries(S.watch.items)) {
    if (!w.target_price) continue;
    for (const st of S.stores) { const p = productByKey(key, st.slug);
      if (p && p.status !== "gone" && effPrice(p) <= w.target_price) out.push({key, store: st.name, p, w}); }
  }
  return out;
}

V.watch = {
  key(){ return `watch|${S.canSave}`; },
  controls(){ return S.canSave ? `<span class="note">Tap the bell on any product to watch it. Set a target price to get flagged when it drops to that price or lower. ${window.CCS_LOCAL ? "Chrome notifications after each check list the same alerts." : "Your 9 AM and midnight emails list the same alerts."}</span>` : `<span class="note">You need edit access to this app to keep a watchlist.</span>`; },
  results(){
    const keys = Object.keys(S.watch.items);
    if (!keys.length) return `<div class="empty">Nothing on your watchlist yet. Tap the bell next to any product.</div>`;
    const act = watchActivity(30);
    const cards = keys.map(key => {
      const w = S.watch.items[key];
      const at = S.stores.map(st => ({st, p: productByKey(key, st.slug)}));
      const cur = at.find(x => x.p && x.p.status !== "gone");
      const p = cur?.p || at.find(x => x.p)?.p;
      const name = p?.name || w.name, brand = p?.brand || w.brand;
      const hit = cur && w.target_price && effPrice(cur.p) <= w.target_price;
      const acts = act.filter(a => a.key === key).slice(0, 5);
      const st = p ? starsFor(p) : null;
      const url = safeUrl(p?.url);
      return {added: w.added || "", hit: !!hit, html: `<article class="card"><div class="watchrow">
        <div class="wtitle">${p ? thumbHTML(p) : ""}<div><h3 style="display:inline">${esc(name)}</h3>${hit ? '<span class="pill p-hit">Target hit</span>' : ""}${p?.sale_price && cur ? '<span class="pill p-sale">Sale</span>' : ""}${st ? `<span class="pill p-rate">${st}★</span>` : ""}<div class="br">${esc(brand||"")}</div></div></div>
        <div class="price">${cur ? (cur.p.sale_price ? `<s>${money(cur.p.price)}</s>${money(cur.p.sale_price)}` : money(cur.p.price)) : '<span class="pill p-gone" style="margin:0">Not on menu</span>'}</div></div>
        <div class="meta" style="display:flex;flex-wrap:wrap;gap:2px 12px;font:0.78rem var(--mono);color:var(--muted)">${at.map(({st,p}) => `<span>${esc(st.name)}: <span class="v">${p && p.status !== "gone" ? money(effPrice(p)) + (p.stock_qty != null ? ` · ${p.stock_qty} in stock` : "") : "not listed"}</span></span>`).join("")}${p ? `<span>${esc(GRAMKIND.has(p.kind) ? gramsText(p) : (p.size||""))}</span><span>${esc(thcText(p))}</span>` : ""}</div>
        ${acts.length ? `<div class="act">${acts.map(a => `<div><span>${day(a.at)}${S.stores.length > 1 ? " · " + esc(a.store) : ""}</span>${esc(a.text)}</div>`).join("")}</div>` : `<div class="note">No changes since you added it${w.added ? ` on ${day(w.added)}` : ""}.</div>`}
        <div class="actions"><label>Alert at or below $<input type="number" step="0.25" min="0" inputmode="decimal" id="tgt-${esc(key)}" data-act="target" data-key="${esc(key)}" value="${w.target_price ?? ""}" aria-label="Target price"></label>
          <button class="btn small" data-act="watch" data-key="${esc(key)}">Remove</button>
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Store page ↗</a>` : ""}</div></article>`};
    }).sort((a,b) => (b.hit - a.hit) || b.added.localeCompare(a.added));
    return `<div class="cards">${cards.map(c => c.html).join("")}</div>`;
  }
};

V.changes = {
  key(){ return `changes`; },
  controls(){ return `<button class="linkbtn" data-view="menu">← Back to menu</button><label class="check"><input type="checkbox" id="f-chHide" ${S.f.chHide?"checked":""}> Hide accessories & apparel</label>`; },
  results(){
    const runs = S.runs[S.slug] || [];
    if (!runs.length) return `<div class="empty">Each check adds an entry here with new products, price changes and items that left the menu.</div>`;
    const keep = x => !S.f.chHide || !["accessory","apparel"].includes(x.kind);
    const item = (x, extra = "") => { const p = productByKey(x.key) || x; const st = x.key ? starsFor(p) : null; const url = safeUrl(x.url);
      return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)} <span class="note">${esc(x.brand||"")} · ${esc(x.subcategory||x.category||"")} · ${money(x.sale_price ?? x.price)}${extra}</span>${S.watch.items[x.key] ? ' <span class="pill">Watching</span>' : ""}${st ? ` <span class="pill p-rate">${st}★</span>` : ""}</li>`; };
    return `<div class="cards">${runs.slice(0, 60).map(r => {
      const sec = [["New products", r.new], ["Back on the menu", r.returned],
        ["Price changes", r.price_changes, x => ` (was ${money(x.old_price)})`],
        ["Sale changes", r.sale_changes, x => ` (sale was ${x.old_sale_price ? money(x.old_sale_price) : "none"})`],
        ["Gone from the menu", r.removed]].map(([t,l,f]) => [t, (l||[]).filter(keep), f]).filter(([,l]) => l.length);
      const hidden = S.f.chHide ? ["new","returned","price_changes","sale_changes","removed"].reduce((n,k) => n + (r[k]||[]).filter(x => !keep(x)).length, 0) : 0;
      const hid = hidden ? `${hidden} accessory/apparel change${hidden>1?"s":""} hidden` : "";
      const body = r.first_run ? `<div class="note">First check. Saved ${r.total_listed} products as the starting point.</div>`
        : sec.length ? sec.map(([t,l,f]) => `<h4>${t} (${l.length})</h4><ul>${l.map(x => item(x, f ? f(x) : "")).join("")}</ul>`).join("") + (hid ? `<div class="note">${hid}</div>` : "")
        : `<div class="note">No changes${hid ? ` (${hid})` : ""}. ${r.total_listed} products listed.</div>`;
      return `<article class="card"><h3>${esc(r.local || r.at)}</h3>${body}</article>`;
    }).join("")}</div>`;
  }
};

/* ============ top-level render ============ */
function renderTabs(){
  const n = {watch: Object.keys(S.watch.items).length};
  $("#tabs").innerHTML = VIEWS.map(([v,l]) => `<button class="tab" role="tab" data-view="${v}" aria-selected="${S.view===v}">${l}${n[v] ? `<span class="n">${n[v]}</span>` : ""}</button>`).join("")
    + (S.view === "changes" ? `<button class="tab" role="tab" data-view="changes" aria-selected="true">Change log</button>` : "");
}
function renderHeader(){
  const m = S.meta[S.slug] || {};
  const sig = S.stores.map(s => s.slug).join(",") + "|" + S.slug;
  if (sig !== S.storesSig) {
    S.storesSig = sig;
    const st = S.stores.find(s => s.slug === S.slug);
    $("#storeTitle").innerHTML = S.stores.length > 1
      ? `<select id="storePick" aria-label="Store">${S.stores.map(s => `<option value="${esc(s.slug)}" ${s.slug===S.slug?"selected":""}>${esc(s.name)}</option>`).join("")}</select>`
      : esc(st?.name || "Calmar");
  }
  const checking = !!(S.checkReq && (!m.last_run || m.last_run < S.checkReq.requested_at) && S.checkReq.requested_at > daysAgo(0.02));
  $("#lastCheck").innerHTML = m.last_run ? `<span>Listed <b>${m.total_listed}</b></span> <span>Checked <b>${esc(when(m.last_run))}</b></span>` : "Waiting for the first check";
  const b = $("#checkNow");
  b.hidden = !S.isOwner || !S.mcp;
  b.disabled = checking || !!S.firing;
  b.textContent = S.firing ? "Starting…" : checking ? "Checking…" : "Check now";
  const ban = [];
  if (checking) ban.push(`<div class="banner info">Checking the live menu now (started ${esc(when(S.checkReq.requested_at))}). New results show up here on their own in about 2–3 minutes.</div>`);
  if (S.checkErr) ban.push(`<div class="banner err">${esc(S.checkErr)}</div>`);
  if (S.saveErr) ban.push(`<div class="banner err">Couldn't save your last change. You may not have edit access to this app.</div>`);
  const recent = watchActivity(3).filter(a => a.kind !== "gone"), hits = targetHits();
  if (recent.length || hits.length) ban.push(`<div class="banner"><b>Watchlist:</b> ${[hits.length ? `${hits.length} at or below your target price` : "", recent.length ? `${recent.length} change${recent.length>1?"s":""} in the last 3 days` : ""].filter(Boolean).join(" · ")} <button class="btn small" data-view="watch">Open watchlist</button></div>`);
  if (!S.canSave && !S.saveErr && S.db && S.userResolved) ban.push(`<div class="banner info">You're viewing read-only. Ask the owner for edit access to keep your own ratings and watchlist.</div>`);
  const html = ban.join("");
  if ($("#banners").innerHTML !== html) $("#banners").innerHTML = html;
  $("#foot").innerHTML = S.stores.length ? `<span>Data from the store's online menu. Only in-stock items are listed, so "gone" means sold out or delisted.</span><span>${window.CCS_LOCAL ? "Checks run on this computer at 8:52 AM, 4:20 PM and midnight while Chrome is open (a missed one runs when Chrome starts)." : "Checks run daily at 9 AM, 4:20 PM and midnight."}</span>${S.view !== "changes" ? `<button class="linkbtn" data-view="changes">Change log</button>` : ""}` : "";
}

function keepFocus(fn){
  const ae = document.activeElement, id = ae && ae.id;
  const sel = id && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  fn();
  if (id && document.activeElement !== ae) {
    const el = document.getElementById(id);
    if (el) { el.focus({preventScroll: true}); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch(_) {} }
  }
}
let lastControlsKey = "";
function render(force){
  const ae = document.activeElement;
  // don't rebuild the list under someone typing a note or a target price
  if (!force && ae && ae.closest && ae.closest("#results") && ae.matches("textarea,input")) { S.pending = true; renderHeader(); return; }
  S.pending = false;
  RIDX = null;
  autoAttach();
  renderHeader(); renderTabs();
  keepFocus(() => {
    const ck = V[S.view].key();
    if (ck !== lastControlsKey) { $("#controls").innerHTML = V[S.view].controls(); lastControlsKey = ck; }
    $("#results").innerHTML = V[S.view].results();
  });
}
document.addEventListener("focusout", () => setTimeout(() => { if (S.pending) render(); }, 0));

/* ============ saving (per-person, private) ============ */
const saveQ = {};
function save(docName){
  if (!S.canSave || !S.db) return Promise.resolve();
  const data = JSON.parse(JSON.stringify(docName === "watchlist" ? S.watch : S.ratings));
  const ref = S.db.doc(`data/users/${S.uid}/${docName}`);
  saveQ[docName] = (saveQ[docName] || Promise.resolve()).then(() => ref.set(data)).catch(() => {
    S.canSave = false; S.saveErr = true; lastControlsKey = ""; render(true);
  });
  return saveQ[docName];
}
const timers = {};
function flash(id, text){ const el = document.getElementById("saved-" + id); if (el) { el.textContent = text; clearTimeout(timers["f"+id]); timers["f"+id] = setTimeout(() => { el.textContent = ""; }, 1800); } }

function toggleWatch(key){
  if (!S.canSave) return;
  if (S.watch.items[key]) delete S.watch.items[key];
  else { const p = productByKey(key); S.watch.items[key] = {name: p?.name || "", brand: p?.brand || "", added: stampNow(), target_price: null}; }
  save("watchlist"); render(true);
}
function productFromEl(el){ const pid = el.dataset.pid; return pid ? products().find(p => String(p.id) === pid) : null; }

/* ============ events ============ */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-view],[data-act],[data-seg]"); if (!t) return;
  if (t.dataset.view) { S.view = t.dataset.view; S.shown = 60; try { localStorage.setItem("ccs.view", S.view); } catch(_) {} render(true); window.scrollTo({top:0}); return; }
  if (t.dataset.seg) { S.f[t.dataset.seg] = t.dataset.v; S.shown = 60; render(true); return; }
  const a = t.dataset.act, key = t.dataset.key, id = t.dataset.id;
  if (a === "toggle") { const k = /^r:/.test(id) ? id : Number(id); S.open.has(k) ? S.open.delete(k) : S.open.add(k); render(true); }
  else if (a === "more") { S.shown += 100; render(true); }
  else if (a === "watch") toggleWatch(key);
  else if (a === "pickphoto") { S.pickOpen.has(key) ? S.pickOpen.delete(key) : S.pickOpen.add(key); render(true); }
  else if (a === "setphoto") setPhoto(key, t.dataset.h);
  else if (a === "markstock") setPhoto(key, "stock");
  else if (a === "clearfacets") { S.f.facets = {}; S.shown = 60; const box = t.closest("#facetbox"); if (box) box.innerHTML = ""; render(true); }
  else if (a === "stars") {
    if (!S.canSave) return;
    const p = productFromEl(t); let rid = t.dataset.rid;
    if (!rid && p) rid = ensureRating(p);
    const e2 = S.ratings.items[rid]; if (!e2) return;
    const n = Number(t.dataset.n);
    e2.stars = e2.stars === n ? null : n; e2.updated = stampNow();
    save("ratings"); render(true); flash(rid, "Saved");
  }
  else if (a === "clearrate") {
    const rid = t.dataset.rid; if (!rid || !S.ratings.items[rid]) return;
    delete S.ratings.items[rid]; save("ratings"); render(true);
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.act === "rnote") {
    if (!S.canSave) return;
    let rid = t.dataset.rid; const p = productFromEl(t);
    if (!rid && p) { rid = ensureRating(p); t.dataset.rid = rid; }
    const e2 = S.ratings.items[rid]; if (!e2) return;
    e2.notes = t.value; e2.updated = stampNow();
    clearTimeout(timers[rid]); timers[rid] = setTimeout(() => { save("ratings").then(() => flash(rid, "Saved")); }, 700);
    return;
  }
  if (t.dataset.act === "target") { const w = S.watch.items[t.dataset.key]; if (!w) return; const v = parseFloat(t.value); w.target_price = isFinite(v) && v > 0 ? v : null; clearTimeout(timers["t"+t.dataset.key]); timers["t"+t.dataset.key] = setTimeout(() => save("watchlist"), 700); return; }
  if (t.dataset.facet) { S.f.facets[t.dataset.facet] = t.value; S.shown = 60; render(true); return; }
  const map = {"f-q":"q","f-kind":"kind","f-sort":"sort","f-fresh":"fresh","f-gone":"gone","f-rated":"rated","f-chHide":"chHide"};
  if (map[t.id]) {
    // starting a search looks across every category; a category picked afterwards narrows it
    if (t.id === "f-q" && !S.f.q.trim() && t.value.trim()) { S.f.kind = ""; S.f.facets = {}; }
    S.f[map[t.id]] = t.type === "checkbox" ? t.checked : t.value;
    if (t.id === "f-kind") { S.f.facets = {}; }
    S.shown = 60; render(true); return;
  }
  if (t.id === "storePick") { S.slug = t.value; S.open.clear(); S.storesSig = ""; try { localStorage.setItem("ccs.store", S.slug); } catch(_) {} lastControlsKey = ""; render(true); }
});

/* ============ help ============ */
const helpDlg = $("#help");
$("#helpBtn").addEventListener("click", () => { if (helpDlg.showModal) helpDlg.showModal(); else helpDlg.setAttribute("open", ""); });
$("#helpClose").addEventListener("click", () => helpDlg.close ? helpDlg.close() : helpDlg.removeAttribute("open"));
helpDlg.addEventListener("click", e => { if (e.target === helpDlg) helpDlg.close(); });

/* ============ Check now (starts a cloud check through your Claude account) ============ */
$("#checkNow").addEventListener("click", async () => {
  if (S.firing) return;
  S.checkErr = null; S.firing = true; renderHeader();
  try {
    await S.mcp.callTool("Claude Code Remote", "fire_trigger", {trigger_id: S.triggerId || CHECK_TRIGGER}, {cache: false});
    const req = {requested_at: stampNow()};
    S.checkReq = req;
    try { await S.db.doc("checks/last").set(req); } catch(_) {}
  } catch (err) {
    const c = err && err.code;
    S.checkErr = c === "server_not_connected" || c === "needs_reauth" ? "Check now needs the Claude Code Remote connector. Reconnect it in claude.ai Settings → Connectors, then try again."
      : c === "not_in_manifest" ? "Check now isn't allowed for this page yet. Tap it again and choose Allow when asked."
      : c === "tool_error" ? `The check couldn't start: ${err.message || "the scheduled task refused it"}.`
      : c === "server_unavailable" || c === "upstream_error" ? "The check may not have started (no answer from the server). Wait a minute and look at the check time before trying again."
      : `The check couldn't start (${c || "unknown error"}).`;
  }
  S.firing = false; renderHeader();
});
setInterval(() => { if (S.checkReq) renderHeader(); }, 30000);

/* ============ boot ============ */
render(true);
(async () => {
  const db = await window.claude?.use?.("db");
  if (!db) { $("#results").innerHTML = `<div class="empty">The menu data isn't available in this view. Open the app from claude.ai while signed in.</div>`; $("#lastCheck").textContent = ""; return; }
  S.db = db;
  const user = await window.claude?.use?.("user");
  try { S.isOwner = user ? await user.isOwner() : false; S.uid = user ? await user.id() : null; } catch(_) { S.uid = null; }
  S.userResolved = true;
  S.canSave = !!S.uid;
  lastControlsKey = "";
  window.claude?.use?.("mcp").then(m => { S.mcp = m; renderHeader(); });

  const subStore = slug => {
    if (S.subs[slug]) return; S.subs[slug] = true;
    db.collection(`stores/${slug}/catalog`).onSnapshot(snap => {
      S.catalogs[slug] = snap.docs.flatMap(d => d.data()?.products || []);
      lastControlsKey = ""; render();
    }, err => console.warn("catalog", err));
    db.collection(`stores/${slug}/media`).onSnapshot(snap => {
      const m = {}; snap.docs.forEach(d => Object.assign(m, d.data()?.items || {}));
      S.media[slug] = m; render();
    }, err => console.warn("media", err));
    db.collection(`stores/${slug}/imagematches`).onSnapshot(snap => {
      const items = {}; let overrides = {};
      snap.docs.forEach(d => { const x = d.data() || {}; if (d.id === "overrides") overrides = x.items || {}; else Object.assign(items, x.items || {}); });
      S.matches[slug] = {items, overrides}; render();
    }, err => console.warn("imagematches", err));
    db.collection(`stores/${slug}/runs`).orderBy("at", "desc").limit(90).onSnapshot(snap => {
      S.runs[slug] = snap.docs.map(d => d.data()).filter(Boolean); render();
    }, err => console.warn("runs", err));
  };
  db.doc("config/stores").onSnapshot(d => {
    S.stores = d.data()?.stores || [{slug:"calmar", name:"Calmar"}];
    let saved = null; try { saved = localStorage.getItem("ccs.store"); } catch(_) {}
    if (!S.slug || !S.stores.some(s => s.slug === S.slug)) S.slug = S.stores.some(s => s.slug === saved) ? saved : S.stores[0].slug;
    S.stores.forEach(s => subStore(s.slug));
    lastControlsKey = ""; render();
  });
  db.collection("stores").onSnapshot(snap => { snap.docs.forEach(d => { S.meta[d.id] = d.data(); }); renderHeader(); });
  db.doc("config/app").onSnapshot(d => { S.triggerId = d.data()?.check_trigger_id || null; });
  db.doc("checks/last").onSnapshot(d => {
    const x = d.data();
    S.checkReq = x || S.checkReq;
    if (x && x.failed && x.failed_at && x.failed_at >= (x.requested_at || "")) { S.checkErr = `The last check failed: ${x.failed}`; S.checkReq = null; }
    renderHeader();
  });
  if (S.uid) {
    db.doc(`data/users/${S.uid}/watchlist`).onSnapshot(d => { if (d.data()) S.watch = {items: {}, ...d.data()}; render(); });
    db.doc(`data/users/${S.uid}/ratings`).onSnapshot(d => {
      const x = d.data();
      if (x && x.items) S.ratings = {v: 2, items: {}, ...x};
      else if (x && x.entries) S.ratings = {v: 2, items: Object.fromEntries(Object.entries(x.entries).map(([id, e]) => [e.key || id, {stars: null, notes: e.notes || "", name: e.name, brand: e.brand, kind: e.kind, key: e.key || null, match: null}]))};
      S.ratingsLoaded = true; render();
    });
  }
  render(true);
})();
