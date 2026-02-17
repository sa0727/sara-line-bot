// db.js
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

// RenderのPostgresは基本SSL接続が必要（外部/内部URLどちらでも）
// rejectUnauthorized:false は Render の証明書チェーン事情で必要になることがある
const shouldUseSSL =
  process.env.PGSSLMODE === "disable" ? false : true; // 明示disableしたい時だけOFF

if (!DATABASE_URL) {
  // 起動時に気づけるように（checkout_failedの原因を早期に潰す）
  console.warn("[db] DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: shouldUseSSL ? { rejectUnauthorized: false } : false,
  // たまにコネクション詰まり防止（好みで）
  // max: 5,
  // idleTimeoutMillis: 30_000,
  // connectionTimeoutMillis: 10_000,
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
