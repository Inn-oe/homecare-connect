// WhatsApp chatbot over the Meta WhatsApp Cloud API.
//
// Customers can browse services and prices, book a service, check their bookings and ask for a person.
// Everything is plain numbered menus, so it works on every phone and needs no approved templates
// (the bot only ever replies inside the 24-hour window the customer opened).
//
// Environment variables (all optional; without them the bot still runs in the admin test console):
//   WA_ACCESS_TOKEN      permanent token of a Meta system user with whatsapp_business_messaging
//   WA_PHONE_NUMBER_ID   the Cloud API phone number ID (not the phone number itself)
//   WA_VERIFY_TOKEN      any string; type the same one into Meta's webhook settings
//   WA_APP_SECRET        the Meta app secret, used to check that webhook calls really come from Meta
//   WA_OPS_NUMBER        a WhatsApp number to alert when a customer asks for a person or books
//   WA_GRAPH_VERSION     Graph API version (default v21.0)

const crypto = require('crypto');

const ENV = {
  token: process.env.WA_ACCESS_TOKEN,
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  verifyToken: process.env.WA_VERIFY_TOKEN,
  appSecret: process.env.WA_APP_SECRET,
  opsNumber: process.env.WA_OPS_NUMBER,
  graphVersion: process.env.WA_GRAPH_VERSION || 'v21.0',
};

const TZ = 'Africa/Harare';
const SESSION_IDLE_MS = 30 * 60 * 1000; // a half-finished booking is forgotten after 30 minutes
const HANDOVER_MS = 12 * 60 * 60 * 1000; // the bot stays quiet this long after a customer asks for a person
const TIMES = [['Morning, 8am', '08:00'], ['Late morning, 10am', '10:00'], ['Early afternoon, 1pm', '13:00'], ['Afternoon, 3pm', '15:00']];
const STATUS_TEXT = {
  quote_requested: 'Waiting for a quote',
  quoted: 'Quote ready. Open the app to accept it',
  confirmed: 'Finding a partner',
  offered: 'A partner is reviewing it',
  accepted: 'Partner assigned',
  en_route: 'Partner on the way',
  in_progress: 'In progress',
  completed: 'Done. Please confirm in the app',
  closed: 'Completed',
  disputed: 'Problem reported. Our team is looking into it',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

const money = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;
const numbered = (items) => items.map((t, i) => `${i + 1}. ${t}`).join('\n');
const pick = (text, list) => {
  const n = parseInt(String(text).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= list.length && String(n) === String(text).trim() ? list[n - 1] : null;
};

// Today's date in Zimbabwe plus `offset` days, as YYYY-MM-DD.
function harareDay(offset = 0) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const atHarare = (day, time) => new Date(`${day}T${time}:00+02:00`);
const dayName = (day, offset) =>
  offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow'
    : new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
const whenText = (iso) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function priceText(s) {
  if (s.pricing_type === 'quote') return 'priced after a free quote';
  const prices = s.options.map((o) => o.price);
  const from = Math.min(...prices);
  const unit = s.pricing_type === 'unit' ? ` per ${s.unit_label}` : s.pricing_type === 'placement' ? ' placement fee' : '';
  return (prices.length > 1 ? 'from ' : '') + money(from) + unit;
}

function createBot(deps) {
  const { db, config, catalog, createBooking, loadBooking, hashPassword, now } = deps;
  const sessions = new Map();
  const company = () => config.COMPANY_NAME;

  // WhatsApp sends numbers as 263772123456. Zimbabwe mobiles are stored the same way as the web app
  // stores them (+263772...); other countries (diaspora customers) are kept as +<digits>.
  function phoneOf(from) {
    try { return deps.normalizePhone(from); } catch { return '+' + String(from).replace(/\D/g, ''); }
  }

  const findUser = (phone) => db.get('SELECT id, role, name, phone FROM users WHERE phone = ?', phone);

  const MENU_WORDS = /^(hi|hey|hello|hie|menu|start|home|0|cancel|stop|back|mhoro|makadii|salibonani)[\s!.]*$/i;
  const PERSON_WORDS = /^(4|person|human|agent|help|support|operator|talk to (a )?person)$/i;

  function menu(name) {
    return [
      `Hi${name ? ' ' + name.split(' ')[0] : ''}! Welcome to *${company()}* 🏠\nTrusted home services across Zimbabwe.`,
      'Reply with a number:\n' + numbered([
        'Book a service',
        'Services & prices',
        'Check my bookings',
        'Talk to a person',
      ]) + '\n\nYou can type *menu* at any time to start again.',
    ];
  }

  async function categoryList(s, intro) {
    const cats = (await catalog()).filter((c) => c.services.length);
    s.data.cats = cats.map((c) => c.id);
    s.step = 'category';
    return [`${intro}\n\n${numbered(cats.map((c) => c.name))}\n\nReply with a number, or *0* for the menu.`];
  }

  async function serviceList(s, catId) {
    const cat = (await catalog()).find((c) => c.id === catId);
    s.data.catId = catId;
    s.data.services = cat.services.map((x) => x.id);
    s.step = 'service';
    const lines = cat.services.map((x, i) => `${i + 1}. *${x.name}*, ${priceText(x)}\n    ${x.description}`);
    return [`*${cat.name}*\n\n${lines.join('\n\n')}\n\nReply with a number to book, or *0* for the menu.`];
  }

  async function startService(s, serviceId) {
    const svc = (await catalog()).flatMap((c) => c.services.map((x) => ({ ...x, category: c }))).find((x) => x.id === serviceId);
    s.data.svc = svc;
    s.data.booking = { service_id: svc.id, option_index: 0, quantity: 1 };
    if (svc.pricing_type !== 'quote' && svc.options.length > 1) {
      s.step = 'option';
      return [`*${svc.name}*. Which one do you need?\n\n${numbered(svc.options.map((o) => `${o.label}, ${money(o.price)}`))}`];
    }
    return afterOption(s);
  }

  function afterOption(s) {
    const svc = s.data.svc;
    if (svc.pricing_type === 'unit') {
      s.step = 'qty';
      return [`How many ${svc.unit_label}s? Reply with a number from 1 to 100.`];
    }
    return askName(s);
  }

  async function askName(s) {
    const user = await findUser(s.phone);
    if (user && user.role !== 'homeowner') {
      reset(s);
      return [`This number is registered as a ${user.role === 'provider' ? 'partner' : 'staff'} account, so it can't book as a customer. Please use the app, or type *4* to talk to a person.`];
    }
    if (user) return askProperty(s, user);
    s.step = 'name';
    return [`Let's set you up. What is your *full name*?${s.profileName ? `\n\nReply *1* to use "${s.profileName}".` : ''}`];
  }

  async function askProperty(s, user) {
    s.data.userId = user.id;
    const props = await db.all('SELECT id, label, suburb, zone FROM properties WHERE owner_id = ? ORDER BY id', user.id);
    if (!props.length) return askZone(s);
    s.data.props = props.map((p) => p.id);
    s.step = 'property';
    return [`Where is the job?\n\n${numbered([...props.map((p) => `${p.label} (${p.suburb})`), 'A different address'])}`];
  }

  function askZone(s) {
    s.step = 'zone';
    return [`Which area is the property in?\n\n${numbered(config.ZONES)}`];
  }

  function askDay(s) {
    const svc = s.data.svc;
    s.data.days = [];
    for (let i = 0; i < 8 && s.data.days.length < 7; i++) {
      const day = harareDay(i);
      const open = svc.pricing_type === 'placement' ? i > 0 : TIMES.some(([, t]) => atHarare(day, t).getTime() > Date.now() + 60 * 60 * 1000);
      if (open) s.data.days.push([day, i]);
    }
    s.step = 'day';
    const q = svc.pricing_type === 'quote' ? 'Which day can we visit to quote?' : svc.pricing_type === 'placement' ? 'When should they start?' : 'Which day should we come?';
    return [`${q}\n\n${numbered(s.data.days.map(([d, i]) => dayName(d, i)))}`];
  }

  function askTime(s) {
    if (s.data.svc.pricing_type === 'placement') {
      s.data.booking.scheduled_for = atHarare(s.data.day, '09:00').toISOString();
      return askDetails(s);
    }
    s.data.times = TIMES.filter(([, t]) => atHarare(s.data.day, t).getTime() > Date.now() + 60 * 60 * 1000);
    s.step = 'time';
    return [`What time suits you?\n\n${numbered(s.data.times.map(([label]) => label))}`];
  }

  function askDetails(s) {
    const svc = s.data.svc;
    s.step = 'details';
    const hint = svc.category.details_hint ? `\n\nHelpful to know: ${svc.category.details_hint}` : '';
    const skip = svc.pricing_type === 'placement' ? '' : '\n\nOr reply *skip*.';
    return [`Anything the team should know?${hint}${skip}`];
  }

  function askPayment(s) {
    s.data.methods = Object.keys(config.PAYMENT_METHODS);
    s.step = 'payment';
    return [`How would you like to pay?\n\n${numbered(s.data.methods.map((k) => config.PAYMENT_METHODS[k]))}`];
  }

  function summary(s) {
    const { svc, booking: b } = s.data;
    const opt = svc.pricing_type === 'quote' ? null : svc.options[b.option_index];
    const price = opt ? money(opt.price * b.quantity) : 'Free quote, you approve the price first';
    const where = s.data.newProperty ? `${s.data.newProperty.address}, ${s.data.newProperty.suburb}` : s.data.propertyText;
    s.step = 'confirm';
    return [[
      '*Please check your booking*',
      `Service: ${svc.name}${opt && svc.options.length > 1 ? ` (${opt.label})` : ''}`,
      svc.pricing_type === 'unit' ? `Quantity: ${b.quantity} ${svc.unit_label}${b.quantity > 1 ? 's' : ''}` : null,
      `When: ${whenText(b.scheduled_for)}`,
      `Where: ${where}`,
      `Price: ${price}`,
      `Payment: ${config.PAYMENT_METHODS[b.payment_method]}`,
      b.details ? `Notes: ${b.details}` : null,
      '',
      'Reply *1* to confirm or *2* to cancel.',
    ].filter((l) => l !== null).join('\n')];
  }

  async function submit(s) {
    const d = s.data;
    let tempPassword = null;
    const userId = await db.tx(async (t) => {
      let uid = d.userId;
      if (!uid) {
        tempPassword = String(crypto.randomInt(100000, 1000000));
        ({ id: uid } = await t.run(
          'INSERT INTO users (role, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
          'homeowner', d.name, s.phone, null, hashPassword(tempPassword), now()
        ));
      }
      if (d.newProperty) {
        const p = d.newProperty;
        const { id } = await t.run(
          'INSERT INTO properties (owner_id, label, address, suburb, zone, property_type, notes, maps_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          uid, p.suburb, p.address, p.suburb, p.zone, 'House', 'Added via WhatsApp', null
        );
        d.booking.property_id = id;
      }
      return uid;
    });
    const id = await createBooking(userId, d.booking);
    const b = await loadBooking(id);
    reset(s);

    const next = b.status === 'quote_requested'
      ? 'A specialist will call you to confirm the visit. You only pay once you accept the quote.'
      : d.svc.pricing_type === 'placement'
        ? 'We will call you within 1 working day to discuss your needs and arrange interviews.'
        : "We're matching you with a vetted partner nearby. You'll get their name and number once they accept.";
    const pay = b.price != null && b.payment_method !== 'cash'
      ? `\n\n*How to pay ${money(b.price)}:*\n${config.PAYMENT_INSTRUCTIONS}\nUse *HC${b.id}* as the reference.` : '';
    const replies = [`✅ Booking *#HC${b.id}* received!\n\n${b.service_name}\n${whenText(b.scheduled_for)}\n\n${next}${pay}`];
    if (tempPassword) {
      replies.push(`We've created your ${company()} account so you can follow your booking online too.\n\nPhone: ${s.phone}\nTemporary password: *${tempPassword}*\n\nPlease change it after you log in.`);
    }
    replies.push('Type *3* any time to check your bookings, or *menu* for more.');
    notifyOps(`🆕 WhatsApp booking #HC${b.id}: ${b.service_name} for ${b.homeowner_name} (${s.phone}), ${b.suburb}, ${whenText(b.scheduled_for)}.`);
    return replies;
  }

  async function myBookings(s) {
    reset(s);
    const user = await findUser(s.phone);
    const rows = user
      ? await db.all(
        `SELECT b.id, b.status, b.scheduled_for, b.price, s.name AS service_name, u.name AS provider_name
         FROM bookings b JOIN services s ON s.id = b.service_id LEFT JOIN users u ON u.id = b.provider_id
         WHERE b.homeowner_id = ? ORDER BY b.created_at DESC LIMIT 5`, user.id)
      : [];
    if (!rows.length) return ['We have no bookings for this number yet. Reply *1* to book a service.'];
    const shown = ['accepted', 'en_route', 'in_progress', 'completed', 'closed'];
    const lines = rows.map((b) => [
      `*#HC${b.id}* ${b.service_name}`,
      `${whenText(b.scheduled_for)}${b.price != null ? ` · ${money(b.price)}` : ''}`,
      `Status: ${STATUS_TEXT[b.status] || b.status}${b.provider_name && shown.includes(b.status) ? ` (${b.provider_name})` : ''}`,
    ].join('\n'));
    return [`Your latest bookings:\n\n${lines.join('\n\n')}\n\nReply *4* if you need help with one.`];
  }

  function handover(s, text) {
    reset(s);
    s.handoverUntil = Date.now() + HANDOVER_MS;
    notifyOps(`🙋 ${s.profileName || 'A customer'} (${s.phone}) asked for a person on WhatsApp.${text ? ` Last message: "${text}"` : ''}`);
    return [`Sure. A member of our team will reply here as soon as possible (Mon–Sat, 8am–5pm).\n\nUrgent? Call ${config.SUPPORT_PHONE}.\n\nType *menu* to go back to the bot.`];
  }

  function reset(s) {
    s.step = 'menu';
    s.data = {};
    s.errors = 0;
  }

  // Handles one incoming message and returns the replies to send.
  async function handle(from, text, profileName) {
    const phone = phoneOf(from);
    let s = sessions.get(phone);
    if (!s || Date.now() - s.at > SESSION_IDLE_MS) {
      s = { phone, step: 'start', data: {}, errors: 0, handoverUntil: s?.handoverUntil || 0 };
      sessions.set(phone, s);
    }
    s.at = Date.now();
    if (profileName) s.profileName = profileName;
    text = String(text || '').trim();

    // While a person is handling the chat, the bot only wakes up for "menu".
    if (s.handoverUntil > Date.now()) {
      if (!/^menu$/i.test(text)) return [];
      s.handoverUntil = 0;
    }

    if (s.step === 'start' || MENU_WORDS.test(text)) {
      reset(s);
      const user = await findUser(phone);
      return menu(user?.name || profileName);
    }
    if (s.step === 'menu' && PERSON_WORDS.test(text)) return handover(s, null);
    if (s.step !== 'menu' && /^(person|human|agent|operator|support)$/i.test(text)) return handover(s, null);

    try {
      const replies = await step(s, text);
      if (replies) {
        s.errors = 0;
        return replies;
      }
    } catch (err) {
      if (!err.status) throw err;
      return [`Sorry, ${err.message.charAt(0).toLowerCase() + err.message.slice(1)}. Type *menu* to start again.`];
    }
    // The reply didn't match what we asked for.
    s.errors += 1;
    if (s.errors >= 3) return handover(s, text);
    return ["Sorry, I didn't get that. Please reply with one of the numbers above, or type *menu* to start again."];
  }

  // Returns replies, or null when the text isn't a valid answer for the current step.
  async function step(s, text) {
    const d = s.data;
    switch (s.step) {
      case 'menu': {
        if (text === '1') return categoryList(s, 'What do you need help with?');
        if (text === '2') {
          d.browse = true;
          return categoryList(s, 'Our services. Pick one to see prices:');
        }
        if (text === '3' || /^status|booking/i.test(text)) return myBookings(s);
        return null;
      }
      case 'category': {
        const id = pick(text, d.cats);
        return id ? serviceList(s, id) : null;
      }
      case 'service': {
        const id = pick(text, d.services);
        return id ? startService(s, id) : null;
      }
      case 'option': {
        const n = parseInt(text, 10);
        if (!(n >= 1 && n <= d.svc.options.length) || String(n) !== text) return null;
        d.booking.option_index = n - 1;
        return afterOption(s);
      }
      case 'qty': {
        const n = parseInt(text, 10);
        if (!(n >= 1 && n <= 100) || String(n) !== text) return null;
        d.booking.quantity = n;
        return askName(s);
      }
      case 'name': {
        const name = text === '1' && s.profileName ? s.profileName : text;
        if (name.length < 2 || name.length > 100 || /^\d+$/.test(name)) return null;
        d.name = name;
        return askZone(s);
      }
      case 'property': {
        const n = parseInt(text, 10);
        if (String(n) !== text || n < 1 || n > d.props.length + 1) return null;
        if (n === d.props.length + 1) return askZone(s);
        const p = await db.get('SELECT * FROM properties WHERE id = ?', d.props[n - 1]);
        d.booking.property_id = p.id;
        d.propertyText = `${p.address}, ${p.suburb}`;
        return askDay(s);
      }
      case 'zone': {
        const zone = pick(text, config.ZONES);
        if (!zone) return null;
        d.newProperty = { zone };
        s.step = 'suburb';
        return ['Which *suburb*? (e.g. Borrowdale, Mabelreign, Hillside)'];
      }
      case 'suburb': {
        if (text.length < 2 || text.length > 80) return null;
        d.newProperty.suburb = text;
        s.step = 'address';
        return ['And the *street address*? (house number and street)\n\nTip: you can also send a Google Maps link in the notes later.'];
      }
      case 'address': {
        if (text.length < 3 || text.length > 200) return null;
        d.newProperty.address = text;
        return askDay(s);
      }
      case 'day': {
        const hit = pick(text, d.days);
        if (!hit) return null;
        d.day = hit[0];
        return askTime(s);
      }
      case 'time': {
        const hit = pick(text, d.times);
        if (!hit) return null;
        d.booking.scheduled_for = atHarare(d.day, hit[1]).toISOString();
        return askDetails(s);
      }
      case 'details': {
        const skip = /^(skip|no|none|nothing|n\/a)$/i.test(text);
        if (skip && d.svc.pricing_type === 'placement') return ['Please tell us a little about what you need so we can find the right person.'];
        if (text.length > 2000) return ['That is a bit long. Please keep it under 2000 characters.'];
        d.booking.details = skip ? null : text;
        return askPayment(s);
      }
      case 'payment': {
        const m = pick(text, d.methods);
        if (!m) return null;
        d.booking.payment_method = m;
        return summary(s);
      }
      case 'confirm': {
        if (text === '1' || /^(yes|y|confirm|ok)$/i.test(text)) return submit(s);
        if (text === '2' || /^no$/i.test(text)) {
          reset(s);
          return ['No problem, nothing was booked. Type *menu* when you need us.'];
        }
        return null;
      }
      default:
        return null;
    }
  }

  // ---- Sending ----

  const configured = () => !!(ENV.token && ENV.phoneNumberId);

  async function send(to, body) {
    if (!configured()) {
      console.log(`[whatsapp] (not configured) to ${to}: ${body.slice(0, 120)}`);
      return;
    }
    const res = await fetch(`https://graph.facebook.com/${ENV.graphVersion}/${ENV.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ENV.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'text', text: { body: body.slice(0, 4096), preview_url: false } }),
    });
    if (!res.ok) console.error(`[whatsapp] send to ${to} failed: ${res.status} ${await res.text()}`);
  }

  // Best effort: Meta only delivers free-form messages to the ops number if it messaged the bot in the last 24 hours.
  function notifyOps(text) {
    console.log(`[whatsapp] ${text}`);
    if (ENV.opsNumber) send(ENV.opsNumber, text).catch((e) => console.error('[whatsapp] ops alert failed', e));
  }

  return { handle, send, configured, sessions };
}

function mount(app, deps) {
  const bot = createBot(deps);
  const seen = new Set(); // Meta retries webhooks, so each message id is handled once
  if (!bot.configured()) console.log('WhatsApp bot: not connected (set WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID). Test it from the admin app.');

  // Meta calls this once when you save the webhook URL.
  app.get('/webhook/whatsapp', (req, res) => {
    const ok = ENV.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === ENV.verifyToken;
    if (ok) return res.send(String(req.query['hub.challenge']));
    res.sendStatus(403);
  });

  app.post('/webhook/whatsapp', (req, res) => {
    if (ENV.appSecret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', ENV.appSecret).update(req.rawBody || '').digest('hex');
      const got = req.get('x-hub-signature-256') || '';
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return res.sendStatus(401);
    }
    res.sendStatus(200); // answer Meta straight away; replies are sent separately

    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (seen.size > 5000) seen.delete(seen.values().next().value);
          const text = m.type === 'text' ? m.text.body
            : m.type === 'interactive' ? (m.interactive.button_reply?.id || m.interactive.list_reply?.id)
              : m.type === 'button' ? m.button.text : null;
          (async () => {
            const replies = text == null
              ? ['Thanks! I can only read text messages. Type *menu* to see what I can do, or *4* to talk to a person.']
              : await bot.handle(m.from, text, names[m.from]);
            for (const r of replies) await bot.send(m.from, r);
          })().catch((e) => console.error('[whatsapp] could not handle message', e));
        }
      }
    }
  });

  // Admin test console: chat with the bot from the browser without a WhatsApp number.
  app.get('/api/admin/whatsapp', deps.requireRole('admin'), (_req, res) => {
    res.json({ connected: bot.configured(), webhookPath: '/webhook/whatsapp', verifyTokenSet: !!ENV.verifyToken, signatureCheck: !!ENV.appSecret, opsNumber: ENV.opsNumber || null });
  });
  app.post('/api/admin/whatsapp/simulate', deps.requireRole('admin'), async (req, res) => {
    const { from, text, name } = req.body || {};
    if (!/^\+?\d{9,15}$/.test(String(from || '').replace(/\s/g, ''))) throw new deps.HttpError(400, 'Enter the phone number to chat as');
    const replies = await bot.handle(String(from).replace(/\D/g, ''), String(text || '').slice(0, 2000), name ? String(name).slice(0, 100) : null);
    res.json({ replies });
  });
}

module.exports = { mount, createBot };
