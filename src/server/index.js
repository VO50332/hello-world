// Express web server
// Serves the website and a simple JSON API for the frontend

const express = require('express');
const path = require('path');
const { getAvailableItems, getAllItems, markItemTaken, markItemAvailable, deleteItem } = require('../db');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

// Serve static files (website + uploaded photos)
app.use(express.static(path.join(__dirname, '../../public')));

// ── API Routes ───────────────────────────────────────────────────────────────

// GET /api/items — return available items (used by the website)
app.get('/api/items', (req, res) => {
  const showAll = req.query.all === 'true';
  const items = showAll ? getAllItems() : getAvailableItems();
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

// ── Scan endpoint ─────────────────────────────────────────────────────────────
// GET /api/scan?days=7  — open this URL in your browser while the bot is running
// to backfill the last N days of group messages into the database.
app.get('/api/scan', async (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
  try {
    // Lazy-require so this works even though server loads before bot
    const { scanHistory } = require('../bot');
    const result = await scanHistory(days);
    res.json({ ok: true, days, ...result });
  } catch (err) {
    const message = err?.message || String(err);
    console.error('❌ Scan failed:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌐 Website running at http://localhost:${PORT}`);
  console.log(`   Scan last 7 days : http://localhost:${PORT}/api/scan?days=7`);
  console.log(`   Scan last 30 days: http://localhost:${PORT}/api/scan?days=30`);
});

module.exports = app;
