// WhatsApp Bot — powered by Baileys (no browser required)
// On first run it will show a QR code — scan it with your phone to log in.
// Session is saved to .baileys_auth/ so you only need to scan once.

const {
  makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { saveItem, getConfiguredGroups } = require('../db');

// Where to save photos sent in the group
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const AUTH_DIR = path.join(__dirname, '../../.baileys_auth');

// Silent logger — suppresses Baileys' internal debug output
const logger = pino({ level: 'silent' });

// Manual message store: jid -> WAMessage[]
// Populated by messages.upsert and messaging-history.set events
const messageStore = new Map();

function storeMessages(messages) {
  for (const msg of messages) {
    const jid = msg.key?.remoteJid;
    if (!jid) continue;
    if (!messageStore.has(jid)) messageStore.set(jid, []);
    messageStore.get(jid).push(msg);
  }
}

let sock = null;
let clientReady = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUnavailableMessage(text) {
  return text ? /💾|❌/.test(text) : false;
}

function matchesKeywords(text, keywords, mode = 'or') {
  if (!keywords || keywords.length === 0) return true;
  const lower = (text || '').toLowerCase();
  return mode === 'and'
    ? keywords.every(k => lower.includes(k))
    : keywords.some(k => lower.includes(k));
}

// Extract plain text caption/body from a Baileys WAMessage
function getMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || '';
}

// ── History scanner ───────────────────────────────────────────────────────────

let scanState = { running: false, days: null, startedAt: null, result: null, error: null };

function getScanState() {
  return { ...scanState };
}

function startScan(days, msgsPerDay, keywords = [], keywordMode = 'or', groupId = null) {
  if (scanState.running) return { alreadyRunning: true };

  const configuredGroups = getConfiguredGroups();
  const configMap = new Map(configuredGroups.map(g => [g.id, g.name]));
  const idsToScan = groupId ? [groupId] : configuredGroups.map(g => g.id);

  if (idsToScan.length === 0)
    return { error: 'אין קבוצות מוגדרות. הוסף קבוצה דרך ממשק הניהול (⚙️ ניהול קבוצות).' };

  for (const id of idsToScan) {
    if (!id.endsWith('@g.us'))
      return { error: `Invalid group ID "${id}". It must end with @g.us.` };
  }

  scanState = { running: true, days, keywords, keywordMode, groupId, startedAt: new Date().toISOString(), result: null, error: null };

  runScanAll(idsToScan, configMap, days, msgsPerDay, keywords, keywordMode).then(result => {
    scanState = { running: false, days, keywords, keywordMode, groupId, startedAt: scanState.startedAt, result, error: null };
  }).catch(err => {
    const message = err?.message || String(err);
    console.error('❌ Scan failed:', message);
    scanState = { running: false, days, keywords, keywordMode, groupId, startedAt: scanState.startedAt, result: null, error: message };
  });

  return { started: true };
}

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
  const cutoffSec = cutoffMs / 1000;
  const limit = days * msgsPerDay;

  const keywordLabel = keywords.length ? ` | keywords (${keywordMode.toUpperCase()}): ${keywords.join(', ')}` : '';
  console.log(`\n🔍 [${groupName}] Scanning last ${days} day(s) — up to ${limit} messages${keywordLabel}...`);

  // Read messages from the manual store (populated via history sync + live messages)
  if (!messageStore.has(groupId)) {
    throw new Error(
      `No messages found in memory for "${groupName}". ` +
      `WhatsApp history sync may still be in progress — wait 1-2 minutes after connecting and try again.`
    );
  }

  const allMessages = messageStore.get(groupId);
  console.log(`   ${allMessages.length} messages in store, processing...`);

  const relevant = allMessages.filter(msg => {
    const ts = Number(msg.messageTimestamp);
    if (ts < cutoffSec) return false;
    if (!msg.message?.imageMessage) return false;  // images only
    const text = getMessageText(msg);
    if (isUnavailableMessage(text)) return false;
    if (!matchesKeywords(text, keywords, keywordMode)) return false;
    return true;
  }).slice(-limit);

  console.log(`   ${relevant.length} relevant messages with photos.`);

  const CONCURRENCY = 5;
  const photoPaths = new Array(relevant.length).fill(null);

  for (let i = 0; i < relevant.length; i += CONCURRENCY) {
    const batch = relevant.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (msg, batchIdx) => {
      try {
        const buffer = await downloadMediaMessage(
          msg, 'buffer', {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        if (buffer) {
          const ext = msg.message.imageMessage.mimetype?.split('/')[1]?.split(';')[0] || 'jpg';
          const filename = `${Date.now()}_${msg.key.id}.${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
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

    const rawParticipant = msg.key.participant || '';
    const phone = rawParticipant.replace('@s.whatsapp.net', '').replace('@c.us', '') || null;
    const senderName = msg.pushName || phone;
    const description = getMessageText(msg)?.trim();
    const messageAt = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

    const itemId = saveItem({
      messageId: msg.key.id,
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
  return { fetched: allMessages.length, withinWindow: relevant.length, saved, skipped };
}

// ── WhatsApp connection ───────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1017531287]; // bundled fallback
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // we print it ourselves via qrcode-terminal
    syncFullHistory: true,    // request full message history on connect
  });

  sock.ev.on('creds.update', saveCreds);

  // Accumulate live messages
  sock.ev.on('messages.upsert', ({ messages }) => storeMessages(messages));

  // Accumulate history sync (fires after connect with syncFullHistory: true)
  sock.ev.on('messaging-history.set', ({ messages }) => storeMessages(messages));

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nGo to WhatsApp → Settings → Linked Devices → Link a Device\n');
    }

    if (connection === 'open') {
      clientReady = true;
      const configured = getConfiguredGroups();
      if (configured.length > 0) {
        console.log(`✅ WhatsApp ready — ${configured.length} group(s) configured for scanning:`);
        for (const g of configured) console.log(`   • "${g.name}" (${g.id})`);
      } else {
        console.log('✅ WhatsApp ready. No groups configured yet.');
        console.log('   Open the website and use ⚙️ ניהול קבוצות to add groups.');
      }
      console.log('   ⏳ History sync is running in the background — wait ~1 min before scanning.');
    }

    if (connection === 'close') {
      clientReady = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      if (shouldReconnect) {
        console.log('🔄 Connection closed — reconnecting...');
        connectToWhatsApp();
      } else {
        console.log('🚪 Logged out. Delete .baileys_auth/ and restart to re-link.');
      }
    }
  });
}

// ── Get all WhatsApp groups the bot is a member of ───────────────────────────

async function getChats() {
  if (!sock) throw new Error('Not connected to WhatsApp');
  const participating = await sock.groupFetchAllParticipating();
  return Object.values(participating).map(g => ({
    id: g.id,
    name: g.subject,
    participants: g.participants?.length ?? '?',
  }));
}

connectToWhatsApp();

module.exports = { isReady: () => clientReady, getChats, startScan, getScanState };
