const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const url = process.env.DATABASE_URL || "";
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

const pool = new Pool({
  connectionString: url,
  // Managed Postgres (Render/Neon/Supabase) needs SSL; local usually doesn't.
  ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
  // Fail fast when the DB is unreachable instead of hanging the request forever.
  connectionTimeoutMillis: 6000,
  idleTimeoutMillis: 30000,
  query_timeout: 12000,
  max: 10,
});

// Don't let a dropped idle DB connection crash the whole process.
pool.on("error", (err) => {
  console.error("Postgres pool error (ignored):", err && err.message);
});

// Runs the schema on startup so you never have to open psql by hand.
// Retries on transient connectivity errors so a brief DB restart doesn't crash-loop the service.
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(sql);
      console.log("Database ready.");
      return;
    } catch (e) {
      const msg = (e && e.message) || "";
      const transient = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|terminating connection|starting up|Connection terminated|server closed/i.test(msg);
      if (attempt === maxAttempts || !transient) {
        console.error("Database init failed (attempt " + attempt + "/" + maxAttempts + "): " + msg);
        throw e;
      }
      const delay = Math.min(1000 * attempt, 8000);
      console.warn("DB not ready (attempt " + attempt + "/" + maxAttempts + "): " + msg + " — retrying in " + delay + "ms");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { pool, init };
