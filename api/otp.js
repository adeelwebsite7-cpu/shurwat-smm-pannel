// SHURWAT SMM - OTP standalone, NO nodemailer, NO Express, NO Firebase
// Gmail: Port 465 SSL (seedha TLS) - 587 wale STARTTLS se aasan, timeout nahi aata
// Code: 10 minute tak chalega. Sab messages Roman Urdu me.
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
    let buf = '';
    let stage = 0;
    const timer = setTimeout(() => { try { socket.destroy(); } catch(e){} reject(new Error('Gmail se jawab nahi aaya. Dobara try karo.')); }, 20000);
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const send = (s) => { try { socket.write(s + '\r\n'); } catch(e){} };
    const fail = (m) => { clearTimeout(timer); try { socket.destroy(); } catch(e){} reject(new Error(m)); };
    socket.on('error', (e) => { clearTimeout(timer); reject(new Error('Gmail connect nahi ho raha: ' + e.message)); });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n')) return;
      // Multi-line jawab ka wait: jab tak "250-" jesi line hai, aur lines aani hain
      const lines = buf.split('\r\n');
      const lastLine = lines[lines.length - 2] || '';
      if (lastLine.length >= 4 && lastLine[3] === '-') return;
      const code = buf.slice(0, 3);
      buf = '';
      if (stage === 0) { // 220 greeting
        if (code !== '220') return fail('Gmail ne jawab nahi diya.');
        stage = 1; send('EHLO shurwat-smm');
      } else if (stage === 1) { // EHLO -> AUTH
        stage = 2; send('AUTH LOGIN');
      } else if (stage === 2) { // 334 -> username
        stage = 3; send(b64(user));
      } else if (stage === 3) { // 334 -> password
        stage = 4; send(b64(pass));
      } else if (stage === 4) { // 235 Auth OK
        if (code !== '235') return fail('Gmail login fail ho gaya. App Password naya banao, gap mat do.');
        stage = 5; send('MAIL FROM:<' + user + '>');
      } else if (stage === 5) {
        if (code !== '250') return fail('MAIL FROM fail ho gaya.');
        stage = 6; send('RCPT TO:<' + to + '>');
      } else if (stage === 6) {
        if (code !== '250' && code !== '251') return fail('Ye Gmail galat hai ya band hai. Sahi Gmail likho.');
        stage = 7; send('DATA');
      } else if (stage === 7) {
        if (code !== '354') return fail('DATA fail ho gaya.');
        const headers = 'From: "SHURWAT SMM" <' + user + '>\r\nTo: <' + to + '>\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n';
        send(headers + html + '\r\n.');
        stage = 8;
      } else if (stage === 8) {
        if (code !== '250') return fail('OTP bhejne me fail ho gaya.');
        stage = 9; send('QUIT');
        clearTimeout(timer); resolve(true);
      }
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const url = String(req.url || '');
  const isVerify = url.includes('/verify');
  try {
    const body = await readBody(req);
    if (isVerify) {
      const em = String(body.email || '').toLowerCase().trim();
      const c = String(body.code || body.otp || '').trim();
      if (!em || !c) return res.status(400).json({ error: 'OTP code likho' });
      const v = store.get(em);
      if (!v || !v.code) return res.status(400).json({ error: 'Pehle Send OTP dabao, OTP aaya hi nahi' });
      if (Date.now() > (v.expiresAt || 0)) { store.delete(em); return res.status(400).json({ error: 'Code expire ho gaya. Dobara Send OTP dabao.' }); }
      if ((v.attempts || 0) >= 5) { store.delete(em); return res.status(400).json({ error: '5 dafa galat likha. Dobara Send OTP dabao.' }); }
      if (String(v.code) !== c) { v.attempts = (v.attempts || 0) + 1; return res.status(400).json({ error: 'Galat OTP hai. Dobara likho.' }); }
      v.verified = true; v.verifiedAt = Date.now();
      return res.status(200).json({ ok: true, msg: 'OTP verify ho gaya' });
    }
    const em = String(body.email || '').toLowerCase().trim();
    const name = String(body.name || '');
    if (!em || !em.includes('@')) return res.status(400).json({ error: 'Sahi Gmail likho' });
    const user = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    if (!user || !pass) return res.status(500).json({ error: 'OTP service set nahi hai. Vercel me Gmail + App Password check karo.' });
    const prev = store.get(em);
    if (prev && prev.sentAt && (Date.now() - prev.sentAt < 60 * 1000)) return res.status(429).json({ error: 'OTP pehle hi bhej diya hai. 60 second wait karo.' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    // 10 minute expiry - pehle 5 min tha, ab 10 min
    store.set(em, { email: em, code, name, sentAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, verified: false });
    try {
      await sendGmail({
        user, pass, to: em,
        subject: 'Apka SHURWAT SMM Code - ' + code,
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#fff;border-radius:16px;text-align:center"><h1>SHURWAT SMM</h1><p>Apka Sign Up Code</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#fff;color:#111;padding:16px;border-radius:12px">' + code + '</div><p style="color:#94a3b8;font-size:13px">Ye code 10 minute tak chalega. Kisi ko mat batana.</p></div>'
      });
    } catch (e) {
      store.delete(em);
      console.log('GMAIL SEND FAIL:', e.message);
      return res.status(500).json({ error: String(e.message || '').slice(0, 160) });
    }
    return res.status(200).json({ ok: true, msg: 'OTP apke Gmail par bhej diya hai' });
  } catch (e) {
    console.log('otp error', e.message);
    return res.status(500).json({ error: 'OTP nahi bheja gaya. Dobara try karo.' });
  }
};
