// Vercel Serverless - /api/debug
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = (process.env.GMAIL_USER || '').trim();
  const p = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  return res.status(200).json({
    hasGmailUser: !!u,
    gmailUserHint: u ? (u.slice(0,2) + '***' + u.slice(u.indexOf('@'))) : 'MISSING',
    hasAppPassword: !!p,
    appPassLength: p.length,
    time: new Date().toISOString(),
    note: 'standalone debug works - api/debug.js'
  });
};
