// Database layer. Uses PostgreSQL when DATABASE_URL is set (production), otherwise a local
// SQLite file (development). Both expose the same async API:
//   db.get(sql, ...params)  -> first row or undefined
//   db.all(sql, ...params)  -> rows
//   db.run(sql, ...params)  -> { changes, id }   (id comes from "RETURNING id")
//   db.tx(async (t) => ...) -> runs the callback in a transaction; t has the same API
// SQL is written with "?" placeholders and in the subset both databases understand.
const path = require('path');
const config = require('./config');
const { hashPassword } = require('./auth');

const usePg = !!process.env.DATABASE_URL;
const ID = usePg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            ${ID},
  role          TEXT NOT NULL CHECK (role IN ('homeowner', 'provider', 'admin')),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id            ${ID},
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  label         TEXT NOT NULL,
  address       TEXT NOT NULL,
  suburb        TEXT NOT NULL,
  zone          TEXT NOT NULL,
  property_type TEXT NOT NULL,
  notes         TEXT,
  maps_link     TEXT
);

-- Partners. Status: pending (applied) -> active (approved) -> suspended.
CREATE TABLE IF NOT EXISTS providers (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  business_name  TEXT,
  provider_type  TEXT NOT NULL CHECK (provider_type IN ('individual', 'team')),
  team_size      INTEGER NOT NULL DEFAULT 1,
  national_id    TEXT NOT NULL,
  payout_number  TEXT NOT NULL,
  zones          TEXT NOT NULL,          -- JSON array of zone names
  bio            TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  available      INTEGER NOT NULL DEFAULT 1,  -- partner's own "taking new jobs" switch
  rating_avg     DOUBLE PRECISION NOT NULL DEFAULT 0,
  rating_count   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  sort_order             INTEGER NOT NULL,
  certification_required TEXT,          -- what partners must hold for this category, if anything
  details_hint           TEXT
);

CREATE TABLE IF NOT EXISTS provider_skills (
  provider_id   INTEGER NOT NULL REFERENCES providers(user_id),
  category_id   TEXT NOT NULL REFERENCES categories(id),
  certification TEXT,
  PRIMARY KEY (provider_id, category_id)
);

-- pricing_type: fixed (pick an option), unit (option price x quantity),
-- quote (site survey, admin sets price), placement (maid placement fee).
CREATE TABLE IF NOT EXISTS services (
  id              ${ID},
  category_id     TEXT NOT NULL REFERENCES categories(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  pricing_type    TEXT NOT NULL CHECK (pricing_type IN ('fixed', 'unit', 'quote', 'placement')),
  unit_label      TEXT,
  options         TEXT NOT NULL DEFAULT '[]',   -- JSON [{label, price}]
  commission_rate DOUBLE PRECISION NOT NULL,    -- company's share of the job price, 0..1
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payouts (
  id          ${ID},
  provider_id INTEGER NOT NULL REFERENCES providers(user_id),
  amount      DOUBLE PRECISION NOT NULL,        -- positive: company paid partner; negative: partner paid company
  reference   TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id              ${ID},
  homeowner_id    INTEGER NOT NULL REFERENCES users(id),
  property_id     INTEGER NOT NULL REFERENCES properties(id),
  service_id      INTEGER NOT NULL REFERENCES services(id),
  option_label    TEXT,
  quantity        INTEGER NOT NULL DEFAULT 1,
  details         TEXT,
  scheduled_for   TEXT NOT NULL,
  status          TEXT NOT NULL,
  price           DOUBLE PRECISION,             -- null until quoted
  commission_rate DOUBLE PRECISION NOT NULL,    -- copied from the service at booking time
  quote_note      TEXT,
  provider_id     INTEGER REFERENCES providers(user_id),
  payment_method  TEXT NOT NULL,
  payment_status  TEXT NOT NULL DEFAULT 'unpaid'
                  CHECK (payment_status IN ('unpaid', 'pending_verification', 'paid', 'cash_collected', 'refunded')),
  payment_ref     TEXT,
  completion_note TEXT,
  rating          INTEGER,
  review          TEXT,
  payout_id       INTEGER REFERENCES payouts(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS bookings_provider ON bookings(provider_id);
CREATE INDEX IF NOT EXISTS bookings_homeowner ON bookings(homeowner_id);

CREATE TABLE IF NOT EXISTS booking_events (
  id         ${ID},
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  actor_id   INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  status     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_events_booking ON booking_events(booking_id);
`;

// ---- Drivers ---------------------------------------------------------------

function pgDriver(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) is bigint; return a JS number
  const ssl = /\.render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: url, ssl, max: 10 });
  // Optional DB_SCHEMA keeps this app's tables in their own schema, so it can share a
  // database with another app without the tables mixing.
  const schema = process.env.DB_SCHEMA;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be lowercase letters, digits or _');
  if (schema) pool.on('connect', (client) => client.query(`SET search_path TO ${schema}`));
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + ++i);
  };
  const wrap = (runner) => ({
    all: async (sql, ...p) => (await runner.query(toPg(sql), p)).rows,
    get: async (sql, ...p) => (await runner.query(toPg(sql), p)).rows[0],
    run: async (sql, ...p) => {
      const r = await runner.query(toPg(sql), p);
      return { changes: r.rowCount, id: r.rows[0]?.id };
    },
    exec: async (sql) => { await runner.query(sql); },
  });
  const db = wrap(pool);
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  db.prepareSchema = async () => {
    if (schema) await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  };
  db.migrate = async () => {
    await db.exec('ALTER TABLE providers ADD COLUMN IF NOT EXISTS available INTEGER NOT NULL DEFAULT 1');
    await db.exec('ALTER TABLE properties ADD COLUMN IF NOT EXISTS maps_link TEXT');
  };
  db.kind = schema ? `PostgreSQL (schema ${schema})` : 'PostgreSQL';
  return db;
}

function sqliteDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const db = {
    all: async (sql, ...p) => raw.prepare(sql).all(...p),
    get: async (sql, ...p) => raw.prepare(sql).get(...p),
    run: async (sql, ...p) => {
      if (/\bRETURNING\b/i.test(sql)) return { changes: 1, id: raw.prepare(sql).get(...p)?.id };
      const r = raw.prepare(sql).run(...p);
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    exec: async (sql) => raw.exec(sql),
  };
  // One connection, so transactions run one at a time.
  let queue = Promise.resolve();
  db.tx = (fn) => {
    const result = queue.then(async () => {
      raw.exec('BEGIN');
      try {
        const value = await fn(db);
        raw.exec('COMMIT');
        return value;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  db.migrate = async () => {
    const cols = raw.prepare('PRAGMA table_info(providers)').all();
    if (!cols.some((c) => c.name === 'available')) raw.exec('ALTER TABLE providers ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
    const pcols = raw.prepare('PRAGMA table_info(properties)').all();
    if (!pcols.some((c) => c.name === 'maps_link')) raw.exec('ALTER TABLE properties ADD COLUMN maps_link TEXT');
  };
  db.kind = 'SQLite';
  return db;
}

const db = usePg
  ? pgDriver(process.env.DATABASE_URL)
  : sqliteDriver(process.env.DB_PATH || path.join(__dirname, 'data.db'));

// ---- Seed data -----------------------------------------------------------

const CATEGORIES = [
  ['lawn', 'Lawn & Grass Cutting', null, 'Anything we should know? e.g. gate code, dogs on the property, where to put cuttings.'],
  ['yard', 'Yard Cleaning', null, 'What needs clearing? e.g. leaves, building rubble, old furniture.'],
  ['trees', 'Tree Cutting', 'Public liability insurance and chainsaw/climbing safety training', 'How many trees, roughly how tall, and are they near power lines, walls or the house?'],
  ['fumigation', 'Fumigation & Pest Control', 'Pesticide applicator registration / EMA licence for hazardous substances', 'Which pests, where in the house, and are there children, pets or anyone with asthma?'],
  ['cleaning', 'Home, Carpet & Sofa Cleaning', null, 'Fabric type, stains, pets, or areas to focus on.'],
  ['construction', 'Post-Construction Cleaning', null, 'New build or renovation? Rough size (rooms or m²), is there water and power on site, has the builder removed the rubble, and when is handover or move-in?'],
  ['property', 'Property & Rental Agents', 'Registered estate agent (Estate Agents Council of Zimbabwe) or agent working under a registered agency', 'Rent or buy, suburbs you like, monthly budget or price range, bedrooms, move-in date, and anything else that matters (pets, parking, borehole, solar, security).'],
  ['cctv', 'CCTV Installation', 'CCTV / electrical installation certificate', 'How many cameras, indoor or outdoor, and do you want phone viewing?'],
  ['maids', 'House Maids & Domestic Help', 'Police clearance, medical certificate and two references', 'Duties (cleaning, cooking, laundry, childcare), live-in or live-out, number of children, preferred start date, salary budget, languages.'],
];

// [category, name, description, pricing_type, unit_label, options, commission_rate]
const o = (...pairs) => pairs.map(([label, price]) => ({ label, price }));
const SERVICES = [
  ['lawn', 'Grass cutting', 'Mowing, edging and clearing of cuttings.', 'fixed', null,
    o(['Small yard (up to 300 m²)', 15], ['Medium yard (300–800 m²)', 25], ['Large yard (800 m² – 1 acre)', 40]), 0.2],
  ['lawn', 'Hedge & shrub trimming', 'Shaping hedges and shrubs, cuttings removed.', 'fixed', null,
    o(['A few shrubs', 10], ['Medium hedge', 20], ['Long boundary hedge', 35]), 0.2],
  ['yard', 'Yard clean-up', 'Sweeping, leaf and debris clearing, weeding of paved areas.', 'fixed', null,
    o(['Small yard', 20], ['Medium yard', 35], ['Large yard', 55]), 0.2],
  ['yard', 'Rubbish & garden refuse removal', 'Loading and legal disposal of garden refuse and rubble.', 'unit', 'truckload',
    o(['Per truckload', 30]), 0.2],
  ['trees', 'Tree pruning', 'Cutting back overgrown branches safely.', 'quote', null, [], 0.2],
  ['trees', 'Tree felling & removal', 'Felling, cutting up and removing the tree.', 'quote', null, [], 0.2],
  ['trees', 'Stump removal', 'Grinding or digging out stumps.', 'quote', null, [], 0.2],
  ['fumigation', 'General pest control', 'Cockroaches, ants, fleas, spiders and other crawling insects.', 'fixed', null,
    o(['Flat / 1–2 rooms', 25], ['3–4 bedroom house', 45], ['5+ bedroom house', 70]), 0.2],
  ['fumigation', 'Bedbug treatment', 'Two-visit treatment of beds, furniture and cracks.', 'fixed', null,
    o(['1–2 rooms', 30], ['3–4 bedrooms', 55], ['5+ bedrooms', 80]), 0.2],
  ['fumigation', 'Rodent control', 'Rats and mice: baiting, trapping and entry-point sealing.', 'fixed', null,
    o(['Standard home', 35], ['Large property', 60]), 0.2],
  ['fumigation', 'Mosquito & fly fogging', 'Outdoor fogging of the yard and breeding areas.', 'fixed', null,
    o(['Standard yard', 25], ['Large property', 45]), 0.2],
  ['fumigation', 'Disinfection & sanitisation', 'Whole-home disinfection of surfaces.', 'fixed', null,
    o(['Flat / small house', 35], ['Large house', 60]), 0.2],
  ['fumigation', 'Termite treatment', 'Inspection and soil/wood treatment against termites.', 'quote', null, [], 0.2],
  ['fumigation', 'Commercial fumigation', 'Offices, shops, warehouses and lodges.', 'quote', null, [], 0.2],
  ['cleaning', 'Home deep cleaning', 'Top-to-bottom clean: kitchen, bathrooms, floors, windows inside.', 'fixed', null,
    o(['1–2 bedrooms', 40], ['3 bedrooms', 60], ['4+ bedrooms', 85]), 0.2],
  ['cleaning', 'Move-in / move-out cleaning', 'Empty-house clean including cupboards and appliances.', 'fixed', null,
    o(['1–2 bedrooms', 55], ['3 bedrooms', 80], ['4+ bedrooms', 110]), 0.2],
  ['cleaning', 'Carpet & rug cleaning', 'Shampoo and extraction cleaning, stain treatment.', 'unit', 'carpet',
    o(['Small rug', 10], ['Medium carpet', 18], ['Large / wall-to-wall room', 30]), 0.2],
  ['cleaning', 'Sofa cleaning', 'Deep clean of fabric or leather seating.', 'unit', 'seat',
    o(['Fabric seat', 8], ['Leather seat (clean & condition)', 10]), 0.2],
  ['cleaning', 'Mattress cleaning', 'Deep clean and sanitise mattresses.', 'unit', 'mattress',
    o(['Single', 12], ['Double / Queen / King', 18]), 0.2],
  ['construction', 'Post-construction clean (new house)', "Full builders' clean before you move in: dust, cement and paint splashes removed from floors, tiles, windows, frames, cupboards and fittings.", 'fixed', null,
    o(['1–2 bedrooms', 90], ['3 bedrooms', 130], ['4 bedrooms', 180], ['5+ bedrooms', 240]), 0.2],
  ['construction', 'Post-renovation clean', 'After painting, tiling, a new kitchen or bathroom, or an extension. Only the rooms that were worked on.', 'unit', 'room',
    o(['Bedroom, lounge or passage', 20], ['Kitchen or bathroom', 30]), 0.2],
  ['construction', "Builders' rubble removal", 'Loading and legal disposal of bricks, broken tiles, cement bags, off-cuts and packaging.', 'unit', 'truckload',
    o(['Per truckload', 40]), 0.2],
  ['construction', 'Floor & tile restoration', 'Cement haze, grout and paint removed from tiles and floors, then machine scrubbed and polished.', 'quote', null, [], 0.2],
  ['construction', 'Commercial & large-site handover clean', 'Offices, shops, lodges, blocks of flats and large homes. Cleaned to handover standard for the contractor or owner.', 'quote', null, [], 0.2],
  ['property', 'Find me a rental', 'Tell us your budget, area and needs. An agent shortlists suitable homes and arranges the viewings. Their fee is quoted once, before they start.', 'quote', null, [], 0.2],
  ['property', 'Property viewing with an agent', 'An agent meets you at a listed property, shows you around and answers questions on the lease, deposit and neighbourhood.', 'unit', 'viewing',
    o(['One viewing', 10]), 0.3],
  ['property', 'List my property to let or sell', 'An agent photographs, advertises and shows your property, then screens enquiries. Their fee is quoted before they start.', 'quote', null, [], 0.2],
  ['property', 'Tenant screening & lease signing', 'ID and reference checks on a tenant, a written lease, a condition inventory and deposit handling.', 'fixed', null,
    o(['Screening, lease and inventory', 35]), 0.3],
  ['property', 'Rental management', 'Monthly rent collection, tenant queries and repairs handled for landlords and diaspora owners. Fee quoted on the rent.', 'quote', null, [], 0.15],
  ['cctv', 'CCTV installation', 'New camera system: survey, supply, install, phone viewing setup.', 'quote', null, [], 0.15],
  ['cctv', 'CCTV repair & maintenance', 'Fault finding, cleaning, re-alignment, DVR/NVR checks.', 'fixed', null,
    o(['Call-out & diagnosis', 20]), 0.2],
  ['maids', 'Day maid (one-off help)', 'A vetted maid for a single day of cleaning, laundry or ironing.', 'unit', 'day',
    o(['Full day (8 hours)', 15], ['Half day (4 hours)', 9]), 0.25],
  ['maids', 'Part-time maid placement', 'We match you with a vetted maid for set days each week. Salary agreed and paid separately.', 'placement', null,
    o(['Placement fee (3-month replacement guarantee)', 30]), 1],
  ['maids', 'Live-in maid placement', 'Full-time live-in maid, vetted and trialled. Salary agreed and paid separately.', 'placement', null,
    o(['Placement fee (3-month replacement guarantee)', 50]), 1],
  ['maids', 'Nanny / housekeeper placement', 'Experienced nanny or housekeeper for families. Salary agreed and paid separately.', 'placement', null,
    o(['Placement fee (3-month replacement guarantee)', 60]), 1],
];

// Adds any category or service from the lists above that the database doesn't have yet, so new
// services reach databases that were seeded by an older version. Existing rows (and the prices,
// commission and live/hidden switch that operations edited) are never changed.
async function syncCatalog(t) {
  const have = new Set((await t.all('SELECT id FROM categories')).map((c) => c.id));
  for (const [i, [id, name, cert, hint]] of CATEGORIES.entries()) {
    if (have.has(id)) await t.run('UPDATE categories SET sort_order = ? WHERE id = ?', i, id);
    else await t.run('INSERT INTO categories (id, name, sort_order, certification_required, details_hint) VALUES (?, ?, ?, ?, ?)', id, name, i, cert, hint);
  }
  const services = new Set((await t.all('SELECT category_id, name FROM services')).map((s) => `${s.category_id}|${s.name}`));
  let added = 0;
  for (const [cat, name, desc, type, unit, options, commission] of SERVICES) {
    if (services.has(`${cat}|${name}`)) continue;
    await t.run(
      'INSERT INTO services (category_id, name, description, pricing_type, unit_label, options, commission_rate) VALUES (?, ?, ?, ?, ?, ?, ?)',
      cat, name, desc, type, unit, JSON.stringify(options), commission
    );
    added += 1;
  }
  return added;
}

async function seed() {
  const now = new Date().toISOString();
  let firstRun = false;
  let added = 0;

  await db.tx(async (t) => {
    added = await syncCatalog(t);
    if ((await t.get('SELECT COUNT(*) AS n FROM users')).n > 0) return;
    firstRun = true;

    const addUser = (role, name, phone, email, password) => t.run(
      'INSERT INTO users (role, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      role, name, phone, email, hashPassword(password), now
    );
    await addUser('admin', 'Operations Admin', config.ADMIN_PHONE, config.ADMIN_EMAIL, config.ADMIN_PASSWORD);

    if (config.SEED_DEMO) {
      const home = await addUser('homeowner', 'Demo Homeowner', '+263771000001', 'home@demo.local', 'demo123');
      await t.run('INSERT INTO properties (owner_id, label, address, suburb, zone, property_type) VALUES (?, ?, ?, ?, ?, ?)',
        home.id, 'Home', '12 Example Road', 'Borrowdale', 'Harare – Northern Suburbs', 'House');

      const partner = await addUser('provider', 'Demo Partner', '+263772000002', 'partner@demo.local', 'demo123');
      await t.run(
        `INSERT INTO providers (user_id, business_name, provider_type, team_size, national_id, payout_number, zones, status, created_at)
         VALUES (?, ?, 'team', 3, '00-000000-X-00', '+263772000002', ?, 'active', ?)`,
        partner.id, 'Demo Garden & Clean Team', JSON.stringify(['Harare – Northern Suburbs', 'Harare – Eastern Suburbs']), now
      );
      for (const cat of ['lawn', 'yard', 'cleaning', 'construction']) {
        await t.run('INSERT INTO provider_skills (provider_id, category_id) VALUES (?, ?)', partner.id, cat);
      }
    }
  });

  if (!firstRun) {
    if (added) console.log(`Catalogue updated: ${added} new service${added > 1 ? 's' : ''} added.`);
    return;
  }
  console.log(`Seeded database. Admin login: ${config.ADMIN_EMAIL}${process.env.ADMIN_PASSWORD ? '' : ' / admin123 (change this before going live)'}`);
  if (config.SEED_DEMO) console.log('Demo logins: home@demo.local / demo123 (homeowner), partner@demo.local / demo123 (partner).');
}

db.ready = (async () => {
  await db.prepareSchema?.();
  await db.exec(SCHEMA);
  await db.migrate();
  await seed();
  console.log(`Database: ${db.kind}`);
})();

module.exports = { db };
