/* Authentication for StayPredeal.
   Two roles:
     - admin : platform owner (us). Sees every property, imports, stats, manages hosts.
     - host  : a hotelier. Manages only the properties they own (properties.owner_id).
   Stateless auth: a signed JWT stored in an httpOnly cookie. No session table needed. */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const COOKIE = "stay_auth";
const TOKEN_TTL = "7d";
const SECRET =
  process.env.AUTH_SECRET ||
  // Fallback keeps local dev working, but logs a loud warning so it isn't shipped.
  "INSECURE-DEV-SECRET-change-me";

if (!process.env.AUTH_SECRET) {
  console.warn(
    "[auth] AUTH_SECRET is not set — using an insecure dev secret. " +
      "Set AUTH_SECRET in the environment before going to production."
  );
}

/* ---------- passwords ---------- */
async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 12);
}
async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(String(plain), hash);
  } catch {
    return false;
  }
}

/* ---------- tokens / cookies ---------- */
function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, email: user.email },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}
function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}
function isSecure(req) {
  return (
    req.secure ||
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
  );
}
function setAuthCookie(req, res, user) {
  const token = signToken(user);
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isSecure(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearAuthCookie(req, res) {
  const parts = [
    `${COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecure(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/* ---------- middleware ---------- */
// Non-blocking: reads the cookie and attaches req.user (or null). Always calls next().
function attachUser(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const payload = token ? verifyToken(token) : null;
  req.user = payload ? { id: payload.uid, role: payload.role, email: payload.email } : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Autentificare necesară" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Autentificare necesară" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acces interzis" });
  next();
}

// True if the user may manage this slug: admins always, hosts only if they own it.
async function userCanAccessSlug(pool, user, slug) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const r = await pool.query("select owner_id from properties where slug=$1", [slug]);
  if (!r.rows.length) return false;
  return String(r.rows[0].owner_id || "") === String(user.id);
}

// Middleware factory: gate a :slug route by ownership.
function requireSlugAccess(pool) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Autentificare necesară" });
    try {
      const ok = await userCanAccessSlug(pool, req.user, req.params.slug);
      if (!ok) return res.status(403).json({ error: "Acces interzis" });
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

/* ---------- bootstrap the first admin from env ---------- */
async function seedAdmin(pool) {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    const exists = await pool.query("select 1 from users where role='admin' limit 1");
    if (!exists.rows.length) {
      console.warn(
        "[auth] No admin account exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set. " +
          "Set them to auto-create the first admin on startup."
      );
    }
    return;
  }
  const existing = await pool.query("select id from users where email=$1", [email]);
  if (existing.rows.length) return; // already created — don't overwrite
  const hash = await hashPassword(password);
  await pool.query(
    "insert into users(email,password_hash,role,name) values($1,$2,'admin','Administrator')",
    [email, hash]
  );
  console.log("[auth] Seeded admin account:", email);
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookies,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  requireSlugAccess,
  userCanAccessSlug,
  seedAdmin,
};
