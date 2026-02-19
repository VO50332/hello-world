// WhatsApp Bot
// Uses whatsapp-web.js which controls WhatsApp Web in a hidden browser.
// On first run it will show a QR code — scan it with your phone to log in.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { saveItem, deleteItemByMessageId, deleteLatestItemByPhone } = require('../db');

// ── Configuration ────────────────────────────────────────────────────────────

// Multi-group support.
//
// New format — supports multiple groups (recommended):
//   WHATSAPP_GROUPS=120363AAA@g.us:שוק מתנות,120363BBB@g.us:קבוצה נוספת
//
// Legacy format — single group (still works):
//   WHATSAPP_GROUP_ID=120363AAA@g.us
//   WHATSAPP_GROUP_NAME=שוק מתנות
//
// groupsConfig: Map<groupId → displayName>
function parseGroupsConfig() {
  if (process.env.WHATSAPP_GROUPS) {
    const map = new Map();
    for (const entry of process.env.WHATSAPP_GROUPS.split(',').map(s => s.trim()).filter(Boolean)) {
      const sep = entry.indexOf(':');
      if (sep === -1) map.set(entry, entry);
      else map.set(entry.slice(0, sep), entry.slice(sep + 1));
    }
    return map;
  }
  if (process.env.WHATSAPP_GROUP_ID) {
    return new Map([[process.env.WHATSAPP_GROUP_ID, process.env.WHATSAPP_GROUP_NAME || process.env.WHATSAPP_GROUP_ID]]);
  }
  return new Map();
}

const groupsConfig = parseGroupsConfig();   // Map<groupId → name>
const targetGroupIds = new Set(groupsConfig.keys());

// SCAN_KEYWORDS: comma-separated words (Hebrew or any language).
// When set, the bot will only save messages whose description contains
// at least one of these keywords — both in live mode and when scanning history.
// Leave empty to save all posts. Example: SCAN_KEYWORDS=כיסא,ספה,מיטה
const ENV_KEYWORDS = process.env.SCAN_KEYWORDS
  ? process.env.SCAN_KEYWORDS.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  : [];

// Where to save photos sent in the group
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '../../.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    protocolTimeout: 120000, // 2 min — for photo downloads on slow connections
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

let clientReady = false;

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
  qrcode.generate(qr, { small: true });
  console.log('\nGo to WhatsApp → Settings → Linked Devices → Link a Device\n');
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated successfully');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('ready', () => {
  clientReady = true;
  if (targetGroupIds.size > 0) {
    console.log(`✅ Bot is running! Monitoring ${targetGroupIds.size} group(s):`);
    for (const [id, name] of groupsConfig) console.log(`   • "${name}" (${id})`);
  } else {
    console.log('✅ Bot is ready. No groups configured yet.');
    console.log('   When any group message arrives, its ID will be printed here.');
    console.log('   Add to your .env: WHATSAPP_GROUPS=<id>:Group Name');
  }
});

// Returns true if the message text contains markers meaning "no longer available"
function isUnavailableMessage(text) {
  return text ? /💾|❌/.test(text) : false;
}

// Returns true when the text matches at least one keyword.
// If no keywords are configured, every message matches (no filter applied).
function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const lower = (text || '').toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ── Main message handler ─────────────────────────────────────────────────────
client.on('message_create', async (message) => {
  try {
    // Only handle group messages
    if (!message.from.endsWith('@g.us')) return;

    // Discovery mode — no groups configured yet, just print IDs to help setup
    if (targetGroupIds.size === 0) {
      console.log(`📋 Group message received — ID: ${message.from}`);
      console.log(`   Add to your .env: WHATSAPP_GROUPS=${message.from}:Group Name`);
      return;
    }

    if (!targetGroupIds.has(message.from)) return;

    const groupId = message.from;
    const groupName = groupsConfig.get(groupId) || groupId;

    // Read sender info directly from the message data — no Puppeteer call needed
    const rawAuthor = message.author || message._data?.author || '';
    // Strip the @c.us suffix to get a clean phone number.
    // If rawAuthor is empty (shouldn't happen in groups) store null rather than
    // falling back to the group ID, which is not a contactable phone number.
    const phone = rawAuthor ? rawAuthor.replace('@c.us', '') : null;
    const senderName = message._data?.notifyName || phone || groupName;

    console.log(`📨 [${groupName}] New message from ${senderName}`);

    const description = message.body?.trim();

    // ── Unavailability markers ──────────────────────────────────────────────
    // If the message contains 💾 or ❌ it signals an item is no longer available.
    if (isUnavailableMessage(description)) {
      if (message.hasQuotedMsg) {
        // Reply to an item post → remove that specific item
        try {
          const quoted = await message.getQuotedMessage();
          if (quoted) {
            const removed = deleteItemByMessageId(quoted.id.id);
            console.log(removed
              ? `  🗑️  Removed item (reply marked unavailable): ${quoted.id.id}`
              : `  ℹ️  Reply marked unavailable but item not found in DB`);
          }
        } catch (e) {
          console.warn('  ⚠️  Could not fetch quoted message:', e.message);
        }
      } else {
        // Standalone message → remove sender's most recent available item
        const removed = deleteLatestItemByPhone(phone);
        console.log(removed
          ? `  🗑️  Removed latest item from ${senderName} (standalone unavailable marker)`
          : `  ℹ️  Unavailable marker from ${senderName} but no matching item found`);
      }
      return;
    }

    // Skip messages without a photo — likely "looking for" requests, not offers
    if (!message.hasMedia) {
      console.log('  ⏭️  Skipping: no photo (probably a "looking for" message)');
      return;
    }

    // Skip messages that don't match the configured keywords (if any)
    if (!matchesKeywords(description, ENV_KEYWORDS)) {
      console.log(`  ⏭️  Skipping: no keyword match (keywords: ${ENV_KEYWORDS.join(', ')})`);
      return;
    }

    // Handle photo attachment
    let photoPath = null;
    try {
      const media = await message.downloadMedia();
      if (media && media.mimetype?.startsWith('image/')) {
        const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'jpg';
        const filename = `${Date.now()}_${message.id.id}.${ext}`;
        const filePath = path.join(UPLOADS_DIR, filename);
        fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
        photoPath = `/uploads/${filename}`;
        console.log(`  📷 Photo saved: ${filename}`);
      } else {
        console.log('  ⏭️  Skipping: media is not an image');
        return;
      }
    } catch (mediaErr) {
      console.warn('  ⚠️  Could not download media:', mediaErr.message);
      return;
    }

    const messageAt = message.timestamp
      ? new Date(message.timestamp * 1000).toISOString()
      : new Date().toISOString();

    const itemId = saveItem({
      messageId: message.id.id,
      description: description || '(ללא תיאור)',
      phone,
      senderName,
      photoPath,
      messageAt,
      groupId,
    });

    if (itemId) {
      console.log(`  ✅ Item saved (ID: ${itemId})`);
    } else {
      console.log('  ⏭️  Duplicate message, skipped');
    }
  } catch (err) {
    console.error('Error processing message:', err);
  }
});

// ── Edit handler ─────────────────────────────────────────────────────────────
// Fires when someone edits a message (e.g. seller adds 💾/❌ to their own post).
client.on('message_edit', (message, newBody) => {
  try {
    if (!targetGroupIds.has(message.from)) return;
    if (!isUnavailableMessage(newBody)) return;

    const removed = deleteItemByMessageId(message.id.id);
    const rawAuthor = message.author || message._data?.author || '';
    const senderName = message._data?.notifyName || rawAuthor.replace('@c.us', '');
    console.log(removed
      ? `  🗑️  Removed item (message edited to mark unavailable by ${senderName})`
      : `  ℹ️  Edited message marked unavailable but item not found in DB`);
  } catch (err) {
    console.error('Error processing message edit:', err);
  }
});

client.on('disconnected', (reason) => {
  console.log('Bot disconnected:', reason);
  client.initialize();
});

// ── History scanner ───────────────────────────────────────────────────────────
// Tracks the state of the background scan so the status endpoint can report it.
let scanState = { running: false, days: null, startedAt: null, result: null, error: null };

function getScanState() {
  return { ...scanState };
}

// Starts a background scan and returns immediately.
// groupId: which group to scan. If omitted, scans all configured groups sequentially.
function startScan(days, msgsPerDay, keywords = [], groupId = null) {
  if (scanState.running) return { alreadyRunning: true };

  const idsToScan = groupId
    ? [groupId]
    : [...targetGroupIds];

  if (idsToScan.length === 0) {
    return { error: 'No groups configured. Add WHATSAPP_GROUPS to your .env file and restart.' };
  }
  for (const id of idsToScan) {
    if (!id.endsWith('@g.us')) {
      return { error: `Invalid group ID "${id}". It must end with @g.us.` };
    }
  }

  scanState = { running: true, days, keywords, groupId, startedAt: new Date().toISOString(), result: null, error: null };

  // Run in background — do NOT await
  runScanAll(idsToScan, days, msgsPerDay, keywords).then(result => {
    scanState = { running: false, days, keywords, groupId, startedAt: scanState.startedAt, result, error: null };
  }).catch(err => {
    const message = err?.message || String(err);
    console.error('❌ Scan failed:', message);
    scanState = { running: false, days, keywords, groupId, startedAt: scanState.startedAt, result: null, error: message };
  });

  return { started: true };
}

// Scan multiple groups sequentially and aggregate results.
async function runScanAll(groupIds, days, msgsPerDay, keywords) {
  let totalFetched = 0, totalWithinWindow = 0, totalSaved = 0, totalSkipped = 0;
  for (const id of groupIds) {
    const r = await runScan(id, days, msgsPerDay, keywords);
    totalFetched += r.fetched;
    totalWithinWindow += r.withinWindow;
    totalSaved += r.saved;
    totalSkipped += r.skipped;
  }
  return { fetched: totalFetched, withinWindow: totalWithinWindow, saved: totalSaved, skipped: totalSkipped };
}

async function runScan(groupId, days, msgsPerDay = 100, keywords = []) {
  const groupName = groupsConfig.get(groupId) || groupId;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = Math.min(days * msgsPerDay, 5000);

  const keywordLabel = keywords.length ? ` | keywords: ${keywords.join(', ')}` : '';
  console.log(`\n🔍 [${groupName}] Scanning last ${days} day(s) — up to ${limit} messages${keywordLabel}...`);

  let chat;
  try {
    chat = await client.getChatById(groupId);
  } catch (err) {
    throw new Error(`Could not load "${groupName}": ${err?.message || err}`);
  }
  if (!chat) throw new Error(`Group not found: "${groupName}" (${groupId})`);

  console.log(`   Found chat: "${chat.name}" — loading messages...`);
  const messages = await chat.fetchMessages({ limit });
  console.log(`   Fetched ${messages.length} messages, processing...`);

  const relevant = messages.filter(msg => {
    if (msg.timestamp * 1000 < cutoffMs) return false;
    if (!msg.hasMedia) return false;
    if (isUnavailableMessage(msg.body)) return false;
    if (!matchesKeywords(msg.body, keywords)) return false;
    return true;
  });
  console.log(`   ${relevant.length} relevant messages with photos.`);

  const CONCURRENCY = 5;
  const photoPaths = new Array(relevant.length).fill(null);

  for (let i = 0; i < relevant.length; i += CONCURRENCY) {
    const batch = relevant.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (msg, batchIdx) => {
      try {
        const media = await msg.downloadMedia();
        if (media && media.mimetype?.startsWith('image/')) {
          const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'jpg';
          const filename = `${Date.now()}_${msg.id.id}.${ext}`;
          const filePath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
          photoPaths[i + batchIdx] = `/uploads/${filename}`;
        }
      } catch (_) { /* skip undownloadable media */ }
    }));
  }

  let saved = 0, skipped = 0;

  for (let idx = 0; idx < relevant.length; idx++) {
    const msg = relevant[idx];
    const photoPath = photoPaths[idx];
    if (!photoPath) continue;

    const rawAuthor = msg.author || msg._data?.author || '';
    const phone = rawAuthor ? rawAuthor.replace('@c.us', '') : null;
    const senderName = msg._data?.notifyName || phone;
    const description = msg.body?.trim();
    const messageAt = new Date(msg.timestamp * 1000).toISOString();

    const itemId = saveItem({
      messageId: msg.id.id,
      description: description || '(ללא תיאור)',
      phone,
      senderName,
      photoPath,
      messageAt,
      groupId,
    });

    if (itemId) saved++;
    else skipped++;
  }

  console.log(`✅ [${groupName}] Scan done — ${saved} new, ${skipped} duplicates.\n`);
  return { fetched: messages.length, withinWindow: relevant.length, saved, skipped };
}

client.initialize();

module.exports = { client, isReady: () => clientReady, startScan, getScanState, groupsConfig };
