#!/usr/bin/env python3
"""Country Cannabis menu tracker engine (multi-store).

One command does a full check:

  python3 engine.py run --prev PREV --out OUT [--app-url URL]

PREV is a folder filled by ArtifactData `list` calls with out_dir=PREV:
  config               -> PREV/config/stores.json         (store list; optional)
  stores               -> PREV/stores/<slug>.json          (per-store meta docs)
  stores/<slug>/catalog-> PREV/stores/<slug>/catalog/chunk-NN.json
  data/users/me        -> PREV/data/users/<id>/watchlist.json   (optional; for email alerts)
plus PREV/versions.txt: the ArtifactData list outputs pasted verbatim (lines
containing `version N  "<path>.json"`), so writes can be pinned. A JSON map
{"stores/calmar/catalog/chunk-00": 3, ...} via --versions also works.

OUT receives: doc JSON files, batch_N.json (ArtifactData batch `writes`
arrays, apply in order), summary.md (email text) and result.json.

Data model (artifact db):
  config/stores                      {stores:[{slug,name,site_id,menu_url}]}
  stores/<slug>                      store meta (last_run, counts, ...)
  stores/<slug>/catalog/chunk-NN     {products:[...]} (all products, incl. gone <90d)
  stores/<slug>/runs/<stamp>         change log for one check
  data/users/<uid>/watchlist|ratings per-person private data (written by the app)
"""
import argparse, datetime, glob, json, os, re, sys, time, urllib.request

API = "https://ecom-api.blaze.me/api"
DEFAULT_STORES = [{"slug": "calmar", "name": "Calmar", "site_id": "ca9cba05-b18a-4dda-9c12-a4c5fa378083",
                   "menu_url": "https://shop.countrycannabisstore.ca/menu/calmar/"}]
CHUNK_BYTES = 110_000   # stored docs are ~35% larger than compact JSON; hard limit is 256 KiB
BATCH_BYTES = 700_000
MT = datetime.timezone(datetime.timedelta(hours=-6))  # display only

KIND_BY_CATEGORY = [
    ("vape", "vape"), ("infused pre", "infused"), ("pre-roll", "preroll"), ("dried flower", "flower"),
    ("milled flower", "flower"), ("hash", "extract"), ("shatter", "extract"), ("concentrate", "extract"),
    ("edible", "edible"), ("beverage", "beverage"), ("oil or spray", "ingestible"), ("capsule", "ingestible"),
    ("topical", "topical"), ("seed", "seed"), ("accessor", "accessory"), ("apparel", "apparel"),
]
KIND_ORDER = ["vape", "flower", "preroll", "infused", "extract", "edible", "beverage", "ingestible",
              "topical", "seed", "accessory", "apparel", "other"]
GRAM_KINDS = {"vape", "flower", "preroll", "infused", "extract"}
CANNABIS_KINDS = GRAM_KINDS | {"edible", "beverage", "ingestible", "topical"}

FRUITY = re.compile(r"strawberr|watermelon|melon|grape|berry|berries|peach|cherry|apple|lemonade|lemon|lime|mango|"
                    r"raspberr|blueberr|punch|candy|gumm|cheesecake|vanilla|macchiato|\bjam\b|\bbear\b|orange|pineapple|"
                    r"banana|tropical|fruit|coconut|tiger blood|razz|cola|\bmint\b|cream|passionfruit|guava|kiwi|"
                    r"bubblegum|lemon|citrus|dessert|cookie dough|caramel|hazelnut|coffee|jelly|jolly|soda")
NATURAL = re.compile(r"live resin|live rosin|\brosin\b|cured resin|\bfse\b|full[- ]spectrum|cannabis[- ]derived terp|"
                     r"unflavou?red|no added flavou?r|100% cannabis|all[- ]cannabis|\bcdt\b")


# ---------------------------------------------------------------- fetching
def get(url, site_id):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.api+json", "X-Store": site_id,
                                               "User-Agent": "Mozilla/5.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))


def fetch_store(site_id):
    items, inc, off, total = [], {}, 0, None
    while total is None or off < total:
        d = get(f"{API}/v1/products/?limit=100&offset={off}&delivery_type=pickup", site_id)
        total = d["meta"]["total_count"]
        items += d["data"]
        for i in d.get("included", []):
            inc[(i["type"], i["id"])] = i
        if not d["data"]:
            break
        off += 100
    cats = get(f"{API}/v2/products/categories/?limit=500", site_id)
    for c in cats.get("data", []) + cats.get("included", []):
        inc[("product_categories", c["id"])] = c
    seen, out = set(), []
    for p in items:
        if p["id"] not in seen:
            seen.add(p["id"])
            out.append(p)
    return out, inc, total


# ---------------------------------------------------------------- shaping
def money(p):
    return None if not p else round(p["amount"] / 100, 2)


def num(x):
    try:
        return float(x["amount"]) if isinstance(x, dict) else (float(x) if x is not None else None)
    except Exception:
        return None


def norm(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def pack_count(name):
    m = re.search(r"(\d+)\s*x\s*[\d.]+\s*(?:g|mg|ml)\b", name, re.I) or re.search(r"\bx\s*(\d+)\b", name, re.I)
    return int(m.group(1)) if m else None


def multipack(name):
    m = re.search(r"multi-?pack of (\d+)", name or "", re.I)
    return int(m.group(1)) if m else 1


def name_grams(name):
    """Grams stated in the product name: '10 x 0.4g' -> 4.0, '3.5g' -> 3.5. Most reliable size source."""
    name = name or ""
    m = re.search(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g\b", name, re.I)
    if m:
        return round(int(m.group(1)) * float(m.group(2)), 3)
    m = re.search(r"(?<![\d.])(\d+(?:\.\d+)?)\s*g\b", name, re.I)
    return float(m.group(1)) if m else None


def grams_of(p, kind):
    if kind not in GRAM_KINDS:
        return None
    g = name_grams(p.get("name"))
    if g:
        return g
    if (p.get("size_units") or "").startswith("gram") and p.get("size_amount"):
        return p["size_amount"]
    m = re.match(r"([\d.]+)\s*gram", p.get("cannabis_weight") or "")
    if m:  # equivalency weight: extracts count 4x, dried cannabis 1x
        return round(float(m.group(1)) / (4 if kind in ("vape", "extract", "infused") else 1), 3)
    return None


CANNS = ("THC", "CBD", "CBN", "CBG", "CBC")
_NUM = r"\d+(?:\.\d+)?"
_NAMES = r"(?:THC|CBD|CBN|CBG|CBC)"


def name_ratio(name):
    """Cannabinoid ratio stated in a product name, e.g. '1:1:1 CBN:CBD:THC', 'THC:CBD 5mg:5mg',
    'CBN10:THC20', '750CBD:150CBN'. Returns {'THC': 1.0, 'CBN': 1.0, ...} or None."""
    n = name or ""
    m = re.search(rf"({_NUM}(?:\s*:\s*{_NUM})+)\s*({_NAMES}(?:\s*[:/|]\s*{_NAMES})+)", n, re.I)
    if m:
        nums = [float(x) for x in re.split(r"\s*:\s*", m.group(1))]
        names = [x.upper() for x in re.split(r"\s*[:/|]\s*", m.group(2))]
        if len(nums) == len(names):
            return dict(zip(names, nums))
    m = re.search(rf"({_NAMES}(?:\s*[:/|]\s*{_NAMES})+)\s*({_NUM}\s*(?:mg)?(?:\s*:\s*{_NUM}\s*(?:mg)?)+)", n, re.I)
    if m:
        names = [x.upper() for x in re.split(r"\s*[:/|]\s*", m.group(1))]
        nums = [float(x) for x in re.findall(_NUM, m.group(2))]
        if len(nums) == len(names):
            return dict(zip(names, nums))
    pairs = re.findall(rf"\b({_NAMES})\s*({_NUM})(?=\s*[:/|])|(?<=[:/|])\s*({_NAMES})\s*({_NUM})\b", n, re.I)
    d = {}
    for a1, b1, a2, b2 in pairs:
        k, v = (a1 or a2).upper(), float(b1 or b2)
        d[k] = v
    if len(d) >= 2:
        return d
    pairs = re.findall(rf"\b({_NUM})\s*({_NAMES})\b(?=\s*[:/|+])|(?<=[:/|+])\s*({_NUM})\s*({_NAMES})\b", n, re.I)
    d = {}
    for a1, b1, a2, b2 in pairs:
        d[(b1 or b2).upper()] = float(a1 or a2)
    return d if len(d) >= 2 else None


def name_mg(name, can):
    """Package total stated outright: '1000 mg CBN', '100 mg CBD x 30 Caps', 'CBD 50mg x 30 Capsules'."""
    n = name or ""
    m = re.search(rf"({_NUM})\s*mg\s*{can}\s*x\s*(\d+)", n, re.I) or re.search(rf"\b{can}\s*({_NUM})\s*mg\s*x\s*(\d+)", n, re.I)
    if m:
        return float(m.group(1)) * int(m.group(2))
    m = re.search(rf"({_NUM})\s*mg\s*{can}\b(?!\s*[:/|])", n, re.I)
    return float(m.group(1)) if m else None


def mid_of(lo, hi, pot_mid):
    if pot_mid:
        return pot_mid
    if lo or hi:
        return ((lo or hi) + (hi or lo)) / 2
    return None


def derive(p):
    cat = (p.get("category") or "").lower()
    kind = next((k for needle, k in KIND_BY_CATEGORY if needle in cat), "other")
    p["kind"] = kind
    p["key"] = f"sku:{p['sku']}" if p.get("sku") else "n:" + norm(f"{p.get('brand') or ''} {p.get('name') or ''}")
    p["price_eff"] = p["sale_price"] if p.get("sale_price") else p.get("price")
    name = p.get("name") or ""
    lo, hi = p.get("thc_min"), p.get("thc_max")
    pot = p.get("potency") or {}
    mid = pot.get("thc") or (((lo or hi) + (hi or lo)) / 2 if (lo or hi) else None)
    p["thc_mid"] = round(mid, 2) if mid else None
    units = (p.get("potency_units") or "").lower()
    grams = grams_of(p, kind)
    p["grams"] = grams
    p["thc_source"] = "store" if mid else None
    p["thc_est"] = False
    if not mid and kind in GRAM_KINDS:
        # the store left THC blank: use what the product's own name or description states
        text = f"{name} {p.get('description') or ''}"
        m_mg = re.search(r"(\d{3,4})\s*mg\s*(?:of\s*)?THC\b", text, re.I)
        m_pct = re.search(r"(\d{2}(?:\.\d+)?)\s*%\s*THC\b", text, re.I) or re.search(r"\bTHC\s*:?\s*(\d{2}(?:\.\d+)?)\s*%", text, re.I)
        m_plus = re.search(r"(?<![\d.])(\d{2})\s*\+(?!\s*\d)", name) if kind in ("vape", "extract") else None
        if m_mg and grams and 0 < float(m_mg.group(1)) <= grams * 1000:
            mid = float(m_mg.group(1)) / grams
        elif m_pct and 1 <= float(m_pct.group(1)) <= 100:
            mid = float(m_pct.group(1)) * 10
        elif m_plus and 50 <= int(m_plus.group(1)) <= 99:
            mid = int(m_plus.group(1)) * 10          # "95+" means at least 95%: a floor, not a measurement
            p["thc_est"] = True
        if mid:
            mid = round(mid, 1)
            units = "mg/g"
            p["thc_min"] = p["thc_max"] = mid
            p["potency_units"] = "mg/g"
            p["thc_mid"] = mid
            p["thc_source"] = "text"
    total = None
    if mid:
        if kind in GRAM_KINDS:
            total = mid * grams if (units == "mg/g" and grams) else None
        elif kind in ("edible", "beverage"):
            # stores label these inconsistently (mg, mg/unit, mg/g); the value is the package total when it
            # fits the 10 mg-per-package limit
            n = multipack(name)
            if n > 1 and mid <= 10.5:
                total = mid * n          # per-package figure on a multipack
            else:
                total = mid if mid <= 10.5 * n else None
        elif kind == "ingestible":
            if units == "mg/g" and p.get("size_amount"):
                total = mid * p["size_amount"]
            elif units in ("mg/unit", "mg/capsule"):
                c = pack_count(name)
                total = mid * c if c else None
    if kind == "ingestible":  # the name is more reliable than the feed when it states THC outright
        m = re.search(r"THC\s*(\d+(?:\.\d+)?)\s*mg\s*x\s*(\d+)", name, re.I) or \
            re.search(r"(\d+(?:\.\d+)?)\s*mg\s*x\s*(\d+)\s*(?:softgels?|capsules?|caps)\b.*\bTHC\b", name, re.I)
        m2 = re.search(r"(\d+(?:\.\d+)?)\s*mg\s*THC\b(?!\s*:)", name, re.I)
        if m:
            total = float(m.group(1)) * int(m.group(2))
        elif m2:
            total = float(m2.group(1))
        if total and total > 1000:
            total = None
    p["thc_total_mg"] = round(total, 1) if total else None

    # --- CBD / CBN / CBG per package: store figures where given, else worked out from the name
    scale = None                      # how the THC figure turned into a package total
    if total and mid:
        scale = total / mid
    cbd_mid = mid_of(p.get("cbd_min"), p.get("cbd_max"), pot.get("cbd"))
    if cbd_mid is not None and cbd_mid < 1:
        cbd_mid = None                # stores list "<1" as 0.1-0.5: trace, not a real amount
    amounts, src = {"THC": total}, {}
    if cbd_mid:
        cbd_total = None
        if kind in GRAM_KINDS and units == "mg/g" and grams:
            cbd_total = cbd_mid * grams
        elif kind in ("edible", "beverage", "topical"):
            n = multipack(name)
            cbd_total = cbd_mid * (n if (n > 1 and mid and mid <= 10.5) else 1)
        elif kind == "ingestible":
            if units == "mg/g" and p.get("size_amount"):
                cbd_total = cbd_mid * p["size_amount"]
            elif units in ("mg/unit", "mg/capsule") and pack_count(name):
                cbd_total = cbd_mid * pack_count(name)
        if cbd_total:
            amounts["CBD"] = cbd_total
    for can in ("CBD", "CBN", "CBG", "THC"):
        if can == "THC" and amounts.get("THC"):
            continue
        v = name_mg(name, can) if kind in ("edible", "beverage", "ingestible", "topical") else None
        if v and v <= 5000:
            amounts[can] = v
            src[can] = "name"
    ratio = name_ratio(name)
    if ratio:
        base = next((c for c in ("THC", "CBD", "CBN", "CBG") if amounts.get(c) and ratio.get(c)), None)
        if base:
            for can, r in ratio.items():
                if can in ("CBD", "CBN", "CBG") and not amounts.get(can) and r:
                    amounts[can] = amounts[base] * r / ratio[base]
                    src[can] = "name"
    has = [c for c in ("CBD", "CBN", "CBG") if amounts.get(c) or re.search(rf"\b{c}\b", name, re.I) or (ratio and ratio.get(c))]
    if not p["thc_total_mg"] and amounts.get("THC") and kind != "topical":
        p["thc_total_mg"] = round(amounts["THC"], 1)
        total = amounts["THC"]
    p["cbd_total_mg"] = round(amounts["CBD"], 1) if amounts.get("CBD") else None
    p["cbn_total_mg"] = round(amounts["CBN"], 1) if amounts.get("CBN") else None
    p["cbg_total_mg"] = round(amounts["CBG"], 1) if amounts.get("CBG") else None
    p["cann_from_name"] = sorted(src) or None
    p["minor"] = [c for c in ("CBN", "CBG") if c in has] or None
    # THC:CBD profile: compare concentrations when the store gives both, else package amounts
    t_amt, c_amt = amounts.get("THC"), amounts.get("CBD")
    if mid and cbd_mid:
        t_ref, c_ref = mid, cbd_mid
    else:
        t_ref, c_ref = t_amt or (mid if not cbd_mid else None), c_amt
    tiny = kind in ("edible", "beverage", "topical") and (t_amt or 0) < 2 and (c_amt or 0) < 2
    if kind not in CANNABIS_KINDS:
        prof = None
    elif tiny:
        prof = "CBD-dominant" if "CBD" in has and not p["minor"] else ("Minor cannabinoids" if p["minor"] else None)
    elif t_ref and c_ref:
        r = c_ref / t_ref
        prof = "CBD-dominant" if r >= 2 else ("Balanced" if r >= 0.5 else "THC-dominant")
    elif t_ref:
        prof = "THC-dominant"
    elif c_ref or "CBD" in has:
        prof = "CBD-dominant"
    else:
        prof = None
    p["profile"] = prof
    # CBD-focused / low-THC products are real but don't belong in a THC-value ranking
    cbd = max([v for v in (p.get("cbd_max"), pot.get("max_cbd"), pot.get("cbd")) if v] or [0])
    thc_ref = hi or mid or 0
    low = False
    if kind in ("flower", "preroll", "infused"):
        low = bool(mid) and thc_ref < 100
    elif kind in ("vape", "extract"):
        low = bool(mid) and thc_ref < 300
    elif kind in ("edible", "beverage"):
        low = bool(mid) and (total or 0) < 2
    elif kind == "ingestible":
        low = bool(mid) and units == "mg/g" and thc_ref < 5
    if cbd and thc_ref and cbd >= thc_ref:
        low = True
    if p.get("profile") == "CBD-dominant":
        low = True
    if re.search(r"\bCBD\b", name) and not re.search(r"\bTHC\b", name) and (not mid or thc_ref < 100):
        low = True
    p["cbd_focused"] = low
    if low and p.get("profile") == "THC-dominant":
        p["profile"] = "CBD-dominant" if "CBD" in has else "Low THC"
    pe = p["price_eff"]
    p["per_gram"] = round(pe / grams, 2) if (pe and grams) else None
    p["per_100mg"] = round(pe / total * 100, 2) if (pe and total and total >= 1) else None
    for can in ("cbd", "cbn"):
        t = p[f"{can}_total_mg"]
        p[f"per_100mg_{can}"] = round(pe / t * 100, 2) if (pe and t and t >= 1) else None
    if kind == "vape":
        text = f"{p.get('name') or ''} {p.get('description') or ''}".lower()
        sub = (p.get("subcategory") or "").lower()
        nm = (p.get("name") or "").lower()
        p["vape_type"] = "Disposable" if ("disp" in sub or "disposable" in nm or "all-in-one" in text) else "Cartridge"
        if p["vape_type"] == "Disposable":
            p["hardware"] = "Disposable (rechargeable)" if "recharg" in text else "Disposable"
        elif "pax" in nm:
            p["hardware"] = "PAX pod"
        elif "postless" in text:
            p["hardware"] = "510 (postless)"
        else:
            p["hardware"] = "510"
        p["extract"] = next((lab for rx, lab in [
            (r"liquid diamond", "Liquid diamonds"), (r"live rosin", "Live rosin"), (r"live resin", "Live resin"),
            (r"cured resin", "Cured resin"), (r"\bfse\b|full[- ]spectrum", "Full spectrum"),
            (r"distillate", "Distillate")] if re.search(rx, text)), None)
        if "botanical terp" in text:
            fl = "Added flavour"
        elif NATURAL.search(text):
            fl = "Natural terps"
        elif FRUITY.search(text) or re.search(r"flavou?r", text):
            fl = "Added flavour"
        else:
            fl = "Unclear"
        p["flavour"] = fl
    return p


def flatten(raw, inc):
    a, rel = raw["attributes"], raw.get("relationships", {})

    def ref(k):
        d = (rel.get(k) or {}).get("data")
        return inc.get((d["type"], d["id"])) if isinstance(d, dict) else None

    cat, brand = ref("category"), ref("brand")
    parent = None
    if cat and cat["attributes"].get("parent_category_id"):
        parent = inc.get(("product_categories", cat["attributes"]["parent_category_id"]))
    tags = []
    for t in (rel.get("tags") or {}).get("data") or []:
        ti = inc.get((t["type"], t["id"]))
        tags.append(ti["attributes"].get("name") if ti else t["id"])
    pot = a.get("potency") or {}
    size = a.get("size") or {}
    cw = a.get("cannabis_weight") or {}
    clean = lambda s: (s or "").strip() or None
    p = {
        "id": raw["id"], "name": clean(a.get("name")), "brand": clean(brand and brand["attributes"]["name"]),
        "brand_id": brand and brand["id"],
        "category": clean((parent or cat or {}).get("attributes", {}).get("name")),
        "subcategory": clean(cat["attributes"]["name"]) if (cat and parent) else None,
        "flower_type": a.get("flower_type"), "strain": a.get("strain"),
        "size": size.get("display_text"), "size_amount": size.get("amount"), "size_units": size.get("units"),
        "cannabis_weight": cw.get("display_text"),
        "price": money(a.get("unit_price")), "sale_price": money(a.get("discount_price")),
        "on_sale": a.get("on_sale"), "discount": a.get("discount"),
        "weight_prices": a.get("weight_prices"), "unit_prices": a.get("unit_prices"),
        "thc_min": num(a.get("min_thc")), "thc_max": num(a.get("max_thc")),
        "cbd_min": num(a.get("min_cbd")), "cbd_max": num(a.get("max_cbd")),
        "potency_units": pot.get("units") or (a.get("max_thc") or {}).get("units"),
        "potency": {k: v for k, v in pot.items() if v} or None,
        "terpenoids": a.get("terpenoids"),
        "in_stock": a.get("in_stock"), "stock_qty": a.get("pos_inventory"),
        "sku": a.get("sku"), "external_id": a.get("external_id"), "type": a.get("type"),
        "is_promoted": a.get("is_promoted"), "tags": tags,
        "description": clean(a.get("description")),
        "image": a.get("main_image"), "url": a.get("store_url"),
        "site_updated_at": a.get("updated_at"),
    }
    return derive(p)


# ---------------------------------------------------------------- state io
def read_versions(prev, versions_json):
    out = {}
    if versions_json:
        out.update(json.loads(versions_json))
    vt = os.path.join(prev or "", "versions.txt")
    if prev and os.path.exists(vt):
        root = os.path.abspath(prev)
        for m in re.finditer(r"version\s+(\d+)\s+\"([^\"]+?\.json)\"", open(vt).read()):
            path = os.path.abspath(m.group(2))
            if path.startswith(root):
                out[os.path.relpath(path, root)[:-5]] = int(m.group(1))
    return out


def load_json(path):
    try:
        return json.load(open(path))
    except Exception:
        return None


def load_state(prev):
    state = {"stores_cfg": None, "meta": {}, "catalog": {}, "chunk_ids": {}, "watch": {}, "ratings": []}
    if not prev or not os.path.isdir(prev):
        return state
    cfg = load_json(os.path.join(prev, "config", "stores.json"))
    if cfg and cfg.get("stores"):
        state["stores_cfg"] = cfg["stores"]
    for f in glob.glob(os.path.join(prev, "stores", "*.json")):
        state["meta"][os.path.basename(f)[:-5]] = load_json(f) or {}
    for d in glob.glob(os.path.join(prev, "stores", "*", "catalog")):
        slug = os.path.basename(os.path.dirname(d))
        prods, ids = {}, []
        for f in sorted(glob.glob(os.path.join(d, "*.json"))):
            doc = load_json(f) or {}
            ids.append(os.path.basename(f)[:-5])
            for p in doc.get("products", []):
                prods[str(p["id"])] = p
        state["catalog"][slug], state["chunk_ids"][slug] = prods, ids
    for f in glob.glob(os.path.join(prev, "data", "users", "*", "watchlist.json")):
        doc = load_json(f) or {}
        state["watch"].update(doc.get("items") or {})
    for f in glob.glob(os.path.join(prev, "data", "users", "*", "ratings.json")):
        doc = load_json(f) or {}
        for rid, e in (doc.get("items") or {}).items():
            if isinstance(e, dict) and e.get("stars"):
                state["ratings"].append(e)
    return state


# ---------------------------------------------------------------- diffing
def diff_store(prev, cur, stamp):
    first = not prev
    ch = {k: [] for k in ("new", "returned", "price", "sale", "removed")}
    merged = {}
    for pid, p in cur.items():
        old = prev.get(pid)
        p["status"] = "listed"
        if not old:
            p["first_seen"] = stamp
            p["price_history"] = [[stamp, p["price"], p["sale_price"]]]
            if not first:
                ch["new"].append(p)
        else:
            p["first_seen"] = old.get("first_seen", stamp)
            ph = list(old.get("price_history") or [])
            if old.get("status") == "gone":
                ch["returned"].append(p)
            if old.get("price") != p["price"]:
                ch["price"].append((old.get("price"), p))
                ph.append([stamp, p["price"], p["sale_price"]])
            elif old.get("sale_price") != p["sale_price"]:
                ch["sale"].append((old.get("sale_price"), p))
                ph.append([stamp, p["price"], p["sale_price"]])
            p["price_history"] = ph[-20:]
        merged[pid] = p
    for pid, old in prev.items():
        if pid in cur:
            continue
        if old.get("status") != "gone":
            old = dict(old, status="gone", gone_since=stamp, in_stock=False)
            ch["removed"].append(old)
        merged[pid] = old
    cutoff = (datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%MZ") - datetime.timedelta(days=90)).strftime("%Y-%m-%dT%H:%MZ")
    merged = {k: v for k, v in merged.items() if not (v.get("status") == "gone" and v.get("gone_since", stamp) < cutoff)}
    return merged, ch, first


def kind_rank(p):
    return (KIND_ORDER.index(p.get("kind", "other")) if p.get("kind") in KIND_ORDER else 99, p.get("name") or "")


SLIM_KEYS = ("id", "key", "name", "brand", "kind", "category", "subcategory", "price", "sale_price", "thc_min",
             "thc_max", "potency_units", "size", "url", "vape_type", "flavour")


def slim(p, **extra):
    d = {k: p.get(k) for k in SLIM_KEYS}
    d.update(extra)
    return d


def watch_alerts(watch, slug, name, ch, merged):
    """Alerts for watched keys at this store (email). Page computes its own per viewer."""
    out = []
    if not watch:
        return out
    by_key = {}
    for p in merged.values():
        by_key.setdefault(p.get("key"), []).append(p)
    for p in ch["new"] + ch["returned"]:
        w = watch.get(p["key"])
        if w:
            out.append(f"Back on the menu at {name}: {fmt(p)}")
    for old, p in ch["price"]:
        if watch.get(p["key"]) and old is not None and (p.get("price") or 0) < old:
            out.append(f"Price drop at {name}: {fmt(p)} (was ${old:.2f})")
    for old, p in ch["sale"]:
        if watch.get(p["key"]) and p.get("sale_price") and (old is None or p["sale_price"] < old):
            out.append(f"On sale at {name}: {fmt(p)}")
    for key, w in watch.items():
        tgt = w.get("target_price")
        if not tgt:
            continue
        for p in by_key.get(key, []):
            if p.get("status") == "listed" and p.get("price_eff") and p["price_eff"] <= tgt:
                hit = any(q is p for q in ch["new"] + ch["returned"]) or any(q is p for _, q in ch["price"] + ch["sale"])
                if hit:
                    out.append(f"At or below your ${tgt:.2f} target at {name}: {fmt(p)}")
    return list(dict.fromkeys(out))


def rated_returns(ratings, name, ch):
    """New or returning products that match something the user rated 4-5 stars."""
    out = []
    liked = [e for e in ratings if (e.get("stars") or 0) >= 4]
    if not liked:
        return out
    for p in ch["new"] + ch["returned"]:
        text = norm(f"{p.get('brand') or ''} {p.get('name') or ''}").replace("-", " ")
        for e in liked:
            if e.get("key") and e["key"] == p.get("key"):
                hit = True
            elif e.get("match") and (not e.get("kind") or e["kind"] == p.get("kind")):
                hit = all(norm(m).replace("-", " ") in text for m in e["match"])
            else:
                hit = False
            if hit:
                out.append(f"You rated {e['stars']}★ ({e.get('name')}), now on the menu at {name}: {fmt(p)}")
                break
    return out


def fmt(p):
    head = " — ".join(x for x in [p.get("brand"), p.get("name")] if x)
    bits = []
    if p.get("subcategory") or p.get("category"):
        bits.append(p.get("subcategory") or p.get("category"))
    if p.get("price") is not None:
        bits.append(f"${p['price']:.2f}" + (f" → sale ${p['sale_price']:.2f}" if p.get("sale_price") else ""))
    if p.get("thc_max"):
        rng = f"{p['thc_min']:g}–{p['thc_max']:g}" if p.get("thc_min") and p["thc_min"] != p["thc_max"] else f"{p['thc_max']:g}"
        bits.append(f"THC {rng} {p.get('potency_units') or ''}".strip())
    if p.get("kind") == "vape" and p.get("flavour"):
        bits.append(p["flavour"].lower())
    return f"{head} [{', '.join(bits)}]"


# ---------------------------------------------------------------- pictures
# Media index docs: stores/<slug>/media/idx-NN = {"items": {<product key>: {"src": <store image url>, "id": <asset id>}}}
# Upload mode (now): pictures are uploaded to the app's asset store and served at /_blob/<id>.
# Inline mode (ready for later, --inline): the picture itself is kept as a data: URI in "data"
# instead of "id", so the app needs no uploaded files (and can be shared by public link).
THUMB_QS = "w=240&h=240&fit=max&fm=webp&q=70"
THUMB_QS_INLINE = "w=120&h=120&fit=max&fm=webp&q=55"   # inline pictures live in the database, so keep them small
MEDIA_CHUNK = 150_000


def thumb_url(src, inline=False):
    return src + ("&" if "?" in src else "?") + (THUMB_QS_INLINE if inline else THUMB_QS)


def safe_name(key):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", key)[:100]


def load_media(prev, slug):
    items, ids = {}, []
    for f in sorted(glob.glob(os.path.join(prev or "", "stores", slug, "media", "*.json"))):
        doc = load_json(f) or {}
        ids.append(os.path.basename(f)[:-5])
        items.update(doc.get("items") or {})
    return items, ids


def thumbs(args):
    """Download pictures for listed products that don't have one yet (or whose picture changed)."""
    state = load_state(args.prev)
    stores = state["stores_cfg"] or DEFAULT_STORES
    os.makedirs(os.path.join(args.out, "thumbs"), exist_ok=True)
    todo = []
    for st in stores:
        slug = st["slug"]
        media, _ = load_media(args.prev, slug)
        seen = set()
        try:
            raw, inc, _ = fetch_store(st["site_id"])
            current = [flatten(r, inc) for r in raw]
        except Exception:
            current = list(state["catalog"].get(slug, {}).values())
        for p in current:
            if p.get("status") == "gone" or not p.get("image") or p["key"] in seen or is_placeholder(p):
                continue    # placeholder pictures are handled by the photo matcher (engine.py photos)
            seen.add(p["key"])
            m = media.get(p["key"])
            if m and m.get("src") == p["image"] and (m.get("id") or m.get("data")):
                continue
            todo.append((slug, p))
    todo = todo[: args.limit]
    done = []
    for slug, p in todo:
        fn = f"{slug}__{safe_name(p['key'])}.webp"
        path = os.path.abspath(os.path.join(args.out, "thumbs", fn))
        try:
            req = urllib.request.Request(thumb_url(p["image"], args.inline), headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if len(data) < 200 or len(data) > 300_000:
                continue
            open(path, "wb").write(data)
            done.append({"slug": slug, "key": p["key"], "src": p["image"], "file": path, "name": fn, "bytes": len(data)})
        except Exception:
            continue
    json.dump(done, open(os.path.join(args.out, "thumbs_todo.json"), "w"), indent=1)
    groups = [[d["file"] for d in done[i:i + 25]] for i in range(0, len(done), 25)]
    json.dump(groups, open(os.path.join(args.out, "thumbs_upload_groups.json"), "w"), indent=1)
    print(json.dumps({"downloaded": len(done), "upload_calls": len(groups), "inline": bool(args.inline)}))


def thumbs_index(args):
    """Record pictures in the media index. Upload mode: --uploaded maps file name -> asset id or url.
    Inline mode: --inline embeds each downloaded picture as a data: URI."""
    import base64
    state = load_state(args.prev)
    versions = read_versions(args.prev, args.versions)
    done = load_json(os.path.join(args.out, "thumbs_todo.json")) or []
    up = {}
    if args.uploaded:
        raw = load_json(args.uploaded) or {}
        for k, v in raw.items():
            m = re.search(r"([0-9a-f]{32})", str(v))
            if m:
                up[os.path.basename(k)] = m.group(1)
    writes = []
    for slug in sorted({d["slug"] for d in done}):
        # keep every picture in the doc it already lives in; new ones go to the last doc (or a new one),
        # so one new product rewrites one doc, not the whole index
        docs = {}
        for f in sorted(glob.glob(os.path.join(args.prev or "", "stores", slug, "media", "*.json"))):
            docs[os.path.basename(f)[:-5]] = (load_json(f) or {}).get("items") or {}
        where = {k: did for did, items in docs.items() for k in items}
        size = lambda items: len(json.dumps(items, separators=(",", ":")))
        touched = set()
        for d in done:
            if d["slug"] != slug:
                continue
            if args.inline:
                b64 = base64.b64encode(open(d["file"], "rb").read()).decode()
                entry = {"src": d["src"], "data": "data:image/webp;base64," + b64}
            elif up.get(d["name"]):
                entry = {"src": d["src"], "id": up[d["name"]]}
            else:
                continue
            did = where.get(d["key"])
            if not did:
                last = sorted(docs)[-1] if docs else None
                if last is None or size(docs[last]) + len(json.dumps(entry)) > MEDIA_CHUNK:
                    last = f"idx-{len(docs):02d}"
                    while last in docs:
                        last = f"idx-{int(last[4:]) + 1:02d}"
                    docs[last] = {}
                did = last
                where[d["key"]] = did
            docs[did][d["key"]] = entry
            touched.add(did)
        for did in sorted(touched):
            fp = os.path.abspath(os.path.join(args.out, f"media__{slug}__{did}.json"))
            json.dump({"items": docs[did]}, open(fp, "w"), separators=(",", ":"))
            w = {"op": "set", "collection": f"stores/{slug}/media", "doc_id": did, "file_path": fp}
            v = versions.get(f"stores/{slug}/media/{did}")
            existed = os.path.exists(os.path.join(args.prev or "", "stores", slug, "media", did + ".json"))
            if v:
                w["if_version"] = v
            elif existed:
                sys.exit(f"ABORT: no version for existing doc stores/{slug}/media/{did} (add its list output to versions.txt)")
            writes.append(w)
    batches, b, bs = [], [], 0
    for w in writes:
        s = os.path.getsize(w["file_path"]) if "file_path" in w else 200
        if b and (bs + s > BATCH_BYTES or len(b) >= 50):
            batches.append(b)
            b, bs = [], 0
        b.append(w)
        bs += s
    if b:
        batches.append(b)
    for f in glob.glob(os.path.join(args.out, "media_batch_*.json")):
        os.remove(f)
    for i, b in enumerate(batches):
        json.dump(b, open(os.path.join(args.out, f"media_batch_{i}.json"), "w"), indent=1)
    print(json.dumps({"recorded": sum(1 for d in done if args.inline or up.get(d["name"])), "batches": len(batches)}))


# ---------------------------------------------------------------- photo matcher
# Products whose store picture is a generic placeholder get a real photo from the OCS public catalog
# (Shopify: ocs.ca/products.json). Results are cached per product key in
#   stores/<slug>/imagematches/m-NN   {"items": {<key>: {st, sc, sku, name, at, pick, cands, man}}}
#     st: "auto" (score >= 80, shown as "matched photo"), "ask" (50-79 or strain-only: owner picks),
#         "none" (nothing close); pick/cands: {h: handle, t: title, v: vendor, s: score, src, th: data: URI}
#     man: {h, th} a 200px picture for the owner's manual choice, filled in on the next run
#   stores/<slug>/imagematches/overrides  {"items": {<key>: {"h": <handle> | "none", "at"}}}  written by the page
PLACEHOLDER = "/catalogue/categories/defaults/"
OCS_URL = "https://ocs.ca/products.json?limit=250&page={}"
MATCH_AUTO, MATCH_ASK = 80, 50
MATCH_RECHECK_DAYS = 7
MATCH_KINDS = CANNABIS_KINDS | {"seed"}
PICK_W, CAND_W = 200, 120
FORMAT_WORDS = set("""pre roll rolls preroll prerolls joint joints blunt blunts vape vapes cartridge cartridges catridge cart
    carts prefilled prefill disposable pod pods soft chew chews gummy gummies x g mg ml pk pack packs pc pcs piece pieces
    of the and by with a an thc cbd cbn cbg cbc thcv reg regular fem feminized seeds seed dried flower whole milled infused
    edible edibles multipack multi indica sativa hybrid blend bath bomb salts oil capsules caps softgels spray""".split())
VENDOR_SUFFIX = re.compile(r"\s+(?:cannabis|co|company|inc|ltd|corp|brands?|labs?)$")
OCS_KIND_RX = [("infused", r"infused"), ("preroll", r"pre-?\s?rolls?|preroll|\bjoints?\b|\bblunts?\b"),
               ("vape", r"vape|cartridge|\b510\b|disposable|\bpods?\b"),
               ("edible", r"gumm|chew|chocolate|edible|cookie|baked|candy|\bmints?\b|\bbites?\b|caramel|lozenge"),
               ("beverage", r"beverage|drink|soda|sparkling|seltzer|\btea\b|\bshots?\b"),
               ("ingestible", r"\boils?\b|capsule|softgel|spray|tincture|ingestible"),
               ("topical", r"topical|\bbath\b|lotion|balm|cream|salve"), ("seed", r"\bseeds?\b"),
               ("extract", r"hash|rosin|shatter|\bwax\b|kief|concentrate|extract|diamonds?|budder|badder|sauce"),
               ("flower", r"flower|dried|whole bud|milled|ground")]
COMPAT = {"infused": "preroll"}


def is_placeholder(p):
    return PLACEHOLDER in (p.get("image") or "")


def toks(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split()


def distinct_tokens(s, drop):
    return {t for t in toks(s) if len(t) > 1 and t not in FORMAT_WORDS and t not in drop and not re.search(r"\d", t)}


def near(a, b):
    """Same word, allowing one typo in words of 5+ letters."""
    if a == b:
        return True
    if min(len(a), len(b)) < 5 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = j = diff = 0
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            diff += 1
            if diff > 1:
                return False
            if len(a) == len(b):
                i += 1
            j += 1
        else:
            i += 1
            j += 1
    return diff + (len(b) - j) + (len(a) - i) <= 1


def ratios(s):
    return set(re.findall(r"\d+(?:\.\d+)?(?:\s*:\s*\d+(?:\.\d+)?)+", s or ""))


def sizes(s):
    s = (s or "").lower()
    rx = r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g\b"
    out = {f"{int(n)}x{float(g):g}" for n, g in re.findall(rx, s)}
    out |= {f"{float(g):g}g" for g in re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)\s*g\b", re.sub(rx, " ", s))}
    return out


def ocs_kind(o):
    tags = o.get("tags") or []
    tags = " ".join(tags) if isinstance(tags, list) else str(tags)
    for text in (o.get("product_type") or "", o.get("title") or "", tags):
        text = text.lower()
        k = next((k for k, rx in OCS_KIND_RX if re.search(rx, text)), None)
        if k:
            return k
    return None


def vnorm(v):
    full = " ".join(toks(v))
    strip = VENDOR_SUFFIX.sub("", full)
    return full, (strip if strip != full and len(strip) >= 4 else None)


def fetch_ocs(cache_path=None, max_pages=60):
    if cache_path and os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < 6 * 3600:
        return load_json(cache_path)
    out = []
    for page in range(1, max_pages + 1):
        req = urllib.request.Request(OCS_URL.format(page), headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    batch = json.load(r).get("products") or []
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))
        if not batch:
            break
        for o in batch:
            imgs = [i.get("src") for i in (o.get("images") or []) if i.get("src")]
            if not imgs:
                continue
            opts = " ".join(str(v.get("title") or "") for v in (o.get("variants") or []))
            out.append({"h": o.get("handle"), "t": o.get("title") or "", "v": o.get("vendor") or "",
                        "pt": o.get("product_type") or "", "tags": o.get("tags") or [], "opts": opts, "src": imgs[0]})
        time.sleep(0.5)
    if cache_path:
        json.dump(out, open(cache_path, "w"))
    return out


def prep_ocs(ocs):
    vendors = {}
    for o in ocs:
        full, strip = vnorm(o["v"])
        o["_vf"], o["_vs"] = full, strip
        o["_kind"] = ocs_kind({"product_type": o.get("pt"), "title": o["t"], "tags": o.get("tags")})
        o["_sizes"] = sizes(f"{o['t']} {o.get('opts') or ''}")
        o["_ratios"] = ratios(o["t"])
        o["_T"] = distinct_tokens(o["t"], set())
        if full:
            vendors[full] = o["v"]
        if strip:
            vendors[strip] = o["v"]
    return vendors


def vendor_hits(p, vendors):
    hay = " " + " ".join(toks(f"{p.get('brand') or ''} {p.get('name') or ''}")) + " "
    return {v for v in vendors if v and f" {v} " in hay}


def score_match(p, o, vh):
    """0-100ish: brand 35, distinctive-word overlap 45, format 10, size 10, ratio +5/-15."""
    if vh:
        b = 35 if (o["_vf"] in vh or (o["_vs"] and o["_vs"] in vh)) else -15
    else:
        b = 0
    drop = {t for v in vh for t in v.split()} | set(o["_vf"].split())
    D = p["_D"] - drop
    T = o["_T"] - drop
    hit = sum(1 for d in D if any(near(d, t) for t in T))
    dice = 2 * hit / (len(D) + len(T)) if D and T else 0.0
    clash = -15 if (D and T and not hit) else 0      # both name something, and nothing in common
    kind = p.get("kind")
    ok = o["_kind"]
    if not ok:
        k = 0
    elif COMPAT.get(ok, ok) == COMPAT.get(kind, kind):
        k = 10
    else:
        k = -40
    s = 10 if (sizes(p.get("name")) & o["_sizes"]) else 0
    pr = ratios(p.get("name"))
    r = (5 if pr & o["_ratios"] else -15) if (pr and o["_ratios"]) else 0
    return round(min(100, b + 45 * dice + k + s + r + clash), 1), dice, k, b


def match_one(p, ocs, vendors):
    vh = vendor_hits(p, vendors)
    p = dict(p, _D=distinct_tokens(p.get("name"), set()))
    scored = []
    for o in ocs:
        sc, dice, k, b = score_match(p, o, vh)
        if k < 0:
            continue                      # wrong format (a vape is never matched to a gummy)
        if sc >= 35 or (dice >= 0.6 and b >= 0):
            scored.append((sc, dice, o))
    scored.sort(key=lambda x: -x[0])
    cands, seen = [], set()
    for sc, dice, o in scored:
        if o["src"] in seen:
            continue
        seen.add(o["src"])
        cands.append((sc, dice, o))
        if len(cands) == 3:
            break
    if not cands:
        return "none", 0, []
    best = cands[0]
    ambiguous = len(cands) > 1 and cands[1][0] >= MATCH_AUTO and best[0] - cands[1][0] < 5
    if best[0] >= MATCH_AUTO and best[1] >= 0.6 and not ambiguous:
        st = "auto"
    elif best[0] >= MATCH_ASK or any(d >= 0.6 for _, d, _ in cands):
        st = "ask"             # includes the strain-only fallback (same strain name, brand unknown)
    else:
        return "none", best[0], []
    return st, best[0], cands


def fetch_thumb(src, width):
    url = src + ("&" if "?" in src else "?") + f"width={width}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "image/webp,image/*;q=0.8"})
    import base64
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
    if not ctype.startswith("image/"):
        ctype = "image/webp" if data[8:12] == b"WEBP" else ("image/png" if data[:4] == b"\x89PNG" else "image/jpeg")
    if len(data) < 200 or len(data) > 120_000:
        raise ValueError(f"picture size {len(data)}")
    return f"data:{ctype};base64," + base64.b64encode(data).decode()


def photos(args):
    """Match placeholder pictures to OCS photos and write stores/<slug>/imagematches docs (photo_batch_N.json)."""
    state = load_state(args.prev)
    versions = read_versions(args.prev, args.versions)
    stores = state["stores_cfg"] or DEFAULT_STORES
    os.makedirs(args.out, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H:%MZ")
    recheck = (now - datetime.timedelta(days=MATCH_RECHECK_DAYS)).strftime("%Y-%m-%dT%H:%MZ")
    ocs = vendors = None
    writes, report = [], {}
    for st in stores:
        slug = st["slug"]
        mdir = os.path.join(args.prev or "", "stores", slug, "imagematches")
        docs, overrides = {}, {}
        for f in sorted(glob.glob(os.path.join(mdir, "*.json"))):
            did = os.path.basename(f)[:-5]
            items = (load_json(f) or {}).get("items") or {}
            if did == "overrides":
                overrides = items
            else:
                docs[did] = items
        where = {k: did for did, items in docs.items() for k in items}
        cache = {k: docs[did][k] for k, did in where.items()}
        prods = [p for p in state["catalog"].get(slug, {}).values()
                 if p.get("status") != "gone" and is_placeholder(p) and p.get("kind") in MATCH_KINDS]
        todo = [p for p in prods if not cache.get(p["key"])
                or (cache[p["key"]].get("st") in ("none", "ask") and (cache[p["key"]].get("at") or "") < recheck)]
        todo = list({p["key"]: p for p in todo}.values())[: args.limit]
        changed = {}
        if todo and ocs is None:
            ocs = fetch_ocs(os.path.join(args.out, "ocs_catalog.json"))
            vendors = prep_ocs(ocs)
        counts = {"auto": 0, "ask": 0, "none": 0, "thumb_errors": 0}
        for p in todo:
            stt, sc, cands = match_one(p, ocs, vendors)
            old = cache.get(p["key"]) or {}
            entry = {"st": stt, "sc": sc, "sku": p.get("sku"), "name": p.get("name"), "at": stamp, "cands": []}
            for i, (csc, _, o) in enumerate(cands):
                c = {"h": o["h"], "t": o["t"], "v": o["v"], "s": csc, "src": o["src"]}
                try:
                    c["th"] = fetch_thumb(o["src"], PICK_W if (i == 0 and stt == "auto") else CAND_W)
                except Exception:
                    counts["thumb_errors"] += 1
                    continue
                entry["cands"].append(c)
            if stt == "auto":
                if entry["cands"] and entry["cands"][0]["h"] == cands[0][2]["h"]:
                    entry["pick"] = entry["cands"][0]
                else:
                    entry["st"] = "ask" if entry["cands"] else "none"
            if cands and not entry["cands"]:
                continue                # pictures couldn't be downloaded: try again next run
            if old.get("man"):
                entry["man"] = old["man"]
            counts[entry["st"]] += 1
            changed[p["key"]] = entry
        # owner's manual choices: fetch a full-size picture for the chosen candidate once
        for key, ov in overrides.items():
            h = (ov or {}).get("h")
            e = changed.get(key) or cache.get(key)
            if not e or not h or h == "none" or (e.get("man") or {}).get("h") == h:
                continue
            c = next((c for c in e.get("cands") or [] if c.get("h") == h), None)
            if not c:
                continue
            try:
                e = dict(e, man={"h": h, "th": fetch_thumb(c["src"], PICK_W)})
                changed[key] = e
            except Exception:
                counts["thumb_errors"] += 1
        # place changed entries: keep each in its doc, new ones go to the last doc (or a new one)
        size = lambda items: len(json.dumps(items, separators=(",", ":")))
        touched = set()
        for key, entry in changed.items():
            did = where.get(key)
            if did:
                docs[did][key] = entry
                if size(docs[did]) > 240_000:          # grew too big: move it to the newest doc
                    del docs[did][key]
                    touched.add(did)
                    did = None
            if not did:
                last = sorted(docs)[-1] if docs else None
                if last is None or size(docs[last]) + size({key: entry}) > MEDIA_CHUNK:
                    last = f"m-{len(docs):02d}"
                    while last in docs:
                        last = f"m-{int(last[2:]) + 1:02d}"
                    docs[last] = {}
                did = last
                docs[did][key] = entry
                where[key] = did
            touched.add(did)
        for did in sorted(touched):
            fp = os.path.abspath(os.path.join(args.out, f"imagematches__{slug}__{did}.json"))
            json.dump({"items": docs[did]}, open(fp, "w"), separators=(",", ":"))
            w = {"op": "set", "collection": f"stores/{slug}/imagematches", "doc_id": did, "file_path": fp}
            v = versions.get(f"stores/{slug}/imagematches/{did}")
            if v:
                w["if_version"] = v
            elif os.path.exists(os.path.join(mdir, did + ".json")):
                sys.exit(f"ABORT: no version for existing doc stores/{slug}/imagematches/{did} (add its list output to versions.txt)")
            writes.append(w)
        allk = {**cache, **changed}
        live = [allk.get(p["key"]) or {} for p in prods]
        report[slug] = {"placeholders": len(prods), "checked": len(todo), "new": counts,
                        "totals": {s: sum(1 for e in live if e.get("st") == s) for s in ("auto", "ask", "none")},
                        "manual": sum(1 for p in prods if (overrides.get(p["key"]) or {}).get("h"))}
    batches, b, bs = [], [], 0
    for w in writes:
        s = os.path.getsize(w["file_path"])
        if b and (bs + s > BATCH_BYTES or len(b) >= 50):
            batches.append(b)
            b, bs = [], 0
        b.append(w)
        bs += s
    if b:
        batches.append(b)
    for f in glob.glob(os.path.join(args.out, "photo_batch_*.json")):
        os.remove(f)
    for i, b in enumerate(batches):
        json.dump(b, open(os.path.join(args.out, f"photo_batch_{i}.json"), "w"), indent=1)
    lines = []
    for slug, r in report.items():
        t = r["totals"]
        if r["placeholders"]:
            lines.append(f"Photos ({slug}): {r['placeholders']} products have only a placeholder picture; "
                         f"{t['auto']} matched automatically, {t['ask']} waiting for a pick, {t['none']} with no close match"
                         + (f", {r['manual']} picked by hand" if r["manual"] else "") + ".")
    open(os.path.join(args.out, "photos_summary.md"), "w").write("\n".join(lines) + ("\n" if lines else ""))
    print(json.dumps({"stores": report, "batches": len(batches)}))


# ---------------------------------------------------------------- main
def run(args):
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H:%MZ")
    local = now.astimezone(MT).strftime("%a %b %d %Y %I:%M %p MT")
    state = load_state(args.prev)
    versions = read_versions(args.prev, args.versions)
    stores = state["stores_cfg"] or DEFAULT_STORES
    os.makedirs(args.out, exist_ok=True)
    writes, lines_alerts, sections, result = [], [], [], {"stores": {}}

    def add_write(docpath, data, op="set"):
        coll, did = docpath.rsplit("/", 1)
        w = {"op": op, "collection": coll, "doc_id": did}
        if data is not None:
            fp = os.path.abspath(os.path.join(args.out, docpath.replace("/", "__") + ".json"))
            json.dump(data, open(fp, "w"), separators=(",", ":"))
            w["file_path"] = fp
        if versions.get(docpath):
            w["if_version"] = versions[docpath]
        writes.append(w)

    if not state["stores_cfg"]:
        add_write("config/stores", {"stores": stores})

    for st in stores:
        slug, sname = st["slug"], st.get("name") or st["slug"]
        try:
            raw, inc, total = fetch_store(st["site_id"])
        except Exception as e:
            sections.append(f"\n== {sname}: CHECK FAILED ({e.__class__.__name__}: {e}) ==")
            result["stores"][slug] = {"error": str(e)}
            continue
        cur = {str(r["id"]): flatten(r, inc) for r in raw}
        if len(cur) < max(50, 0.5 * total):
            sections.append(f"\n== {sname}: CHECK FAILED (only {len(cur)} of {total} products fetched) ==")
            result["stores"][slug] = {"error": "partial fetch"}
            continue
        prev = state["catalog"].get(slug, {})
        merged, ch, first = diff_store(prev, cur, stamp)

        # catalog chunks (only changed ones are written)
        chunks, buf, size = [], [], 0
        for p in sorted(merged.values(), key=lambda x: int(x["id"])):
            s = len(json.dumps(p, separators=(",", ":")))
            if buf and size + s > CHUNK_BYTES:
                chunks.append(buf)
                buf, size = [], 0
            buf.append(p)
            size += s
        if buf:
            chunks.append(buf)
        prev_dir = os.path.join(args.prev or "", "stores", slug, "catalog")
        new_ids = set()
        for i, c in enumerate(chunks):
            did = f"chunk-{i:02d}"
            new_ids.add(did)
            old = load_json(os.path.join(prev_dir, did + ".json")) if args.prev else None
            if old and old.get("products") == c:
                continue
            add_write(f"stores/{slug}/catalog/{did}", {"products": c})
        for did in state["chunk_ids"].get(slug, []):
            if did not in new_ids:
                add_write(f"stores/{slug}/catalog/{did}", None, op="delete")

        counts = {k: len(v) for k, v in ch.items()}
        run_doc = {"at": stamp, "local": local, "store": slug, "first_run": first, "total_listed": len(cur),
                   "api_total": total, "counts": counts,
                   "new": [slim(p) for p in sorted(ch["new"], key=kind_rank)],
                   "returned": [slim(p) for p in sorted(ch["returned"], key=kind_rank)],
                   "price_changes": [slim(p, old_price=o) for o, p in ch["price"]],
                   "sale_changes": [slim(p, old_sale_price=o) for o, p in ch["sale"]],
                   "removed": [slim(p) for p in sorted(ch["removed"], key=kind_rank)]}
        add_write(f"stores/{slug}/runs/{stamp.replace(':', '')}", run_doc)
        meta = dict(state["meta"].get(slug) or {})
        meta.update({"slug": slug, "name": sname, "menu_url": st.get("menu_url"), "last_run": stamp,
                     "last_run_local": local, "total_listed": len(cur),
                     "chunks": len(chunks), "last_counts": counts})
        add_write(f"stores/{slug}", meta)

        lines_alerts += watch_alerts(state["watch"], slug, sname, ch, merged)
        lines_alerts += rated_returns(state["ratings"], sname, ch)
        sec = [f"\n== {sname}: {len(cur)} products listed =="]
        if first:
            sec.append("First check for this store: baseline saved.")
        blocks = [("NEW PRODUCTS", sorted(ch["new"], key=kind_rank), fmt),
                  ("BACK ON THE MENU", sorted(ch["returned"], key=kind_rank), fmt),
                  ("PRICE CHANGES", ch["price"], lambda t: f"${(t[0] or 0):.2f} → ${(t[1]['price'] or 0):.2f}: {fmt(t[1])}"),
                  ("SALE CHANGES", ch["sale"], lambda t: f"{'$%.2f' % t[0] if t[0] else 'no sale'} → "
                                                        f"{'$%.2f' % t[1]['sale_price'] if t[1].get('sale_price') else 'no sale'}: {fmt(t[1])}"),
                  ("GONE FROM MENU (sold out or delisted)", sorted(ch["removed"], key=kind_rank), fmt)]
        anych = False
        for title, items, f in blocks:
            if items:
                anych = True
                sec.append(f"\n{title} ({len(items)})")
                sec += [f"- {f(x)}" for x in items]
        if not first and not anych:
            sec.append("No changes since the last check.")
        sections += sec
        result["stores"][slug] = {"listed": len(cur), "counts": counts, "first_run": first,
                                  "new": [f"{p.get('brand') or ''} — {p['name']}" for p in sorted(ch["new"], key=kind_rank)][:40],
                                  "returned": [f"{p.get('brand') or ''} — {p['name']}" for p in ch["returned"]][:40]}

    # batches
    batches, b, bs = [], [], 0
    for w in writes:
        s = os.path.getsize(w["file_path"]) if "file_path" in w else 200
        if b and (bs + s > BATCH_BYTES or len(b) >= 50):
            batches.append(b)
            b, bs = [], 0
        b.append(w)
        bs += s
    if b:
        batches.append(b)
    for f in glob.glob(os.path.join(args.out, "batch_*.json")):
        os.remove(f)
    for i, b in enumerate(batches):
        json.dump(b, open(os.path.join(args.out, f"batch_{i}.json"), "w"), indent=1)

    L = [f"Country Cannabis menu check — {local}"]
    if lines_alerts:
        L.append(f"\nALERTS FOR YOU ({len(lines_alerts)})")
        L += [f"- {a}" for a in lines_alerts]
    L += sections
    if args.app_url:
        L.append(f"\nOpen the app: {args.app_url}")
    open(os.path.join(args.out, "summary.md"), "w").write("\n".join(L) + "\n")
    existing = set()
    if args.prev and os.path.isdir(args.prev):
        for f in glob.glob(os.path.join(args.prev, "**", "*.json"), recursive=True):
            existing.add(os.path.relpath(f, args.prev)[:-5])
    missing = [w["collection"] + "/" + w["doc_id"] for w in writes
               if "if_version" not in w and (w["collection"] + "/" + w["doc_id"]) in existing]
    result.update({"batches": len(batches), "writes": len(writes), "alerts": len(lines_alerts),
                   "stamp": stamp, "missing_versions": missing})
    json.dump(result, open(os.path.join(args.out, "result.json"), "w"), indent=1)
    print(json.dumps(result))
    if all("error" in v for v in result["stores"].values()):
        sys.exit("ABORT: every store failed")
    if missing and not args.assume_new:
        sys.exit("ABORT: no version for existing docs " + ", ".join(missing) + " (add the list outputs to versions.txt)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("run")
    r.add_argument("--prev")
    r.add_argument("--out", required=True)
    r.add_argument("--versions", help="JSON map of doc path -> version (alternative to PREV/versions.txt)")
    r.add_argument("--app-url")
    r.add_argument("--assume-new", action="store_true", help=argparse.SUPPRESS)
    t = sp.add_parser("thumbs", help="download pictures for products that lack one")
    t.add_argument("--prev"); t.add_argument("--out", required=True)
    t.add_argument("--limit", type=int, default=100); t.add_argument("--inline", action="store_true")
    ti = sp.add_parser("thumbs-index", help="record downloaded pictures in the media index")
    ti.add_argument("--prev"); ti.add_argument("--out", required=True); ti.add_argument("--versions")
    ti.add_argument("--uploaded", help="JSON map: uploaded file name -> asset id (or its /_blob/<id> url)")
    ti.add_argument("--inline", action="store_true", help="store pictures as data: URIs instead of uploads")
    ph = sp.add_parser("photos", help="match placeholder pictures to OCS catalog photos")
    ph.add_argument("--prev"); ph.add_argument("--out", required=True); ph.add_argument("--versions")
    ph.add_argument("--limit", type=int, default=150)
    a = ap.parse_args()
    {"run": run, "thumbs": thumbs, "thumbs-index": thumbs_index, "photos": photos}[a.cmd](a)
