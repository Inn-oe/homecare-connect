const express = require('express');
const path = require('path');
const { db } = require('./db');
const { hashPassword, verifyPassword, issueToken, readToken } = require('./auth');
const config = require('./config');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

// ---- Helpers ---------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const round2 = (n) => Math.round(n * 100) / 100;
const now = () => new Date().toISOString();

function str(value, name, { required = true, max = 200 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) fail(400, `${name} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) fail(400, `${name} is too long (max ${max} characters)`);
  return s;
}

// Accepts 0772123456, 772123456, +263772123456 or 263 772 123 456; stores +263772123456.
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  let local;
  if (/^2637\d{8}$/.test(digits)) local = digits.slice(3);
  else if (/^07\d{8}$/.test(digits)) local = digits.slice(1);
  else if (/^7\d{8}$/.test(digits)) local = digits;
  else fail(400, 'Enter a valid Zimbabwe mobile number, e.g. 0772 123 456');
  return '+263' + local;
}

const getUser = (id, q = db) => q.get('SELECT id, role, name, phone, email, created_at FROM users WHERE id = ?', id);

async function getProvider(userId, q = db) {
  const p = await q.get('SELECT * FROM providers WHERE user_id = ?', userId);
  if (!p) return null;
  p.zones = JSON.parse(p.zones);
  p.skills = await q.all('SELECT category_id, certification FROM provider_skills WHERE provider_id = ?', userId);
  return p;
}

const logEvent = (q, bookingId, actorId, action, status, note = null) =>
  q.run('INSERT INTO booking_events (booking_id, actor_id, action, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    bookingId, actorId, action, status, note, now());

// ---- Auth middleware -------------------------------------------------------

app.use('/api', async (req, _res, next) => {
  const payload = readToken((req.get('authorization') || '').replace(/^Bearer /, ''));
  req.user = payload ? await getUser(payload.uid) : null;
  next();
});

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please log in'));
  if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'You are not allowed to do that'));
  next();
};

// ---- Public ----------------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({
    company: config.COMPANY_NAME,
    currency: config.CURRENCY,
    zones: config.ZONES,
    paymentMethods: config.PAYMENT_METHODS,
    paymentInstructions: config.PAYMENT_INSTRUCTIONS,
    supportPhone: config.SUPPORT_PHONE,
    demo: config.SEED_DEMO,
  });
});

async function catalog({ includeInactive = false } = {}) {
  const categories = await db.all('SELECT * FROM categories ORDER BY sort_order');
  const services = await db.all(`SELECT * FROM services ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY id`);
  return categories.map((c) => ({
    ...c,
    services: services.filter((s) => s.category_id === c.id).map((s) => ({ ...s, options: JSON.parse(s.options) })),
  }));
}

app.get('/api/catalog', async (req, res) => {
  res.json(await catalog({ includeInactive: req.user?.role === 'admin' }));
});

// ---- Accounts --------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  const b = req.body || {};
  const role = b.role === 'provider' ? 'provider' : 'homeowner';
  const name = str(b.name, 'Full name', { max: 100 });
  const phone = normalizePhone(b.phone);
  const email = str(b.email, 'Email', { required: false, max: 120 })?.toLowerCase() ?? null;
  const password = String(b.password || '');
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (await db.get('SELECT 1 AS x FROM users WHERE phone = ? OR email = ?', phone, email)) {
    fail(409, 'An account with that phone number or email already exists');
  }

  let partner;
  if (role === 'provider') {
    const zones = Array.isArray(b.zones) ? b.zones.filter((z) => config.ZONES.includes(z)) : [];
    if (!zones.length) fail(400, 'Choose at least one area you can work in');
    const categories = new Map((await db.all('SELECT id, name, certification_required FROM categories')).map((c) => [c.id, c]));
    const skills = (Array.isArray(b.skills) ? b.skills : []).filter((s) => categories.has(s?.category_id));
    if (!skills.length) fail(400, 'Choose at least one service you offer');
    for (const s of skills) {
      const cat = categories.get(s.category_id);
      s.certification = str(s.certification, `Certification for ${cat.name}`, { required: !!cat.certification_required, max: 200 });
    }
    partner = {
      business_name: str(b.business_name, 'Business name', { required: false, max: 100 }),
      provider_type: b.provider_type === 'team' ? 'team' : 'individual',
      team_size: b.provider_type === 'team' ? Math.min(Math.max(parseInt(b.team_size, 10) || 2, 2), 100) : 1,
      national_id: str(b.national_id, 'National ID number', { max: 30 }),
      payout_number: normalizePhone(b.payout_number || b.phone),
      bio: str(b.bio, 'About you', { required: false, max: 1000 }),
      zones,
      skills,
    };
  }

  const userId = await db.tx(async (t) => {
    const { id } = await t.run(
      'INSERT INTO users (role, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      role, name, phone, email, hashPassword(password), now()
    );
    if (partner) {
      await t.run(
        `INSERT INTO providers (user_id, business_name, provider_type, team_size, national_id, payout_number, zones, bio, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, partner.business_name, partner.provider_type, partner.team_size, partner.national_id, partner.payout_number,
        JSON.stringify(partner.zones), partner.bio, now()
      );
      for (const s of partner.skills) {
        await t.run('INSERT INTO provider_skills (provider_id, category_id, certification) VALUES (?, ?, ?)', id, s.category_id, s.certification);
      }
    }
    return id;
  });

  res.status(201).json({ token: issueToken({ id: userId }), user: await getUser(userId) });
});

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body?.login || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  let row = await db.get('SELECT * FROM users WHERE email = ?', login);
  if (!row) {
    let phone = null;
    try {
      phone = normalizePhone(login);
    } catch {
      /* not a phone number */
    }
    if (phone) row = await db.get('SELECT * FROM users WHERE phone = ?', phone);
  }
  if (!row || !verifyPassword(password, row.password_hash)) fail(401, 'Wrong phone/email or password');
  res.json({ token: issueToken(row), user: await getUser(row.id) });
});

app.get('/api/me', requireRole(), async (req, res) => {
  res.json({ user: req.user, provider: req.user.role === 'provider' ? await getProvider(req.user.id) : null });
});

app.post('/api/me/password', requireRole(), async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body?.current || ''), row.password_hash)) fail(400, 'Your current password is wrong');
  const next = String(req.body?.next || '');
  if (next.length < 6) fail(400, 'New password must be at least 6 characters');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
  res.json({ ok: true });
});

app.post('/api/provider/availability', requireRole('provider'), async (req, res) => {
  await db.run('UPDATE providers SET available = ? WHERE user_id = ?', req.body?.available ? 1 : 0, req.user.id);
  res.json(await getProvider(req.user.id));
});

// ---- Properties (homeowner) -----------------------------------------------

app.get('/api/properties', requireRole('homeowner'), async (req, res) => {
  res.json(await db.all('SELECT * FROM properties WHERE owner_id = ? ORDER BY id', req.user.id));
});

app.post('/api/properties', requireRole('homeowner'), async (req, res) => {
  const b = req.body || {};
  const zone = config.ZONES.includes(b.zone) ? b.zone : fail(400, 'Choose the area the property is in');
  const { id } = await db.run(
    'INSERT INTO properties (owner_id, label, address, suburb, zone, property_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    req.user.id,
    str(b.label, 'Name for this property', { max: 60 }),
    str(b.address, 'Street address', { max: 200 }),
    str(b.suburb, 'Suburb', { max: 80 }),
    zone,
    str(b.property_type, 'Property type', { max: 40 }),
    str(b.notes, 'Notes', { required: false, max: 500 })
  );
  res.status(201).json(await db.get('SELECT * FROM properties WHERE id = ?', id));
});

app.delete('/api/properties/:id', requireRole('homeowner'), async (req, res) => {
  const id = Number(req.params.id);
  if (!(await db.get('SELECT 1 AS x FROM properties WHERE id = ? AND owner_id = ?', id, req.user.id))) fail(404, 'Property not found');
  if (await db.get('SELECT 1 AS x FROM bookings WHERE property_id = ?', id)) fail(409, 'This property has bookings, so it cannot be removed');
  await db.run('DELETE FROM properties WHERE id = ?', id);
  res.json({ ok: true });
});

// ---- Bookings --------------------------------------------------------------

const BOOKING_SELECT = `
  SELECT b.*, s.name AS service_name, s.pricing_type, s.unit_label, c.id AS category_id, c.name AS category_name,
         p.label AS property_label, p.address, p.suburb, p.zone, p.property_type,
         h.name AS homeowner_name, h.phone AS homeowner_phone,
         pu.name AS provider_name, pu.phone AS provider_phone,
         pr.business_name AS provider_business, pr.rating_avg AS provider_rating, pr.rating_count AS provider_rating_count
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN categories c ON c.id = s.category_id
  JOIN properties p ON p.id = b.property_id
  JOIN users h ON h.id = b.homeowner_id
  LEFT JOIN users pu ON pu.id = b.provider_id
  LEFT JOIN providers pr ON pr.user_id = b.provider_id`;

const loadBooking = (id, q = db) => q.get(`${BOOKING_SELECT} WHERE b.id = ?`, id);

// Once a partner has accepted, homeowner and partner can see each other's phone number and the full address.
const CONTACT_SHARED = ['accepted', 'en_route', 'in_progress', 'completed', 'closed', 'disputed'];

const providerShare = (b) => (b.price == null ? null : round2(b.price * (1 - b.commission_rate)));

// What a settled job adds to a partner's balance. For cash jobs the partner already holds
// the money, so they owe the company its commission instead.
function settlementAmount(b) {
  if (b.payment_status === 'paid') return providerShare(b);
  if (b.payment_status === 'cash_collected') return round2(providerShare(b) - b.price);
  return 0;
}

function present(b, user) {
  const out = { ...b, provider_share: providerShare(b) };
  const shared = CONTACT_SHARED.includes(b.status);
  if (user.role === 'homeowner') {
    delete out.commission_rate;
    delete out.provider_share;
    if (!shared) out.provider_phone = null;
  }
  if (user.role === 'provider' && !shared) {
    out.homeowner_phone = null;
    out.address = null;
  }
  return out;
}

function canSee(b, user) {
  return user.role === 'admin' || b.homeowner_id === user.id || b.provider_id === user.id;
}

app.post('/api/bookings', requireRole('homeowner'), async (req, res) => {
  const b = req.body || {};
  const service = await db.get('SELECT * FROM services WHERE id = ? AND active = 1', Number(b.service_id)) || fail(404, 'Service not found');
  const property = await db.get('SELECT * FROM properties WHERE id = ? AND owner_id = ?', Number(b.property_id), req.user.id)
    || fail(400, 'Choose one of your properties');
  const scheduled = new Date(b.scheduled_for);
  if (isNaN(scheduled)) fail(400, 'Choose a date and time');
  if (scheduled.getTime() < Date.now()) fail(400, 'Choose a date and time in the future');
  if (!config.PAYMENT_METHODS[b.payment_method]) fail(400, 'Choose a payment method');
  const details = str(b.details, 'Details', { required: false, max: 2000 });
  if (service.pricing_type === 'placement' && !details) fail(400, 'Tell us what you need from the maid so we can match you');

  let optionLabel = null;
  let quantity = 1;
  let price = null;
  let status = 'quote_requested';
  if (service.pricing_type !== 'quote') {
    const option = JSON.parse(service.options)[Number(b.option_index)] || fail(400, 'Choose an option');
    if (service.pricing_type === 'unit') {
      quantity = Number(b.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) fail(400, 'Enter a quantity between 1 and 100');
    }
    optionLabel = option.label;
    price = round2(option.price * quantity);
    status = 'confirmed';
  }

  const id = await db.tx(async (t) => {
    const { id } = await t.run(
      `INSERT INTO bookings (homeowner_id, property_id, service_id, option_label, quantity, details, scheduled_for, status,
                             price, commission_rate, payment_method, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      req.user.id, property.id, service.id, optionLabel, quantity, details, scheduled.toISOString(), status,
      price, service.commission_rate, b.payment_method, now(), now()
    );
    await logEvent(t, id, req.user.id, 'create', status, status === 'quote_requested' ? 'Site survey / quote requested' : null);
    return id;
  });
  res.status(201).json(present(await loadBooking(id), req.user));
});

app.get('/api/bookings', requireRole(), async (req, res) => {
  const { role, id } = req.user;
  let rows;
  if (role === 'homeowner') {
    rows = await db.all(`${BOOKING_SELECT} WHERE b.homeowner_id = ? ORDER BY b.created_at DESC`, id);
  } else if (role === 'provider') {
    rows = await db.all(`${BOOKING_SELECT} WHERE b.provider_id = ? ORDER BY b.scheduled_for DESC`, id);
  } else if (req.query.status) {
    rows = await db.all(`${BOOKING_SELECT} WHERE b.status = ? ORDER BY b.scheduled_for LIMIT 300`, String(req.query.status));
  } else {
    rows = await db.all(`${BOOKING_SELECT} ORDER BY b.created_at DESC LIMIT 300`);
  }
  res.json(rows.map((b) => present(b, req.user)));
});

app.get('/api/bookings/:id', requireRole(), async (req, res) => {
  const b = await loadBooking(Number(req.params.id));
  if (!b || !canSee(b, req.user)) fail(404, 'Booking not found');
  const events = await db.all(
    `SELECT e.action, e.status, e.note, e.created_at, u.name AS actor_name, u.role AS actor_role
     FROM booking_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.booking_id = ? ORDER BY e.id`,
    b.id
  );
  res.json({ ...present(b, req.user), events });
});

// ---- Dispatch --------------------------------------------------------------

// Active, available partners with the right skill who cover the property's zone, best first.
// Partners who already declined this booking are left out.
async function eligibleProviders(b, q = db) {
  const rows = await q.all(
    `SELECT pr.user_id, pr.business_name, pr.zones, pr.rating_avg, pr.rating_count, pr.provider_type, pr.team_size,
            u.name, u.phone,
            (SELECT COUNT(*) FROM bookings x WHERE x.provider_id = pr.user_id
               AND x.status IN ('offered','accepted','en_route','in_progress')) AS active_jobs,
            (SELECT COUNT(*) FROM bookings x WHERE x.provider_id = pr.user_id
               AND x.status IN ('offered','accepted','en_route','in_progress')
               AND substr(x.scheduled_for, 1, 10) = substr(?, 1, 10)) AS jobs_that_day,
            (SELECT COUNT(*) FROM bookings x WHERE x.provider_id = pr.user_id AND x.status = 'closed') AS completed_jobs
     FROM providers pr
     JOIN users u ON u.id = pr.user_id
     JOIN provider_skills ps ON ps.provider_id = pr.user_id AND ps.category_id = ?
     WHERE pr.status = 'active' AND pr.available = 1
       AND pr.user_id NOT IN (SELECT actor_id FROM booking_events WHERE booking_id = ? AND action = 'decline' AND actor_id IS NOT NULL)`,
    b.scheduled_for, b.category_id, b.id
  );

  return rows
    .filter((r) => JSON.parse(r.zones).includes(b.zone))
    .map((r) => {
      // New partners are treated as 4-star until they have ratings; busy partners rank lower.
      const rating = r.rating_count ? r.rating_avg : 4;
      const score = rating * 20 - r.jobs_that_day * 15 - r.active_jobs * 5 + Math.min(r.completed_jobs, 20);
      return { ...r, zones: undefined, score: round2(score) };
    })
    .sort((a, z) => z.score - a.score);
}

app.get('/api/admin/bookings/:id/eligible', requireRole('admin'), async (req, res) => {
  const b = await loadBooking(Number(req.params.id)) || fail(404, 'Booking not found');
  res.json(await eligibleProviders(b));
});

async function offerTo(t, b, providerId) {
  await t.run('UPDATE bookings SET provider_id = ? WHERE id = ?', providerId, b.id);
  return `Offered to ${(await getUser(providerId, t)).name}`;
}

// ---- Booking actions (the job lifecycle) ----------------------------------
//
// quote_requested -> quoted -> confirmed -> offered -> accepted -> en_route -> in_progress -> completed -> closed
// Fixed-price bookings start at confirmed. Side exits: cancelled, disputed -> closed | refunded.
// Each run(t, b, body, user) gets a transaction handle and returns an optional note for the timeline.

const OPEN_PAYMENT = ['confirmed', 'offered', 'accepted', 'en_route', 'in_progress', 'completed', 'closed', 'disputed'];

const ACTIONS = {
  // Homeowner
  cancel: {
    roles: ['homeowner', 'admin'],
    from: ['quote_requested', 'quoted', 'confirmed', 'offered', 'accepted'],
    to: 'cancelled',
    run: async (t, b, body) => str(body.note, 'Reason', { required: false, max: 500 }),
  },
  accept_quote: { roles: ['homeowner'], from: ['quoted'], to: 'confirmed' },
  decline_quote: { roles: ['homeowner'], from: ['quoted'], to: 'cancelled' },
  submit_payment: {
    roles: ['homeowner'],
    from: OPEN_PAYMENT,
    async run(t, b, body) {
      if (b.payment_method === 'cash') fail(400, 'This booking is paid in cash when the job is done');
      if (b.payment_status !== 'unpaid') fail(409, 'Payment has already been submitted');
      const ref = str(body.reference, 'Payment reference', { max: 60 });
      await t.run("UPDATE bookings SET payment_status = 'pending_verification', payment_ref = ? WHERE id = ?", ref, b.id);
      return `Payment submitted via ${config.PAYMENT_METHODS[b.payment_method]}, ref ${ref}`;
    },
  },
  confirm: {
    roles: ['homeowner'],
    from: ['completed'],
    to: 'closed',
    async run(t, b, body) {
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Give a rating from 1 to 5 stars');
      const review = str(body.review, 'Review', { required: false, max: 1000 });
      await t.run('UPDATE bookings SET rating = ?, review = ? WHERE id = ?', rating, review, b.id);
      await t.run(
        'UPDATE providers SET rating_avg = (rating_avg * rating_count + ?) / (rating_count + 1), rating_count = rating_count + 1 WHERE user_id = ?',
        rating, b.provider_id
      );
      return `Rated ${rating}/5${review ? `: ${review}` : ''}`;
    },
  },
  dispute: {
    roles: ['homeowner'],
    from: ['completed'],
    to: 'disputed',
    run: async (t, b, body) => str(body.note, 'Description of the problem', { max: 1000 }),
  },

  // Partner
  accept: {
    roles: ['provider'],
    from: ['offered'],
    to: 'accepted',
    async run(t, b, body, user) {
      if ((await getProvider(user.id, t)).status !== 'active') fail(403, 'Your partner account is not active');
    },
  },
  decline: {
    roles: ['provider'],
    from: ['offered'],
    to: 'confirmed',
    async run(t, b, body) {
      await t.run('UPDATE bookings SET provider_id = NULL WHERE id = ?', b.id);
      return str(body.note, 'Reason', { required: false, max: 500 }) || 'Partner declined';
    },
  },
  en_route: { roles: ['provider'], from: ['accepted'], to: 'en_route' },
  start: { roles: ['provider'], from: ['accepted', 'en_route'], to: 'in_progress' },
  complete: {
    roles: ['provider'],
    from: ['in_progress'],
    to: 'completed',
    async run(t, b, body) {
      const note = str(body.note, 'Completion note', { required: false, max: 1000 });
      await t.run('UPDATE bookings SET completion_note = ? WHERE id = ?', note, b.id);
      if (b.payment_method === 'cash' && body.cash_collected === true) {
        await t.run("UPDATE bookings SET payment_status = 'cash_collected' WHERE id = ?", b.id);
        return [note, `Cash collected: $${b.price.toFixed(2)}`].filter(Boolean).join(' · ');
      }
      return note;
    },
  },

  // Operations
  set_quote: {
    roles: ['admin'],
    from: ['quote_requested', 'quoted'],
    to: 'quoted',
    async run(t, b, body) {
      const price = round2(Number(body.price));
      if (!(price > 0)) fail(400, 'Enter the quoted price');
      const note = str(body.note, 'Quote details', { required: false, max: 1000 });
      await t.run('UPDATE bookings SET price = ?, quote_note = ? WHERE id = ?', price, note, b.id);
      return `Quoted $${price.toFixed(2)}${note ? `: ${note}` : ''}`;
    },
  },
  assign: {
    roles: ['admin'],
    from: ['confirmed', 'offered'],
    to: 'offered',
    async run(t, b, body) {
      const providerId = Number(body.provider_id);
      if (!(await eligibleProviders(b, t)).some((p) => p.user_id === providerId)) fail(400, 'That partner cannot take this job');
      return offerTo(t, b, providerId);
    },
  },
  auto_assign: {
    roles: ['admin'],
    from: ['confirmed'],
    to: 'offered',
    async run(t, b) {
      const [best] = await eligibleProviders(b, t);
      if (!best) fail(409, `No available partner offers ${b.category_name} in ${b.zone}`);
      return offerTo(t, b, best.user_id);
    },
  },
  verify_payment: {
    roles: ['admin'],
    from: OPEN_PAYMENT,
    async run(t, b) {
      if (b.payment_status === 'paid' || b.payment_status === 'cash_collected') fail(409, 'Payment is already recorded');
      const status = b.payment_method === 'cash' ? 'cash_collected' : 'paid';
      await t.run('UPDATE bookings SET payment_status = ? WHERE id = ?', status, b.id);
      return status === 'paid' ? `Payment verified (${b.payment_ref || 'no reference'})` : 'Cash collection confirmed';
    },
  },
  close: {
    roles: ['admin'],
    from: ['completed', 'disputed'],
    to: 'closed',
    run: async (t, b, body) => str(body.note, 'Note', { required: false, max: 1000 }),
  },
  refund: {
    roles: ['admin'],
    from: ['disputed'],
    to: 'refunded',
    async run(t, b, body) {
      await t.run("UPDATE bookings SET payment_status = 'refunded' WHERE id = ?", b.id);
      return str(body.note, 'Refund note', { max: 1000 });
    },
  },
};

app.post('/api/bookings/:id/actions/:action', requireRole(), async (req, res) => {
  const def = Object.hasOwn(ACTIONS, req.params.action) ? ACTIONS[req.params.action] : fail(404, 'Unknown action');
  if (!def.roles.includes(req.user.role)) fail(403, 'You are not allowed to do that');
  const id = Number(req.params.id);

  await db.tx(async (t) => {
    // Re-read inside the transaction so two people acting at once can't both succeed.
    const b = await loadBooking(id, t);
    if (!b || !canSee(b, req.user)) fail(404, 'Booking not found');
    if (def.from && !def.from.includes(b.status)) fail(409, `That can't be done while the booking is "${b.status.replace('_', ' ')}"`);
    const note = def.run ? await def.run(t, b, req.body || {}, req.user) : null;
    const status = def.to || b.status;
    const { changes } = await t.run('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ? AND status = ?', status, now(), b.id, b.status);
    if (!changes) fail(409, 'This booking was just updated by someone else. Please refresh.');
    await logEvent(t, b.id, req.user.id, req.params.action, status, note || null);
  });
  res.json(present(await loadBooking(id), req.user));
});

// ---- Partner earnings ------------------------------------------------------

const SETTLEABLE = `b.status = 'closed' AND b.payout_id IS NULL AND b.payment_status IN ('paid', 'cash_collected')`;

app.get('/api/provider/earnings', requireRole('provider'), async (req, res) => {
  const jobs = (await db.all(`${BOOKING_SELECT} WHERE b.provider_id = ? AND b.status = 'closed' ORDER BY b.updated_at DESC`, req.user.id))
    .map((b) => ({ ...present(b, req.user), settlement: settlementAmount(b) }));
  const unsettled = jobs.filter((j) => !j.payout_id && ['paid', 'cash_collected'].includes(j.payment_status));
  res.json({
    balance: round2(unsettled.reduce((sum, j) => sum + j.settlement, 0)),
    awaitingPayment: jobs.filter((j) => j.payment_status === 'unpaid' || j.payment_status === 'pending_verification').length,
    jobs,
    payouts: await db.all('SELECT * FROM payouts WHERE provider_id = ? ORDER BY id DESC', req.user.id),
  });
});

// ---- Operations admin ------------------------------------------------------

app.get('/api/admin/stats', requireRole('admin'), async (_req, res) => {
  const byStatus = Object.fromEntries(
    (await db.all('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status')).map((r) => [r.status, r.n])
  );
  const money = await db.get(
    `SELECT COALESCE(SUM(price), 0) AS revenue, COALESCE(SUM(price * commission_rate), 0) AS commission
     FROM bookings WHERE status = 'closed' AND payment_status IN ('paid', 'cash_collected')`
  );
  const providers = Object.fromEntries(
    (await db.all('SELECT status, COUNT(*) AS n FROM providers GROUP BY status')).map((r) => [r.status, r.n])
  );
  res.json({
    byStatus,
    revenue: round2(money.revenue),
    commission: round2(money.commission),
    providers,
    paymentsToVerify: (await db.get("SELECT COUNT(*) AS n FROM bookings WHERE payment_status = 'pending_verification'")).n,
    homeowners: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'homeowner'")).n,
  });
});

app.get('/api/admin/providers', requireRole('admin'), async (_req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.name, u.phone, u.email, u.created_at,
            (SELECT COUNT(*) FROM bookings b WHERE b.provider_id = u.id AND b.status = 'closed') AS completed_jobs
     FROM users u JOIN providers p ON p.user_id = u.id ORDER BY (p.status = 'pending') DESC, u.name`
  );
  res.json(await Promise.all(rows.map(async (r) => ({ ...r, ...(await getProvider(r.id)) }))));
});

app.post('/api/admin/providers/:id/status', requireRole('admin'), async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'suspended'].includes(status)) fail(400, 'Status must be active or suspended');
  const { changes } = await db.run('UPDATE providers SET status = ? WHERE user_id = ?', status, Number(req.params.id));
  if (!changes) fail(404, 'Partner not found');
  res.json(await getProvider(Number(req.params.id)));
});

app.get('/api/admin/balances', requireRole('admin'), async (_req, res) => {
  const jobs = await db.all(`SELECT b.* FROM bookings b WHERE ${SETTLEABLE}`);
  const balances = new Map();
  for (const j of jobs) {
    const entry = balances.get(j.provider_id) || { provider_id: j.provider_id, jobs: 0, amount: 0 };
    entry.jobs += 1;
    entry.amount = round2(entry.amount + settlementAmount(j));
    balances.set(j.provider_id, entry);
  }
  const result = await Promise.all([...balances.values()].map(async (e) => {
    const u = await getUser(e.provider_id);
    const p = await getProvider(e.provider_id);
    return { ...e, name: u.name, phone: u.phone, business_name: p.business_name, payout_number: p.payout_number };
  }));
  const recent = await db.all('SELECT po.*, u.name FROM payouts po JOIN users u ON u.id = po.provider_id ORDER BY po.id DESC LIMIT 50');
  res.json({ balances: result, recent });
});

app.post('/api/admin/payouts', requireRole('admin'), async (req, res) => {
  const providerId = Number(req.body?.provider_id);
  const reference = str(req.body?.reference, 'Payment reference', { max: 100 });
  const payout = await db.tx(async (t) => {
    const jobs = await t.all(`SELECT b.* FROM bookings b WHERE ${SETTLEABLE} AND b.provider_id = ?`, providerId);
    if (!jobs.length) fail(409, 'Nothing to settle for this partner');
    const amount = round2(jobs.reduce((sum, j) => sum + settlementAmount(j), 0));
    const { id } = await t.run(
      'INSERT INTO payouts (provider_id, amount, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      providerId, amount, reference, req.user.id, now()
    );
    for (const j of jobs) await t.run('UPDATE bookings SET payout_id = ? WHERE id = ?', id, j.id);
    return t.get('SELECT * FROM payouts WHERE id = ?', id);
  });
  res.status(201).json(payout);
});

app.put('/api/admin/services/:id', requireRole('admin'), async (req, res) => {
  const service = await db.get('SELECT * FROM services WHERE id = ?', Number(req.params.id)) || fail(404, 'Service not found');
  const b = req.body || {};
  const commission = Number(b.commission_rate);
  if (!(commission >= 0 && commission <= 1)) fail(400, 'Commission must be between 0% and 100%');
  let options = [];
  if (service.pricing_type !== 'quote') {
    const current = JSON.parse(service.options);
    if (!Array.isArray(b.prices) || b.prices.length !== current.length) fail(400, 'Send one price per option');
    options = current.map((opt, i) => {
      const price = round2(Number(b.prices[i]));
      if (!(price > 0)) fail(400, `Enter a price for "${opt.label}"`);
      return { ...opt, price };
    });
  }
  await db.run('UPDATE services SET options = ?, commission_rate = ?, active = ? WHERE id = ?',
    JSON.stringify(options), commission, b.active ? 1 : 0, service.id);
  res.json({ ...(await db.get('SELECT * FROM services WHERE id = ?', service.id)), options });
});

// ---- Errors ----------------------------------------------------------------

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  if (err.code === '23505' || /UNIQUE constraint/.test(err.message)) {
    return res.status(409).json({ error: 'An account with that phone number or email already exists' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

db.ready
  .then(() => {
    app.listen(config.PORT, () => console.log(`${config.COMPANY_NAME} running at http://localhost:${config.PORT}`));
  })
  .catch((err) => {
    console.error('Could not start: database setup failed.', err);
    process.exit(1);
  });
