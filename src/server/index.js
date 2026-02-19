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

// ── Scan endpoints ────────────────────────────────────────────────────────────
// GET /api/scan?days=7  — starts a background scan and returns immediately.
// GET /api/scan/status  — check whether the scan is still running and see results.
app.get('/api/scan', (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
  const { startScan } = require('../bot');
  const outcome = startScan(days);

  if (outcome.error) return res.status(400).json({ ok: false, error: outcome.error });
  if (outcome.alreadyRunning) return res.json({ ok: true, status: 'already_running', message: 'A scan is already in progress. Check /api/scan/status for updates.' });

  res.json({ ok: true, status: 'started', days, message: `Scanning last ${days} days in the background. Open /api/scan/status to check progress.` });
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
