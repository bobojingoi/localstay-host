const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const url = process.env.DATABASE_URL || "";
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

const pool = new Pool({
  connectionString: url,
  // Managed Postgres (Render/Neon/Supabase) needs SSL; local usually doesn't.
  ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
});

// Runs the schema on startup so you never have to open psql by hand.
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Database ready.");
}

module.exports = { pool, init };
