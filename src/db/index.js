// Database layer using SQLite
// SQLite is a simple file-based database — perfect for a small project like this

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store the database file in the project root
const DB_PATH = path.join(__dirname, '../../data/marketplace.db');

// Make sure the data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create the items table if it doesn't exist yet
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT UNIQUE,          -- WhatsApp message ID (prevents duplicates)
    description TEXT NOT NULL,        -- The text of the WhatsApp message
    phone       TEXT,                 -- Sender's phone number
    sender_name TEXT,                 -- Sender's display name
    photo_path  TEXT,                 -- Local path to saved photo (if any)
    is_taken    INTEGER DEFAULT 0,    -- 0 = available, 1 = taken
    message_at  TEXT,                 -- When the original WhatsApp message was sent
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )
`);

// Migrate existing databases that don't have message_at yet
try { db.exec(`ALTER TABLE items ADD COLUMN message_at TEXT`); } catch (_) {}

// Migrate: add group_id for multi-group support
try { db.exec(`ALTER TABLE items ADD COLUMN group_id TEXT DEFAULT ''`); } catch (_) {}

// Groups configuration table — managed via the web UI.
// Seeded from .env on the very first run so existing setups keep working.
db.exec(`
  CREATE TABLE IF NOT EXISTS configured_groups (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  )
`);
{
  const { c } = db.prepare('SELECT COUNT(*) as c FROM configured_groups').get();
  if (c === 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO configured_groups (id, name) VALUES (?, ?)');
    if (process.env.WHATSAPP_GROUPS) {
      for (const entry of process.env.WHATSAPP_GROUPS.split(',').map(s => s.trim()).filter(Boolean)) {
        const sep = entry.indexOf(':');
        const id   = sep !== -1 ? entry.slice(0, sep) : entry;
        const name = sep !== -1 ? entry.slice(sep + 1) : entry;
        if (id.endsWith('@g.us')) insert.run(id, name);
      }
    } else if (process.env.WHATSAPP_GROUP_ID) {
      insert.run(
        process.env.WHATSAPP_GROUP_ID,
        process.env.WHATSAPP_GROUP_NAME || process.env.WHATSAPP_GROUP_ID,
      );
    }
  }
}

// ── Retroactive cleanup ───────────────────────────────────────────────────────
// Enforce current rules against data that was saved before the rules existed.
{
  // 1. Remove items with no photo (those are "looking for" posts, not offers)
  const noPhoto = db.prepare(`DELETE FROM items WHERE photo_path IS NULL`).run();

  // 2. Remove items whose description contains 💾 or ❌ (unavailable markers)
  const unavailable = db.prepare(`
    DELETE FROM items WHERE description LIKE '%💾%' OR description LIKE '%❌%'
  `).run();

  const total = noPhoto.changes + unavailable.changes;
  if (total > 0) {
    console.log(`🧹 Cleaned up ${total} stale DB records (${noPhoto.changes} no-photo, ${unavailable.changes} unavailable).`);
  }
}

// --- Helper functions ---

/**
 * Save a new item from a WhatsApp message.
 * Returns the new item's ID, or null if it was a duplicate.
 */
function saveItem({ messageId, description, phone, senderName, photoPath, messageAt, groupId = '' }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO items (message_id, description, phone, sender_name, photo_path, message_at, group_id)
      VALUES (@messageId, @description, @phone, @senderName, @photoPath, @messageAt, @groupId)
    `);
    const result = stmt.run({ messageId, description, phone, senderName, photoPath, messageAt: messageAt || null, groupId });
    return result.lastInsertRowid;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) return null;
    throw err;
  }
}

/**
 * Return all available (not taken) items, newest first.
 * Pass groupId to restrict to a single group.
 */
function getAvailableItems(groupId = null) {
  if (groupId) {
    return db.prepare(`
      SELECT * FROM items WHERE is_taken = 0 AND group_id = ?
      ORDER BY COALESCE(message_at, created_at) DESC
    `).all(groupId);
  }
  return db.prepare(`
    SELECT * FROM items WHERE is_taken = 0
    ORDER BY COALESCE(message_at, created_at) DESC
  `).all();
}

/**
 * Return all items regardless of status, newest first.
 * Pass groupId to restrict to a single group.
 */
function getAllItems(groupId = null) {
  if (groupId) {
    return db.prepare(`
      SELECT * FROM items WHERE group_id = ?
      ORDER BY COALESCE(message_at, created_at) DESC
    `).all(groupId);
  }
  return db.prepare(`
    SELECT * FROM items ORDER BY COALESCE(message_at, created_at) DESC
  `).all();
}

/**
 * Return distinct group IDs present in the DB.
 */
function getGroupIds() {
  return db.prepare(`SELECT DISTINCT group_id FROM items WHERE group_id != ''`).all().map(r => r.group_id);
}

/**
 * Mark an item as taken (no longer available).
 */
function markItemTaken(id) {
  db.prepare(`
    UPDATE items
    SET is_taken = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Mark an item as available again.
 */
function markItemAvailable(id) {
  db.prepare(`
    UPDATE items
    SET is_taken = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Delete an item by ID.
 */
function deleteItem(id) {
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

/**
 * Delete an item by its WhatsApp message ID.
 * Returns true if a row was deleted.
 */
function deleteItemByMessageId(messageId) {
  const result = db.prepare('DELETE FROM items WHERE message_id = ?').run(messageId);
  return result.changes > 0;
}

/**
 * Delete the most recent available item from a given phone number.
 * Returns true if a row was deleted.
 */
function deleteLatestItemByPhone(phone) {
  const result = db.prepare(`
    DELETE FROM items WHERE id = (
      SELECT id FROM items
      WHERE phone = ? AND is_taken = 0
      ORDER BY COALESCE(message_at, created_at) DESC
      LIMIT 1
    )
  `).run(phone);
  return result.changes > 0;
}

/** Return all groups in the configured_groups table. */
function getConfiguredGroups() {
  return db.prepare('SELECT id, name FROM configured_groups ORDER BY name').all();
}

/** Add or rename a configured group. */
function addConfiguredGroup(id, name) {
  db.prepare('INSERT OR REPLACE INTO configured_groups (id, name) VALUES (?, ?)').run(id, name);
}

/** Remove a configured group by ID. */
function removeConfiguredGroup(id) {
  db.prepare('DELETE FROM configured_groups WHERE id = ?').run(id);
}

module.exports = {
  saveItem, getAvailableItems, getAllItems, getGroupIds,
  markItemTaken, markItemAvailable, deleteItem,
  deleteItemByMessageId, deleteLatestItemByPhone,
  getConfiguredGroups, addConfiguredGroup, removeConfiguredGroup,
};
