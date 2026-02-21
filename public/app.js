// Frontend JavaScript
// Fetches items from the API and renders them as cards

const grid = document.getElementById('items-grid');
const loading = document.getElementById('loading');
const empty = document.getElementById('empty');
const showTakenCheckbox = document.getElementById('showTaken');
const searchInput = document.getElementById('searchInput');

// All items fetched from the server — filtering happens client-side
let allItems = [];
let activeGroupId = null; // null = all groups

// ── Admin auth ────────────────────────────────────────────────────────────────
let adminToken = localStorage.getItem('adminToken') || '';

function isAdminMode() { return adminToken.length > 0; }

function authHeaders() {
  return adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {};
}

// Shows/hides admin-only UI elements based on current auth state.
// Called on page load and after any login/logout.
function applyAdminVisibility() {
  const admin = isAdminMode();
  const lockBtn = document.getElementById('lockBtn');
  if (lockBtn) lockBtn.textContent = admin ? '🔓 נעל ממשק' : '🔒 כניסת מנהל';
  const clearBtn = document.getElementById('clearAllBtn');
  if (clearBtn) clearBtn.style.display = admin ? '' : 'none';
  const groupsPanel = document.getElementById('groups-panel');
  if (groupsPanel) groupsPanel.style.display = admin ? '' : 'none';
  const scanPanel = document.getElementById('scan-panel');
  if (scanPanel) scanPanel.style.display = admin ? '' : 'none';
}

// Called when a protected API returns 401 (e.g. after a server restart).
function handleAuthError() {
  adminToken = '';
  localStorage.removeItem('adminToken');
  applyAdminVisibility();
  loadItems();
  alert('הפגישה פגה. הזן PIN שוב.');
}

async function toggleAdminMode() {
  if (isAdminMode()) {
    // Already unlocked → lock
    adminToken = '';
    localStorage.removeItem('adminToken');
    applyAdminVisibility();
    loadItems();
    return;
  }
  const pin = prompt('הזן PIN כדי לגשת לממשק הניהול:');
  if (pin === null) return; // user cancelled
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (data.ok) {
      adminToken = data.token;
      localStorage.setItem('adminToken', adminToken);
      applyAdminVisibility();
      loadItems(); // re-render cards with delete buttons
    } else {
      alert('PIN שגוי. נסה שנית.');
    }
  } catch (err) {
    alert('שגיאת רשת: ' + err.message);
  }
}

// Load groups and items when the page opens
document.addEventListener('DOMContentLoaded', () => {
  applyAdminVisibility(); // hide/show admin panels before data loads
  loadGroups().then(loadItems);
  initGroupsPanel();
});
showTakenCheckbox.addEventListener('change', loadItems);

// Filter locally as the user types — no extra network request.
// Also listen to 'search' so the browser's × clear button works correctly.
searchInput.addEventListener('input', renderItems);
searchInput.addEventListener('search', renderItems);

// ── Groups ─────────────────────────────────────────────────────────────────

let groups = []; // [{id, name, hasItems}]

async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    groups = await res.json();
    renderGroupTabs();
    populateScanGroupSelect();
  } catch (_) { /* groups tab is optional */ }
}

function renderGroupTabs() {
  const tabsEl = document.getElementById('group-tabs');
  if (groups.length < 2) { tabsEl.style.display = 'none'; return; }

  tabsEl.style.display = 'flex';
  tabsEl.innerHTML = '';

  const allBtn = makeTab('הכל', null);
  tabsEl.appendChild(allBtn);
  for (const g of groups) {
    tabsEl.appendChild(makeTab(g.name, g.id));
  }
}

function makeTab(label, groupId) {
  const btn = document.createElement('button');
  btn.className = 'group-tab' + (activeGroupId === groupId ? ' active' : '');
  btn.textContent = label;
  btn.onclick = () => {
    activeGroupId = groupId;
    document.querySelectorAll('.group-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadItems();
  };
  return btn;
}

function populateScanGroupSelect() {
  const sel = document.getElementById('scanGroupSelect');
  const label = document.getElementById('scanGroupLabel');
  if (groups.length < 2) { label.style.display = 'none'; return; }

  label.style.display = '';
  sel.innerHTML = '<option value="">כל הקבוצות</option>';
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  }
}

// ── Items ──────────────────────────────────────────────────────────────────

async function loadItems() {
  loading.style.display = 'block';
  empty.style.display = 'none';
  grid.innerHTML = '';

  try {
    const showAll = showTakenCheckbox.checked;
    let url = `/api/items${showAll ? '?all=true' : ''}`;
    if (activeGroupId) url += `${showAll ? '&' : '?'}group=${encodeURIComponent(activeGroupId)}`;

    const res = await fetch(url);
    allItems = await res.json();
    loading.style.display = 'none';
    renderItems();
  } catch (err) {
    loading.textContent = '⚠️ שגיאה בטעינת הפריטים. נסה לרענן את הדף.';
    console.error(err);
  }
}

function renderItems() {
  grid.innerHTML = '';
  const query = searchInput.value.trim().toLowerCase();

  const visible = query
    ? allItems.filter(item => item.description?.toLowerCase().includes(query))
    : allItems;

  empty.style.display = visible.length === 0 ? 'block' : 'none';
  visible.forEach(item => grid.appendChild(createCard(item)));
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = `item-card${item.is_taken ? ' taken' : ''}`;

  // ── Photo ────────────────────────────────────────────────────
  if (item.photo_path) {
    const img = document.createElement('img');
    img.className = 'item-photo';
    img.src = item.photo_path;
    img.alt = 'תמונת הפריט';
    img.loading = 'lazy';
    img.onclick = () => openModal(item.photo_path);
    card.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'no-photo';
    placeholder.textContent = '🎁';
    card.appendChild(placeholder);
  }

  // ── Body ─────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'item-body';

  // Status badge
  const badge = document.createElement('span');
  badge.className = `status-badge ${item.is_taken ? 'status-taken' : 'status-available'}`;
  badge.textContent = item.is_taken ? 'נלקח' : 'זמין';
  body.appendChild(badge);

  // Group tag (shown when more than one group exists)
  const groupName = groups.find(g => g.id === item.group_id)?.name;
  if (groupName && groups.length > 1) {
    const tag = document.createElement('span');
    tag.className = 'item-group-tag';
    tag.textContent = '📍 ' + groupName;
    body.appendChild(tag);
  }

  // Description text
  const desc = document.createElement('p');
  desc.className = 'item-description';
  desc.textContent = item.description;
  body.appendChild(desc);

  // Meta: contact + date
  const meta = document.createElement('div');
  meta.className = 'item-meta';

  // Contact — always shown
  const waPhone = (item.phone || '').replace(/\D/g, '');
  const contact = document.createElement('div');
  if (waPhone.length >= 7) {
    contact.className = 'item-contact';
    contact.innerHTML = `📞 <a href="https://wa.me/${waPhone}" target="_blank" rel="noopener">${
      item.sender_name || item.phone
    }</a>`;
  } else if (item.sender_name || item.phone) {
    contact.className = 'item-contact';
    contact.textContent = `📞 ${item.sender_name || item.phone}`;
  } else {
    contact.className = 'item-contact item-no-contact';
    contact.textContent = '⚠️ אין פרטי קשר';
  }
  meta.appendChild(contact);

  const date = document.createElement('div');
  date.className = 'item-date';
  date.textContent = `🕐 ${formatDate(item.message_at || item.created_at)}`;
  meta.appendChild(date);

  body.appendChild(meta);
  card.appendChild(body);

  // ── Action buttons ────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'item-actions';

  if (!item.is_taken) {
    const takenBtn = document.createElement('button');
    takenBtn.className = 'btn btn-taken';
    takenBtn.textContent = 'סמן כנלקח';
    takenBtn.onclick = async () => {
      await fetch(`/api/items/${item.id}/taken`, { method: 'PATCH' });
      loadItems();
    };
    actions.appendChild(takenBtn);
  } else {
    const availBtn = document.createElement('button');
    availBtn.className = 'btn btn-avail';
    availBtn.textContent = 'סמן כזמין';
    availBtn.onclick = async () => {
      await fetch(`/api/items/${item.id}/available`, { method: 'PATCH' });
      loadItems();
    };
    actions.appendChild(availBtn);
  }

  if (isAdminMode()) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-delete';
    deleteBtn.textContent = 'מחק';
    deleteBtn.onclick = async () => {
      if (confirm('למחוק את הפריט?')) {
        const res = await fetch(`/api/items/${item.id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.status === 401) { handleAuthError(); return; }
        loadItems();
      }
    };
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  return card;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function openModal(src) {
  document.getElementById('modal-img').src = src;
  document.getElementById('photo-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('photo-modal').style.display = 'none';
}

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// Refresh the list every 30 seconds automatically
setInterval(loadItems, 30_000);

async function clearAllItems() {
  if (!confirm('למחוק את כל הפריטים? פעולה זו אינה ניתנת לביטול.')) return;
  const res = await fetch('/api/items', { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) { handleAuthError(); return; }
  loadItems();
}

// ── Groups management panel ───────────────────────────────────────────────────

let availableChats = [];   // all WhatsApp groups from /api/chats
let chatsFetched = false;

function initGroupsPanel() {
  const details = document.getElementById('groups-details');
  // Lazy-load the available chats list the first time the panel is opened
  details.addEventListener('toggle', () => {
    if (details.open && !chatsFetched) fetchAvailableChats();
    renderConfiguredGroups();
  });
  document.getElementById('groupSearchInput').addEventListener('input', e => {
    renderAvailableGroups(e.target.value);
  });
}

async function fetchAvailableChats() {
  const statusEl = document.getElementById('chats-status');
  statusEl.textContent = '⏳ טוען רשימת קבוצות מ-WhatsApp...';
  try {
    const res = await fetch('/api/chats', { headers: authHeaders() });
    if (res.status === 401) { handleAuthError(); return; }
    const data = await res.json();
    if (data.ok) {
      availableChats = data.groups || [];
      chatsFetched = true;
      statusEl.textContent = availableChats.length
        ? `נמצאו ${availableChats.length} קבוצות — חפש לפי שם:`
        : 'לא נמצאו קבוצות';
    } else {
      statusEl.textContent = `⚠️ ${data.error}`;
    }
  } catch (err) {
    statusEl.textContent = `⚠️ שגיאת רשת: ${err.message}`;
  }
  renderAvailableGroups('');
}

function renderConfiguredGroups() {
  const list = document.getElementById('configured-groups-list');
  list.innerHTML = '';
  if (groups.length === 0) {
    list.innerHTML = '<p class="no-groups-msg">אין קבוצות מוגדרות עדיין</p>';
    return;
  }
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'configured-group-row';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = g.name;
    nameSpan.title = g.id;

    const idSmall = document.createElement('small');
    idSmall.textContent = g.id;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-delete btn-sm';
    removeBtn.textContent = 'הסר';
    removeBtn.onclick = async () => {
      const res = await fetch('/api/groups/' + encodeURIComponent(g.id), { method: 'DELETE', headers: authHeaders() });
      if (res.status === 401) { handleAuthError(); return; }
      await loadGroups();
      renderConfiguredGroups();
      renderAvailableGroups(document.getElementById('groupSearchInput').value);
    };

    row.appendChild(nameSpan);
    row.appendChild(idSmall);
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
}

function renderAvailableGroups(query) {
  const list = document.getElementById('available-groups-list');
  list.innerHTML = '';
  if (!chatsFetched) return;

  const q = query.trim().toLowerCase();
  const configuredIds = new Set(groups.map(g => g.id));
  const filtered = availableChats.filter(c =>
    !configuredIds.has(c.id) && (!q || c.name.toLowerCase().includes(q))
  );

  if (filtered.length === 0) {
    list.innerHTML = `<p class="no-groups-msg">${
      availableChats.length === 0 ? 'לא נמצאו קבוצות' : 'כל הקבוצות כבר מוגדרות'
    }</p>`;
    return;
  }

  for (const chat of filtered.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'available-group-row';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = chat.name;

    const countSmall = document.createElement('small');
    countSmall.textContent = `${chat.participants} משתתפים`;

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-scan btn-sm';
    addBtn.textContent = 'הוסף';
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: chat.id, name: chat.name }),
      });
      if (res.status === 401) { handleAuthError(); return; }
      await loadGroups();
      renderConfiguredGroups();
      renderAvailableGroups(document.getElementById('groupSearchInput').value);
    };

    row.appendChild(nameSpan);
    row.appendChild(countSmall);
    row.appendChild(addBtn);
    list.appendChild(row);
  }
}

// ── Scan panel ────────────────────────────────────────────────────────────────

let scanPoller = null;

async function triggerScan() {
  const days = document.getElementById('scanDays').value || 30;
  const rawKeywords = document.getElementById('scanKeywords').value.trim();
  const groupId = document.getElementById('scanGroupSelect')?.value || '';
  const statusEl = document.getElementById('scan-status');
  const btn = document.getElementById('scanBtn');

  const keywordMode = document.getElementById('keywordMode')?.value || 'or';
  let url = `/api/scan?days=${encodeURIComponent(days)}&msgsPerDay=500`;
  if (rawKeywords) url += `&keywords=${encodeURIComponent(rawKeywords)}&keywordMode=${keywordMode}`;
  if (groupId) url += `&groupId=${encodeURIComponent(groupId)}`;

  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.className = 'scan-status running';
  statusEl.textContent = '⏳ מתחיל סריקה...';

  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 401) { handleAuthError(); btn.disabled = false; return; }
    const data = await res.json();
    if (!data.ok) {
      statusEl.className = 'scan-status error';
      statusEl.textContent = `❌ שגיאה: ${data.error}`;
      btn.disabled = false;
      return;
    }
    if (data.status === 'already_running') {
      statusEl.textContent = '⏳ סריקה כבר רצה ברקע...';
    } else {
      const kwMode = rawKeywords && keywordMode === 'and' ? ' (AND)' : rawKeywords ? ' (OR)' : '';
      const kw = rawKeywords ? ` | מילות מפתח${kwMode}: ${rawKeywords}` : '';
      statusEl.textContent = `⏳ סורק ${days} ימים (עד ${data.limit} הודעות)${kw}...`;
    }
    pollScanStatus();
  } catch (err) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = `❌ שגיאת רשת: ${err.message}`;
    btn.disabled = false;
  }
}

function pollScanStatus() {
  clearInterval(scanPoller);
  scanPoller = setInterval(async () => {
    try {
      const res = await fetch('/api/scan/status');
      const data = await res.json();
      const statusEl = document.getElementById('scan-status');
      const btn = document.getElementById('scanBtn');

      if (data.status === 'running') {
        statusEl.className = 'scan-status running';
        statusEl.textContent = '⏳ סריקה פעילה — נא המתן...';
        return;
      }

      clearInterval(scanPoller);
      btn.disabled = false;

      if (data.status === 'done') {
        const r = data.result;
        statusEl.className = 'scan-status done';
        statusEl.textContent =
          `✅ סריקה הסתיימה — ${r.saved} פריטים נשמרו, ${r.skipped} כפילויות, ${r.withinWindow} הודעות רלוונטיות מתוך ${r.fetched} שנמשכו`;
        loadItems(); // refresh the grid
      } else if (data.status === 'error') {
        statusEl.className = 'scan-status error';
        statusEl.textContent = `❌ הסריקה נכשלה: ${data.error}`;
      }
    } catch (_) { /* network hiccup — try again next tick */ }
  }, 3000);
}
