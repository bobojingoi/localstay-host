require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pool, init } = require("./db");
const { STAY } = require("./transform");
const sharp = require("sharp");
const { r2put, r2ready } = require("./r2");
const { describeImage, enhanceImage, generateFbPosts } = require("./ai");
const AUTH = require("./auth");

const app = express();
app.set("trust proxy", 1); // Render runs behind a proxy — needed for Secure cookies + req.secure
app.use(express.json({ limit: "25mb" }));
app.use(AUTH.attachUser); // sets req.user (or null) from the auth cookie on every request

// While the project is not yet validated, keep every page out of search indexes.
// Controlled by the NOINDEX env var (ON by default). Set NOINDEX=false to allow
// indexing once you're ready — no code change needed.
app.use((req, res, next) => {
  if (NOINDEX) res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(NOINDEX ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n");
});

// Safety net: never let a request hang forever (e.g. if the DB is briefly down).
// If a handler hasn't responded in time, return 503 instead of spinning.
// AI image editing and uploads are legitimately slow, so they get longer budgets.
app.use((req, res, next) => {
  const p = req.path || "";
  let ms = 12000;
  if (p.indexOf("/api/ai-enhance") === 0 || p.indexOf("/api/ai-optimize") === 0) ms = 250000;   // gpt-image-2 / Gemini image edit is slow
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
const BASE_DOMAIN = (process.env.BASE_DOMAIN || "").toLowerCase(); // e.g. localstay.ro
// Search-engine indexing switch. ON by default (everything noindex) until the
// project is validated; set NOINDEX=false (or 0/off/no) to allow indexing.
const NOINDEX = !/^(false|0|off|no)$/i.test(String(process.env.NOINDEX || "").trim());
// Optional Google Analytics 4 measurement ID (e.g. G-XXXXXXXXXX). When set, the
// gtag snippet is injected into every public unit page so traffic flows to GA4.
const GA4_ID = (process.env.GA4_MEASUREMENT_ID || "").trim();
// Canonical public URL for a unit: pensiunea-crocus.localstay.ro when a base
// domain is configured, otherwise the path form on the Render host.
function siteUrl(slug) {
  return BASE_DOMAIN ? ("https://" + slug + "." + BASE_DOMAIN) : ("/s/" + slug);
}

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
  const url = siteUrl(slug);
  const html = inject(tpl, "window.STAY_PROPERTY=" + JSON.stringify(site) + ";window.STAY_THEME=" + JSON.stringify(theme) + ";window.STAY_SLUG=" + JSON.stringify(slug||"") + ";window.STAY_URL=" + JSON.stringify(url) + ";");
  // robots noindex (until validated) + canonical subdomain URL for SEO / sharing
  let headExtra = "";
  if (NOINDEX) headExtra += '<meta name="robots" content="noindex, nofollow">';
  if (BASE_DOMAIN) headExtra += '<link rel="canonical" href="' + url + '"><meta property="og:url" content="' + url + '">';
  // Google Analytics 4 — collects real traffic into your GA4 property when GA4_MEASUREMENT_ID is set.
  // The slug is sent as a custom dimension so you can segment traffic per unit in GA4.
  if (GA4_ID) {
    headExtra += '<script async src="https://www.googletagmanager.com/gtag/js?id=' + GA4_ID + '"></script>'
      + '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());'
      + 'gtag("config",' + JSON.stringify(GA4_ID) + ',{property_slug:' + JSON.stringify(slug||"") + '});</script>';
  }
  return headExtra ? html.replace("</head>", headExtra + "</head>") : html;
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
  const out = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//LocalStay//RO","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  const now = new Date();
  const stamp = now.getUTCFullYear()+pad(now.getUTCMonth()+1)+pad(now.getUTCDate())+"T"+pad(now.getUTCHours())+pad(now.getUTCMinutes())+"00Z";
  const d = [...dates].sort(); let i = 0;
  const fromIso = s => { const [y,m,dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m-1, dd)); };
  const iso = x => x.getUTCFullYear()+"-"+pad(x.getUTCMonth()+1)+"-"+pad(x.getUTCDate());
  while (i < d.length) {
    let start = d[i], j = i;
    while (j+1 < d.length) { const nx = fromIso(d[j]); nx.setUTCDate(nx.getUTCDate()+1); if (iso(nx) === d[j+1]) j++; else break; }
    const end = fromIso(d[j]); end.setUTCDate(end.getUTCDate()+1);
    out.push("BEGIN:VEVENT","UID:"+start+"-"+Math.random().toString(36).slice(2)+"@localstay",
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
    const r=await fetch(url,{signal:ctrl.signal,headers:{"User-Agent":"LocalStay/1.0 (+ical-sync)"}});
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

/* public client config (base domain for building unit URLs) */
app.get("/api/config", (req, res) => res.json({ baseDomain: BASE_DOMAIN || "" }));

/* ====================== AUTH ====================== */
function normEmail(e) { return String(e || "").trim().toLowerCase(); }

// Log in. Sets the auth cookie. Returns the user's role.
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const password = (req.body && req.body.password) || "";
    const remember = !!(req.body && req.body.remember);
    if (!email || !password) return res.status(400).json({ error: "Email și parolă obligatorii" });
    const r = await pool.query("select * from users where email=$1", [email]);
    const u = r.rows[0];
    if (!u || !(await AUTH.verifyPassword(password, u.password_hash)))
      return res.status(401).json({ error: "Email sau parolă greșite" });
    AUTH.setAuthCookie(req, res, u, remember);
    res.json({ ok: true, role: u.role, email: u.email, name: u.name || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- password recovery ---------- */
// Pages
app.get("/forgot", (req, res) => res.sendFile(path.join(PUBLIC, "forgot.html")));
app.get("/reset/:token", (req, res) => res.sendFile(path.join(PUBLIC, "reset.html")));

// Host asks for a reset: we store a token. Delivery is admin-relayed (no SMTP yet),
// so we always answer generically and never reveal whether the email exists.
app.post("/api/auth/forgot", async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    if (email) {
      const r = await pool.query("select id from users where email=$1", [email]);
      if (r.rows.length) {
        const token = crypto.randomBytes(24).toString("hex");
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await pool.query("update users set reset_token=$1, reset_expires=$2 where id=$3", [token, expires, r.rows[0].id]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate a reset token (so the reset page can show/hide the form).
app.get("/api/auth/reset/:token", async (req, res) => {
  try {
    const r = await pool.query("select email from users where reset_token=$1 and reset_expires > now()", [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: "Link invalid sau expirat." });
    res.json({ ok: true, email: r.rows[0].email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a new password using a valid token.
app.post("/api/auth/reset", async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "");
    const password = String((req.body && req.body.password) || "");
    if (password.length < 8) return res.status(400).json({ error: "Parola trebuie să aibă minim 8 caractere." });
    const r = await pool.query("select id from users where reset_token=$1 and reset_expires > now()", [token]);
    if (!r.rows.length) return res.status(404).json({ error: "Link invalid sau expirat." });
    const hash = await AUTH.hashPassword(password);
    await pool.query("update users set password_hash=$1, reset_token=null, reset_expires=null where id=$2", [hash, r.rows[0].id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: generate a reset link for a host (to relay by WhatsApp/email).
app.post("/api/admin/hosts/:id/reset-link", AUTH.requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h for admin-generated links
    const r = await pool.query("update users set reset_token=$1, reset_expires=$2 where id=$3 and role='host' returning email", [token, expires, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Hotelier inexistent." });
    res.json({ ok: true, token, email: r.rows[0].email, path: "/reset/" + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/logout", (req, res) => {
  AUTH.clearAuthCookie(req, res);
  res.json({ ok: true });
});

// Who am I? Returns role + (for hosts) the slugs they own.
app.get("/api/auth/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Neautentificat" });
  try {
    const u = await pool.query("select id,email,role,name from users where id=$1", [req.user.id]);
    if (!u.rows.length) return res.status(401).json({ error: "Neautentificat" });
    const me = u.rows[0];
    let slugs = [];
    if (me.role !== "admin") {
      const ps = await pool.query("select slug from properties where owner_id=$1 order by updated_at desc", [me.id]);
      slugs = ps.rows.map((r) => r.slug);
    }
    res.json({ id: me.id, email: me.email, role: me.role, name: me.name || "", slugs, imp: !!req.user.imp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change own email and/or password (any logged-in user). Requires current password.
app.post("/api/auth/change-credentials", AUTH.requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = b.currentPassword || "";
    const r = await pool.query("select * from users where id=$1", [req.user.id]);
    const u = r.rows[0];
    if (!u || !(await AUTH.verifyPassword(cur, u.password_hash)))
      return res.status(401).json({ error: "Parola actuală este greșită" });
    const newEmail = b.newEmail != null ? normEmail(b.newEmail) : null;
    const newPassword = b.newPassword || null;
    if (newEmail && newEmail !== u.email) {
      const dup = await pool.query("select 1 from users where email=$1 and id<>$2", [newEmail, u.id]);
      if (dup.rows.length) return res.status(409).json({ error: "Acest email este deja folosit" });
    }
    if (newPassword && String(newPassword).length < 8)
      return res.status(400).json({ error: "Parola nouă trebuie să aibă minim 8 caractere" });
    const email = newEmail || u.email;
    const hash = newPassword ? await AUTH.hashPassword(newPassword) : u.password_hash;
    await pool.query("update users set email=$1, password_hash=$2, updated_at=now() where id=$3", [email, hash, u.id]);
    AUTH.setAuthCookie(req, res, { id: u.id, role: u.role, email }); // refresh token with new email
    res.json({ ok: true, email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============== ADMIN: manage hotelier accounts ============== */

// Admin enters a hotelier's console without their password (impersonation).
app.post("/api/admin/impersonate/:hostId", AUTH.requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("select id, email, role from users where id=$1 and role='host'", [req.params.hostId]);
    if (!r.rows.length) return res.status(404).json({ error: "Hotelier inexistent." });
    AUTH.setAuthCookie(req, res, r.rows[0], false, req.user.id); // imp = admin uid; session cookie
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Return to the admin account after impersonating a hotelier.
app.post("/api/auth/stop-impersonation", AUTH.requireAuth, async (req, res) => {
  try {
    if (!req.user.imp) return res.status(400).json({ error: "Nu ești în modul impersonare." });
    const r = await pool.query("select id, email, role from users where id=$1 and role='admin'", [req.user.imp]);
    if (!r.rows.length) return res.status(404).json({ error: "Cont admin inexistent." });
    AUTH.setAuthCookie(req, res, r.rows[0], false); // back to admin (no imp)
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List host accounts + the slugs each owns.
app.get("/api/admin/hosts", AUTH.requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `select u.id, u.email, u.name, u.created_at,
              (u.reset_token is not null and u.reset_expires > now()) as reset_pending,
              coalesce(u.photo_price,3) as photo_price,
              coalesce(u.photo_spent,0) as photo_spent,
              coalesce(u.photos_optimized,0) as photos_optimized,
              coalesce(json_agg(p.slug) filter (where p.slug is not null), '[]') as slugs,
              coalesce(json_agg(json_build_object(
                'slug', p.slug,
                'name', p.admin_state->'property'->'basicInfo'->>'name',
                'status', coalesce(p.approval->>'status','pending'),
                'token', p.approval->>'token'
              ) order by p.created_at) filter (where p.slug is not null), '[]') as units
       from users u
       left join properties p on p.owner_id = u.id
       where u.role='host'
       group by u.id order by u.created_at desc`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a hotelier account and (optionally) assign properties to it.
app.post("/api/admin/hosts", AUTH.requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const email = normEmail(b.email);
    const password = b.password || "";
    const name = (b.name || "").trim() || null;
    const slugs = Array.isArray(b.slugs) ? b.slugs : [];
    if (!email || !password) return res.status(400).json({ error: "Email și parolă obligatorii" });
    if (String(password).length < 8) return res.status(400).json({ error: "Parola trebuie să aibă minim 8 caractere" });
    const dup = await pool.query("select 1 from users where email=$1", [email]);
    if (dup.rows.length) return res.status(409).json({ error: "Acest email este deja folosit" });
    const hash = await AUTH.hashPassword(password);
    const ins = await pool.query(
      "insert into users(email,password_hash,role,name) values($1,$2,'host',$3) returning id,email,name",
      [email, hash, name]
    );
    const host = ins.rows[0];
    if (slugs.length)
      await pool.query("update properties set owner_id=$1 where slug = any($2::text[])", [host.id, slugs]);
    res.json({ ok: true, host: { ...host, slugs } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a host's email and/or name (admin manages credentials from Hotelieri).
app.post("/api/admin/hosts/:id", AUTH.requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const email = normEmail(b.email);
    const name = (b.name || "").trim() || null;
    if (!email) return res.status(400).json({ error: "Email obligatoriu" });
    const dup = await pool.query("select 1 from users where email=$1 and id<>$2", [email, id]);
    if (dup.rows.length) return res.status(409).json({ error: "Acest email este deja folosit" });
    const r = await pool.query(
      "update users set email=$1, name=$2 where id=$3 and role='host' returning id, email, name",
      [email, name, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Hotelier negăsit" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Replace the set of properties a host owns.
app.post("/api/admin/hosts/:id/properties", AUTH.requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const slugs = Array.isArray(req.body && req.body.slugs) ? req.body.slugs : [];
    await pool.query("update properties set owner_id=null where owner_id=$1", [id]); // clear current
    if (slugs.length)
      await pool.query("update properties set owner_id=$1 where slug = any($2::text[])", [id, slugs]);
    res.json({ ok: true, slugs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin resets a host's password.
app.post("/api/admin/hosts/:id/password", AUTH.requireAdmin, async (req, res) => {
  try {
    const pw = (req.body && req.body.password) || "";
    if (String(pw).length < 8) return res.status(400).json({ error: "Parola trebuie să aibă minim 8 caractere" });
    const hash = await AUTH.hashPassword(pw);
    const r = await pool.query("update users set password_hash=$1, updated_at=now() where id=$2 and role='host' returning id", [hash, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Cont negăsit" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a hotelier's price per AI-optimized photo (in lei). Optionally reset their spend counter.
app.post("/api/admin/hosts/:id/photo-price", AUTH.requireAdmin, async (req, res) => {
  try {
    const price = Number(req.body && req.body.price);
    if (!isFinite(price) || price < 0 || price > 10000) return res.status(400).json({ error: "Preț invalid" });
    const resetSpend = !!(req.body && req.body.resetSpend);
    const r = await pool.query(
      resetSpend
        ? "update users set photo_price=$1, photo_spent=0, photos_optimized=0, updated_at=now() where id=$2 and role='host' returning coalesce(photo_price,3) as price, coalesce(photo_spent,0) as spent, coalesce(photos_optimized,0) as count"
        : "update users set photo_price=$1, updated_at=now() where id=$2 and role='host' returning coalesce(photo_price,3) as price, coalesce(photo_spent,0) as spent, coalesce(photos_optimized,0) as count",
      [price, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Cont negăsit" });
    res.json({ ok: true, price: Number(r.rows[0].price), spent: Number(r.rows[0].spent), count: Number(r.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a host account (their properties become unassigned).
app.delete("/api/admin/hosts/:id", AUTH.requireAdmin, async (req, res) => {
  try {
    await pool.query("delete from users where id=$1 and role='host'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ====================== END AUTH ====================== */

app.post("/api/ai-enhance", AUTH.requireAuth, async (req, res) => {
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

app.post("/api/upload", AUTH.requireAuth, async (req, res) => {
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

// AI optimize (for bulk photo tool): AI-enhance (best-effort) → optimize → upload → describe, in one call.
app.post("/api/ai-optimize", AUTH.requireAuth, async (req, res) => {
  try {
    if (!r2ready()) return res.status(503).json({ error: "R2 not configured" });
    let mime, b64;
    if (req.body && req.body.url) {
      const fr = await fetch(req.body.url);
      if (!fr.ok) return res.status(400).json({ error: "fetch image " + fr.status });
      mime = fr.headers.get("content-type") || "image/jpeg";
      b64 = Buffer.from(await fr.arrayBuffer()).toString("base64");
    } else {
      const m = String((req.body && req.body.dataUrl) || "").match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: "bad image" });
      mime = m[1]; b64 = m[2];
    }
    let enhanced = false, aiError = null;
    // 1) AI enhance — best-effort; if it fails we still optimize+upload the original
    if (req.body.enhance !== false) {
      try {
        const out = await enhanceImage(b64, mime);
        if (out && out.image) { b64 = out.image; mime = out.mime || mime; enhanced = true; }
        else aiError = "AI nu a returnat o imagine";
      } catch (e) { aiError = e.message; console.error("ai-optimize enhance failed:", e.message); } // e.g. OpenAI 429 (credit epuizat)
    }
    const input = Buffer.from(b64, "base64");
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

    // Billing: charge the account its per-account price per optimized photo (works for hosts and admins).
    let cost = 0, spent = null, count = null;
    try {
      const pr = await pool.query(
        "update users set photos_optimized = coalesce(photos_optimized,0)+1, photo_spent = coalesce(photo_spent,0)+coalesce(photo_price,3) where id=$1 returning coalesce(photo_price,3) as price, photo_spent, photos_optimized",
        [req.user.id]
      );
      if (pr.rows.length) { cost = Number(pr.rows[0].price); spent = Number(pr.rows[0].photo_spent); count = Number(pr.rows[0].photos_optimized); }
    } catch (e) { /* billing is best-effort; never fail the optimize */ }
    res.json({ url, thumb: thumbUrl, alt, description, enhanced, aiError, cost, spent, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Current hotelier's photo billing (price per photo + cumulative spend).
app.get("/api/host/photo-billing", AUTH.requireAuth, async (req, res) => {
  try {
    const r = await pool.query("select coalesce(photo_price,3) as price, coalesce(photo_spent,0) as spent, coalesce(photos_optimized,0) as count from users where id=$1", [req.user.id]);
    const row = r.rows[0] || { price: 3, spent: 0, count: 0 };
    res.json({ price: Number(row.price), spent: Number(row.spent), count: Number(row.count), isHost: req.user.role === "host" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
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

/* ============== UNIT APPROVAL (hotelier reviews the generated site) ============== */

function approvalLinks(slug, token) {
  return { site: siteUrl(slug), console: "/admin?slug=" + encodeURIComponent(slug), approve: "/aproba/" + token };
}

// Public LocalStay approval page (the link sent to the hotelier by email / WhatsApp).
app.get("/aproba/:token", (req, res) => res.sendFile(path.join(PUBLIC, "approve.html")));

// Info for the approval page (token-gated, no login required).
app.get("/api/approval/:token", async (req, res) => {
  try {
    const r = await pool.query(
      "select slug, admin_state->'property'->'basicInfo'->>'name' as name, approval from properties where approval->>'token' = $1",
      [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Link invalid sau expirat." });
    const row = r.rows[0];
    res.json({
      slug: row.slug, name: row.name || row.slug,
      status: (row.approval && row.approval.status) || "pending",
      note: (row.approval && row.approval.note) || "",
      links: approvalLinks(row.slug, req.params.token)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parseDecision(b) {
  if (b && b.decision === "approved") return "approved";
  if (b && b.decision === "rejected") return "rejected";
  return null;
}

// Record a decision via the token (from the email / WhatsApp link, no login).
app.post("/api/approval/:token", async (req, res) => {
  try {
    const decision = parseDecision(req.body);
    if (!decision) return res.status(400).json({ error: "Decizie invalidă." });
    const patch = { status: decision, note: String((req.body && req.body.note) || "").slice(0, 500), decidedAt: new Date().toISOString() };
    const r = await pool.query(
      "update properties set approval = coalesce(approval,'{}'::jsonb) || $2::jsonb where approval->>'token' = $1 returning slug",
      [req.params.token, JSON.stringify(patch)]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Link invalid." });
    res.json({ ok: true, status: decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a decision from inside the hotelier's own console (session-authenticated).
app.post("/api/host/approval", AUTH.requireAuth, async (req, res) => {
  try {
    const slug = String((req.body && req.body.slug) || "");
    const decision = parseDecision(req.body);
    if (!slug || !decision) return res.status(400).json({ error: "Date lipsă." });
    const patch = { status: decision, note: String((req.body && req.body.note) || "").slice(0, 500), decidedAt: new Date().toISOString() };
    const isAdmin = req.user.role === "admin";
    const where = isAdmin ? "slug=$1" : "slug=$1 and owner_id=$3";
    const params = isAdmin ? [slug, JSON.stringify(patch)] : [slug, JSON.stringify(patch), req.user.id];
    const r = await pool.query(
      "update properties set approval = coalesce(approval,'{}'::jsonb) || $2::jsonb where " + where + " returning slug",
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: "Unitate inexistentă sau fără acces." });
    res.json({ ok: true, status: decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============== OFFERS / DEALS (hotelier-created, shown on the public site) ============== */

const DEAL_TYPES = ["interval_discount", "last_minute", "late_checkout", "early_checkin", "free_snack", "stay_pay", "long_stay", "early_bird"];

function sanitizeDeals(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 40).map(d => {
    d = d || {};
    return {
      id: String(d.id || crypto.randomBytes(6).toString("hex")).slice(0, 40),
      type: DEAL_TYPES.includes(d.type) ? d.type : "interval_discount",
      title: String(d.title || "").slice(0, 120),
      active: d.active !== false,
      percent: Math.max(0, Math.min(90, Math.round(+d.percent || 0))),
      start: String(d.start || "").slice(0, 10),
      end: String(d.end || "").slice(0, 10),
      days: Math.max(0, Math.min(60, Math.round(+d.days || 0))),
      recurring: !!d.recurring,
      time: String(d.time || "").slice(0, 5),
      nights: Math.max(0, Math.min(30, Math.round(+d.nights || 0))),
      freeNights: Math.max(0, Math.min(10, Math.round(+d.freeNights || 0))),
      weekdaysOnly: !!d.weekdaysOnly,
      note: String(d.note || "").slice(0, 300)
    };
  });
}

// Read the hotelier's deals for a unit (host owns slug, or admin).
app.get("/api/host/deals", AUTH.requireAuth, async (req, res) => {
  try {
    const slug = String(req.query.slug || "");
    if (!slug) return res.status(400).json({ error: "slug lipsă" });
    if (!(await AUTH.userCanAccessSlug(pool, req.user, slug))) return res.status(403).json({ error: "Fără acces" });
    const r = await pool.query("select deals, deals_consent from properties where slug=$1", [slug]);
    res.json({ deals: (r.rows[0] && r.rows[0].deals) || [], consent: !!(r.rows[0] && r.rows[0].deals_consent) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotelier agrees that offers are published on the LocalStay platform.
app.post("/api/host/deals-consent", AUTH.requireAuth, async (req, res) => {
  try {
    const slug = String((req.body && req.body.slug) || "");
    if (!slug) return res.status(400).json({ error: "slug lipsă" });
    if (!(await AUTH.userCanAccessSlug(pool, req.user, slug))) return res.status(403).json({ error: "Fără acces" });
    await pool.query("update properties set deals_consent=$1 where slug=$2", [!!(req.body && req.body.consent), slug]);
    res.json({ ok: true, consent: !!(req.body && req.body.consent) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save the deals array for a unit.
app.post("/api/host/deals", AUTH.requireAuth, async (req, res) => {
  try {
    const slug = String((req.body && req.body.slug) || "");
    if (!slug) return res.status(400).json({ error: "slug lipsă" });
    if (!(await AUTH.userCanAccessSlug(pool, req.user, slug))) return res.status(403).json({ error: "Fără acces" });
    const deals = sanitizeDeals(req.body && req.body.deals);
    await pool.query("update properties set deals=$1 where slug=$2", [JSON.stringify(deals), slug]);
    res.json({ ok: true, deals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: active (non-expired) deals for a unit — rendered on the public site.
app.get("/api/site/:slug/deals", async (req, res) => {
  try {
    const r = await pool.query("select deals from properties where slug=$1", [req.params.slug]);
    const all = (r.rows[0] && r.rows[0].deals) || [];
    const today = todayIso();
    const active = all.filter(d => d && d.active !== false && !(d.type === "interval_discount" && d.end && d.end < today));
    res.json({ deals: active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Core import logic, reusable for single + bulk import.
async function importOne(master) {
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

  // Auto-provision a host account for this property. Default credentials:
  //   email    = <slug>@<BASE_DOMAIN || localstay.ro>
  //   password = <slug>            (the hotelier changes it after first login)
  // Re-importing the same slug reuses the existing account (no duplicate, no
  // password reset) and never steals a property already owned by someone else.
  let host = null;
  try {
    const hostEmail = normEmail(slug + "@" + (BASE_DOMAIN || "localstay.ro"));
    const found = await pool.query("select id from users where email=$1", [hostEmail]);
    let hostId;
    if (found.rows.length) {
      hostId = found.rows[0].id;
      host = { email: hostEmail, created: false };
    } else {
      const hash = await AUTH.hashPassword(slug);
      const ins = await pool.query(
        "insert into users(email,password_hash,role,name) values($1,$2,'host',$3) returning id",
        [hostEmail, hash, merged.property.basicInfo.name || slug]
      );
      hostId = ins.rows[0].id;
      host = { email: hostEmail, password: slug, created: true };
    }
    await pool.query("update properties set owner_id=$1 where slug=$2 and owner_id is null", [hostId, slug]);
  } catch (e) {
    host = { error: e.message }; // never fail the import over host provisioning
  }

  // Ensure an approval record exists (status "pending") without resetting a prior decision.
  let approval = null;
  try {
    const cur = await pool.query("select approval from properties where slug=$1", [slug]);
    approval = cur.rows[0] && cur.rows[0].approval;
    if (!approval || !approval.token) {
      approval = { status: "pending", token: crypto.randomBytes(18).toString("hex"), requestedAt: new Date().toISOString() };
      await pool.query("update properties set approval=$1 where slug=$2", [approval, slug]);
    }
  } catch (e) { /* approval is best-effort */ }

  return { slug, name: merged.property.basicInfo.name || slug, merged: !!existing, host, url: siteUrl(slug), approval: approval ? { status: approval.status, token: approval.token } : null };
}

app.post("/api/import", AUTH.requireAdmin, async (req, res) => {
  try {
    res.json(await importOne(req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk import: accepts { items:[master, ...] } or a raw array. Each property is
// imported independently; one bad item never aborts the rest.
app.post("/api/import-bulk", AUTH.requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : (Array.isArray(req.body && req.body.items) ? req.body.items : null);
  if (!items || !items.length) return res.status(400).json({ error: "Trimite un array de proprietăți (items)." });
  if (items.length > 100) return res.status(400).json({ error: "Maxim 100 de proprietăți per import." });
  const results = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await importOne(items[i]);
      results.push({ ok: true, index: i, slug: r.slug, name: r.name, merged: r.merged, url: r.url, approval: r.approval, host: r.host });
    } catch (e) {
      let nm = "";
      try { nm = (items[i] && items[i].general && items[i].general.basicInfo && items[i].general.basicInfo.name) || (items[i] && items[i].name) || ""; } catch (_) {}
      results.push({ ok: false, index: i, name: nm, error: e.message });
    }
  }
  res.json({ count: results.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});

app.get("/api/properties", AUTH.requireAuth, async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const r = await pool.query(
    `select slug,
            admin_state->'property'->'basicInfo'->>'name' as name,
            site->'photos'->>'hero' as hero
     from properties
     ${isAdmin ? "" : "where owner_id = $1"}
     order by updated_at desc`,
    isAdmin ? [] : [req.user.id]
  );
  res.json(r.rows);
});

app.delete("/api/host/:slug", AUTH.requireAdmin, async (req, res) => {
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

app.get("/api/host/:slug/booking-requests", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    const r = await pool.query(
      "select * from booking_requests where slug=$1 order by created_at desc limit 500",
      [req.params.slug]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Facebook module: saved groups + AI post generation ---------- */
app.get("/api/host/:slug/fb-groups", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    const r = await pool.query("select id, name, url, created_at from fb_groups where slug=$1 order by created_at", [req.params.slug]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/host/:slug/fb-groups", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : (Array.isArray(req.body && req.body.items) ? req.body.items : [req.body || {}]);
    const out = [];
    for (const it of items.slice(0, 200)) {
      const name = String((it && it.name) || "").trim();
      let url = String((it && it.url) || "").trim();
      if (!name && !url) continue;
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      const r = await pool.query("insert into fb_groups(slug,name,url) values($1,$2,$3) returning id,name,url,created_at", [req.params.slug, name || url, url]);
      out.push(r.rows[0]);
    }
    res.json({ added: out.length, items: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/host/:slug/fb-groups/:id", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    await pool.query("delete from fb_groups where id=$1 and slug=$2", [req.params.id, req.params.slug]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/host/:slug/fb-generate", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    const p = await getProp(req.params.slug);
    if (!p) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const site = p.site || {};
    // absolute URLs (Render is behind a proxy; trust proxy is set so req.protocol is correct)
    const origin = req.protocol + "://" + req.get("host");
    const pubUrl = BASE_DOMAIN ? siteUrl(req.params.slug) : (origin + "/s/" + req.params.slug);
    const calUrl = origin + "/w/" + req.params.slug;
    // facilities: most-appreciated first, then the rest (deduped) — from the real site data only
    const amen = Array.isArray(site.amenities) ? site.amenities : [];
    const nm = x => (x && (x.name || x.label)) || (typeof x === "string" ? x : "");
    const mostApp = ((amen.find(a => /apreciat/i.test(a.title || "")) || {}).items || []).map(nm).filter(Boolean);
    const rest = amen.filter(a => !/apreciat/i.test(a.title || ""))
      .reduce((acc, a) => acc.concat((a.items || []).map(nm)), []).filter(Boolean);
    const facilities = mostApp.concat(rest.filter(f => mostApp.indexOf(f) < 0)).slice(0, 14);
    const loc = site.location || {};
    const location = [loc.area, loc.county].filter(Boolean).join(", ");
    // property facts (bedrooms, baths, parking, experience, natural setting, category, suitable-for...) from the real "about" section
    const about = Array.isArray(site.about) ? site.about : [];
    const facts = about.map(a => ((a.label || "") + ": " + (a.value || "")).trim())
      .filter(s => s && s !== ":").join("; ");
    const out = await generateFbPosts({
      propertyName: site.name || "",
      location,
      capacity: site.capacity || (site.basicInfo && site.basicInfo.unitCapacity) || "",
      facilities,
      facts,
      url: pubUrl,
      calendarUrl: calUrl,
      occasion: b.occasion || "ofertă",
      details: b.details || "",
      tone: b.tone || "prietenos",
      emoji: b.emoji !== false,
      includeLink: !!b.includeLink,
      includeCalendar: !!b.includeCalendar,
      count: Math.max(1, Math.min(30, +b.count || (Array.isArray(b.groups) ? b.groups.length : 1) || 1)),
      groups: Array.isArray(b.groups) ? b.groups : [],
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stream a property photo as a download (so it can be attached to a Facebook post).
// Restricted to the property's own R2 bucket to avoid open-proxy/SSRF.
app.get("/api/host/:slug/fb-photo", AUTH.requireSlugAccess(pool), async (req, res) => {
  try {
    const base = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
    const u = String(req.query.u || "");
    if (!base || !u.startsWith(base + "/")) return res.status(400).send("URL invalid");
    const fr = await fetch(u);
    if (!fr.ok) return res.status(502).send("fetch " + fr.status);
    const ct = fr.headers.get("content-type") || "image/jpeg";
    const name = ((u.split("/").pop() || "poza").split("?")[0]).replace(/[^\w.\-]/g, "_");
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '"');
    res.send(Buffer.from(await fr.arrayBuffer()));
  } catch (e) { res.status(500).send(e.message); }
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

/* ---------- host dashboard: occupancy, est. revenue, traffic, requests ---------- */
function todayIso(){ return iso(new Date()); }
function addDaysIso(s,n){ const d=fromIso(s); d.setUTCDate(d.getUTCDate()+n); return iso(d); }
function rangeDates(fromS,toS){ const out=[]; let d=fromIso(fromS); const end=fromIso(toS); while(d<end){ out.push(iso(d)); d.setUTCDate(d.getUTCDate()+1); } return out; }
function isWeekendIso(s){ const w=fromIso(s).getUTCDay(); return w===5||w===6; } // Fri/Sat nights
function nightlyPrice(pricing, roomId, ds){
  const dp=(pricing && pricing.dayPrices) || {};
  if (dp[roomId] && dp[roomId][ds]!=null) return +dp[roomId][ds] || 0;
  const rooms=(pricing && pricing.rooms) || [];
  const room=rooms.find(r=>r.id===roomId) || {};
  const we=isWeekendIso(ds);
  const periods=(pricing && pricing.periods) || [];
  const per=periods.find(p=>(p.roomId===roomId||p.roomId==="all") && p.start && p.end && ds>=p.start && ds<=p.end);
  if (per){ const v=we ? (per.weekend||per.weekday) : per.weekday; if (v) return +v || 0; }
  const base=we ? (room.weekend||room.weekday) : room.weekday;
  return +base || 0;
}
function occupancyAndRevenue(adminState, dates){
  const units=(adminState && adminState.units) || [];
  const pricing=(adminState && adminState.pricing) || {};
  const rooms=pricing.rooms || [];
  const hasEntire=rooms.some(r=>r.isEntire), hasRooms=rooms.some(r=>!r.isEntire);
  // when a property mixes an "entire" unit with individual rooms, count only the rooms
  // (the entire unit mirrors them, so counting both would double-count nights)
  const counted=units.filter(u=>{ const r=rooms.find(x=>x.id===u.id); const isE=r?!!r.isEntire:false; return (hasEntire&&hasRooms)?!isE:true; });
  const dateSet=new Set(dates);
  let occ=0, rev=0;
  counted.forEach(u=>{ effectiveBlocked(adminState, u.id).forEach(ds=>{ if (dateSet.has(ds)){ occ++; rev+=nightlyPrice(pricing, u.id, ds); } }); });
  return { occNights:occ, totalNights:counted.length*dates.length, estRevenue:Math.round(rev), currency:(rooms[0]&&rooms[0].currency)||"RON", units:counted.length };
}
// Map a page_view event's referrer/utm to a readable traffic source label.
function classifySource(meta, ownHosts) {
  let m = meta || {};
  if (typeof m === "string") { try { m = JSON.parse(m); } catch (e) { m = {}; } }
  const utm = String(m.utm || "").trim();
  if (utm) return utm.charAt(0).toUpperCase() + utm.slice(1);
  const ref = String(m.ref || "").trim();
  if (!ref) return "Direct";
  let host = "";
  try { host = new URL(ref).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return "Direct"; }
  if (host.endsWith("onrender.com")) return "Intern";
  if (ownHosts.some(h => h && (host === h || host.endsWith("." + h)))) return "Intern";
  if (host.includes("google")) return "Google";
  if (host.includes("facebook") || host === "fb.com" || host.startsWith("l.facebook")) return "Facebook";
  if (host.includes("instagram")) return "Instagram";
  if (host.includes("tiktok")) return "TikTok";
  if (host.includes("bing")) return "Bing";
  if (host.includes("t.co") || host.includes("twitter") || host === "x.com") return "X/Twitter";
  if (host.includes("booking.com")) return "Booking.com";
  if (host.includes("airbnb")) return "Airbnb";
  return host; // fallback: the referring domain itself
}

// Aggregated dashboard for a hotelier across all their properties (admin sees all).
app.get("/api/host/overview", AUTH.requireAuth, async (req, res) => {
  try {
    const days=[7,30,90].includes(+req.query.days) ? +req.query.days : 30;
    const wantSlug = req.query.slug ? String(req.query.slug) : null;
    const propsQ = req.user.role==="admin"
      ? await pool.query("select slug, admin_state from properties order by created_at desc")
      : await pool.query("select slug, admin_state from properties where owner_id=$1 order by created_at desc", [req.user.id]);
    // optional: scope the whole dashboard to a single property the user can access
    const props = wantSlug ? propsQ.rows.filter(p => p.slug === wantSlug) : propsQ.rows;
    const slugs=props.map(p=>p.slug);
    const today=todayIso(), fwdEnd=addDaysIso(today,days), backStart=addDaysIso(today,-days);
    const fwdDates=rangeDates(today,fwdEnd);

    let occ=0,total=0,rev=0,currency="RON"; const perProperty=[];
    props.forEach(p=>{
      const s=occupancyAndRevenue(p.admin_state, fwdDates);
      occ+=s.occNights; total+=s.totalNights; rev+=s.estRevenue; if (s.currency) currency=s.currency;
      const name=(p.admin_state.property && p.admin_state.property.basicInfo && p.admin_state.property.basicInfo.name) || p.slug;
      perProperty.push({ slug:p.slug, name, occupancy: s.totalNights?Math.round(s.occNights/s.totalNights*100):0, occNights:s.occNights, estRevenue:s.estRevenue, currency:s.currency, units:s.units });
    });
    const nameOf={}; perProperty.forEach(pp=>{ nameOf[pp.slug]=pp.name; });

    let events=[], reqsBack=[], stays=[];
    if (slugs.length){
      events=(await pool.query("select type, meta, slug, to_char(created_at,'YYYY-MM-DD') as day from site_events where slug = ANY($1) and created_at >= $2 and type in ('page_view','phone_reveal')", [slugs, backStart])).rows;
      reqsBack=(await pool.query("select status, slug, to_char(created_at,'YYYY-MM-DD') as day from booking_requests where slug = ANY($1) and created_at >= $2", [slugs, backStart])).rows;
      stays=(await pool.query("select slug, name, phone, to_char(checkin,'YYYY-MM-DD') as checkin, to_char(checkout,'YYYY-MM-DD') as checkout, adults, children, status from booking_requests where slug = ANY($1) and ((checkin >= $2 and checkin < $3) or (checkout >= $2 and checkout < $3)) order by checkin asc limit 100", [slugs, today, fwdEnd])).rows;
    }
    const views=events.filter(e=>e.type==="page_view").length;
    const reveals=events.filter(e=>e.type==="phone_reveal").length;
    const requests=reqsBack.length;
    const byStatus={}; reqsBack.forEach(r=>{ const s=r.status||"nou"; byStatus[s]=(byStatus[s]||0)+1; });

    // traffic sources (from page_view referrer/utm) — analytics without GA
    const ownHosts = [BASE_DOMAIN].filter(Boolean);
    const srcCounts = {};
    events.forEach(e => { if (e.type === "page_view") { const s = classifySource(e.meta, ownHosts); srcCounts[s] = (srcCounts[s] || 0) + 1; } });
    const sources = Object.keys(srcCounts).map(k => ({ source: k, count: srcCounts[k] })).sort((a, b) => b.count - a.count);

    const trend=rangeDates(backStart, addDaysIso(today,1)).map(d=>({ date:d, views:0, requests:0 }));
    const tindex={}; trend.forEach(t=>{ tindex[t.date]=t; });
    events.forEach(e=>{ if (e.type==="page_view" && tindex[e.day]) tindex[e.day].views++; });
    reqsBack.forEach(r=>{ if (tindex[r.day]) tindex[r.day].requests++; });

    // per-property traffic + requests (platform view for master admin)
    const viewsBySlug={}, reqBySlug={};
    events.forEach(e=>{ if (e.type==="page_view") viewsBySlug[e.slug]=(viewsBySlug[e.slug]||0)+1; });
    reqsBack.forEach(r=>{ reqBySlug[r.slug]=(reqBySlug[r.slug]||0)+1; });
    perProperty.forEach(pp=>{ pp.views=viewsBySlug[pp.slug]||0; pp.requests=reqBySlug[pp.slug]||0; });

    const fmt=s=>({ name:s.name||"—", phone:s.phone||"", property:nameOf[s.slug]||s.slug, checkin:s.checkin, checkout:s.checkout, guests:(s.adults||0)+(s.children||0), status:s.status||"nou" });
    const arrivals=stays.filter(s=>s.checkin && s.checkin>=today && s.checkin<fwdEnd).map(fmt);
    const departures=stays.filter(s=>s.checkout && s.checkout>=today && s.checkout<fwdEnd).map(fmt);

    // leads = users who left personal data (booking-request contacts), most recent first
    let leadRows=[];
    if (slugs.length) {
      leadRows=(await pool.query(
        "select slug, name, phone, email, to_char(checkin,'YYYY-MM-DD') as checkin, to_char(checkout,'YYYY-MM-DD') as checkout, adults, children, status, to_char(created_at,'YYYY-MM-DD') as day from booking_requests where slug = ANY($1) order by created_at desc limit 60",
        [slugs])).rows;
    }
    const leads = leadRows.map(r=>({ name:r.name||"—", phone:r.phone||"", email:r.email||"", property:nameOf[r.slug]||r.slug, checkin:r.checkin, checkout:r.checkout, guests:(r.adults||0)+(r.children||0), status:r.status||"nou", day:r.day }));
    const leadsTotal = leadRows.length;

    res.json({
      days, properties: perProperty.length,
      occupancy: total?Math.round(occ/total*100):0, occNights:occ, totalNights:total,
      estRevenue:Math.round(rev), currency,
      views, reveals, requests, byStatus,
      conv: { viewToReveal: views?Math.round(reveals/views*100):0, revealToRequest: reveals?Math.round(requests/reveals*100):0, viewToRequest: views?Math.round(requests/views*100):0 },
      trend, arrivals, departures, perProperty, leads, leadsTotal, sources
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- global stats for the importer dashboard ---------- */
app.get("/api/stats", AUTH.requireAdmin, async (req, res) => {
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

app.get("/api/host/:slug/state", AUTH.requireSlugAccess(pool), async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.admin_state);
});

app.put("/api/host/:slug/state", AUTH.requireSlugAccess(pool), async (req, res) => {
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

app.post("/api/host/:slug/sync", AUTH.requireSlugAccess(pool), async (req, res) => {
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
  if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  const html = fs.readFileSync(path.join(PUBLIC, "admin-console.html"), "utf8");
  const slug = req.query.slug;
  if (!slug) return res.send(html);
  const allowed = await AUTH.userCanAccessSlug(pool, req.user, slug);
  if (!allowed) return res.status(403).send("Nu ai acces la această proprietate.");
  const p = await getProp(slug);
  if (!p) return res.status(404).send("Proprietate negăsită");
  const ap = p.approval || {};
  res.send(inject(html,
    "window.__ADMIN_STATE=" + JSON.stringify(p.admin_state) +
    ";window.__ME=" + JSON.stringify({ role: req.user.role, email: req.user.email, imp: !!req.user.imp }) +
    ";window.__APPROVAL=" + JSON.stringify({ status: ap.status || "pending", token: ap.token || "", note: ap.note || "" }) + ";"));
});

/* public site by path (preview without a subdomain) */
app.get("/s/:slug", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).send("Proprietate negăsită");
  res.send(renderSite(p.site, p.slug));
});

/* Embeddable per-room availability calendar widget (for the hotelier's own site) */
app.get("/w/:slug", async (req, res) => {
  const p = await getProp(req.params.slug);
  if (!p) return res.status(404).send("Proprietate negăsită");
  const tpl = fs.readFileSync(path.join(PUBLIC, "widget.html"), "utf8");
  const url = siteUrl(p.slug);
  const html = inject(tpl, "window.STAY_PROPERTY=" + JSON.stringify(p.site) + ";window.STAY_SLUG=" + JSON.stringify(p.slug || "") + ";window.STAY_URL=" + JSON.stringify(url) + ";");
  res.send(html);
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
// Public login page.
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC, "login.html")));

// The importer hub is ADMIN ONLY. Hosts get their own dashboard at /host so a
// hotelier can never load the platform admin (import, hosts, global stats).
app.get("/importer.html", (req, res) => {
  if (!req.user) return res.redirect("/login");
  if (req.user.role !== "admin") return res.redirect("/host");
  res.sendFile(path.join(PUBLIC, "importer.html"));
});

// Hotelier landing — the unified console (editor + dashboard) for their property.
app.get("/host", async (req, res) => {
  if (!req.user) return res.redirect("/login?next=/host");
  if (req.user.role === "admin") return res.redirect("/importer.html");
  try {
    const r = await pool.query("select slug from properties where owner_id=$1 order by created_at asc limit 1", [req.user.id]);
    if (r.rows.length) return res.redirect("/admin?slug=" + encodeURIComponent(r.rows[0].slug));
  } catch (e) {}
  // no property assigned yet → simple empty-state page
  res.sendFile(path.join(PUBLIC, "host.html"));
});
app.get("/host.html", (req, res) => res.redirect("/host"));

// Don't let the raw editor shell load without auth — funnel to the gated /admin route.
app.get("/admin-console.html", (req, res) => {
  if (!req.user) return res.redirect("/login");
  res.redirect("/admin" + (req.query.slug ? "?slug=" + encodeURIComponent(req.query.slug) : ""));
});

app.use(express.static(PUBLIC));
// Role-aware landing: admins → hub, hosts → their dashboard.
app.get("/", (req, res) => res.redirect(!req.user ? "/login" : (req.user.role === "admin" ? "/importer.html" : "/host")));

/* ---------- start ---------- */
// Keep the web service alive even through transient DB outages: a stray async
// rejection (e.g. a request that hits the DB while it's briefly down) must not kill the process.
process.on("unhandledRejection", (e) => console.error("Unhandled rejection (ignored):", e && e.message));

const PORT = process.env.PORT || 3000;
// Listen FIRST so the port is open and health checks pass — no 502 if the DB is briefly unavailable.
app.listen(PORT, () => console.log("LocalStay running on port " + PORT));

let _icalStarted = false;
function startIcalSync() {
  if (_icalStarted) return; _icalStarted = true;
  setTimeout(syncAll, 30000);
  setInterval(syncAll, 15 * 60 * 1000);
}
// Give every existing unit an approval token (so already-imported units get a
// shareable approval link without needing a re-import).
async function backfillApproval() {
  try {
    const r = await pool.query("select slug from properties where approval is null or approval->>'token' is null");
    for (const row of r.rows) {
      const ap = { status: "pending", token: crypto.randomBytes(18).toString("hex"), requestedAt: new Date().toISOString() };
      await pool.query("update properties set approval=$1 where slug=$2", [ap, row.slug]);
    }
    if (r.rows.length) console.log("[approval] backfilled tokens for " + r.rows.length + " unit(s).");
  } catch (e) { console.error("[approval] backfill failed:", e && e.message); }
}

function bootDb() {
  init()
    .then(() => { console.log("LocalStay DB ready."); startIcalSync(); backfillApproval(); return AUTH.seedAdmin(pool).catch((e)=>console.error("[auth] seedAdmin failed:", e && e.message)); })
    .catch((e) => {
      console.error("DB not ready, server stays up; retrying in 30s:", e && e.message);
      setTimeout(bootDb, 30000); // recover automatically when the DB comes back
    });
}
bootDb();
