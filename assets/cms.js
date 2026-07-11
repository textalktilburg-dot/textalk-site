// Textalk CMS-loader: haalt content op die via /admin is ingevoerd
// en toont die op de pagina's. Werkt zonder build-stap.
// Listing: via de GitHub API (publieke repo, zie cms-config.js),
// met /content/<collectie>/manifest.json als reserve.
window.TextalkCMS = (function () {
  const cfg = window.TEXTALK_CMS || {};
  const cache = {};

  function safeUrl(u) {
    u = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function miniYaml(src) {
    // Reserve-parser voor onze frontmatter (werkt zonder externe bibliotheek).
    const lines = src.split(/\r?\n/);
    const root = {};
    let i = 0;
    function unq(v){v=v.trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return v;}
    function indentOf(l){const m=l.match(/^ */);return m?m[0].length:0;}
    function parseBlock(indent, into){
      while(i<lines.length){
        const line=lines[i];
        if(!line.trim()){i++;continue;}
        const ind=indentOf(line);
        if(ind<indent)return;
        const t=line.trim();
        if(t.startsWith('- ')){
          // lijst-item (object of scalar)
          if(!Array.isArray(into._list))into._list=[];
          const item={};
          const rest=t.slice(2);
          i++;
          if(rest.includes(':')){
            const ci=rest.indexOf(':');
            const k=rest.slice(0,ci).trim(), v=rest.slice(ci+1).trim();
            if(v)item[k]=unq(v); else {parseBlock(ind+2,item);}
            // vervolg-velden van hetzelfde item
            while(i<lines.length){
              const l2=lines[i];
              if(!l2.trim()){i++;continue;}
              const ind2=indentOf(l2);const t2=l2.trim();
              if(ind2<=ind||t2.startsWith('- '))break;
              const ci2=t2.indexOf(':');
              if(ci2<0)break;
              const k2=t2.slice(0,ci2).trim(); let v2=t2.slice(ci2+1).trim();
              if(v2==='>-'||v2==='>'||v2==='|'){i++;const buf=[];
                while(i<lines.length&&(!lines[i].trim()||indentOf(lines[i])>ind2)){buf.push(lines[i].trim());i++;}
                item[k2]=buf.join(' ').trim();
              } else {item[k2]=unq(v2);i++;}
            }
          } else { into._list.push(unq(rest)); continue; }
          into._list.push(item);
          continue;
        }
        const ci=t.indexOf(':');
        if(ci<0){i++;continue;}
        const key=t.slice(0,ci).trim(); let val=t.slice(ci+1).trim();
        i++;
        if(val==='>-'||val==='>'||val==='|'){
          const buf=[];
          while(i<lines.length&&(!lines[i].trim()||indentOf(lines[i])>ind)){buf.push(lines[i].trim());i++;}
          into[key]=buf.join(' ').trim();
        } else if(val===''){
          const child={};parseBlock(ind+1,child);
          into[key]=Array.isArray(child._list)?child._list:child;
        } else {
          into[key]=unq(val);
        }
      }
    }
    parseBlock(0,root);
    delete root._list;
    return root;
  }

  function parseDoc(txt) {
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { body: txt };
    let data = {};
    try {
      data = (typeof jsyaml !== "undefined" ? jsyaml.load(m[1]) : miniYaml(m[1])) || {};
    } catch (e) {
      try { data = miniYaml(m[1]) || {}; } catch (e2) { data = {}; }
    }
    data.body = txt.slice(m[0].length).trim();
    return data;
  }

  async function listFiles(collection) {
    // 1) GitHub API (werkt zodra cms-config.js is ingevuld)
    if (cfg.user && cfg.repo) {
      try {
        const r = await fetch(
          "https://api.github.com/repos/" + cfg.user + "/" + cfg.repo +
          "/contents/content/" + collection + "?ref=" + (cfg.branch || "main")
        );
        if (r.ok) {
          const j = await r.json();
          return j.filter(f => f.name.endsWith(".md")).map(f => f.name);
        }
      } catch (e) { /* val terug op manifest */ }
    }
    // 2) manifest.json als reserve
    try {
      const r = await fetch("/content/" + collection + "/manifest.json");
      if (r.ok) return await r.json();
    } catch (e) { }
    throw new Error("Geen bestandslijst voor " + collection);
  }

  async function list(collection) {
    const key = "list:" + collection;
    if (cache[key]) return cache[key];
    // sessionStorage-cache (5 min): sneller + spaart de GitHub-API-limiet
    try {
      const raw = sessionStorage.getItem("tx:" + key);
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() - c.t < 300000) { cache[key] = c.v; return c.v; }
      }
    } catch (e) { }
    const names = await listFiles(collection);
    const items = [];
    for (const name of names) {
      try {
        const r = await fetch("/content/" + collection + "/" + name);
        if (!r.ok) continue;
        const d = parseDoc(await r.text());
        d._slug = name.replace(/\.md$/, "");
        items.push(d);
      } catch (e) { }
    }
    cache[key] = items;
    try { sessionStorage.setItem("tx:" + key, JSON.stringify({ t: Date.now(), v: items })); } catch (e) { }
    return items;
  }

  async function get(collection, slug) {
    const r = await fetch("/content/" + collection + "/" + slug + ".md");
    if (!r.ok) throw new Error("Niet gevonden: " + slug);
    const d = parseDoc(await r.text());
    d._slug = slug;
    return d;
  }

  function mdToHtml(md) {
    // minimale markdown: alinea's en **vet**
    return String(md || "").split(/\n{2,}/).map(p =>
      "<p>" + esc(p.trim()).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>") + "</p>"
    ).join("");
  }

  // ---------- RENDERERS ----------

  function showTile(s) {
    const kleur = s.kleur || "#E5ABFF";
    return '<a class="card aspect-[4/5]" href="show.html?slug=' + encodeURIComponent(s._slug) + '" style="background:' + esc(kleur) + '" aria-label="' + esc(s.title) + '">' +
      '<div class="media absolute inset-0"><div class="ph-people"></div></div>' +
      '<div class="absolute inset-0 flex flex-col justify-between p-4">' +
      '<span class="logo-pill text-xs self-start" style="border-width:1.5px;background:rgba(255,255,255,.85)"><span class="logo-tex">tex</span><span class="logo-talk">talk</span></span>' +
      '<div><p class="h3">' + esc(s.title) + '</p>' +
      (s.ondertitel ? '<p class="mt-1 font-medium">' + esc(s.ondertitel) + '</p>' : '') +
      '<p class="meta mt-1 font-semibold">' + esc(s.datum || "") + ' · Terugkijken →</p></div></div></a>';
  }

  function newsTile(n) {
    const d = n.datum ? new Date(n.datum) : null;
    const dstr = d && !isNaN(d) ? d.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" }) : esc(n.datum || "");
    return '<a class="card flex flex-col justify-between gap-6 p-6" style="border:1px solid var(--ink)" href="nieuws.html?slug=' + encodeURIComponent(n._slug) + '">' +
      '<div><span class="tag" style="border-width:1px;font-size:.75rem;padding:4px 12px">' + esc(n.tag || "Nieuws") + '</span>' +
      '<h3 class="h3 mt-4">' + esc(n.title) + '</h3></div>' +
      '<p class="meta font-semibold">' + dstr + ' · Lees verder →</p></a>';
  }

  function expertTile(e) {
    const kleur = e.kleur || "#FDED79";
    return '<a class="ecard" href="expert.html?slug=' + encodeURIComponent(e._slug) + '" data-th="' + esc(e.themas || "") + '" data-n="' + esc((e.naam + " " + (e.rol || "")).toLowerCase()) + '">' +
      '<div class="media relative aspect-[4/5] overflow-hidden" style="background:' + esc(kleur) + ';border:1px solid var(--ink)">' +
      (e.portret ? '<img loading="lazy" src="' + esc(e.portret) + '" alt="' + esc(e.naam) + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">' : '<div class="ph-people"></div>') +
      '</div>' +
      '<p class="font-semibold mt-3 leading-tight">' + esc(e.naam) + '</p>' +
      '<p class="meta" style="color:var(--grey-text)">' + esc(e.rol || "") + '</p>' +
      (e.show ? '<p class="meta mt-1 font-semibold">' + esc(e.show) + ' →</p>' : '') + '</a>';
  }

  function mensTile(p) {
    const kleur = p.kleur || "#E5ABFF";
    return '<a class="card" href="index.html#/over" aria-label="' + esc(p.naam) + '">' +
      '<div class="media relative aspect-[4/5] overflow-hidden" style="background:' + esc(kleur) + '">' +
      (p.portret ? '<img loading="lazy" src="' + esc(p.portret) + '" alt="' + esc(p.naam) + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">' : '<div class="ph-people"></div>') +
      '</div>' +
      '<div class="pt-3"><p class="font-semibold text-white leading-tight">' + esc(p.naam) + '</p>' +
      '<p class="meta text-white/60">' + esc(p.rol || "") + '</p></div></a>';
  }

  async function fill(containerId, collection, renderer, opts) {
    const el = document.getElementById(containerId);
    if (!el) return;
    try {
      let items = await list(collection);
      if (opts && opts.sort) items = opts.sort(items);
      if (opts && opts.limit) items = items.slice(0, opts.limit);
      if (!items.length) return; // laat statische fallback staan
      el.innerHTML = items.map(renderer).join("");
    } catch (e) {
      // stil falen: de statische voorbeeldinhoud blijft dan gewoon staan
      console.warn("CMS niet geladen voor", collection, e.message);
    }
  }

  return { list, get, esc, safeUrl, mdToHtml, showTile, newsTile, expertTile, mensTile, fill };
})();
