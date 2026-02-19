// Express web server
// Serves the website and a simple JSON API for the frontend

const express = require('express');
const path = require('path');
const { getAvailableItems, getAllItems, getGroupIds, markItemTaken, markItemAvailable, deleteItem } = require('../db');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

// Serve static files (website + uploaded photos)
app.use(express.static(path.join(__dirname, '../../public')));

// ── API Routes ───────────────────────────────────────────────────────────────

// GET /api/groups — return configured groups (id + name) and which IDs exist in DB
app.get('/api/groups', (req, res) => {
  const { groupsConfig } = require('../bot');
  const dbIds = new Set(getGroupIds());
  const groups = [...groupsConfig.entries()].map(([id, name]) => ({
    id,
    name,
    hasItems: dbIds.has(id),
  }));
  // Also include any groups in DB not in config (e.g. old data)
  for (const id of dbIds) {
    if (!groupsConfig.has(id)) groups.push({ id, name: id, hasItems: true });
  }
  res.json(groups);
});

// GET /api/items — return available items (used by the website)
// Optional ?group=<groupId> to filter by group, ?all=true to include taken items.
app.get('/api/items', (req, res) => {
  const showAll = req.query.all === 'true';
  const groupId = req.query.group || null;
  const items = showAll ? getAllItems(groupId) : getAvailableItems(groupId);
  res.json(items);
});

// PATCH /api/items/:id/taken — mark an item as taken
app.patch('/api/items/:id/taken', (req, res) => {
  markItemTaken(Number(req.params.id));
  res.json({ ok: true });
});

// PATCH /api/items/:id/available — mark an item as available again
app.patch('/api/items/:id/available', (req, res) => {
  markItemAvailable(Number(req.params.id));
  res.json({ ok: true });
});

// DELETE /api/items/:id — remove an item
app.delete('/api/items/:id', (req, res) => {
  deleteItem(Number(req.params.id));
  res.json({ ok: true });
});

// ── Scan endpoints ────────────────────────────────────────────────────────────
// GET /api/chats   — list all WhatsApp groups the bot is a member of.
// GET /api/scan?days=7  — starts a background scan and returns immediately.
// GET /api/scan/status  — check whether the scan is still running and see results.
app.get('/api/chats', async (req, res) => {
  try {
    const { client, isReady } = require('../bot');
    if (!isReady()) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client is not ready yet. Wait for the QR code to be scanned and the bot to print "✅ Bot is running!", then try again.' });
    }
    const chats = await client.getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(c => ({ id: c.id._serialized, name: c.name, participants: c.participants?.length ?? '?' }));
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});
app.get('/api/scan', (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 180));
  const msgsPerDay = Math.max(10, Math.min(Number(req.query.msgsPerDay) || 100, 500));
  const keywords = req.query.keywords
    ? req.query.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : [];
  const groupId = req.query.groupId || null;

  const { startScan } = require('../bot');
  const outcome = startScan(days, msgsPerDay, keywords, groupId);

  if (outcome.error) return res.status(400).json({ ok: false, error: outcome.error });
  if (outcome.alreadyRunning) return res.json({ ok: true, status: 'already_running', message: 'Scan already running. Check /api/scan/status.' });

  const limit = days * msgsPerDay;
  res.json({ ok: true, status: 'started', days, msgsPerDay, keywords, groupId, limit,
    message: `Scan started for last ${days} days${groupId ? ` in ${groupId}` : ' (all groups)'}${keywords.length ? ` | keywords: ${keywords.join(', ')}` : ''}.` });
});

app.get('/api/scan/status', (req, res) => {
  const { getScanState } = require('../bot');
  const state = getScanState();
  const status = state.running ? 'running' : state.error ? 'error' : state.result ? 'done' : 'idle';
  res.json({ ok: true, status, ...state });
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌐 Website running at http://localhost:${PORT}`);
  console.log(`   Start scan (7 days) : http://localhost:${PORT}/api/scan?days=7`);
  console.log(`   Start scan (30 days): http://localhost:${PORT}/api/scan?days=30`);
  console.log(`   Check scan progress : http://localhost:${PORT}/api/scan/status`);
});

module.exports = app;
