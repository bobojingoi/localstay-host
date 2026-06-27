require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { pool, init } = require("./db");
const { STAY } = require("./transform");
const sharp = require("sharp");
const { r2put, r2ready } = require("./r2");
const { describeImage, enhanceImage } = require("./ai");

const app = express();
app.use(express.json({ limit: "25mb" }));

const PUBLIC = path.join(__dirname, "public");
const BASE_DOMAIN = (process.env.BASE_DOMAIN || "").toLowerCase(); // e.g. staypredeal.ro

/* ---------- helpers ---------- */
async function getProp(slug) {
  const r = await pool.query("select * from properties where slug=$1", [slug]);
  return r.rows[0];
}
function inject(html, js) {
  return html.replace("</head>", "<script>" + js + "</script></head>");
}
function renderSite(site) {
  const tpl = fs.readFileSync(path.join(PUBLIC, "stay-property-template.html"), "utf8");
  const c = site._contact || {};
  const theme = { brandName: site.name || "", brandSub: (site.location && site.location.area) || "" };
  if (c.phone) theme.booking = { phone: c.phone, whatsapp: (c.phone || "").replace(/[^0-9]/g, ""), url: "" };
  return inject(tpl, "window.STAY_PROPERTY=" + JSON.stringify(site) + ";window.STAY_THEME=" + JSON.stringify(theme) + ";");
}

/* ---------- iCal export (effective blocks incl. entire/room overlap) ---------- */
function pad(n){ return String(n).padStart(2,"0"); }
function effectiveBlocked(adminState, unitId) {
  const units = adminState.units || [];
  const rooms = (adminState.pricing && adminState.pricing.rooms) || [];
  const isEntire = id => { const r = rooms.find(x => x.id === id); return r ? !!r.isEntire : false; };
  const feedDates = u => { const s = new Set(); (u.feeds||[]).forEach(f => (f.blocks||[]).forEach(d => s.add(d))); return s; };
  const u = units.find(x => x.id === unitId) || { blocks: [], feeds: [] };
  const set = new Set(u.blocks || []); feedDates(u).forEach(d => set.add(d));
  const others = isEntire(unitId) ? units.filter(x => x.id !== unitId) : units.filter(x => isEntire(x.id));
  others.forEach(o => { (o.blocks||[]).forEach(d => set.add(d)); feedDates(o).forEach(d => set.add(d)); });
  return [...set].sort();
}
function buildICS(dates, label) {
  const out = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//StayPredeal//RO","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  const now = new Date();
  const stamp = now.getUTCFullYear()+pad(now.getUTCMonth()+1)+pad(now.getUTCDate())+"T"+pad(now.getUTCHours())+pad(now.getUTCMinutes())+"00Z";
  const d = [...dates].sort(); let i = 0;
  const fromIso = s => { const [y,m,dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m-1, dd)); };
  const iso = x => x.getUTCFullYear()+"-"+pad(x.getUTCMonth()+1)+"-"+pad(x.getUTCDate());
  while (i < d.length) {
    let start = d[i], j = i;
    while (j+1 < d.length) { const nx = fromIso(d[j]); nx.setUTCDate(nx.getUTCDate()+1); if (iso(nx) === d[j+1]) j++; else break; }
    const end = fromIso(d[j]); end.setUTCDate(end.getUTCDate()+1);
    out.push("BEGIN:VEVENT","UID:"+start+"-"+Math.random().toString(36).slice(2)+"@staypredeal",
      "DTSTAMP:"+stamp,"DTSTART;VALUE=DATE:"+start.replace(/-/g,""),"DTEND;VALUE=DATE:"+iso(end).replace(/-/g,""),
      "SUMMARY:"+(label||"Indisponibil"),"END:VEVENT");
    i = j+1;
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n");
}

/* ---------- iCal fetch + parse (server side — no CORS here) ---------- */
function fromIso(s){ const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)); }
function iso(x){ return x.getUTCFullYear()+"-"+pad(x.getUTCMonth()+1)+"-"+pad(x.getUTCDate()); }
function icd(v){ const m=v.match(/(\d{4})(\d{2})(\d{2})/); return m?(m[1]+"-"+m[2]+"-"+m[3]):null; }
function parseICS(t){
  const lines=String(t).replace(/\r\n[ \t]/g,"").replace(/\n[ \t]/g,"").split(/\r?\n/);
  const ev=[]; let c=null;
  for(const l of lines){
    if(l==="BEGIN:VEVENT")c={};
    else if(l==="END:VEVENT"){ if(c&&c.start)ev.push(c); c=null; }
    else if(c){ const i=l.indexOf(":"); if(i<0)continue;
      const n=l.slice(0,i).split(";")[0].toUpperCase(), v=l.slice(i+1).trim();
      if(n==="DTSTART")c.start=icd(v); else if(n==="DTEND")c.end=icd(v); }
  }
  return ev;
}
function eventsToDates(ev){
  const s=new Set();
  for(const e of ev){ if(!e.start)continue;
    const a=fromIso(e.start), b=e.end?fromIso(e.end):new Date(a.getTime()+864e5);
    for(let d=new Date(a); d<b; d.setUTCDate(d.getUTCDate()+1)) s.add(iso(d)); }
  return [...s];
}
async function fetchText(url){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch(url,{signal:ctrl.signal,headers:{"User-Agent":"StayPredeal/1.0 (+ical-sync)"}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
// Fetch every URL feed for a property, fill its blocked dates, save.
async function syncProperty(slug){
  const p=await getProp(slug); if(!p) return {error:"not found"};
  const admin=p.admin_state; let changed=false, total=0;
  for(const u of (admin.units||[])){
    for(const f of (u.feeds||[])){
      if(!f.url) continue;
      try{
        const dates=eventsToDates(parseICS(await fetchText(f.url)));
        f.blocks=dates; f.count=dates.length; f.lastSync=Date.now(); f.lastStatus="ok";
        total+=dates.length; changed=true;
      }catch(e){ f.lastStatus="error: "+e.message; f.lastSync=Date.now(); changed=true; }
    }
  }
  if(changed) await pool.query("update properties set admin_state=$2, updated_at=now() where slug=$1",[slug,admin]);
  return { ok:true, total, admin_state:admin };
}
async function syncAll(){
  try{
    const r=await pool.query("select slug from properties");
    for(const row of r.rows){ await syncProperty(row.slug).catch(e=>console.error("sync",row.slug,e.message)); }
    console.log("iCal sync run: "+r.rows.length+" properties");
  }catch(e){ console.error("syncAll failed:",e.message); }
}

/* ---------- subdomain routing: {slug}.BASE_DOMAIN -> public site ---------- */
app.use(async (req, res, next) => {
  try {
    const host = (req.headers.host || "").split(":")[0].toLowerCase();
    if (BASE_DOMAIN && host.endsWith("." + BASE_DOMAIN)) {
      const slug = host.slice(0, host.length - BASE_DOMAIN.length - 1);
      if (slug && slug !== "www" && slug !== "app") {
        const p = await getProp(slug);
        if (!p) return res.status(404).send("Proprietate negăsită");
        return res.send(renderSite(p.site));
      }
    }
  } catch (e) { return next(e); }
  next();
});

/* ---------- API ---------- */
app.post("/api/ai-enhance", async (req, res) => {
  try {
    let base64, mime;
    if (req.body.url) {
      const r = await fetch(req.body.url);
      if (!r.ok) throw new Error("fetch image " + r.status);
      mime = r.headers.get("content-type") || "image/jpeg";
      base64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    } else {
      const m = String(req.body.dataUrl || "").match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: "bad image" });
      mime = m[1]; base64 = m[2];
    }
    const out = await enhanceImage(base64, mime);
    if (!out) return res.status(502).json({ error: "AI enhance failed" });
    res.json({ dataUrl: "data:" + out.mime + ";base64," + out.image });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/upload", async (req, res) => {
  try {
    if (!r2ready()) return res.status(503).json({ error: "R2 not configured" });
    const m = String(req.body.dataUrl || "").match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "bad image" });
    const input = Buffer.from(m[2], "base64");

    // optimize: auto-rotate (EXIF), resize<=1600, auto-contrast, sharpen, WebP + a thumbnail
    const main = await sharp(input).rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .normalize().sharpen().webp({ quality: 82 }).toBuffer();
    const thumb = await sharp(input).rotate()
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 }).toBuffer();

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const url = await r2put("photos/" + id + ".webp", main, "image/webp");
    let thumbUrl = "";
    try { thumbUrl = await r2put("photos/" + id + "_t.webp", thumb, "image/webp"); } catch (e) {}

    let alt = "", description = "";
    try { const ai = await describeImage(main.toString("base64"), "image/webp"); alt = ai.alt; description = ai.description; } catch (e) {}

    res.json({ url, thumb: thumbUrl, alt, description });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/import", async (req, res) => {
  try {
    const master = req.body;
    const admin = STAY.deriveAdminState(master);
    const slug = STAY.slugify(admin.property.basicInfo.name || "unitate");
    const site = STAY.masterToSite(admin.property, admin.pricing);
    await pool.query(
      `insert into properties(slug, admin_state, site) values($1,$2,$3)
       on conflict(slug) do update set admin_state=excluded.admin_state, site=excluded.site, updated_at=now()`,
      [slug, admin, site]
    );
    res.json({ slug, name: admin.property.basicInfo.name || slug });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/properties", async (req, res) => {
  const r = await pool.query(
    `select slug,
            admin_state->'property'->'basicInfo'->>'name' as name,
            site->'photos'->>'hero' as hero
     from properties order by updated_at desc`
  );
  res.json(r.rows);
});

app.delete("/api/host/:slug", async (req, res) => {
  await pool.query("delete from properties where slug=$1", [req.params.slug]);
  res.json({ ok: true });
});

app.get("/api/host/:slug/state", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.admin_state);
});

app.put("/api/host/:slug/state", async (req, res) => {
  try {
    const adminState = req.body;
    const site = STAY.masterToSite(adminState.property, adminState.pricing);
    const r = await pool.query(
      "update properties set admin_state=$2, site=$3, updated_at=now() where slug=$1 returning slug",
      [req.params.slug, adminState, site]
    );
    if (!r.rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/host/:slug/sync", async (req, res) => {
  try {
    const r = await syncProperty(req.params.slug);
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/site/:slug", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.site);
});

/* admin, with the property's data injected so it loads pre-filled */
app.get("/admin", async (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, "admin-console.html"), "utf8");
  const slug = req.query.slug;
  if (!slug) return res.send(html);
  const p = await getProp(slug);
  if (!p) return res.status(404).send("Proprietate negăsită");
  res.send(inject(html, "window.__ADMIN_STATE=" + JSON.stringify(p.admin_state) + ";"));
});

/* public site by path (preview without a subdomain) */
app.get("/s/:slug", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).send("Proprietate negăsită");
  res.send(renderSite(p.site));
});

/* iCal export per unit — paste this URL into Booking/Airbnb */
app.get("/ical/:slug/:file", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).send("Not found");
  const unitId = req.params.file.replace(/\.ics$/i, "");
  const dates = effectiveBlocked(p.admin_state, unitId);
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.send(buildICS(dates, "Indisponibil"));
});

/* ---------- static files + root ---------- */
app.use(express.static(PUBLIC));
app.get("/", (req, res) => res.redirect("/importer.html"));

/* ---------- start ---------- */
init()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => console.log("StayPredeal running on port " + (process.env.PORT || 3000)));
    // Background iCal sync: once shortly after boot, then every 15 minutes.
    setTimeout(syncAll, 30000);
    setInterval(syncAll, 15 * 60 * 1000);
  })
  .catch(e => { console.error("Startup failed:", e); process.exit(1); });
