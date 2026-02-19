// Frontend JavaScript
// Fetches items from the API and renders them as cards

const grid = document.getElementById('items-grid');
const loading = document.getElementById('loading');
const empty = document.getElementById('empty');
const showTakenCheckbox = document.getElementById('showTaken');
const searchInput = document.getElementById('searchInput');

// All items fetched from the server — filtering happens client-side
let allItems = [];

// Load from server when page opens or "show taken" changes
document.addEventListener('DOMContentLoaded', loadItems);
showTakenCheckbox.addEventListener('change', loadItems);

// Filter locally as the user types — no extra network request
searchInput.addEventListener('input', renderItems);

async function loadItems() {
  loading.style.display = 'block';
  empty.style.display = 'none';
  grid.innerHTML = '';

  try {
    const showAll = showTakenCheckbox.checked;
    const res = await fetch(`/api/items${showAll ? '?all=true' : ''}`);
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

  if (visible.length === 0) {
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    visible.forEach(item => grid.appendChild(createCard(item)));
  }
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

  // Description text
  const desc = document.createElement('p');
  desc.className = 'item-description';
  desc.textContent = item.description;
  body.appendChild(desc);

  // Meta: contact + date
  const meta = document.createElement('div');
  meta.className = 'item-meta';

  if (item.phone) {
    const contact = document.createElement('div');
    contact.className = 'item-contact';
    contact.innerHTML = `📞 <a href="https://wa.me/${item.phone}" target="_blank" rel="noopener">${
      item.sender_name || item.phone
    }</a>`;
    meta.appendChild(contact);
  }

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

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-delete';
  deleteBtn.textContent = 'מחק';
  deleteBtn.onclick = async () => {
    if (confirm('למחוק את הפריט?')) {
      await fetch(`/api/items/${item.id}`, { method: 'DELETE' });
      loadItems();
    }
  };
  actions.appendChild(deleteBtn);

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
