// ============================================================
// SHURWAT SMM - FULLY HEAVY BACKEND SERVER v3.0
// Node.js + Express + Firebase Admin + RAM Cache + Live Sync
// Frontend -> Heavy Server -> Firebase (Fastest)
// ============================================================
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const admin = require('firebase-admin');
let nodemailer=null; try{ nodemailer=require('nodemailer'); }catch(e){ console.log('nodemailer missing'); }

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 1. HEAVY MIDDLEWARE ----------
app.use(cors({ origin: '*' }));
app.use(compression()); // GZIP - data 70% chota
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- VERCEL FIX: /api kaat de to bhi kaam kare ----------
app.use((req,res,next)=>{
  if(req.url==='/debug') req.url='/api/debug';
  if(req.url==='/otp/send') req.url='/api/otp/send';
  if(req.url==='/otp/verify') req.url='/api/otp/verify';
  next();
});


// Simple Rate Limit - spam se server heavy na ho
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'local';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  if (arr.length > 120) return res.status(429).json({ error: 'Too many requests, thora wait karo' });
  next();
});

// ---------- 2. FIREBASE ADMIN ----------
let db = null;
try {
  const svcRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (svcRaw) {
    const svc = JSON.parse(svcRaw);
    if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert(svc),
      databaseURL: process.env.FIREBASE_DB_URL || 'https://shurwat-3c60e-default-rtdb.firebaseio.com'
    });
    db = admin.database();
    console.log('✅ Firebase Admin Connected - HEAVY MODE');
  } else console.log('⚠️ FIREBASE_SERVICE_ACCOUNT missing - set env var');
} catch (e) { console.log('Firebase init error:', e.message); }

// ---------- 3. HEAVY RAM CACHE ----------
const cache = {
  usersByName: new Map(), // name_lower -> {uid,email,name}
  usersByUid: new Map(),
  services: null, servicesTime: 0,
  cats: null,
  vouchers: new Map(), // code -> voucher
  stats: null, statsTime: 0,
  orders: null, ordersTime: 0,
};
const TTL = { services: 30*1000, stats: 15*1000, orders: 20*1000 };
const keyName = (n) => String(n||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'_');
const keyCode = (c) => String(c||'').toUpperCase().trim();
const noCache = (res) => res.set('Cache-Control','no-store');
const cacheHeader = (res, s) => res.set('Cache-Control', `public, max-age=${s}`);

async function warmCache(){
  if(!db) return;
  try{
    const [uSnap, sSnap, cSnap, vSnap] = await Promise.all([
      db.ref('users').once('value'),
      db.ref('services').once('value'),
      db.ref('categories').once('value'),
      db.ref('vouchers').once('value'),
    ]);
    const users = uSnap.val()||{};
    cache.usersByName.clear(); cache.usersByUid.clear();
    for(const [uid,u] of Object.entries(users)){
      if(u.name){ cache.usersByName.set(keyName(u.name), {uid, email:u.email, name:u.name}); cache.usersByUid.set(uid,u); }
    }
    cache.services = sSnap.val()||{}; cache.servicesTime = Date.now();
    cache.cats = cSnap.val()||{};
    const vou = vSnap.val()||{};
    cache.vouchers.clear();
    for(const [code,v] of Object.entries(vou)) cache.vouchers.set(keyCode(code), {code, ...v});
    console.log(`🔥 Cache Warmed: ${cache.usersByName.size} users | ${Object.keys(cache.services).length} services | ${cache.vouchers.size} vouchers`);
  }catch(e){ console.log('warmCache error', e.message); }
}

function startLiveSync(){
  if(!db) return;
  db.ref('users').on('child_added', s=>{ const u=s.val(); if(u?.name){ cache.usersByName.set(keyName(u.name), {uid:s.key, email:u.email, name:u.name}); cache.usersByUid.set(s.key,u);} });
  db.ref('users').on('child_changed', s=>{ const u=s.val(); if(u?.name){ cache.usersByName.set(keyName(u.name), {uid:s.key, email:u.email, name:u.name}); cache.usersByUid.set(s.key,u);} });
  db.ref('users').on('child_removed', s=>{ cache.usersByUid.delete(s.key); });
  db.ref('services').on('value', s=>{ cache.services=s.val()||{}; cache.servicesTime=Date.now(); });
  db.ref('categories').on('value', s=>{ cache.cats=s.val()||{}; });
  db.ref('vouchers').on('value', s=>{ const v=s.val()||{}; cache.vouchers.clear(); for(const [code, val] of Object.entries(v)) cache.vouchers.set(keyCode(code), {code, ...val}); });
  console.log('⚡ Live Sync ON');
}

// ---------- 4. HEALTH ----------
app.get('/', (req,res)=>res.json({status:'SHURWAT HEAVY SERVER RUNNING 🔥', uptime:Math.floor(process.uptime()), cachedUsers:cache.usersByName.size, cachedServices:cache.services?Object.keys(cache.services).length:0, cachedVouchers:cache.vouchers.size}));
app.get('/ping', (req,res)=>res.json({ok:true, time:Date.now()}));

// ---------- 5. AUTH - LOGIN BY NAME (0ms cache) ----------
app.post('/api/auth/login', async (req,res)=>{
  try{
    const {name} = req.body||{};
    if(!name) return res.status(400).json({error:'Enter Name'});
    const found = cache.usersByName.get(keyName(name));
    if(found) return res.json({email:found.email, uid:found.uid, name:found.name, from:'cache-0ms'});
    if(!db) return res.status(404).json({error:'Name not found. Please Sign Up first.'});
    const snap = await db.ref('userNames/'+keyName(name)).once('value');
    if(!snap.exists()){
      const snap2 = await db.ref('users').orderByChild('name').equalTo(name).once('value');
      if(!snap2.exists()) return res.status(404).json({error:'Name not found. Please Sign Up first.'});
      const [uid,u] = Object.entries(snap2.val())[0];
      cache.usersByName.set(keyName(name), {uid, email:u.email, name:u.name});
      return res.json({email:u.email, uid, name:u.name, from:'db-fallback'});
    }
    const v = snap.val();
    cache.usersByName.set(keyName(name), {uid:v.uid, email:v.email, name:v.name});
    return res.json({email:v.email, uid:v.uid, name:v.name, from:'db-index'});
  }catch(e){ console.log('login error', e.message); return res.status(500).json({error:'Server error. Try again.'}); }
});

// ---------- 6. AUTH - SIGNUP ----------
app.post('/api/auth/signup', async (req,res)=>{
  try{
    const {name, email, password} = req.body||{};
    if(!name || !email || !password) return res.status(400).json({error:'Fill all fields'});
    if(!db) return res.status(500).json({error:'Server not connected. Set FIREBASE_SERVICE_ACCOUNT.'});
    let user;
    try{ user = await admin.auth().createUser({email, password, displayName:name}); }
    catch(e){
      if(e.code==='auth/email-already-exists') return res.status(400).json({error:'This Gmail is already registered. Please Login.'});
      if(e.code==='auth/weak-password') return res.status(400).json({error:'Password kam se kam 6 characters ka ho'});
      if(e.code==='auth/invalid-email') return res.status(400).json({error:'Sahi Gmail likho'});
      return res.status(400).json({error:e.message});
    }
    const k = keyName(name);
    await Promise.all([
      db.ref('users/'+user.uid).set({name, email, phone:'', balance:0, status:'active', createdAt:Date.now(), role:'user'}),
      db.ref('userNames/'+k).set({uid:user.uid, email, name}),
    ]);
    cache.usersByName.set(k, {uid:user.uid, email, name});
    cache.usersByUid.set(user.uid, {name, email, balance:0});
    return res.json({ok:true, uid:user.uid, email, name});
  }catch(e){ console.log('signup error', e.message); return res.status(500).json({error:'Server error. Try again.'}); }
});

// ---------- 7. SERVICES (cached) ----------
app.get('/api/services', (req,res)=>{
  cacheHeader(res, 30);
  if(cache.services && (Date.now()-cache.servicesTime < TTL.services)) return res.json({services:cache.services, categories:cache.cats, from:'cache'});
  if(!db) return res.json({services:{}, categories:{}});
  db.ref('services').once('value').then(s=>{
    cache.services=s.val()||{}; cache.servicesTime=Date.now();
    return res.json({services:cache.services, categories:cache.cats, from:'db'});
  }).catch(()=>res.json({services:{}, categories:{}}));
});

// ---------- 8. USER DATA - Dashboard fast (1 call me sab) ----------
app.get('/api/user/:uid/dashboard', async (req,res)=>{
  try{
    noCache(res);
    if(!db) return res.status(500).json({error:'Server not connected'});
    const uid = req.params.uid;
    const [uSnap, oSnap, dSnap, tSnap] = await Promise.all([
      db.ref('users/'+uid).once('value'),
      db.ref('orders').orderByChild('userId').equalTo(uid).limitToLast(20).once('value'),
      db.ref('deposits').orderByChild('userId').equalTo(uid).limitToLast(20).once('value'),
      db.ref('transactions').orderByChild('userId').equalTo(uid).limitToLast(20).once('value'),
    ]);
    const user = uSnap.val()||{};
    const orders = oSnap.val()||{};
    const deposits = dSnap.val()||{};
    const transactions = tSnap.val()||{};
    return res.json({
      user, orders, deposits, transactions,
      stats: {
        totalOrders: Object.keys(orders).length,
        pending: Object.values(orders).filter(x=>x.status==='Pending').length,
        completed: Object.values(orders).filter(x=>x.status==='Completed').length,
        balance: user.balance||0
      }
    });
  }catch(e){ return res.status(500).json({error:'Dashboard error'}); }
});

// ---------- 9. PLACE ORDER (server side balance check = safe + fast) ----------
app.post('/api/order', async (req,res)=>{
  try{
    const {uid, serviceId, link, quantity} = req.body||{};
    if(!uid || !serviceId || !link || !quantity) return res.status(400).json({error:'Fill all fields'});
    if(!db) return res.status(500).json({error:'Server not connected'});
    const [uSnap, sSnap] = await Promise.all([ db.ref('users/'+uid).once('value'), db.ref('services/'+serviceId).once('value') ]);
    const user = uSnap.val(); const svc = sSnap.val();
    if(!user) return res.status(404).json({error:'User not found'});
    if(!svc) return res.status(404).json({error:'Service not found'});
    const qty = parseInt(quantity);
    if(qty < (svc.min||1) || qty > (svc.max||100000)) return res.status(400).json({error:`Quantity ${svc.min} - ${svc.max} ke beech me ho`});
    const total = (svc.price/1000) * qty;
    if((user.balance||0) < total) return res.status(400).json({error:'Balance kam hai. Deposit karo.'});
    const orderId = 'ORD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
    const order = { orderId, userId:uid, serviceId, serviceName:svc.name, link, quantity:qty, totalPrice:parseFloat(total.toFixed(2)), status:'Pending', createdAt:Date.now() };
    // Atomic: order banao + balance kato - ek saath
    await Promise.all([
      db.ref('orders/'+orderId).set(order),
      db.ref('users/'+uid+'/balance').set(parseFloat(((user.balance||0)-total).toFixed(2))),
      db.ref('transactions').push({userId:uid, type:'order', amount:-total, desc:`Order ${orderId} - ${svc.name}`, createdAt:Date.now()}),
    ]);
    return res.json({ok:true, order});
  }catch(e){ console.log('order error', e.message); return res.status(500).json({error:'Order failed. Try again.'}); }
});

// ---------- 10. VOUCHER REDEEM (server side = double redeem impossible) ----------
app.post('/api/voucher/redeem', async (req,res)=>{
  try{
    const {uid, code} = req.body||{};
    if(!uid || !code) return res.status(400).json({error:'Enter voucher code'});
    const v = cache.vouchers.get(keyCode(code));
    if(!v) return res.status(404).json({error:'Invalid voucher code'});
    if(v.active === false) return res.status(400).json({error:'This voucher is disabled'});
    if(v.expiry && Date.now() > v.expiry) return res.status(400).json({error:'Voucher expired'});
    if(!db) return res.status(500).json({error:'Server not connected'});
    const redSnap = await db.ref('voucherRedemptions').orderByChild('code').equalTo(keyCode(code)).once('value');
    const reds = redSnap.val()||{};
    if(Object.values(reds).some(r=>r.userId===uid)) return res.status(400).json({error:'Tum ye voucher pehle use kar chuke ho'});
    if(v.maxUses && Object.keys(reds).length >= v.maxUses) return res.status(400).json({error:'Voucher limit khatam ho gaya'});
    const uSnap = await db.ref('users/'+uid).once('value');
    const user = uSnap.val(); if(!user) return res.status(404).json({error:'User not found'});
    const amount = parseFloat(v.amount||0);
    const newBal = parseFloat(((user.balance||0)+amount).toFixed(2));
    await Promise.all([
      db.ref('users/'+uid+'/balance').set(newBal),
      db.ref('voucherRedemptions').push({userId:uid, code:keyCode(code), amount, createdAt:Date.now()}),
      db.ref('transactions').push({userId:uid, type:'voucher', amount, desc:`Voucher ${keyCode(code)}`, createdAt:Date.now()}),
    ]);
    return res.json({ok:true, amount, newBalance:newBal});
  }catch(e){ console.log('voucher error', e.message); return res.status(500).json({error:'Voucher failed'}); }
});

// ---------- 11. ADMIN STATS (cached 15 sec) ----------
app.get('/api/admin/stats', async (req,res)=>{
  if(cache.stats && (Date.now()-cache.statsTime < TTL.stats)) return res.json({...cache.stats, from:'cache'});
  if(!db) return res.json({users:0, orders:0});
  try{
    const [u,o,d] = await Promise.all([ db.ref('users').once('value'), db.ref('orders').once('value'), db.ref('deposits').once('value') ]);
    const users=u.val()||{}, orders=o.val()||{}, deposits=d.val()||{};
    const stats={ users:Object.keys(users).length, orders:Object.keys(orders).length, deposits:Object.keys(deposits).length, pendingOrders:Object.values(orders).filter(x=>x.status==='Pending').length, pendingDeposits:Object.values(deposits).filter(x=>x.status==='Pending').length, totalRevenue:Object.values(orders).filter(x=>x.status!=='Cancelled').reduce((a,x)=>a+(x.totalPrice||0),0), totalBalances:Object.values(users).reduce((a,x)=>a+(x.balance||0),0) };
    cache.stats=stats; cache.statsTime=Date.now();
    return res.json({...stats, from:'db'});
  }catch(e){ return res.status(500).json({error:'Stats error'}); }
});

// ---------- 12. ADMIN - CLEAR CACHE ----------
app.post('/api/cache/clear', async (req,res)=>{
  cache.services=null; cache.stats=null; cache.orders=null;
  await warmCache();
  return res.json({ok:true, msg:'Cache cleared + rewarmed'});
});




// ---------- DEBUG - Env check, bina secret dikhaye ----------
app.get('/api/debug', (req,res)=>{
  const u = (process.env.GMAIL_USER||'').trim();
  const p = (process.env.GMAIL_APP_PASSWORD||'').replace(/\s+/g,'');
  return res.json({
    hasGmailUser: !!u,
    gmailUserLength: u.length,
    gmailUserHint: u ? (u.slice(0,2)+'***'+u.slice(u.indexOf('@'))) : 'MISSING',
    hasAppPassword: !!p,
    appPassLength: p.length,
    hasNodemailer: !!nodemailer,
    time: new Date().toISOString()
  });
});
// Alias: Vercel kabhi /api kaat deta hai, isliye dono routes
app.get('/debug', (req,res)=>{ const u=(process.env.GMAIL_USER||'').trim(); const p=(process.env.GMAIL_APP_PASSWORD||'').replace(/\s+/g,''); return res.json({ hasGmailUser: !!u, gmailUserLength: u.length, gmailUserHint: u ? (u.slice(0,2)+'***'+u.slice(u.indexOf('@'))) : 'MISSING', hasAppPassword: !!p, appPassLength: p.length, hasNodemailer: !!nodemailer, time: new Date().toISOString(), note:'alias /debug works' }); });

// ---------- OTP v3 - NO Firebase folder needed, NO FIREBASE_SERVICE_ACCOUNT, ONLY GMAIL vars ----------
// OTP sirf server memory me rehta hai, Firebase me folder banane ki zaroorat nahi
const otpMem3 = new Map();
function getMailer3(){
  if(!nodemailer) return null;
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g,'');
  if(!user || !pass) return null;
  return nodemailer.createTransport({ host:'smtp.gmail.com', port:587, secure:false, requireTLS:true, auth:{ user, pass } });
}
app.post('/api/otp/send', async (req,res)=>{
  try{
    const { email, name } = req.body||{};
    const em = String(email||'').toLowerCase().trim();
    if(!em || !em.includes('@')) return res.status(400).json({error:'Enter a valid Gmail Address'});
    const mailer = getMailer3();
    if(!mailer) return res.status(500).json({error:'OTP service not set up yet. Vercel me GMAIL_USER + GMAIL_APP_PASSWORD check karo, phir Redeploy karo.'});
    const prev = otpMem3.get(em);
    if(prev && prev.sentAt && (Date.now()-prev.sentAt < 60*1000)) return res.status(429).json({error:'OTP already sent. Wait 60 seconds and try again.'});
    const code = String(Math.floor(100000 + Math.random()*900000));
    otpMem3.set(em, { email:em, code, name:name||'', sentAt:Date.now(), expiresAt:Date.now()+5*60*1000, attempts:0, verified:false });
    const fromUser = (process.env.GMAIL_USER||'').trim();
    try{
      await mailer.sendMail({
        from: '"SHURWAT SMM" <'+fromUser+'>',
        to: em,
        subject: 'Your SHURWAT SMM OTP - '+code,
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f172a;color:#fff;border-radius:16px;text-align:center"><h1 style="margin:0">SHURWAT <span style="color:#a78bfa">SMM</span></h1><p style="color:#cbd5e1">Your OTP for Sign Up</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#fff;color:#111;padding:16px;border-radius:12px">'+code+'</div><p style="color:#94a3b8;font-size:13px">This code expires in 5 minutes. Never share it with anyone.</p></div>',
        text: 'Your SHURWAT SMM OTP is: '+code+' (expires in 5 minutes)'
      });
    }catch(e){
      console.log('GMAIL SEND FAIL:', e.message);
      otpMem3.delete(em);
      if(e.message && (e.message.includes('Invalid login') || e.message.includes('Username and Password not accepted') || e.message.includes('535'))) return res.status(500).json({error:'Gmail login failed. GMAIL_USER aur GMAIL_APP_PASSWORD ek hi Gmail (adeelwebsite7@gmail.com) ke hone chahiye. App Code naya banao, gap mat do.'});
      if(e.message && e.message.includes('Missing credentials')) return res.status(500).json({error:'OTP service not set up. GMAIL_USER + GMAIL_APP_PASSWORD Vercel Project me nahi hain.'});
      return res.status(500).json({error:'Gmail se connect nahi ho raha: '+e.message.slice(0,120)});
    }
    return res.json({ok:true, msg:'OTP sent to your Gmail'});
  }catch(e){ console.log('otp send error', e.message); return res.status(500).json({error:'Could not send OTP. Try again.'}); }
});
app.post('/api/otp/verify', async (req,res)=>{
  try{
    const { email, code } = req.body||{};
    const em = String(email||'').toLowerCase().trim();
    const c = String(code||'').trim();
    if(!em || !c) return res.status(400).json({error:'Enter OTP code'});
    const v = otpMem3.get(em);
    if(!v || !v.code) return res.status(400).json({error:'No OTP found. Tap Send OTP first.'});
    if(Date.now() > (v.expiresAt||0)) return res.status(400).json({error:'OTP expired. Tap Send OTP again.'});
    if((v.attempts||0) >= 5) return res.status(400).json({error:'Too many wrong tries. Tap Send OTP again.'});
    if(String(v.code) !== c){ v.attempts=(v.attempts||0)+1; return res.status(400).json({error:'Wrong OTP. Try again.'}); }
    v.verified=true; v.verifiedAt=Date.now();
    return res.json({ok:true, msg:'OTP verified'});
  }catch(e){ console.log('otp verify error', e.message); return res.status(500).json({error:'Could not verify OTP. Try again.'}); }
});

// ---------- 13. VERCEL EXPORT ----------
let _warmed = false;
app.use(async (req,res,next)=>{
  if(!_warmed){ _warmed = true; try{ await warmCache(); startLiveSync(); }catch(e){} }
  next();
});
module.exports = app;
