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

// --- Helper functions ---

/**
 * Save a new item from a WhatsApp message.
 * Returns the new item's ID, or null if it was a duplicate.
 */
function saveItem({ messageId, description, phone, senderName, photoPath, messageAt }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO items (message_id, description, phone, sender_name, photo_path, message_at)
      VALUES (@messageId, @description, @phone, @senderName, @photoPath, @messageAt)
    `);
    const result = stmt.run({ messageId, description, phone, senderName, photoPath, messageAt: messageAt || null });
    return result.lastInsertRowid;
  } catch (err) {
    // UNIQUE constraint on message_id — this message was already processed
    if (err.message.includes('UNIQUE constraint failed')) {
      return null;
    }
    throw err;
  }
}

/**
 * Return all available (not taken) items, newest first.
 */
function getAvailableItems() {
  return db.prepare(`
    SELECT * FROM items
    WHERE is_taken = 0
    ORDER BY COALESCE(message_at, created_at) DESC
  `).all();
}

/**
 * Return all items regardless of status, newest first.
 */
function getAllItems() {
  return db.prepare(`
    SELECT * FROM items
    ORDER BY COALESCE(message_at, created_at) DESC
  `).all();
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

module.exports = { saveItem, getAvailableItems, getAllItems, markItemTaken, markItemAvailable, deleteItem };
