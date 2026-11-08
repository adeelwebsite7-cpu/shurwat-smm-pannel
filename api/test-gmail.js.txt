// /api/test-gmail - sirf Gmail login test, OTP nahi bhejta
const tls = require('tls');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const logs = [];
  logs.push('GMAIL_USER set: ' + (!!user));
  logs.push('GMAIL_USER hint: ' + (user ? user.slice(0,2) + '***' + user.slice(user.indexOf('@')) : 'MISSING'));
  logs.push('APP_PASS length: ' + pass.length);
  logs.push('APP_PASS has space: ' + /\s/.test(process.env.GMAIL_APP_PASSWORD || ''));
  logs.push('APP_PASS has quote: ' + /["']/.test(process.env.GMAIL_APP_PASSWORD || ''));
  if (!user || !pass) return res.status(200).json({ ok: false, logs, error: 'Env missing' });
  try {
    const result = await new Promise((resolve, reject) => {
      const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
      let buf = ''; let stage = 0; const steps = [];
      const timer = setTimeout(() => { try{socket.destroy();}catch(e){} reject(new Error('Timeout - Gmail ne 20 sec me jawab nahi diya')); }, 20000);
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
      const send = (s) => { try{socket.write(s + '\r\n');}catch(e){} };
      socket.on('error', (e) => { clearTimeout(timer); reject(new Error('Connect fail: ' + e.message)); });
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!buf.includes('\r\n')) return;
        const lines = buf.split('\r\n');
        const lastLine = lines[lines.length - 2] || '';
        if (lastLine.length >= 4 && lastLine[3] === '-') return;
        const code = buf.slice(0, 3);
        const full = buf.trim().slice(0, 200);
        steps.push('Stage ' + stage + ' -> Gmail: ' + full);
        buf = '';
        if (stage === 0) { stage = 1; send('EHLO shurwat-smm'); }
        else if (stage === 1) { stage = 2; send('AUTH LOGIN'); }
        else if (stage === 2) { stage = 3; send(b64(user)); }
        else if (stage === 3) { stage = 4; send(b64(pass)); }
        else if (stage === 4) {
          clearTimeout(timer);
          send('QUIT');
          if (code === '235') resolve({ ok: true, steps, msg: 'LOGIN HO GAYA - password sahi hai' });
          else resolve({ ok: false, steps, msg: 'LOGIN FAIL - Gmail code: ' + code });
        }
      });
    });
    return res.status(200).json({ ...result, logs });
  } catch (e) {
    return res.status(200).json({ ok: false, logs, error: e.message });
  }
};
