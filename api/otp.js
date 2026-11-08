// SHURWAT SMM - OTP standalone (no Express, no Firebase)
// Vercel is file ko /api/otp/send aur /api/otp/verify dono par chalata hai.
// OTP server memory me rehta hai - Firebase folder ki zaroorat nahi.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }

// Global - ek hi warm container me send + verify dono ko milega
if (!global.__shurwatOtp) global.__shurwatOtp = new Map();
const store = global.__shurwatOtp;

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch(e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = String(req.url || '');
  const isVerify = url.includes('/verify');
  const isSend = url.includes('/send') || !isVerify;

  try {
    const body = await readBody(req);

    // ---------- VERIFY ----------
    if (isVerify) {
      const em = String(body.email || '').toLowerCase().trim();
      const c = String(body.code || body.otp || '').trim();
      if (!em || !c) return res.status(400).json({ error: 'Enter OTP code' });
      const v = store.get(em);
      if (!v || !v.code) return res.status(400).json({ error: 'No OTP found. Tap Send OTP first.' });
      if (Date.now() > (v.expiresAt || 0)) { store.delete(em); return res.status(400).json({ error: 'OTP expired. Tap Send OTP again.' }); }
      if ((v.attempts || 0) >= 5) { store.delete(em); return res.status(400).json({ error: 'Too many wrong tries. Tap Send OTP again.' }); }
      if (String(v.code) !== c) { v.attempts = (v.attempts || 0) + 1; return res.status(400).json({ error: 'Wrong OTP. Try again.' }); }
      v.verified = true; v.verifiedAt = Date.now();
      return res.status(200).json({ ok: true, msg: 'OTP verified' });
    }

    // ---------- SEND ----------
    const em = String(body.email || '').toLowerCase().trim();
    const name = String(body.name || '');
    if (!em || !em.includes('@')) return res.status(400).json({ error: 'Enter a valid Gmail Address' });

    const user = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    if (!user || !pass) return res.status(500).json({ error: 'OTP service not set up. Vercel me GMAIL_USER + GMAIL_APP_PASSWORD nahi hain.' });
    if (!nodemailer) return res.status(500).json({ error: 'OTP service not set up. nodemailer missing - Redeploy karo.' });

    const prev = store.get(em);
    if (prev && prev.sentAt && (Date.now() - prev.sentAt < 60 * 1000)) return res.status(429).json({ error: 'OTP already sent. Wait 60 seconds and try again.' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    store.set(em, { email: em, code, name, sentAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, verified: false });

    const mailer = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true, auth: { user, pass } });
    try {
      await mailer.sendMail({
        from: '"SHURWAT SMM" <' + user + '>',
        to: em,
        subject: 'Your SHURWAT SMM OTP - ' + code,
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#fff;border-radius:16px;text-align:center"><h1>SHURWAT SMM</h1><p>Your OTP for Sign Up</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#fff;color:#111;padding:16px;border-radius:12px">' + code + '</div><p style="color:#94a3b8;font-size:13px">This code expires in 5 minutes. Never share it with anyone.</p></div>',
        text: 'Your SHURWAT SMM OTP is: ' + code + ' (expires in 5 minutes)'
      });
    } catch (e) {
      store.delete(em);
      console.log('GMAIL SEND FAIL:', e.message);
      if (e.message && (e.message.includes('Invalid login') || e.message.includes('not accepted') || e.message.includes('535'))) return res.status(500).json({ error: 'Gmail login failed. App Password naya banao, gap mat do.' });
      return res.status(500).json({ error: 'Gmail se connect nahi ho raha: ' + String(e.message || '').slice(0, 140) });
    }
    return res.status(200).json({ ok: true, msg: 'OTP sent to your Gmail' });
  } catch (e) {
    console.log('otp error', e.message);
    return res.status(500).json({ error: 'Could not send OTP. Try again.' });
  }
};
