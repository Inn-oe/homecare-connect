'use strict';
// HomeCare Connect web app: public site + three role apps (homeowner, partner, operations).
// Hash routes (#/bookings/12) so the browser back button works everywhere.

const S = {
  token: null,
  user: null,
  provider: null,
  config: null,
  catalog: [],
  properties: [],
  wiz: null,          // booking wizard state
  afterLogin: null,   // route to return to after logging in / signing up
  routeSeq: 0,
  poll: null,
  dialogResolve: null,
};
try { S.token = localStorage.getItem('token'); } catch { /* storage unavailable */ }

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : '$' + Number(n).toFixed(2).replace(/\.00$/, ''));
const initials = (name) => esc(String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
const firstName = (name) => String(name || '').split(/\s+/)[0];
const go = (path) => { location.hash = '#/' + path; };

const sameDay = (a, b) => a.toDateString() === b.toDateString();
function dayLabel(d) {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 864e5);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
const timeLabel = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const fmtWhen = (iso) => { const d = new Date(iso); return `${dayLabel(d)}, ${timeLabel(d)}`; };
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtStamp = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${timeLabel(d)}`; };

// +263771234567 -> 0771 234 567
function fmtPhone(p) {
  if (!p) return '';
  if (!p.startsWith('+263')) return p;
  const s = p.slice(4);
  return `0${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}`;
}
const telHref = (p) => `tel:${p}`;
const waHref = (p, text = '') => `https://wa.me/${String(p).replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const mapsHref = (b) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  [b.address, b.suburb, String(b.zone || '').split(' – ')[0], 'Zimbabwe'].filter(Boolean).join(', '))}`;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) {
    logout();
    throw new Error('Your session has expired. Please log in again.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.innerHTML = `${icon(isError ? 'alert' : 'check', 18)}<span>${esc(message)}</span>`;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 3000);
}

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const first = $('#modal-body').querySelector('input:not([type=hidden]), textarea, select');
  if (first && matchMedia('(min-width: 761px)').matches) first.focus();
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
  if (S.dialogResolve) {
    S.dialogResolve(false);
    S.dialogResolve = null;
  }
}
const modalOpen = () => !$('#modal').hidden;

// Promise-based confirm dialog, styled like the rest of the app.
function confirmDialog({ title, body = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    closeModal();
    openModal(`
      <h2>${esc(title)}</h2>
      ${body ? `<p class="muted">${esc(body)}</p>` : ''}
      <div class="btn-row end" style="margin-top:22px">
        <button class="btn" data-act="dialog" data-v="0">Go back</button>
        <button class="btn ${danger ? 'danger solid' : 'primary'}" data-act="dialog" data-v="1">${esc(confirmText)}</button>
      </div>`);
    S.dialogResolve = resolve;
  });
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="16" cy="13.5" r="1.3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2.5.5 4 2.5 4 5.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.3-4.4A9 9 0 1 1 21 12z"/>',
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v4M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  logout: '<path d="M9 4H5v16h4M14 8l4 4-4 4M18 12H9"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  nav: '<path d="M3 11 21 3l-8 18-2-8z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  // Category icons
  lawn: '<path d="M3 21h18"/><path d="M6 21c0-5-2-8-3-9M10 21c0-6 1-10 3-13M14 21c0-4 2-7 5-9M18 21c0-3-1-5-2-6"/>',
  yard: '<path d="M15 3 10.5 11"/><path d="M6.5 11h8l2 3.5-1.5 6.5H6l-1.5-6.5z"/><path d="M9 15v5M12 15v5"/>',
  tree: '<path d="M12 22v-6"/><path d="M12 2 5 12h4l-3 4h12l-3-4h4z"/>',
  bug: '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M9.5 4 11 6.5M14.5 4 13 6.5M8 11H4M8 15.5H4M16 11h4M16 15.5h4M12 7v13"/>',
  sparkle: '<path d="M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z"/><path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  camera: '<path d="M2.5 7.5 15 4l2 6-12.5 3.5z"/><path d="m17 8 4-1v5l-3.5 1M9 12.5V17H4M4 15v4"/>',
  maid: '<circle cx="12" cy="5.5" r="2.8"/><path d="M8.5 11h7l2 10h-11z"/><path d="M10 11l2 3 2-3"/>',
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${name === 'star' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const CAT_STYLE = {
  lawn: ['lawn', '#e5f3eb', '#17734a'],
  yard: ['yard', '#f5efe0', '#7a5a12'],
  trees: ['tree', '#e2efe0', '#2e6b2a'],
  fumigation: ['bug', '#fdecea', '#b42318'],
  cleaning: ['sparkle', '#e6effb', '#1b5aa6'],
  cctv: ['camera', '#ecebfb', '#4636a3'],
  maids: ['maid', '#fbeaf3', '#a3326b'],
};
function catIcon(catId, size = 46) {
  const [name, bg, fg] = CAT_STYLE[catId] || ['tag', '#eef1ef', '#5c6862'];
  return `<span class="cat-icon" style="background:${bg};color:${fg};width:${size}px;height:${size}px;border-radius:${Math.round(size / 3.6)}px">${icon(name, Math.round(size * 0.52))}</span>`;
}
const logoMark = () => `<span class="logo-mark">${icon('home', 20)}</span>`;

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const STATUS = {
  quote_requested: ['Awaiting quote', 'amber'],
  quoted: ['Quote ready', 'blue'],
  confirmed: ['Finding a partner', 'amber'],
  offered: ['Partner reviewing', 'blue'],
  accepted: ['Partner assigned', 'blue'],
  en_route: ['On the way', 'blue'],
  in_progress: ['In progress', 'blue'],
  completed: ['Done – please confirm', 'green'],
  closed: ['Completed', 'gray'],
  disputed: ['Problem reported', 'red'],
  cancelled: ['Cancelled', 'gray'],
  refunded: ['Refunded', 'gray'],
};
const STATUS_BY_ROLE = {
  provider: { offered: ['New offer', 'amber'], accepted: ['Accepted', 'blue'], completed: ['Awaiting customer', 'green'] },
  admin: { offered: ['Offered', 'blue'], completed: ['Awaiting confirmation', 'green'] },
};
const statusInfo = (s) => STATUS_BY_ROLE[S.user?.role]?.[s] || STATUS[s] || [s, 'gray'];
const pill = (s) => { const [label, color] = statusInfo(s); return `<span class="pill ${color}">${esc(label)}</span>`; };

const PAYMENT = { unpaid: 'Not paid yet', pending_verification: 'Being checked', paid: 'Paid', cash_collected: 'Paid in cash', refunded: 'Refunded' };
const OPEN_PAYMENT = ['confirmed', 'offered', 'accepted', 'en_route', 'in_progress', 'completed', 'closed', 'disputed'];
const CANCELLABLE = ['quote_requested', 'quoted', 'confirmed', 'offered', 'accepted'];
const CONTACT_SHARED = ['accepted', 'en_route', 'in_progress', 'completed', 'closed', 'disputed'];
const ACTIVE = ['quote_requested', 'quoted', 'confirmed', 'offered', 'accepted', 'en_route', 'in_progress', 'completed', 'disputed'];
const PARTNER_ACTIVE = ['accepted', 'en_route', 'in_progress'];

const allServices = () => S.catalog.flatMap((c) => c.services.map((s) => ({ ...s, category: c })));
const findService = (id) => allServices().find((s) => s.id === Number(id));
const findCategory = (id) => S.catalog.find((c) => c.id === id);
const payName = (k) => S.config.paymentMethods[k] || k;

function fromPrice(s) {
  if (s.pricing_type === 'quote') return { main: 'Free quote', sub: 'after site visit' };
  const min = Math.min(...s.options.map((o) => o.price));
  if (s.pricing_type === 'placement') return { main: money(min), sub: 'placement fee' };
  return { main: `from ${money(min)}`, sub: s.unit_label ? `per ${s.unit_label}` : '' };
}

function optionText(b) {
  if (!b.option_label) return b.pricing_type === 'quote' ? 'Site visit & quote' : '—';
  return `${b.option_label}${b.quantity > 1 ? ` × ${b.quantity}` : ''}`;
}

const EVENT_LABELS = {
  accept_quote: 'Quote accepted', decline_quote: 'Quote declined', submit_payment: 'Payment submitted',
  confirm: 'Customer confirmed the job', dispute: 'Problem reported', accept: 'Partner accepted',
  decline: 'Partner declined', en_route: 'Partner on the way', start: 'Job started', complete: 'Job finished',
  set_quote: 'Quote sent', assign: 'Offered to partner', auto_assign: 'Offered to partner (auto-assign)',
  verify_payment: 'Payment confirmed', close: 'Job closed', refund: 'Refunded', cancel: 'Cancelled',
};
const eventLabel = (e) => (e.action === 'create'
  ? (e.status === 'quote_requested' ? 'Site visit requested' : 'Booking made')
  : EVENT_LABELS[e.action] || statusInfo(e.status)[0]);

function trackerHtml(b) {
  if (['cancelled', 'refunded', 'disputed'].includes(b.status)) return '';
  const steps = [
    ...(b.pricing_type === 'quote' ? [['Quote', ['quote_requested', 'quoted']]] : []),
    ['Booked', ['confirmed', 'offered']],
    ['Assigned', ['accepted']],
    ['On the way', ['en_route']],
    ['Working', ['in_progress']],
    ['Done', ['completed', 'closed']],
  ];
  const current = steps.findIndex(([, statuses]) => statuses.includes(b.status));
  const allDone = b.status === 'closed';
  return `<div class="track-steps">${steps.map(([label], i) => {
    const cls = allDone || i < current ? 'done' : i === current ? 'current' : '';
    return `<div class="step ${cls}"><div class="dot">${cls === 'done' ? icon('check', 14) : ''}</div>${label}</div>`;
  }).join('')}</div>`;
}

function starsText(avg, count) {
  if (!count) return '<span class="faint small">New partner</span>';
  return `<span class="stars-inline">★ ${Number(avg).toFixed(1)}</span> <span class="faint small">(${count})</span>`;
}

function contactButtons(phone, waText = '') {
  if (!phone) return '';
  return `<div class="btn-row">
    <a class="btn sm" href="${telHref(phone)}">${icon('phone', 16)} Call</a>
    <a class="btn sm whatsapp" href="${waHref(phone, waText)}" target="_blank" rel="noopener">${icon('chat', 16)} WhatsApp</a>
  </div>`;
}

function emptyState(iconName, title, text, action = '') {
  return `<div class="empty"><div class="icon">${icon(iconName, 28)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

function bookingRow(b, href) {
  const who = S.user.role === 'admin' ? `${esc(b.homeowner_name)} · ${esc(b.suburb)}` : S.user.role === 'provider' ? `${esc(b.suburb)}, ${esc(b.zone)}` : esc(b.property_label);
  const price = S.user.role === 'provider' ? b.provider_share : b.price;
  return `
    <a class="list-row" href="#/${href}">
      ${catIcon(b.category_id, 42)}
      <div class="body">
        <div class="title">${esc(b.service_name)}</div>
        <div class="sub">${fmtWhen(b.scheduled_for)} · ${who}</div>
        ${pill(b.status)}
      </div>
      <div class="end"><span class="small strong">${price == null ? '' : money(price)}</span></div>
      <span class="chev">${icon('right', 18)}</span>
    </a>`;
}

const supportLink = (text = 'WhatsApp support') =>
  `<a href="${waHref(S.config.supportPhone, `Hi ${S.config.company}, I need help`)}" target="_blank" rel="noopener">${esc(text)}</a>`;

// ---------------------------------------------------------------------------
// Session & routing
// ---------------------------------------------------------------------------

async function boot() {
  S.config = await api('/config');
  document.title = S.config.company;
  if (S.token) {
    try {
      const me = await api('/me');
      S.user = me.user;
      S.provider = me.provider;
    } catch {
      S.token = null;
      S.user = null;
    }
  }
  S.catalog = await api('/catalog');
  route();
}

function startSession({ token, user }) {
  S.token = token;
  try { localStorage.setItem('token', token); } catch { /* ignore */ }
  S.user = user;
  api('/me').then((me) => {
    S.provider = me.provider;
    const next = S.afterLogin || '';
    S.afterLogin = null;
    $('#app').innerHTML = '';
    if (location.hash === '#/' + next) route();
    else go(next);
  });
}

function logout() {
  S.token = S.user = S.provider = S.wiz = null;
  try { localStorage.removeItem('token'); } catch { /* ignore */ }
  stopPoll();
  $('#app').innerHTML = '';
  if (location.hash === '#/' || location.hash === '') route();
  else go('');
}

function parseRoute() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

const NAV = {
  homeowner: [['', 'Home', 'home'], ['bookings', 'My bookings', 'calendar'], ['account', 'Account', 'user']],
  provider: [['', 'Jobs', 'briefcase'], ['history', 'History', 'list'], ['earnings', 'Earnings', 'wallet'], ['account', 'Account', 'user']],
  admin: [['', 'Dashboard', 'chart'], ['bookings', 'Bookings', 'calendar'], ['partners', 'Partners', 'users'], ['settlements', 'Payouts', 'wallet'], ['services', 'Prices', 'tag'], ['account', 'Account', 'user']],
};
const NAV_ALIAS = { services: '', book: '', jobs: '' };

function renderShell() {
  document.body.classList.add('has-nav');
  const items = NAV[S.user.role];
  const link = (cls, size) => ([path, label, ic]) =>
    `<a href="#/${path}" data-nav="${path}">${icon(ic, size)}<span>${label}</span><span class="badge hidden" data-badge="${path}"></span></a>`;
  $('#app').innerHTML = `
    <header class="header">
      <a class="logo" href="#/">${logoMark()}<span>${esc(S.config.company)}</span></a>
      <nav class="topnav">${items.map(link('', 18)).join('')}</nav>
      <div class="me"><span class="only-desktop">${esc(S.user.name)}</span><a class="avatar" href="#/account" title="Account">${initials(S.user.name)}</a></div>
    </header>
    <main id="main"></main>
    <nav class="bottomnav">${items.map(link('', 22)).join('')}</nav>`;
}

function setActiveNav(parts) {
  const key = parts[0] in NAV_ALIAS ? NAV_ALIAS[parts[0]] : parts[0] || '';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function setBadge(path, n) {
  $$(`[data-badge="${path}"]`).forEach((el) => {
    el.textContent = n;
    el.classList.toggle('hidden', !n);
  });
}

async function refreshBadges() {
  try {
    if (S.user?.role === 'provider') {
      const rows = await api('/bookings');
      setBadge('', rows.filter((b) => b.status === 'offered').length);
    } else if (S.user?.role === 'admin') {
      const s = await api('/admin/stats');
      const n = (k) => s.byStatus[k] || 0;
      setBadge('', n('quote_requested') + n('confirmed') + n('disputed') + s.paymentsToVerify + (s.providers.pending || 0));
    }
  } catch { /* badges are best-effort */ }
}

function stopPoll() {
  clearInterval(S.poll);
  S.poll = null;
}

// Pages marked live re-render every 20s while untouched, so new offers and status changes show up.
function startPoll(view, parts, query, seq) {
  S.poll = setInterval(async () => {
    if (seq !== S.routeSeq || modalOpen() || document.hidden) return;
    const active = document.activeElement;
    if (active && $('#main').contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
    try {
      const html = await view.render(parts, query);
      if (seq === S.routeSeq && html !== S.lastHtml && !modalOpen()) {
        S.lastHtml = html;
        $('#main').innerHTML = html;
      }
      refreshBadges();
    } catch { /* keep showing the last good render */ }
  }, 20000);
}

async function route({ keepScroll = false } = {}) {
  stopPoll();
  if (modalOpen()) closeModal();
  const { parts, query } = parseRoute();
  if (!S.user) return renderPublic(parts, query);
  if (!$('#main') || !document.body.classList.contains('has-nav')) renderShell();
  setActiveNav(parts);

  const view = resolveView(parts);
  const main = $('#main');
  const seq = ++S.routeSeq;
  main.className = view.narrow ? 'narrow' : '';
  if (!keepScroll) {
    main.innerHTML = '<p class="loading">Loading…</p>';
    window.scrollTo(0, 0);
  }
  try {
    const html = await view.render(parts, query);
    if (seq !== S.routeSeq) return;
    S.lastHtml = html;
    main.innerHTML = html;
    if (view.live) startPoll(view, parts, query, seq);
  } catch (err) {
    if (seq === S.routeSeq) main.innerHTML = emptyState('alert', 'Could not load this page', err.message, '<button class="btn" data-act="reload">Try again</button>');
  }
  refreshBadges();
}
const refresh = () => route({ keepScroll: true });

function resolveView([first = '', id], query) {
  const role = S.user.role;
  const V = VIEWS[role];
  if (role === 'homeowner') {
    if (first === 'services' && id) return { render: () => H.category(id) };
    if (first === 'book' && id) return { render: () => W.start(id), narrow: true };
    if (first === 'bookings' && id) return { render: () => bookingDetail(id), live: true, narrow: true };
  }
  if (role === 'provider' && first === 'jobs' && id) return { render: () => P.job(id), live: true, narrow: true };
  if (role === 'admin' && first === 'bookings' && id) return { render: () => bookingDetail(id), live: true };
  return V[first] || V[''];
}

const VIEWS = {
  homeowner: {
    '': { render: () => H.home() },
    bookings: { render: (p, q) => H.bookings(q), live: true },
    account: { render: () => accountPage(), narrow: true },
  },
  provider: {
    '': { render: () => P.jobs(), live: true },
    history: { render: () => P.history() },
    earnings: { render: () => P.earnings() },
    account: { render: () => accountPage(), narrow: true },
  },
  admin: {
    '': { render: () => A.dashboard(), live: true },
    bookings: { render: (p, q) => A.bookings(q), live: true },
    partners: { render: (p, q) => A.partners(q) },
    settlements: { render: () => A.settlements() },
    services: { render: () => A.services() },
    account: { render: () => accountPage(), narrow: true },
  },
};

// ---------------------------------------------------------------------------
// Public site (logged out)
// ---------------------------------------------------------------------------

function renderPublic([page = '', id]) {
  document.body.classList.remove('has-nav');
  if (page === 'book' && id) {
    S.afterLogin = `book/${id}`;
    return go('signup');
  }
  const views = { login: loginPage, signup: signupPage, partner: partnerPage, services: () => publicCategory(id) };
  const body = (views[page] || landingPage)();
  $('#app').innerHTML = `
    <header class="header landing-header">
      <a class="logo" href="#/">${logoMark()}<span>${esc(S.config.company)}</span></a>
      <div class="me">
        ${page !== 'login' ? '<a class="btn sm ghost" href="#/login">Log in</a>' : ''}
        ${page !== 'signup' ? '<a class="btn sm primary" href="#/signup">Sign up</a>' : ''}
      </div>
    </header>
    <main>${body}</main>`;
  window.scrollTo(0, 0);
}

function catGrid(base) {
  return `<div class="cat-grid">${S.catalog.map((c) => `
    <a class="cat-tile" href="#/${base}/${c.id}">${catIcon(c.id)}<span>${esc(c.name)}<br><small>${c.services.length} services</small></span></a>`).join('')}</div>`;
}

function landingPage() {
  return `
    <section class="hero">
      <h1>Home services you can trust, across Zimbabwe</h1>
      <p>Garden, cleaning, fumigation, CCTV and vetted house maids. Book in minutes, and we send a checked, rated professional to your door.</p>
      <div class="btn-row">
        <a class="btn lg light" href="#/signup">Book a service</a>
        <a class="btn lg outline" href="#/login">I have an account</a>
      </div>
      <div class="trust">
        <span>${icon('shield', 18)} ID & police-checked partners</span>
        <span>${icon('tag', 18)} Clear prices upfront</span>
        <span>${icon('cash', 18)} EcoCash, OneMoney, InnBucks or cash</span>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>What do you need?</h2></div>
      ${catGrid('services')}
    </section>

    <section class="section">
      <div class="section-title"><h2>How it works</h2></div>
      <div class="how">
        <div class="card"><div class="num">1</div><h3>Choose a service & time</h3><p class="muted small">See the price before you book. Bigger jobs like tree felling and CCTV get a free site visit and quote.</p></div>
        <div class="card"><div class="num">2</div><h3>We send a vetted partner</h3><p class="muted small">You get their name, rating and phone number, and you can follow the job live.</p></div>
        <div class="card"><div class="num">3</div><h3>Pay & rate</h3><p class="muted small">Pay by mobile money, bank or cash. If something isn't right, tell us and we'll fix it.</p></div>
      </div>
    </section>

    <section class="section">
      <div class="card partner-cta">
        <div>
          <h3>Gardener, cleaner, fumigator, technician or maid?</h3>
          <p class="muted" style="margin:0">Join ${esc(S.config.company)} as a partner and get steady jobs near you.</p>
        </div>
        <a class="btn primary" href="#/partner">Apply as a partner</a>
      </div>
    </section>
    <p class="footer">© ${new Date().getFullYear()} ${esc(S.config.company)} · Need help? ${supportLink('WhatsApp us')}</p>`;
}

function publicCategory(catId) {
  const c = findCategory(catId);
  if (!c) return landingPage();
  return `<a class="back" href="#/">${icon('left', 18)} All services</a>${categoryBody(c, 'book')}`;
}

function categoryBody(c, bookBase) {
  const notes = {
    maids: 'Every maid is interviewed and has a police clearance, medical certificate and references. Placements come with a 3-month free replacement guarantee. You agree the salary directly with the maid.',
    fumigation: 'Our fumigation partners are licensed to handle pesticides. You will get safety instructions (when to leave the house and for how long) before the job.',
    trees: 'Tree work is done by insured, trained teams. A specialist visits first and gives you a free quote.',
    cctv: 'Certified technicians. Installations start with a free site survey and an itemised quote.',
  };
  return `
    <div class="wizard-head">${catIcon(c.id, 56)}<div><h1 style="margin:0">${esc(c.name)}</h1><p class="muted" style="margin:0">Choose a service to see options and book</p></div></div>
    ${notes[c.id] ? `<div class="notice">${icon('shield', 20)}<div>${esc(notes[c.id])}</div></div><div class="spacer"></div>` : ''}
    ${c.services.map((s) => {
      const p = fromPrice(s);
      return `<a class="service-row" href="#/${bookBase}/${s.id}">
        <div class="body"><div class="title">${esc(s.name)}</div><div class="desc">${esc(s.description)}</div></div>
        <div class="price">${p.main}<small>${esc(p.sub)}</small></div>
        <span class="faint">${icon('right', 18)}</span>
      </a>`;
    }).join('')}`;
}

function demoBox() {
  if (!S.config.demo) return '';
  const demo = [['Homeowner', 'home@demo.local', 'demo123'], ['Partner', 'partner@demo.local', 'demo123'], ['Operations', 'admin@homecare.local', 'admin123']];
  return `<div class="notice blue demo-box">${icon('info', 18)}<div><strong>Demo accounts:</strong> ${demo.map(([label, l, p]) =>
    `<button type="button" data-act="demo-login" data-login="${l}" data-password="${p}">${label}</button>`).join(' · ')}</div></div>`;
}

function loginPage() {
  return `
    <div class="auth-wrap">
      <div class="card">
        <h1>Welcome back</h1>
        <p class="muted">Log in with your mobile number or email.</p>
        ${S.afterLogin ? `<div class="notice">${icon('info', 18)}<div>Log in to finish your booking.</div></div>` : ''}
        <form data-form="login">
          <label class="field"><span>Mobile number or email</span><input name="login" required autocomplete="username" placeholder="0772 123 456"></label>
          <label class="field"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
          <div class="form-error"></div>
          <div class="spacer"></div>
          <button class="btn primary lg block" type="submit">Log in</button>
        </form>
        <p class="small muted center" style="margin-top:14px">Forgot your password? ${supportLink('WhatsApp support')} and we'll reset it.</p>
        ${demoBox()}
      </div>
      <p class="auth-switch">New here? <a href="#/signup">Create an account</a> · <a href="#/partner">Apply as a partner</a></p>
    </div>`;
}

function signupPage() {
  return `
    <div class="auth-wrap">
      <div class="card">
        <h1>Create your account</h1>
        <p class="muted">It takes less than a minute. You'll add your address when you book.</p>
        ${S.afterLogin ? `<div class="notice">${icon('info', 18)}<div>Create a free account to finish your booking.</div></div>` : ''}
        <form data-form="signup">
          <label class="field"><span>Full name</span><input name="name" required autocomplete="name"></label>
          <label class="field"><span>Mobile number</span><input name="phone" required type="tel" inputmode="tel" autocomplete="tel" placeholder="0772 123 456">
            <small>Your partner will call this number when they're on the way.</small></label>
          <label class="field"><span>Email <span class="faint">(optional)</span></span><input name="email" type="email" autocomplete="email"></label>
          <label class="field"><span>Choose a password</span><input name="password" type="password" minlength="6" required autocomplete="new-password"><small>At least 6 characters.</small></label>
          <div class="form-error"></div>
          <div class="spacer"></div>
          <button class="btn primary lg block" type="submit">Create account</button>
        </form>
      </div>
      <p class="auth-switch">Already have an account? <a href="#/login">Log in</a></p>
    </div>`;
}

function partnerPage() {
  const services = S.catalog.map((c) => `
    <div class="skill">
      <label class="choice">${catIcon(c.id, 38)}<input type="checkbox" name="skill" value="${c.id}" data-skill>
        <div class="body"><div class="title">${esc(c.name)}</div>${c.certification_required ? `<div class="sub">Needs: ${esc(c.certification_required)}</div>` : ''}</div>
        <span class="tick">${icon('check', 14)}</span></label>
      ${c.certification_required ? `<label class="field hidden" data-cert="${c.id}" style="margin:8px 0 4px 8px"><span class="small">Certificate / licence number for ${esc(c.name)}</span><input name="cert_${c.id}"></label>` : ''}
    </div>`).join('');
  const zones = S.config.zones.map((z) => `<label class="chip"><input type="checkbox" name="zones" value="${esc(z)}">${esc(z)}</label>`).join('');
  return `
    <div class="auth-wrap wide">
      <div class="card">
        <h1>Become a partner</h1>
        <p class="muted">Get jobs from ${esc(S.config.company)} customers near you. You choose your services and areas, and you're paid per job.</p>
        <div class="notice">${icon('info', 20)}<div><strong>What happens next:</strong> after you apply, our team calls you within 2 working days to check your ID, police clearance and any certificates. You start getting jobs as soon as you're approved.</div></div>
        <form data-form="partner">
          <div class="form-section"><h3><span class="num">1</span> About you</h3>
            <div class="grid-2">
              <label class="field"><span>Full name</span><input name="name" required autocomplete="name"></label>
              <label class="field"><span>National ID number</span><input name="national_id" required placeholder="63-123456-A-42"></label>
              <label class="field"><span>Mobile number</span><input name="phone" type="tel" inputmode="tel" required placeholder="0772 123 456"></label>
              <label class="field"><span>Email <span class="faint">(optional)</span></span><input name="email" type="email"></label>
            </div>
          </div>
          <div class="form-section"><h3><span class="num">2</span> How you work</h3>
            <div class="choices cols">
              <label class="choice"><input type="radio" name="provider_type" value="individual" checked data-team-toggle><span class="tick"></span><div class="body"><div class="title">On my own</div></div></label>
              <label class="choice"><input type="radio" name="provider_type" value="team" data-team-toggle><span class="tick"></span><div class="body"><div class="title">With a team</div></div></label>
            </div>
            <div class="grid-2">
              <label class="field hidden" data-team><span>Team size</span><input name="team_size" type="number" min="2" max="100" value="2"></label>
              <label class="field"><span>Business name <span class="faint">(optional)</span></span><input name="business_name"></label>
              <label class="field"><span>EcoCash number for payments</span><input name="payout_number" type="tel" inputmode="tel" placeholder="Leave blank to use your mobile number"></label>
            </div>
          </div>
          <div class="form-section"><h3><span class="num">3</span> Services you offer</h3>
            <div class="choices">${services}</div>
          </div>
          <div class="form-section"><h3><span class="num">4</span> Areas you can work in</h3>
            <div class="chips">${zones}</div>
          </div>
          <div class="form-section"><h3><span class="num">5</span> Your experience</h3>
            <label class="field"><span>Tell us about your experience <span class="faint">(optional)</span></span>
              <textarea name="bio" placeholder="Years of experience, equipment you own, places you've worked, references…"></textarea></label>
            <label class="field"><span>Choose a password</span><input name="password" type="password" minlength="6" required autocomplete="new-password"><small>At least 6 characters.</small></label>
          </div>
          <div class="form-error"></div>
          <div class="spacer"></div>
          <button class="btn primary lg block" type="submit">Submit application</button>
        </form>
      </div>
      <p class="auth-switch">Already a partner? <a href="#/login">Log in</a></p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Homeowner
// ---------------------------------------------------------------------------

const H = {
  async home() {
    const bookings = await api('/bookings');
    const active = bookings.filter((b) => ACTIVE.includes(b.status)).slice(0, 3);
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `
      <h1>${greet}, ${esc(firstName(S.user.name))}</h1>
      <p class="muted">What can we help you with today?</p>
      <label class="field" style="position:relative;margin-top:6px">
        <span class="hidden">Search services</span>
        <input type="search" data-search placeholder="Search e.g. grass cutting, bedbugs, sofa, maid…" style="padding-left:42px">
        <span class="faint" style="position:absolute;left:13px;top:13px">${icon('search', 20)}</span>
      </label>
      <div id="search-results"></div>
      ${active.length ? `
        <section class="section">
          <div class="section-title"><h2>Your active bookings</h2><a href="#/bookings" class="small">See all</a></div>
          <div class="list">${active.map((b) => bookingRow(b, `bookings/${b.id}`)).join('')}</div>
        </section>` : ''}
      <section class="section" id="categories">
        <div class="section-title"><h2>Services</h2></div>
        ${catGrid('services')}
      </section>
      <p class="footer">Need help? ${supportLink('WhatsApp us')} or call ${esc(fmtPhone(S.config.supportPhone))}</p>`;
  },

  category(id) {
    const c = findCategory(id);
    if (!c) return Promise.resolve(emptyState('alert', 'Not found', 'That service category does not exist.'));
    return Promise.resolve(`<a class="back" href="#/">${icon('left', 18)} Home</a>${categoryBody(c, 'book')}`);
  },

  async bookings(query) {
    const rows = await api('/bookings');
    const tab = query.get('tab') === 'past' ? 'past' : 'active';
    const active = rows.filter((b) => ACTIVE.includes(b.status));
    const past = rows.filter((b) => !ACTIVE.includes(b.status));
    const shown = tab === 'past' ? past : active;
    return `
      <div class="page-head"><h1>My bookings</h1><a class="btn primary" href="#/">${icon('plus', 18)} New booking</a></div>
      <div class="chips" style="margin-bottom:16px">
        <a class="chip ${tab === 'active' ? 'active' : ''}" href="#/bookings">Active <span class="count">${active.length}</span></a>
        <a class="chip ${tab === 'past' ? 'active' : ''}" href="#/bookings?tab=past">Past <span class="count">${past.length}</span></a>
      </div>
      ${shown.length
        ? `<div class="list">${shown.map((b) => bookingRow(b, `bookings/${b.id}`)).join('')}</div>`
        : tab === 'active'
          ? emptyState('calendar', 'No active bookings', 'When you book a service it will show up here so you can follow it.', '<a class="btn primary" href="#/">Book a service</a>')
          : emptyState('list', 'Nothing here yet', 'Your completed and cancelled bookings will appear here.')}`;
  },
};

function searchServices(q) {
  const box = $('#search-results');
  const cats = $('#categories');
  if (!box) return;
  const term = q.trim().toLowerCase();
  cats?.classList.toggle('hidden', !!term);
  if (!term) { box.innerHTML = ''; return; }
  const hits = allServices().filter((s) => `${s.name} ${s.description} ${s.category.name}`.toLowerCase().includes(term));
  box.innerHTML = `<div class="section">${hits.length
    ? hits.map((s) => {
      const p = fromPrice(s);
      return `<a class="service-row" href="#/book/${s.id}">${catIcon(s.category.id, 40)}
        <div class="body"><div class="title">${esc(s.name)}</div><div class="desc">${esc(s.category.name)}</div></div>
        <div class="price">${p.main}<small>${esc(p.sub)}</small></div></a>`;
    }).join('')
    : emptyState('search', 'No matching services', `Try another word, or WhatsApp us and we'll help you find the right service.`)}</div>`;
}

// ---------------------------------------------------------------------------
// Booking wizard (homeowner)
// ---------------------------------------------------------------------------

const SLOTS = ['07:00', '09:00', '11:00', '13:00', '15:00'];
const LEAD_MS = 2 * 3600 * 1000; // earliest booking is 2 hours from now

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const slotDate = (day, time) => new Date(`${day}T${time}:00`);
const slotOpen = (day, time) => slotDate(day, time).getTime() >= Date.now() + LEAD_MS;

const W = {
  async start(serviceId) {
    const s = findService(serviceId);
    if (!s) return emptyState('alert', 'Service not found', 'It may no longer be offered.', '<a class="btn" href="#/">Back to services</a>');
    S.properties = await api('/properties');
    if (!S.wiz || S.wiz.serviceId !== s.id) {
      const days = W.days();
      const firstDay = days.find((d) => SLOTS.some((t) => slotOpen(d, t)));
      S.wiz = {
        serviceId: s.id,
        step: 0,
        option: 0,
        qty: 1,
        day: firstDay,
        time: SLOTS.find((t) => slotOpen(firstDay, t)),
        propertyId: S.properties[0]?.id ?? null,
        details: '',
        payment: 'ecocash',
      };
    }
    return W.html();
  },

  days() {
    return Array.from({ length: 14 }, (_, i) => isoDay(new Date(Date.now() + i * 864e5)));
  },

  steps(s) {
    return [
      ...(s.pricing_type === 'quote' ? [] : ['option']),
      'when', 'where', 'details', 'review',
    ];
  },

  total(s) {
    if (s.pricing_type === 'quote') return null;
    return s.options[S.wiz.option].price * (s.pricing_type === 'unit' ? S.wiz.qty : 1);
  },

  html() {
    const w = S.wiz;
    const s = findService(w.serviceId);
    const steps = W.steps(s);
    const step = steps[w.step];
    const titles = {
      option: 'What do you need?',
      when: s.pricing_type === 'quote' ? 'When can we visit to quote?' : s.pricing_type === 'placement' ? 'When should the maid start?' : 'When should we come?',
      where: 'Where is the job?',
      details: 'A few more details',
      review: 'Check and confirm',
    };
    const total = W.total(s);
    const isLast = w.step === steps.length - 1;
    return `
      <a class="back" href="#/services/${s.category.id}">${icon('left', 18)} ${esc(s.category.name)}</a>
      <div class="wizard-head">${catIcon(s.category.id, 48)}<div><div class="step-label">Step ${w.step + 1} of ${steps.length}</div><h1 style="margin:0">${esc(s.name)}</h1></div></div>
      <div class="progress"><div style="width:${((w.step + 1) / steps.length) * 100}%"></div></div>
      <h2>${titles[step]}</h2>
      <div id="wiz-body">${W[step](s)}</div>
      <div class="form-error" id="wiz-error"></div>
      <div class="wizard-foot">
        <button class="btn" data-act="wiz-back">${w.step === 0 ? 'Cancel' : 'Back'}</button>
        <div class="total">${total == null ? '<small>Price</small><b>Free quote</b>' : `<small>Total</small><b>${money(total)}</b>`}</div>
        <button class="btn primary lg" data-act="${isLast ? 'wiz-submit' : 'wiz-next'}">${isLast ? (s.pricing_type === 'quote' ? 'Request visit' : 'Confirm booking') : 'Continue'}</button>
      </div>`;
  },

  rerender() {
    $('#main').innerHTML = W.html();
  },

  option(s) {
    const w = S.wiz;
    const opts = s.options.map((o, i) => `
      <label class="choice"><input type="radio" name="wiz-option" value="${i}" ${w.option === i ? 'checked' : ''}><span class="tick"></span>
        <div class="body"><div class="title">${esc(o.label)}</div>${s.unit_label ? `<div class="sub">per ${esc(s.unit_label)}</div>` : ''}</div>
        <span class="end">${money(o.price)}</span></label>`).join('');
    const qty = s.pricing_type === 'unit' ? `
      <label class="field"><span>How many ${esc(s.unit_label)}s?</span></label>
      <div class="stepper-input">
        <button type="button" data-act="qty" data-d="-1" aria-label="Fewer">−</button>
        <input type="number" name="wiz-qty" min="1" max="100" value="${w.qty}" inputmode="numeric" aria-label="Quantity">
        <button type="button" data-act="qty" data-d="1" aria-label="More">+</button>
      </div>` : '';
    const placement = s.pricing_type === 'placement'
      ? `<div class="notice" style="margin-top:14px">${icon('info', 18)}<div>This is a one-off placement fee. You'll interview shortlisted maids, there's a trial period, and you agree the monthly salary directly with the maid.</div></div>` : '';
    return `<div class="choices">${opts}</div>${qty}${placement}`;
  },

  when(s) {
    const w = S.wiz;
    const dates = W.days().map((day) => {
      const d = new Date(`${day}T12:00:00`);
      const open = SLOTS.some((t) => slotOpen(day, t));
      const top = sameDay(d, new Date()) ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short' });
      return `<label class="chip date-chip" ${open ? '' : 'style="opacity:.4;pointer-events:none"'}>
        <input type="radio" name="wiz-day" value="${day}" ${w.day === day ? 'checked' : ''} ${open ? '' : 'disabled'}>
        <small>${top}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString('en-GB', { month: 'short' })}</small></label>`;
    }).join('');
    if (s.pricing_type === 'placement') {
      return `<div class="chips scroll">${dates}</div><p class="muted small" style="margin-top:12px">We'll call you before then to arrange interviews.</p>`;
    }
    const times = SLOTS.map((t) => {
      const open = slotOpen(w.day, t);
      return `<label class="chip" ${open ? '' : 'style="opacity:.4;pointer-events:none"'}>
        <input type="radio" name="wiz-time" value="${t}" ${w.time === t ? 'checked' : ''} ${open ? '' : 'disabled'}>${timeLabel(slotDate(w.day, t))}</label>`;
    }).join('');
    return `
      <div class="chips scroll">${dates}</div>
      <h3 style="margin-top:22px">Arrival time</h3>
      <div class="chips">${times}</div>
      <p class="muted small" style="margin-top:12px">The partner will arrive within 30 minutes of the time you choose and will call you if they're running late.</p>`;
  },

  where() {
    const w = S.wiz;
    const props = S.properties.map((p) => `
      <label class="choice"><input type="radio" name="wiz-property" value="${p.id}" ${w.propertyId === p.id ? 'checked' : ''}><span class="tick"></span>
        <div class="body"><div class="title">${esc(p.label)}</div><div class="sub">${esc(p.address)}, ${esc(p.suburb)} · ${esc(p.zone)}</div></div></label>`).join('');
    return `
      ${S.properties.length ? `<div class="choices">${props}</div>` : `<p class="muted">Add the address where the work will be done.</p>`}
      <button class="btn ${S.properties.length ? '' : 'primary'}" style="margin-top:12px" data-act="modal-property">${icon('plus', 18)} Add ${S.properties.length ? 'another' : 'an'} address</button>`;
  },

  details(s) {
    const w = S.wiz;
    const required = s.pricing_type === 'placement';
    const payHint = {
      ecocash: 'Pay to our merchant code, then enter the reference',
      onemoney: 'Pay to our merchant code, then enter the reference',
      innbucks: 'Pay with InnBucks, then enter the reference',
      bank: 'Transfer to our account, then enter the reference',
      cash: 'Pay the partner when the job is done',
    };
    return `
      <label class="field"><span>${required ? 'Tell us what you need' : 'Anything the partner should know?'} ${required ? '' : '<span class="faint">(optional)</span>'}</span>
        <textarea name="wiz-details" placeholder="${esc(s.category.details_hint || '')}" ${required ? 'required' : ''}>${esc(w.details)}</textarea></label>
      <h3 style="margin-top:22px">How will you pay?</h3>
      <div class="choices cols">${Object.entries(S.config.paymentMethods).map(([k, v]) => `
        <label class="choice"><input type="radio" name="wiz-pay" value="${k}" ${w.payment === k ? 'checked' : ''}><span class="tick"></span>
          <div class="body"><div class="title">${esc(v)}</div><div class="sub">${payHint[k] || ''}</div></div></label>`).join('')}
      </div>
      ${s.pricing_type === 'quote' ? '<p class="muted small" style="margin-top:12px">You only pay once you have accepted the quote.</p>' : ''}`;
  },

  review(s) {
    const w = S.wiz;
    const p = S.properties.find((x) => x.id === w.propertyId);
    const when = s.pricing_type === 'placement' ? dayLabel(slotDate(w.day, '09:00')) : `${dayLabel(slotDate(w.day, w.time))}, ${timeLabel(slotDate(w.day, w.time))}`;
    const rows = [
      ['Service', esc(s.name)],
      ...(s.pricing_type === 'quote' ? [] : [['Option', `${esc(s.options[w.option].label)}${s.pricing_type === 'unit' ? ` × ${w.qty}` : ''}`]]),
      [s.pricing_type === 'quote' ? 'Site visit' : s.pricing_type === 'placement' ? 'Start date' : 'When', when],
      ['Where', `${esc(p.label)}: ${esc(p.address)}, ${esc(p.suburb)}`],
      ['Payment', esc(payName(w.payment))],
      ...(w.details ? [['Notes', esc(w.details)]] : []),
    ];
    const next = {
      quote: 'A specialist will call you to confirm the visit. After the visit your quote appears here, and the job only goes ahead if you accept it.',
      placement: 'We will call you within 1 working day to discuss your needs and arrange interviews with shortlisted maids.',
    }[s.pricing_type] || 'We will match you with a vetted partner nearby. You will see their name, rating and phone number as soon as they accept.';
    return `
      <div class="card flat"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
      <div class="notice">${icon('info', 18)}<div><strong>What happens next:</strong> ${next}</div></div>
      <p class="muted small" style="margin-top:12px">Free cancellation until the partner is on the way.</p>`;
  },

  validate(s) {
    const w = S.wiz;
    const step = W.steps(s)[w.step];
    if (step === 'option' && s.pricing_type === 'unit' && !(w.qty >= 1 && w.qty <= 100)) return 'Enter a number between 1 and 100';
    if (step === 'when') {
      if (!w.day) return 'Choose a date';
      if (s.pricing_type !== 'placement' && (!w.time || !slotOpen(w.day, w.time))) return 'Choose an available time';
    }
    if (step === 'where' && !S.properties.some((p) => p.id === w.propertyId)) return 'Choose an address, or add one';
    if (step === 'details' && s.pricing_type === 'placement' && !w.details.trim()) return 'Please tell us what you need from the maid';
    return '';
  },

  async submit() {
    const w = S.wiz;
    const s = findService(w.serviceId);
    const time = s.pricing_type === 'placement' ? '09:00' : w.time;
    const b = await api('/bookings', {
      method: 'POST',
      body: {
        service_id: s.id,
        property_id: w.propertyId,
        option_index: w.option,
        quantity: w.qty,
        scheduled_for: slotDate(w.day, time).toISOString(),
        details: w.details,
        payment_method: w.payment,
      },
    });
    S.wiz = null;
    toast(b.status === 'quote_requested' ? 'Site visit requested' : 'Booking confirmed');
    go(`bookings/${b.id}`);
  },
};

// ---------------------------------------------------------------------------
// Booking detail (homeowner + operations)
// ---------------------------------------------------------------------------

async function bookingDetail(id) {
  const b = await api(`/bookings/${id}`);
  const admin = S.user.role === 'admin';
  const eligible = admin && ['confirmed', 'offered'].includes(b.status) ? await api(`/admin/bookings/${b.id}/eligible`) : [];
  const where = `${esc(b.address || '')}${b.address ? ', ' : ''}${esc(b.suburb)} · ${esc(b.zone)}`;

  const header = `
    <div class="card">
      <div class="hero-status">${catIcon(b.category_id, 52)}
        <div style="flex:1;min-width:0"><h2>${esc(b.service_name)}</h2><div class="muted small">Booking #HC${b.id} · ${fmtWhen(b.scheduled_for)}</div>${pill(b.status)}</div>
      </div>
      ${trackerHtml(b)}
    </div>`;

  const partnerCard = b.provider_name && CONTACT_SHARED.includes(b.status) || (admin && b.provider_name) ? `
    <div class="card">
      <h3>${admin ? 'Partner' : 'Your partner'}</h3>
      <div class="person"><span class="avatar lg">${initials(b.provider_name)}</span>
        <div class="body"><div class="strong">${esc(b.provider_name)}</div>
          <div class="small muted">${b.provider_business ? esc(b.provider_business) + ' · ' : ''}${starsText(b.provider_rating, b.provider_rating_count)}</div></div></div>
      ${b.provider_phone ? `<div class="spacer"></div>${contactButtons(b.provider_phone, `Hi ${firstName(b.provider_name)}, about booking #HC${b.id}`)}` : ''}
    </div>` : '';

  const customerCard = admin ? `
    <div class="card">
      <h3>Customer</h3>
      <div class="person"><span class="avatar lg">${initials(b.homeowner_name)}</span>
        <div class="body"><div class="strong">${esc(b.homeowner_name)}</div><div class="small muted">${esc(fmtPhone(b.homeowner_phone))}</div></div></div>
      <div class="spacer"></div>${contactButtons(b.homeowner_phone, `Hi ${firstName(b.homeowner_name)}, this is ${S.config.company} about booking #HC${b.id}`)}
    </div>` : '';

  const detailRows = [
    ['Service', esc(optionText(b))],
    ['When', fmtWhen(b.scheduled_for)],
    ['Where', `${esc(b.property_label)}<div class="small muted">${where}</div>`],
    ['Price', b.price == null ? 'Quote pending' : money(b.price)],
    ['Payment', `${esc(payName(b.payment_method))} · ${PAYMENT[b.payment_status]}${b.payment_ref ? ` <span class="faint small">(ref ${esc(b.payment_ref)})</span>` : ''}`],
    ...(admin && b.price != null ? [['Commission', `${Math.round(b.commission_rate * 100)}% · partner earns ${money(b.provider_share)}`]] : []),
    ...(b.details ? [[admin ? 'Customer notes' : 'Your notes', esc(b.details)]] : []),
    ...(b.quote_note ? [['Quote covers', esc(b.quote_note)]] : []),
    ...(b.completion_note ? [['Partner report', esc(b.completion_note)]] : []),
    ...(b.rating ? [['Rating', `${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}${b.review ? ` · ${esc(b.review)}` : ''}`]] : []),
  ];

  const timeline = `
    <details class="card" ${admin ? 'open' : ''}>
      <summary class="strong" style="cursor:pointer">Booking history</summary>
      <ul class="timeline" style="margin-top:14px">${b.events.map((e) => `
        <li><div class="strong small">${esc(eventLabel(e))}</div>
          <div class="when">${fmtStamp(e.created_at)} · ${esc(e.actor_name || 'System')}</div>
          ${e.note ? `<div class="small">${esc(e.note)}</div>` : ''}</li>`).join('')}</ul>
    </details>`;

  const cancel = CANCELLABLE.includes(b.status)
    ? `<div class="center" style="margin-top:20px"><button class="btn ghost danger" data-act="act" data-id="${b.id}" data-action="cancel"
        data-confirm="Cancel this booking?" data-confirm-body="${admin ? 'The customer and partner will see it as cancelled.' : 'Cancelling is free at this stage.'}" data-danger="1" data-success="Booking cancelled">Cancel booking</button></div>` : '';

  const back = admin ? `<a class="back" href="#/bookings">${icon('left', 18)} All bookings</a>` : `<a class="back" href="#/bookings">${icon('left', 18)} My bookings</a>`;
  const actionCards = admin ? adminActionCards(b, eligible) : homeownerActionCards(b);

  if (admin) {
    return `${back}${header}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:14px;align-items:start">
        <div>${actionCards}<div class="card"><h3>Job details</h3><dl class="kv">${detailRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div></div>
        <div>${customerCard}${partnerCard}${timeline}</div>
      </div>${cancel}`;
  }
  return `${back}${header}${actionCards}${partnerCard}
    <div class="card"><h3>Booking details</h3><dl class="kv">${detailRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    ${timeline}${cancel}
    <p class="footer">Questions about this booking? ${supportLink('WhatsApp us')}</p>`;
}

function homeownerActionCards(b) {
  const partner = esc(firstName(b.provider_name) || 'Your partner');
  const cards = [];
  const status = {
    quote_requested: ['clock', 'amber', `We'll call you on ${esc(fmtPhone(S.user.phone))} to confirm the site visit on ${fmtWhen(b.scheduled_for)}. Your quote will appear here afterwards.`],
    confirmed: ['clock', 'amber', "We're finding the best available partner near you. You'll see their name and phone number here as soon as they accept."],
    offered: ['clock', 'amber', "A partner near you is reviewing your job. You'll see their details as soon as they accept."],
    accepted: ['check', '', `${partner} has accepted your job and will arrive ${fmtWhen(b.scheduled_for)}.`],
    en_route: ['nav', 'blue', `${partner} is on the way to you now.`],
    in_progress: ['briefcase', 'blue', `${partner} is working on your job.`],
    disputed: ['alert', 'red', "We've received your report and our team is looking into it. We'll contact you shortly."],
    cancelled: ['x', 'amber', 'This booking was cancelled.'],
    refunded: ['cash', 'amber', 'This booking was refunded.'],
  }[b.status];
  if (status) cards.push(`<div class="notice ${status[1]}">${icon(status[0], 20)}<div>${status[2]}</div></div>`);

  if (b.status === 'quoted') {
    cards.push(`
      <div class="card">
        <h3>Your quote is ready</h3>
        <div class="big-money">${money(b.price)}</div>
        ${b.quote_note ? `<p class="muted">${esc(b.quote_note)}</p>` : ''}
        <div class="btn-row" style="margin-top:12px">
          <button class="btn primary lg grow" data-act="act" data-id="${b.id}" data-action="accept_quote" data-success="Quote accepted">Accept quote</button>
          <button class="btn lg" data-act="act" data-id="${b.id}" data-action="decline_quote" data-confirm="Decline this quote?" data-confirm-body="The booking will be cancelled." data-danger="1" data-success="Quote declined">Decline</button>
        </div>
      </div>`);
  }

  if (b.status === 'completed') {
    cards.push(`
      <div class="card">
        <h3>How did ${partner} do?</h3>
        <p class="muted small">Confirm the job is done and rate the work. This helps us keep quality high.</p>
        <form data-form="rate" data-id="${b.id}">
          <input type="hidden" name="rating" value="5">
          <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="on" data-act="star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
          <label class="field"><span>Comments <span class="faint">(optional)</span></span><textarea name="review" placeholder="What went well? What could be better?"></textarea></label>
          <div class="form-error"></div>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn primary lg grow" type="submit">Confirm job done</button>
            <button class="btn lg" type="button" data-act="modal-dispute" data-id="${b.id}">Report a problem</button>
          </div>
        </form>
      </div>`);
  }

  if (b.status === 'closed' || b.status === 'cancelled' || b.status === 'refunded') {
    cards.push(`<div class="card"><div class="btn-row" style="align-items:center">
      <div class="grow">${b.status === 'closed' ? `<strong>Thanks for using ${esc(S.config.company)}!</strong><div class="muted small">Need it again?</div>` : '<strong>Still need this done?</strong>'}</div>
      <a class="btn primary" href="#/book/${b.service_id}">Book again</a></div></div>`);
  }

  // Payment
  if (b.price != null && OPEN_PAYMENT.includes(b.status)) {
    if (b.payment_method === 'cash' && b.payment_status === 'unpaid') {
      cards.push(`<div class="notice amber">${icon('cash', 20)}<div>Please have <strong>${money(b.price)}</strong> cash ready to pay ${partner} when the job is done.</div></div>`);
    } else if (b.payment_status === 'unpaid') {
      cards.push(`
        <div class="card">
          <h3>Pay ${money(b.price)} with ${esc(payName(b.payment_method))}</h3>
          <ol class="small" style="padding-left:20px;margin:8px 0 0">
            <li>${esc(S.config.paymentInstructions)}</li>
            <li>Use reference <strong>HC${b.id}</strong>.</li>
            <li>Enter the transaction reference from your confirmation SMS below.</li>
          </ol>
          <form data-form="pay" data-id="${b.id}">
            <label class="field"><span>Transaction reference</span><input name="reference" required placeholder="e.g. MP241026.1234.A12345" autocomplete="off"></label>
            <div class="form-error"></div>
            <button class="btn primary block" style="margin-top:12px" type="submit">I've paid</button>
          </form>
        </div>`);
    } else if (b.payment_status === 'pending_verification') {
      cards.push(`<div class="notice blue">${icon('clock', 20)}<div>We're confirming your payment (ref ${esc(b.payment_ref)}). This usually takes a few minutes during working hours.</div></div>`);
    } else if (b.payment_status === 'paid' || b.payment_status === 'cash_collected') {
      cards.push(`<div class="notice">${icon('check', 20)}<div>Payment of <strong>${money(b.price)}</strong> received. Thank you!</div></div>`);
    }
  }
  return cards.join('') ? `<div style="margin:14px 0">${cards.join('')}</div>` : '';
}

function adminActionCards(b, eligible) {
  const cards = [];
  if (['quote_requested', 'quoted'].includes(b.status)) {
    cards.push(`
      <div class="card">
        <h3>${b.status === 'quoted' ? 'Revise quote' : 'Prepare quote'}</h3>
        <p class="muted small">Call the customer, arrange the site visit, then enter the quote. The customer accepts it in the app.</p>
        <form data-form="quote" data-id="${b.id}">
          <label class="field"><span>Price (USD, labour + materials)</span><input name="price" type="number" min="1" step="0.5" required value="${b.price ?? ''}"></label>
          <label class="field"><span>What the quote covers</span><textarea name="note" placeholder="e.g. 4 × 2MP outdoor cameras, 4-channel DVR, 1TB drive, cabling, installation and phone setup">${esc(b.quote_note || '')}</textarea></label>
          <div class="form-error"></div>
          <button class="btn primary block" style="margin-top:12px" type="submit">${b.status === 'quoted' ? 'Update quote' : 'Send quote to customer'}</button>
        </form>
      </div>`);
  }
  if (['confirmed', 'offered'].includes(b.status)) {
    const waiting = b.status === 'offered' ? `<div class="notice blue">${icon('clock', 18)}<div>Waiting for <strong>${esc(b.provider_name)}</strong> to accept. You can offer it to someone else instead.</div></div><div class="spacer"></div>` : '';
    cards.push(`
      <div class="card">
        <div class="section-title"><h3 style="margin:0">${b.status === 'offered' ? 'Reassign job' : 'Assign a partner'}</h3>
          ${b.status === 'confirmed' && eligible.length ? `<button class="btn sm primary" data-act="act" data-id="${b.id}" data-action="auto_assign" data-success="Offered to the best match">Auto-assign</button>` : ''}</div>
        ${waiting}
        ${eligible.length ? `<div class="list">${eligible.map((p) => `
          <div class="list-row">
            <span class="avatar">${initials(p.name)}</span>
            <div class="body"><div class="title">${esc(p.name)}</div>
              <div class="sub">${starsText(p.rating_avg, p.rating_count)} · ${p.completed_jobs} jobs · ${p.jobs_that_day} that day</div></div>
            ${p.user_id === b.provider_id ? '<span class="pill blue">Offered</span>'
              : `<button class="btn sm" data-act="offer" data-id="${b.id}" data-provider="${p.user_id}">Offer</button>`}
          </div>`).join('')}</div>`
          : `<div class="notice amber">${icon('alert', 18)}<div>No available partner offers <strong>${esc(b.category_name)}</strong> in <strong>${esc(b.zone)}</strong>. Approve or recruit one, or ask a partner to switch their availability on.</div></div>`}
      </div>`);
  }
  if (b.payment_status === 'pending_verification') {
    cards.push(`
      <div class="card">
        <h3>Check payment</h3>
        <p>The customer says they paid <strong>${money(b.price)}</strong> via ${esc(payName(b.payment_method))}, ref <strong>${esc(b.payment_ref)}</strong>. Check your statement before verifying.</p>
        <button class="btn primary block" data-act="act" data-id="${b.id}" data-action="verify_payment" data-confirm="Mark as paid?" data-confirm-body="Only do this once the money is in the company account." data-success="Payment verified">Payment received</button>
      </div>`);
  }
  if (b.payment_method === 'cash' && b.payment_status === 'unpaid' && ['completed', 'closed', 'disputed'].includes(b.status)) {
    cards.push(`
      <div class="card"><h3>Cash payment</h3>
        <p class="small muted">The partner didn't record collecting the cash. Check with them.</p>
        <button class="btn block" data-act="act" data-id="${b.id}" data-action="verify_payment" data-confirm="Confirm cash was collected?" data-success="Cash recorded">Partner collected ${money(b.price)} cash</button></div>`);
  }
  if (['completed', 'disputed'].includes(b.status)) {
    cards.push(`
      <div class="card">
        <h3>${b.status === 'disputed' ? 'Resolve problem' : 'Close job'}</h3>
        <p class="small muted">${b.status === 'disputed' ? 'Call the customer and the partner. Then close the job (after a re-do, if needed) or record a refund.'
          : 'The customer has not confirmed yet. You can close the job if they confirmed by phone.'}</p>
        <div class="btn-row">
          <button class="btn primary grow" data-act="modal-note" data-id="${b.id}" data-action="close" data-title="Close job">Close job</button>
          ${b.status === 'disputed' ? `<button class="btn danger" data-act="modal-note" data-id="${b.id}" data-action="refund" data-title="Record refund" data-required="1">Refund</button>` : ''}
        </div>
      </div>`);
  }
  return cards.join('');
}

// ---------------------------------------------------------------------------
// Partner
// ---------------------------------------------------------------------------

function partnerStatusNotice() {
  const p = S.provider;
  if (p?.status === 'pending') return `<div class="notice amber">${icon('clock', 20)}<div><strong>Application under review.</strong> We'll call you within 2 working days to verify your documents. You'll start receiving jobs once you're approved.</div></div>`;
  if (p?.status === 'suspended') return `<div class="notice red">${icon('alert', 20)}<div><strong>Your account is paused.</strong> Please ${supportLink('contact the operations team')}.</div></div>`;
  return '';
}

const P = {
  async jobs() {
    const [rows, me] = await Promise.all([api('/bookings'), api('/me')]);
    S.provider = me.provider;
    const offers = rows.filter((b) => b.status === 'offered');
    const active = rows.filter((b) => PARTNER_ACTIVE.includes(b.status)).sort((a, z) => a.scheduled_for.localeCompare(z.scheduled_for));
    const today = active.filter((b) => sameDay(new Date(b.scheduled_for), new Date()) || new Date(b.scheduled_for) < new Date());
    const later = active.filter((b) => !today.includes(b));
    const p = S.provider;

    const offerCards = offers.map((b) => `
      <div class="card">
        <div class="hero-status">${catIcon(b.category_id, 44)}
          <div style="flex:1;min-width:0"><strong>${esc(b.service_name)}</strong><div class="small muted">${esc(optionText(b))}</div></div>
          <div class="center"><div class="big-money" style="font-size:1.4rem">${money(b.provider_share)}</div><div class="tiny muted">you earn</div></div>
        </div>
        <div class="small" style="margin:12px 0;display:grid;gap:4px">
          <div>${icon('clock', 15)} ${fmtWhen(b.scheduled_for)}</div>
          <div>${icon('pin', 15)} ${esc(b.suburb)}, ${esc(b.zone)}</div>
          ${b.payment_method === 'cash' ? `<div>${icon('cash', 15)} Collect ${money(b.price)} cash from the customer</div>` : ''}
        </div>
        <div class="btn-row">
          <button class="btn primary lg grow" data-act="act" data-id="${b.id}" data-action="accept" data-success="Job accepted. The customer has been notified">Accept job</button>
          <button class="btn lg" data-act="act" data-id="${b.id}" data-action="decline" data-confirm="Decline this job?" data-confirm-body="We'll offer it to another partner." data-success="Job declined">Decline</button>
        </div>
        <div class="center" style="margin-top:6px"><a class="small" href="#/jobs/${b.id}">View details</a></div>
      </div>`).join('');

    return `
      <div class="page-head"><h1>Hi, ${esc(firstName(S.user.name))}</h1></div>
      ${partnerStatusNotice()}
      ${p.status === 'active' ? `
        <div class="card tight" style="display:flex;align-items:center;gap:12px;justify-content:space-between">
          <div><strong>${p.available ? 'You are available' : 'You are offline'}</strong>
            <div class="small muted">${p.available ? 'You will receive new job offers.' : 'Switch on to receive new job offers.'}</div></div>
          <label class="switch"><input type="checkbox" data-availability ${p.available ? 'checked' : ''}><span class="track"></span></label>
        </div>` : ''}
      <section class="section">
        <div class="section-title"><h2>New job offers</h2>${offers.length ? `<span class="badge">${offers.length}</span>` : ''}</div>
        ${offers.length ? offerCards : `<div class="card flat center muted small">No new offers right now. We'll show them here as soon as they come in.</div>`}
      </section>
      <section class="section">
        <div class="section-title"><h2>Today</h2></div>
        ${today.length ? `<div class="list">${today.map((b) => bookingRow(b, `jobs/${b.id}`)).join('')}</div>` : '<div class="card flat center muted small">No jobs scheduled for today.</div>'}
      </section>
      ${later.length ? `<section class="section"><div class="section-title"><h2>Upcoming</h2></div>
        <div class="list">${later.map((b) => bookingRow(b, `jobs/${b.id}`)).join('')}</div></section>` : ''}`;
  },

  async job(id) {
    const b = await api(`/bookings/${id}`);
    const shared = CONTACT_SHARED.includes(b.status);
    let action = '';
    if (b.status === 'offered') {
      action = `<div class="btn-row">
        <button class="btn primary lg grow" data-act="act" data-id="${b.id}" data-action="accept" data-success="Job accepted">Accept job</button>
        <button class="btn lg" data-act="act" data-id="${b.id}" data-action="decline" data-confirm="Decline this job?" data-success="Job declined">Decline</button></div>`;
    } else if (b.status === 'accepted') {
      action = `<button class="btn primary lg block" data-act="act" data-id="${b.id}" data-action="en_route" data-success="Customer told you're on the way">${icon('nav', 18)} I'm on my way</button>
        <button class="btn block" style="margin-top:10px" data-act="act" data-id="${b.id}" data-action="start" data-success="Job started">I'm already there, start job</button>`;
    } else if (b.status === 'en_route') {
      action = `<button class="btn primary lg block" data-act="act" data-id="${b.id}" data-action="start" data-success="Job started">I've arrived, start job</button>`;
    } else if (b.status === 'in_progress') {
      action = `<button class="btn primary lg block" data-act="modal-complete" data-id="${b.id}">${icon('check', 18)} Job finished</button>`;
    } else if (b.status === 'completed') {
      action = `<div class="notice">${icon('clock', 18)}<div>Waiting for the customer to confirm. You'll be paid once it's confirmed.</div></div>`;
    } else if (b.status === 'closed') {
      action = `<div class="notice">${icon('check', 18)}<div>Job complete${b.rating ? `. The customer rated you ${'★'.repeat(b.rating)}${b.review ? `: "${esc(b.review)}"` : ''}` : ''}.</div></div>`;
    } else if (b.status === 'disputed') {
      action = `<div class="notice red">${icon('alert', 18)}<div>The customer reported a problem. Our operations team will call you.</div></div>`;
    }

    const rows = [
      ['Job', esc(optionText(b))],
      ['When', fmtWhen(b.scheduled_for)],
      ['Where', shared ? `${esc(b.address)}, ${esc(b.suburb)}<div class="small muted">${esc(b.zone)} · ${esc(b.property_type)}</div>` : `${esc(b.suburb)}, ${esc(b.zone)} <div class="small muted">Full address shown after you accept</div>`],
      ['Customer pays', `${money(b.price)} · ${esc(payName(b.payment_method))}`],
      ['You earn', `<strong>${money(b.provider_share)}</strong>`],
      ...(b.details ? [['Customer notes', esc(b.details)]] : []),
      ...(b.completion_note ? [['Your report', esc(b.completion_note)]] : []),
    ];

    return `
      <a class="back" href="#/">${icon('left', 18)} Jobs</a>
      <div class="card">
        <div class="hero-status">${catIcon(b.category_id, 52)}
          <div style="flex:1;min-width:0"><h2>${esc(b.service_name)}</h2><div class="muted small">#HC${b.id} · ${fmtWhen(b.scheduled_for)}</div>${pill(b.status)}</div></div>
        ${['accepted', 'en_route', 'in_progress', 'completed', 'closed'].includes(b.status) ? trackerHtml(b) : ''}
        ${action ? `<div style="margin-top:16px">${action}</div>` : ''}
      </div>
      ${b.payment_method === 'cash' && ['accepted', 'en_route', 'in_progress'].includes(b.status)
        ? `<div class="notice amber">${icon('cash', 20)}<div>Collect <strong>${money(b.price)}</strong> cash from the customer when you finish.</div></div>` : ''}
      ${shared ? `
        <div class="card">
          <h3>Customer</h3>
          <div class="person"><span class="avatar lg">${initials(b.homeowner_name)}</span>
            <div class="body"><div class="strong">${esc(b.homeowner_name)}</div><div class="small muted">${esc(fmtPhone(b.homeowner_phone))}</div></div></div>
          <div class="spacer"></div>
          <div class="btn-row">
            <a class="btn sm" href="${telHref(b.homeowner_phone)}">${icon('phone', 16)} Call</a>
            <a class="btn sm whatsapp" href="${waHref(b.homeowner_phone, `Hi ${firstName(b.homeowner_name)}, I'm your ${S.config.company} partner for ${b.service_name}.`)}" target="_blank" rel="noopener">${icon('chat', 16)} WhatsApp</a>
            <a class="btn sm" href="${mapsHref(b)}" target="_blank" rel="noopener">${icon('pin', 16)} Directions</a>
          </div>
        </div>` : ''}
      <div class="card"><h3>Job details</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
      <p class="footer">Problem on site? ${supportLink('WhatsApp operations')}</p>`;
  },

  async history() {
    const rows = (await api('/bookings')).filter((b) => !['offered', ...PARTNER_ACTIVE].includes(b.status));
    return `<h1>Job history</h1>${rows.length
      ? `<div class="list">${rows.map((b) => bookingRow(b, `jobs/${b.id}`)).join('')}</div>`
      : emptyState('list', 'No past jobs yet', 'Jobs you finish will be listed here.')}`;
  },

  async earnings() {
    const e = await api('/provider/earnings');
    const owed = e.balance >= 0;
    return `
      <h1>Earnings</h1>
      <div class="card" style="background:${owed ? 'var(--brand)' : 'var(--amber-soft)'};color:${owed ? '#fff' : 'inherit'};border:0">
        <div class="small" style="opacity:.85">${owed ? 'Due to you at next payout' : 'Commission you owe from cash jobs'}</div>
        <div class="big-money" style="font-size:2.4rem">${money(Math.abs(e.balance))}</div>
        <div class="small" style="opacity:.85">${owed ? `Paid weekly to your EcoCash ${esc(fmtPhone(S.provider?.payout_number))}` : 'This is deducted from your next payout, or paid to the company by EcoCash.'}</div>
      </div>
      <div class="stats" style="margin-top:14px">
        <div class="card stat"><div class="value">${e.jobs.length}</div><div class="label">Completed jobs</div></div>
        <div class="card stat"><div class="value">${money(e.jobs.reduce((s, j) => s + (j.provider_share || 0), 0))}</div><div class="label">Total earned</div></div>
        <div class="card stat"><div class="value">${e.awaitingPayment}</div><div class="label">Waiting for customer payment</div></div>
      </div>
      <section class="section"><div class="section-title"><h2>Completed jobs</h2></div>
        ${e.jobs.length ? `<div class="list">${e.jobs.map((j) => `
          <a class="list-row" href="#/jobs/${j.id}">${catIcon(j.category_id, 40)}
            <div class="body"><div class="title">${esc(j.service_name)}</div><div class="sub">${fmtDate(j.scheduled_for)} · ${PAYMENT[j.payment_status]}${j.payout_id ? ' · settled' : ''}</div></div>
            <div class="end"><strong>${money(j.provider_share)}</strong></div></a>`).join('')}</div>`
          : emptyState('wallet', 'No earnings yet', 'Finish your first job to start earning.')}
      </section>
      ${e.payouts.length ? `<section class="section"><div class="section-title"><h2>Payouts</h2></div>
        <div class="list">${e.payouts.map((p) => `
          <div class="list-row"><div class="body"><div class="title">${p.amount >= 0 ? 'Paid to you' : 'Commission paid by you'}</div><div class="sub">${fmtDate(p.created_at)} · ref ${esc(p.reference)}</div></div>
          <div class="end"><strong>${money(Math.abs(p.amount))}</strong></div></div>`).join('')}</div></section>` : ''}`;
  },
};

// ---------------------------------------------------------------------------
// Operations admin
// ---------------------------------------------------------------------------

const A = {
  async dashboard() {
    const [s, rows] = await Promise.all([api('/admin/stats'), api('/bookings')]);
    const n = (k) => s.byStatus[k] || 0;
    const attention = [
      ['bookings?status=quote_requested', 'Quotes to prepare', n('quote_requested'), 'tag'],
      ['bookings?status=confirmed', 'Jobs needing a partner', n('confirmed'), 'users'],
      ['bookings?status=payments', 'Payments to check', s.paymentsToVerify, 'cash'],
      ['bookings?status=disputed', 'Problems reported', n('disputed'), 'alert'],
      ['partners', 'Partner applications', s.providers.pending || 0, 'shield'],
      ['bookings?status=offered', 'Waiting for partner reply', n('offered'), 'clock'],
    ];
    const soon = rows
      .filter((b) => ['offered', 'accepted', 'en_route', 'in_progress', 'confirmed'].includes(b.status) && new Date(b.scheduled_for) - Date.now() < 2 * 864e5)
      .sort((a, z) => a.scheduled_for.localeCompare(z.scheduled_for));
    return `
      <div class="page-head"><h1>Dashboard</h1><span class="muted small">Updates automatically</span></div>
      <div class="stats">
        <div class="card stat"><div class="value">${money(s.revenue)}</div><div class="label">Revenue (paid jobs)</div></div>
        <div class="card stat"><div class="value">${money(s.commission)}</div><div class="label">Company commission</div></div>
        <div class="card stat"><div class="value">${s.providers.active || 0}</div><div class="label">Active partners</div></div>
        <div class="card stat"><div class="value">${s.homeowners}</div><div class="label">Customers</div></div>
      </div>
      <section class="section">
        <div class="section-title"><h2>Needs your attention</h2></div>
        <div class="attention-grid">${attention.map(([href, label, count, ic]) => `
          <a class="card tight attention ${count ? '' : 'zero'}" href="#/${href}">
            <span class="cat-icon" style="width:42px;height:42px;background:${count ? 'var(--amber-soft)' : 'var(--gray-soft)'};color:${count ? 'var(--amber)' : 'var(--faint)'}">${icon(ic, 20)}</span>
            <span class="body"><span class="num">${count}</span><br><span class="label">${label}</span></span><span class="faint">${icon('right', 18)}</span></a>`).join('')}
        </div>
      </section>
      <section class="section">
        <div class="section-title"><h2>Next 48 hours</h2><a class="small" href="#/bookings">All bookings</a></div>
        ${soon.length ? `<div class="list">${soon.map((b) => bookingRow(b, `bookings/${b.id}`)).join('')}</div>` : '<div class="card flat center muted small">Nothing scheduled in the next 48 hours.</div>'}
      </section>`;
  },

  async bookings(query) {
    const rows = await api('/bookings');
    const filter = query.get('status') || '';
    const counts = {};
    rows.forEach((b) => { counts[b.status] = (counts[b.status] || 0) + 1; });
    const payments = rows.filter((b) => b.payment_status === 'pending_verification').length;
    const shown = filter === 'payments' ? rows.filter((b) => b.payment_status === 'pending_verification')
      : filter ? rows.filter((b) => b.status === filter) : rows;
    const chip = (key, label, count) =>
      `<a class="chip ${filter === key ? 'active' : ''}" href="#/bookings${key ? `?status=${key}` : ''}">${esc(label)}${count != null ? ` <span class="count">${count}</span>` : ''}</a>`;
    return `
      <div class="page-head"><h1>Bookings</h1></div>
      <label class="field" style="position:relative;margin:0 0 12px">
        <span class="hidden">Search bookings</span>
        <input type="search" data-filter-list placeholder="Search by customer, phone, suburb, service or #number" style="padding-left:42px">
        <span class="faint" style="position:absolute;left:13px;top:13px">${icon('search', 20)}</span>
      </label>
      <div class="chips scroll" style="margin-bottom:16px">
        ${chip('', 'All', rows.length)}
        ${chip('payments', 'Payments to check', payments)}
        ${Object.keys(STATUS).filter((k) => counts[k]).map((k) => chip(k, statusInfo(k)[0], counts[k])).join('')}
      </div>
      ${shown.length ? `<div class="list" id="filter-list">${shown.map((b) => `
        <div data-search-text="${esc(`#hc${b.id} ${b.homeowner_name} ${b.homeowner_phone} ${fmtPhone(b.homeowner_phone)} ${b.suburb} ${b.zone} ${b.service_name} ${b.provider_name || ''}`.toLowerCase())}">
          ${bookingRow(b, `bookings/${b.id}`)}</div>`).join('')}</div>`
        : emptyState('calendar', 'No bookings here', 'Try another filter.')}`;
  },

  async partners(query) {
    const rows = await api('/admin/providers');
    const tab = query.get('tab') || (rows.some((p) => p.status === 'pending') ? 'pending' : 'active');
    const count = (s) => rows.filter((p) => p.status === s).length;
    const shown = rows.filter((p) => p.status === tab);
    const catName = (id) => findCategory(id)?.name || id;
    const tabs = [['pending', 'Applications'], ['active', 'Active'], ['suspended', 'Suspended']];
    return `
      <div class="page-head"><h1>Partners</h1></div>
      <div class="chips" style="margin-bottom:16px">${tabs.map(([k, label]) =>
        `<a class="chip ${tab === k ? 'active' : ''}" href="#/partners?tab=${k}">${label} <span class="count">${count(k)}</span></a>`).join('')}</div>
      ${tab === 'pending' && shown.length ? `<div class="notice amber">${icon('shield', 18)}<div>Before approving: call the applicant, check their national ID and police clearance, and verify certificates for fumigation, tree cutting, CCTV and maid work.</div></div><div class="spacer"></div>` : ''}
      ${shown.length ? shown.map((p) => `
        <div class="card">
          <div class="person">
            <span class="avatar lg">${initials(p.name)}</span>
            <div class="body"><div class="strong">${esc(p.name)}${p.business_name ? ` <span class="muted small">· ${esc(p.business_name)}</span>` : ''}</div>
              <div class="small muted">${esc(fmtPhone(p.phone))} · ${p.provider_type === 'team' ? `Team of ${p.team_size}` : 'Individual'} · applied ${fmtDate(p.created_at)}</div></div>
            ${p.status === 'active' ? (p.available ? '<span class="pill green">Available</span>' : '<span class="pill gray">Offline</span>') : ''}
          </div>
          <dl class="kv" style="margin-top:14px">
            <dt>National ID</dt><dd>${esc(p.national_id)}</dd>
            <dt>Services</dt><dd>${p.skills.map((s) => `${esc(catName(s.category_id))}${s.certification ? ` <span class="muted small">(${esc(s.certification)})</span>` : ''}`).join('<br>')}</dd>
            <dt>Areas</dt><dd>${p.zones.map(esc).join(', ')}</dd>
            <dt>Payout EcoCash</dt><dd>${esc(fmtPhone(p.payout_number))}</dd>
            <dt>Track record</dt><dd>${p.completed_jobs} jobs · ${starsText(p.rating_avg, p.rating_count)}</dd>
            ${p.bio ? `<dt>Experience</dt><dd>${esc(p.bio)}</dd>` : ''}
          </dl>
          <div class="btn-row" style="margin-top:16px">
            ${contactButtons(p.phone)}
            <span class="grow"></span>
            ${p.status !== 'active' ? `<button class="btn primary" data-act="provider-status" data-id="${p.id}" data-status="active" data-name="${esc(p.name)}">${p.status === 'pending' ? 'Approve' : 'Reactivate'}</button>` : ''}
            ${p.status !== 'suspended' ? `<button class="btn danger" data-act="provider-status" data-id="${p.id}" data-status="suspended" data-name="${esc(p.name)}">${p.status === 'pending' ? 'Reject' : 'Suspend'}</button>` : ''}
          </div>
        </div>`).join('')
        : emptyState('users', tab === 'pending' ? 'No applications waiting' : `No ${tab} partners`, tab === 'pending' ? 'New partner applications will appear here.' : '')}`;
  },

  async settlements() {
    const { balances, recent } = await api('/admin/balances');
    return `
      <div class="page-head"><h1>Partner payouts</h1></div>
      <p class="muted">Closed, paid jobs that haven't been settled yet. <strong>Pay</strong> means the company sends the partner money. <strong>Collect</strong> means the partner took cash from customers and owes the company its commission.</p>
      ${balances.length ? `<div class="list">${balances.map((b) => `
        <div class="list-row">
          <span class="avatar">${initials(b.name)}</span>
          <div class="body"><div class="title">${esc(b.name)}</div><div class="sub">${b.jobs} job${b.jobs > 1 ? 's' : ''} · EcoCash ${esc(fmtPhone(b.payout_number))}</div></div>
          <div class="end"><span class="pill ${b.amount >= 0 ? 'green' : 'amber'}">${b.amount >= 0 ? 'Pay' : 'Collect'} ${money(Math.abs(b.amount))}</span></div>
          <button class="btn sm primary" data-act="modal-settle" data-id="${b.provider_id}" data-amount="${b.amount}" data-name="${esc(b.name)}" data-number="${esc(fmtPhone(b.payout_number))}">Settle</button>
        </div>`).join('')}</div>`
        : emptyState('wallet', 'All settled', 'There is nothing to pay or collect right now.')}
      <section class="section"><div class="section-title"><h2>Recent payouts</h2></div>
        ${recent.length ? `<div class="list">${recent.map((p) => `
          <div class="list-row"><div class="body"><div class="title">${esc(p.name)}</div><div class="sub">${fmtDate(p.created_at)} · ref ${esc(p.reference)}</div></div>
            <div class="end"><strong>${p.amount >= 0 ? 'Paid' : 'Collected'} ${money(Math.abs(p.amount))}</strong></div></div>`).join('')}</div>`
          : '<div class="card flat center muted small">No payouts recorded yet.</div>'}
      </section>`;
  },

  async services() {
    S.catalog = await api('/catalog');
    return `
      <div class="page-head"><h1>Services & prices</h1></div>
      <p class="muted">Prices are in USD. Changes apply to new bookings only; existing bookings keep their price.</p>
      ${S.catalog.map((c) => `
        <section class="section">
          <div class="section-title"><h2 style="display:flex;align-items:center;gap:10px">${catIcon(c.id, 32)} ${esc(c.name)}</h2></div>
          <div class="list">${c.services.map((s) => {
            const p = fromPrice(s);
            return `<details class="svc">
              <summary><div style="flex:1;min-width:0"><div class="strong">${esc(s.name)}</div><div class="small muted">${p.main} ${esc(p.sub)} · ${Math.round(s.commission_rate * 100)}% commission</div></div>
                ${s.active ? '<span class="pill green">Live</span>' : '<span class="pill gray">Hidden</span>'}<span class="faint">${icon('right', 18)}</span></summary>
              <form data-form="service" data-id="${s.id}">
                ${s.pricing_type === 'quote' ? '<p class="small muted">Priced by quote after a site visit.</p>' : `<div class="grid-2">${s.options.map((o) => `
                  <label class="field"><span>${esc(o.label)}${s.unit_label ? ` <span class="faint">(per ${esc(s.unit_label)})</span>` : ''}</span><input name="price" type="number" step="0.5" min="0.5" value="${o.price}" required></label>`).join('')}</div>`}
                <div class="grid-2">
                  <label class="field"><span>Company commission (%)</span><input name="commission" type="number" min="0" max="100" step="1" value="${Math.round(s.commission_rate * 100)}" required></label>
                </div>
                <div style="margin-top:14px"><label class="switch"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}><span class="track"></span> Customers can book this</label></div>
                <div class="form-error"></div>
                <button class="btn primary" style="margin-top:14px" type="submit">Save changes</button>
              </form>
            </details>`;
          }).join('')}</div>
        </section>`).join('')}`;
  },
};

// ---------------------------------------------------------------------------
// Account (all roles)
// ---------------------------------------------------------------------------

async function accountPage() {
  const role = S.user.role;
  let extra = '';
  if (role === 'homeowner') {
    S.properties = await api('/properties');
    extra = `
      <section class="section"><div class="section-title"><h2>My addresses</h2></div>
        ${S.properties.length ? `<div class="list">${S.properties.map((p) => `
          <div class="list-row"><span class="cat-icon" style="width:40px;height:40px;background:var(--brand-soft);color:var(--brand)">${icon('home', 20)}</span>
            <div class="body"><div class="title">${esc(p.label)}</div><div class="sub">${esc(p.address)}, ${esc(p.suburb)} · ${esc(p.zone)}</div></div>
            <button class="btn sm ghost danger" data-act="delete-property" data-id="${p.id}" aria-label="Remove ${esc(p.label)}">${icon('trash', 18)}</button></div>`).join('')}</div>`
          : '<div class="card flat center muted small">No addresses yet.</div>'}
        <button class="btn" style="margin-top:12px" data-act="modal-property">${icon('plus', 18)} Add address</button>
      </section>`;
  }
  if (role === 'provider') {
    const me = await api('/me');
    S.provider = me.provider;
    const p = S.provider;
    extra = `
      ${partnerStatusNotice()}
      <section class="section"><div class="section-title"><h2>My work profile</h2></div>
        <div class="card"><dl class="kv">
          <dt>Status</dt><dd>${p.status === 'active' ? 'Approved' : p.status === 'pending' ? 'Under review' : 'Paused'}</dd>
          <dt>Rating</dt><dd>${starsText(p.rating_avg, p.rating_count)}</dd>
          <dt>Working as</dt><dd>${p.provider_type === 'team' ? `Team of ${p.team_size}` : 'Individual'}${p.business_name ? ` · ${esc(p.business_name)}` : ''}</dd>
          <dt>Services</dt><dd>${p.skills.map((s) => esc(findCategory(s.category_id)?.name || s.category_id)).join('<br>')}</dd>
          <dt>Areas</dt><dd>${p.zones.map(esc).join(', ')}</dd>
          <dt>Payout EcoCash</dt><dd>${esc(fmtPhone(p.payout_number))}</dd>
        </dl>
        <p class="small muted" style="margin-top:14px">To change your services, areas or payout number, ${supportLink('message the operations team')}.</p></div>
      </section>`;
  }
  return `
    <h1>Account</h1>
    <div class="card"><div class="person"><span class="avatar lg">${initials(S.user.name)}</span>
      <div class="body"><div class="strong">${esc(S.user.name)}</div><div class="small muted">${esc(fmtPhone(S.user.phone))}${S.user.email ? ` · ${esc(S.user.email)}` : ''}</div></div></div></div>
    ${extra}
    <section class="section"><div class="section-title"><h2>Change password</h2></div>
      <div class="card"><form data-form="password">
        <label class="field" style="margin-top:0"><span>Current password</span><input name="current" type="password" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input name="next" type="password" minlength="6" required autocomplete="new-password"><small>At least 6 characters.</small></label>
        <div class="form-error"></div>
        <button class="btn primary" style="margin-top:14px" type="submit">Update password</button>
      </form></div>
    </section>
    <section class="section">
      <div class="card"><div class="btn-row" style="align-items:center"><div class="grow"><strong>Need help?</strong><div class="small muted">Call ${esc(fmtPhone(S.config.supportPhone))} or message us on WhatsApp.</div></div>
        ${contactButtons(S.config.supportPhone, `Hi ${S.config.company}, I need help`)}</div></div>
      <button class="btn block danger" style="margin-top:14px" data-act="logout">${icon('logout', 18)} Log out</button>
    </section>`;
}

function propertyModal() {
  openModal(`
    <h2>Add an address</h2>
    <form data-form="property">
      <div class="grid-2">
        <label class="field"><span>Name</span><input name="label" required placeholder="Home, Office, Mum's house"></label>
        <label class="field"><span>Type</span><select name="property_type">
          <option>House</option><option>Flat / Apartment</option><option>Cluster / Townhouse</option><option>Office</option><option>Shop / Business</option><option>Farm / Plot</option></select></label>
      </div>
      <label class="field"><span>Street address</span><input name="address" required placeholder="House number and street name"></label>
      <div class="grid-2">
        <label class="field"><span>Suburb</span><input name="suburb" required placeholder="e.g. Avondale"></label>
        <label class="field"><span>Area</span><select name="zone" required>${S.config.zones.map((z) => `<option>${esc(z)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Directions <span class="faint">(optional)</span></span><textarea name="notes" placeholder="Landmarks, gate colour, dogs…" style="min-height:70px"></textarea></label>
      <div class="form-error"></div>
      <button class="btn primary lg block" style="margin-top:16px" type="submit">Save address</button>
    </form>`);
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function runAction(id, action, body = {}, success = 'Done') {
  await api(`/bookings/${id}/actions/${action}`, { method: 'POST', body });
  closeModal();
  toast(success);
  await refresh();
}

const CLICKS = {
  logout,
  reload: () => route(),
  'close-modal': closeModal,
  dialog(el) {
    const resolve = S.dialogResolve;
    S.dialogResolve = null;
    closeModal();
    resolve?.(el.dataset.v === '1');
  },
  'demo-login': (el) =>
    api('/auth/login', { method: 'POST', body: { login: el.dataset.login, password: el.dataset.password } }).then(startSession),

  async act(el) {
    const d = el.dataset;
    if (d.confirm && !(await confirmDialog({ title: d.confirm, body: d.confirmBody, confirmText: 'Yes, continue', danger: !!d.danger }))) return;
    await runAction(d.id, d.action, {}, d.success);
  },
  offer: (el) => runAction(el.dataset.id, 'assign', { provider_id: Number(el.dataset.provider) }, 'Job offered to partner'),
  star(el) {
    const n = Number(el.dataset.n);
    const form = el.closest('form');
    form.rating.value = n;
    form.querySelectorAll('.stars button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= n));
  },

  'modal-property': () => propertyModal(),
  'modal-dispute'(el) {
    openModal(`
      <h2>Report a problem</h2>
      <p class="muted">Tell us what went wrong. Our team will call you and the partner to put it right.</p>
      <form data-form="note-action" data-id="${el.dataset.id}" data-action="dispute" data-success="Problem reported. We'll be in touch">
        <label class="field"><span>What went wrong?</span><textarea name="note" required></textarea></label>
        <div class="form-error"></div>
        <button class="btn primary lg block" style="margin-top:14px" type="submit">Send report</button>
      </form>`);
  },
  'modal-note'(el) {
    const d = el.dataset;
    openModal(`
      <h2>${esc(d.title)}</h2>
      <form data-form="note-action" data-id="${d.id}" data-action="${d.action}" data-success="${esc(d.title)}: done">
        <label class="field"><span>Note${d.required ? '' : ' <span class="faint">(optional)</span>'}</span><textarea name="note" ${d.required ? 'required' : ''}
          placeholder="${d.action === 'refund' ? 'Amount refunded, how and when' : 'e.g. customer confirmed by phone'}"></textarea></label>
        <div class="form-error"></div>
        <button class="btn ${d.action === 'refund' ? 'danger solid' : 'primary'} lg block" style="margin-top:14px" type="submit">${esc(d.title)}</button>
      </form>`);
  },
  async 'modal-complete'(el) {
    const b = await api(`/bookings/${el.dataset.id}`);
    openModal(`
      <h2>Finish job</h2>
      <form data-form="complete" data-id="${b.id}">
        <label class="field"><span>What did you do? <span class="faint">(optional)</span></span>
          <textarea name="note" placeholder="${b.category_id === 'fumigation' ? 'Chemicals used, rooms treated, when the family can go back in' : b.category_id === 'cctv' ? 'Cameras installed, serial numbers, app login handed over' : 'Work done, anything the customer should know'}"></textarea></label>
        ${b.payment_method === 'cash' ? `<label class="choice" style="margin-top:14px"><input type="checkbox" name="cash_collected"><span class="tick">${icon('check', 14)}</span>
          <div class="body"><div class="title">I collected ${money(b.price)} cash</div><div class="sub">Tick this once the customer has paid you</div></div></label>` : ''}
        <div class="form-error"></div>
        <button class="btn primary lg block" style="margin-top:16px" type="submit">Mark job as finished</button>
      </form>`);
  },
  'modal-settle'(el) {
    const d = el.dataset;
    const amount = Number(d.amount);
    openModal(`
      <h2>Settle with ${esc(d.name)}</h2>
      <div class="notice ${amount >= 0 ? '' : 'amber'}">${icon('wallet', 20)}<div>${amount >= 0
        ? `Send <strong>${money(amount)}</strong> to EcoCash <strong>${esc(d.number)}</strong>, then record the transaction reference.`
        : `Collect <strong>${money(-amount)}</strong> commission from ${esc(d.name)}, then record the reference.`}</div></div>
      <form data-form="settle" data-id="${d.id}">
        <label class="field"><span>Transaction reference</span><input name="reference" required autocomplete="off"></label>
        <div class="form-error"></div>
        <button class="btn primary lg block" style="margin-top:14px" type="submit">Record payout</button>
      </form>`);
  },

  async 'provider-status'(el) {
    const d = el.dataset;
    const approve = d.status === 'active';
    const ok = await confirmDialog({
      title: approve ? `Approve ${d.name}?` : `${el.textContent.trim()} ${d.name}?`,
      body: approve ? 'They will start receiving job offers straight away.' : 'They will stop receiving job offers.',
      confirmText: el.textContent.trim(),
      danger: !approve,
    });
    if (!ok) return;
    await api(`/admin/providers/${d.id}/status`, { method: 'POST', body: { status: d.status } });
    toast(approve ? `${d.name} is now active` : `${d.name} has been ${el.textContent.trim() === 'Reject' ? 'rejected' : 'suspended'}`);
    refresh();
  },
  async 'delete-property'(el) {
    if (!(await confirmDialog({ title: 'Remove this address?', confirmText: 'Remove', danger: true }))) return;
    await api(`/properties/${el.dataset.id}`, { method: 'DELETE' });
    toast('Address removed');
    refresh();
  },

  // Wizard
  'wiz-back'() {
    if (S.wiz.step === 0) {
      const s = findService(S.wiz.serviceId);
      S.wiz = null;
      return go(`services/${s.category.id}`);
    }
    S.wiz.step -= 1;
    W.rerender();
    window.scrollTo(0, 0);
  },
  'wiz-next'() {
    const s = findService(S.wiz.serviceId);
    const error = W.validate(s);
    if (error) {
      $('#wiz-error').textContent = error;
      return;
    }
    S.wiz.step += 1;
    W.rerender();
    window.scrollTo(0, 0);
  },
  'wiz-submit': () => W.submit(),
  qty(el) {
    S.wiz.qty = Math.min(100, Math.max(1, S.wiz.qty + Number(el.dataset.d)));
    W.rerender();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const handler = CLICKS[el.dataset.act];
  if (!handler) return;
  e.preventDefault();
  const busy = el.tagName === 'BUTTON' && !['dialog', 'star', 'qty', 'close-modal', 'wiz-back', 'wiz-next'].includes(el.dataset.act);
  const original = el.innerHTML;
  if (busy) {
    if (el.disabled) return;
    el.disabled = true;
    el.innerHTML = '<span class="spin"></span>';
  }
  try {
    await handler(el);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (busy && el.isConnected) {
      el.disabled = false;
      el.innerHTML = original;
    }
  }
});

$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen()) closeModal(); });

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('[data-search]')) searchServices(t.value);
  if (t.matches('[data-filter-list]')) {
    const term = t.value.trim().toLowerCase();
    $$('#filter-list [data-search-text]').forEach((row) => row.classList.toggle('hidden', !!term && !row.dataset.searchText.includes(term)));
  }
  if (S.wiz && t.name === 'wiz-details') S.wiz.details = t.value;
  if (S.wiz && t.name === 'wiz-qty') {
    const n = parseInt(t.value, 10);
    if (n >= 1 && n <= 100) {
      S.wiz.qty = n;
      const s = findService(S.wiz.serviceId);
      const total = $('.wizard-foot .total b');
      if (total) total.textContent = money(W.total(s));
    }
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (S.wiz && t.name?.startsWith('wiz-')) {
    const w = S.wiz;
    if (t.name === 'wiz-option') w.option = Number(t.value);
    if (t.name === 'wiz-day') {
      w.day = t.value;
      if (!slotOpen(w.day, w.time)) w.time = SLOTS.find((s) => slotOpen(w.day, s));
    }
    if (t.name === 'wiz-time') w.time = t.value;
    if (t.name === 'wiz-property') w.propertyId = Number(t.value);
    if (t.name === 'wiz-pay') w.payment = t.value;
    if (['wiz-option', 'wiz-day'].includes(t.name)) {
      const y = window.scrollY;
      W.rerender();
      window.scrollTo(0, y);
    }
    $('#wiz-error') && ($('#wiz-error').textContent = '');
    return;
  }
  if (t.matches('[data-skill]')) {
    document.querySelector(`[data-cert="${t.value}"]`)?.classList.toggle('hidden', !t.checked);
  }
  if (t.matches('[data-team-toggle]')) {
    document.querySelector('[data-team]')?.classList.toggle('hidden', t.value !== 'team');
  }
  if (t.matches('[data-availability]')) {
    try {
      S.provider = await api('/provider/availability', { method: 'POST', body: { available: t.checked } });
      toast(t.checked ? "You're available for new jobs" : "You're offline. No new offers will be sent");
      refresh();
    } catch (err) {
      t.checked = !t.checked;
      toast(err.message, true);
    }
  }
});

const FORMS = {
  async login(form, data) {
    startSession(await api('/auth/login', { method: 'POST', body: data }));
  },
  async signup(form, data) {
    startSession(await api('/auth/register', { method: 'POST', body: { ...data, role: 'homeowner' } }));
  },
  async partner(form, data) {
    const fd = new FormData(form);
    const skills = fd.getAll('skill').map((id) => ({ category_id: id, certification: data[`cert_${id}`] || null }));
    if (!skills.length) throw new Error('Choose at least one service you offer');
    if (!fd.getAll('zones').length) throw new Error('Choose at least one area you can work in');
    startSession(await api('/auth/register', { method: 'POST', body: { ...data, role: 'provider', zones: fd.getAll('zones'), skills } }));
    toast('Application received. We will call you soon');
  },
  async property(form, data) {
    const p = await api('/properties', { method: 'POST', body: data });
    closeModal();
    toast('Address saved');
    if (S.wiz) {
      S.properties = await api('/properties');
      S.wiz.propertyId = p.id;
      W.rerender();
    } else {
      refresh();
    }
  },
  pay: (form, data) => runAction(form.dataset.id, 'submit_payment', data, "Thanks! We're confirming your payment"),
  rate: (form, data) => runAction(form.dataset.id, 'confirm', { rating: Number(data.rating), review: data.review }, 'Thank you for your feedback'),
  quote: (form, data) => runAction(form.dataset.id, 'set_quote', { price: Number(data.price), note: data.note }, 'Quote sent to customer'),
  'note-action': (form, data) => runAction(form.dataset.id, form.dataset.action, data, form.dataset.success),
  complete: (form, data) => runAction(form.dataset.id, 'complete', { note: data.note, cash_collected: 'cash_collected' in data }, 'Job finished. The customer has been asked to confirm'),
  async settle(form, data) {
    await api('/admin/payouts', { method: 'POST', body: { provider_id: Number(form.dataset.id), reference: data.reference } });
    closeModal();
    toast('Payout recorded');
    refresh();
  },
  async service(form) {
    const fd = new FormData(form);
    await api(`/admin/services/${form.dataset.id}`, {
      method: 'PUT',
      body: { prices: fd.getAll('price').map(Number), commission_rate: Number(fd.get('commission')) / 100, active: fd.has('active') },
    });
    toast('Prices saved');
    refresh();
  },
  async password(form, data) {
    await api('/me/password', { method: 'POST', body: data });
    form.reset();
    toast('Password updated');
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const errorBox = form.querySelector('.form-error');
  if (errorBox) errorBox.textContent = '';
  const button = form.querySelector('button[type="submit"]');
  const original = button?.innerHTML;
  if (button) {
    if (button.disabled) return;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> Please wait';
  }
  try {
    await FORMS[form.dataset.form](form, Object.fromEntries(new FormData(form)));
  } catch (err) {
    if (errorBox && errorBox.isConnected) errorBox.textContent = err.message;
    else toast(err.message, true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
});

window.addEventListener('hashchange', () => route());

boot().catch((err) => {
  $('#app').innerHTML = `<main>${emptyState('alert', 'Could not start the app', err.message, '<button class="btn" onclick="location.reload()">Try again</button>')}</main>`;
});
