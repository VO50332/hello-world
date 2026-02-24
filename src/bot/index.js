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
const { saveItem, getConfiguredGroups, saveRawMessages, loadRawMessages } = require('../db');

// Where to save photos sent in the group
// All persistent data lives under data/ so a single Railway Volume covers everything
const UPLOADS_DIR = path.join(__dirname, '../../data/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const AUTH_DIR = path.join(__dirname, '../../data/baileys_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Silent logger — suppresses Baileys' internal debug output
const logger = pino({ level: 'silent' });

// Manual message store: jid -> WAMessage[]
// Pre-loaded from SQLite on startup; live messages + history sync add to it.
const messageStore = new Map();

// Pre-load persisted messages so the store works immediately on restart
let preloadedFromDB = false;
{
  const loaded = loadRawMessages();
  let total = 0;
  for (const [jid, msgs] of loaded) {
    messageStore.set(jid, msgs);
    total += msgs.length;
  }
  if (total > 0) {
    preloadedFromDB = true;
    console.log(`📦 Loaded ${total} persisted messages across ${messageStore.size} groups from DB.`);
  }
}

// History sync tracking
let historySyncComplete = false;
let historySyncBatches = 0;
let lastHistorySyncAt = null;
let historySyncTimer = null; // debounce timer to detect "sync done" on reconnects

function markHistorySyncComplete(reason) {
  if (historySyncComplete) return;
  historySyncComplete = true;
  let total = 0;
  for (const msgs of messageStore.values()) total += msgs.length;
  console.log(`   ✅ History sync complete (${reason}) — ${total} messages across ${messageStore.size} groups.`);
  // After sync completes, request on-demand history for any configured group
  // whose messages are still missing from the store.
  requestMissingGroupHistory();
}

// Called on connection open and after each sync batch.
// If no new history events arrive within the delay, considers sync done.
function scheduleHistorySyncComplete(delayMs) {
  clearTimeout(historySyncTimer);
  historySyncTimer = setTimeout(() => markHistorySyncComplete(`no activity for ${delayMs / 1000}s`), delayMs);
}

// After history sync finishes, request on-demand history for configured groups
// that are missing from the message store (common on reconnects).
async function requestMissingGroupHistory() {
  if (!sock) return;
  const configured = getConfiguredGroups();
  for (const g of configured) {
    if (messageStore.has(g.id) && messageStore.get(g.id).length > 0) continue;
    console.log(`📡 Requesting on-demand history for "${g.name}" (${g.id})...`);
    try {
      // Use fetchMessageHistory with a synthetic key:
      //   - chatJid = the group's JID
      //   - fromMe/id/timestamp can be synthetic since we want the "latest" messages
      // WhatsApp will respond via messaging-history.set with syncType ON_DEMAND
      await sock.fetchMessageHistory(
        50,  // request up to 50 messages
        { remoteJid: g.id, fromMe: false, id: '3EB0' + Date.now().toString(16).toUpperCase() },
        Date.now()
      );
      console.log(`   ✅ On-demand history request sent for "${g.name}".`);
    } catch (err) {
      console.warn(`   ⚠️ Failed to request history for "${g.name}": ${err?.message || err}`);
    }
  }
}

function storeMessages(messages) {
  for (const msg of messages) {
    const jid = msg.key?.remoteJid;
    if (!jid) continue;
    if (!messageStore.has(jid)) messageStore.set(jid, []);
    messageStore.get(jid).push(msg);
  }
  // Persist to DB so messages survive restarts
  try { saveRawMessages(messages); } catch (_) { /* non-fatal */ }
}

function getSyncStatus() {
  const groupCounts = {};
  for (const [jid, msgs] of messageStore) {
    groupCounts[jid] = msgs.length;
  }
  return {
    historySyncComplete,
    historySyncBatches,
    lastHistorySyncAt,
    totalGroups: messageStore.size,
    groupCounts,
  };
}

let sock = null;
let clientReady = false;
let currentQr = null; // latest QR string (null once authenticated)

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

  // Read messages from the manual store (populated via history sync + live messages).
  // If messages are missing, either wait for sync or request on-demand history.
  if (!messageStore.has(groupId)) {
    const storeJids = [...messageStore.keys()];
    console.warn(`⚠️  [${groupName}] Group "${groupId}" not found in store.`);
    console.warn(`   Store contains ${storeJids.length} group(s): ${storeJids.join(', ') || '(empty)'}`);

    // If history sync already finished without this group, request on-demand history
    if (historySyncComplete && sock) {
      console.log(`   📡 Requesting on-demand history for "${groupName}"...`);
      try {
        await sock.fetchMessageHistory(
          50,
          { remoteJid: groupId, fromMe: false, id: '3EB0' + Date.now().toString(16).toUpperCase() },
          Date.now()
        );
      } catch (err) {
        console.warn(`   ⚠️ On-demand request failed: ${err?.message || err}`);
      }
    }

    // Wait for messages to arrive (from either regular sync or on-demand request)
    console.log(`   ⏳ Waiting for messages for "${groupName}"...`);
    const WAIT_TIMEOUT = 30_000; // 30 seconds
    const POLL_INTERVAL = 2_000; // check every 2s
    const waitStart = Date.now();
    while (!messageStore.has(groupId) && Date.now() - waitStart < WAIT_TIMEOUT) {
      // If sync just finished AND we're not expecting an on-demand response, break
      if (historySyncComplete && !sock) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    if (!messageStore.has(groupId)) {
      const storeJids2 = [...messageStore.keys()];
      const hint = storeJids2.length > 0
        ? `\nGroups in store: ${storeJids2.join(', ')}`
        : '\nThe message store is empty — WhatsApp did not send any history.';
      throw new Error(
        `No messages found for "${groupName}" (${groupId}).${hint}\n` +
        'Possible fixes:\n' +
        '• Open "Vinted Haifa" on your phone and send/view a message, then retry\n' +
        '• Delete the data/baileys_auth folder and restart to do a fresh QR scan\n' +
        '• Wait for new messages to arrive in the group'
      );
    }
    console.log(`   ✅ Messages arrived for "${groupName}" after ${Math.round((Date.now() - waitStart) / 1000)}s.`);
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

  // Accumulate history sync (fires after connect with syncFullHistory: true).
  // isLatest=true means this is the final batch.  On reconnects WhatsApp may
  // skip isLatest entirely, so we also use an idle timer as a fallback.
  // syncType values: 0=INITIAL_BOOTSTRAP, 2=FULL, 3=RECENT, 6=ON_DEMAND
  sock.ev.on('messaging-history.set', ({ messages, chats, isLatest, syncType, progress }) => {
    storeMessages(messages);
    historySyncBatches++;
    lastHistorySyncAt = new Date().toISOString();

    const chatJids = (chats || []).map(c => c.id).filter(Boolean);
    console.log(`   📥 History batch #${historySyncBatches}: ${messages.length} msgs, ${chatJids.length} chats, syncType=${syncType ?? '?'}, progress=${progress ?? '?'}, isLatest=${isLatest}`);
    if (chatJids.length > 0 && chatJids.length <= 20) {
      console.log(`      Chats: ${chatJids.join(', ')}`);
    }

    if (isLatest) {
      clearTimeout(historySyncTimer);
      markHistorySyncComplete('isLatest=true');
    } else {
      // Reset idle timer — consider done 15s after the last batch
      scheduleHistorySyncComplete(15_000);
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQr = qr; // expose via /api/qr for Railway deployments
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nOr open  <your-app-url>/qr  in a browser to scan.\n');
      console.log('Go to WhatsApp → Settings → Linked Devices → Link a Device\n');
    }

    if (connection === 'open') {
      currentQr = null; // no longer needed
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
      // Fallback: if no history events arrive within 20s of connecting (e.g. on
      // a reconnect), mark sync as complete so scans are not blocked.
      // If the DB was preloaded, a shorter 5s grace period is enough.
      scheduleHistorySyncComplete(preloadedFromDB ? 5_000 : 20_000);
    }

    if (connection === 'close') {
      clientReady = false;
      historySyncComplete = false;
      historySyncBatches = 0;
      lastHistorySyncAt = null;
      clearTimeout(historySyncTimer);
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

module.exports = { isReady: () => clientReady, getQr: () => currentQr, getChats, startScan, getScanState, getSyncStatus };
