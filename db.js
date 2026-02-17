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
  // max: 5,
  // idleTimeoutMillis: 30_000,
  // connectionTimeoutMillis: 10_000,
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * 起動時に最低限のテーブルを用意
 * - ここが無いと 42P01 (relation does not exist) が出る
 */
async function initDB() {
  if (!DATABASE_URL) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      line_user_id TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'inactive',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // updated_at 自動更新（任意だけど便利）
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at'
      ) THEN
        CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at();
      END IF;
    END
    $$;
  `);

  console.log("✅ [db] users table ensured");
}

// サーバ起動時に実行（失敗しても落とさずログに出す）
initDB().catch((e) => console.error("❌ [db] initDB failed:", e));

module.exports = { pool, query, initDB };
