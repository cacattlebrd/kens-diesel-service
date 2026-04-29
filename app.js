// Ken's Diesel Service - App Logic v2 (Ticket-based)
// Phase 1: Local browser storage. Drive sync added later.

const APP_VERSION = '1.0.8';
const STORAGE_KEY = 'kens-mechanic-data';
const SCHEMA_VERSION = 2;

// ---------------- DATA MODEL ----------------
let data = {
  schemaVersion: SCHEMA_VERSION,
  customers: [],
  tickets: [],
  invoices: [],
  // Legacy v1 array kept for migration only - not used after migration
  timeEntries: [],
  settings: {
    businessName: "Ken's Diesel Service",
    ownerName: "Kenneth Wayne Stevens Jr",
    address: "222 E Mitchell St apt 5213\nSan Antonio, TX 78210",
    email: "kensmechanicservice@gmail.com",
    phone: "(210) 529-0883",
    paymentInstructions: "Pay by Zelle (no fees):\n  Email: muzzleflash9600@gmail.com\n  Phone: (210) 529-0883\nName on Zelle: Kenneth Stevens\n\nOR mail check payable to: Kenneth Wayne Stevens Jr\n222 E Mitchell St apt 5213, San Antonio, TX 78210",
    nextInvoiceNumber: 1
  }
};

// In-progress invoice line items (working buffer)
let currentInvoiceLines = [];

// ---------------- ERROR LOG (for diagnostics) ----------------
const errorLog = [];
const MAX_ERRORS = 20;
window.addEventListener('error', e => {
  errorLog.push({
    time: new Date().toISOString(),
    msg: e.message,
    src: e.filename + ':' + e.lineno + ':' + e.colno,
    stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 800) : null
  });
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
});
window.addEventListener('unhandledrejection', e => {
  errorLog.push({
    time: new Date().toISOString(),
    msg: 'Unhandled promise: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)).slice(0, 200),
    src: 'promise'
  });
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
});

// ---------------- AUTO-UPDATE CHECK ----------------
// Checks for a newer version on GitHub Pages. If found, shows a banner
// that lets the user reload to get the new version (busts cache).
async function checkForUpdate() {
  try {
    // Cache-bust by appending a timestamp
    const url = './version.json?_=' + Date.now();
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return;
    const remote = await res.json();
    if (!remote || !remote.version) return;
    if (compareVersions(remote.version, APP_VERSION) > 0) {
      showUpdateBanner(remote.version, remote.notes || '');
    }
  } catch (e) {
    // Silent — no internet or version.json missing is fine
  }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function showUpdateBanner(newVersion, notes) {
  // Don't show if already showing
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <div style="background:#0d1626; color:#00bfff; padding:12px 16px; display:flex; align-items:center; gap:10px; border-bottom:2px solid #00bfff; font-size:14px; font-weight:600; cursor:pointer; position:sticky; top:0; z-index:101;">
      <span style="font-size:18px;">⬇</span>
      <div style="flex:1;">
        <div>Update Available — v${newVersion}</div>
        ${notes ? `<div style="font-size:12px; font-weight:normal; color:#a0d8ef; margin-top:2px;">${notes}</div>` : ''}
      </div>
      <button id="update-now-btn" style="background:#00bfff; color:#0d1626; border:none; padding:8px 14px; border-radius:6px; font-weight:700; cursor:pointer; font-size:13px;">Update Now</button>
    </div>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  document.getElementById('update-now-btn').onclick = forceUpdate;
}

function forceUpdate() {
  // Hard reload, bypassing cache
  showToast('Updating...');
  setTimeout(() => {
    // location.reload(true) is deprecated but still works in many browsers
    // Adding a query param forces a full re-fetch of all assets
    const url = window.location.href.split('?')[0] + '?v=' + Date.now();
    window.location.href = url;
  }, 400);
}

// ---------------- DRIVE SYNC ----------------
// Paste the Client ID from Google Cloud Console here.
// (chadcrocker@cacattlebrd.com → Cloud Console → Credentials → OAuth 2.0 Client ID)
const GOOGLE_CLIENT_ID = '228853916026-knnf7p30p3868gbmgleq8gec8edjasuv.apps.googleusercontent.com';
const DRIVE_FILE_NAME = 'kens-diesel-service-data.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

let driveState = {
  enabled: false,            // true once Client ID is configured
  signedIn: false,
  accessToken: null,
  tokenExpiresAt: 0,
  driveFileId: null,         // Drive file ID once located/created
  lastSyncedAt: null,
  saveTimer: null,
  syncInProgress: false,
  tokenClient: null,         // Google's OAuth token client
  pendingChanges: false      // dirty flag — true if local has unsaved changes
};

function setSyncStatus(state, text) {
  const btn = document.getElementById('sync-btn');
  if (!btn) return;
  btn.classList.remove('synced', 'syncing', 'error');
  if (state) btn.classList.add(state);
  btn.textContent = text;
}

function initDriveSync() {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('TODO') !== -1 || GOOGLE_CLIENT_ID === '') {
    driveState.enabled = false;
    setSyncStatus('', 'Local Only');
    document.getElementById('sync-btn').title = 'Drive sync not configured yet';
    document.getElementById('sync-btn').onclick = () => {
      showToast('Drive sync not configured yet — local-only mode', false);
    };
    return;
  }

  driveState.enabled = true;
  // Wait for Google Identity Services script to load
  function tryInit() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      setTimeout(tryInit, 200);
      return;
    }
    driveState.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: handleAuthResponse
    });
    setSyncStatus('', 'Sign In');
    document.getElementById('sync-btn').onclick = signIn;
  }
  tryInit();
}

function signIn() {
  if (!driveState.tokenClient) {
    showToast('Sign-in not ready yet — try again in a moment', true);
    return;
  }
  setSyncStatus('syncing', 'Signing In...');
  // Request token. If user has never granted, will prompt; if granted, returns silently.
  driveState.tokenClient.requestAccessToken({ prompt: driveState.signedIn ? '' : 'consent' });
}

function handleAuthResponse(resp) {
  if (resp.error) {
    setSyncStatus('error', 'Sign In');
    showToast('Sign-in failed: ' + resp.error, true);
    return;
  }
  driveState.accessToken = resp.access_token;
  driveState.tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
  driveState.signedIn = true;
  setSyncStatus('syncing', 'Syncing...');
  // Now find or create the data file in Drive, then pull the latest
  syncFromDrive().then(() => {
    setSyncStatus('synced', 'Synced');
    document.getElementById('sync-btn').onclick = manualSyncClick;
  }).catch(err => {
    console.error('Initial sync error:', err);
    setSyncStatus('error', 'Sync Error');
    showToast('Could not sync from Drive: ' + (err.message || 'unknown'), true);
  });
}

function manualSyncClick() {
  // If clicked when synced, force a re-sync (pull fresh from Drive)
  setSyncStatus('syncing', 'Syncing...');
  syncFromDrive().then(() => {
    setSyncStatus('synced', 'Synced');
    showToast('Synced from Drive');
  }).catch(err => {
    setSyncStatus('error', 'Sync Error');
    showToast('Sync failed: ' + (err.message || 'unknown'), true);
  });
}

async function ensureToken() {
  if (!driveState.signedIn) throw new Error('not signed in');
  if (Date.now() >= driveState.tokenExpiresAt) {
    // Token expired — silent re-auth
    return new Promise((resolve, reject) => {
      driveState.tokenClient.callback = (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else {
          driveState.accessToken = resp.access_token;
          driveState.tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
          // restore default callback
          driveState.tokenClient.callback = handleAuthResponse;
          resolve();
        }
      };
      driveState.tokenClient.requestAccessToken({ prompt: '' });
    });
  }
}

async function driveFetch(url, opts) {
  await ensureToken();
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {}, {
    'Authorization': 'Bearer ' + driveState.accessToken
  });
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Drive API ' + res.status + ': ' + text.slice(0, 200));
  }
  return res;
}

async function findOrCreateDriveFile() {
  // Search for existing file in appDataFolder
  const searchUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent("name='" + DRIVE_FILE_NAME + "'")}&fields=files(id,name,modifiedTime)`;
  const res = await driveFetch(searchUrl);
  const json = await res.json();
  if (json.files && json.files.length > 0) {
    driveState.driveFileId = json.files[0].id;
    return { id: json.files[0].id, modifiedTime: json.files[0].modifiedTime, isNew: false };
  }
  // Create empty file
  const meta = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
  const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const created = await createRes.json();
  driveState.driveFileId = created.id;
  return { id: created.id, isNew: true };
}

async function downloadDriveFile() {
  if (!driveState.driveFileId) return null;
  const url = `https://www.googleapis.com/drive/v3/files/${driveState.driveFileId}?alt=media`;
  const res = await driveFetch(url);
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function uploadDriveFile(payload) {
  if (!driveState.driveFileId) return;
  const url = `https://www.googleapis.com/upload/drive/v3/files/${driveState.driveFileId}?uploadType=media`;
  await driveFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function syncFromDrive() {
  if (!driveState.signedIn) return;
  driveState.syncInProgress = true;
  try {
    const fileInfo = await findOrCreateDriveFile();
    const remote = fileInfo.isNew ? null : await downloadDriveFile();

    if (!remote) {
      // No remote data — push local up
      await pushToDrive();
    } else {
      // Compare timestamps. Last-write-wins.
      const remoteTs = remote._lastModified || 0;
      const localTs = data._lastModified || 0;
      if (remoteTs > localTs) {
        // Remote is newer — replace local
        data = remote;
        saveDataLocal(); // skip drive push
        showToast('Pulled latest from Drive');
        // Refresh whatever screen is showing
        const active = document.querySelector('.screen.active');
        if (active && active.id === 'screen-dashboard') renderDashboard();
      } else if (localTs > remoteTs) {
        // Local newer — push up
        await pushToDrive();
      }
      // Equal: nothing to do
    }
    driveState.lastSyncedAt = Date.now();
  } finally {
    driveState.syncInProgress = false;
  }
}

async function pushToDrive() {
  if (!driveState.signedIn || !driveState.driveFileId) return;
  data._lastModified = Date.now();
  await uploadDriveFile(data);
  driveState.pendingChanges = false;
  driveState.lastSyncedAt = Date.now();
}

function scheduleDrivePush() {
  if (!driveState.enabled || !driveState.signedIn) return;
  driveState.pendingChanges = true;
  setSyncStatus('syncing', 'Saving...');
  if (driveState.saveTimer) clearTimeout(driveState.saveTimer);
  driveState.saveTimer = setTimeout(() => {
    pushToDrive().then(() => {
      setSyncStatus('synced', 'Synced');
    }).catch(err => {
      setSyncStatus('error', 'Sync Error');
      console.error('Drive push error:', err);
    });
  }, 1500); // debounce 1.5s after last change
}

// Save locally without triggering Drive push (used during pulls)
function saveDataLocal() {
  try {
    data.schemaVersion = SCHEMA_VERSION;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { console.error('Save error:', e); }
}

// ---------------- STORAGE ----------------
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      data = {
        ...data,
        ...parsed,
        settings: { ...data.settings, ...(parsed.settings || {}) },
        customers: parsed.customers || [],
        tickets: parsed.tickets || [],
        invoices: parsed.invoices || [],
        timeEntries: parsed.timeEntries || []
      };
    }
  } catch (e) {
    console.error('Load error:', e);
    showToast('Could not load saved data', true);
  }
}

function saveData() {
  try {
    data.schemaVersion = SCHEMA_VERSION;
    data._lastModified = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    scheduleDrivePush();
  } catch (e) {
    console.error('Save error:', e);
    showToast('Could not save data', true);
  }
}

// ---------------- MIGRATION (v1 -> v2) ----------------
function migrateIfNeeded() {
  // Already migrated?
  if ((data.schemaVersion || 1) >= SCHEMA_VERSION && data.tickets && data.tickets.length > 0) return;

  // Add shortCodes to existing customers without one
  data.customers.forEach(c => {
    if (!c.shortCode) {
      const code = (c.name || 'CUST').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'CUST';
      c.shortCode = code;
    }
    if (typeof c.nextTicketNum !== 'number') c.nextTicketNum = 1;
  });

  // Migrate v1 timeEntries -> v2 tickets if any exist
  if (data.timeEntries && data.timeEntries.length > 0) {
    // Group by customerId + week
    const groups = {};
    data.timeEntries.forEach(e => {
      const week = weekKey(e.date);
      const key = e.customerId + '|' + week;
      if (!groups[key]) groups[key] = { customerId: e.customerId, week, entries: [] };
      groups[key].entries.push(e);
    });

    Object.values(groups).forEach(g => {
      const cust = data.customers.find(c => c.id === g.customerId);
      if (!cust) return;
      const num = cust.nextTicketNum || 1;
      cust.nextTicketNum = num + 1;
      const ticket = {
        id: uuid(),
        number: cust.shortCode + '-TKT-' + String(num).padStart(3, '0'),
        customerId: g.customerId,
        title: 'Migrated work — week of ' + fmtDate(g.week),
        equipmentInfo: { year: '', makeModel: '', serialOrVin: '', odometer: '', licensePlate: '' },
        jobCode: '',
        complaint: '',
        diagnosis: '',
        workSummary: '',
        status: 'open',
        openedDate: g.week,
        closedDate: null,
        clonedFromTicketId: null,
        lineItems: g.entries.map(e => ({
          id: uuid(),
          type: 'labor',
          date: e.date,
          startTime: e.startTime || '',
          endTime: e.endTime || '',
          qty: Number(e.hours) || 0,
          rate: Number(e.rate) || 0,
          markup: 0,
          desc: [e.jobCode, e.equipmentId, e.notes].filter(Boolean).join(' / ').trim() || 'Labor',
          billable: true,
          billedOnInvoice: e.invoiceId ? findInvoiceNumByOldId(e.invoiceId) : null,
          auditNotes: []
        }))
      };
      // Close ticket if all items billed
      if (ticket.lineItems.every(l => l.billedOnInvoice)) ticket.status = 'closed';
      data.tickets.push(ticket);
    });

    // Re-link invoices to tickets
    data.invoices.forEach(inv => {
      if (!inv.ticketIds) {
        inv.ticketIds = [];
        data.tickets.forEach(t => {
          if (t.customerId === inv.customerId &&
              t.lineItems.some(l => l.billedOnInvoice === inv.number)) {
            inv.ticketIds.push(t.id);
          }
        });
      }
    });

    // Clear legacy timeEntries
    data.timeEntries = [];
    showToast('Old data migrated to new ticket format', false);
  }

  data.schemaVersion = SCHEMA_VERSION;
  saveData();
}

function findInvoiceNumByOldId(invId) {
  const inv = data.invoices.find(i => i.id === invId);
  return inv ? inv.number : null;
}

function weekKey(dateStr) {
  if (!dateStr) return todayISO();
  const d = new Date(dateStr + 'T00:00:00');
  // Get Monday of that week
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  return monday.toISOString().slice(0, 10);
}

// ---------------- UTILITIES ----------------
function uuid() { return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9); }

function fmtMoney(n) {
  const num = Number(n) || 0;
  return (num < 0 ? '-$' : '$') + Math.abs(num).toFixed(2);
}

function fmtDate(d) {
  if (!d) return '';
  const date = (typeof d === 'string') ? new Date(d + 'T00:00:00') : d;
  if (isNaN(date.getTime())) return '';
  return (date.getMonth() + 1) + '/' + date.getDate() + '/' + String(date.getFullYear()).slice(-2);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function calcHours(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round(mins / 15) / 4;
}

function lineTotal(line) {
  let base = (Number(line.qty) || 0) * (Number(line.rate) || 0);
  if (line.markup && line.markup > 0) base = base * (1 + Number(line.markup) / 100);
  if (line.type === 'chargeback') return -Math.abs(base);
  return base;
}

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast'; }, 2400);
}

// ---------------- NAVIGATION ----------------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + name.replace('ticket-new', 'ticket'));
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }

  if (name === 'dashboard') renderDashboard();
  else if (name === 'tickets') renderTicketsList();
  else if (name === 'ticket-new') prepareTicket(null);
  else if (name === 'customers') renderCustomers();
  else if (name === 'history') renderHistory();
  else if (name === 'invoice-builder') prepareInvoiceBuilder();
  else if (name === 'settings') prepareSettings();
}

// ---------------- DASHBOARD ----------------
function renderDashboard() {
  const owed = data.invoices.filter(i => i.status === 'sent').reduce((s, i) => s + (i.total || 0), 0);
  const openCount = data.invoices.filter(i => i.status === 'sent').length;
  document.getElementById('total-owed').textContent = fmtMoney(owed);
  document.getElementById('open-invoice-count').textContent = openCount + ' open invoice' + (openCount !== 1 ? 's' : '');

  // Open tickets
  const openTickets = data.tickets.filter(t => t.status === 'open')
    .sort((a, b) => (b.openedDate || '').localeCompare(a.openedDate || ''))
    .slice(0, 5);
  const otEl = document.getElementById('open-tickets');
  if (openTickets.length === 0) {
    otEl.innerHTML = '<div class="empty-state">No open tickets. Tap "New Ticket" to start one.</div>';
  } else {
    otEl.innerHTML = openTickets.map(t => {
      const cust = data.customers.find(c => c.id === t.customerId);
      const openTotal = t.lineItems.filter(l => !l.billedOnInvoice && l.billable).reduce((s, l) => s + lineTotal(l), 0);
      return `<div class="list-item" data-action="open-ticket" data-id="${t.id}">
        <div class="list-item-title">${t.number} — ${t.title || 'Untitled'}</div>
        <div class="list-item-sub">${cust ? cust.name : 'Unknown'} • opened ${fmtDate(t.openedDate)}</div>
        <div class="list-item-meta"><span><span class="badge badge-open">Open</span> ${t.lineItems.length} items</span><span class="list-item-amount">${fmtMoney(openTotal)} unbilled</span></div>
      </div>`;
    }).join('');
  }

  // Recent invoices
  const recentInv = [...data.invoices]
    .sort((a, b) => (b.sentDate || '').localeCompare(a.sentDate || ''))
    .slice(0, 3);
  const invEl = document.getElementById('recent-invoices');
  if (recentInv.length === 0) {
    invEl.innerHTML = '<div class="empty-state">No invoices yet.</div>';
  } else {
    invEl.innerHTML = recentInv.map(i => {
      const cust = data.customers.find(c => c.id === i.customerId);
      const badge = i.status === 'paid' ? '<span class="badge badge-paid">Paid</span>' : '<span class="badge badge-sent">Sent</span>';
      return `<div class="list-item" data-action="open-invoice" data-id="${i.id}">
        <div class="list-item-title">${i.number} — ${cust ? cust.name : 'Unknown'}</div>
        <div class="list-item-sub">${fmtDate(i.sentDate)}</div>
        <div class="list-item-meta"><span class="list-item-amount">${fmtMoney(i.total)}</span>${badge}</div>
      </div>`;
    }).join('');
  }
}

// ---------------- TICKETS LIST ----------------
function renderTicketsList() {
  const cf = document.getElementById('tickets-filter-customer');
  cf.innerHTML = '<option value="">All Customers</option>' +
    data.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  applyTicketsFilter();
}

function applyTicketsFilter() {
  const cf = document.getElementById('tickets-filter-customer').value;
  const sf = document.getElementById('tickets-filter-status').value;
  let tickets = [...data.tickets];
  if (cf) tickets = tickets.filter(t => t.customerId === cf);
  if (sf) tickets = tickets.filter(t => t.status === sf);
  tickets.sort((a, b) => (b.openedDate || '').localeCompare(a.openedDate || ''));

  const el = document.getElementById('tickets-list');
  if (tickets.length === 0) {
    el.innerHTML = '<div class="empty-state">No tickets match.</div>';
    return;
  }
  el.innerHTML = tickets.map(t => {
    const cust = data.customers.find(c => c.id === t.customerId);
    const openTotal = t.lineItems.filter(l => !l.billedOnInvoice && l.billable).reduce((s, l) => s + lineTotal(l), 0);
    const billedTotal = t.lineItems.filter(l => l.billedOnInvoice).reduce((s, l) => s + lineTotal(l), 0);
    const badge = t.status === 'open' ? '<span class="badge badge-open">Open</span>' : '<span class="badge badge-closed">Closed</span>';
    return `<div class="list-item" data-action="open-ticket" data-id="${t.id}">
      <div class="list-item-title">${t.number} — ${t.title || 'Untitled'}</div>
      <div class="list-item-sub">${cust ? cust.name : 'Unknown'} • opened ${fmtDate(t.openedDate)}${t.closedDate ? ' • closed ' + fmtDate(t.closedDate) : ''}</div>
      <div class="list-item-meta">
        <span>${badge} ${t.lineItems.length} items</span>
        <span>${openTotal > 0 ? '<span class="list-item-amount">' + fmtMoney(openTotal) + ' open</span>' : ''} ${billedTotal > 0 ? '<span style="color:#888;font-size:12px;">' + fmtMoney(billedTotal) + ' billed</span>' : ''}</span>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('tickets-filter-customer').addEventListener('change', applyTicketsFilter);
document.getElementById('tickets-filter-status').addEventListener('change', applyTicketsFilter);

// ---------------- TICKET EDITOR ----------------
let currentTicketId = null;

function prepareTicket(ticketId) {
  // Customer dropdown
  const sel = document.getElementById('tk-customer');
  sel.innerHTML = '<option value="">— Select customer —</option>' +
    data.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  if (ticketId) {
    const t = data.tickets.find(x => x.id === ticketId);
    if (!t) { showToast('Ticket not found', true); showScreen('tickets'); return; }
    currentTicketId = ticketId;
    document.getElementById('ticket-screen-title').textContent = t.number;
    document.getElementById('ticket-id').value = t.id;
    document.getElementById('tk-customer').value = t.customerId;
    document.getElementById('tk-number').value = t.number;
    document.getElementById('tk-status').value = t.status;
    document.getElementById('tk-title').value = t.title || '';
    document.getElementById('tk-job-code').value = t.jobCode || '';
    document.getElementById('tk-eq-year').value = t.equipmentInfo?.year || '';
    document.getElementById('tk-eq-makemodel').value = t.equipmentInfo?.makeModel || '';
    document.getElementById('tk-eq-serial').value = t.equipmentInfo?.serialOrVin || '';
    document.getElementById('tk-eq-odometer').value = t.equipmentInfo?.odometer || '';
    document.getElementById('tk-eq-plate').value = t.equipmentInfo?.licensePlate || '';
    document.getElementById('tk-complaint').value = t.complaint || '';
    document.getElementById('tk-diagnosis').value = t.diagnosis || '';
    document.getElementById('tk-work-summary').value = t.workSummary || '';
    document.getElementById('ticket-lines-panel').style.display = 'block';
    document.getElementById('tk-toggle-status-btn').textContent = t.status === 'open' ? 'Close Ticket' : 'Reopen Ticket';
    renderTicketLines(t);
  } else {
    currentTicketId = null;
    document.getElementById('ticket-screen-title').textContent = 'New Ticket';
    document.getElementById('ticket-form').reset();
    document.getElementById('ticket-id').value = '';
    document.getElementById('tk-number').value = '(saves on first save)';
    document.getElementById('tk-status').value = 'open';
    document.getElementById('ticket-lines-panel').style.display = 'none';
  }
}

document.getElementById('ticket-back-btn').addEventListener('click', () => showScreen('tickets'));

document.getElementById('tk-save-btn').addEventListener('click', () => {
  const custId = document.getElementById('tk-customer').value;
  const title = document.getElementById('tk-title').value.trim();
  if (!custId) { showToast('Pick a customer', true); return; }
  if (!title) { showToast('Enter a job title', true); return; }

  const cust = data.customers.find(c => c.id === custId);
  if (!cust) { showToast('Customer not found', true); return; }

  let ticket;
  if (currentTicketId) {
    ticket = data.tickets.find(t => t.id === currentTicketId);
    if (!ticket) { showToast('Ticket not found', true); return; }
  } else {
    const num = cust.nextTicketNum || 1;
    cust.nextTicketNum = num + 1;
    ticket = {
      id: uuid(),
      number: cust.shortCode + '-TKT-' + String(num).padStart(3, '0'),
      customerId: custId,
      lineItems: [],
      status: 'open',
      openedDate: todayISO(),
      closedDate: null,
      clonedFromTicketId: null,
      equipmentInfo: { year: '', makeModel: '', serialOrVin: '', odometer: '', licensePlate: '' }
    };
    data.tickets.push(ticket);
    currentTicketId = ticket.id;
  }

  // Update fields (number does not change once assigned)
  ticket.customerId = custId;
  ticket.title = title;
  ticket.jobCode = document.getElementById('tk-job-code').value.trim();
  ticket.status = document.getElementById('tk-status').value;
  ticket.closedDate = ticket.status === 'closed' ? (ticket.closedDate || todayISO()) : null;
  ticket.equipmentInfo = {
    year: document.getElementById('tk-eq-year').value.trim(),
    makeModel: document.getElementById('tk-eq-makemodel').value.trim(),
    serialOrVin: document.getElementById('tk-eq-serial').value.trim(),
    odometer: document.getElementById('tk-eq-odometer').value.trim(),
    licensePlate: document.getElementById('tk-eq-plate').value.trim()
  };
  ticket.complaint = document.getElementById('tk-complaint').value.trim();
  ticket.diagnosis = document.getElementById('tk-diagnosis').value.trim();
  ticket.workSummary = document.getElementById('tk-work-summary').value.trim();

  saveData();
  showToast('Ticket ' + ticket.number + ' saved');
  prepareTicket(ticket.id); // Re-render with full panel
});

function renderTicketLines(ticket) {
  const groups = { labor: [], part: [], mileage: [], misc: [] };
  ticket.lineItems.forEach(l => {
    if (groups[l.type]) groups[l.type].push(l);
  });

  const renderGroup = (lines, elId) => {
    const el = document.getElementById(elId);
    if (lines.length === 0) {
      el.innerHTML = '<div class="empty-state">No items yet.</div>';
      return;
    }
    el.innerHTML = lines.map(l => {
      const billedBadge = l.billedOnInvoice ? `<span class="badge badge-billed">Billed ${l.billedOnInvoice}</span>` : '<span class="badge badge-open">Open</span>';
      const unbillableBadge = !l.billable ? '<span class="badge badge-closed">Non-billable</span>' : '';
      const subInfo = l.type === 'labor' && l.startTime
        ? `${fmtDate(l.date)} ${l.startTime}-${l.endTime} • ${l.qty} hr @ ${fmtMoney(l.rate)}`
        : `${fmtDate(l.date)} • ${l.qty} × ${fmtMoney(l.rate)}${l.markup > 0 ? ' +' + l.markup + '%' : ''}`;
      return `<div class="ticket-line ${l.billedOnInvoice ? 'billed' : ''}" data-action="edit-line" data-tid="${ticket.id}" data-id="${l.id}">
        <div class="ticket-line-main">
          <div class="ticket-line-title">${(l.desc || '(no desc)').split('\n')[0]}</div>
          <div class="ticket-line-sub">${subInfo} ${billedBadge} ${unbillableBadge}</div>
        </div>
        <div class="ticket-line-amount">${fmtMoney(lineTotal(l))}</div>
      </div>`;
    }).join('');
  };

  renderGroup(groups.labor, 'tk-labor-list');
  renderGroup(groups.part, 'tk-parts-list');
  renderGroup(groups.mileage, 'tk-mileage-list');
  renderGroup(groups.misc, 'tk-misc-list');

  const openTotal = ticket.lineItems.filter(l => !l.billedOnInvoice && l.billable).reduce((s, l) => s + lineTotal(l), 0);
  const billedTotal = ticket.lineItems.filter(l => l.billedOnInvoice).reduce((s, l) => s + lineTotal(l), 0);
  document.getElementById('tk-open-total').textContent = fmtMoney(openTotal);
  document.getElementById('tk-billed-total').textContent = fmtMoney(billedTotal);
  document.getElementById('tk-grand-total').textContent = fmtMoney(openTotal + billedTotal);
}

// Add-line buttons
document.querySelectorAll('[data-add-line]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!currentTicketId) { showToast('Save the ticket first', true); return; }
    prepareLineEditor(currentTicketId, null, btn.getAttribute('data-add-line'));
    showScreen('line');
  });
});

// Toggle status
document.getElementById('tk-toggle-status-btn').addEventListener('click', () => {
  const t = data.tickets.find(x => x.id === currentTicketId);
  if (!t) return;
  if (t.status === 'open') {
    t.status = 'closed';
    t.closedDate = todayISO();
    showToast('Ticket closed');
  } else {
    t.status = 'open';
    t.closedDate = null;
    showToast('Ticket reopened');
  }
  saveData();
  prepareTicket(t.id);
});

// Delete ticket
document.getElementById('tk-delete-btn').addEventListener('click', () => {
  const t = data.tickets.find(x => x.id === currentTicketId);
  if (!t) return;
  const hasBilled = t.lineItems.some(l => l.billedOnInvoice);
  if (hasBilled) {
    if (!confirm('This ticket has items already billed on invoices. Deleting will NOT delete those invoices, but the ticket history will be lost. Continue?')) return;
  } else {
    if (!confirm('Delete ticket ' + t.number + '? This cannot be undone.')) return;
  }
  data.tickets = data.tickets.filter(x => x.id !== currentTicketId);
  saveData();
  showToast('Ticket deleted');
  showScreen('tickets');
});

// Clone ticket
document.getElementById('tk-clone-btn').addEventListener('click', () => {
  const t = data.tickets.find(x => x.id === currentTicketId);
  if (!t) return;
  const cust = data.customers.find(c => c.id === t.customerId);
  if (!cust) return;
  const num = cust.nextTicketNum || 1;
  cust.nextTicketNum = num + 1;
  const clone = {
    id: uuid(),
    number: cust.shortCode + '-TKT-' + String(num).padStart(3, '0'),
    customerId: t.customerId,
    title: t.title,
    equipmentInfo: { ...t.equipmentInfo },
    jobCode: t.jobCode,
    complaint: t.complaint,
    diagnosis: '',
    workSummary: '',
    status: 'open',
    openedDate: todayISO(),
    closedDate: null,
    clonedFromTicketId: t.id,
    lineItems: t.lineItems.map(l => ({
      id: uuid(),
      type: l.type,
      date: todayISO(),
      startTime: '',
      endTime: '',
      qty: 0,
      rate: l.rate,        // Keep rates per option B
      markup: l.markup || 0,
      desc: l.desc,
      billable: l.billable !== false,
      billedOnInvoice: null,
      auditNotes: []
    }))
  };
  data.tickets.push(clone);
  saveData();
  showToast('Cloned to ' + clone.number);
  prepareTicket(clone.id);
});

// Generate Invoice from this Ticket
document.getElementById('tk-invoice-btn').addEventListener('click', () => {
  const t = data.tickets.find(x => x.id === currentTicketId);
  if (!t) return;
  const openItems = t.lineItems.filter(l => !l.billedOnInvoice && l.billable);
  if (openItems.length === 0) { showToast('No open billable items on this ticket', true); return; }
  showScreen('invoice-builder');
  // Pre-select customer and this ticket
  document.getElementById('inv-customer').value = t.customerId;
  renderInvoiceTicketsList(t.customerId, [t.id]);
  pullSelectedTicketLines();
});

// ---------------- LINE ITEM EDITOR ----------------
let currentLineId = null;
let currentLineType = null;

function prepareLineEditor(ticketId, lineId, typeForNew) {
  document.getElementById('line-ticket-id').value = ticketId;
  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  if (lineId) {
    const line = ticket.lineItems.find(l => l.id === lineId);
    if (!line) return;
    currentLineId = lineId;
    currentLineType = line.type;
    document.getElementById('line-id').value = line.id;
    document.getElementById('line-type').value = line.type;
    document.getElementById('line-title').textContent = 'Edit ' + capLabel(line.type);
    document.getElementById('line-date').value = line.date || todayISO();
    document.getElementById('line-start').value = line.startTime || '';
    document.getElementById('line-end').value = line.endTime || '';
    document.getElementById('line-desc').value = line.desc || '';
    document.getElementById('line-qty').value = line.qty || '';
    document.getElementById('line-rate').value = line.rate || '';
    document.getElementById('line-markup').value = line.markup || 0;
    document.getElementById('line-billable').checked = line.billable !== false;
    document.getElementById('line-billable-2').checked = line.billable !== false;
    document.getElementById('line-delete-btn').style.display = 'block';
    if (line.billedOnInvoice) {
      document.getElementById('line-billed-banner').style.display = 'block';
      document.getElementById('line-billed-on').textContent = line.billedOnInvoice;
    } else {
      document.getElementById('line-billed-banner').style.display = 'none';
    }
  } else {
    currentLineId = null;
    currentLineType = typeForNew;
    document.getElementById('line-id').value = '';
    document.getElementById('line-type').value = typeForNew;
    document.getElementById('line-title').textContent = 'Add ' + capLabel(typeForNew);
    document.getElementById('line-form').reset();
    document.getElementById('line-date').value = todayISO();
    document.getElementById('line-billable').checked = true;
    document.getElementById('line-billable-2').checked = true;
    document.getElementById('line-markup').value = 0;
    document.getElementById('line-delete-btn').style.display = 'none';
    document.getElementById('line-billed-banner').style.display = 'none';
  }

  // Show/hide fields per type
  const isLabor = currentLineType === 'labor';
  const showMarkup = currentLineType === 'part' || currentLineType === 'misc';
  document.getElementById('line-labor-fields').style.display = isLabor ? 'block' : 'none';
  document.getElementById('line-markup-row').style.display = showMarkup ? 'flex' : 'none';
  document.getElementById('line-billable-row').style.display = showMarkup ? 'none' : 'flex';
  document.getElementById('line-qty-label').firstChild.textContent =
    isLabor ? 'Hours' : currentLineType === 'mileage' ? 'Miles / Trips' : 'Qty';

  updateLineTotal();
}

function capLabel(t) {
  return ({ labor: 'Labor', part: 'Part', mileage: 'Mileage', misc: 'Misc Item' })[t] || t;
}

function updateLineTotal() {
  const qty = Number(document.getElementById('line-qty').value) || 0;
  const rate = Number(document.getElementById('line-rate').value) || 0;
  const markup = Number(document.getElementById('line-markup').value) || 0;
  let total = qty * rate;
  if (markup > 0 && document.getElementById('line-markup-row').style.display !== 'none') {
    total = total * (1 + markup / 100);
  }
  document.getElementById('line-total').textContent = fmtMoney(total);
}

['line-qty', 'line-rate', 'line-markup'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateLineTotal);
});

// Auto-calc hours from start/end for labor
document.getElementById('line-start').addEventListener('change', () => {
  const s = document.getElementById('line-start').value;
  const e = document.getElementById('line-end').value;
  if (s && e && currentLineType === 'labor') {
    document.getElementById('line-qty').value = calcHours(s, e);
    updateLineTotal();
  }
});
document.getElementById('line-end').addEventListener('change', () => {
  const s = document.getElementById('line-start').value;
  const e = document.getElementById('line-end').value;
  if (s && e && currentLineType === 'labor') {
    document.getElementById('line-qty').value = calcHours(s, e);
    updateLineTotal();
  }
});

document.getElementById('line-back-btn').addEventListener('click', () => {
  showScreen('ticket');
  prepareTicket(currentTicketId);
});

document.getElementById('line-save-btn').addEventListener('click', () => {
  const ticketId = document.getElementById('line-ticket-id').value;
  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  const showMarkup = currentLineType === 'part' || currentLineType === 'misc';
  const billable = showMarkup
    ? document.getElementById('line-billable').checked
    : document.getElementById('line-billable-2').checked;

  const lineData = {
    type: currentLineType,
    date: document.getElementById('line-date').value || todayISO(),
    startTime: document.getElementById('line-start').value,
    endTime: document.getElementById('line-end').value,
    desc: document.getElementById('line-desc').value.trim(),
    qty: Number(document.getElementById('line-qty').value) || 0,
    rate: Number(document.getElementById('line-rate').value) || 0,
    markup: showMarkup ? (Number(document.getElementById('line-markup').value) || 0) : 0,
    billable: billable
  };

  if (currentLineId) {
    const line = ticket.lineItems.find(l => l.id === currentLineId);
    if (line) Object.assign(line, lineData);
  } else {
    ticket.lineItems.push({
      id: uuid(),
      ...lineData,
      billedOnInvoice: null,
      auditNotes: []
    });
  }

  saveData();
  showToast('Line saved');
  showScreen('ticket');
  prepareTicket(ticketId);
});

document.getElementById('line-delete-btn').addEventListener('click', () => {
  const ticketId = document.getElementById('line-ticket-id').value;
  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  const line = ticket.lineItems.find(l => l.id === currentLineId);
  if (line && line.billedOnInvoice) {
    if (!confirm('This line was already billed on ' + line.billedOnInvoice + '. Deleting it will NOT remove it from that invoice. Continue?')) return;
  } else {
    if (!confirm('Delete this line item?')) return;
  }
  ticket.lineItems = ticket.lineItems.filter(l => l.id !== currentLineId);
  saveData();
  showToast('Line deleted');
  showScreen('ticket');
  prepareTicket(ticketId);
});

document.getElementById('line-unbill-btn').addEventListener('click', () => {
  const ticketId = document.getElementById('line-ticket-id').value;
  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  const line = ticket.lineItems.find(l => l.id === currentLineId);
  if (!line || !line.billedOnInvoice) return;
  const reason = prompt('Reason for unbilling? (e.g., customer dispute, error correction)');
  if (reason === null) return;
  const wasOn = line.billedOnInvoice;
  line.billedOnInvoice = null;
  line.auditNotes = line.auditNotes || [];
  line.auditNotes.push({
    date: todayISO(),
    action: 'unbilled',
    fromInvoice: wasOn,
    reason: reason.trim() || '(no reason given)'
  });
  saveData();
  showToast('Line unbilled — now open');
  showScreen('ticket');
  prepareTicket(ticketId);
});

// ---------------- CUSTOMERS ----------------
function renderCustomers() {
  const el = document.getElementById('customers-list');
  if (data.customers.length === 0) {
    el.innerHTML = '<div class="empty-state">No customers yet. Tap "+ Add" to add one.</div>';
    return;
  }
  el.innerHTML = data.customers.map(c => {
    const owed = data.invoices.filter(i => i.customerId === c.id && i.status === 'sent').reduce((s, i) => s + i.total, 0);
    const openTickets = data.tickets.filter(t => t.customerId === c.id && t.status === 'open').length;
    return `<div class="list-item" data-action="edit-customer" data-id="${c.id}">
      <div class="list-item-title">${c.name} <span style="font-size:12px;color:#888;font-weight:normal;">[${c.shortCode || '?'}]</span></div>
      <div class="list-item-sub">${c.email || c.phone || ''}</div>
      <div class="list-item-meta">
        <span>${openTickets} open ticket${openTickets !== 1 ? 's' : ''}</span>
        ${owed > 0 ? `<span class="list-item-amount">Owed: ${fmtMoney(owed)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

document.getElementById('add-customer-btn').addEventListener('click', () => {
  document.getElementById('customer-edit-title').textContent = 'Add Customer';
  document.getElementById('customer-form').reset();
  document.getElementById('customer-id').value = '';
  document.getElementById('customer-delete').style.display = 'none';
  showScreen('customer-edit');
});

function editCustomer(id) {
  const c = data.customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById('customer-edit-title').textContent = 'Edit ' + c.name;
  document.getElementById('customer-id').value = c.id;
  document.getElementById('cust-name').value = c.name || '';
  document.getElementById('cust-shortcode').value = c.shortCode || '';
  document.getElementById('cust-address').value = c.address || '';
  document.getElementById('cust-phone').value = c.phone || '';
  document.getElementById('cust-email').value = c.email || '';
  document.getElementById('cust-ein').value = c.ein || '';
  document.getElementById('cust-notes').value = c.notes || '';
  document.getElementById('customer-delete').style.display = 'block';
  showScreen('customer-edit');
}

document.getElementById('customer-save-btn').addEventListener('click', () => {
  const id = document.getElementById('customer-id').value;
  const name = document.getElementById('cust-name').value.trim();
  const shortCode = document.getElementById('cust-shortcode').value.trim().toUpperCase();
  if (!name) { showToast('Customer name required', true); return; }
  if (!shortCode) { showToast('Short code required', true); return; }

  if (id) {
    const c = data.customers.find(x => x.id === id);
    if (!c) return;
    c.name = name;
    c.shortCode = shortCode;
    c.address = document.getElementById('cust-address').value.trim();
    c.phone = document.getElementById('cust-phone').value.trim();
    c.email = document.getElementById('cust-email').value.trim();
    c.ein = document.getElementById('cust-ein').value.trim();
    c.notes = document.getElementById('cust-notes').value.trim();
  } else {
    data.customers.push({
      id: uuid(),
      name,
      shortCode,
      address: document.getElementById('cust-address').value.trim(),
      phone: document.getElementById('cust-phone').value.trim(),
      email: document.getElementById('cust-email').value.trim(),
      ein: document.getElementById('cust-ein').value.trim(),
      notes: document.getElementById('cust-notes').value.trim(),
      nextTicketNum: 1,
      created: todayISO()
    });
  }
  saveData();
  showToast('Customer saved');
  showScreen('customers');
});

document.getElementById('customer-delete').addEventListener('click', () => {
  const id = document.getElementById('customer-id').value;
  const hasData = data.tickets.some(t => t.customerId === id) || data.invoices.some(i => i.customerId === id);
  if (hasData) {
    showToast('Cannot delete — has tickets or invoices', true);
    return;
  }
  if (!confirm('Delete this customer?')) return;
  data.customers = data.customers.filter(c => c.id !== id);
  saveData();
  showToast('Customer deleted');
  showScreen('customers');
});

// ---------------- INVOICE BUILDER ----------------
function prepareInvoiceBuilder() {
  const sel = document.getElementById('inv-customer');
  sel.innerHTML = '<option value="">— Select customer —</option>' +
    data.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('invoice-form').reset();
  document.getElementById('invoice-id').value = '';
  document.getElementById('revised-banner').style.display = 'none';
  document.getElementById('invoice-builder-title').textContent = 'New Invoice';
  document.getElementById('invoice-submit-btn').textContent = 'Save & Generate PDF';
  currentInvoiceLines = [];
  document.getElementById('inv-tickets-list').innerHTML = '<div class="empty-state">Pick a customer to see their open tickets.</div>';
  renderInvoiceLines();
}

document.getElementById('inv-customer').addEventListener('change', () => {
  const custId = document.getElementById('inv-customer').value;
  if (!custId) {
    document.getElementById('inv-tickets-list').innerHTML = '<div class="empty-state">Pick a customer to see their open tickets.</div>';
    currentInvoiceLines = [];
    renderInvoiceLines();
    return;
  }
  renderInvoiceTicketsList(custId, []);
});

function renderInvoiceTicketsList(custId, preCheckedIds) {
  const tickets = data.tickets.filter(t => {
    if (t.customerId !== custId) return false;
    return t.lineItems.some(l => !l.billedOnInvoice && l.billable);
  });
  const el = document.getElementById('inv-tickets-list');
  if (tickets.length === 0) {
    el.innerHTML = `<div class="empty-state">
      No tickets with open billable items for this customer.
      <div style="margin-top:8px; font-size:12px;">Create a ticket first, add items to it, then come back here.</div>
    </div>`;
    document.getElementById('inv-tickets-summary').style.display = 'none';
    return;
  }
  el.innerHTML = tickets.map(t => {
    const openTotal = t.lineItems.filter(l => !l.billedOnInvoice && l.billable).reduce((s, l) => s + lineTotal(l), 0);
    const itemCount = t.lineItems.filter(l => !l.billedOnInvoice && l.billable).length;
    const checked = preCheckedIds.includes(t.id) ? 'checked' : '';
    const eq = t.equipmentInfo || {};
    const eqShort = `${eq.year || ''} ${eq.makeModel || ''}`.trim();
    return `<label class="ticket-pick" data-pick-card="${t.id}">
      <input type="checkbox" data-ticket-pick="${t.id}" ${checked}>
      <div class="ticket-pick-info">
        <div class="ticket-pick-num">${t.number} <span style="font-weight:normal;font-size:13px;color:#333;">— ${t.title || '(untitled)'}</span></div>
        <div class="ticket-pick-title">${eqShort ? eqShort + ' • ' : ''}${itemCount} open item${itemCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="ticket-pick-amount">${fmtMoney(openTotal)}</div>
    </label>`;
  }).join('');

  el.querySelectorAll('[data-ticket-pick]').forEach(cb => {
    cb.addEventListener('change', () => {
      pullSelectedTicketLines();
      updateTicketsSummary();
    });
  });
  updateTicketsSummary();
}

function updateTicketsSummary() {
  const checked = document.querySelectorAll('[data-ticket-pick]:checked');
  const summaryEl = document.getElementById('inv-tickets-summary');
  if (!summaryEl) return;
  if (checked.length === 0) {
    summaryEl.style.display = 'none';
    return;
  }
  let total = 0;
  const nums = [];
  checked.forEach(cb => {
    const t = data.tickets.find(x => x.id === cb.getAttribute('data-ticket-pick'));
    if (!t) return;
    nums.push(t.number);
    total += t.lineItems.filter(l => !l.billedOnInvoice && l.billable).reduce((s, l) => s + lineTotal(l), 0);
  });
  summaryEl.style.display = 'block';
  summaryEl.innerHTML = `${checked.length} ticket${checked.length !== 1 ? 's' : ''} added (${nums.join(', ')}) — open total: <span style="color:#00bfff;">${fmtMoney(total)}</span>`;
  // Highlight checked cards
  document.querySelectorAll('[data-pick-card]').forEach(card => {
    const cb = card.querySelector('input[type=checkbox]');
    if (cb && cb.checked) {
      card.style.background = '#ebf5fc';
      card.style.borderColor = '#00bfff';
    } else {
      card.style.background = '#fff';
      card.style.borderColor = '#e0e0d8';
    }
  });
}

function pullSelectedTicketLines() {
  // Keep any chargeback / custom lines, drop the rest
  const keepers = currentInvoiceLines.filter(l => l.type === 'chargeback' || l._custom);
  currentInvoiceLines = keepers;

  document.querySelectorAll('[data-ticket-pick]:checked').forEach(cb => {
    const tid = cb.getAttribute('data-ticket-pick');
    const t = data.tickets.find(x => x.id === tid);
    if (!t) return;
    t.lineItems
      .filter(l => !l.billedOnInvoice && l.billable)
      .forEach(l => {
        currentInvoiceLines.push({
          ...l,
          _ticketId: t.id,
          _ticketNumber: t.number
        });
      });
  });
  renderInvoiceLines();
}

function renderInvoiceLines() {
  const el = document.getElementById('inv-lines-list');
  if (currentInvoiceLines.length === 0) {
    el.innerHTML = '<div class="empty-state">No items yet. Pick tickets above or add custom lines below.</div>';
    updateInvoiceTotals();
    return;
  }
  el.innerHTML = currentInvoiceLines.map((l, idx) => {
    const cssClass = l.type === 'labor' ? 'labor' : (l.type === 'part' ? 'part' : (l.type === 'mileage' ? 'mileage' : (l.type === 'chargeback' ? 'chargeback' : '')));
    const label = ({ labor: 'Labor', part: 'Part', mileage: 'Mileage', misc: 'Misc', chargeback: 'Chargeback (subtracts)', custom: 'Custom' })[l.type] || l.type;
    const sourceTag = l._ticketNumber ? `<div class="line-item-source">From ${l._ticketNumber}</div>` : '';
    const isLabor = l.type === 'labor';
    return `<div class="line-item ${cssClass}">
      <button type="button" class="line-item-remove" data-remove="${idx}">×</button>
      <div style="font-size:11px;font-weight:700;color:#666;text-transform:uppercase;margin-bottom:4px;">${label}</div>
      <div class="line-item-row">
        <textarea class="desc" rows="${isLabor ? 2 : 1}" data-line="${idx}" data-field="desc" placeholder="Description">${l.desc || ''}</textarea>
      </div>
      <div class="line-item-row">
        <input type="number" class="qty" step="0.25" data-line="${idx}" data-field="qty" value="${l.qty || 0}" placeholder="${isLabor ? 'Hrs' : 'Qty'}">
        <input type="number" class="rate" step="0.01" data-line="${idx}" data-field="rate" value="${l.rate || 0}" placeholder="Rate">
        <div class="total">${fmtMoney(lineTotal(l))}</div>
      </div>
      ${sourceTag}
    </div>`;
  }).join('');

  el.querySelectorAll('[data-line]').forEach(input => {
    input.addEventListener('input', handleInvoiceLineEdit);
  });
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-remove'));
      currentInvoiceLines.splice(idx, 1);
      renderInvoiceLines();
    });
  });
  updateInvoiceTotals();
}

function handleInvoiceLineEdit(e) {
  const idx = parseInt(e.target.getAttribute('data-line'));
  const field = e.target.getAttribute('data-field');
  const line = currentInvoiceLines[idx];
  if (!line) return;
  if (field === 'desc') line.desc = e.target.value;
  else line[field] = parseFloat(e.target.value) || 0;
  // Update displayed total
  const totalEl = e.target.closest('.line-item').querySelector('.total');
  if (totalEl) totalEl.textContent = fmtMoney(lineTotal(line));
  updateInvoiceTotals();
}

function updateInvoiceTotals() {
  const subOf = type => currentInvoiceLines.filter(l => l.type === type).reduce((s, l) => s + lineTotal(l), 0);
  const subLabor = subOf('labor');
  const subParts = subOf('part');
  const subMileage = subOf('mileage');
  const subMisc = subOf('misc') + subOf('custom');
  const cb = subOf('chargeback');
  const subtotal = subLabor + subParts + subMileage + subMisc;
  document.getElementById('inv-sub-labor').textContent = fmtMoney(subLabor);
  document.getElementById('inv-sub-parts').textContent = fmtMoney(subParts);
  document.getElementById('inv-sub-mileage').textContent = fmtMoney(subMileage);
  document.getElementById('inv-sub-misc').textContent = fmtMoney(subMisc);
  document.getElementById('inv-subtotal').textContent = fmtMoney(subtotal);
  document.getElementById('inv-chargeback').textContent = fmtMoney(cb);
  document.getElementById('inv-total').textContent = fmtMoney(subtotal + cb);
}

document.getElementById('add-chargeback-btn').addEventListener('click', () => {
  currentInvoiceLines.push({
    id: uuid(), type: 'chargeback', desc: 'Chargeback',
    qty: 1, rate: 0, markup: 0, _custom: true
  });
  renderInvoiceLines();
});
document.getElementById('add-custom-line-btn').addEventListener('click', () => {
  currentInvoiceLines.push({
    id: uuid(), type: 'custom', desc: '',
    qty: 1, rate: 0, markup: 0, _custom: true
  });
  renderInvoiceLines();
});

document.getElementById('preview-pdf-btn').addEventListener('click', () => {
  try {
    const custId = document.getElementById('inv-customer').value;
    if (!custId) { showToast('Pick a customer first', true); return; }
    if (currentInvoiceLines.length === 0) { showToast('Add line items first', true); return; }
    const num = data.settings.nextInvoiceNumber || 1;
    const subOf = type => currentInvoiceLines.filter(l => l.type === type).reduce((s, l) => s + lineTotal(l), 0);
    const preview = {
      number: 'INV-' + String(num).padStart(3, '0') + ' (PREVIEW)',
      customerId: custId,
      ticketIds: [...new Set(currentInvoiceLines.map(l => l._ticketId).filter(Boolean))],
      lineItems: currentInvoiceLines.map(l => ({ ...l })),
      subtotalLabor: subOf('labor'),
      subtotalParts: subOf('part'),
      subtotalMileage: subOf('mileage'),
      subtotalMisc: subOf('misc') + subOf('custom'),
      subtotal: subOf('labor') + subOf('part') + subOf('mileage') + subOf('misc') + subOf('custom'),
      chargeback: subOf('chargeback'),
      total: subOf('labor') + subOf('part') + subOf('mileage') + subOf('misc') + subOf('custom') + subOf('chargeback'),
      status: 'preview',
      sentDate: todayISO(),
      isRevised: false,
      lastEditedDate: null
    };
    generatePDF(preview);
  } catch (err) {
    console.error('Preview error:', err);
    showToast('Preview failed: ' + (err.message || 'unknown'), true);
  }
});

document.getElementById('invoice-submit-btn').addEventListener('click', () => {
  const custId = document.getElementById('inv-customer').value;
  const editId = document.getElementById('invoice-id').value;
  const isRevised = document.getElementById('mark-revised-checkbox').checked;
  if (!custId) { showToast('Pick a customer', true); return; }
  if (currentInvoiceLines.length === 0) { showToast('Add line items', true); return; }

  const subOf = type => currentInvoiceLines.filter(l => l.type === type).reduce((s, l) => s + lineTotal(l), 0);
  const subtotalLabor = subOf('labor');
  const subtotalParts = subOf('part');
  const subtotalMileage = subOf('mileage');
  const subtotalMisc = subOf('misc') + subOf('custom');
  const subtotal = subtotalLabor + subtotalParts + subtotalMileage + subtotalMisc;
  const cb = subOf('chargeback');
  const ticketIds = [...new Set(currentInvoiceLines.map(l => l._ticketId).filter(Boolean))];

  let invoice;
  if (editId) {
    invoice = data.invoices.find(i => i.id === editId);
    if (!invoice) return;
    // Unmark previously billed lines on tickets
    data.tickets.forEach(t => {
      t.lineItems.forEach(l => {
        if (l.billedOnInvoice === invoice.number) l.billedOnInvoice = null;
      });
    });
    invoice.customerId = custId;
    invoice.ticketIds = ticketIds;
    invoice.lineItems = currentInvoiceLines.map(l => ({ ...l }));
    invoice.subtotalLabor = subtotalLabor;
    invoice.subtotalParts = subtotalParts;
    invoice.subtotalMileage = subtotalMileage;
    invoice.subtotalMisc = subtotalMisc;
    invoice.subtotal = subtotal;
    invoice.chargeback = cb;
    invoice.total = subtotal + cb;
    invoice.isRevised = isRevised;
    invoice.lastEditedDate = todayISO();
  } else {
    const num = data.settings.nextInvoiceNumber || 1;
    invoice = {
      id: uuid(),
      number: 'INV-' + String(num).padStart(3, '0'),
      customerId: custId,
      ticketIds,
      lineItems: currentInvoiceLines.map(l => ({ ...l })),
      subtotalLabor, subtotalParts, subtotalMileage, subtotalMisc,
      subtotal, chargeback: cb, total: subtotal + cb,
      status: 'sent',
      sentDate: todayISO(),
      paidDate: null,
      isRevised: false,
      lastEditedDate: null
    };
    data.invoices.push(invoice);
    data.settings.nextInvoiceNumber = num + 1;
  }

  // Mark ticket line items as billed
  currentInvoiceLines.forEach(invLine => {
    if (invLine._ticketId) {
      const t = data.tickets.find(x => x.id === invLine._ticketId);
      if (t) {
        const origLine = t.lineItems.find(l => l.id === invLine.id);
        if (origLine) origLine.billedOnInvoice = invoice.number;
      }
    }
  });

  saveData();
  showToast('Invoice ' + invoice.number + ' saved');
  generatePDF(invoice);
  currentInvoiceLines = [];
  showScreen('dashboard');
});

// ---------------- HISTORY ----------------
function renderHistory() {
  const cFilter = document.getElementById('history-filter-customer');
  cFilter.innerHTML = '<option value="">All Customers</option>' +
    data.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const cf = document.getElementById('history-filter-customer').value;
  const sf = document.getElementById('history-filter-status').value;
  let invs = [...data.invoices];
  if (cf) invs = invs.filter(i => i.customerId === cf);
  if (sf) invs = invs.filter(i => i.status === sf);
  invs.sort((a, b) => (b.sentDate || '').localeCompare(a.sentDate || ''));

  const owed = invs.filter(i => i.status === 'sent').reduce((s, i) => s + i.total, 0);
  document.getElementById('history-total-owed').textContent = fmtMoney(owed);

  const el = document.getElementById('history-list');
  if (invs.length === 0) {
    el.innerHTML = '<div class="empty-state">No invoices match.</div>';
    return;
  }
  el.innerHTML = invs.map(i => {
    const cust = data.customers.find(c => c.id === i.customerId);
    const badge = i.status === 'paid' ? '<span class="badge badge-paid">Paid</span>' : '<span class="badge badge-sent">Sent</span>';
    return `<div class="list-item" data-action="open-invoice" data-id="${i.id}">
      <div class="list-item-title">${i.number} — ${cust ? cust.name : 'Unknown'}</div>
      <div class="list-item-sub">${fmtDate(i.sentDate)}${i.paidDate ? ' • paid ' + fmtDate(i.paidDate) : ''}</div>
      <div class="list-item-meta"><span class="list-item-amount">${fmtMoney(i.total)}</span>${badge}</div>
    </div>`;
  }).join('');
}

document.getElementById('history-filter-customer').addEventListener('change', applyHistoryFilter);
document.getElementById('history-filter-status').addEventListener('change', applyHistoryFilter);

function openInvoiceDetail(id) {
  const inv = data.invoices.find(i => i.id === id);
  if (!inv) return;
  const cust = data.customers.find(c => c.id === inv.customerId);
  document.getElementById('invoice-detail-title').textContent = inv.number;

  document.getElementById('invoice-detail-content').innerHTML = renderInvoiceMockHTML(inv, cust);

  document.getElementById('redownload-pdf-btn').onclick = () => generatePDF(inv);
  document.getElementById('email-customer-btn').onclick = () => emailInvoice(inv);
  document.getElementById('mark-paid-btn').textContent = inv.status === 'paid' ? 'Mark as Unpaid' : 'Mark as Paid';
  document.getElementById('mark-paid-btn').onclick = () => {
    inv.status = inv.status === 'paid' ? 'sent' : 'paid';
    inv.paidDate = inv.status === 'paid' ? todayISO() : null;
    saveData();
    showToast(inv.status === 'paid' ? 'Marked paid' : 'Marked unpaid');
    openInvoiceDetail(id);
  };
  document.getElementById('edit-invoice-btn').onclick = () => {
    showScreen('invoice-builder');
    prepareInvoiceEdit(id);
  };
  document.getElementById('delete-invoice-btn').onclick = () => {
    if (!confirm('Delete invoice ' + inv.number + '? Items on tickets will be unbilled and re-available.')) return;
    data.tickets.forEach(t => {
      t.lineItems.forEach(l => {
        if (l.billedOnInvoice === inv.number) l.billedOnInvoice = null;
      });
    });
    data.invoices = data.invoices.filter(i => i.id !== id);
    saveData();
    showToast('Invoice deleted');
    showScreen('history');
  };

  showScreen('invoice-detail');
}

function prepareInvoiceEdit(invId) {
  const inv = data.invoices.find(i => i.id === invId);
  if (!inv) return;
  prepareInvoiceBuilder();
  document.getElementById('invoice-builder-title').textContent = 'Edit ' + inv.number;
  document.getElementById('invoice-id').value = inv.id;
  document.getElementById('inv-customer').value = inv.customerId;
  document.getElementById('revised-banner').style.display = 'block';
  document.getElementById('mark-revised-checkbox').checked = !!inv.isRevised;
  document.getElementById('invoice-submit-btn').textContent = 'Save Changes & Generate PDF';
  // Render tickets list with this invoice's tickets pre-checked
  renderInvoiceTicketsList(inv.customerId, inv.ticketIds || []);
  // Load lines from invoice (snapshot, not pulled fresh from tickets)
  currentInvoiceLines = (inv.lineItems || []).map(l => ({ ...l }));
  renderInvoiceLines();
}

// ---------------- IN-APP INVOICE MOCK (HTML mirror of PDF) ----------------
function renderInvoiceMockHTML(inv, cust) {
  const s = data.settings;
  const ticketsForInvoice = (inv.ticketIds || []).map(id => data.tickets.find(t => t.id === id)).filter(Boolean);

  // Group line items by ticket and by type
  const itemsByTicket = {};
  const looseItems = [];
  (inv.lineItems || []).forEach(l => {
    if (l.type === 'chargeback') { looseItems.push(l); return; }
    const tid = l._ticketId;
    if (!tid) { looseItems.push(l); return; }
    if (!itemsByTicket[tid]) itemsByTicket[tid] = [];
    itemsByTicket[tid].push(l);
  });

  const subSecs = [
    { key: 'labor',   label: 'LABOR',   qtyHdr: 'HRS',   rateHdr: 'RATE' },
    { key: 'part',    label: 'PARTS',   qtyHdr: 'QTY',   rateHdr: 'PRICE' },
    { key: 'mileage', label: 'MILEAGE', qtyHdr: 'MILES', rateHdr: 'RATE' },
    { key: 'misc',    label: 'MISC',    qtyHdr: 'QTY',   rateHdr: 'RATE' },
    { key: 'custom',  label: 'OTHER',   qtyHdr: 'QTY',   rateHdr: 'RATE' }
  ];

  const escape = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderDescCell = (text) => escape(text || '').replace(/\n/g, '<br>');

  function renderLineRows(lines) {
    return lines.map((l, i) => `
      <tr style="background:${i % 2 === 1 ? '#f0f8fe' : '#fff'};">
        <td style="padding:6px 8px; border-right:1px solid #e0ecf5; font-size:12px; white-space:nowrap;">${escape(fmtDate(l.date))}</td>
        <td style="padding:6px 8px; border-right:1px solid #e0ecf5; font-size:12px;">${renderDescCell(l.desc)}${l.markup > 0 ? `<div style="font-size:10px; color:#888;">(${l.markup}% markup applied)</div>` : ''}</td>
        <td style="padding:6px 8px; border-right:1px solid #e0ecf5; font-size:12px; text-align:right; white-space:nowrap;">${l.qty || 0}</td>
        <td style="padding:6px 8px; border-right:1px solid #e0ecf5; font-size:12px; text-align:right; white-space:nowrap;">${fmtMoney(l.rate)}</td>
        <td style="padding:6px 8px; font-size:12px; font-weight:700; text-align:right; white-space:nowrap;">${fmtMoney(lineTotal(l))}</td>
      </tr>`).join('');
  }

  function renderSubSection(lines, sec) {
    return `
      <table style="width:100%; border-collapse:collapse; margin-bottom:0;">
        <thead>
          <tr style="background:#cdeefe;">
            <th colspan="5" style="text-align:left; padding:5px 8px; font-size:11px; color:#0d1626; font-weight:700; letter-spacing:0.5px;">${sec.label}</th>
          </tr>
          <tr style="background:#cdeefe;">
            <th style="padding:4px 8px; font-size:10px; color:#0d1626; text-align:left; width:80px;">DATE</th>
            <th style="padding:4px 8px; font-size:10px; color:#0d1626; text-align:left;">DESCRIPTION</th>
            <th style="padding:4px 8px; font-size:10px; color:#0d1626; text-align:right; width:60px;">${sec.qtyHdr}</th>
            <th style="padding:4px 8px; font-size:10px; color:#0d1626; text-align:right; width:80px;">${sec.rateHdr}</th>
            <th style="padding:4px 8px; font-size:10px; color:#0d1626; text-align:right; width:90px;">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          ${renderLineRows(lines)}
        </tbody>
      </table>`;
  }

  function renderTicketBlock(t, lines) {
    let ticketTotal = 0;
    const byType = {};
    lines.forEach(l => {
      const k = subSecs.find(s => s.key === l.type) ? l.type : 'custom';
      if (!byType[k]) byType[k] = [];
      byType[k].push(l);
      ticketTotal += lineTotal(l);
    });
    const subSecsHtml = subSecs.map(sec => byType[sec.key] && byType[sec.key].length > 0 ? renderSubSection(byType[sec.key], sec) : '').join('');
    const eq = t.equipmentInfo || {};
    const hasEq = eq.year || eq.makeModel || eq.serialOrVin || eq.odometer || eq.licensePlate;
    const eqStr = hasEq ? [
      `${eq.year || ''} ${eq.makeModel || ''}`.trim(),
      eq.serialOrVin ? 'SN: ' + eq.serialOrVin : '',
      eq.odometer ? 'Hrs/Mi: ' + eq.odometer : '',
      eq.licensePlate ? 'Plate: ' + eq.licensePlate : ''
    ].filter(Boolean).join(' • ') : '';

    const narrative = (label, text) => text && String(text).trim() ? `
      <div style="background:#fcfcf8; border:1px solid #e0e0d8; padding:8px 10px; margin-bottom:4px; font-size:13px;">
        <strong style="color:#0d1626; font-size:11px; text-transform:uppercase;">${label}:</strong>
        <span style="margin-left:8px;">${escape(text).replace(/\n/g, '<br>')}</span>
      </div>` : '';

    return `
      <div style="margin-bottom:16px; border:1px solid #d0d0c8; border-radius:6px; overflow:hidden;">
        <div style="background:#0d1626; color:#fff; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; border-left:4px solid #00bfff;">
          <div>
            <strong style="color:#00bfff; font-size:14px;">${escape(t.number)}</strong>
            <span style="margin-left:10px;">${escape(t.title || '')}</span>
          </div>
          ${t.jobCode ? `<span style="font-size:11px; color:#a0d8ef;">Job code: ${escape(t.jobCode)}</span>` : ''}
        </div>
        ${hasEq ? `<div style="background:#f0f8fe; padding:6px 12px; font-size:12px;"><strong style="color:#0d1626;">EQUIPMENT:</strong> ${escape(eqStr)}</div>` : ''}
        <div style="padding:8px 12px;">
          ${narrative('Complaint', t.complaint)}
          ${narrative('Diagnosis', t.diagnosis)}
          ${narrative('Work Performed', t.workSummary)}
        </div>
        <div style="padding:0 12px;">
          ${subSecsHtml}
        </div>
        <div style="background:#ebf5fc; padding:8px 12px; border-top:1px solid #0d1626; display:flex; justify-content:space-between; font-weight:700; color:#0d1626; font-size:13px;">
          <span>${escape(t.number)} SUBTOTAL</span>
          <span>${fmtMoney(ticketTotal)}</span>
        </div>
      </div>`;
  }

  const ticketBlocks = ticketsForInvoice.map(t => {
    const lines = itemsByTicket[t.id] || [];
    if (lines.length === 0) return '';
    return renderTicketBlock(t, lines);
  }).join('');

  const nonChargeLoose = looseItems.filter(l => l.type !== 'chargeback');
  const looseBlock = nonChargeLoose.length > 0 ? `
    <div style="margin-bottom:16px; border:1px solid #d0d0c8; border-radius:6px; overflow:hidden;">
      <div style="background:#0d1626; color:#fff; padding:8px 12px; border-left:4px solid #00bfff;">
        <strong style="color:#00bfff; font-size:14px;">ADDITIONAL ITEMS</strong>
      </div>
      <div style="padding:0 12px;">
        ${renderSubSection(nonChargeLoose, { label: 'OTHER', qtyHdr: 'QTY', rateHdr: 'RATE' })}
      </div>
    </div>` : '';

  const statusBadge = inv.status === 'paid'
    ? `<span style="background:#d6f4d6; color:#1a4d2e; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700;">PAID ${fmtDate(inv.paidDate)}</span>`
    : `<span style="background:#fff4d6; color:#8a6d00; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700;">SENT</span>`;

  const revisedBadge = inv.isRevised && inv.lastEditedDate
    ? `<span style="background:#fff4d6; color:#8a6d00; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; margin-left:6px;">REVISED ${fmtDate(inv.lastEditedDate)}</span>`
    : '';

  return `
    <div style="background:#fff; border:1px solid #d0d0c8; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.06); margin-bottom:16px;">
      <!-- TOP BANNER -->
      <div style="background:#0d1626; padding:16px 18px; display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div style="color:#00bfff; font-size:20px; font-weight:800; letter-spacing:0.5px;">${escape(s.businessName.toUpperCase())}</div>
          <div style="color:#a0d8ef; font-size:11px; margin-top:4px;">${escape(s.ownerName)}</div>
          ${s.phone ? `<div style="color:#a0d8ef; font-size:11px;">${escape(s.phone)}</div>` : ''}
        </div>
        <div style="text-align:right;">
          <div style="color:#fff; font-size:24px; font-weight:800; letter-spacing:1px;">INVOICE</div>
          <div style="color:#a0d8ef; font-size:11px; margin-top:4px;">${escape(s.email)}</div>
        </div>
      </div>
      <div style="height:3px; background:#00bfff;"></div>

      <!-- META ROW -->
      <div style="display:grid; grid-template-columns:1fr 1fr 1.5fr; gap:0; border-bottom:1px solid #d0d0c8;">
        <div style="border-right:1px solid #d0d0c8;">
          <div style="background:#0d1626; color:#00bfff; padding:3px 8px; font-size:9px; font-weight:700;">INVOICE #</div>
          <div style="padding:8px; font-size:14px; font-weight:700;">${escape(inv.number)}</div>
        </div>
        <div style="border-right:1px solid #d0d0c8;">
          <div style="background:#0d1626; color:#00bfff; padding:3px 8px; font-size:9px; font-weight:700;">DATE</div>
          <div style="padding:8px; font-size:13px;">${escape(fmtDate(inv.sentDate))}</div>
        </div>
        <div>
          <div style="background:#0d1626; color:#00bfff; padding:3px 8px; font-size:9px; font-weight:700;">STATUS</div>
          <div style="padding:8px; font-size:13px;">${statusBadge}${revisedBadge}</div>
        </div>
      </div>

      <!-- BILL TO -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:0; border-bottom:1px solid #d0d0c8;">
        <div style="border-right:1px solid #d0d0c8;">
          <div style="background:#0d1626; color:#00bfff; padding:3px 8px; font-size:9px; font-weight:700;">BILL TO</div>
          <div style="padding:8px; font-size:12px;">
            <strong>${cust ? escape(cust.name) : '—'}</strong><br>
            ${cust && cust.address ? escape(cust.address).replace(/\n/g, '<br>') : ''}
            ${cust && cust.phone ? '<br>Ph: ' + escape(cust.phone) : ''}
            ${cust && cust.email ? '<br>' + escape(cust.email) : ''}
          </div>
        </div>
        <div>
          <div style="background:#0d1626; color:#00bfff; padding:3px 8px; font-size:9px; font-weight:700;">SUMMARY</div>
          <div style="padding:8px; font-size:12px;">
            ${ticketsForInvoice.length} job${ticketsForInvoice.length !== 1 ? 's' : ''} on this invoice
          </div>
        </div>
      </div>

      <!-- TICKETS -->
      <div style="padding:14px;">
        ${ticketBlocks}
        ${looseBlock}
      </div>

      <!-- TOTALS -->
      <div style="padding:0 14px 14px 14px; display:grid; grid-template-columns:1fr 240px; gap:10px;">
        <div style="background:#fcfcf8; border:1px solid #e0e0d8; padding:10px; font-size:12px;">
          <strong style="color:#0d1626;">PAYMENT INSTRUCTIONS</strong>
          <div style="margin-top:6px;">${escape(s.paymentInstructions).replace(/\n/g, '<br>')}</div>
        </div>
        <div style="border:1.5px solid #0d1626;">
          <div style="background:#0d1626; color:#00bfff; padding:6px 10px; font-size:11px; font-weight:700;">INVOICE TOTAL</div>
          <div style="padding:8px 10px; font-size:12px;">
            <div style="display:flex; justify-content:space-between;"><span>Subtotal:</span><span>${fmtMoney(inv.subtotal)}</span></div>
            ${inv.chargeback && inv.chargeback !== 0 ? `<div style="display:flex; justify-content:space-between;"><span>Chargeback:</span><span>${fmtMoney(inv.chargeback)}</span></div>` : ''}
          </div>
          <div style="background:#0d1626; color:#fff; padding:10px; display:flex; justify-content:space-between; align-items:center;">
            <span style="color:#00bfff; font-weight:700; font-size:13px;">GRAND TOTAL</span>
            <span style="font-size:17px; font-weight:800;">${fmtMoney(inv.total)}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---------------- PDF GENERATION (AUTO-SHOP WORK ORDER STYLE) ----------------
// returnBlob: if true, returns { blob, filename } and skips download
function generatePDF(inv, returnBlob) {
  if (!window.jspdf || !window.jspdf.jsPDF) { showToast('PDF library not loaded', true); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const cust = data.customers.find(c => c.id === inv.customerId);
  const s = data.settings;

  // Brand colors
  const NAVY = [13, 22, 38];
  const CYAN = [0, 191, 255];
  const CYAN_LIGHT = [200, 235, 255];
  const BAND = [240, 248, 254];
  const BAND2 = [225, 240, 250];
  const GREY = [110, 110, 110];
  const BLACK = [0, 0, 0];

  const setFill = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const setText = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c) => doc.setDrawColor(c[0], c[1], c[2]);

  // Helper: filled rect with optional stroke
  function box(x, y, w, h, fill, stroke) {
    if (fill) { setFill(fill); doc.rect(x, y, w, h, 'F'); }
    if (stroke) { setDraw(stroke); doc.setLineWidth(0.6); doc.rect(x, y, w, h, 'S'); }
  }
  // Helper: cell with a label tab + value below
  function labelCell(x, y, w, h, label, value, opts) {
    opts = opts || {};
    box(x, y, w, h, opts.fill || null, NAVY);
    // Label tab
    setFill(NAVY); doc.rect(x, y, w, 12, 'F');
    setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(7);
    doc.text(String(label).toUpperCase(), x + 4, y + 9);
    // Value
    setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(opts.fontSize || 10);
    if (value) {
      const lines = doc.splitTextToSize(String(value), w - 8);
      lines.slice(0, Math.floor((h - 14) / 11)).forEach((ln, i) => {
        doc.text(ln, x + 4, y + 22 + i * 11);
      });
    }
  }

  // Page geometry
  const pageW = 612, pageH = 792;
  const M = 30;            // outer margin
  const innerW = pageW - M * 2;
  const right = pageW - M;
  let y = M;

  // ===== TOP BANNER: business name + INVOICE label =====
  // Left third: business identity on navy
  setFill(NAVY); doc.rect(M, y, innerW, 72, 'F');
  // Cyan side accent
  setFill(CYAN); doc.rect(M, y + 72, innerW, 4, 'F');

  setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(26);
  doc.text(s.businessName.toUpperCase(), M + 14, y + 32);
  setText(CYAN_LIGHT); doc.setFont('helvetica', 'normal').setFontSize(9);
  let bizY = y + 48;
  doc.text(s.ownerName, M + 14, bizY); bizY += 11;
  if (s.phone) { doc.text(s.phone, M + 14, bizY); bizY += 11; }
  // Right side: big "INVOICE" label
  setText([255, 255, 255]); doc.setFont('helvetica', 'bold').setFontSize(28);
  doc.text('INVOICE', right - 14, y + 38, { align: 'right' });
  setText(CYAN_LIGHT); doc.setFont('helvetica', 'normal').setFontSize(9);
  doc.text(s.email, right - 14, y + 56, { align: 'right' });

  y += 82;

  // ===== INVOICE META ROW (3 cells: Inv #, Date, Tickets) =====
  const ticketsForInvoice = (inv.ticketIds || []).map(id => data.tickets.find(t => t.id === id)).filter(Boolean);
  const ticketsStr = ticketsForInvoice.map(t => t.number).join(', ') || '—';
  const cellH = 42;
  const c1 = innerW * 0.30, c2 = innerW * 0.30, c3 = innerW * 0.40;
  labelCell(M,           y, c1, cellH, 'Invoice #', inv.number, { fontSize: 13 });
  labelCell(M + c1,      y, c2, cellH, 'Date',      fmtDate(inv.sentDate), { fontSize: 11 });
  labelCell(M + c1 + c2, y, c3, cellH, 'Ticket Reference', ticketsStr, { fontSize: 10 });

  if (inv.isRevised && inv.lastEditedDate) {
    setFill([255, 245, 200]); doc.rect(right - 110, y - 6, 110, 16, 'F');
    setDraw([200, 150, 0]); doc.setLineWidth(0.5); doc.rect(right - 110, y - 6, 110, 16, 'S');
    setText([150, 80, 0]); doc.setFont('helvetica', 'bold').setFontSize(9);
    doc.text('REVISED ' + fmtDate(inv.lastEditedDate), right - 55, y + 5, { align: 'center' });
  }
  y += cellH + 6;

  // ===== CUSTOMER + EQUIPMENT GRID (work-order style) =====
  // Row 1: Bill To (left half) | Vehicle/Equipment (right half)
  const halfW = innerW / 2;
  const billRowH = 70;
  // Build bill-to value
  const billToLines = [];
  if (cust) {
    billToLines.push(cust.name);
    if (cust.address) cust.address.split('\n').forEach(l => billToLines.push(l));
    if (cust.phone) billToLines.push('Ph: ' + cust.phone);
    if (cust.email) billToLines.push(cust.email);
  }
  labelCell(M, y, halfW, billRowH, 'Bill To', billToLines.join('\n'), { fontSize: 9.5 });

  // Right side: invoice summary count
  const ticketsCount = ticketsForInvoice.length;
  const summaryStr = ticketsCount > 0
    ? `${ticketsCount} job${ticketsCount !== 1 ? 's' : ''} on this invoice`
    : '—';
  labelCell(M + halfW, y, halfW, billRowH, 'Summary', summaryStr, { fontSize: 11 });
  y += billRowH + 12;

  // ===== COLUMN GEOMETRY (used by per-ticket tables) =====
  const colDate = M;
  const colDesc = M + 60;
  const colQty  = M + innerW - 200;
  const colRate = M + innerW - 130;
  const colTot  = M + innerW;

  function checkPageBreak(needed) {
    if (y + needed > pageH - 100) {
      doc.addPage();
      y = M;
    }
  }

  // ===== PER-TICKET SECTIONS =====
  // Group all line items by ticket. Items not tied to a ticket (chargebacks, custom)
  // get held aside for the summary block.
  const itemsByTicket = {};
  const looseItems = [];
  (inv.lineItems || []).forEach(l => {
    if (l.type === 'chargeback') { looseItems.push(l); return; }
    const tid = l._ticketId;
    if (!tid) { looseItems.push(l); return; }
    if (!itemsByTicket[tid]) itemsByTicket[tid] = [];
    itemsByTicket[tid].push(l);
  });

  const subSectionConfig = [
    { key: 'labor',   label: 'LABOR',   qtyHdr: 'HRS',   rateHdr: 'RATE' },
    { key: 'part',    label: 'PARTS',   qtyHdr: 'QTY',   rateHdr: 'PRICE' },
    { key: 'mileage', label: 'MILEAGE', qtyHdr: 'MILES', rateHdr: 'RATE' },
    { key: 'misc',    label: 'MISC',    qtyHdr: 'QTY',   rateHdr: 'RATE' },
    { key: 'custom',  label: 'OTHER',   qtyHdr: 'QTY',   rateHdr: 'RATE' }
  ];

  function drawSubSectionHeader(label, qtyHdr, rateHdr) {
    checkPageBreak(40);
    // Row 1: section label band (cyan with navy text, full width)
    setFill(CYAN_LIGHT); doc.rect(M, y, innerW, 14, 'F');
    setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(9);
    doc.text(label, M + 8, y + 10);
    y += 14;
    // Row 2: column headers band (slightly darker, smaller text)
    setFill([235, 245, 252]); doc.rect(M, y, innerW, 14, 'F');
    setDraw([200, 215, 230]); doc.setLineWidth(0.3);
    doc.line(M, y + 14, M + innerW, y + 14);
    setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(7.5);
    doc.text('DATE', colDate + 4, y + 10);
    doc.text('DESCRIPTION', colDesc + 4, y + 10);
    doc.text(qtyHdr, colQty - 4, y + 10, { align: 'right' });
    doc.text(rateHdr, colRate - 4, y + 10, { align: 'right' });
    doc.text('AMOUNT', colTot - 4, y + 10, { align: 'right' });
    y += 14;
  }

  function drawLineRow(line, rowIdx) {
    const desc = String(line.desc || '');
    const descLines = doc.splitTextToSize(desc, colQty - colDesc - 8);
    const extraH = (line.markup && line.markup > 0) ? 10 : 0;
    const rowH = Math.max(18, descLines.length * 11 + 4 + extraH);
    checkPageBreak(rowH + 30);
    if (rowIdx % 2 === 1) {
      setFill(BAND); doc.rect(M, y, innerW, rowH, 'F');
    }
    setDraw([220, 220, 220]); doc.setLineWidth(0.3);
    [colDesc, colQty, colRate].forEach(x => doc.line(x, y, x, y + rowH));

    setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(9);
    doc.text(fmtDate(line.date) || '', colDate + 4, y + 11);
    descLines.forEach((dl, i) => {
      doc.text(dl, colDesc + 4, y + 11 + i * 11);
    });
    if (line.markup && line.markup > 0) {
      setText(GREY); doc.setFontSize(7);
      doc.text('(' + line.markup + '% markup applied)', colDesc + 4, y + 11 + descLines.length * 11);
      setText(BLACK); doc.setFontSize(9);
    }
    doc.text(String(line.qty || 0), colQty - 4, y + 11, { align: 'right' });
    doc.text(fmtMoney(line.rate), colRate - 4, y + 11, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.text(fmtMoney(lineTotal(line)), colTot - 4, y + 11, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += rowH;
  }

  function drawNarrativeBlock(label, text) {
    if (!text || !String(text).trim()) return;
    const valueX = 130; // pushed out so the longest label ("WORK PERFORMED:") never overlaps
    const lines = doc.splitTextToSize(String(text).trim(), innerW - (valueX - M) - 10);
    const blockH = Math.max(20, 6 + lines.length * 11 + 4);
    checkPageBreak(blockH + 4);
    setFill([252, 252, 248]); doc.rect(M, y, innerW, blockH, 'F');
    setDraw([200, 200, 195]); doc.setLineWidth(0.3); doc.rect(M, y, innerW, blockH, 'S');
    setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(8.5);
    doc.text(label.toUpperCase() + ':', M + 6, y + 12);
    setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(9);
    lines.forEach((ln, i) => {
      doc.text(ln, M + valueX - M, y + 12 + i * 11);
    });
    y += blockH + 2;
  }

  function drawTicketBlock(ticket, lines) {
    checkPageBreak(80);

    // ---- Ticket header bar (navy with cyan title) ----
    setFill(NAVY); doc.rect(M, y, innerW, 22, 'F');
    setFill(CYAN); doc.rect(M, y, 4, 22, 'F'); // cyan left edge accent
    setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(11);
    doc.text(ticket.number, M + 12, y + 15);
    setText([255, 255, 255]); doc.setFont('helvetica', 'normal').setFontSize(10);
    const titleStr = ticket.title || '(untitled)';
    doc.text(titleStr, M + 110, y + 15);
    if (ticket.jobCode) {
      setText(CYAN_LIGHT); doc.setFontSize(8);
      doc.text('Job code: ' + ticket.jobCode, right - 8, y + 15, { align: 'right' });
    }
    y += 26;

    // ---- Equipment row (if any equipment info) ----
    const eq = ticket.equipmentInfo || {};
    const hasEq = eq.year || eq.makeModel || eq.serialOrVin || eq.odometer || eq.licensePlate;
    if (hasEq) {
      const eqStr = [
        (`${eq.year || ''} ${eq.makeModel || ''}`.trim()),
        eq.serialOrVin ? 'SN: ' + eq.serialOrVin : '',
        eq.odometer ? 'Hrs/Mi: ' + eq.odometer : '',
        eq.licensePlate ? 'Plate: ' + eq.licensePlate : ''
      ].filter(Boolean).join('  •  ');
      checkPageBreak(20);
      setFill([245, 250, 255]); doc.rect(M, y, innerW, 16, 'F');
      setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(8);
      doc.text('EQUIPMENT:', M + 6, y + 11);
      setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(9);
      doc.text(eqStr, M + 76, y + 11);
      y += 18;
    }

    // ---- Narrative blocks ----
    drawNarrativeBlock('Complaint', ticket.complaint);
    drawNarrativeBlock('Diagnosis', ticket.diagnosis);
    drawNarrativeBlock('Work Performed', ticket.workSummary);

    y += 4;

    // ---- Line item subsections (only for types this ticket has lines in) ----
    const byType = {};
    lines.forEach(l => {
      const t = (l.type === 'custom' || !subSectionConfig.find(s => s.key === l.type)) ? 'custom' : l.type;
      if (!byType[t]) byType[t] = [];
      byType[t].push(l);
    });

    let ticketTotal = 0;
    subSectionConfig.forEach(sec => {
      const subLines = byType[sec.key];
      if (!subLines || subLines.length === 0) return;
      drawSubSectionHeader(sec.label, sec.qtyHdr, sec.rateHdr);
      subLines.forEach((line, i) => {
        drawLineRow(line, i);
        ticketTotal += lineTotal(line);
      });
    });

    // ---- Ticket subtotal bar ----
    checkPageBreak(22);
    setFill([235, 245, 252]); doc.rect(M, y, innerW, 18, 'F');
    setDraw(NAVY); doc.setLineWidth(0.8); doc.rect(M, y, innerW, 18, 'S');
    setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(10);
    doc.text(ticket.number + ' SUBTOTAL', M + 8, y + 12);
    doc.text(fmtMoney(ticketTotal), right - 8, y + 12, { align: 'right' });
    y += 26;
  }

  // Render each ticket block
  ticketsForInvoice.forEach(t => {
    const lines = itemsByTicket[t.id] || [];
    if (lines.length === 0) return;
    drawTicketBlock(t, lines);
  });

  // Render any non-ticket items (custom lines added in invoice builder, etc) under "Additional Items"
  const nonChargeLoose = looseItems.filter(l => l.type !== 'chargeback');
  if (nonChargeLoose.length > 0) {
    checkPageBreak(60);
    setFill(NAVY); doc.rect(M, y, innerW, 22, 'F');
    setFill(CYAN); doc.rect(M, y, 4, 22, 'F');
    setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(11);
    doc.text('ADDITIONAL ITEMS', M + 12, y + 15);
    y += 26;
    drawSubSectionHeader('OTHER', 'QTY', 'RATE');
    let extraTotal = 0;
    nonChargeLoose.forEach((line, i) => {
      drawLineRow(line, i);
      extraTotal += lineTotal(line);
    });
    checkPageBreak(22);
    setFill([235, 245, 252]); doc.rect(M, y, innerW, 18, 'F');
    setDraw(NAVY); doc.setLineWidth(0.8); doc.rect(M, y, innerW, 18, 'S');
    setText(NAVY); doc.setFont('helvetica', 'bold').setFontSize(10);
    doc.text('ADDITIONAL ITEMS SUBTOTAL', M + 8, y + 12);
    doc.text(fmtMoney(extraTotal), right - 8, y + 12, { align: 'right' });
    y += 26;
  }

  if (ticketsForInvoice.length === 0 && nonChargeLoose.length === 0) {
    setText(GREY); doc.setFont('helvetica', 'italic').setFontSize(10);
    doc.text('(No line items)', M + innerW / 2, y + 20, { align: 'center' });
    y += 40;
    setText(BLACK);
  }

  // ===== GRAND TOTAL BLOCK (right-side) + payment instructions (left) =====
  checkPageBreak(120);
  y += 6;
  const totalsW = 240;
  const totalsX = right - totalsW;
  const totalsY = y;

  // Frame
  setDraw(NAVY); doc.setLineWidth(1.2);
  doc.rect(totalsX, totalsY, totalsW, 100, 'S');
  // Header
  setFill(NAVY); doc.rect(totalsX, totalsY, totalsW, 18, 'F');
  setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(10);
  doc.text('INVOICE TOTAL', totalsX + 8, totalsY + 13);

  setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(9);
  let ty = totalsY + 32;
  doc.text('Subtotal:', totalsX + 10, ty);
  doc.text(fmtMoney(inv.subtotal), totalsX + totalsW - 10, ty, { align: 'right' });
  ty += 14;
  if (inv.chargeback && inv.chargeback !== 0) {
    doc.text('Chargeback:', totalsX + 10, ty);
    doc.text(fmtMoney(inv.chargeback), totalsX + totalsW - 10, ty, { align: 'right' });
    ty += 14;
  }
  // Grand Total band
  setFill(NAVY); doc.rect(totalsX, totalsY + 66, totalsW, 34, 'F');
  setText(CYAN); doc.setFont('helvetica', 'bold').setFontSize(13);
  doc.text('GRAND TOTAL', totalsX + 10, totalsY + 88);
  setText([255, 255, 255]); doc.setFontSize(16);
  doc.text(fmtMoney(inv.total), totalsX + totalsW - 10, totalsY + 88, { align: 'right' });
  setText(BLACK);

  // Payment instructions (left of total box)
  setFill([252, 252, 248]); doc.rect(M, totalsY, totalsX - M - 10, 100, 'F');
  setDraw([200, 200, 195]); doc.setLineWidth(0.4); doc.rect(M, totalsY, totalsX - M - 10, 100, 'S');
  doc.setFont('helvetica', 'bold').setFontSize(9);
  setText(NAVY);
  doc.text('PAYMENT INSTRUCTIONS', M + 8, totalsY + 14);
  setText(BLACK); doc.setFont('helvetica', 'normal').setFontSize(8.5);
  let py = totalsY + 28;
  s.paymentInstructions.split('\n').forEach(line => {
    if (py < totalsY + 96) { doc.text(line, M + 8, py); py += 11; }
  });

  y = totalsY + 110;

  // ===== SIGNATURE LINES =====
  checkPageBreak(60);
  y += 8;
  setDraw(BLACK); doc.setLineWidth(0.5);
  doc.line(M, y, M + 240, y);
  doc.line(right - 200, y, right, y);
  setText(GREY); doc.setFont('helvetica', 'normal').setFontSize(8);
  doc.text('Customer Authorized Signature', M, y + 11);
  doc.text('Date', right - 200, y + 11);
  setText(BLACK);

  // ===== FOOTER =====
  // Cyan accent rule above footer
  setFill(CYAN); doc.rect(M, pageH - 38, innerW, 2, 'F');
  setText(GREY); doc.setFont('helvetica', 'italic').setFontSize(9);
  doc.text('Thank you for your business — ' + (s.ownerName.split(' ')[0] || 'Ken'),
    M + innerW / 2, pageH - 22, { align: 'center' });
  doc.setFontSize(7);
  doc.text(s.businessName + ' • ' + (s.phone || '') + ' • ' + s.email,
    M + innerW / 2, pageH - 12, { align: 'center' });

  const filename = (inv.number || 'invoice').replace(/[^a-z0-9-]/gi, '_') +
    '_' + (cust ? cust.name.replace(/[^a-z0-9]/gi, '_') : 'customer') + '.pdf';

  if (returnBlob) {
    const blob = doc.output('blob');
    return { blob, filename };
  }

  doc.save(filename);
  showToast('PDF saved: ' + filename);
}

// ---------------- EMAIL INVOICE ----------------
async function emailInvoice(inv) {
  const cust = data.customers.find(c => c.id === inv.customerId);
  const s = data.settings;

  // Build a short equipment overview from the tickets on this invoice
  const ticketsForInvoice = (inv.ticketIds || []).map(id => data.tickets.find(t => t.id === id)).filter(Boolean);
  const equipList = ticketsForInvoice.map(t => {
    const eq = t.equipmentInfo || {};
    const yearMake = `${eq.year || ''} ${eq.makeModel || ''}`.trim();
    return yearMake || t.title || '';
  }).filter(Boolean);

  // Build a one-line summary of equipment for the body
  let equipSummary;
  if (equipList.length === 0) {
    equipSummary = 'requested work';
  } else if (equipList.length === 1) {
    equipSummary = equipList[0];
  } else if (equipList.length === 2) {
    equipSummary = equipList[0] + ' and ' + equipList[1];
  } else {
    equipSummary = equipList[0] + ' and other equipment';
  }

  // Greeting — first word of customer name
  const greeting = cust && cust.name
    ? 'Hi ' + cust.name.split(/[\s,]/)[0] + ','
    : 'Hi,';

  // Date for subject (use invoice date, formatted clean)
  const dateForSubject = fmtDate(inv.sentDate);

  const subject = `${inv.number} — Mechanical work performed on ${dateForSubject}`;

  const body = `${greeting}

Attached is invoice ${inv.number} (${fmtMoney(inv.total)}) for work performed on ${dateForSubject} on ${equipSummary}. Full details on the invoice.

------------------------------------------
PAYMENT OPTIONS (no fees on Zelle)
------------------------------------------
Zelle email:   muzzleflash9600@gmail.com
Zelle phone:   (210) 529-0883
Zelle name:    Kenneth Stevens

Or mail check payable to:
   ${s.ownerName}
   ${(s.address || '').split('\n').join('\n   ')}
------------------------------------------

Thanks for your business,

${s.ownerName.split(' ')[0]}
${s.businessName}
${s.phone || ''}
${s.email || ''}`;

  const to = cust && cust.email ? cust.email : '';
  if (!to) {
    showToast('No email on file for this customer — add one in Customers', true);
    return;
  }

  // ---- Try the Web Share API path (iPhone/Android — attaches PDF) ----
  try {
    const result = generatePDF(inv, true); // returns { blob, filename }
    if (result && result.blob && navigator.canShare) {
      const file = new File([result.blob], result.filename, { type: 'application/pdf' });
      const shareData = { files: [file], title: subject, text: body };
      if (navigator.canShare(shareData)) {
        showToast('Opening share sheet — pick Mail');
        await navigator.share(shareData);
        return;
      }
    }
  } catch (err) {
    // User cancelled the share, or the share API threw — fall through to mailto
    if (err && err.name === 'AbortError') {
      // User explicitly cancelled — no need to fall through
      return;
    }
    console.warn('Web Share failed, falling back:', err);
  }

  // ---- Fallback: download PDF + open mailto (manual attach) ----
  generatePDF(inv); // saves to device
  const mailto = 'mailto:' + encodeURIComponent(to) +
    '?subject=' + encodeURIComponent(subject) +
    '&body=' + encodeURIComponent(body);
  window.location.href = mailto;
  showToast('PDF downloaded — attach it to the email');
}

// ---------------- SETTINGS ----------------
function prepareSettings() {
  const s = data.settings;
  document.getElementById('set-business-name').value = s.businessName || '';
  document.getElementById('set-owner-name').value = s.ownerName || '';
  document.getElementById('set-address').value = s.address || '';
  document.getElementById('set-email').value = s.email || '';
  document.getElementById('set-phone').value = s.phone || '';
  document.getElementById('set-payment-instructions').value = s.paymentInstructions || '';
  const ver = document.getElementById('app-version');
  if (ver) ver.textContent = APP_VERSION;
}

document.getElementById('settings-save-btn').addEventListener('click', () => {
  data.settings.businessName = document.getElementById('set-business-name').value.trim();
  data.settings.ownerName = document.getElementById('set-owner-name').value.trim();
  data.settings.address = document.getElementById('set-address').value.trim();
  data.settings.email = document.getElementById('set-email').value.trim();
  data.settings.phone = document.getElementById('set-phone').value.trim();
  data.settings.paymentInstructions = document.getElementById('set-payment-instructions').value.trim();
  saveData();
  showToast('Settings saved');
  showScreen('dashboard');
});

document.getElementById('export-backup-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kens-diesel-backup-' + todayISO() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded');
});

document.getElementById('import-backup-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!confirm('Replace ALL current data with backup?')) return;
      data = imported;
      migrateIfNeeded();
      saveData();
      showToast('Backup imported');
      showScreen('dashboard');
    } catch (err) { showToast('Invalid backup file', true); }
  };
  reader.readAsText(file);
});

document.getElementById('settings-btn').addEventListener('click', () => showScreen('settings'));

// ---------------- DIAGNOSTIC EXPORT ----------------
document.getElementById('diag-export-btn').addEventListener('click', () => {
  if (!confirm('This will download a file with all your app data and open an email to Chad. Continue?')) return;

  const diag = {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    online: navigator.onLine,
    screen: { w: screen.width, h: screen.height },
    storageEstimate: 'unknown',
    driveSyncState: {
      enabled: driveState.enabled,
      signedIn: driveState.signedIn,
      lastSyncedAt: driveState.lastSyncedAt ? new Date(driveState.lastSyncedAt).toISOString() : null,
      pendingChanges: driveState.pendingChanges,
      driveFileExists: !!driveState.driveFileId
    },
    counts: {
      customers: data.customers.length,
      tickets: data.tickets.length,
      invoices: data.invoices.length,
      openTickets: data.tickets.filter(t => t.status === 'open').length,
      openInvoices: data.invoices.filter(i => i.status === 'sent').length
    },
    recentErrors: errorLog.slice(-20),
    fullData: data
  };

  // Try to get storage estimate (chrome supports it)
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(est => {
      diag.storageEstimate = `used ${Math.round(est.usage / 1024)} KB of ${Math.round(est.quota / 1024 / 1024)} MB`;
    }).finally(() => downloadAndEmailDiag(diag));
  } else {
    downloadAndEmailDiag(diag);
  }
});

function downloadAndEmailDiag(diag) {
  // 1. Download the JSON file
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `kens-diesel-diagnostic-${stamp}.json`;
  const blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  // 2. Open email pre-filled
  const subject = `Ken's Diesel App — Diagnostic ${stamp}`;
  const body = `Hi Chad,

Something's not working right with the app. Diagnostic file just downloaded — I'll attach it before sending this email.

What I was trying to do:
[describe what you were doing when it broke]

What went wrong:
[what did you see / what didn't work]

App version: ${APP_VERSION}
Customers: ${diag.counts.customers}
Tickets: ${diag.counts.tickets}
Invoices: ${diag.counts.invoices}
${diag.recentErrors.length > 0 ? '\nRecent errors logged: ' + diag.recentErrors.length : ''}

Thanks,
Ken`;

  const mailto = 'mailto:chadcrocker@cacattlebrd.com?subject=' +
    encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  window.location.href = mailto;
  showToast('Attach the diagnostic file before sending');
}

// ---------------- GLOBAL EVENT DELEGATION ----------------
document.addEventListener('click', e => {
  const navTarget = e.target.closest('[data-nav]');
  if (navTarget) { showScreen(navTarget.getAttribute('data-nav')); return; }
  const item = e.target.closest('[data-action]');
  if (item) {
    const action = item.getAttribute('data-action');
    const id = item.getAttribute('data-id');
    if (action === 'open-ticket') { showScreen('ticket'); prepareTicket(id); }
    else if (action === 'edit-line') {
      const tid = item.getAttribute('data-tid');
      prepareLineEditor(tid, id, null);
      showScreen('line');
    }
    else if (action === 'edit-customer') editCustomer(id);
    else if (action === 'open-invoice') openInvoiceDetail(id);
  }
});

// ---------------- BOOT ----------------
loadData();
migrateIfNeeded();
initDriveSync();
// Render version stamp at the bottom of the app
const verEl = document.getElementById('app-version-num');
if (verEl) verEl.textContent = APP_VERSION;
checkForUpdate();
// Also check every 5 min while app is open in case Ken leaves it open all day
setInterval(checkForUpdate, 5 * 60 * 1000);

// First-run: pre-load CA Cattle as a customer if none exist
if (data.customers.length === 0) {
  data.customers.push({
    id: uuid(),
    name: 'CA Cattle Company - BRD',
    shortCode: 'CA',
    address: '902 Monterey St\nSan Antonio, TX 78207',
    phone: '325-347-2580',
    email: 'chadcrocker@cacattlebrd.com',
    ein: '',
    notes: 'Bakery Recycling Division',
    nextTicketNum: 1,
    created: todayISO()
  });
  saveData();
}

showScreen('dashboard');
