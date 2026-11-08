// SHURWAT SMM - OTP standalone, NO nodemailer, NO Express, NO Firebase
// Gmail SMTP seedha Node ke built-in net/tls se - koi package install karne ki zaroorat nahi
// Isliye "nodemailer missing" wala error ab aa hi nahi sakta.
const net = require('net');
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

// --- Minimal SMTP client for Gmail (587 + STARTTLS + AUTH LOGIN) ---
function sendGmail({ user, pass, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    let socket = net.connect(587, 'smtp.gmail.com', () => {});
    let buf = '';
    let stage = 0;
    let tlsStarted = false;
    const timeout = setTimeout(() => { try { socket.destroy(); } catch(e){} reject(new Error('Gmail timeout - 15 sec me jawab nahi aaya')); }, 20000);

    function send(s) { try { socket.write(s + '\r\n'); } catch(e){} }

    function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // poora jawab aa gaya? (XYZ + space = last line)
      if (!/\r\n\d{3} /.test(buf) && !/\r\n\d{3}-/.test(buf) && buf.indexOf('\r\n') === -1) return;
      // multi-line reply ka wait karo
      const lines = buf.split('\r\n');
      const last = lines[lines.length - 2] || '';
      if (last && last[3] === '-' ) return; // abhi aur lines aani hain
      const code = buf.slice(0, 3);
      buf = '';
      // console.log('SMTP stage', stage, 'code', code);
      if (stage === 0) { // 220 greeting
        if (code !== '220') return fail('Gmail greeting fail: ' + code);
        stage = 1; send('EHLO shurwat-smm');
      } else if (stage === 1) { // EHLO -> STARTTLS
        stage = 2; send('STARTTLS');
      } else if (stage === 2) { // 220 Ready -> TLS upgrade
        if (code !== '220') return fail('STARTTLS fail: ' + code);
        try {
          const tlsSocket = tls.connect({ socket: socket, servername: 'smtp.gmail.com', rejectUnauthorized: true });
          socket = tlsSocket;
          socket.on('data', onData);
          socket.on('error', onErr);
          stage = 3; send('EHLO shurwat-smm');
        } catch(e) { return fail('TLS fail: ' + e.message); }
      } else if (stage === 3) { // EHLO (TLS) -> AUTH LOGIN
        stage = 4; send('AUTH LOGIN');
      } else if (stage === 4) { // 334 -> username
        stage = 5; send(b64(user));
      } else if (stage === 5) { // 334 -> password
        stage = 6; send(b64(pass));
      } else if (stage === 6) { // 235 Auth OK -> MAIL FROM
        if (code !== '235') return fail('Gmail login failed. App Password naya banao, gap mat do. Code: ' + code);
        stage = 7; send('MAIL FROM:<' + user + '>');
      } else if (stage === 7) {
        if (code !== '250') return fail('MAIL FROM fail: ' + code);
        stage = 8; send('RCPT TO:<' + to + '>');
      } else if (stage === 8) {
        if (code !== '250' && code !== '251') return fail('RCPT fail - ye Gmail galat hai ya band hai: ' + code);
        stage = 9; send('DATA');
      } else if (stage === 9) {
        if (code !== '354') return fail('DATA fail: ' + code);
        const headers = 'From: "SHURWAT SMM" <' + user + '>\r\nTo: <' + to + '>\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n';
        send(headers + html + '\r\n.');
        stage = 10;
      } else if (stage === 10) {
        if (code !== '250') return fail('Send fail: ' + code);
        stage = 11; send('QUIT');
        clearTimeout(timeout);
        resolve(true);
      }
      function onData(c) { socket.emit('data2', c); }
    });
    // TLS ke baad data event dobara lagana padta hai - isliye wrapper
    function onData(c) {}
    function onErr(e) { clearTimeout(timeout); reject(new Error('Gmail connect fail: ' + e.message)); }
    function fail(msg) { clearTimeout(timeout); try { socket.destroy(); } catch(e){} reject(new Error(msg)); }
    socket.on('error', onErr);
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
      if (!em || !c) return res.status(400).json({ error: 'Enter OTP code' });
      const v = store.get(em);
      if (!v || !v.code) return res.status(400).json({ error: 'No OTP found. Tap Send OTP first.' });
      if (Date.now() > (v.expiresAt || 0)) { store.delete(em); return res.status(400).json({ error: 'OTP expired. Tap Send OTP again.' }); }
      if ((v.attempts || 0) >= 5) { store.delete(em); return res.status(400).json({ error: 'Too many wrong tries. Tap Send OTP again.' }); }
      if (String(v.code) !== c) { v.attempts = (v.attempts || 0) + 1; return res.status(400).json({ error: 'Wrong OTP. Try again.' }); }
      v.verified = true; v.verifiedAt = Date.now();
      return res.status(200).json({ ok: true, msg: 'OTP verified' });
    }

    // SEND
    const em = String(body.email || '').toLowerCase().trim();
    const name = String(body.name || '');
    if (!em || !em.includes('@')) return res.status(400).json({ error: 'Enter a valid Gmail Address' });
    const user = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    if (!user || !pass) return res.status(500).json({ error: 'OTP service not set up. Vercel me GMAIL_USER + GMAIL_APP_PASSWORD nahi hain.' });

    const prev = store.get(em);
    if (prev && prev.sentAt && (Date.now() - prev.sentAt < 60 * 1000)) return res.status(429).json({ error: 'OTP already sent. Wait 60 seconds and try again.' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    store.set(em, { email: em, code, name, sentAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, verified: false });

    try {
      await sendGmail({
        user, pass, to: em,
        subject: 'Your SHURWAT SMM OTP - ' + code,
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#fff;border-radius:16px;text-align:center"><h1>SHURWAT SMM</h1><p>Your OTP for Sign Up</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#fff;color:#111;padding:16px;border-radius:12px">' + code + '</div><p style="color:#94a3b8;font-size:13px">This code expires in 5 minutes. Never share it with anyone.</p></div>',
        text: 'Your SHURWAT SMM OTP is: ' + code
      });
    } catch (e) {
      store.delete(em);
      console.log('GMAIL SEND FAIL:', e.message);
      return res.status(500).json({ error: String(e.message || '').slice(0, 160) });
    }
    return res.status(200).json({ ok: true, msg: 'OTP sent to your Gmail' });
  } catch (e) {
    console.log('otp error', e.message);
    return res.status(500).json({ error: 'Could not send OTP. Try again.' });
  }
};
