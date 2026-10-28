// Business settings. Override any of these with environment variables in production.
const production = process.env.NODE_ENV === 'production';
if (production) {
  const missing = ['APP_SECRET', 'ADMIN_PASSWORD', 'DATABASE_URL'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required environment variables for production: ${missing.join(', ')}`);
}

module.exports = {
  COMPANY_NAME: process.env.COMPANY_NAME || 'HomeCare Connect',
  CURRENCY: 'USD',
  PORT: Number(process.env.PORT) || 3000,

  // Service zones a property can be in and a partner can cover.
  ZONES: [
    'Harare – Northern Suburbs',
    'Harare – Eastern Suburbs',
    'Harare – Western Suburbs',
    'Harare – Southern Suburbs',
    'Harare – CBD & Avenues',
    'Chitungwiza',
    'Ruwa',
    'Norton',
    'Bulawayo',
    'Gweru',
    'Mutare',
    'Masvingo',
    'Kwekwe',
    'Victoria Falls',
  ],

  PAYMENT_METHODS: {
    ecocash: 'EcoCash',
    onemoney: 'OneMoney',
    innbucks: 'InnBucks',
    bank: 'Bank transfer / ZIPIT',
    cash: 'Cash on completion',
  },

  // Shown to homeowners when they pay. Replace with the company's real merchant/bank details.
  PAYMENT_INSTRUCTIONS:
    process.env.PAYMENT_INSTRUCTIONS ||
    'EcoCash merchant code: 000000 · OneMoney: 000000 · InnBucks: 000000 · Bank: <Bank name>, Acc <number>, Branch <branch>. Use your booking number as the reference.',

  // Customer support line, shown as call / WhatsApp buttons in the app.
  SUPPORT_PHONE: process.env.SUPPORT_PHONE || '+263700000000',

  // First operations admin, created when the database is empty. Change the password after first login.
  ADMIN_EMAIL: (process.env.ADMIN_EMAIL || 'admin@homecare.local').toLowerCase(),
  ADMIN_PHONE: process.env.ADMIN_PHONE || '+263700000000',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',

  // Seed demo homeowner/partner accounts on first run. Always off in production.
  SEED_DEMO: !production && process.env.SEED_DEMO !== 'false',
};
