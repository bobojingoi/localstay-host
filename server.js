require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { pool, init } = require("./db");
const { STAY } = require("./transform");

const app = express();
app.use(express.json({ limit: "5mb" }));

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
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("StayPredeal running on port " + (process.env.PORT || 3000))))
  .catch(e => { console.error("Startup failed:", e); process.exit(1); });
