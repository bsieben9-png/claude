# Calmar Menu Tracker: how it's built

This file is for extending the app later. It is published next to the page as README.md.

## Pieces
- **The app page** (index): two tabs, Menu and Watchlist, plus a Change log reached from the footer. The Menu covers every category with its own filters (vapes live here) and sorts by best THC value by default; "Cheapest CBD" and "Cheapest CBN" sit in the Sort list. Each product carries your 1–5 star rating and notes. A "?" button in the header opens a plain-language how-to panel. It reads the artifact database live and uses the Bran Dark design system.
- **engine.txt** (Python): fetches every store's menu from the store's product API, adds the computed fields, diffs against the last check, and writes a plan of database writes plus the email summary. Scheduled Claude runs download it, run it, and apply the writes.
- **Scheduled tasks** (Claude account): "Calmar menu check (morning)" at 8:52 AM and "(midnight)" at 12:00 AM, both emailing the summary; "(afternoon)" at 4:20 PM with no email. "(on demand)" has no schedule. The app's Check now button starts it through the Claude Code Remote connector. Every check also runs `engine.py photos` after the pictures step.

## Data source
`GET https://ecom-api.blaze.me/api/v1/products/?limit=100&offset=N&delivery_type=pickup` with header `X-Store: <site id>`.
Categories come from `/api/v2/products/categories/`. Only in-stock products are returned.
Calmar site id: `ca9cba05-b18a-4dda-9c12-a4c5fa378083`. Other Country Cannabis stores (for example Thorsby, at shop.countrycannabisstore.ca/menu/thorsby/) have their own id in the page's `__NEXT_DATA__` (props.pageProps.site.id).

## Database layout
| Path | What |
|---|---|
| `config/stores` | `{stores:[{slug,name,site_id,menu_url}]}`. Add a store here and the next check picks it up. |
| `config/app` | `{check_trigger_id}` for the Check now button |
| `stores/<slug>` | store meta: last_run, total_listed, last_counts |
| `stores/<slug>/catalog/chunk-NN` | `{products:[…]}`, every product plus items gone for under 90 days |
| `stores/<slug>/runs/<stamp>` | one check's changes: new, returned, price_changes, sale_changes, removed |
| `checks/last` | when Check now was last pressed |
| `stores/<slug>/imagematches/m-NN` | photo matches for placeholder pictures, keyed by product key: `{st: auto/ask/none, sc, sku, name, at, pick, cands:[{h, t, v, s, src, th}], man}`. `th` is an inline `data:` picture (200px for the pick, 120px for other candidates). |
| `stores/<slug>/imagematches/overrides` | the owner's photo choices from the page: `{items:{<key>:{h: <OCS handle> or "none", stock: true, at}}}`. `stock` marks a store picture that is really a generic stock box (uploaded as a normal photo, so the URL check can't catch it); the matcher then treats it like a placeholder. |
| `stores/<slug>/media/idx-NN` | pictures: `{items:{<product key>:{src, id}}}` where `id` is an uploaded asset served at `/_blob/<id>`; or `{src, data}` with a `data:image/webp` URI in inline mode |
| `data/users/<uid>/watchlist` | `{items:{<key>:{name,brand,added,target_price}}}` (private to each person) |
| `data/users/<uid>/ratings` | `{v:2, items:{<id>:{stars 1–5, notes, name, brand, kind, key, match, updated}}}` (private). `id` is the product key; ratings for items not on the menu use `c:<slug>` with `match` phrases, and the page pins them to a product when exactly one matches. |

Emails: watchlist alerts (price drops, sales, restocks, target prices) plus "something you rated 4–5★ is back" appear at the top as ALERTS FOR YOU.

Access: shared data is readable by everyone the app is shared with and written only by the owner (and the owner's scheduled runs). Each person writes only their own `data/users/<uid>/`, and they need edit (Contributor/Editor) access to do so.

## Product fields
Straight from the store: id, name, brand, category, subcategory, flower_type, size, size_amount, price, sale_price, thc_min/max, cbd_min/max, potency_units, potency, in_stock, stock_qty, sku, description, image, url.
Computed by the engine:
- `key` (`sku:<AGLC SKU>`, the same across Alberta stores; else `n:<brand-name>`)
- `kind`, `price_eff`, `thc_mid`, `thc_total_mg`, `per_gram`, `per_100mg`
- for vapes: `vape_type`, `hardware`, `extract`, `flavour` (a guess from the text)
- `grams` (from the name first, then size, then cannabis-equivalent weight)
- cannabinoids per package: `thc_total_mg`, `cbd_total_mg`, `cbn_total_mg`, `cbg_total_mg`, with `cann_from_name` listing which came from the product name (ratios like "1:1:1 THC:CBD:CBN" or "1000 mg CBN"; the store never lists CBN)
- `per_100mg_cbd`, `per_100mg_cbn`, `profile` (THC-dominant, Balanced, CBD-dominant, Low THC, Minor cannabinoids), `minor` (CBN/CBG), `cbd_focused` (kept out of THC value rankings by default)
- `thc_source` (`store` or `text`) and `thc_est`: when the store leaves THC blank, the engine reads it from the product's name or description ("1000mg of THC per cart", "95+"); a "95+" style figure is a floor, shown as an estimate
- tracking: first_seen, status (listed/gone), gone_since, price_history

Potency sanity rules follow Canadian limits: at most 10 mg THC per edible or beverage package (multipacks count every package), and at most 1000 mg per oil or capsule package. Store data above those limits is ignored. A CBD figure under 1 is treated as a trace amount, not a real one.

## Pictures
Pictures are stored **inline** in the database (`stores/<slug>/media/idx-NN`, 120px WebP as `data:` URIs, about 2.8 MB for ~500 products). Inline storage keeps the "Anyone with the link" sharing option; a page that uses uploaded assets can't be public.
Each check runs `engine.py thumbs --inline` (downloads pictures for listed products that lack one, up to 100 per run) and then `engine.py thumbs-index --inline`, which adds them to the last index doc so only that doc is rewritten.
Upload mode is still in the engine (`thumbs` without `--inline`, upload the files as artifact assets, then `thumbs-index --uploaded <map of file name to asset id>`). It needs the page to declare the `assets` capability, and the page reads either form.

## Matched photos (placeholder pictures)
About 90 products only have the store's generic placeholder (`main_image` contains `/catalogue/categories/defaults/`). `engine.py photos` looks for the real photo in the OCS public Shopify catalog (`https://ocs.ca/products.json?limit=250&page=N`, all pages, cached for 6 hours in the output folder):
- **Scoring (0–100)**: brand 35 (an OCS vendor named in the Blaze product name or brand; a different known brand costs 15), distinctive-word overlap 45 (Dice overlap of the name words after removing brand, format, size and cannabinoid words; one typo allowed in 5+ letter words), format 10 (the wrong format is ruled out entirely), size or pack 10, ratio +5 or −15, and −15 when both names have distinctive words with nothing in common.
- **Decisions**: 80 or more, at least 60% word overlap, and no runner-up within 5 points means `auto`: the photo shows with a "Matched photo" badge. 50–79, or a strain-name match with an unknown brand, means `ask`: the owner gets **Pick photo** with the top 3 candidates. Anything else is `none`.
- **Caching**: results are cached by product key (the AGLC SKU). `auto` is never redone; `ask` and `none` are re-checked after 7 days. The owner's choice (`overrides`) always wins, and "No photo" is allowed. On the next run the engine fetches a 200px picture for a hand-picked candidate (`man`).
- The regular `thumbs` step skips placeholder pictures, since the matcher handles them.
- Output: `photo_batch_N.json` (ArtifactData batch writes, pinned with versions from `versions.txt`) and `photos_summary.md`.

## Search
Menu search splits the query into words. Every word has to match somewhere across name, brand, SKU, category, subcategory and flower type, in any order. Synonyms are folded first: pre-roll / pre roll / preroll / joint; cart / cartridge / 510; gummy / gummies / chew / soft chew; disty / distillate. Typos are forgiven (1 edit for words of 4+ letters, 2 for 8+). Words containing digits, like SKUs and sizes, must match exactly.

## Adding a store
Add an entry to `config/stores` (slug, name, site_id, menu_url). The next check builds its baseline, and a store picker appears in the app header.

## Ideas queued for later
- THC for products the store leaves blank (about 37 flower, pre-roll and vape items today): AGLC's albertacannabis.org can't be read automatically, so this needs another source or manual entry
- Price comparison between stores (products share `key` across stores)
- Watch a brand or keyword ("any new Sticky Greens cart")
- Price-history chart per product
- Share ratings with friends (a shared ratings path with `{self}` write rules)
- Terpene and effect filters, if the store starts publishing terpenoids
