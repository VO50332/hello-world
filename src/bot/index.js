// WhatsApp Bot — scan-only mode
// Uses whatsapp-web.js which controls WhatsApp Web in a hidden browser.
// On first run it will show a QR code — scan it with your phone to log in.
// Live monitoring has been removed; use the "Scan" panel on the website instead.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { saveItem, getConfiguredGroups } = require('../db');

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
  const configured = getConfiguredGroups();
  if (configured.length > 0) {
    console.log(`✅ WhatsApp ready — ${configured.length} group(s) configured for scanning:`);
    for (const g of configured) console.log(`   • "${g.name}" (${g.id})`);
  } else {
    console.log('✅ WhatsApp ready. No groups configured yet.');
    console.log('   Open the website and use ⚙️ ניהול קבוצות to add groups.');
  }
});

client.on('disconnected', (reason) => {
  console.log('Bot disconnected:', reason);
  client.initialize();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns true if the message body text contains markers meaning "no longer available"
function isUnavailableMessage(text) {
  return text ? /💾|❌/.test(text) : false;
}

// Returns true if the message has been reacted to with 💾 or ❌ (= no longer available)
function hasUnavailableReaction(msg) {
  const reactions = msg._data?.reactions;
  if (!Array.isArray(reactions) || reactions.length === 0) return false;
  return reactions.some(r => r.aggregateEmoji === '💾' || r.aggregateEmoji === '❌');
}

// Returns true when the text matches keywords.
// mode='or'  → at least one keyword must appear (default)
// mode='and' → every keyword must appear
// If no keywords are configured, every message matches (no filter applied).
function matchesKeywords(text, keywords, mode = 'or') {
  if (!keywords || keywords.length === 0) return true;
  const lower = (text || '').toLowerCase();
  return mode === 'and'
    ? keywords.every(k => lower.includes(k))
    : keywords.some(k => lower.includes(k));
}

// ── History scanner ───────────────────────────────────────────────────────────
// Groups are loaded fresh from the DB each time a scan starts, so any groups
// added via the web UI are picked up without restarting the server.

let scanState = { running: false, days: null, startedAt: null, result: null, error: null };

function getScanState() {
  return { ...scanState };
}

// Starts a background scan and returns immediately.
// groupId: which group to scan. If omitted, scans all configured groups sequentially.
function startScan(days, msgsPerDay, keywords = [], keywordMode = 'or', groupId = null) {
  if (scanState.running) return { alreadyRunning: true };

  // Load groups fresh from DB so newly added groups are included
  const configuredGroups = getConfiguredGroups();
  const configMap = new Map(configuredGroups.map(g => [g.id, g.name]));

  const idsToScan = groupId ? [groupId] : configuredGroups.map(g => g.id);

  if (idsToScan.length === 0) {
    return { error: 'אין קבוצות מוגדרות. הוסף קבוצה דרך ממשק הניהול (⚙️ ניהול קבוצות).' };
  }
  for (const id of idsToScan) {
    if (!id.endsWith('@g.us')) {
      return { error: `Invalid group ID "${id}". It must end with @g.us.` };
    }
  }

  scanState = { running: true, days, keywords, keywordMode, groupId, startedAt: new Date().toISOString(), result: null, error: null };

  // Run in background — do NOT await
  runScanAll(idsToScan, configMap, days, msgsPerDay, keywords, keywordMode).then(result => {
    scanState = { running: false, days, keywords, keywordMode, groupId, startedAt: scanState.startedAt, result, error: null };
  }).catch(err => {
    const message = err?.message || String(err);
    console.error('❌ Scan failed:', message);
    scanState = { running: false, days, keywords, keywordMode, groupId, startedAt: scanState.startedAt, result: null, error: message };
  });

  return { started: true };
}

// Scan multiple groups sequentially and aggregate results.
async function runScanAll(groupIds, configMap, days, msgsPerDay, keywords, keywordMode = 'or') {
  let totalFetched = 0, totalWithinWindow = 0, totalSaved = 0, totalSkipped = 0;
  for (const id of groupIds) {
    const r = await runScan(id, configMap.get(id) || id, days, msgsPerDay, keywords, keywordMode);
    totalFetched += r.fetched;
    totalWithinWindow += r.withinWindow;
    totalSaved += r.saved;
    totalSkipped += r.skipped;
  }
  return { fetched: totalFetched, withinWindow: totalWithinWindow, saved: totalSaved, skipped: totalSkipped };
}

async function runScan(groupId, groupName, days, msgsPerDay = 100, keywords = [], keywordMode = 'or') {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = days * msgsPerDay;

  const keywordLabel = keywords.length ? ` | keywords (${keywordMode.toUpperCase()}): ${keywords.join(', ')}` : '';
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
    if (hasUnavailableReaction(msg)) return false;
    if (!matchesKeywords(msg.body, keywords, keywordMode)) return false;
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

module.exports = { client, isReady: () => clientReady, startScan, getScanState };
