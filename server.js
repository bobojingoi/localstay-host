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

// Safety net: never let a request hang forever (e.g. if the DB is briefly down).
// If a handler hasn't responded in time, return 503 instead of spinning.
// AI image editing and uploads are legitimately slow, so they get longer budgets.
app.use((req, res, next) => {
  const p = req.path || "";
  let ms = 12000;
  if (p.indexOf("/api/ai-enhance") === 0) ms = 250000;   // gpt-image-2 / Gemini image edit is slow
  else if (p.indexOf("/api/upload") === 0) ms = 60000;   // image processing + R2 upload
  const t = setTimeout(() => {
    if (!res.headersSent && !res.writableEnded) {
      try { res.status(503).json({ error: "Serviciul este momentan ocupat. Reîncearcă în câteva momente." }); } catch (e) {}
    }
  }, ms);
  res.on("finish", () => clearTimeout(t));
  res.on("close", () => clearTimeout(t));
  next();
});

// Diagnostic: shows DB + R2 status without exposing secrets. Visit /api/health.
app.get("/api/health", async (req, res) => {
  let db = false, dbErr = null;
  try { await pool.query("select 1"); db = true; } catch (e) { dbErr = e.message; }
  res.json({
    db, dbErr,
    r2: {
      ready: r2ready(),
      endpoint: process.env.R2_ENDPOINT || null,       // not secret — check for typos
      bucket: process.env.R2_BUCKET || null,            // not secret
      publicUrl: process.env.R2_PUBLIC_URL || null,     // not secret
      hasAccessKey: !!process.env.R2_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.R2_SECRET_ACCESS_KEY,
    },
  });
});

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
function renderSite(site, slug) {
  const tpl = fs.readFileSync(path.join(PUBLIC, "stay-property-template.html"), "utf8");
  const c = site._contact || {};
  const theme = { brandName: site.name || "", brandSub: (site.location && site.location.area) || "" };
  if (c.phone) theme.booking = { phone: c.phone, whatsapp: (c.phone || "").replace(/[^0-9]/g, ""), url: "" };
  return inject(tpl, "window.STAY_PROPERTY=" + JSON.stringify(site) + ";window.STAY_THEME=" + JSON.stringify(theme) + ";window.STAY_SLUG=" + JSON.stringify(slug||"") + ";");
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
        return res.send(renderSite(p.site, p.slug));
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
    try {
      const ai = await Promise.race([
        describeImage(main.toString("base64"), "image/webp"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("describe timeout")), 6000)),
      ]);
      alt = ai.alt; description = ai.description;
    } catch (e) {}

    res.json({ url, thumb: thumbUrl, alt, description });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Smart re-import: keep host-added data (iCal feeds/blocks, galleries, uploaded photos) when re-importing an existing slug */
function mergeAdminState(oldS, newS) {
  if (!oldS) return newS;
  const oldUnits = oldS.units || [];
  (newS.units || []).forEach(u => {
    const o = oldUnits.find(x => x.id === u.id);
    if (o) { u.feeds = o.feeds || u.feeds || []; u.blocks = o.blocks || u.blocks || []; }
  });
  if (oldS.galleries && Object.keys(oldS.galleries).length) newS.galleries = oldS.galleries;
  const np = (newS.property && newS.property._photos) || [];
  const op = (oldS.property && oldS.property._photos) || [];
  if (!np.length && op.length && newS.property) newS.property._photos = op;
  // preserve host price edits (base rates, currency, min nights, seasonal periods, per-day prices)
  const oldRooms = (oldS.pricing && oldS.pricing.rooms) || [];
  ((newS.pricing && newS.pricing.rooms) || []).forEach(r => {
    const o = oldRooms.find(x => x.id === r.id);
    if (o) {
      if (o.weekday != null) r.weekday = o.weekday;
      if (o.weekend != null) r.weekend = o.weekend;
      if (o.currency) r.currency = o.currency;
      if (o.minNights != null) r.minNights = o.minNights;
    }
  });
  if (oldS.pricing) {
    newS.pricing = newS.pricing || {};
    if (oldS.pricing.periods && oldS.pricing.periods.length) newS.pricing.periods = oldS.pricing.periods;
    if (oldS.pricing.dayPrices && Object.keys(oldS.pricing.dayPrices).length) newS.pricing.dayPrices = oldS.pricing.dayPrices;
  }
  return newS;
}

app.post("/api/import", async (req, res) => {
  try {
    const master = req.body;
    const admin = STAY.deriveAdminState(master);
    const slug = STAY.slugify(admin.property.basicInfo.name || "unitate");
    const existing = await getProp(slug);
    const merged = existing ? mergeAdminState(existing.admin_state, admin) : admin;
    const site = STAY.masterToSite(merged.property, merged.pricing, merged.galleries);
    await pool.query(
      `insert into properties(slug, admin_state, site) values($1,$2,$3)
       on conflict(slug) do update set admin_state=excluded.admin_state, site=excluded.site, updated_at=now()`,
      [slug, merged, site]
    );
    res.json({ slug, name: merged.property.basicInfo.name || slug, merged: !!existing });
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

/* ---------- booking requests (from the public booking form) ---------- */
app.post("/api/booking-request", async (req, res) => {
  try {
    const b = req.body || {};
    const g = b.guests || {};
    const slug = String(b.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "slug lipsă" });
    if (!b.name && !b.phone) return res.status(400).json({ error: "nume sau telefon obligatoriu" });
    const toDate = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const r = await pool.query(
      `insert into booking_requests
        (slug,name,phone,email,checkin,checkout,adults,children,infants,pets,rooms,message)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) returning id`,
      [
        slug,
        (b.name || "").slice(0, 200),
        (b.phone || "").slice(0, 60),
        (b.email || "").slice(0, 200),
        toDate(b.checkin),
        toDate(b.checkout),
        +g.adults || 0, +g.children || 0, +g.infants || 0, +g.pets || 0,
        JSON.stringify(Array.isArray(b.rooms) ? b.rooms.slice(0, 30) : []),
        (b.message || "").slice(0, 4000),
      ]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/host/:slug/booking-requests", async (req, res) => {
  try {
    const r = await pool.query(
      "select * from booking_requests where slug=$1 order by created_at desc limit 500",
      [req.params.slug]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- lightweight event tracking (phone reveals, etc.) ---------- */
app.post("/api/track", async (req, res) => {
  try {
    const b = req.body || {};
    const slug = String(b.slug || "").slice(0, 120);
    const type = String(b.type || "").slice(0, 60);
    if (!slug || !type) return res.status(400).json({ error: "slug/type lipsă" });
    await pool.query(
      "insert into site_events (slug,type,meta) values ($1,$2,$3::jsonb)",
      [slug, type, JSON.stringify(b.meta || {})]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- global stats for the importer dashboard ---------- */
app.get("/api/stats", async (req, res) => {
  try {
    const names = await pool.query(
      "select slug, admin_state->'property'->'basicInfo'->>'name' as name from properties"
    );
    const nameOf = {};
    names.rows.forEach((r) => { nameOf[r.slug] = r.name || r.slug; });

    const reqs = await pool.query("select * from booking_requests order by created_at desc limit 300");
    const reveals = await pool.query(
      "select slug, created_at, meta from site_events where type='phone_reveal' order by created_at desc limit 300"
    );
    const totals = await pool.query(`
      select
        (select count(*) from booking_requests) as requests,
        (select count(*) from booking_requests where created_at > now() - interval '7 days') as requests7d,
        (select count(*) from site_events where type='phone_reveal') as reveals,
        (select count(*) from site_events where type='phone_reveal' and created_at > now() - interval '7 days') as reveals7d
    `);
    res.json({
      totals: totals.rows[0],
      requests: reqs.rows.map((r) => ({ ...r, property: nameOf[r.slug] || r.slug })),
      reveals: reveals.rows.map((r) => ({ ...r, property: nameOf[r.slug] || r.slug })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/host/:slug/state", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.admin_state);
});

app.put("/api/host/:slug/state", async (req, res) => {
  try {
    const adminState = req.body;
    const site = STAY.masterToSite(adminState.property, adminState.pricing, adminState.galleries);
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

app.get("/api/availability/:slug", async (req, res) => {
  try {
    const p = await getProp(req.params.slug);
    if (!p) return res.status(404).json({ error: "not found" });
    const units = (p.admin_state.units || []);
    const out = {};
    units.forEach(u => { out[u.id] = [...effectiveBlocked(p.admin_state, u.id)]; });
    // "entire" availability = union of all units (if any unit is booked that day, the whole place is taken)
    const all = new Set();
    units.forEach(u => effectiveBlocked(p.admin_state, u.id).forEach(d => all.add(d)));
    out.__all = [...all];
    res.json({ units: out });
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
  res.send(renderSite(p.site, p.slug));
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
// Keep the web service alive even through transient DB outages: a stray async
// rejection (e.g. a request that hits the DB while it's briefly down) must not kill the process.
process.on("unhandledRejection", (e) => console.error("Unhandled rejection (ignored):", e && e.message));

const PORT = process.env.PORT || 3000;
// Listen FIRST so the port is open and health checks pass — no 502 if the DB is briefly unavailable.
app.listen(PORT, () => console.log("StayPredeal running on port " + PORT));

let _icalStarted = false;
function startIcalSync() {
  if (_icalStarted) return; _icalStarted = true;
  setTimeout(syncAll, 30000);
  setInterval(syncAll, 15 * 60 * 1000);
}
function bootDb() {
  init()
    .then(() => { console.log("StayPredeal DB ready."); startIcalSync(); })
    .catch((e) => {
      console.error("DB not ready, server stays up; retrying in 30s:", e && e.message);
      setTimeout(bootDb, 30000); // recover automatically when the DB comes back
    });
}
bootDb();
