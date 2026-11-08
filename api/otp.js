// SHURWAT SMM - OTP standalone, NO nodemailer, NO Express, NO Firebase
// Gmail: Port 465 SSL - nodemailer ki zaroorat hi nahi, missing ka error aa hi nahi sakta
// Code: 10 minute tak chalega. Full English.
const tls = require('tls');
if (!global.__shurwatOtp) global.__shurwatOtp = new Map();
const store = global.__shurwatOtp;
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendGmail({ user, pass, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com', rejectUnauthorized: true });
    let buf = ''; let stage = 0;
    const timer = setTimeout(() => { try { socket.destroy(); } catch(e){} reject(new Error('Gmail did not respond. Try again.')); }, 20000);
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const send = (s) => { try { socket.write(s + '\r\n'); } catch(e){} };
    const fail = (m) => { clearTimeout(timer); try { socket.destroy(); } catch(e){} reject(new Error(m)); };
    socket.on('error', (e) => { clearTimeout(timer); reject(new Error('Could not connect to Gmail: ' + e.message)); });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n')) return;
      const lines = buf.split('\r\n');
      const lastLine = lines[lines.length - 2] || '';
      if (lastLine.length >= 4 && lastLine[3] === '-') return;
      const code = buf.slice(0, 3); buf = '';
      if (stage === 0) { if (code !== '220') return fail('Gmail did not respond.'); stage = 1; send('EHLO shurwat-smm'); }
      else if (stage === 1) { stage = 2; send('AUTH LOGIN'); }
      else if (stage === 2) { stage = 3; send(b64(user)); }
      else if (stage === 3) { stage = 4; send(b64(pass)); }
      else if (stage === 4) { if (code !== '235') return fail('Gmail login failed. Create a new App Password, no spaces.'); stage = 5; send('MAIL FROM:<' + user + '>'); }
      else if (stage === 5) { if (code !== '250') return fail('MAIL FROM failed.'); stage = 6; send('RCPT TO:<' + to + '>'); }
      else if (stage === 6) { if (code !== '250' && code !== '251') return fail('This Gmail is invalid. Enter a correct Gmail.'); stage = 7; send('DATA'); }
      else if (stage === 7) { if (code !== '354') return fail('DATA failed.'); const headers = 'From: "SHURWAT SMM" <' + user + '>\r\nTo: <' + to + '>\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'; send(headers + html + '\r\n.'); stage = 8; }
      else if (stage === 8) { if (code !== '250') return fail('Failed to send OTP.'); stage = 9; send('QUIT'); clearTimeout(timer); resolve(true); }
    });
  });
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const url = String(req.url || '');
  const hdr = String(req.headers['x-otp-action'] || req.headers['x-path'] || '');
  // Vercel rewrite strips /verify from URL, so also check body.code + header + referer
  const bodyPeek = req.body && typeof req.body === 'object' ? req.body : {};
  const isVerify = url.includes('/verify') || hdr.includes('verify') || !!(bodyPeek.code || bodyPeek.otp);
  try {
    const body = await readBody(req);
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
    const em = String(body.email || '').toLowerCase().trim();
    if (!em || !em.includes('@')) return res.status(400).json({ error: 'Enter a valid Gmail Address' });
    const user = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    if (!user || !pass) return res.status(500).json({ error: 'OTP service not set up. Check GMAIL_USER + GMAIL_APP_PASSWORD in Vercel.' });
    const prev = store.get(em);
    if (prev && prev.sentAt && (Date.now() - prev.sentAt < 60 * 1000)) return res.status(429).json({ error: 'OTP already sent. Wait 60 seconds and try again.' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    store.set(em, { email: em, code, sentAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, verified: false });
    try {
      await sendGmail({ user, pass, to: em, subject: 'Your SHURWAT SMM OTP - ' + code, html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#fff;border-radius:16px;text-align:center"><h1>SHURWAT SMM</h1><p>Your OTP for Sign Up</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#fff;color:#111;padding:16px;border-radius:12px">' + code + '</div><p style="color:#94a3b8;font-size:13px">This code expires in 10 minutes. Never share it with anyone.</p></div>' });
    } catch (e) { store.delete(em); console.log('GMAIL SEND FAIL:', e.message); return res.status(500).json({ error: String(e.message || '').slice(0, 160) }); }
    return res.status(200).json({ ok: true, msg: 'OTP sent to your Gmail' });
  } catch (e) { console.log('otp error', e.message); return res.status(500).json({ error: 'Could not send OTP. Try again.' }); }
};
