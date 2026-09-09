try { require('dotenv').config(); } catch (_) { /* dotenv not installed — env vars set by host */ }
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

// Web Push (optional — gracefully disabled if not installed)
let webpush = null;
try { webpush = require('web-push'); } catch (_) {}

const JWT_SECRET = process.env.JWT_SECRET || 'fc-default-dev-secret-please-set-env';
const JWT_EXPIRY = '365d';

// Accounts with full super-admin privileges (unlimited points, free shop, no ban/reset, super-admin panel)
const SUPER_ADMINS = ['danielthecreator', 'friendnix'];
// All accounts with unlimited Friend Points / free shop (superset of SUPER_ADMINS)
const PRIVILEGED_USERS = ['danielthecreator', 'leo', 'friendnix'];

// Case-insensitive helpers
const isSuperAdmin = (username) => SUPER_ADMINS.includes((username || '').toLowerCase());
const isPrivilegedUser = (username) => PRIVILEGED_USERS.includes((username || '').toLowerCase());
// Only the friendnix account acts on admin actions immediately (everyone else goes through the approval queue)
const isFriendNix = (username) => (username || '').toLowerCase() === 'friendnix';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '8mb' }));

// Health check — used by the frontend to detect when the server has woken up.
// Returns 503 until initDB() finishes so Railway/Render doesn't route traffic
// before the database is loaded (prevents the "friends disappear" race condition).
app.get('/api/health', (_req, res) => {
  if (!dbInitialized) return res.status(503).json({ ok: false, status: 'starting' });
  res.json({ ok: true });
});

// Serve built frontend with long cache for hashed assets, no-cache for HTML
app.use(express.static(path.join(__dirname, '../frontend/dist'), {
  maxAge: '1y', etag: true, lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// =================== DATABASE ===================
// When MONGODB_URI is set (e.g. on Render), data is stored in MongoDB Atlas
// and persists across every redeploy. Otherwise falls back to backend/data/db.json
// for local development.
// DATA_DIR can be set to a Railway/Render persistent volume mount path so
// Auto-detect a Railway Volume mounted at /data (no env var needed).
// Priority: MONGODB_URI > DATA_DIR env var > /data volume (auto) > local data/db.json
const _autoVolumeDir = '/data';
const FILE_DB_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'db.json')
  : (fs.existsSync(_autoVolumeDir) ? path.join(_autoVolumeDir, 'db.json')
    : path.join(__dirname, 'data', 'db.json'));
const FILE_DB_BACKUP_PATH = FILE_DB_PATH.replace(/\.json$/, '.backup.json');
if (FILE_DB_PATH.startsWith(_autoVolumeDir)) {
  console.log('📦 Using Railway Volume at /data for persistent storage');
}

// Warn loudly in production when no persistent storage is configured.
// Without MongoDB or a mounted volume, ALL data (users, friends, messages)
// is wiped on every redeploy because db.json is local to the container.
if (process.env.NODE_ENV === 'production') {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!mongoUri && !fs.existsSync(_autoVolumeDir) && !process.env.DATA_DIR) {
    console.warn('\n⚠️  WARNING: No persistent storage detected!');
    console.warn('   All user data will be WIPED on every redeploy.');
    console.warn('   Fix: Set the MONGODB_URI environment variable in your');
    console.warn('   Railway / Render dashboard with a MongoDB Atlas connection string.');
    console.warn('   Get a free database at: https://www.mongodb.com/atlas\n');
  }
}

let dbCache = null;        // always-current in-memory copy
let dbInitialized = false; // true once initDB() has finished loading
let mongoCollection = null; // set when MongoDB is in use
let pgPool = null;          // set when PostgreSQL is in use
let _mongoWriteTimer = null;   // debounce timer — coalesces rapid writes
let _mongoWritePending = null; // in-flight write promise

function readDB() {
  // Return a safe empty shell if initDB() hasn't completed yet (early-listen race guard)
  if (!dbCache) return { users: {}, messages: {}, groups: {}, pendingActions: [], userLog: [], flags: [] };
  return dbCache;
}

function writeDB(data) {
  dbCache = data;
  if (!dbInitialized) return; // don't persist during startup race window
  // Always write to file as backup (survives MongoDB outages and redeploy races)
  try {
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(FILE_DB_PATH, serialized);
    try { fs.writeFileSync(FILE_DB_BACKUP_PATH, serialized); } catch {}
  } catch (e) { /* non-critical — DB is primary */ }
  if (mongoCollection) {
    // Debounce: coalesce rapid back-to-back writes (e.g. burst of messages) into one
    // MongoDB operation. 50ms gives a very small loss window on crash while still
    // batching bursts that happen within the same tick.
    if (_mongoWriteTimer) clearTimeout(_mongoWriteTimer);
    _mongoWriteTimer = setTimeout(() => {
      _mongoWriteTimer = null;
      const snapshot = dbCache; // capture current state at time of flush
      _mongoWritePending = mongoCollection
        .replaceOne({ _id: 'main' }, { _id: 'main', ...snapshot }, { upsert: true })
        .then(() => { _mongoWritePending = null; })
        .catch((err) => {
          console.error('MongoDB write error:', err.message);
          _mongoWritePending = null;
        });
    }, 50);
  } else if (pgPool) {
    if (_mongoWriteTimer) clearTimeout(_mongoWriteTimer);
    _mongoWriteTimer = setTimeout(() => {
      _mongoWriteTimer = null;
      const snapshot = JSON.stringify(dbCache);
      pgPool.query(
        `INSERT INTO appdb (id, data) VALUES ('main', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [snapshot]
      ).catch((err) => console.error('PostgreSQL write error:', err.message));
    }, 50);
  }
}

// writeDBNow — for critical operations (friend add/accept, shop purchase, avatar, etc.)
// Cancels any pending debounce and writes immediately to MongoDB.
async function writeDBNow(data) {
  dbCache = data;
  if (_mongoWriteTimer) {
    clearTimeout(_mongoWriteTimer);
    _mongoWriteTimer = null;
  }
  // Always write to file as backup
  try {
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(FILE_DB_PATH, serialized);
    try { fs.writeFileSync(FILE_DB_BACKUP_PATH, serialized); } catch {}
  } catch (e) { /* non-critical */ }
  if (mongoCollection) {
    try {
      await mongoCollection.replaceOne(
        { _id: 'main' },
        { _id: 'main', ...data },
        { upsert: true }
      );
    } catch (err) {
      console.error('MongoDB immediate write error:', err.message);
      writeDB(data);
    }
  } else if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO appdb (id, data) VALUES ('main', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [JSON.stringify(data)]
      );
    } catch (err) {
      console.error('PostgreSQL immediate write error:', err.message);
      writeDB(data);
    }
  }
}

// Flush any pending MongoDB/PostgreSQL write immediately — called on graceful shutdown.
async function flushMongo() {
  if (pgPool) {
    if (_mongoWriteTimer) { clearTimeout(_mongoWriteTimer); _mongoWriteTimer = null; }
    try {
      await pgPool.query(
        `INSERT INTO appdb (id, data) VALUES ('main', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [JSON.stringify(dbCache)]
      );
      console.log('✅ PostgreSQL flushed on shutdown');
    } catch (err) {
      console.error('PostgreSQL flush error on shutdown:', err.message);
    }
    return;
  }
  if (!mongoCollection) return;
  if (_mongoWriteTimer) {
    clearTimeout(_mongoWriteTimer);
    _mongoWriteTimer = null;
  }
  if (_mongoWritePending) {
    await _mongoWritePending.catch(() => {});
    _mongoWritePending = null;
  }
  try {
    await mongoCollection.replaceOne(
      { _id: 'main' },
      { _id: 'main', ...dbCache },
      { upsert: true }
    );
    console.log('✅ MongoDB flushed on shutdown');
  } catch (err) {
    console.error('MongoDB flush error on shutdown:', err.message);
  }
}

// Graceful shutdown — ensure the last state reaches MongoDB before the process exits.
// Cloud hosts (Render, Railway) send SIGTERM before killing the container.
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received — flushing data to MongoDB before exit...`);
  await flushMongo();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

async function initDB() {
  // Support both MONGODB_URI (manual/Atlas) and MONGO_URL (Railway built-in MongoDB service).
  // Try each URI in order — if one fails auth/connection, fall through to the next.
  const mongoUris = [
    process.env.MONGODB_URI,
    process.env.MONGO_URL,
  ].filter(Boolean);

  for (const mongoUri of mongoUris) {
    const label = mongoUri === process.env.MONGO_URL ? 'MONGO_URL' : 'MONGODB_URI';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { MongoClient } = require('mongodb');
        // Only force TLS for Atlas SRV URIs — Railway's internal MongoDB uses plain TCP
        const isSrv = mongoUri.startsWith('mongodb+srv://');
        const client = new MongoClient(mongoUri, {
          serverSelectionTimeoutMS: 15000,
          connectTimeoutMS: 15000,
          ...(isSrv ? { tls: true, tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true } : {}),
        });
        await client.connect();
        mongoCollection = client.db('friendnix').collection('appdb');

        const doc = await mongoCollection.findOne({ _id: 'main' });
        if (doc) {
          const { _id, ...data } = doc;
          dbCache = data;
          // Ensure required top-level keys always exist (migration guard)
          if (!dbCache.users)    dbCache.users    = {};
          if (!dbCache.messages) dbCache.messages = {};
          if (!dbCache.groups)   dbCache.groups   = {};
          if (!dbCache.userLog)  dbCache.userLog  = [];
          if (!dbCache.pendingActions) dbCache.pendingActions = [];
          if (!dbCache.flags)    dbCache.flags    = [];
          // Migrate existing users: ensure all required fields are present
          let mongoMigrated = false;
          Object.values(dbCache.users).forEach((user) => {
            if (user.friendPoints === undefined || user.friendPoints === null) { user.friendPoints = 10; mongoMigrated = true; }
            if (!user.unlockedItems) { user.unlockedItems = []; mongoMigrated = true; }
            if (!user.completedMilestones) { user.completedMilestones = ['starter']; mongoMigrated = true; }
            if (user.messageCount === undefined || user.messageCount === null) { user.messageCount = 0; mongoMigrated = true; }
            if (!user.contacts) { user.contacts = []; mongoMigrated = true; }
            if (!user.pendingRequests) { user.pendingRequests = []; mongoMigrated = true; }
            if (!user.incomingRequests) { user.incomingRequests = []; mongoMigrated = true; }
          });
          if (mongoMigrated) {
            mongoCollection.replaceOne({ _id: 'main' }, { _id: 'main', ...dbCache }, { upsert: true })
              .catch((err) => console.error('MongoDB migration write error:', err.message));
            console.log('✅  Migrated MongoDB users with missing fields.');
          }
          console.log('✅ Loaded DB from MongoDB');
        } else {
          // First run — seed from the committed db.json so existing accounts carry over
          dbCache = fs.existsSync(FILE_DB_PATH)
            ? JSON.parse(fs.readFileSync(FILE_DB_PATH, 'utf8'))
            : { users: {}, messages: {}, groups: {} };
          await mongoCollection.insertOne({ _id: 'main', ...dbCache });
          console.log('✅ Seeded MongoDB from db.json');
        }

        // Reset all users to offline — no sockets are connected yet after a restart
        Object.values(dbCache.users || {}).forEach((u) => { u.status = 'offline'; });

        // Keep MongoDB alive — reconnect on socket errors
        client.on('error', (err) => {
          console.error('MongoDB client error:', err.message);
        });

        dbInitialized = true;
        console.log(`✅ DB ready (MongoDB via ${label})`);
        return;
      } catch (err) {
        console.error(`[${label}] MongoDB connection attempt ${attempt}/3 failed:`, err.message);
        // Auth errors (bad credentials) are permanent — retrying won't help
        const isAuthError = err.code === 18 || /bad auth|authentication failed/i.test(err.message);
        if (isAuthError) {
          console.error(`[${label}] Authentication error — skipping retries. Fix: update MONGO_URL / MONGODB_URI password in Railway.`);
          break; // skip remaining retries for this URI
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    // This URI exhausted all retries — try the next one (if any)
    console.warn(`⚠️  ${label} failed all 3 attempts.${mongoUris.length > 1 ? ' Trying next URI...' : ''}`);
    mongoCollection = null;
  }

  if (mongoUris.length > 0) {
    // Every configured URI failed — fall back to file-based storage so the app stays
    // running instead of crash-looping. Data stored in db.json may reset on redeploy
    // but this keeps the service alive while you fix the credentials.
    console.error('⚠️  WARNING: All MongoDB URIs failed. Falling back to file-based storage.');
    console.error('   ALL DATA WILL RESET ON EVERY REDEPLOY until MongoDB is fixed!');
    console.error('   Common fixes:');
    console.error('     1. In MongoDB Atlas → Network Access → add 0.0.0.0/0 (allow all IPs)');
    console.error('     2. Verify MONGODB_URI / MONGO_URL password is correct in Railway/Render');
    console.error('     3. Check that your Atlas cluster is not paused/terminated');
    // Fall through to file-based DB below
  }

  // ── PostgreSQL (Railway Postgres plugin sets DATABASE_URL automatically) ──────
  const pgUrl = process.env.DATABASE_URL;
  if (pgUrl) {
    try {
      const { Pool } = require('pg');
      pgPool = new Pool({
        connectionString: pgUrl,
        ssl: pgUrl.includes('railway') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
      });
      // Ensure table exists
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS appdb (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL
        )
      `);
      const result = await pgPool.query(`SELECT data FROM appdb WHERE id = 'main'`);
      if (result.rows.length > 0) {
        dbCache = result.rows[0].data;
        if (!dbCache.users)          dbCache.users          = {};
        if (!dbCache.messages)       dbCache.messages       = {};
        if (!dbCache.groups)         dbCache.groups         = {};
        if (!dbCache.userLog)        dbCache.userLog        = [];
        if (!dbCache.pendingActions) dbCache.pendingActions = [];
        if (!dbCache.flags)          dbCache.flags          = [];
        // Migrate users
        Object.values(dbCache.users).forEach((user) => {
          if (user.friendPoints == null)         user.friendPoints         = 10;
          if (!user.unlockedItems)               user.unlockedItems        = [];
          if (!user.completedMilestones)         user.completedMilestones  = ['starter'];
          if (user.messageCount == null)         user.messageCount         = 0;
          if (!user.contacts)                    user.contacts             = [];
          if (!user.pendingRequests)             user.pendingRequests      = [];
          if (!user.incomingRequests)            user.incomingRequests     = [];
        });
        console.log('✅ Loaded DB from PostgreSQL');
      } else {
        // First run — seed from committed db.json
        dbCache = fs.existsSync(FILE_DB_PATH)
          ? JSON.parse(fs.readFileSync(FILE_DB_PATH, 'utf8'))
          : { users: {}, messages: {}, groups: {} };
        await pgPool.query(
          `INSERT INTO appdb (id, data) VALUES ('main', $1::jsonb) ON CONFLICT (id) DO NOTHING`,
          [JSON.stringify(dbCache)]
        );
        console.log('✅ Seeded PostgreSQL from db.json');
      }
      Object.values(dbCache.users || {}).forEach((u) => { u.status = 'offline'; });
      dbInitialized = true;
      console.log('✅ DB ready (PostgreSQL)');
      return;
    } catch (err) {
      console.error('PostgreSQL connection failed:', err.message);
      pgPool = null;
      // Fall through to file-based DB
    }
  }

  // No MongoDB URIs configured — warn if on a cloud host
  if (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER) {
    console.warn('⚠️  Running on a cloud host WITHOUT MongoDB or PostgreSQL. Data stored in db.json may reset on redeploy.');
    console.warn('   Fix: Add a Postgres or MongoDB plugin in your Railway/Render dashboard.');
  }
  if (process.env.DATA_DIR) {
    console.log(`📂  Using persistent DATA_DIR: ${process.env.DATA_DIR}`);
  }

  // File-based fallback (local dev)
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE_DB_PATH)) {
    // Try to restore from the backup before creating a blank database
    if (fs.existsSync(FILE_DB_BACKUP_PATH)) {
      try {
        const backupData = fs.readFileSync(FILE_DB_BACKUP_PATH, 'utf8');
        JSON.parse(backupData); // validate
        fs.writeFileSync(FILE_DB_PATH, backupData);
        console.warn('⚠️  db.json was missing — restored from db.backup.json!');
      } catch {
        fs.writeFileSync(FILE_DB_PATH, JSON.stringify({ users: {}, messages: {}, groups: {} }, null, 2));
      }
    } else {
      fs.writeFileSync(FILE_DB_PATH, JSON.stringify({ users: {}, messages: {}, groups: {} }, null, 2));
    }
  }
  let rawDB;
  try {
    rawDB = fs.readFileSync(FILE_DB_PATH, 'utf8');
    dbCache = JSON.parse(rawDB);
  } catch {
    // Main file corrupt — attempt recovery from backup
    console.error('❌ db.json is corrupt. Attempting recovery from db.backup.json...');
    if (fs.existsSync(FILE_DB_BACKUP_PATH)) {
      try {
        dbCache = JSON.parse(fs.readFileSync(FILE_DB_BACKUP_PATH, 'utf8'));
        fs.writeFileSync(FILE_DB_PATH, JSON.stringify(dbCache, null, 2));
        console.warn('✅ Recovered db.json from backup!');
      } catch {
        console.error('❌ Backup also corrupt. Starting with empty DB.');
        dbCache = { users: {}, messages: {}, groups: {} };
        fs.writeFileSync(FILE_DB_PATH, JSON.stringify(dbCache, null, 2));
      }
    } else {
      console.error('❌ No backup found. Starting with empty DB.');
      dbCache = { users: {}, messages: {}, groups: {} };
      fs.writeFileSync(FILE_DB_PATH, JSON.stringify(dbCache, null, 2));
    }
  }
  // Ensure required top-level keys always exist
  if (!dbCache.users)    dbCache.users    = {};
  if (!dbCache.messages) dbCache.messages = {};
  if (!dbCache.groups)   dbCache.groups   = {};
  if (!dbCache.userLog)  dbCache.userLog  = []; // permanent registry of every account
  if (!dbCache.pendingActions) dbCache.pendingActions = []; // admin actions awaiting FriendNix approval
  if (!dbCache.flags)    dbCache.flags    = []; // flagged messages awaiting review

  // Migrate existing users: ensure all required fields are present
  let migrated = false;
  Object.values(dbCache.users).forEach((user) => {
    if (user.friendPoints === undefined || user.friendPoints === null) {
      user.friendPoints = 10; // grant same starting points as new users
      migrated = true;
    }
    if (!user.unlockedItems) {
      user.unlockedItems = [];
      migrated = true;
    }
    if (!user.completedMilestones) {
      user.completedMilestones = ['starter'];
      migrated = true;
    }
    if (user.messageCount === undefined || user.messageCount === null) {
      user.messageCount = 0;
      migrated = true;
    }
  });
  if (migrated) {
    writeDB(dbCache);
    console.log('✅  Migrated existing users with missing fields.');
  }

  // Reset all users to offline — no sockets are connected yet after a restart
  Object.values(dbCache.users).forEach((u) => { u.status = 'offline'; });

  dbInitialized = true;
  console.log('✅ DB ready');
}

// =================== FRIEND POINTS ===================
const SHOP_ITEMS = [
  // --- Themes ---
  { id: 'theme_midnight', category: 'theme', name: 'Midnight Dark', emoji: '🌙', description: 'Deep dark purple night theme', cost: 50 },
  { id: 'theme_rosegold',  category: 'theme', name: 'Rose Gold',    emoji: '🌹', description: 'Elegant rose-gold gradient',    cost: 75 },
  { id: 'theme_neon',      category: 'theme', name: 'Cyber',   emoji: '⚡', description: 'Vibrant neon cyan & purple',    cost: 100 },
  { id: 'theme_arctic',    category: 'theme', name: 'Arctic',   emoji: '❄️', description: 'Cool icy blue tones',           cost: 60 },
  { id: 'theme_cherry',    category: 'theme', name: 'Cherry Blossom', emoji: '🌸', description: 'Soft pink sakura theme',      cost: 80 },
  { id: 'theme_ocean',     category: 'theme', name: 'Deep Ocean',   emoji: '🌊', description: 'Rich deep-sea blue tones',      cost: 70 },
  { id: 'theme_lava',      category: 'theme', name: 'Lava',    emoji: '🌋', description: 'Fiery orange & red theme',      cost: 90 },
  { id: 'theme_amoled',    category: 'theme', name: 'Dark',  emoji: '⬛', description: 'True OLED black — ultra-soothing dark mode', cost: 10 },
  { id: 'theme_galaxy',    category: 'theme', name: 'Galaxy',        emoji: '🌌', description: 'Deep-space nebula theme — stars, purple & cosmic glow', cost: 130 },
  // --- Emoji Reaction Packs ---
  { id: 'reactions_party',  category: 'reactions', name: 'Party Pack',  emoji: '🎉', description: '🎉 🎊 🥳 🎁 🎈 🎆', cost: 30 },
  { id: 'reactions_nature', category: 'reactions', name: 'Nature Pack', emoji: '🌸', description: '🌸 🌺 🌻 🍀 🌈 ⭐', cost: 30 },
  { id: 'reactions_food',   category: 'reactions', name: 'Food Pack',   emoji: '🍕', description: '🍕 🍦 🎂 🍩 🍪 🌮', cost: 25 },
  { id: 'reactions_sports', category: 'reactions', name: 'Sports Pack', emoji: '⚽', description: '⚽ 🏀 🎾 🏆 🥊 🎯', cost: 25 },
  { id: 'reactions_space',  category: 'reactions', name: 'Space Pack',  emoji: '🚀', description: '🚀 🌙 ⭐ 🪐 👾 🌌', cost: 35 },
  // --- Group Backgrounds ---
  { id: 'bg_galaxy',   category: 'background', name: 'Galaxy',       emoji: '🌌', description: 'Deep-space gradient background', cost: 40 },
  { id: 'bg_sunset',   category: 'background', name: 'Sunset Waves', emoji: '🌅', description: 'Warm sunset wave background',     cost: 40 },
  { id: 'bg_forest',   category: 'background', name: 'Forest Path',  emoji: '🌲', description: 'Lush forest green background',    cost: 40 },
  { id: 'bg_neon',     category: 'background', name: 'Neon Grid',    emoji: '🕹️', description: 'Cyberpunk neon grid background',  cost: 50 },
  { id: 'bg_candy',    category: 'background', name: 'Candy Land',   emoji: '🍭', description: 'Sweet pastel candy background',   cost: 45 },
  { id: 'bg_aurora',   category: 'background', name: 'Aurora',       emoji: '🌠', description: 'Northern lights background',      cost: 55 },
  { id: 'bg_ocean',    category: 'background', name: 'Ocean Depths', emoji: '🌊', description: 'Deep underwater blue background', cost: 45 },
  // --- Badges ---
  { id: 'badge_early',    category: 'badge', name: 'Early Adopter',   emoji: '🚀', description: 'OG member badge shown on profile', cost: 20 },
  { id: 'badge_social',   category: 'badge', name: 'Social Butterfly',emoji: '🦋', description: 'For the most connected users',    cost: 50 },
  { id: 'badge_chatter',  category: 'badge', name: 'Chatterbox',      emoji: '💬', description: 'For the most talkative users',    cost: 75 },
  { id: 'badge_gamer',    category: 'badge', name: 'Gamer',           emoji: '🎮', description: 'For avid game players',           cost: 40 },
  { id: 'badge_star',     category: 'badge', name: 'Superstar',       emoji: '⭐', description: 'Stand out with a star badge',     cost: 60 },
  { id: 'badge_cool',     category: 'badge', name: 'Cool Kid',        emoji: '😎', description: 'The coolest badge around',        cost: 35 },
  // --- Video Call Backgrounds ---
  { id: 'call_bg_space',  category: 'call_bg', name: 'Space Station',  emoji: '🚀', description: 'Deep space background for your calls', cost: 60 },
  { id: 'call_bg_beach',  category: 'call_bg', name: 'Tropical Beach', emoji: '🏖️', description: 'Chill beach vibes behind you',          cost: 50 },
  { id: 'call_bg_city',   category: 'call_bg', name: 'City Skyline',   emoji: '🌃', description: 'Gorgeous night city backdrop',          cost: 55 },
  { id: 'call_bg_studio', category: 'call_bg', name: 'Neon Studio',    emoji: '💜', description: 'Professional neon studio look',         cost: 65 },
  { id: 'call_bg_cabin',  category: 'call_bg', name: 'Cozy Cabin',     emoji: '🏠', description: 'Warm fireplace cabin background',       cost: 45 },
  { id: 'call_bg_jungle', category: 'call_bg', name: 'Jungle',         emoji: '🌴', description: 'Lush tropical jungle setting',          cost: 50 },
  // --- Call Frames ---
  { id: 'call_frame_gold',    category: 'call_frame', name: 'Gold Frame',    emoji: '✨', description: 'Shiny gold border around your cam', cost: 40 },
  { id: 'call_frame_rainbow', category: 'call_frame', name: 'Rainbow Frame', emoji: '🌈', description: 'Animated rainbow border',           cost: 55 },
  { id: 'call_frame_fire',    category: 'call_frame', name: 'Fire Frame',    emoji: '🔥', description: 'Burning fire border effect',        cost: 50 },
  { id: 'call_frame_ice',     category: 'call_frame', name: 'Ice Frame',     emoji: '❄️', description: 'Frozen crystal ice border',         cost: 45 },
  { id: 'call_frame_floral',  category: 'call_frame', name: 'Floral Frame',  emoji: '🌸', description: 'Pretty flower petal border',        cost: 40 },
];

// Milestones that award points; each has a unique id stored in completedMilestones so it fires once
const POINT_MILESTONES = [
  { id: 'first_friend',       points: 5,  label: '+5 Friend Points for adding your first friend! 🎉' },
  { id: 'first_message',      points: 5,  label: '+5 Friend Points for sending your first message! 💬' },
  { id: 'set_avatar',         points: 10, label: '+10 Friend Points for setting a profile picture! 📸' },
  { id: 'create_group',       points: 5,  label: '+5 Friend Points for creating a group! 👥' },
];

// Award N points for a repeatable action (like adding each new friend, or every 500 msgs)
function awardPoints(db, userId, amount, milestoneId) {
  const user = db.users[userId];
  if (!user) return false;
  if (!user.friendPoints) user.friendPoints = 0;
  if (!user.completedMilestones) user.completedMilestones = [];
  if (!user.unlockedItems) user.unlockedItems = [];
  if (!user.messageCount) user.messageCount = 0;

  // One-shot milestones
  if (milestoneId) {
    if (user.completedMilestones.includes(milestoneId)) return false;
    user.completedMilestones.push(milestoneId);
  }
  user.friendPoints += amount;
  return true;
}

// =================== HELPERS ===================

// Mint a refreshed JWT that includes avatar, friendPoints, and unlockedItems so
// this state survives server restarts even without MongoDB.
function mintToken(user, db) {
  // Build compact contact snapshots so contacts survive a DB wipe via JWT restoration.
  // Only emoji/short avatars are included to keep token size reasonable.
  const contactSnapshots = db
    ? (user.contacts || [])
        .map((id) => {
          const c = db.users?.[id];
          if (!c) return null;
          return {
            i: id,
            n: c.username,
            ...(c.avatar && c.avatar.length <= 10 ? { a: c.avatar } : {}),
            s: c.secretId || '',
          };
        })
        .filter(Boolean)
    : undefined;
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      secretId: user.secretId,
      createdAt: user.createdAt,
      ph: user.password,
      av: user.avatar && user.avatar.length <= 10 ? user.avatar : undefined,
      fp: user.friendPoints || 0,
      ui: user.unlockedItems || [],
      ct: user.contacts || [],
      cs: contactSnapshots,
      ia: (user.isAdmin || isSuperAdmin(user.username)) ? true : undefined,
      im: user.isModerator ? true : undefined,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function generateSecretId(db) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '0123456789';
  let id;
  do {
    let l = '', d = '';
    for (let i = 0; i < 4; i++) {
      l += letters[Math.floor(Math.random() * letters.length)];
      d += digits[Math.floor(Math.random() * digits.length)];
    }
    id = `FC-${l}-${d}`;
  } while (Object.values(db.users).some((u) => u.secretId === id));
  return id;
}

const AVATARS = ['🐱','🐶','🐼','🦊','🐸','🦁','🐯','🐻','🐨','🐙','🦋','🐬','🦄','🐧','🦜','🐢','🦩','🦔','🐿️','🦘'];

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const db = readDB();

  // ── JWT path (new tokens) ──────────────────────────────────────────────────
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;

    // If the server restarted and wiped the DB, auto-restore the user from the
    // info baked into their JWT so they are never logged out.
    if (!db.users[req.userId]) {
      db.users[req.userId] = {
        id: decoded.sub,
        secretId: decoded.secretId || '',
        username: decoded.username || 'User',
        avatar: decoded.av || decoded.avatar || '🐱',
        // ph in token = original bcrypt hash, allows login from other devices after restore
        password: decoded.ph || '',
        status: 'online',
        contacts: decoded.ct || [],
        pendingRequests: [],
        incomingRequests: [],
        createdAt: decoded.createdAt || new Date().toISOString(),
        friendPoints: isPrivilegedUser(decoded.username) ? Number.MAX_SAFE_INTEGER : (decoded.fp ?? 10),
        messageCount: 0,
        unlockedItems: decoded.ui || [],
        completedMilestones: ['starter'],
        _restored: true,
      };
      // Also ensure this user appears in the permanent log
      if (!db.userLog) db.userLog = [];
      if (!db.userLog.find((e) => e.id === decoded.sub)) {
        db.userLog.push({
          id: decoded.sub,
          username: decoded.username || 'User',
          avatar: decoded.avatar || '🐱',
          secretId: decoded.secretId || '',
          createdAt: decoded.createdAt || new Date().toISOString(),
        });
      }
      // Restore contact skeletons from compact snapshots baked into the JWT.
      // This makes the contacts list work immediately after a server wipe,
      // even before the contact users have logged back in themselves.
      if (Array.isArray(decoded.cs)) {
        decoded.cs.forEach(({ i: cId, n: username, a: avatar, s: secretId }) => {
          if (!cId || !username) return;
          if (!db.users[cId]) {
            db.users[cId] = {
              id: cId,
              secretId: secretId || '',
              username,
              avatar: avatar || '🐱',
              password: '',
              status: 'offline',
              contacts: [],
              pendingRequests: [],
              incomingRequests: [],
              createdAt: new Date().toISOString(),
              friendPoints: 0,
              messageCount: 0,
              unlockedItems: [],
              completedMilestones: ['starter'],
              _restored: true,
            };
          }
        });
      }
      writeDB(db);
    } else {
      // Ensure all required fields exist on existing users (migration guard)
      const u = db.users[req.userId];
      let changed = false;
      if (u.friendPoints === undefined || u.friendPoints === null) { u.friendPoints = 10; changed = true; }
      // Always keep privileged accounts at unlimited points
      if (isPrivilegedUser(u.username) && u.friendPoints !== Number.MAX_SAFE_INTEGER) {
        u.friendPoints = Number.MAX_SAFE_INTEGER; changed = true;
      }
      if (!u.unlockedItems) { u.unlockedItems = []; changed = true; }
      if (!u.completedMilestones) { u.completedMilestones = ['starter']; changed = true; }
      if (u.messageCount === undefined || u.messageCount === null) { u.messageCount = 0; changed = true; }
      if (!u.contacts) { u.contacts = []; changed = true; }
      if (!u.pendingRequests) { u.pendingRequests = []; changed = true; }
      if (!u.incomingRequests) { u.incomingRequests = []; changed = true; }
      // NOTE: We intentionally do NOT restore contacts from the JWT for existing users.
      // Doing so would silently re-add contacts that were intentionally unfriended, because
      // the other party's old JWT still contains the removed contact in its `ct` claim.
      // Contact restoration from JWT only happens when the user record is completely absent
      // from the DB (the !db.users[req.userId] branch above), which covers true DB-wipe restores.
      //
      // EXCEPTION: skeleton records created by restoreFromLog() have _restored:true and
      // empty contacts. When the real user logs in and their record is a skeleton, it is
      // safe — and necessary — to restore their contacts from the JWT so their friend list
      // is not permanently wiped just because someone looked them up while they were offline.
      if (u._restored && Array.isArray(decoded.ct) && decoded.ct.length > 0) {
        u.contacts = decoded.ct;
        delete u._restored;
        changed = true;
      }
      // Restore purchases — additive merge: any item in the JWT that isn't in the DB is added back.
      // This guarantees purchases survive git resets, redeployments, and DB wipes.
      if (Array.isArray(decoded.ui) && decoded.ui.length > 0) {
        const missingItems = decoded.ui.filter((id) => !(u.unlockedItems || []).includes(id));
        if (missingItems.length > 0) {
          u.unlockedItems = [...(u.unlockedItems || []), ...missingItems];
          changed = true;
        }
      }
      // Restore friendPoints from JWT if DB shows fewer — handles partial write failures
      if (!isPrivilegedUser(u.username) && typeof decoded.fp === 'number' && decoded.fp > (u.friendPoints || 0)) {
        u.friendPoints = decoded.fp;
        changed = true;
      }
      if (changed) writeDB(db);
    }

    req.db = readDB(); // re-read after possible write
    // Block banned users from using any authenticated endpoint
    if (req.db.users[req.userId]?.banned) {
      return res.status(403).json({ error: 'This account has been banned.' });
    }
    next();
    return;
  } catch (_) {
    // Not a valid JWT — fall through to legacy plain-UUID token check
  }

  // ── Legacy path (plain userId tokens from before JWT was added) ───────────
  if (!db.users[token]) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = token;
  req.db = db;
  if (req.db.users[req.userId]?.banned) {
    return res.status(403).json({ error: 'This account has been banned.' });
  }
  next();
}

function sanitize(str) {
  return String(str).trim().slice(0, 2000);
}

// ── Content moderation ──────────────────────────────────────────────────────
const BAD_WORDS = [
  'nigger','nigga','faggot','retard','chink','spic','kike','wetback','gook','tranny',
  'cunt','fuck','shit','bitch','ass','dick','cock','pussy','whore','slut',
  'kill yourself','kys','i will kill','i want to kill',
];
function containsBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some((w) => lower.includes(w));
}
function flagMessage(db, senderId, senderName, senderAvatar, content, chatId, messageId) {
  if (!db.flags) db.flags = [];
  db.flags.push({
    id: uuidv4(),
    userId: senderId,
    username: senderName,
    avatar: senderAvatar,
    content,
    chatId,
    messageId,
    timestamp: new Date().toISOString(),
    dismissed: false,
  });
}

// =================== AUTH ROUTES ===================
app.post('/api/register', async (req, res) => {
  if (!dbInitialized) return res.status(503).json({ error: 'Server is starting up, please retry in a moment.' });
  try {
    const username = sanitize(req.body.username || '');
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const db = readDB();
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Also block usernames that were previously used (changed away from) by other accounts
    const allLoggedNames = (db.userLog || []).flatMap((e) =>
      [e.username, ...(e.previousUsernames || [])]
    ).map((n) => n.toLowerCase());
    if (allLoggedNames.includes(username.toLowerCase())) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const secretId = generateSecretId(db);
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];

    const createdAt = new Date().toISOString();
    db.users[userId] = {
      id: userId,
      secretId,
      username,
      password: hashed,
      avatar,
      status: 'offline',
      contacts: [],
      pendingRequests: [],
      incomingRequests: [],
      createdAt,
      friendPoints: isPrivilegedUser(username) ? Number.MAX_SAFE_INTEGER : 10,
      messageCount: 0,
      unlockedItems: [],
      completedMilestones: ['starter'],
      ...(isSuperAdmin(username) ? { isAdmin: true } : {}),
    };

    // Permanent log — survives DB wipes, never loses entries
    if (!db.userLog) db.userLog = [];
    if (!db.userLog.find((e) => e.id === userId)) {
      db.userLog.push({ id: userId, username, avatar, secretId, createdAt });
    }

    await writeDBNow(db);

    // Notify admin panel in real time
    io.to('admin').emit('user_registered', { id: userId, username, avatar, secretId, createdAt });

    const { password: _, ...safe } = db.users[userId];
    const token = mintToken(db.users[userId], db);
    res.json({ user: safe, token });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!dbInitialized) return res.status(503).json({ error: 'Server is starting up, please retry in a moment.' });
  try {
    const username = sanitize(req.body.username || '');
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const db = readDB();
    const user = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (user.banned) {
      return res.status(403).json({ error: 'This account has been banned.' });
    }

    // Grant infinite friend points to privileged accounts on every login
    if (isPrivilegedUser(user.username)) {
      user.friendPoints = Number.MAX_SAFE_INTEGER;
    }
    // Ensure super-admins always have isAdmin flag set in DB
    if (isSuperAdmin(user.username) && !user.isAdmin) {
      user.isAdmin = true;
    }
    if (isPrivilegedUser(user.username) || isSuperAdmin(user.username)) {
      await writeDBNow(db);
    }

    // Ensure user is in the permanent log (backfill for accounts created before log existed)
    if (!db.userLog) db.userLog = [];
    if (!db.userLog.find((e) => e.id === user.id)) {
      db.userLog.push({ id: user.id, username: user.username, avatar: user.avatar, secretId: user.secretId, createdAt: user.createdAt });
      await writeDBNow(db);
    }

    const { password: _, ...safe } = user;
    const token = mintToken(user, db);
    res.json({ user: safe, token });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  const { password: _, ...safe } = req.db.users[req.userId];
  res.json(safe);
});

// =================== WEB PUSH ROUTES ===================

// Return the VAPID public key so the frontend can subscribe
app.get('/api/push/vapid-key', (req, res) => {
  const db = readDB();
  if (!webpush || !db.vapidKeys) return res.json({ publicKey: null });
  res.json({ publicKey: db.vapidKeys.publicKey });
});

// Save a push subscription for the authenticated user
app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'Push not available' });
  const { endpoint, keys, expirationTime } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Invalid subscription' });

  const db = req.db;
  if (!db.pushSubscriptions) db.pushSubscriptions = {};
  if (!db.pushSubscriptions[req.userId]) db.pushSubscriptions[req.userId] = [];

  // Deduplicate by endpoint
  db.pushSubscriptions[req.userId] = db.pushSubscriptions[req.userId].filter(
    (s) => s.endpoint !== endpoint
  );
  db.pushSubscriptions[req.userId].push({ endpoint, keys, expirationTime: expirationTime || null });

  writeDB(db);
  res.json({ ok: true });
});

// Remove a push subscription (on logout)
app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body;
  const db = req.db;
  if (db.pushSubscriptions && db.pushSubscriptions[req.userId]) {
    db.pushSubscriptions[req.userId] = db.pushSubscriptions[req.userId].filter(
      (s) => s.endpoint !== endpoint
    );
    writeDB(db);
  }
  res.json({ ok: true });
});

// Helper: send a Web Push notification to all subscriptions of a user (fire-and-forget)
function sendPushToUser(db, userId, payload) {
  if (!webpush) return;
  const subs = (db.pushSubscriptions || {})[userId];
  if (!subs || subs.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  const deadEndpoints = [];

  subs.forEach((sub) => {
    webpush
      .sendNotification(sub, payloadStr)
      .catch((err) => {
        // 410 Gone / 404 = subscription expired — remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          deadEndpoints.push(sub.endpoint);
        }
      })
      .finally(() => {
        if (deadEndpoints.length) {
          db.pushSubscriptions[userId] = (db.pushSubscriptions[userId] || []).filter(
            (s) => !deadEndpoints.includes(s.endpoint)
          );
          writeDB(db);
        }
      });
  });
}

app.get('/api/users/search', authMiddleware, (req, res) => {
  const query = sanitize((req.query.q || '').toString()).toLowerCase().trim();
  if (!query || query.length < 2) return res.json({ users: [] });

  const db = req.db;
  const me = db.users[req.userId];

  const results = Object.values(db.users)
    .filter((u) =>
      u.id !== me.id &&
      u.username &&
      u.username.toLowerCase().includes(query)
    )
    .slice(0, 10)
    .map((u) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar || null,
      isContact: me.contacts.includes(u.id),
      requestSent: me.pendingRequests.includes(u.id),
      requestReceived: me.incomingRequests.includes(u.id),
    }));

  res.json({ users: results });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const db = req.db;
  if (db.users[req.userId]) {
    db.users[req.userId].status = 'offline';
    writeDB(db);
    // Notify contacts
    db.users[req.userId].contacts.forEach((cId) => {
      io.to(cId).emit('contact_online', { userId: req.userId, status: 'offline' });
    });
  }
  res.json({ ok: true });
});

// =================== USERNAME CHANGE ===================
app.patch('/api/me/username', authMiddleware, async (req, res) => {
  try {
    const newUsername = sanitize(req.body.username || '');
    if (!newUsername) return res.status(400).json({ error: 'Username required' });
    if (newUsername.length < 2 || newUsername.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });

    const db = req.db;
    const user = db.users[req.userId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.username.toLowerCase() === newUsername.toLowerCase()) {
      return res.status(400).json({ error: 'That is already your username' });
    }

    const isPrivileged = isSuperAdmin(user.username) || user.isAdmin;

    const CHANGE_COST = 1000;
    if (!isPrivileged && (user.friendPoints || 0) < CHANGE_COST) {
      return res.status(400).json({ error: `You need ${CHANGE_COST.toLocaleString()} Friend Points to change your username` });
    }

    // Block any username currently in use by another account
    if (Object.values(db.users).some((u) => u.id !== req.userId && u.username.toLowerCase() === newUsername.toLowerCase())) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Block any username ever used by OTHER users (admins can reclaim their own previous names)
    if (!isPrivileged) {
      const allLoggedNames = (db.userLog || [])
        .filter((e) => e.id !== req.userId)
        .flatMap((e) => [e.username, ...(e.previousUsernames || [])])
        .map((n) => n.toLowerCase());
      if (allLoggedNames.includes(newUsername.toLowerCase())) {
        return res.status(400).json({ error: 'Username already taken' });
      }
    }

    // Deduct cost (admins change for free)
    if (!isPrivileged) user.friendPoints -= CHANGE_COST;

    // Update userLog: preserve old username in previousUsernames
    if (!db.userLog) db.userLog = [];
    const logEntry = db.userLog.find((e) => e.id === req.userId);
    if (logEntry) {
      if (!logEntry.previousUsernames) logEntry.previousUsernames = [];
      logEntry.previousUsernames.push(logEntry.username);
      logEntry.username = newUsername;
    }

    // Update live user record
    user.username = newUsername;
    await writeDBNow(db);

    const newToken = mintToken(user, db);
    io.to(req.userId).emit('token_refresh', { token: newToken });
    io.to(req.userId).emit('points_updated', { friendPoints: user.friendPoints });

    const { password: _, ...safe } = user;
    res.json({ ...safe, token: newToken });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// =================== AVATAR ROUTES ===================
app.patch('/api/me/avatar', authMiddleware, async (req, res) => {
  const { avatar } = req.body;
  if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'Avatar required' });
  const isEmoji = avatar.length <= 10;
  const isDataUrl = avatar.startsWith('data:image/');
  if (!isEmoji && !isDataUrl) return res.status(400).json({ error: 'Invalid avatar format' });
  if (avatar.length > 1_000_000) return res.status(400).json({ error: 'Image too large (max ~750KB)' });

  const db = req.db;
  db.users[req.userId].avatar = avatar;
  // Friend Points: one-time reward for setting a real profile picture
  let avatarPointsAwarded = false;
  try {
    avatarPointsAwarded = isDataUrl ? awardPoints(db, req.userId, 10, 'set_avatar') : false;
  } catch (e) { console.error('awardPoints error (avatar):', e.message); }
  await writeDBNow(db);
  const { password: _, ...safe } = db.users[req.userId];
  try {
    if (avatarPointsAwarded) {
      io.to(req.userId).emit('points_updated', { friendPoints: db.users[req.userId].friendPoints, reason: '+10 for setting a profile picture! 📸' });
    }
    // Notify all contacts so their UI updates the avatar in real time
    const contactIds = db.users[req.userId]?.contacts || [];
    const avatarBroadcast = { userId: req.userId, avatar: db.users[req.userId].avatar };
    contactIds.forEach((cId) => io.to(cId).emit('contact_avatar_updated', avatarBroadcast));
  } catch (e) { console.error('socket emit error (avatar points):', e.message); }
  // Re-issue JWT with updated avatar (emoji) / points so state survives server restarts
  const newToken = mintToken(db.users[req.userId], db);
  res.json({ ...safe, token: newToken });
});

// =================== GROUP HELPERS ===================
// Returns group with members resolved to { id, username, avatar, status } objects
function populateGroup(db, group) {
  return {
    ...group,
    members: (group.members || []).map((mId) => {
      const u = db.users[mId];
      return u ? { id: u.id, username: u.username, avatar: u.avatar, status: u.status } : null;
    }).filter(Boolean),
  };
}

app.patch('/api/groups/:groupId/avatar', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { avatar } = req.body;
  if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'Avatar required' });
  const db = req.db;
  const group = db.groups[groupId];
  if (!group || !group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  if (avatar.length > 1_000_000) return res.status(400).json({ error: 'Image too large' });
  db.groups[groupId].avatar = avatar;
  writeDB(db);
  io.to(groupId).emit('group_updated', populateGroup(db, db.groups[groupId]));
  res.json(db.groups[groupId]);
});

// Add member to group
app.post('/api/groups/:groupId/members', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { userId, username } = req.body;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  // Resolve by userId first, then fall back to username lookup
  let resolvedId = userId;
  if (!resolvedId || !db.users[resolvedId]) {
    if (username) {
      const found = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
      resolvedId = found?.id;
    }
  }
  if (!resolvedId || !db.users[resolvedId]) return res.status(404).json({ error: 'User not found' });
  if (group.members.includes(resolvedId)) return res.status(400).json({ error: 'Already in group' });
  db.groups[groupId].members.push(resolvedId);
  writeDB(db);
  io.to(resolvedId).emit('added_to_group', db.groups[groupId]);
  io.to(groupId).emit('group_updated', populateGroup(db, db.groups[groupId]));
  res.json(db.groups[groupId]);
});

// Remove member from group (self-leave or creator removing)
app.delete('/api/groups/:groupId/members/:memberId', authMiddleware, (req, res) => {
  const { groupId, memberId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  const isSelf = memberId === req.userId;
  const isCreator = group.createdBy === req.userId;
  if (!isSelf && !isCreator) return res.status(403).json({ error: 'Only the creator can remove members' });
  db.groups[groupId].members = db.groups[groupId].members.filter((m) => m !== memberId);
  writeDB(db);
  io.to(groupId).emit('group_updated', populateGroup(db, db.groups[groupId]));
  // Notify the removed member directly so they can leave the chat view
  io.to(memberId).emit('removed_from_group', { groupId });
  res.json({ success: true });
});

// Delete group (creator only)
app.delete('/api/groups/:groupId', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.createdBy !== req.userId) return res.status(403).json({ error: 'Only the creator can delete the group' });
  const members = group.members;
  delete db.groups[groupId];
  delete db.messages[groupId];
  writeDB(db);
  members.forEach((mId) => io.to(mId).emit('group_deleted', { groupId }));
  res.json({ success: true });
});

// =================== EXTENDED GROUP CUSTOMIZATION ===================

// Update group settings (name, description, theme, rules, announcementMode, slowModeSeconds)
app.patch('/api/groups/:groupId', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  const isCreatorOrAdmin = group.createdBy === req.userId || (group.admins || []).includes(req.userId);
  if (!isCreatorOrAdmin) return res.status(403).json({ error: 'Only admins can update group settings' });

  if (req.body.name !== undefined) {
    const name = sanitize(String(req.body.name || ''));
    if (!name || name.length > 30) return res.status(400).json({ error: 'Name required (max 30 chars)' });
    db.groups[groupId].name = name;
  }
  if (req.body.description !== undefined) {
    db.groups[groupId].description = sanitize(String(req.body.description || '')).slice(0, 200);
  }
  if (req.body.theme !== undefined) {
    const theme = String(req.body.theme || '');
    if (/^#[0-9a-fA-F]{6}$/.test(theme)) db.groups[groupId].theme = theme;
  }
  if (req.body.rules !== undefined) {
    db.groups[groupId].rules = sanitize(String(req.body.rules || '')).slice(0, 500);
  }
  if (req.body.announcementMode !== undefined) {
    db.groups[groupId].announcementMode = !!req.body.announcementMode;
  }
  if (req.body.slowModeSeconds !== undefined) {
    const secs = parseInt(req.body.slowModeSeconds, 10);
    if (!isNaN(secs) && secs >= 0 && secs <= 3600) db.groups[groupId].slowModeSeconds = secs;
  }
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Promote member to admin (creator only)
app.post('/api/groups/:groupId/admins', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.createdBy !== req.userId) return res.status(403).json({ error: 'Only the creator can promote admins' });
  if (!userId || !group.members.includes(userId)) return res.status(400).json({ error: 'User is not a member' });
  if (!db.groups[groupId].admins) db.groups[groupId].admins = [];
  if (db.groups[groupId].admins.includes(userId)) return res.status(400).json({ error: 'Already an admin' });
  db.groups[groupId].admins.push(userId);
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Demote admin (creator only)
app.delete('/api/groups/:groupId/admins/:memberId', authMiddleware, (req, res) => {
  const { groupId, memberId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.createdBy !== req.userId) return res.status(403).json({ error: 'Only the creator can demote admins' });
  db.groups[groupId].admins = (db.groups[groupId].admins || []).filter((a) => a !== memberId);
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Transfer ownership (creator only)
app.patch('/api/groups/:groupId/transfer', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.createdBy !== req.userId) return res.status(403).json({ error: 'Only the creator can transfer ownership' });
  if (!userId || !group.members.includes(userId)) return res.status(400).json({ error: 'User is not a member' });
  db.groups[groupId].createdBy = userId;
  if (!db.groups[groupId].admins) db.groups[groupId].admins = [];
  if (!db.groups[groupId].admins.includes(req.userId)) db.groups[groupId].admins.push(req.userId);
  db.groups[groupId].admins = db.groups[groupId].admins.filter((a) => a !== userId);
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Generate/reset invite code (admin only)
app.post('/api/groups/:groupId/invite', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const isAdmin = (group.admins || []).includes(req.userId);
  if (group.createdBy !== req.userId && !isAdmin) return res.status(403).json({ error: 'Only admins can generate invite codes' });
  const code = uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase();
  db.groups[groupId].inviteCode = code;
  writeDB(db);
  res.json({ inviteCode: code });
});

// Join group via invite code
app.post('/api/groups/join/:inviteCode', authMiddleware, (req, res) => {
  const { inviteCode } = req.params;
  const db = req.db;
  const group = Object.values(db.groups).find((g) => g.inviteCode === inviteCode);
  if (!group) return res.status(404).json({ error: 'Invalid or expired invite code' });
  if (group.members.includes(req.userId)) return res.status(400).json({ error: 'Already in this group' });
  db.groups[group.id].members.push(req.userId);
  writeDB(db);
  io.to(req.userId).emit('added_to_group', db.groups[group.id]);
  const populated = populateGroup(db, db.groups[group.id]);
  io.to(group.id).emit('group_updated', populated);
  res.json(db.groups[group.id]);
});

// Set member nickname in group
app.patch('/api/groups/:groupId/nicknames', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { memberId, nickname } = req.body;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  const isCreator = group.createdBy === req.userId;
  const isAdmin = (group.admins || []).includes(req.userId);
  const isSelf = memberId === req.userId;
  if (!isCreator && !isAdmin && !isSelf) return res.status(403).json({ error: 'You can only change your own nickname' });
  if (!memberId || !group.members.includes(memberId)) return res.status(400).json({ error: 'Member not found' });
  const nick = sanitize(String(nickname || '')).slice(0, 30);
  if (!db.groups[groupId].memberNicknames) db.groups[groupId].memberNicknames = {};
  if (nick) {
    db.groups[groupId].memberNicknames[memberId] = nick;
  } else {
    delete db.groups[groupId].memberNicknames[memberId];
  }
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Pin / unpin a message in group
app.patch('/api/groups/:groupId/pin', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const { messageId } = req.body;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const isCreator = group.createdBy === req.userId;
  const isAdmin = (group.admins || []).includes(req.userId);
  if (!isCreator && !isAdmin) return res.status(403).json({ error: 'Only admins can pin messages' });
  if (!messageId) {
    db.groups[groupId].pinnedMessage = null;
  } else {
    const msgs = db.messages[groupId] || [];
    const msg = msgs.find((m) => m.id === messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    db.groups[groupId].pinnedMessage = { id: msg.id, content: msg.content, type: msg.type, senderName: msg.senderName };
  }
  writeDB(db);
  const populated = populateGroup(db, db.groups[groupId]);
  io.to(groupId).emit('group_updated', populated);
  res.json(db.groups[groupId]);
});

// Edit a message (sender only, text messages only, within 15 minutes)
app.put('/api/messages/:chatId/:messageId', authMiddleware, (req, res) => {
  const { chatId, messageId } = req.params;
  const db = req.db;
  const msgs = db.messages[chatId];
  if (!msgs) return res.status(404).json({ error: 'Chat not found' });
  const idx = msgs.findIndex((m) => m.id === messageId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found' });
  const msg = msgs[idx];
  if (msg.senderId !== req.userId) return res.status(403).json({ error: 'Can only edit your own messages' });
  if (msg.type !== 'text') return res.status(400).json({ error: 'Can only edit text messages' });
  // 15-minute edit window
  const msgAge = Date.now() - new Date(msg.timestamp).getTime();
  if (msgAge > 15 * 60 * 1000) return res.status(400).json({ error: 'Edit window expired (15 min limit)' });
  const newContent = sanitize(req.body.content || '');
  if (!newContent) return res.status(400).json({ error: 'Message cannot be empty' });
  if (newContent.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  msg.content = newContent;
  msg.edited = true;
  msg.editedAt = new Date().toISOString();
  writeDB(db);
  io.to(chatId).emit('message_edited', { chatId, messageId, content: newContent, editedAt: msg.editedAt });
  res.json({ success: true, message: msg });
});

// Unsend (delete) a message
app.delete('/api/messages/:chatId/:messageId', authMiddleware, (req, res) => {
  const { chatId, messageId } = req.params;
  const db = req.db;
  const msgs = db.messages[chatId];
  if (!msgs) return res.status(404).json({ error: 'Chat not found' });
  const idx = msgs.findIndex((m) => m.id === messageId);
  if (idx === -1) return res.status(404).json({ error: 'Message not found' });
  if (msgs[idx].senderId !== req.userId) return res.status(403).json({ error: 'Can only unsend your own messages' });
  db.messages[chatId].splice(idx, 1);
  writeDB(db);
  io.to(chatId).emit('message_deleted', { chatId, messageId });
  res.json({ success: true });
});

// =================== CONTACT ROUTES ===================
// Helper: restore a user from userLog into db.users so they can be found by secretId / userId
function restoreFromLog(db, matchFn) {
  const logEntry = (db.userLog || []).find(matchFn);
  if (!logEntry || db.users[logEntry.id]) return null;
  db.users[logEntry.id] = {
    id: logEntry.id,
    secretId: logEntry.secretId || '',
    username: logEntry.username,
    avatar: logEntry.avatar || '🐱',
    password: '',
    status: 'offline',
    contacts: [],
    pendingRequests: [],
    incomingRequests: [],
    createdAt: logEntry.createdAt || new Date().toISOString(),
    friendPoints: 0,
    messageCount: 0,
    unlockedItems: [],
    completedMilestones: ['starter'],
    _restored: true,
  };
  writeDB(db);
  return db.users[logEntry.id];
}

app.post('/api/contacts/request', authMiddleware, async (req, res) => {
  const secretId = sanitize(req.body.secretId || '').toUpperCase();
  if (!secretId) return res.status(400).json({ error: 'Secret ID required' });

  const db = req.db;
  const me = db.users[req.userId];

  // Search live users first, then fall back to userLog (handles post-restart restores)
  let target = Object.values(db.users).find((u) => u.secretId === secretId);
  if (!target) target = restoreFromLog(db, (e) => e.secretId === secretId);

  if (!target) return res.status(404).json({ error: 'No user found with that ID' });
  if (target.id === me.id) return res.status(400).json({ error: "You can't add yourself!" });
  if (me.contacts.includes(target.id)) return res.status(400).json({ error: 'Already a contact' });
  if (me.pendingRequests.includes(target.id)) return res.status(400).json({ error: 'Request already sent' });
  if (me.incomingRequests.includes(target.id)) return res.status(400).json({ error: 'This user already sent you a request – check your requests!' });

  db.users[me.id].pendingRequests.push(target.id);
  db.users[target.id].incomingRequests.push(me.id);
  await writeDBNow(db);

  io.to(target.id).emit('contact_request', {
    from: { id: me.id, username: me.username, avatar: me.avatar, secretId: me.secretId },
  });
  sendPushToUser(db, target.id, {
    title: '👋 New friend request',
    body: `${me.username} wants to connect with you`,
    icon: '/Logo.png',
    tag: `friend-request-${me.id}`,
    url: '/contacts',
  });

  res.json({ success: true, message: `Friend request sent to ${target.username}!` });
});

app.post('/api/contacts/request-by-id', authMiddleware, async (req, res) => {
  const targetId = sanitize(req.body.userId || '');
  if (!targetId) return res.status(400).json({ error: 'userId required' });

  const db = req.db;
  const me = db.users[req.userId];
  const target = db.users[targetId];

  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === me.id) return res.status(400).json({ error: "You can't add yourself!" });
  if (me.contacts.includes(target.id)) return res.status(400).json({ error: 'Already a contact' });
  if (me.pendingRequests.includes(target.id)) return res.status(400).json({ error: 'Request already sent' });
  if (me.incomingRequests.includes(target.id)) return res.status(400).json({ error: 'This user already sent you a request – check your requests!' });

  db.users[me.id].pendingRequests.push(target.id);
  db.users[target.id].incomingRequests.push(me.id);
  await writeDBNow(db);

  io.to(target.id).emit('contact_request', {
    from: { id: me.id, username: me.username, avatar: me.avatar, secretId: me.secretId },
  });
  sendPushToUser(db, target.id, {
    title: '👋 New friend request',
    body: `${me.username} wants to connect with you`,
    icon: '/Logo.png',
    tag: `friend-request-${me.id}`,
    url: '/contacts',
  });

  res.json({ success: true, message: `Friend request sent to ${target.username}!` });
});

app.post('/api/contacts/accept', authMiddleware, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = req.db;
  const me = db.users[req.userId];
  if (!me.incomingRequests.includes(userId)) return res.status(400).json({ error: 'No request from this user' });

  db.users[me.id].contacts.push(userId);
  db.users[userId].contacts.push(me.id);
  db.users[me.id].incomingRequests = db.users[me.id].incomingRequests.filter((id) => id !== userId);
  db.users[userId].pendingRequests = db.users[userId].pendingRequests.filter((id) => id !== me.id);

  // Friend Points: +5 per new friend for both parties
  try {
    const isFirstFriendMe = db.users[me.id].contacts.length === 1;
    const isFirstFriendThem = db.users[userId].contacts.length === 1;
    awardPoints(db, me.id, 5, isFirstFriendMe ? 'first_friend' : null);
    awardPoints(db, userId, 5, isFirstFriendThem ? 'first_friend' : null);
  } catch (e) { console.error('awardPoints error (friend accept):', e.message); }

  await writeDBNow(db);

  const chatId = [me.id, userId].sort().join('_');
  // Emit updated token to requester so their contacts survive a server restart
  io.to(userId).emit('contact_accepted', {
    by: { id: me.id, username: me.username, avatar: me.avatar },
    chatId,
    token: mintToken(db.users[userId], db),
  });
  // Notify both parties of their updated points
  try {
    io.to(me.id).emit('points_updated', { friendPoints: db.users[me.id].friendPoints, reason: '+5 for new friend! 🤝' });
    io.to(userId).emit('points_updated', { friendPoints: db.users[userId].friendPoints, reason: '+5 for new friend! 🤝' });
  } catch (e) { console.error('socket emit error (friend points):', e.message); }

  // Return fresh token to accepter with updated contacts baked in
  res.json({ success: true, chatId, token: mintToken(db.users[me.id], db) });
});

app.post('/api/contacts/reject', authMiddleware, async (req, res) => {
  const { userId } = req.body;
  const db = req.db;
  const me = db.users[req.userId];
  db.users[me.id].incomingRequests = db.users[me.id].incomingRequests.filter((id) => id !== userId);
  db.users[userId].pendingRequests = db.users[userId].pendingRequests.filter((id) => id !== me.id);
  await writeDBNow(db);
  res.json({ success: true });
});

app.delete('/api/contacts/:userId', authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const db = req.db;
  const me = db.users[req.userId];
  if (!me) return res.status(404).json({ error: 'User not found' });
  db.users[me.id].contacts = (db.users[me.id].contacts || []).filter((id) => id !== userId);
  if (db.users[userId]) {
    db.users[userId].contacts = (db.users[userId].contacts || []).filter((id) => id !== me.id);
    // Emit updated token to the other party too
    io.to(userId).emit('token_refresh', { token: mintToken(db.users[userId], db) });
  }
  await writeDBNow(db);
  // Return fresh token with the removed contact no longer in ct claim
  res.json({ success: true, token: mintToken(db.users[me.id], db) });
});

app.get('/api/contacts', authMiddleware, (req, res) => {
  const db = req.db;
  const me = db.users[req.userId];

  const contacts = me.contacts
    .map((id) => {
      // Restore from userLog if user isn't in the live DB (e.g. after server restart)
      let u = db.users[id];
      if (!u) u = restoreFromLog(db, (e) => e.id === id);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar, status: u.status, secretId: u.secretId, isTester: u.isTester || false };
    })
    .filter(Boolean);

  const incoming = me.incomingRequests
    .map((id) => {
      let u = db.users[id];
      if (!u) u = restoreFromLog(db, (e) => e.id === id);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar };
    })
    .filter(Boolean);

  const pending = me.pendingRequests
    .map((id) => {
      let u = db.users[id];
      if (!u) u = restoreFromLog(db, (e) => e.id === id);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar };
    })
    .filter(Boolean);

  res.json({ contacts, incoming, pending });
});

// =================== MESSAGE ROUTES ===================
app.get('/api/messages/:chatId', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  // Validate user is part of this chat
  const db = req.db;
  const me = db.users[req.userId];
  const isGroup = chatId.startsWith('group_');
  if (isGroup) {
    const group = db.groups[chatId];
    if (!group || !group.members.includes(req.userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  } else {
    const ids = chatId.split('_');
    if (!ids.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  }
  res.json(db.messages[chatId] || []);
});

app.post('/api/messages/:chatId', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  const rawType = req.body.type;
  const type = rawType === 'emoji' ? 'emoji' : rawType === 'image' ? 'image' : rawType === 'game_invite' ? 'game_invite' : 'text';

  let content;
  if (type === 'image') {
    content = req.body.content || '';
    if (!content.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });
    if (content.length > 3_000_000) return res.status(400).json({ error: 'Image too large' });
  } else if (type === 'game_invite') {
    // content is JSON string: { gameId, gameType, hostName }
    content = req.body.content || '';
    if (!content) return res.status(400).json({ error: 'Game invite content required' });
    if (content.length > 500) return res.status(400).json({ error: 'Content too long' });
  } else {
    content = sanitize(req.body.content || '');
    if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
    if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  }

  const db = req.db;
  const sender = db.users[req.userId];

  // Group-specific sending restrictions
  if (chatId.startsWith('group_')) {
    const group = db.groups[chatId];
    if (group) {
      const isGroupPrivileged = group.createdBy === req.userId || (group.admins || []).includes(req.userId);
      if (group.announcementMode && !isGroupPrivileged) {
        return res.status(403).json({ error: '📢 Announcement mode is on. Only admins can send messages.' });
      }
      if ((group.slowModeSeconds || 0) > 0 && !isGroupPrivileged) {
        const msgs = db.messages[chatId] || [];
        const lastMsg = [...msgs].reverse().find((m) => m.senderId === req.userId);
        if (lastMsg) {
          const elapsed = (Date.now() - new Date(lastMsg.timestamp).getTime()) / 1000;
          if (elapsed < group.slowModeSeconds) {
            const wait = Math.ceil(group.slowModeSeconds - elapsed);
            return res.status(429).json({ error: `⏱️ Slow mode: wait ${wait}s before sending again.` });
          }
        }
      }
    }
  }

  // Validate replyTo if provided
  const replyToRaw = req.body.replyTo;
  let replyTo;
  if (replyToRaw && typeof replyToRaw === 'object' && replyToRaw.id) {
    replyTo = {
      id: String(replyToRaw.id),
      senderName: sanitize(String(replyToRaw.senderName || '')),
      content: String(replyToRaw.content || '').slice(0, 200),
      type: ['text','emoji','image'].includes(replyToRaw.type) ? replyToRaw.type : 'text',
    };
  }

  const message = {
    id: uuidv4(),
    chatId,
    senderId: req.userId,
    senderName: sender.username,
    senderAvatar: sender.avatar,
    senderIsTester: sender.isTester || false,
    content,
    type,
    ...(replyTo ? { replyTo } : {}),
    timestamp: new Date().toISOString(),
  };

  if (!db.messages[chatId]) db.messages[chatId] = [];
  db.messages[chatId].push(message);

  // ---- Friend Points for messaging ----
  const pointsEarned = [];
  try {
    if (!db.users[req.userId].messageCount) db.users[req.userId].messageCount = 0;
    db.users[req.userId].messageCount += 1;
    const msgCount = db.users[req.userId].messageCount;
    if (awardPoints(db, req.userId, 5, 'first_message')) pointsEarned.push('+5 for your first message! 💬');
    if (msgCount % 500 === 0) {
      awardPoints(db, req.userId, 20, null);
      pointsEarned.push('+20 for sending 500 messages! 🏆');
    }
  } catch (e) { console.error('awardPoints error (message):', e.message); }

  writeDB(db);

  // ---- Content moderation ----
  if (type === 'text' && containsBadWord(content)) {
    flagMessage(db, req.userId, sender.username, sender.avatar, content, chatId, message.id);
    writeDB(db);
    // Notify all online admins in real time
    Object.values(db.users).forEach((u) => {
      if (u.isAdmin || isSuperAdmin(u.username)) {
        io.to(u.id).emit('new_flag', db.flags[db.flags.length - 1]);
      }
    });
  }

  io.to(chatId).emit('new_message', message);
  // Notify recipients in their personal rooms (for notifications when not in the chat)
  try {
    const notif = {
      chatId,
      senderId: req.userId,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      content: type === 'image' ? '📷 Photo' : content,
      type,
    };
    if (chatId.startsWith('group_')) {
      const group = db.groups[chatId];
      if (group) {
        group.members.forEach((mId) => {
          if (mId !== req.userId) {
            io.to(mId).emit('message_notification', notif);
            // Web Push — fires even when the recipient's window is closed
            sendPushToUser(db, mId, {
              title: notif.senderName,
              body: notif.content,
              icon: '/Logo.png',
              tag: `chat-${chatId}`,
              url: `/chat/${chatId}`,
            });
          }
        });
      }
    } else {
      const recipientId = chatId.split('_').find((id) => id !== req.userId);
      if (recipientId) {
        io.to(recipientId).emit('message_notification', notif);
        sendPushToUser(db, recipientId, {
          title: notif.senderName,
          body: notif.content,
          icon: '/Logo.png',
          tag: `chat-${chatId}`,
          url: `/chat/${chatId}`,
        });
      }
    }
  } catch (e) { console.error('socket emit error (message_notification):', e.message); }
  try {
    if (pointsEarned.length) {
      io.to(req.userId).emit('points_updated', { friendPoints: db.users[req.userId].friendPoints, reason: pointsEarned[0] });
    }
  } catch (e) { console.error('socket emit error (message points):', e.message); }
  res.json(message);
});

// =================== GROUP ROUTES ===================
app.post('/api/groups', authMiddleware, (req, res) => {
  const name = sanitize(req.body.name || '');
  const avatar = req.body.avatar || '👥';
  const members = Array.isArray(req.body.members) ? req.body.members : [];

  if (!name) return res.status(400).json({ error: 'Group name required' });
  if (name.length > 30) return res.status(400).json({ error: 'Group name too long' });

  const db = req.db;
  const groupId = `group_${uuidv4()}`;
  const allMembers = [...new Set([req.userId, ...members])];

  db.groups[groupId] = {
    id: groupId,
    name,
    avatar,
    members: allMembers,
    createdBy: req.userId,
    createdAt: new Date().toISOString(),
  };

  // Friend Points: +5 for creating your first group
  try {
    const isFirstGroup = !Object.values(db.groups).some(
      (g) => g.createdBy === req.userId && g.id !== groupId
    );
    if (isFirstGroup) {
      const awarded = awardPoints(db, req.userId, 5, 'create_group');
      if (awarded) io.to(req.userId).emit('points_updated', { friendPoints: db.users[req.userId].friendPoints, reason: '+5 for creating a group! 👥' });
    }
  } catch (e) { console.error('awardPoints error (group):', e.message); }

  writeDB(db);

  allMembers.forEach((memberId) => {
    if (memberId !== req.userId) {
      io.to(memberId).emit('added_to_group', db.groups[groupId]);
    }
  });

  res.json(db.groups[groupId]);
});

app.get('/api/groups', authMiddleware, (req, res) => {
  const db = req.db;
  const groups = Object.values(db.groups).filter((g) => g.members.includes(req.userId));
  res.json(groups);
});

// Get a single group with populated members
app.get('/api/groups/:groupId', authMiddleware, (req, res) => {
  const { groupId } = req.params;
  const db = req.db;
  const group = db.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.userId)) return res.status(403).json({ error: 'Access denied' });
  res.json(populateGroup(db, group));
});

// =================== FRIEND POINTS / SHOP ROUTES ===================

// ── Daily Reward ─────────────────────────────────────────────────────────────
// Points awarded per streak day (1-indexed, day 7 also gets a weekly item)
const DAILY_REWARD_POINTS = [10, 15, 20, 25, 30, 40, 50];

// Weekly reward items awarded on every 7th streak day (cycles through the list).
// If the user already owns the item they get WEEKLY_FALLBACK_POINTS instead.
const WEEKLY_REWARD_ITEMS = [
  { itemId: 'bg_galaxy',  name: 'Galaxy Background',  emoji: '🌌' },
  { itemId: 'bg_sunset',  name: 'Sunset Background',  emoji: '🌅' },
  { itemId: 'bg_forest',  name: 'Forest Background',  emoji: '🌲' },
  { itemId: 'bg_neon',    name: 'Neon Background',    emoji: '💡' },
  { itemId: 'bg_candy',   name: 'Candy Background',   emoji: '🍬' },
  { itemId: 'bg_aurora',  name: 'Aurora Background',  emoji: '🌠' },
  { itemId: 'bg_ocean',   name: 'Ocean Background',   emoji: '🌊' },
];
const WEEKLY_FALLBACK_POINTS = 100; // given when user already owns the weekly item

// Returns today's date string in UTC (YYYY-MM-DD) so the reward resets at midnight UTC.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/daily-reward — returns current streak status without claiming
app.get('/api/daily-reward', authMiddleware, (req, res) => {
  const user = req.db.users[req.userId];
  const today = todayUTC();
  const last  = user.lastDailyReward || null;
  const streak = user.dailyStreak || 0;

  const alreadyClaimed = last === today;
  const dayIndex = alreadyClaimed ? ((streak - 1 + 7) % 7) : (streak % 7); // 0-based index into DAILY_REWARD_POINTS
  const nextPoints = DAILY_REWARD_POINTS[dayIndex] ?? 10;

  // Which week completion reward comes next (or this cycle)?
  const weeklyRewardIndex = Math.floor(streak / 7) % WEEKLY_REWARD_ITEMS.length;
  const weeklyPreview = WEEKLY_REWARD_ITEMS[weeklyRewardIndex];

  res.json({
    canClaim: !alreadyClaimed,
    streak,
    currentDay: alreadyClaimed ? (((streak - 1) % 7) + 1) : ((streak % 7) + 1), // 1-7 display day
    nextPoints,
    isWeekCompletion: !alreadyClaimed && (streak % 7 === 6), // next claim completes a week
    weeklyPreview: { ...weeklyPreview, alreadyOwned: (user.unlockedItems || []).includes(weeklyPreview.itemId) },
  });
});

// POST /api/daily-reward — claim today's reward
app.post('/api/daily-reward', authMiddleware, async (req, res) => {
  try {
    const db = req.db;
    const user = db.users[req.userId];
    const today = todayUTC();

    // Already claimed today?
    if (user.lastDailyReward === today) {
      return res.status(400).json({ error: 'Already claimed today' });
    }

    // Determine streak: continues only if last claim was yesterday
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const prevStreak = user.dailyStreak || 0;
    const newStreak  = (user.lastDailyReward === yesterday) ? prevStreak + 1 : 1;

    // Points for this day (day in the 7-day cycle, 0-based index)
    const dayIndex   = (newStreak - 1) % 7; // 0 = day 1 … 6 = day 7
    const pointsEarned = DAILY_REWARD_POINTS[dayIndex] ?? 10;

    if (!user.friendPoints) user.friendPoints = 0;
    if (!user.unlockedItems) user.unlockedItems = [];
    user.friendPoints  += pointsEarned;
    user.dailyStreak    = newStreak;
    user.lastDailyReward = today;

    // Week completion? (every 7th streak day: streak 7, 14, 21, …)
    let weeklyReward = null;
    if (newStreak % 7 === 0) {
      const weekNumber = Math.floor((newStreak - 1) / 7); // 0, 1, 2 …
      const rewardMeta = WEEKLY_REWARD_ITEMS[weekNumber % WEEKLY_REWARD_ITEMS.length];
      const alreadyOwned = user.unlockedItems.includes(rewardMeta.itemId);
      if (alreadyOwned) {
        // Give fallback points instead
        user.friendPoints += WEEKLY_FALLBACK_POINTS;
        weeklyReward = { ...rewardMeta, alreadyOwned: true, fallbackPoints: WEEKLY_FALLBACK_POINTS };
      } else {
        user.unlockedItems.push(rewardMeta.itemId);
        weeklyReward = { ...rewardMeta, alreadyOwned: false };
      }
    }

    await writeDBNow(db);

    // Push updated points/items to any open sockets for this user
    const reason = weeklyReward
      ? `🎁 Week complete! +${pointsEarned} FP${weeklyReward.alreadyOwned ? ` +${WEEKLY_FALLBACK_POINTS} FP (item owned)` : ''}`
      : `📅 Day ${((newStreak - 1) % 7) + 1} login reward! +${pointsEarned} FP`;
    io.to(req.userId).emit('points_updated', {
      friendPoints:  user.friendPoints,
      unlockedItems: user.unlockedItems,
      reason,
    });

    // Re-mint token so the new points/items survive a server restart
    const newToken = mintToken(user, db);
    res.json({
      ok: true,
      streak: newStreak,
      pointsEarned,
      weeklyReward,
      friendPoints: user.friendPoints,
      unlockedItems: user.unlockedItems,
      token: newToken,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/shop', authMiddleware, (req, res) => {
  const user = req.db.users[req.userId];
  res.json({
    friendPoints: user.friendPoints || 0,
    messageCount: user.messageCount || 0,
    unlockedItems: user.unlockedItems || [],
    items: SHOP_ITEMS,
  });
});

app.post('/api/shop/buy', authMiddleware, async (req, res) => {
  const { itemId } = req.body;
  if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId required' });
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const db = req.db;
  const user = db.users[req.userId];
  if (!user.friendPoints) user.friendPoints = 0;
  if (!user.unlockedItems) user.unlockedItems = [];

  const isPrivileged = isPrivilegedUser(user.username);

  if (user.unlockedItems.includes(itemId)) return res.status(400).json({ error: 'Already owned' });
  if (!isPrivileged && user.friendPoints < item.cost) return res.status(400).json({ error: 'Not enough Friend Points' });

  if (!isPrivileged) user.friendPoints -= item.cost;
  user.unlockedItems.push(itemId);
  await writeDBNow(db);

  // Emit updated unlockedItems via socket so other open tabs stay in sync
  io.to(req.userId).emit('points_updated', { friendPoints: user.friendPoints, unlockedItems: user.unlockedItems });

  const { password: _, ...safe } = user;
  // Re-issue JWT with updated points/unlocked so purchases survive server restarts
  const newToken = mintToken(user, db);
  res.json({ ok: true, friendPoints: user.friendPoints, unlockedItems: user.unlockedItems, user: safe, token: newToken });
});

app.post('/api/shop/transfer-points', authMiddleware, async (req, res) => {
  try {
    const toUsername = sanitize(req.body.toUsername || '');
    const parsedAmount = parseInt(req.body.amount);
    if (!toUsername || !parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: 'toUsername and a positive amount are required' });
    }

    const db = req.db;
    const sender = db.users[req.userId];
    const recipient = Object.values(db.users).find((u) => u.username.toLowerCase() === toUsername.toLowerCase());

    if (!recipient) return res.status(404).json({ error: 'User not found' });

    const isSuperSender = isSuperAdmin(sender.username);

    if (!isSuperSender && (sender.friendPoints || 0) < parsedAmount) {
      return res.status(400).json({ error: 'Not enough Friend Points' });
    }

    if (!isSuperSender) sender.friendPoints -= parsedAmount;
    if (!recipient.friendPoints) recipient.friendPoints = 0;
    recipient.friendPoints += parsedAmount;
    await writeDBNow(db);

    io.to(recipient.id).emit('points_updated', {
      friendPoints: recipient.friendPoints,
      reason: `+${parsedAmount} Friend Points gifted by ${sender.username}! 🎁`,
    });
    if (!isSuperSender) {
      io.to(req.userId).emit('points_updated', {
        friendPoints: sender.friendPoints,
        reason: `Sent ${parsedAmount} pts to ${recipient.username}`,
      });
    }

    res.json({ ok: true, friendPoints: sender.friendPoints });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// =================== ADMIN ROUTES ===================
function adminMiddleware(req, res, next) {
  const sender = req.db.users[req.userId];
  if (!sender || (!isSuperAdmin(sender.username) && !sender.isAdmin)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function moderatorMiddleware(req, res, next) {
  const sender = req.db.users[req.userId];
  if (!sender || (!isSuperAdmin(sender.username) && !sender.isAdmin && !sender.isModerator)) {
    return res.status(403).json({ error: 'Moderator only' });
  }
  next();
}

function superAdminMiddleware(req, res, next) {
  const sender = req.db.users[req.userId];
  if (!sender || !isSuperAdmin(sender.username)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  next();
}

// Get all active (non-dismissed) flags
app.get('/api/admin/flags', authMiddleware, moderatorMiddleware, (req, res) => {
  const db = req.db;
  const flags = (db.flags || []).filter((f) => !f.dismissed);
  res.json(flags);
});

// Dismiss a flag
app.post('/api/admin/flags/:flagId/dismiss', authMiddleware, moderatorMiddleware, (req, res) => {
  const db = req.db;
  if (!db.flags) db.flags = [];
  const flag = db.flags.find((f) => f.id === req.params.flagId);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  flag.dismissed = true;
  writeDB(db);
  res.json({ ok: true });
});

// Get all active (non-dismissed) flags
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const db = req.db;
  // Merge permanent log with live user data so admin always sees every account ever made
  const log = db.userLog || [];
  const result = log.map((entry) => {
    const live = db.users[entry.id];
    if (live) {
      const { password: _, ...safe } = live;
      return safe;
    }
    // User not currently in DB (pre-restore) — show log entry with limited info
    return {
      id: entry.id,
      username: entry.username,
      avatar: entry.avatar,
      secretId: entry.secretId,
      createdAt: entry.createdAt,
      status: 'offline',
      contacts: [],
      friendPoints: 0,
      banned: false,
      _logOnly: true,
    };
  });
  // Also include any live users not yet in the log (edge case)
  Object.values(db.users).forEach((u) => {
    if (!log.find((e) => e.id === u.id)) {
      const { password: _, ...safe } = u;
      result.push(safe);
    }
  });
  res.json(result);
});

app.post('/api/admin/ban/:userId', authMiddleware, moderatorMiddleware, (req, res) => {
  const { userId } = req.params;
  const db = req.db;
  const actor = db.users[req.userId];
  const isModOnly = !isSuperAdmin(actor?.username) && !actor?.isAdmin && actor?.isModerator;
  // Restore log-only users so they can be banned
  if (!db.users[userId]) restoreFromLog(db, (e) => e.id === userId);
  if (!db.users[userId]) return res.status(404).json({ error: 'User not found' });
  if (isSuperAdmin(db.users[userId].username)) {
    return res.status(400).json({ error: 'Cannot ban a super admin' });
  }
  if (db.users[userId].isAdmin && !isSuperAdmin(actor?.username)) {
    return res.status(400).json({ error: 'Only a super admin can ban another admin' });
  }
  // Moderators can only ban users who have an active flag
  if (isModOnly) {
    const hasFlaggedMessage = (db.flags || []).some((f) => !f.dismissed && f.userId === userId);
    if (!hasFlaggedMessage) return res.status(403).json({ error: 'Moderators can only ban users with active flagged messages' });
  }
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'ban',
      targetUserId: userId,
      targetUsername: db.users[userId].username,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: true,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  db.users[userId].banned = true;
  writeDB(db);
  // Force disconnect the banned user
  io.to(userId).emit('account_banned');
  res.json({ ok: true });
});

app.post('/api/admin/unban/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.params;
  const db = req.db;
  const actor = db.users[req.userId];
  // Restore log-only users so they can be unbanned
  if (!db.users[userId]) restoreFromLog(db, (e) => e.id === userId);
  if (!db.users[userId]) return res.status(404).json({ error: 'User not found' });
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'unban',
      targetUserId: userId,
      targetUsername: db.users[userId].username,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: false,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  db.users[userId].banned = false;
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/admin/reset/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.params;
  const db = req.db;
  if (!db.users[userId]) restoreFromLog(db, (e) => e.id === userId);
  if (!db.users[userId]) return res.status(404).json({ error: 'User not found' });
  const actor = req.db.users[req.userId];
  if (isSuperAdmin(db.users[userId].username)) {
    return res.status(400).json({ error: 'Cannot reset a super admin' });
  }
  if (db.users[userId].isAdmin && !isSuperAdmin(actor?.username)) {
    return res.status(400).json({ error: 'Only a super admin can reset another admin' });
  }
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'reset',
      targetUserId: userId,
      targetUsername: db.users[userId].username,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: true,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  const target = db.users[userId];
  // Remove this user from all their contacts' friend lists
  (target.contacts || []).forEach((cId) => {
    if (db.users[cId]) {
      db.users[cId].contacts = (db.users[cId].contacts || []).filter((id) => id !== userId);
      db.users[cId].pendingRequests = (db.users[cId].pendingRequests || []).filter((id) => id !== userId);
      db.users[cId].incomingRequests = (db.users[cId].incomingRequests || []).filter((id) => id !== userId);
      io.to(cId).emit('token_refresh', { token: mintToken(db.users[cId], db) });
    }
  });
  // Reset everything
  target.friendPoints = 10;
  target.unlockedItems = [];
  target.completedMilestones = ['starter'];
  target.contacts = [];
  target.pendingRequests = [];
  target.incomingRequests = [];
  target.messageCount = 0;
  writeDB(db);
  // Force the user's session to be wiped and reload
  io.to(userId).emit('account_reset');
  res.json({ ok: true });
});

app.post('/api/admin/subtract-points/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.params;
  const amount = parseInt(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Positive amount required' });
  const db = req.db;
  const actor = db.users[req.userId];
  if (!db.users[userId]) restoreFromLog(db, (e) => e.id === userId);
  if (!db.users[userId]) return res.status(404).json({ error: 'User not found' });
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'subtract_points',
      targetUserId: userId,
      targetUsername: db.users[userId].username,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: amount,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  const target = db.users[userId];
  target.friendPoints = Math.max(0, (target.friendPoints || 0) - amount);
  writeDB(db);
  io.to(userId).emit('points_updated', {
    friendPoints: target.friendPoints,
    reason: `-${amount} points removed by admin`,
  });
  res.json({ ok: true, friendPoints: target.friendPoints });
});

// Grant tester badge by username
app.post('/api/admin/grant-tester', authMiddleware, adminMiddleware, (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  const db = req.db;
  const actor = db.users[req.userId];
  const target = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'grant_tester',
      targetUserId: target.id,
      targetUsername: target.username,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: !target.isTester,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  target.isTester = !target.isTester; // toggle
  writeDB(db);
  // Notify the user's session in real time
  io.to(target.id).emit('tester_granted', { isTester: target.isTester });
  res.json({ ok: true, isTester: target.isTester, username: target.username });
});

// Force-add two users as contacts (admin only)
app.post('/api/admin/force-add-contact', authMiddleware, adminMiddleware, async (req, res) => {
  const user1 = String(req.body.user1 || '').trim();
  const user2 = String(req.body.user2 || '').trim();
  if (!user1 || !user2) return res.status(400).json({ error: 'Both usernames required' });
  if (user1.toLowerCase() === user2.toLowerCase()) return res.status(400).json({ error: 'Cannot add a user to themselves' });
  const db = req.db;
  const actor = db.users[req.userId];
  const u1 = Object.values(db.users).find((u) => u.username.toLowerCase() === user1.toLowerCase());
  const u2 = Object.values(db.users).find((u) => u.username.toLowerCase() === user2.toLowerCase());
  if (!u1) return res.status(404).json({ error: `User "${user1}" not found` });
  if (!u2) return res.status(404).json({ error: `User "${user2}" not found` });
  // Everyone except FriendNix queues a pending action for approval
  if (!isFriendNix(actor?.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'force_add_contact',
      targetUserId: u1.id,
      targetUsername: `${u1.username} & ${u2.username}`,
      requestedBy: actor.username,
      requestedById: actor.id,
      value: { user1Id: u1.id, user2Id: u2.id, user1Name: u1.username, user2Name: u2.username },
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  if (!u1.contacts.includes(u2.id)) u1.contacts.push(u2.id);
  if (!u2.contacts.includes(u1.id)) u2.contacts.push(u1.id);
  // Clear any pending/incoming requests between them
  u1.pendingRequests  = (u1.pendingRequests  || []).filter((id) => id !== u2.id);
  u1.incomingRequests = (u1.incomingRequests || []).filter((id) => id !== u2.id);
  u2.pendingRequests  = (u2.pendingRequests  || []).filter((id) => id !== u1.id);
  u2.incomingRequests = (u2.incomingRequests || []).filter((id) => id !== u1.id);
  await writeDBNow(db);
  const chatId = [u1.id, u2.id].sort().join('_');
  // Notify both users in real time so their contact list refreshes
  io.to(u1.id).emit('contact_accepted', { by: { id: u2.id, username: u2.username, avatar: u2.avatar }, chatId, token: mintToken(u1, db) });
  io.to(u2.id).emit('contact_accepted', { by: { id: u1.id, username: u1.username, avatar: u1.avatar }, chatId, token: mintToken(u2, db) });
  res.json({ ok: true, message: `${u1.username} and ${u2.username} are now friends` });
});

// Grant moderator status by username
// Super admins apply it directly; regular admins create a pending action for FriendNix approval
app.post('/api/admin/grant-moderator', authMiddleware, adminMiddleware, (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  const db = req.db;
  const sender = db.users[req.userId];
  const target = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isSuperAdmin(target.username)) return res.status(400).json({ error: 'Cannot change role of a super admin' });
  // Only FriendNix applies immediately; everyone else queues for approval
  if (isFriendNix(sender.username)) {
    target.isModerator = !target.isModerator;
    writeDB(db);
    io.to(target.id).emit('token_refresh', { token: mintToken(target, db) });
    return res.json({ ok: true, isModerator: target.isModerator, username: target.username, pending: false });
  }
  // Regular admins: queue a pending action for FriendNix approval
  if (!db.pendingActions) db.pendingActions = [];
  const action = {
    id: uuidv4(),
    type: 'grant_moderator',
    targetUserId: target.id,
    targetUsername: target.username,
    requestedBy: sender.username,
    requestedById: sender.id,
    value: !target.isModerator, // true = grant, false = revoke
    createdAt: new Date().toISOString(),
  };
  db.pendingActions.push(action);
  writeDB(db);
  // Notify FriendNix in real time
  io.emit('pending_action_new', action);
  return res.json({ ok: true, pending: true, message: `Request submitted — awaiting FriendNix approval` });
});

// Give points to a user
// Super admins apply directly; regular admins create a pending action for FriendNix approval
app.post('/api/admin/give-points', authMiddleware, adminMiddleware, (req, res) => {
  const username = String(req.body.username || '').trim();
  const amount = parseInt(req.body.amount);
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Positive amount required' });
  const db = req.db;
  const sender = db.users[req.userId];
  const target = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Only FriendNix and primevanta apply immediately
  if (isFriendNix(sender.username) || sender.username.toLowerCase() === 'primevanta') {
    if (!isPrivilegedUser(target.username)) {
      target.friendPoints = (target.friendPoints || 0) + amount;
    }
    writeDB(db);
    io.to(target.id).emit('points_updated', { friendPoints: target.friendPoints, reason: `+${amount} points granted by ${sender.username}` });
    return res.json({ ok: true, friendPoints: target.friendPoints, pending: false });
  }
  // Regular admins: queue a pending action
  if (!db.pendingActions) db.pendingActions = [];
  const action = {
    id: uuidv4(),
    type: 'give_points',
    targetUserId: target.id,
    targetUsername: target.username,
    requestedBy: sender.username,
    requestedById: sender.id,
    value: amount,
    createdAt: new Date().toISOString(),
  };
  db.pendingActions.push(action);
  writeDB(db);
  io.emit('pending_action_new', action);
  return res.json({ ok: true, pending: true, message: `Request submitted — awaiting FriendNix approval` });
});

// ── Pending Actions (FriendNix approval queue) ──────────────────────────────

// List all pending actions (super admin only)
app.get('/api/admin/pending-actions', authMiddleware, superAdminMiddleware, (req, res) => {
  const db = req.db;
  res.json(db.pendingActions || []);
});

// Approve a pending action (super admin only)
app.post('/api/admin/pending-actions/:actionId/approve', authMiddleware, superAdminMiddleware, (req, res) => {
  const db = req.db;
  if (!db.pendingActions) db.pendingActions = [];
  const idx = db.pendingActions.findIndex((a) => a.id === req.params.actionId);
  if (idx === -1) return res.status(404).json({ error: 'Action not found' });
  const action = db.pendingActions[idx];
  db.pendingActions.splice(idx, 1);

  if (action.type === 'grant_moderator') {
    const target = db.users[action.targetUserId];
    if (target) {
      target.isModerator = action.value;
      io.to(target.id).emit('token_refresh', { token: mintToken(target, db) });
    }
  } else if (action.type === 'give_points') {
    const target = db.users[action.targetUserId];
    if (target && !isPrivilegedUser(target.username)) {
      target.friendPoints = (target.friendPoints || 0) + action.value;
      io.to(target.id).emit('points_updated', { friendPoints: target.friendPoints, reason: `+${action.value} points approved by FriendNix` });
    }
  } else if (action.type === 'ban') {
    if (!db.users[action.targetUserId]) restoreFromLog(db, (e) => e.id === action.targetUserId);
    const target = db.users[action.targetUserId];
    if (target) {
      target.banned = true;
      io.to(target.id).emit('account_banned');
    }
  } else if (action.type === 'unban') {
    const target = db.users[action.targetUserId];
    if (target) {
      target.banned = false;
    }
  } else if (action.type === 'reset') {
    const target = db.users[action.targetUserId];
    if (target) {
      (target.contacts || []).forEach((cId) => {
        if (db.users[cId]) {
          db.users[cId].contacts = (db.users[cId].contacts || []).filter((id) => id !== action.targetUserId);
          db.users[cId].pendingRequests = (db.users[cId].pendingRequests || []).filter((id) => id !== action.targetUserId);
          db.users[cId].incomingRequests = (db.users[cId].incomingRequests || []).filter((id) => id !== action.targetUserId);
          io.to(cId).emit('token_refresh', { token: mintToken(db.users[cId], db) });
        }
      });
      target.friendPoints = 10;
      target.unlockedItems = [];
      target.completedMilestones = ['starter'];
      target.contacts = [];
      target.pendingRequests = [];
      target.incomingRequests = [];
      target.messageCount = 0;
      io.to(target.id).emit('account_reset');
    }
  } else if (action.type === 'subtract_points') {
    const target = db.users[action.targetUserId];
    if (target) {
      target.friendPoints = Math.max(0, (target.friendPoints || 0) - action.value);
      io.to(target.id).emit('points_updated', { friendPoints: target.friendPoints, reason: `-${action.value} points removed (approved by FriendNix)` });
    }
  } else if (action.type === 'grant_tester') {
    const target = db.users[action.targetUserId];
    if (target) {
      target.isTester = action.value;
      io.to(target.id).emit('tester_granted', { isTester: target.isTester });
    }
  } else if (action.type === 'force_add_contact') {
    const { user1Id, user2Id } = action.value;
    const u1 = db.users[user1Id];
    const u2 = db.users[user2Id];
    if (u1 && u2) {
      if (!u1.contacts.includes(u2.id)) u1.contacts.push(u2.id);
      if (!u2.contacts.includes(u1.id)) u2.contacts.push(u1.id);
      u1.pendingRequests  = (u1.pendingRequests  || []).filter((id) => id !== u2.id);
      u1.incomingRequests = (u1.incomingRequests || []).filter((id) => id !== u2.id);
      u2.pendingRequests  = (u2.pendingRequests  || []).filter((id) => id !== u1.id);
      u2.incomingRequests = (u2.incomingRequests || []).filter((id) => id !== u1.id);
      const chatId = [u1.id, u2.id].sort().join('_');
      io.to(u1.id).emit('contact_accepted', { by: { id: u2.id, username: u2.username, avatar: u2.avatar }, chatId, token: mintToken(u1, db) });
      io.to(u2.id).emit('contact_accepted', { by: { id: u1.id, username: u1.username, avatar: u1.avatar }, chatId, token: mintToken(u2, db) });
    }
  } else if (action.type === 'grant_admin') {
    const target = db.users[action.targetUserId];
    if (target && !isSuperAdmin(target.username)) {
      target.isAdmin = action.value;
      io.to(target.id).emit('token_refresh', { token: mintToken(target, db) });
    }
  }

  writeDB(db);
  // Notify requester the action was approved
  io.to(action.requestedById).emit('pending_action_resolved', { id: action.id, status: 'approved', action });
  res.json({ ok: true, action });
});

// Troll a user — sends a fake scary suspension notice, then reveals the joke (super admin only)
app.post('/api/admin/troll/:userId', authMiddleware, superAdminMiddleware, (req, res) => {
  const db = req.db;
  const target = db.users[req.params.userId];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const trollerName = db.users[req.userId]?.username || 'An admin';
  io.to(target.id).emit('admin_troll', { trolledBy: trollerName });
  return res.json({ ok: true });
});

// Reject a pending action (super admin only)
app.post('/api/admin/pending-actions/:actionId/reject', authMiddleware, superAdminMiddleware, (req, res) => {
  const db = req.db;
  if (!db.pendingActions) db.pendingActions = [];
  const idx = db.pendingActions.findIndex((a) => a.id === req.params.actionId);
  if (idx === -1) return res.status(404).json({ error: 'Action not found' });
  const action = db.pendingActions.splice(idx, 1)[0];
  writeDB(db);
  // Notify requester the action was rejected
  io.to(action.requestedById).emit('pending_action_resolved', { id: action.id, status: 'rejected', action });
  res.json({ ok: true, action });
});

// Grant admin panel access by username (super admin only)
app.post('/api/admin/grant-admin', authMiddleware, superAdminMiddleware, (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  const db = req.db;
  const sender = db.users[req.userId];
  const target = Object.values(db.users).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isSuperAdmin(target.username)) return res.status(400).json({ error: 'Already the super admin' });
  // Only FriendNix applies immediately; everyone else queues for approval
  if (!isFriendNix(sender.username)) {
    if (!db.pendingActions) db.pendingActions = [];
    const action = {
      id: uuidv4(),
      type: 'grant_admin',
      targetUserId: target.id,
      targetUsername: target.username,
      requestedBy: sender.username,
      requestedById: sender.id,
      value: !target.isAdmin,
      createdAt: new Date().toISOString(),
    };
    db.pendingActions.push(action);
    writeDB(db);
    io.emit('pending_action_new', action);
    return res.json({ ok: true, pending: true, message: 'Request submitted — awaiting FriendNix approval' });
  }
  target.isAdmin = !target.isAdmin; // toggle
  writeDB(db);
  // Refresh the user's token so their admin state is reflected immediately
  io.to(target.id).emit('token_refresh', { token: mintToken(target, db) });
  res.json({ ok: true, isAdmin: target.isAdmin, username: target.username });
});

// Refresh JWT — re-mints with latest user data (contacts, points, etc.)
app.get('/api/refresh-token', authMiddleware, (req, res) => {
  const user = req.db.users[req.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ token: mintToken(user, req.db) });
});

// =================== CHATS ROUTE ===================
app.get('/api/chats', authMiddleware, (req, res) => {
  const db = req.db;
  const me = db.users[req.userId];
  const chats = [];

  me.contacts.forEach((contactId) => {
    let contact = db.users[contactId];
    if (!contact) contact = restoreFromLog(db, (e) => e.id === contactId);
    if (!contact) return;
    const chatId = [req.userId, contactId].sort().join('_');
    const msgs = db.messages[chatId] || [];
    chats.push({
      id: chatId,
      type: 'dm',
      name: contact.username,
      avatar: contact.avatar,
      contactId,
      lastMessage: msgs[msgs.length - 1] || null,
      status: contact.status,
    });
  });

  Object.values(db.groups)
    .filter((g) => g.members.includes(req.userId))
    .forEach((group) => {
      const msgs = db.messages[group.id] || [];
      chats.push({
        id: group.id,
        type: 'group',
        name: group.name,
        avatar: group.avatar,
        createdBy: group.createdBy,
        members: group.members.map((mId) => {
          const u = db.users[mId];
          return u ? { id: u.id, username: u.username, avatar: u.avatar } : null;
        }).filter(Boolean),
        lastMessage: msgs[msgs.length - 1] || null,
        description: group.description || '',
        theme: group.theme || '',
        rules: group.rules || '',
        admins: group.admins || [],
        announcementMode: group.announcementMode || false,
        slowModeSeconds: group.slowModeSeconds || 0,
        inviteCode: group.inviteCode || '',
        memberNicknames: group.memberNicknames || {},
        pinnedMessage: group.pinnedMessage || null,
      });
    });

  chats.sort((a, b) => {
    const ta = a.lastMessage?.timestamp || a.id;
    const tb = b.lastMessage?.timestamp || b.id;
    return tb > ta ? 1 : -1;
  });

  res.json(chats);
});

// =================== GAME SESSIONS ===================
const gameSessions = {};
const PLAYER_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#F59E0B','#DDA0DD','#F97316','#14B8A6'];
const GAME_WORLD = { w: 800, h: 560 };

// ── Bomb Tag constants ────────────────────────────────────────────────────────
const BOMB_TAG = {
  COUNTDOWN: 10,           // seconds before bomb explodes
  PASS_RADIUS: 40,         // pixel distance to pass bomb
  SPEED_BOOST: 1.4,        // bomb carrier moves faster
  SPEED_PENALTY: 0.7,      // non-carriers move slower when close to bomb
  ARENA_PADDING: 30,
};

function generateCoins(count = 14) {
  const types = ['coin','coin','coin','coin','coin','star','star','gem'];
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    x: 60 + Math.floor(Math.random() * (GAME_WORLD.w - 120)),
    y: 60 + Math.floor(Math.random() * (GAME_WORLD.h - 120)),
    type: types[Math.floor(Math.random() * types.length)],
    collected: false,
  }));
}

const QUIZ_QUESTIONS = [
  // Science & Nature
  { id:'q1',  question:'What is the largest planet in our solar system?', options:['Saturn','Jupiter','Neptune','Uranus'], correct:1, emoji:'🪐' },
  { id:'q2',  question:'How many legs does a spider have?', options:['6','8','10','12'], correct:1, emoji:'🕷️' },
  { id:'q3',  question:'What gas do plants absorb from the air?', options:['Oxygen','Nitrogen','CO2','Hydrogen'], correct:2, emoji:'🌿' },
  { id:'q4',  question:'Which is the fastest land animal?', options:['Lion','Horse','Cheetah','Tiger'], correct:2, emoji:'🐆' },
  { id:'q5',  question:'How many colors are in a rainbow?', options:['5','6','7','8'], correct:2, emoji:'🌈' },
  { id:'q6',  question:'What is the largest mammal on Earth?', options:['Elephant','Blue Whale','Giraffe','Hippo'], correct:1, emoji:'🐋' },
  { id:'q7',  question:'Which element has the symbol O?', options:['Gold','Oxygen','Osmium','Carbon'], correct:1, emoji:'⚗️' },
  { id:'q8',  question:'What is the boiling point of water in Celsius?', options:['90','95','100','110'], correct:2, emoji:'🌡️' },
  { id:'q9',  question:'How many chromosomes do humans have?', options:['23','44','46','48'], correct:2, emoji:'🧬' },
  { id:'q10', question:'What is the fastest bird in the world?', options:['Eagle','Peregrine Falcon','Ostrich','Penguin'], correct:1, emoji:'🦅' },
  // Geography & World
  { id:'q11', question:'What is the capital of France?', options:['Berlin','Madrid','Paris','Rome'], correct:2, emoji:'🗼' },
  { id:'q12', question:'How many continents are on Earth?', options:['5','6','7','8'], correct:2, emoji:'🌍' },
  { id:'q13', question:'Which planet is called the Red Planet?', options:['Venus','Jupiter','Mars','Mercury'], correct:2, emoji:'🔴' },
  { id:'q14', question:'What is the smallest ocean?', options:['Indian','Arctic','Atlantic','Pacific'], correct:1, emoji:'🌊' },
  { id:'q15', question:'Which country invented pizza?', options:['France','Greece','Italy','Spain'], correct:2, emoji:'🍕' },
  { id:'q16', question:'Which planet is closest to the Sun?', options:['Earth','Venus','Mercury','Mars'], correct:2, emoji:'☀️' },
  { id:'q17', question:'What is the capital of Japan?', options:['Beijing','Seoul','Tokyo','Bangkok'], correct:2, emoji:'🗾' },
  { id:'q18', question:'What is the longest river in the world?', options:['Amazon','Congo','Nile','Yangtze'], correct:2, emoji:'🏞️' },
  { id:'q19', question:'Which continent is the largest?', options:['Africa','Americas','Asia','Europe'], correct:2, emoji:'🌏' },
  { id:'q20', question:'What is the currency of Japan?', options:['Yuan','Won','Yen','Baht'], correct:2, emoji:'💴' },
  { id:'q21', question:'Which country has the most natural lakes?', options:['Russia','USA','Canada','Brazil'], correct:2, emoji:'🏔️' },
  { id:'q22', question:'What is the smallest country in the world?', options:['Monaco','Maldives','Vatican City','San Marino'], correct:2, emoji:'🏰' },
  // Math & Logic
  { id:'q23', question:'How many sides does a hexagon have?', options:['5','6','7','8'], correct:1, emoji:'⬡' },
  { id:'q24', question:'What is H2O?', options:['Hydrogen','Salt','Water','Oxygen'], correct:2, emoji:'💧' },
  { id:'q25', question:'How many bones in the adult human body?', options:['196','206','216','226'], correct:1, emoji:'💀' },
  { id:'q26', question:'How many hours are in a day?', options:['12','20','24','48'], correct:2, emoji:'⏰' },
  { id:'q27', question:'What is 8 × 7?', options:['48','54','56','64'], correct:2, emoji:'🔢' },
  { id:'q28', question:'What is the square root of 144?', options:['10','11','12','14'], correct:2, emoji:'📐' },
  { id:'q29', question:'How many degrees in a right angle?', options:['45','60','90','180'], correct:2, emoji:'📏' },
  { id:'q30', question:'How many days in a leap year?', options:['364','365','366','367'], correct:2, emoji:'📅' },
  // General Knowledge & Pop Culture
  { id:'q31', question:'What do bees make?', options:['Silk','Honey','Wax','Oil'], correct:1, emoji:'🐝' },
  { id:'q32', question:'What is the hardest natural substance?', options:['Gold','Iron','Diamond','Quartz'], correct:2, emoji:'💎' },
  { id:'q33', question:'How many strings does a standard guitar have?', options:['4','5','6','7'], correct:2, emoji:'🎸' },
  { id:'q34', question:'What color do you get mixing red and blue?', options:['Green','Orange','Purple','Brown'], correct:2, emoji:'🎨' },
  { id:'q35', question:'How many players are on a soccer team?', options:['9','10','11','12'], correct:2, emoji:'⚽' },
  { id:'q36', question:'Which animal is the symbol of the WWF?', options:['Lion','Giant Panda','Tiger','Elephant'], correct:1, emoji:'🐼' },
  { id:'q37', question:'How many keys does a standard piano have?', options:['76','80','88','92'], correct:2, emoji:'🎹' },
  { id:'q38', question:'What year did World War II end?', options:['1943','1944','1945','1946'], correct:2, emoji:'🕊️' },
  { id:'q39', question:'What is the most spoken language in the world?', options:['English','Spanish','Mandarin','Hindi'], correct:2, emoji:'🗣️' },
  { id:'q40', question:'How many planets are in our solar system?', options:['7','8','9','10'], correct:1, emoji:'🌌' },
  { id:'q41', question:'How many sides does a triangle have?', options:['2','3','4','5'], correct:1, emoji:'🔺' },
  { id:'q42', question:'What is the largest ocean?', options:['Atlantic','Indian','Arctic','Pacific'], correct:3, emoji:'🌊' },
  { id:'q43', question:'Which sport uses a shuttlecock?', options:['Tennis','Badminton','Squash','Volleyball'], correct:1, emoji:'🏸' },
  { id:'q44', question:'How many seconds are in one minute?', options:['30','45','60','100'], correct:2, emoji:'⏱️' },
  { id:'q45', question:'What is the tallest mountain on Earth?', options:['K2','Kangchenjunga','Mount Everest','Lhotse'], correct:2, emoji:'🏔️' },
  { id:'q46', question:'Which gas makes up most of Earth\'s atmosphere?', options:['Oxygen','Carbon Dioxide','Nitrogen','Argon'], correct:2, emoji:'💨' },
  { id:'q47', question:'What is the national animal of Australia?', options:['Koala','Emu','Kangaroo','Platypus'], correct:2, emoji:'🦘' },
  { id:'q48', question:'How many teeth does an adult human have?', options:['28','30','32','34'], correct:2, emoji:'🦷' },
  { id:'q49', question:'Which planet has the most moons?', options:['Jupiter','Saturn','Uranus','Neptune'], correct:1, emoji:'🌙' },
  { id:'q50', question:'What is the chemical symbol for gold?', options:['Go','Gd','Au','Ag'], correct:2, emoji:'🥇' },
];

const WORD_POOL = [
  'rainbow','elephant','keyboard','sunshine','mountain','butterfly','chocolate','umbrella',
  'adventure','freedom','dragon','crystal','thunder','galaxy','forest','wizard','castle',
  'ocean','puzzle','rocket','sparkle','treasure','journey','mystery','legend','shadow',
  'magic','champion','victory','blizzard','feather','lantern','compass','horizon','balloon',
  'pancake','unicorn','dolphin','volcano','tornado','penguin','cactus','phoenix','pumpkin',
];

function pickWord(exclude) {
  const pool = WORD_POOL.filter(w => w !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickQuestion(excludeId) {
  const pool = QUIZ_QUESTIONS.filter(q => q.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Grade-based Trivia question banks ────────────────────────────────────────
const TRIVIA_QUESTIONS = {
  elementary: [
    { id:'te1',  question:'What is 5 + 3?',                             options:['6','7','8','9'],                                      correct:2, emoji:'➕' },
    { id:'te2',  question:'How many legs does a dog have?',             options:['2','4','6','8'],                                      correct:1, emoji:'🐕' },
    { id:'te3',  question:'What color is the sky on a sunny day?',      options:['Red','Blue','Green','Yellow'],                        correct:1, emoji:'🌤️' },
    { id:'te4',  question:'Which animal is the biggest?',               options:['Cat','Mouse','Elephant','Dog'],                       correct:2, emoji:'🐘' },
    { id:'te5',  question:'What is 10 - 4?',                            options:['5','6','7','8'],                                      correct:1, emoji:'➖' },
    { id:'te6',  question:'How many days are in a week?',               options:['5','6','7','8'],                                      correct:2, emoji:'📅' },
    { id:'te7',  question:'What sound does a cow make?',                options:['Woof','Moo','Meow','Oink'],                           correct:1, emoji:'🐄' },
    { id:'te8',  question:'What is 3 × 4?',                             options:['10','11','12','13'],                                  correct:2, emoji:'✖️' },
    { id:'te9',  question:'Which animal lives in water?',               options:['Lion','Giraffe','Fish','Eagle'],                      correct:2, emoji:'🐟' },
    { id:'te10', question:'How many months are in a year?',             options:['10','11','12','13'],                                  correct:2, emoji:'📆' },
    { id:'te11', question:'What shape has 4 equal sides?',              options:['Triangle','Rectangle','Square','Circle'],             correct:2, emoji:'🔷' },
    { id:'te12', question:'Which planet do we live on?',                options:['Mars','Venus','Earth','Saturn'],                      correct:2, emoji:'🌍' },
    { id:'te13', question:'What comes right after 9?',                  options:['8','10','11','7'],                                    correct:1, emoji:'🔢' },
    { id:'te14', question:'Which of these is a fruit?',                 options:['Carrot','Potato','Apple','Broccoli'],                 correct:2, emoji:'🍎' },
    { id:'te15', question:'How many fingers do humans have in total?',  options:['8','9','10','11'],                                   correct:2, emoji:'🖐️' },
    { id:'te16', question:'What do caterpillars turn into?',            options:['Beetles','Moths','Butterflies','Bees'],               correct:2, emoji:'🦋' },
    { id:'te17', question:'How many sides does a triangle have?',       options:['2','3','4','5'],                                     correct:1, emoji:'🔺' },
    { id:'te18', question:'What is 20 ÷ 4?',                            options:['4','5','6','7'],                                     correct:1, emoji:'➗' },
    { id:'te19', question:'Which animal is the king of the jungle?',    options:['Tiger','Bear','Lion','Cheetah'],                      correct:2, emoji:'🦁' },
    { id:'te20', question:'What do bees make?',                         options:['Milk','Honey','Butter','Jam'],                        correct:1, emoji:'🐝' },
  ],
  middle: [
    { id:'tm1',  question:'What is 25% of 80?',                                     options:['15','20','25','30'],                                              correct:1, emoji:'📊' },
    { id:'tm2',  question:'What is the powerhouse of the cell?',                    options:['Nucleus','Ribosome','Mitochondria','Vacuole'],                    correct:2, emoji:'🔬' },
    { id:'tm3',  question:'What year did the American Revolution end?',             options:['1776','1781','1783','1789'],                                      correct:2, emoji:'🇺🇸' },
    { id:'tm4',  question:'What is the square root of 64?',                         options:['6','7','8','9'],                                                  correct:2, emoji:'📐' },
    { id:'tm5',  question:'What is the chemical formula for water?',                options:['H2O','CO2','O2','NaCl'],                                          correct:0, emoji:'💧' },
    { id:'tm6',  question:'Who wrote "Romeo and Juliet"?',                          options:['Dickens','Shakespeare','Austen','Poe'],                           correct:1, emoji:'📚' },
    { id:'tm7',  question:'What is the area of a rectangle 5×8?',                   options:['26','30','40','45'],                                              correct:2, emoji:'📏' },
    { id:'tm8',  question:'Which continent is Brazil on?',                          options:['Africa','North America','South America','Europe'],                correct:2, emoji:'🌎' },
    { id:'tm9',  question:'What type of rock is formed from lava?',                 options:['Sedimentary','Metamorphic','Igneous','Mineral'],                  correct:2, emoji:'🌋' },
    { id:'tm10', question:'Who was the first US President?',                        options:['Lincoln','Jefferson','Washington','Adams'],                       correct:2, emoji:'🏛️' },
    { id:'tm11', question:'What is the largest organ in the human body?',           options:['Heart','Liver','Lungs','Skin'],                                   correct:3, emoji:'🫀' },
    { id:'tm12', question:'Solve: x + 5 = 12. What is x?',                         options:['5','6','7','8'],                                                  correct:2, emoji:'🔡' },
    { id:'tm13', question:'What gas do plants produce during photosynthesis?',      options:['CO2','Nitrogen','Oxygen','Hydrogen'],                             correct:2, emoji:'🌿' },
    { id:'tm14', question:'What is the capital of Australia?',                      options:['Sydney','Melbourne','Canberra','Perth'],                          correct:2, emoji:'🇦🇺' },
    { id:'tm15', question:'How many vertices does a cube have?',                    options:['6','8','10','12'],                                                correct:1, emoji:'📦' },
    { id:'tm16', question:'Who painted the Mona Lisa?',                             options:['Picasso','Van Gogh','Da Vinci','Monet'],                          correct:2, emoji:'🎨' },
    { id:'tm17', question:'What is 15% of 200?',                                    options:['20','25','30','35'],                                              correct:2, emoji:'💯' },
    { id:'tm18', question:'What force keeps planets in orbit around the Sun?',      options:['Magnetic','Nuclear','Gravity','Friction'],                        correct:2, emoji:'🪐' },
    { id:'tm19', question:'What is 2/3 as a decimal (rounded to 2 places)?',       options:['0.55','0.60','0.67','0.75'],                                      correct:2, emoji:'🔢' },
    { id:'tm20', question:'What is the atomic number of Carbon?',                   options:['4','6','8','12'],                                                 correct:1, emoji:'⚗️' },
  ],
  high: [
    { id:'th1',  question:'What is the derivative of x³?',                            options:['x²','2x²','3x²','4x²'],                                                                    correct:2, emoji:'📈' },
    { id:'th2',  question:'Which war ended with the Treaty of Versailles?',           options:['WWI','WWII','Korean War','Vietnam War'],                                                     correct:0, emoji:'🕊️' },
    { id:'th3',  question:'What is the value of π to 2 decimal places?',             options:['3.12','3.14','3.16','3.18'],                                                                correct:1, emoji:'🔵' },
    { id:'th4',  question:'What is sin(90°)?',                                        options:['0','0.5','1','-1'],                                                                         correct:2, emoji:'📐' },
    { id:'th5',  question:'Who wrote the novel "1984"?',                             options:['Huxley','Orwell','Kafka','Bradbury'],                                                        correct:1, emoji:'📖' },
    { id:'th6',  question:'What is the formula for kinetic energy?',                 options:['mgh','½mv²','mv','Fd'],                                                                     correct:1, emoji:'⚡' },
    { id:'th7',  question:'Who proposed the theory of general relativity?',          options:['Newton','Bohr','Einstein','Hawking'],                                                        correct:2, emoji:'🌌' },
    { id:'th8',  question:'What is log₁₀(1000)?',                                     options:['2','3','4','5'],                                                                            correct:1, emoji:'🔢' },
    { id:'th9',  question:'What is the Pythagorean theorem?',                        options:['a+b=c','a²-b²=c²','a²+b²=c²','2a+b=c'],                                                   correct:2, emoji:'📏' },
    { id:'th10', question:'In mitosis, which phase do chromosomes separate?',        options:['Prophase','Metaphase','Anaphase','Telophase'],                                               correct:2, emoji:'🔬' },
    { id:'th11', question:'Which element has the highest electronegativity?',        options:['Oxygen','Nitrogen','Chlorine','Fluorine'],                                                  correct:3, emoji:'🧪' },
    { id:'th12', question:'What are the three branches of the US government?',       options:['President/Senate/House','Executive/Legislative/Judicial','Federal/State/Local','Congress/Court/President'], correct:1, emoji:'🏛️' },
    { id:'th13', question:'What is the pH of a neutral solution?',                   options:['0','7','10','14'],                                                                          correct:1, emoji:'🧫' },
    { id:'th14', question:'What is the slope of y = 3x + 7?',                        options:['7','3','10','1/3'],                                                                         correct:1, emoji:'📊' },
    { id:'th15', question:'What year did the Berlin Wall fall?',                     options:['1987','1988','1989','1990'],                                                                correct:2, emoji:'🧱' },
    { id:'th16', question:'Which gas law is expressed as PV = nRT?',                 options:["Boyle's Law","Charles' Law",'Ideal Gas Law',"Dalton's Law"],                              correct:2, emoji:'💨' },
    { id:'th17', question:'Which Shakespeare play features the villain Iago?',       options:['Hamlet','Macbeth','Othello','King Lear'],                                                    correct:2, emoji:'🎭' },
    { id:'th18', question:'What is Avogadro\'s number (approx)?',                   options:['6.02×10²²','6.02×10²³','6.02×10²⁴','6.02×10²⁵'],                                         correct:1, emoji:'⚗️' },
    { id:'th19', question:'What is the unit of electric resistance?',                options:['Volt','Ampere','Ohm','Watt'],                                                                correct:2, emoji:'🔌' },
    { id:'th20', question:'In the quadratic formula, what is under the radical?',    options:['b²-4ac','b²+4ac','2b-4ac','b+4ac'],                                                         correct:0, emoji:'✏️' },
  ],
};

function pickTriviaQuestion(gradeLevel, excludeId) {
  const pool = (TRIVIA_QUESTIONS[gradeLevel] || TRIVIA_QUESTIONS.elementary).filter(q => q.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Strip internal timer handles before sending state to clients.
// Node.js Timeout objects contain circular references that cause
// socket.io-parser's hasBinary() to overflow the call stack.
function toClientState(game) {
  const { _qTimer, _timerInt, _coinInt, _bombInterval, ...rest } = game;
  return rest;
}

// Centralized quiz question scheduler — always recurses correctly
function scheduleQuizQuestion(gameId, delay) {
  const game = gameSessions[gameId];
  if (!game || game.status !== 'playing') return;
  if (game._qTimer) clearTimeout(game._qTimer);
  game._qTimer = setTimeout(() => {
    const g = gameSessions[gameId];
    if (!g || g.status !== 'playing') return;
    g.question = pickQuestion(g.question?.id);
    g.questionAnswers = {};
    g.questionDeadline = Date.now() + 15000;
    g.timeLeft = 15;
    io.to(`game_${gameId}`).emit('game_state', toClientState(g));
    scheduleQuizQuestion(gameId, 15000);
  }, delay);
}

function scheduleTriviaQuestion(gameId, delay) {
  const game = gameSessions[gameId];
  if (!game || game.status !== 'playing') return;
  if (game._qTimer) clearTimeout(game._qTimer);
  game._qTimer = setTimeout(() => {
    const g = gameSessions[gameId];
    if (!g || g.status !== 'playing') return;
    g.question = pickTriviaQuestion(g.gradeLevel, g.question?.id);
    g.questionAnswers = {};
    g.questionDeadline = Date.now() + 15000;
    g.timeLeft = 15;
    io.to(`game_${gameId}`).emit('game_state', toClientState(g));
    scheduleTriviaQuestion(gameId, 15000);
  }, delay);
}

function endGame(gameId) {
  const game = gameSessions[gameId];
  if (!game || game.status === 'finished') return;
  game.status = 'finished';
  cleanupGameTimers(game);
  // For bomb_tag, winner is last alive (already set by bomb logic) or highest score
  if (game.type === 'bomb_tag' && !game.winner) {
    const alive = Object.values(game.players).filter(p => p.alive);
    if (alive.length === 1) game.winner = alive[0].id;
    else {
      const sorted = Object.values(game.players).sort((a, b) => b.score - a.score);
      game.winner = sorted[0]?.id || null;
    }
  } else {
    const sorted = Object.values(game.players).sort((a, b) => b.score - a.score);
    game.winner = sorted[0]?.id || null;
  }
  game.finalScores = Object.values(game.players).map(p => ({ id: p.id, username: p.username, avatar: p.avatar, score: p.score, color: p.color, alive: p.alive }));

  // Award 15 Friend Points to the winner (only if they answered at least one correctly)
  if (game.winner && (game.players[game.winner]?.score ?? 0) > 0) {
    try {
      const db = readDB();
      const winnerUser = db.users[game.winner];
      if (winnerUser) {
        winnerUser.friendPoints = (winnerUser.friendPoints || 0) + 15;
        writeDB(db);
        io.to(game.winner).emit('points_updated', {
          friendPoints: winnerUser.friendPoints,
          reason: '+15 Friend Points for winning! 🏆',
        });
        io.to(game.winner).emit('token_refresh', { token: mintToken(winnerUser, db) });
      }
    } catch (e) { console.error('endGame points error:', e.message); }
  }

  io.to(`game_${gameId}`).emit('game_state', toClientState(game));
  setTimeout(() => delete gameSessions[gameId], 120000);
}

function cleanupGameTimers(game) {
  if (game._timerInt) clearInterval(game._timerInt);
  if (game._coinInt)  clearInterval(game._coinInt);
  if (game._qTimer)   clearTimeout(game._qTimer);
  if (game._bombInterval) clearInterval(game._bombInterval);
}

function cleanupGame(gameId) {
  const game = gameSessions[gameId];
  if (game) cleanupGameTimers(game);
  delete gameSessions[gameId];
}

// =================== SOCKET.IO ===================
io.on('connection', (socket) => {
  socket.on('authenticate', (userId) => {
    if (!userId) return;
    const db = readDB();
    // Prevent banned users from connecting — kick them immediately
    if (db.users[userId]?.banned) {
      socket.emit('account_banned');
      return;
    }
    socket.userId = userId;
    socket.join(userId);
    if (db.users[userId]) {
      db.users[userId].status = 'online';
      writeDB(db);
      // Send a fresh token so the client's stored JWT always has the latest
      // contacts, points, and unlocked items — even after server restarts or
      // if the user was in a game room when a token_refresh event was missed.
      socket.emit('token_refresh', { token: mintToken(db.users[userId], db) });
    }
    // Broadcast online status to contacts
    const user = readDB().users[userId];
    if (user) {
      // Admin gets real-time notifications about new registrations
      if (isSuperAdmin(user.username) || user.isAdmin) socket.join('admin');
      user.contacts.forEach((cId) => {
        io.to(cId).emit('contact_online', { userId, status: 'online' });
      });
      // Send back the current status of ALL this user's contacts so their
      // contacts page shows accurate online/offline dots right after (re)connect.
      const db2 = readDB();
      const statuses = user.contacts.map((cId) => ({
        userId: cId,
        status: (db2.users[cId]?.status === 'online') ? 'online' : 'offline',
      }));
      socket.emit('contacts_status', statuses);
    }
  });

  socket.on('join_chat', (chatId) => socket.join(chatId));
  socket.on('leave_chat', (chatId) => socket.leave(chatId));

  socket.on('typing', ({ chatId, isTyping }) => {
    socket.to(chatId).emit('user_typing', { userId: socket.userId, isTyping });
  });

  // =================== EMOJI REACTIONS ===================
  socket.on('add_reaction', ({ chatId, messageId, emoji }) => {
    if (!socket.userId || !chatId || !messageId || !emoji) return;
    const db = readDB();
    if (!db.messages[chatId]) return;
    const msg = db.messages[chatId].find((m) => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(socket.userId);
    if (idx === -1) {
      msg.reactions[emoji].push(socket.userId);
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    }
    writeDB(db);
    io.to(chatId).emit('reaction_updated', { chatId, messageId, reactions: msg.reactions });
  });

  // =================== MESSAGE EDITING (SOCKET) ===================
  socket.on('edit_message', ({ chatId, messageId, content }) => {
    if (!socket.userId || !chatId || !messageId || !content) return;
    const db = readDB();
    const msgs = db.messages[chatId];
    if (!msgs) return;
    const msg = msgs.find((m) => m.id === messageId);
    if (!msg) return;
    if (msg.senderId !== socket.userId) return;
    if (msg.type !== 'text') return;
    const msgAge = Date.now() - new Date(msg.timestamp).getTime();
    if (msgAge > 15 * 60 * 1000) return;
    const newContent = sanitize(content);
    if (!newContent || newContent.length > 1000) return;
    msg.content = newContent;
    msg.edited = true;
    msg.editedAt = new Date().toISOString();
    writeDB(db);
    io.to(chatId).emit('message_edited', { chatId, messageId, content: newContent, editedAt: msg.editedAt });
  });

  // =================== GAME SOCKET EVENTS ===================
  socket.on('game_create', ({ type, chatId, gradeLevel }) => {
    if (!socket.userId) return;
    const db = readDB();
    const user = db.users[socket.userId];
    if (!user) return;
    // Validate game type
    const validTypes = ['coin_rush', 'quiz_duel', 'trivia', 'word_blitz', 'bomb_tag'];
    if (!validTypes.includes(type)) return socket.emit('game_error', 'Invalid game type');
    const gameId = uuidv4();
    const game = {
      id: gameId,
      type,
      status: 'lobby',
      hostId: socket.userId,
      chatId: chatId || null,
      players: {
        [socket.userId]: {
          id: socket.userId,
          username: user.username,
          avatar: user.avatar,
          x: GAME_WORLD.w / 2,
          y: GAME_WORLD.h / 2,
          score: 0,
          color: PLAYER_COLORS[0],
          isMoving: false,
          trackPos: 0,
          alive: true,
        },
      },
      coins: [],
      question: null,
      questionAnswers: {},
      wordTarget: null,
      gradeLevel: type === 'trivia' ? (gradeLevel || 'elementary') : undefined,
      // Bomb Tag state
      bombCarrier: type === 'bomb_tag' ? socket.userId : null,
      bombTimer: type === 'bomb_tag' ? BOMB_TAG.COUNTDOWN : null,
      eliminated: [],
      timeLeft: type === 'coin_rush' ? 60 : type === 'bomb_tag' ? 90 : 90,
      winner: null,
      finalScores: null,
    };
    gameSessions[gameId] = game;
    socket.join(`game_${gameId}`);
    socket.emit('game_created', { gameId });
    socket.emit('game_state', toClientState(game));
    if (chatId) {
      socket.to(chatId).emit('game_invite_notification', {
        gameId, type,
        hostId: socket.userId,
        hostName: user.username,
        hostAvatar: user.avatar,
        chatId,
      });
    }
  });

  socket.on('game_join', ({ gameId }) => {
    if (!socket.userId) return;
    const game = gameSessions[gameId];
    if (!game) return socket.emit('game_error', 'Game not found');
    socket.join(`game_${gameId}`);
    if (game.players[socket.userId]) {
      socket.emit('game_state', toClientState(game));
      return;
    }
    if (game.status !== 'lobby') return socket.emit('game_error', 'Game already started');
    const playerIdx = Object.keys(game.players).length;
    if (playerIdx >= 8) return socket.emit('game_error', 'Game is full (max 8)');
    const db = readDB();
    const user = db.users[socket.userId];
    if (!user) return;
    const color = PLAYER_COLORS[playerIdx % PLAYER_COLORS.length];
    const startPositions = [
      { x: 120, y: 120 }, { x: 680, y: 120 }, { x: 120, y: 440 }, { x: 680, y: 440 },
      { x: 400, y: 80  }, { x: 400, y: 480 }, { x: 80,  y: 280 }, { x: 720, y: 280 },
    ];
    const pos = startPositions[playerIdx % 8];
    game.players[socket.userId] = {
      id: socket.userId,
      username: user.username,
      avatar: user.avatar,
      x: pos.x, y: pos.y,
      score: 0, color,
      isMoving: false,
      trackPos: 0,
      alive: true,
    };
    io.to(`game_${gameId}`).emit('game_state', toClientState(game));
  });

  socket.on('game_start', ({ gameId }) => {
    const game = gameSessions[gameId];
    if (!game || game.hostId !== socket.userId || game.status !== 'lobby') return;
    game.status = 'playing';
    game.startTime = Date.now();
    if (game.type === 'coin_rush') {
      game.coins = generateCoins(14);
      game.timeLeft = 60;
    } else if (game.type === 'quiz_duel') {
      game.question = pickQuestion(null);
      game.questionAnswers = {};
      game.questionDeadline = Date.now() + 15000;
      game.timeLeft = 15;
    } else if (game.type === 'trivia') {
      game.question = pickTriviaQuestion(game.gradeLevel, null);
      game.questionAnswers = {};
      game.questionDeadline = Date.now() + 15000;
      game.timeLeft = 15;
    } else if (game.type === 'word_blitz') {
      game.wordTarget = pickWord(null);
      game.wordTyped = {};
      game.timeLeft = 90;
    } else if (game.type === 'bomb_tag') {
      // Randomly assign bomb carrier
      const playerIds = Object.keys(game.players);
      game.bombCarrier = playerIds[Math.floor(Math.random() * playerIds.length)];
      game.bombTimer = BOMB_TAG.COUNTDOWN;
      game.eliminated = [];
      Object.values(game.players).forEach(p => { p.alive = true; });
      game.timeLeft = 90;
    }
    // Reset track positions and alive status
    Object.values(game.players).forEach(p => { p.trackPos = 0; p.score = 0; if (game.type === 'bomb_tag') p.alive = true; });
    io.to(`game_${gameId}`).emit('game_state', toClientState(game));

    // Coin Rush: replenish coins
    if (game.type === 'coin_rush') {
      game._coinInt = setInterval(() => {
        const g = gameSessions[gameId];
        if (!g || g.status !== 'playing') { clearInterval(g._coinInt); return; }
        const remaining = (g.coins || []).filter(c => !c.collected).length;
        if (remaining < 6) {
          const fresh = generateCoins(6);
          g.coins.push(...fresh);
          io.to(`game_${gameId}`).emit('game_coins_added', fresh);
        }
      }, 3000);
    }

    // Bomb Tag: need at least 2 players
    if (game.type === 'bomb_tag' && Object.keys(game.players).length < 2) {
      return socket.emit('game_error', 'Bomb Tag needs at least 2 players!');
    }

    // Quiz/Trivia: auto-advance question using centralized scheduler
    if (game.type === 'quiz_duel') {
      scheduleQuizQuestion(gameId, 15000);
    }
    if (game.type === 'trivia') {
      scheduleTriviaQuestion(gameId, 15000);
    }

    // Universal countdown timer
    game._timerInt = setInterval(() => {
      const g = gameSessions[gameId];
      if (!g || g.status !== 'playing') { clearInterval(g._timerInt); return; }
      const elapsed = (Date.now() - g.startTime) / 1000;
      const maxTime = g.type === 'coin_rush' ? 60 : g.type === 'word_blitz' ? 90 : g.type === 'bomb_tag' ? 90 : null;
      if (maxTime !== null) {
        g.timeLeft = Math.max(0, maxTime - elapsed);
        io.to(`game_${gameId}`).emit('game_timer', { timeLeft: g.timeLeft });
        if (g.timeLeft <= 0) endGame(gameId);
      } else if (g.type === 'quiz_duel' || g.type === 'trivia') {
        const tl = Math.max(0, (g.questionDeadline - Date.now()) / 1000);
        g.timeLeft = tl;
        io.to(`game_${gameId}`).emit('game_timer', { timeLeft: tl });
      }
    }, 500);

    // Bomb Tag: tick the bomb countdown every second
    if (game.type === 'bomb_tag') {
      game._bombInterval = setInterval(() => {
        const g = gameSessions[gameId];
        if (!g || g.status !== 'playing') { clearInterval(g._bombInterval); return; }
        if (g.bombCarrier && g.bombTimer > 0) {
          g.bombTimer -= 1;
          io.to(`game_${gameId}`).emit('bomb_tick', { bombTimer: g.bombTimer, bombCarrier: g.bombCarrier });
          if (g.bombTimer <= 0) {
            // Bomb explodes — carrier is eliminated
            const carrierId = g.bombCarrier;
            if (g.players[carrierId]) {
              g.players[carrierId].alive = false;
              g.eliminated.push(carrierId);
              g.players[carrierId].score = Math.max(0, g.players[carrierId].score - 10);
            }
            io.to(`game_${gameId}`).emit('bomb_exploded', { carrierId, eliminated: g.eliminated });
            // Check win condition: only 1 alive left
            const alive = Object.values(g.players).filter(p => p.alive);
            if (alive.length <= 1) {
              // Last player standing wins
              if (alive.length === 1) {
                alive[0].score += 50;
                g.winner = alive[0].id;
              }
              endGame(gameId);
              return;
            }
            // Re-arm bomb on a random alive player
            const aliveIds = alive.map(p => p.id);
            g.bombCarrier = aliveIds[Math.floor(Math.random() * aliveIds.length)];
            g.bombTimer = BOMB_TAG.COUNTDOWN;
            io.to(`game_${gameId}`).emit('bomb_reassigned', { bombCarrier: g.bombCarrier, bombTimer: g.bombTimer });
          }
        }
      }, 1000);
    }
  });

  socket.on('game_player_move', ({ gameId, x, y, isMoving }) => {
    const game = gameSessions[gameId];
    if (!game || game.status !== 'playing' || !game.players[socket.userId]) return;
    const p = game.players[socket.userId];
    if (game.type === 'bomb_tag' && !p.alive) return; // dead players can't move
    p.x = Math.max(24, Math.min(GAME_WORLD.w - 24, x));
    p.y = Math.max(24, Math.min(GAME_WORLD.h - 24, y));
    p.isMoving = isMoving;
    socket.to(`game_${gameId}`).emit('game_players_update', { players: game.players });
  });

  socket.on('game_collect_coin', ({ gameId, coinId }) => {
    const game = gameSessions[gameId];
    if (!game || game.status !== 'playing') return;
    const coin = (game.coins || []).find(c => c.id === coinId && !c.collected);
    const player = game.players[socket.userId];
    if (!coin || !player) return;
    const dist = Math.hypot(player.x - coin.x, player.y - coin.y);
    if (dist > 52) return;
    coin.collected = true;
    const value = coin.type === 'gem' ? 5 : coin.type === 'star' ? 3 : 1;
    player.score += value;
    io.to(`game_${gameId}`).emit('game_coin_collected', { coinId, collectorId: socket.userId, newScore: player.score });
  });

  socket.on('game_quiz_answer', ({ gameId, answerIdx }) => {
    const game = gameSessions[gameId];
    if (!game || game.status !== 'playing' || (game.type !== 'quiz_duel' && game.type !== 'trivia')) return;
    if (!game.questionAnswers) game.questionAnswers = {};
    if (game.questionAnswers[socket.userId] !== undefined) return;
    const isCorrect = answerIdx === game.question.correct;
    game.questionAnswers[socket.userId] = { answerIdx, isCorrect };
    if (isCorrect) {
      game.players[socket.userId].score += 10;
      game.players[socket.userId].trackPos = Math.min(100, (game.players[socket.userId].trackPos || 0) + 20);
    }
    const trackPositions = Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, p.trackPos || 0]));
    const scores = Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, p.score]));
    io.to(`game_${gameId}`).emit('game_quiz_answered', { playerId: socket.userId, answerIdx, isCorrect, scores, trackPositions });
    if ((game.players[socket.userId].trackPos || 0) >= 100) { endGame(gameId); return; }
    // In trivia, advance immediately after any answer — reset deadline so the
    // countdown shows a clean 2-second reveal window instead of jumping to 0.
    if (game.type === 'trivia') {
      game.questionDeadline = Date.now() + 2000;
      scheduleTriviaQuestion(gameId, 2000);
      return;
    }
    const allAnswered = Object.keys(game.players).every(id => game.questionAnswers[id] !== undefined);
    if (allAnswered) {
      // Advance to next question early (2s reveal delay) using centralized scheduler
      scheduleQuizQuestion(gameId, 2000);
    }
  });

  socket.on('game_word_submit', ({ gameId, word }) => {
    const game = gameSessions[gameId];
    if (!game || game.status !== 'playing' || game.type !== 'word_blitz') return;
    if (!game.wordTarget || word.toLowerCase().trim() !== game.wordTarget.toLowerCase()) return;
    if (!game.wordTyped) game.wordTyped = {};
    game.wordTyped[socket.userId] = (game.wordTyped[socket.userId] || 0) + 1;
    game.players[socket.userId].score += 1;
    game.players[socket.userId].trackPos = Math.min(100, (game.players[socket.userId].trackPos || 0) + 10);
    const scores = Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, p.score]));
    const trackPositions = Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, p.trackPos || 0]));
    io.to(`game_${gameId}`).emit('game_word_typed', { playerId: socket.userId, scores, trackPositions });
    if ((game.players[socket.userId].trackPos || 0) >= 100) { endGame(gameId); return; }
    const newWord = pickWord(game.wordTarget);
    game.wordTarget = newWord;
    io.to(`game_${gameId}`).emit('game_new_word', { word: newWord });
  });

  // =================== BOMB TAG ===================
  socket.on('bomb_pass', ({ gameId }) => {
    const game = gameSessions[gameId];
    if (!game || game.status !== 'playing' || game.type !== 'bomb_tag') return;
    if (game.bombCarrier !== socket.userId) return;
    const carrier = game.players[socket.userId];
    if (!carrier || !carrier.alive) return;
    // Find nearest alive player within pass radius
    let nearest = null;
    let nearestDist = Infinity;
    for (const p of Object.values(game.players)) {
      if (p.id === socket.userId || !p.alive) continue;
      const dist = Math.hypot(carrier.x - p.x, carrier.y - p.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = p;
      }
    }
    if (!nearest || nearestDist > BOMB_TAG.PASS_RADIUS) return;
    // Pass bomb
    game.bombCarrier = nearest.id;
    game.bombTimer = BOMB_TAG.COUNTDOWN;
    carrier.score += 5; // reward for passing
    nearest.score += 2; // small reward for receiving
    io.to(`game_${gameId}`).emit('bomb_passed', {
      from: socket.userId,
      to: nearest.id,
      bombCarrier: nearest.id,
      bombTimer: game.bombTimer,
      scores: Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, p.score])),
    });
  });

  socket.on('game_leave', ({ gameId }) => {
    const game = gameSessions[gameId];
    if (!game) return;
    socket.leave(`game_${gameId}`);
    // If bomb carrier leaves, reassign bomb to a random alive player
    if (game.type === 'bomb_tag' && game.bombCarrier === socket.userId) {
      const remaining = Object.keys(game.players).filter(id => id !== socket.userId && game.players[id].alive);
      if (remaining.length > 0) {
        game.bombCarrier = remaining[Math.floor(Math.random() * remaining.length)];
        game.bombTimer = BOMB_TAG.COUNTDOWN;
        io.to(`game_${gameId}`).emit('bomb_reassigned', { bombCarrier: game.bombCarrier, bombTimer: game.bombTimer });
      }
    }
    delete game.players[socket.userId];
    if (Object.keys(game.players).length === 0) {
      cleanupGame(gameId);
    } else {
      if (game.hostId === socket.userId) game.hostId = Object.keys(game.players)[0];
      io.to(`game_${gameId}`).emit('game_state', toClientState(game));
    }
  });

  socket.on('game_get_state', ({ gameId }) => {
    const game = gameSessions[gameId];
    if (game) socket.emit('game_state', toClientState(game));
    else socket.emit('game_error', 'Game not found');
  });

  // =====================================================
  // =================== VIDEO CALL SIGNALING ===========
  // =====================================================

  // User initiates a call to a chatId (DM or group)
  socket.on('call_start', ({ chatId, callerInfo }) => {
    if (!socket.userId) return;
    const db = readDB();
    const caller = db.users[socket.userId];
    if (!caller) return;

    const callId = uuidv4();
    const isGroup = chatId.startsWith('group_');
    let recipientIds = [];

    if (isGroup) {
      const group = db.groups[chatId];
      if (!group) return;
      recipientIds = group.members.filter((m) => m !== socket.userId);
    } else {
      const ids = chatId.split('_');
      recipientIds = ids.filter((id) => id !== socket.userId);
    }

    recipientIds.forEach((rId) => {
      io.to(rId).emit('incoming_call', {
        callId,
        chatId,
        callerId: socket.userId,
        callerName: caller.username,
        callerAvatar: caller.avatar,
        isGroup,
      });
      // Web Push — fires even when the recipient's window is closed
      sendPushToUser(db, rId, {
        title: `📞 ${caller.username} is calling…`,
        body: isGroup ? 'Incoming group video call' : 'Tap to answer',
        icon: '/Logo.png',
        tag: `call-${callId}`,
        requireInteraction: true,
        url: `/chat/${chatId}`,
      });
    });

    // Confirm callId back to caller
    socket.emit('call_initiated', { callId });
  });

  // WebRTC offer — relay to a specific peer
  socket.on('call_offer', ({ to, offer, callId }) => {
    io.to(to).emit('call_offer', { from: socket.userId, offer, callId });
  });

  // WebRTC answer — relay back to offerer
  socket.on('call_answer', ({ to, answer, callId }) => {
    io.to(to).emit('call_answer', { from: socket.userId, answer, callId });
  });

  // ICE candidate relay
  socket.on('ice_candidate', ({ to, candidate, callId }) => {
    io.to(to).emit('ice_candidate', { from: socket.userId, candidate, callId });
  });

  // User ended the call
  socket.on('call_end', ({ chatId, callId }) => {
    if (!socket.userId) return;
    // Notify everyone in the chat room that the call ended
    socket.to(chatId).emit('call_ended', { callId, by: socket.userId });
  });

  // User left the call without ending it for everyone (group calls)
  socket.on('call_leave', ({ chatId, callId }) => {
    if (!socket.userId) return;
    socket.to(chatId).emit('call_peer_left', { userId: socket.userId, callId });
  });

  // Relay camera state change to everyone else in the call room
  socket.on('call_cam_state', ({ chatId, camOn, callId }) => {
    if (!socket.userId) return;
    socket.to(chatId).emit('call_cam_state', { userId: socket.userId, camOn, callId });
  });

  // Relay mic state change to everyone else in the call room
  socket.on('call_mic_state', ({ chatId, micOn, callId }) => {
    if (!socket.userId) return;
    socket.to(chatId).emit('call_mic_state', { userId: socket.userId, micOn, callId });
  });

  // User rejected incoming call
  socket.on('call_reject', ({ callerId, callId }) => {
    if (!socket.userId) return;
    io.to(callerId).emit('call_rejected', { by: socket.userId, callId });
  });

  // User is joining an ongoing group call
  socket.on('call_peer_join', ({ chatId, callId, callerId }) => {
    if (!socket.userId) return;
    // Broadcast to the chat room so all existing call members (including the original caller)
    // know a new peer has joined and can send them an offer.
    // The caller joins the chatId room before call_start, so this reaches them.
    // Include name/avatar so every participant can display the new joiner correctly
    const db = readDB();
    const joiner = db.users[socket.userId];
    const peerInfo = {
      userId:   socket.userId,
      callId,
      username: joiner?.username ?? 'Friend',
      avatar:   joiner?.avatar   ?? '',
    };
    // Notify every participant already in the chat room
    socket.to(chatId).emit('call_peer_joined', peerInfo);
    // Belt-and-suspenders: also notify the original caller directly in case
    // they haven't joined the room socket yet (slow network / race condition).
    if (callerId && callerId !== socket.userId) {
      const callerSockets = io.sockets.adapter.rooms.get(chatId);
      const callerInRoom = callerSockets && [...callerSockets].some(sid => {
        const s = io.sockets.sockets.get(sid);
        return s && s.userId === callerId;
      });
      if (!callerInRoom) {
        io.to(callerId).emit('call_peer_joined', peerInfo);
      }
    }
  });

  // =====================================================

  socket.on('disconnect', () => {
    if (socket.userId) {
      // Notify all socket rooms this user was in that they left the call.
      // This cleans up ghost tiles when a participant drops unexpectedly.
      for (const room of socket.rooms) {
        if (room !== socket.id) {
          socket.to(room).emit('call_peer_left', { userId: socket.userId });
        }
      }
      const db = readDB();
      if (db.users[socket.userId]) {
        db.users[socket.userId].status = 'offline';
        writeDB(db);
        db.users[socket.userId].contacts.forEach((cId) => {
          io.to(cId).emit('contact_online', { userId: socket.userId, status: 'offline' });
        });
      }
    }
  });
});

// =================== START ===================
const PORT = process.env.PORT || 3001;

// Fallback to index.html for client-side routing (must be after API routes)
app.get('*', (_req, res) => {
  const indexPath = path.join(__dirname, '../frontend/dist', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
  }
});

let publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;

// GET /api/server-info — returns public tunnel URL if available
app.get('/api/server-info', (_req, res) => {
  res.json({ publicUrl });
});

// =================== POST-INIT MAINTENANCE ===================
async function postInitMaintenance() {
  const db = readDB();
  let dirty = false;

  // 1. Backfill userLog from existing users (fixes empty log on old installs)
  if (!db.userLog) { db.userLog = []; dirty = true; }
  Object.values(db.users).forEach((u) => {
    if (!db.userLog.find((e) => e.id === u.id)) {
      db.userLog.push({ id: u.id, username: u.username, avatar: u.avatar, secretId: u.secretId, createdAt: u.createdAt || new Date().toISOString() });
      dirty = true;
    }
  });
  if (dirty) console.log('✅ Backfilled userLog from existing users.');

  // 2. Ensure Danielthecreator admin account exists
  const adminExists = Object.values(db.users).some((u) => u.username === 'Danielthecreator');
  if (!adminExists) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'Friendnix2024!';
    const adminId = uuidv4();
    const adminSecretId = generateSecretId(db);
    const hashed = await bcrypt.hash(adminPassword, 10);
    db.users[adminId] = {
      id: adminId,
      secretId: adminSecretId,
      username: 'Danielthecreator',
      password: hashed,
      avatar: '👑',
      status: 'offline',
      contacts: [],
      pendingRequests: [],
      incomingRequests: [],
      createdAt: new Date().toISOString(),
      friendPoints: Number.MAX_SAFE_INTEGER,
      messageCount: 0,
      unlockedItems: [],
      completedMilestones: ['starter'],
    };
    db.userLog.push({ id: adminId, username: 'Danielthecreator', avatar: '👑', secretId: adminSecretId, createdAt: db.users[adminId].createdAt });
    dirty = true;
    console.log(`✅ Auto-created admin account 'Danielthecreator'.`);
    console.log(`   🔑 Password: ${adminPassword}`);
    console.log(`   ⚠️  Set ADMIN_PASSWORD env var to change the default password.`);
  }

  if (dirty) writeDB(db);
}

// Initialise DB first, then start listening
// Start listening immediately so Railway's healthcheck passes before async
// initialisation completes (avoids "Application failed to respond" on cold start).
httpServer.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIp = 'localhost';
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
    }
    if (localIp !== 'localhost') break;
  }
  console.log(`\n🚀 Friendnix starting on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}`);
  if (publicUrl) console.log(`   Public:  ${publicUrl}  ← Railway deployment 🚀`);
});

initDB().then(async () => {
  // Initialise Web Push VAPID keys (generate once, persist in DB)
  if (webpush) {
    const db = readDB();
    if (!db.vapidKeys) {
      db.vapidKeys = webpush.generateVAPIDKeys();
      await writeDBNow(db);
      console.log('✅ Generated VAPID keys for Web Push');
    }
    webpush.setVapidDetails(
      'mailto:admin@friendnix.app',
      db.vapidKeys.publicKey,
      db.vapidKeys.privateKey
    );
    console.log('🔔 Web Push ready');
  }

  await postInitMaintenance();
  console.log('\n✅ Friendnix fully initialised\n');
}).catch((err) => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
