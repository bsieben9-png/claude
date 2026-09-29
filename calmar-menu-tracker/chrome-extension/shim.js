/* Local mode: gives the app page the same database API it uses on claude.ai (window.claude.use),
   backed by chrome.storage.local. The background worker writes the menu data; the page writes the
   watchlist, ratings, photo choices and "Check now" requests. */
(function(){
  window.CCS_LOCAL = true;
  const store = chrome.storage.local;
  const listeners = new Set();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes);
    for (const l of listeners) if (l.keys(keys)) l.fire();
  });
  const get = keys => store.get(keys);
  const snapDocs = docs => ({docs: docs.map(([id, v]) => ({id, data: () => v}))});
  const snapDoc = v => ({data: () => v ?? null});

  // document path -> storage key
  function docKey(path){
    const p = path.split("/");
    if (path === "config/stores") return "config/stores";
    if (path === "checks/last") return "checks/last";
    if (path === "config/app") return null;
    if (p[0] === "data" && p[1] === "users") return p[3] === "watchlist" ? "watchlist" : p[3] === "ratings" ? "ratings" : null;
    if (p[0] === "stores" && p[2] === "imagematches" && p[3] === "overrides") return "overrides/" + p[1];
    return null;
  }
  // collection path -> [storage keys, builder(values) -> [[id, data]]]
  async function collSpec(path){
    const p = path.split("/");
    if (path === "stores") {
      const cfg = (await get("config/stores"))["config/stores"];
      const slugs = ((cfg && cfg.stores) || [{slug: "calmar"}]).map(s => s.slug);
      const keys = slugs.map(s => "stores/" + s);
      return [keys, v => slugs.filter(s => v["stores/" + s]).map(s => [s, v["stores/" + s]])];
    }
    if (p[0] === "stores" && p.length === 3) {
      const slug = p[1], kind = p[2];
      if (kind === "catalog") return [["catalog/" + slug], v => [["all", {products: v["catalog/" + slug] || []}]]];
      if (kind === "media") return [["media/" + slug], v => [["all", {items: v["media/" + slug] || {}}]]];
      if (kind === "runs") return [["runs/" + slug], v => (v["runs/" + slug] || []).map(r => [r.at, r])];
      if (kind === "imagematches") return [["matches/" + slug, "overrides/" + slug],
        v => [["m", {items: v["matches/" + slug] || {}}], ["overrides", {items: (v["overrides/" + slug] || {}).items || {}}]]];
    }
    return [[], () => []];
  }
  function subscribe(keys, fire){
    const l = {keys: changed => changed.some(k => keys.includes(k)), fire};
    listeners.add(l); fire();
    return () => listeners.delete(l);
  }
  const db = {
    doc(path){
      const key = docKey(path);
      return {
        onSnapshot(cb){ if (!key) { setTimeout(() => cb(snapDoc(null)), 0); return () => {}; }
          return subscribe([key], () => get(key).then(v => cb(snapDoc(v[key])))); },
        set(data){ if (!key) return Promise.reject(new Error("read-only")); return store.set({[key]: JSON.parse(JSON.stringify(data))}); },
        get(){ return key ? get(key).then(v => snapDoc(v[key])) : Promise.resolve(snapDoc(null)); }
      };
    },
    collection(path){
      let n = null;
      const api = {
        orderBy(){ return api; }, limit(k){ n = k; return api; },
        onSnapshot(cb){
          let off = () => {}, dead = false;
          collSpec(path).then(([keys, build]) => {
            if (dead) return;
            off = subscribe(keys, () => get(keys).then(v => { let d = build(v); if (n) d = d.slice(0, n); cb(snapDocs(d)); }));
          });
          return () => { dead = true; off(); };
        }
      };
      return api;
    }
  };
  const user = {isOwner: async () => true, id: async () => "local"};
  const mcp = {
    // "Check now" on claude.ai starts a scheduled task; here it asks the background worker to run a check
    async callTool(server, tool){
      if (tool !== "fire_trigger") throw Object.assign(new Error("unsupported"), {code: "tool_error"});
      const r = await chrome.runtime.sendMessage({cmd: "check"});
      if (!r || !r.ok) throw Object.assign(new Error(r && r.error || "no answer"), {code: "tool_error"});
      return r;
    }
  };
  window.claude = {use: async name => name === "db" ? db : name === "user" ? user : name === "mcp" ? mcp : null};
})();
