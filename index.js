/* StudyFlow: función "ai".
   Recibe las preguntas de la app, revisa el plan y los límites de la familia,
   y llama a la API de Claude con tu llave secreta (que nunca llega al celular). */
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const crypto = require('crypto');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getAuth} = require('firebase-admin/auth');

initializeApp();
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Modelo: Haiku es rápido y económico. Cámbialo aquí si quieres otro.
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 1500;

// Límites por persona. "dia" se reinicia cada día, "semana" cada lunes.
const LIMITS = {
  free: {tutor: 5, quiz: 2, temario: 3, otros: 10},
  pro:  {tutor: 50, quiz: 30, temario: 20, otros: 60},
};
const PRO_ONLY = ['photo', 'guide', 'ideas'];

// Correos con acceso al panel de administrador (activar Pro, ver pagos, links de pago).
// La cuenta debe tener el correo verificado (entrar con Google lo verifica solo).
const ADMIN_EMAILS = ['msalinas8811@gmail.com'];
const DAY = 86400000;

// Precio de la IA (Haiku 5.5, por millón de tokens) para el estimado de costo del panel.
// Revisa platform.claude.com/docs/en/about-claude/pricing si cambias de modelo.
const PRICE_IN = 0.10, PRICE_OUT = 0.50;
function monthKey(t) { return new Date(t || Date.now()).toISOString().slice(0, 7); }
function money(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : 0; }

// Pro vigente: plan "pro" y sin vencer
function isProPlan(p) {
  return !!p && p.plan === 'pro' && (!p.until || p.until > Date.now());
}

function periodKey(kind) {
  const now = new Date();
  if (kind === 'quiz') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return 'w' + d.toISOString().slice(0, 10);
  }
  return 'd' + now.toISOString().slice(0, 10);
}

exports.ai = onCall({secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: '256MiB', maxInstances: 10}, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const uid = req.auth.uid;
  const data = req.data || {};
  const kind = String(data.kind || 'otros');
  const messages = Array.isArray(data.messages) ? data.messages : [];

  // Validar lo que llega
  if (!messages.length || messages.length > 30) throw new HttpsError('invalid-argument', 'mensajes');
  let total = 0;
  const clean = messages.map((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) || '');
    total += content.length;
    return {role, content};
  }).filter((m) => m.content.trim());
  if (!clean.length || clean[clean.length - 1].role !== 'user') throw new HttpsError('invalid-argument', 'mensajes');
  if (total > 60000) throw new HttpsError('invalid-argument', 'demasiado texto');

  // Familia y plan
  const user = (await db.doc(`users/${uid}`).get()).data();
  if (!user || !user.familyId) throw new HttpsError('failed-precondition', 'sin familia');
  const fid = user.familyId;
  const member = await db.doc(`families/${fid}/members/${uid}`).get();
  if (!member.exists) throw new HttpsError('permission-denied', 'no_member');
  const planDoc = (await db.doc(`families/${fid}/meta/plan`).get()).data() || {};
  let plan = isProPlan(planDoc) ? 'pro' : 'free';
  // Alumnos de un colegio con licencia vigente (y su familia) tienen Pro
  if (plan === 'free') {
    const ms = (await db.doc(`families/${fid}/meta/school`).get()).data();
    for (const s of Object.keys((ms && ms.schools) || {}).slice(0, 5)) {
      if (schoolActive((await db.doc(`schools/${s}`).get()).data())) { plan = 'pro'; break; }
    }
  }
  if (PRO_ONLY.includes(kind) && plan !== 'pro') throw new HttpsError('permission-denied', 'pro_required');

  // Límite de uso (contador por persona)
  const bucket = kind === 'tutor' ? 'tutor' : kind === 'quiz' ? 'quiz' : kind === 'temario' ? 'temario' : 'otros';
  const max = LIMITS[plan][bucket];
  const ref = db.doc(`families/${fid}/usage/${uid}_${bucket}_${periodKey(bucket)}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const n = snap.exists ? snap.data().n || 0 : 0;
    if (n >= max) throw new HttpsError('resource-exhausted', 'limit');
    t.set(ref, {n: n + 1, uid, bucket, at: Date.now()}, {merge: true});
  });

  // Imagen opcional (foto del temario)
  const img = data.image;
  if (img) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(img.media_type) || typeof img.data !== 'string' || img.data.length > 7000000) {
      throw new HttpsError('invalid-argument', 'imagen');
    }
    const last = clean[clean.length - 1];
    last.content = [
      {type: 'image', source: {type: 'base64', media_type: img.media_type, data: img.data}},
      {type: 'text', text: last.content},
    ];
  }

  // Si algo falla, se devuelve la pregunta al contador
  const refund = () => ref.set({n: FieldValue.increment(-1)}, {merge: true}).catch(() => {});

  // Llamada a Claude
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY.value(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({model: MODEL, max_tokens: MAX_TOKENS, messages: clean}),
  });
  } catch (e) {
    await refund();
    throw new HttpsError('unavailable', 'ai_error');
  }
  if (!res.ok) {
    await refund();
    const body = await res.text();
    console.error('Anthropic', res.status, body.slice(0, 500));
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'busy');
    throw new HttpsError('unavailable', 'ai_error');
  }
  const out = await res.json();
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text.trim()) await refund();
  else {
    const u = out.usage || {};
    db.doc(`stats/ai_${monthKey()}`).set({
      calls: FieldValue.increment(1),
      inTok: FieldValue.increment(Number(u.input_tokens) || 0),
      outTok: FieldValue.increment(Number(u.output_tokens) || 0),
      [`k_${bucket}`]: FieldValue.increment(1),
      ['fam_' + fid]: true,
    }, {merge: true}).catch(() => {});
  }
  return {text, truncated: out.stop_reason === 'max_tokens'};
});

/* ---------- Panel de administrador ---------- */
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
function cleanUrl(v) {
  const u = str(v, 500);
  if (!u) return '';
  if (!/^https:\/\/[^\s<>"']+$/i.test(u)) throw new HttpsError('invalid-argument', 'link');
  return u;
}
async function familyInfo(fid) {
  const fam = await db.doc(`families/${fid}`).get();
  if (!fam.exists) return null;
  const [plan, members] = await Promise.all([
    db.doc(`families/${fid}/meta/plan`).get(),
    db.collection(`families/${fid}/members`).get(),
  ]);
  const f = fam.data();
  return {
    id: fid, name: f.name || '', code: f.code || '', createdAt: f.createdAt || 0,
    plan: plan.exists ? plan.data() : {plan: 'free'},
    members: members.docs.map((d) => ({name: d.data().name || '', role: d.data().role || ''})),
  };
}
async function notifyStudents(fid, title, text) {
  const st = await db.collection(`families/${fid}/students`).get();
  const batch = db.batch();
  st.docs.forEach((d) => {
    batch.set(db.collection(`families/${fid}/notes`).doc(), {student: d.id, kind: 'pro', title, text, subject: '', at: Date.now(), read: false, done: false});
  });
  if (st.size) await batch.commit();
}

exports.admin = onCall({timeoutSeconds: 60, memory: '256MiB', maxInstances: 5}, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const tok = req.auth.token || {};
  const email = String(tok.email || '').toLowerCase();
  const data = req.data || {};
  const action = str(data.action, 30);
  if (!ADMIN_EMAILS.includes(email)) throw new HttpsError('permission-denied', 'not_admin');
  if (!tok.email_verified) {
    if (action === 'whoami') return {admin: true, verified: false};
    throw new HttpsError('permission-denied', 'unverified');
  }

  if (action === 'whoami') return {admin: true, verified: true};

  if (action === 'getBilling') {
    const b = await db.doc('public/billing').get();
    return b.exists ? b.data() : {};
  }

  if (action === 'setBilling') {
    const b = {
      monthlyUrl: cleanUrl(data.monthlyUrl), yearlyUrl: cleanUrl(data.yearlyUrl), paypalUrl: cleanUrl(data.paypalUrl),
      priceMonthly: str(data.priceMonthly, 30), priceYearly: str(data.priceYearly, 30),
      note: str(data.note, 400), updatedAt: Date.now(),
    };
    await db.doc('public/billing').set(b);
    return b;
  }

  if (action === 'pending') {
    const q = await db.collection('payReqs').where('status', '==', 'pending').limit(100).get();
    const list = await Promise.all(q.docs.map(async (d) => {
      const r = d.data();
      const f = await db.doc(`families/${r.familyId}`).get();
      return {id: d.id, ...r, familyName: f.exists ? f.data().name || '' : '(no existe)', code: f.exists ? f.data().code || '' : ''};
    }));
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return {list};
  }

  if (action === 'find') {
    const code = str(data.code, 10).toUpperCase();
    const c = await db.doc(`codes/${code}`).get();
    if (!c.exists) return {family: null};
    return {family: await familyInfo(c.data().familyId)};
  }

  if (action === 'setPlan') {
    const fid = str(data.familyId, 60);
    const days = Math.round(Number(data.days) || 0);
    if (!fid || days < 1 || days > 800) throw new HttpsError('invalid-argument', 'dias');
    const famRef = db.doc(`families/${fid}`);
    if (!(await famRef.get()).exists) throw new HttpsError('not-found', 'familia');
    const pref = db.doc(`families/${fid}/meta/plan`);
    const cur = (await pref.get()).data() || {};
    const base = isProPlan(cur) && cur.until ? cur.until : Date.now();
    const p = {
      plan: 'pro', until: base + days * DAY, since: isProPlan(cur) ? cur.since || Date.now() : Date.now(),
      cycle: days >= 300 ? 'year' : 'month', by: email, updatedAt: Date.now(), ref: str(data.ref, 120),
    };
    await pref.set(p);
    const reqId = str(data.reqId, 60);
    let rq = {};
    if (reqId) {
      rq = (await db.doc(`payReqs/${reqId}`).get()).data() || {};
      await db.doc(`payReqs/${reqId}`).set({status: 'done', doneAt: Date.now(), days}, {merge: true});
    }
    const fam = (await famRef.get()).data() || {};
    await db.collection('payments').add({
      familyId: fid, familyName: fam.name || '', code: fam.code || '', days, until: p.until,
      amount: money(data.amount), method: str(data.method || rq.method || 'manual', 20), cycle: p.cycle,
      ref: str(data.ref || rq.ref, 120), payer: str(rq.name, 80), at: Date.now(), by: email,
    });
    await notifyStudents(fid, '¡Tu familia activó StudyFlow Pro! 🚀', 'Ahora tienes más preguntas al tutor de IA, mini exámenes y puedes subir fotos del temario.');
    return {family: await familyInfo(fid)};
  }

  if (action === 'revoke') {
    const fid = str(data.familyId, 60);
    if (!fid) throw new HttpsError('invalid-argument', 'familia');
    await db.doc(`families/${fid}/meta/plan`).set({plan: 'free', updatedAt: Date.now(), by: email});
    return {family: await familyInfo(fid)};
  }

  if (action === 'history') {
    const q = await db.collection('payments').orderBy('at', 'desc').limit(300).get();
    return {list: q.docs.map((d) => ({id: d.id, ...d.data()}))};
  }

  if (action === 'summary') {
    const month = /^\d{4}-\d{2}$/.test(str(data.month, 7)) ? str(data.month, 7) : monthKey();
    const start = Date.parse(month + '-01T00:00:00Z');
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const [st, pays, all] = await Promise.all([
      db.doc(`stats/ai_${month}`).get(),
      db.collection('payments').where('at', '>=', start).where('at', '<', end.getTime()).get(),
      db.collection('payments').orderBy('at', 'desc').limit(2000).get(),
    ]);
    const s = st.exists ? st.data() : {};
    const inTok = s.inTok || 0, outTok = s.outTok || 0;
    const latest = {};
    all.docs.forEach((d) => { const x = d.data(); if (!latest[x.familyId] || latest[x.familyId] < x.until) latest[x.familyId] = x.until; });
    const now = Date.now();
    return {
      month, calls: s.calls || 0, inTok, outTok,
      byKind: {tutor: s.k_tutor || 0, quiz: s.k_quiz || 0, temario: s.k_temario || 0, otros: s.k_otros || 0},
      families: Object.keys(s).filter((k) => k.startsWith('fam_')).length,
      aiCost: Math.round((inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6 * 100) / 100,
      income: Math.round(pays.docs.reduce((a, d) => a + (d.data().amount || 0), 0) * 100) / 100,
      payments: pays.size,
      activePro: Object.values(latest).filter((u) => u > now).length,
    };
  }

  if (action === 'dismiss') {
    const reqId = str(data.reqId, 60);
    if (!reqId) throw new HttpsError('invalid-argument', 'pago');
    await db.doc(`payReqs/${reqId}`).set({status: 'dismissed', doneAt: Date.now()}, {merge: true});
    return {ok: true};
  }

  throw new HttpsError('invalid-argument', 'accion');
});


/* ---------- Confirmación de actividades por el docente (link sin cuenta) ---------- */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const LINK_DAYS = 7;

// La familia crea un link único para una actividad de su hijo o hija
exports.teacherReq = onCall({timeoutSeconds: 30, memory: '256MiB', maxInstances: 10}, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const uid = req.auth.uid, d = req.data || {};
  const user = (await db.doc(`users/${uid}`).get()).data();
  if (!user || !user.familyId) throw new HttpsError('failed-precondition', 'sin familia');
  const fid = user.familyId;
  const me = await db.doc(`families/${fid}/members/${uid}`).get();
  if (!me.exists || me.data().role !== 'parent') throw new HttpsError('permission-denied', 'solo madre o padre');
  const sid = str(d.studentId, 60), taskId = str(d.taskId, 60);
  if (!sid || !taskId) throw new HttpsError('invalid-argument', 'datos');
  const st = await db.doc(`families/${fid}/members/${sid}`).get();
  if (!st.exists || st.data().role !== 'student') throw new HttpsError('invalid-argument', 'estudiante');
  // Límite: 40 links por familia al día
  const cref = db.doc(`families/${fid}/usage/treq_${new Date().toISOString().slice(0, 10)}`);
  await db.runTransaction(async (t) => {
    const c = await t.get(cref);
    const n = c.exists ? c.data().n || 0 : 0;
    if (n >= 40) throw new HttpsError('resource-exhausted', 'limit');
    t.set(cref, {n: n + 1, at: Date.now()}, {merge: true});
  });
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  await db.doc(`teacherReqs/${token}`).set({
    familyId: fid, studentId: sid, studentName: str(st.data().name, 40).split(' ')[0] || 'Estudiante',
    taskId, title: str(d.title, 120), subject: str(d.subject, 60), due: str(d.due, 10), teacherName: str(d.teacherName, 60),
    status: 'pending', createdBy: uid, createdAt: now, expiresAt: now + LINK_DAYS * DAY,
  });
  return {token, expiresAt: now + LINK_DAYS * DAY};
});

async function loadReq(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new HttpsError('not-found', 'link');
  const ref = db.doc(`teacherReqs/${token}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'link');
  const r = snap.data();
  if (r.expiresAt < Date.now()) throw new HttpsError('failed-precondition', 'expired');
  return {ref, r};
}

// El docente abre el link: solo ve el primer nombre del estudiante y la actividad
exports.teacherGet = onCall({timeoutSeconds: 20, memory: '256MiB', maxInstances: 10}, async (req) => {
  const {r} = await loadReq((req.data || {}).token);
  return {studentName: r.studentName, title: r.title, subject: r.subject, due: r.due, teacherName: r.teacherName,
    result: r.result || '', comment: r.comment || '', expiresAt: r.expiresAt};
});

// El docente responde: Entregó / Tarde / No entregó (puede cambiarlo mientras el link siga vigente)
exports.teacherAnswer = onCall({timeoutSeconds: 20, memory: '256MiB', maxInstances: 10}, async (req) => {
  const d = req.data || {};
  const result = str(d.result, 12);
  if (!['entregada', 'tarde', 'no'].includes(result)) throw new HttpsError('invalid-argument', 'resultado');
  const comment = str(d.comment, 300);
  const {ref, r} = await loadReq(d.token);
  if ((r.answers || 0) >= 20) throw new HttpsError('resource-exhausted', 'limit');
  const now = Date.now();
  await ref.set({status: 'answered', result, comment, answeredAt: now, answers: FieldValue.increment(1)}, {merge: true});
  await db.doc(`families/${r.familyId}/teacherChecks/${r.studentId}_${r.taskId}`).set({
    student: r.studentId, taskId: r.taskId, title: r.title, result, comment, teacherName: r.teacherName, at: now,
  });
  return {ok: true};
});

/* ======================================================================
   Colegios: una sola función "school" con varias acciones.
   Todas las escrituras de colegios pasan por aquí; las reglas de Firestore
   solo permiten LEER (cada quien lo suyo).
   ====================================================================== */
const SCH_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EV_TYPES = ['tarea', 'examen', 'proyecto', 'actividad', 'lectura', 'laboratorio', 'cuaderno', 'exposicion', 'tema', 'evento', 'aviso', 'otro'];
const STAFF_ROLES = ['director', 'admin', 'nurse', 'teacher'];
const ADMIN_ROLES = ['director', 'admin'];
const NURSE_KINDS = {visita: 'Pasó a enfermería', malestar: 'Se sintió mal', golpe: 'Golpe o caída leve', medicina: 'Se le dio medicamento autorizado', retiro: 'Se recomienda recogerlo', otro: 'Otro aviso'};
const LEVELS = ['Parvularia 4', 'Parvularia 5', 'Parvularia 6', '1.º grado', '2.º grado', '3.º grado', '4.º grado', '5.º grado', '6.º grado', '7.º grado', '8.º grado', '9.º grado', '1.º bachillerato', '2.º bachillerato', '3.º bachillerato'];
const COLORS = ['#1f4e8c', '#0e7490', '#15803d', '#c2410c', '#b91c1c', '#be185d', '#6d28d9', '#a16207'];
function levelSubjects(lv) {
  if (/Parvularia/.test(lv)) return ['Lenguaje', 'Matemática', 'Arte', 'Música'];
  if (/bachillerato/.test(lv)) return ['Lenguaje y Literatura', 'Matemática', 'Ciencias Naturales', 'Estudios Sociales', 'Inglés', 'Informática', 'Orientación para la vida'];
  const n = parseInt(lv, 10);
  return n >= 7 ? ['Lenguaje', 'Matemática', 'Ciencias', 'Sociales', 'Inglés', 'Educación Física', 'Informática'] : ['Lenguaje', 'Matemática', 'Ciencias', 'Sociales', 'Inglés', 'Educación Física', 'Arte'];
}
const fail = (c) => { throw new HttpsError(c === 'forbidden' ? 'permission-denied' : c === 'not-found' ? 'not-found' : 'failed-precondition', c); };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = (v) => v === '' || /^\d{2}:\d{2}$/.test(String(v || ''));
const int = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
// Trimestre › Unidad › Tema (la fecha del tema la pone la docente; puede ir vacía)
const temaFields = (x) => ({tri: int(x && x.tri, 1, 4), unitNo: int(x && x.unitNo, 1, 40), unitName: str(x && x.unitName, 100), ord: int(x && x.ord, 0, 999)});
// Recordatorios del docente para los alumnos: días antes y hora
const cleanEvRems = (l) => (Array.isArray(l) ? l : []).slice(0, 4).map((r) => ({d: int(r && r.d, 0, 30), t: isTime(r && r.t) && r.t ? r.t : '18:00'}))
  .filter((r, i, a) => a.findIndex((q) => q.d === r.d && q.t === r.t) === i);
const isEmail = (v) => /^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,30}$/.test(v);
const gName = (g) => g ? (g.name + (g.section ? ' ' + g.section : '')) : '';
const newId = () => crypto.randomBytes(10).toString('hex');
function newCode() { const b = crypto.randomBytes(6); let s = ''; for (let i = 0; i < 6; i++) s += SCH_CH[b[i] % SCH_CH.length]; return s; }
function schoolActive(s) {
  if (!s || s.status === 'suspended') return false;
  return !s.until || s.until >= new Date().toISOString().slice(0, 10);
}
async function uniqueCode(t) {
  for (let i = 0; i < 8; i++) {
    const c = newCode();
    const d = t ? await t.get(db.doc(`schoolCodes/${c}`)) : await db.doc(`schoolCodes/${c}`).get();
    if (!d.exists) return c;
  }
  fail('invalid');
}
function cleanSubjects(list, teachers) {
  if (!Array.isArray(list) || list.length > 30) fail('invalid');
  const seen = {};
  return list.map((x, i) => {
    const name = str(x && x.name, 40);
    if (!name) return null;
    const k = name.toLowerCase();
    if (seen[k]) fail('invalid');
    seen[k] = 1;
    const tid = str(x.teacherId, 40);
    const t = tid && teachers[tid];
    return {id: /^[A-Za-z0-9_-]{1,40}$/.test(String(x.id || '')) ? x.id : 'sj' + newId().slice(0, 8), name,
      color: /^#[0-9a-fA-F]{6}$/.test(String(x.color || '')) ? x.color : COLORS[i % COLORS.length], teacherId: t ? tid : '', teacherName: t ? t.name : ''};
  }).filter(Boolean);
}
async function teachersOf(sid) {
  const q = await db.collection(`schools/${sid}/staff`).where('role', '==', 'teacher').get();
  const out = {};
  q.docs.forEach((d) => { out[d.id] = d.data(); });
  return out;
}
async function staffCtx(sid, uid) {
  if (!/^[A-Za-z0-9_-]{4,60}$/.test(String(sid || ''))) fail('invalid');
  const idx = await db.doc(`schools/${sid}/staffUids/${uid}`).get();
  if (!idx.exists) fail('forbidden');
  const st = await db.doc(`schools/${sid}/staff/${idx.data().staffId}`).get();
  if (!st.exists) fail('forbidden');
  const school = await db.doc(`schools/${sid}`).get();
  if (!school.exists) fail('not-found');
  return {role: st.data().role, staffId: st.id, staff: st.data(), school: school.data()};
}
// Recalcula qué grados puede ver cada familia (sus hijos aprobados)
async function syncFamAccess(sid, fid) {
  const q = await db.collection(`schools/${sid}/members`).where('familyId', '==', fid).get();
  const grades = {}, students = {};
  q.docs.forEach((d) => { grades[d.data().gradeId] = true; students[d.id] = d.data().gradeId; });
  const ref = db.doc(`schools/${sid}/famAccess/${fid}`), meta = db.doc(`families/${fid}/meta/school`);
  if (q.empty) {
    await ref.delete();
    await meta.set({schools: {[sid]: FieldValue.delete()}}, {merge: true});
  } else {
    await ref.set({grades, students, at: Date.now()});
    await meta.set({schools: {[sid]: true}}, {merge: true});
  }
}
async function revokeStaff(sid, st) {
  if (st.uid) {
    await db.doc(`schools/${sid}/staffUids/${st.uid}`).delete();
    const u = await db.doc(`users/${st.uid}`).get();
    if (u.exists) await u.ref.set({staff: (u.data().staff || []).filter((x) => x.schoolId !== sid)}, {merge: true});
  }
  if (st.email) await db.doc(`staffInvites/${st.email}__${sid}`).delete();
}

exports.school = onCall({timeoutSeconds: 120, memory: '512MiB', maxInstances: 10}, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Inicia sesión');
  const uid = req.auth.uid, tok = req.auth.token || {};
  const email = String(tok.email || '').toLowerCase(), verified = !!tok.email_verified;
  const data = req.data || {};
  const action = str(data.action, 30);
  const now = Date.now();
  const isPlatform = ADMIN_EMAILS.includes(email) && verified;

  /* ---------- Plataforma (administrador de StudyFlow) ---------- */
  // Dashboard de la plataforma: todo lo que maneja la app, en números
  if (action === 'plat.stats') {
    if (!isPlatform) fail('forbidden');
    const now = Date.now(), DAYMS = 86400000;
    const months = [];
    const base = new Date();
    for (let i = 5; i >= 0; i--) months.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    const cnt = async (q) => { try { return (await q.count().get()).data().count; } catch (e) { return 0; } };
    const [fams, mems, staff, schools, stus, pays, events, nurse, pend, groups, aiDocs] = await Promise.all([
      db.collection('families').select('createdAt').limit(20000).get(),
      db.collectionGroup('members').select('role', 'gradeId').limit(50000).get(),
      db.collectionGroup('staff').select('role', 'access').limit(20000).get(),
      db.collection('schools').get(),
      db.collectionGroup('students').limit(3000).get(),
      db.collection('payments').orderBy('at', 'desc').limit(3000).get(),
      cnt(db.collectionGroup('events')),
      cnt(db.collectionGroup('nurse')),
      cnt(db.collection('payReqs').where('status', '==', 'pending')),
      cnt(db.collection('studyGroups')),
      Promise.all(months.map((m) => db.doc(`stats/ai_${m}`).get())),
    ]);
    const famByMonth = months.map(() => 0);
    fams.docs.forEach((d) => { const k = new Date(d.data().createdAt || 0).toISOString().slice(0, 7); const i = months.indexOf(k); if (i >= 0) famByMonth[i]++; });
    let students = 0, parents = 0, schoolStudents = 0;
    mems.docs.forEach((d) => { const r = d.data().role; if (r === 'student') students++; else if (r === 'parent') parents++; else if (d.data().gradeId && d.ref.path.startsWith('schools/')) schoolStudents++; });
    const staffBy = {director: 0, admin: 0, nurse: 0, teacher: 0}; let staffActive = 0;
    staff.docs.forEach((d) => { const r = d.data().role; if (staffBy[r] != null) staffBy[r]++; if (d.data().access === 'active') staffActive++; });
    const today = new Date().toISOString().slice(0, 10), wk = new Date(now - 7 * DAYMS).toISOString().slice(0, 10);
    const use = {active7: 0, active30: 0, tasks: 0, done: 0, onTime: 0, bySchool: 0, byParent: 0, byStudent: 0, reminders: 0, studyMin7: 0, topics: 0, quizzes: 0, subjects: 0, grades: 0, overdue: 0};
    stus.docs.forEach((d) => {
      const x = d.data() || {}, S = x.data || {}, up = x.updatedAt || 0;
      if (up > now - 7 * DAYMS) use.active7++;
      if (up > now - 30 * DAYMS) use.active30++;
      (S.tasks || []).forEach((t) => {
        use.tasks++;
        if (t.done) { use.done++; if (t.doneAt && t.due && t.doneAt <= t.due) use.onTime++; } else if (t.due && t.due < today) use.overdue++;
        if (t.school) use.bySchool++; else if (t.by === 'parent') use.byParent++; else use.byStudent++;
        use.reminders += (t.reminders || []).length;
      });
      (S.sessions || []).forEach((z) => { if (z.date >= wk) use.studyMin7 += Math.round(+z.minutes || 0); });
      (S.topics || []).forEach((z) => { use.topics++; if (z.quiz) use.quizzes++; });
      use.subjects += (S.subjects || []).length;
      use.grades += (S.grades || []).length;
    });
    const month = months[months.length - 1];
    let income = 0, paysMonth = 0;
    const latest = {};
    pays.docs.forEach((d) => { const x = d.data(); if (new Date(x.at || 0).toISOString().slice(0, 7) === month) { income += x.amount || 0; paysMonth++; } if (!latest[x.familyId] || latest[x.familyId] < x.until) latest[x.familyId] = x.until; });
    const ai = aiDocs.map((d, i) => { const x = d.exists ? d.data() : {}; return {month: months[i], calls: x.calls || 0, cost: Math.round(((x.inTok || 0) * PRICE_IN + (x.outTok || 0) * PRICE_OUT) / 1e6 * 100) / 100,
      byKind: {tutor: x.k_tutor || 0, quiz: x.k_quiz || 0, temario: x.k_temario || 0, otros: x.k_otros || 0}}; });
    const sch = schools.docs.map((d) => d.data());
    return {
      at: now, months, famByMonth, families: fams.size, students, parents, schoolStudents, staffBy, staffActive,
      schools: sch.length, schoolsActive: sch.filter((x) => schoolActive(x)).length, schoolsTrial: sch.filter((x) => x.status === 'trial').length,
      expiring: sch.filter((x) => x.until && x.until >= today && x.until <= new Date(now + 30 * DAYMS).toISOString().slice(0, 10)).length,
      seats: sch.reduce((a, x) => a + (x.seats || 0), 0),
      events, nurse, pendingPays: pend, groups, use, ai,
      income: Math.round(income * 100) / 100, paysMonth, activePro: Object.values(latest).filter((u) => u > now).length,
    };
  }
  if (action === 'plat.list') {
    if (!isPlatform) fail('forbidden');
    const q = await db.collection('schools').get();
    const schools = await Promise.all(q.docs.map(async (d) => {
      const [m, r, g, s, n] = await Promise.all(['members', 'reqs', 'grades', 'staff'].map((c) => db.collection(`schools/${d.id}/${c}`).count().get())
        .concat([db.doc(`schoolsAdmin/${d.id}`).get()]));
      const ad = await db.collection(`schools/${d.id}/staff`).where('role', '==', 'admin').get();
      return Object.assign({id: d.id}, d.data(), {students: m.data().count, pending: r.data().count, grades: g.data().count, staff: s.data().count, notes: n.exists ? (n.data().notes || '') : '',
        admins: ad.docs.map((x) => ({name: x.data().name || '', email: x.data().email || '', access: x.data().access || 'none'}))});
    }));
    return {schools};
  }
  // Crear (o restablecer) el usuario y la contraseña del administrador de un colegio
  if (action === 'plat.login') {
    if (!isPlatform) fail('forbidden');
    const sid = str(data.id, 60);
    const em = str(data.email, 80).toLowerCase();
    const pw = String(data.password || '');
    const name = str(data.name, 60) || 'Administración';
    if (!isEmail(em) || pw.length < 8 || pw.length > 64) fail('invalid');
    const sdoc = await db.doc(`schools/${sid}`).get();
    if (!sdoc.exists) fail('not-found');
    const sq = await db.collection(`schools/${sid}/staff`).where('email', '==', em).get();
    let st = sq.docs[0];
    if (st && !ADMIN_ROLES.includes(st.data().role)) fail('exists');
    let user = null;
    try { user = await getAuth().getUserByEmail(em); } catch (e) { user = null; }
    if (user) {
      // Solo se cambia la contraseña de una cuenta que ya es administradora de ESTE colegio
      const idx = await db.doc(`schools/${sid}/staffUids/${user.uid}`).get();
      if (!idx.exists || !ADMIN_ROLES.includes(idx.data().role)) fail('exists');
      await getAuth().updateUser(user.uid, {password: pw});
    } else {
      user = await getAuth().createUser({email: em, password: pw, emailVerified: true, displayName: name});
    }
    if (!st) {
      const ref = db.collection(`schools/${sid}/staff`).doc();
      await ref.set({role: 'admin', name, email: em, phone: '', hours: '', grades: [], access: 'active', uid: user.uid, at: now});
      st = await ref.get();
    } else {
      await st.ref.set({access: 'active', uid: user.uid}, {merge: true});
    }
    await db.doc(`schools/${sid}/staffUids/${user.uid}`).set({staffId: st.id, role: st.data().role, at: now});
    const entry = {schoolId: sid, schoolName: sdoc.data().name || '', role: st.data().role, staffId: st.id};
    const u = await db.doc(`users/${user.uid}`).get();
    await db.doc(`users/${user.uid}`).set({name: (u.exists && u.data().name) || st.data().name || name,
      staff: ((u.exists && u.data().staff) || []).filter((x) => x.schoolId !== sid).concat([entry])}, {merge: true});
    await db.doc(`staffInvites/${em}__${sid}`).delete();
    return {email: em};
  }
  if (action === 'plat.save') {
    if (!isPlatform) fail('forbidden');
    const name = str(data.name, 120);
    if (!name) fail('invalid');
    const prof = {name, responsible: str(data.responsible, 80), phone: str(data.phone, 20), email: str(data.email, 80), address: str(data.address, 120), city: str(data.city, 60),
      seats: Math.max(1, Math.min(20000, parseInt(data.seats, 10) || 1)), until: isDate(data.until) ? data.until : '',
      plan: ['prueba', 'anual', 'mensual'].includes(data.plan) ? data.plan : 'prueba', status: ['trial', 'active', 'suspended'].includes(data.status) ? data.status : 'trial', updatedAt: now};
    let sid = str(data.id, 60);
    if (sid) {
      const ref = db.doc(`schools/${sid}`);
      if (!(await ref.get()).exists) fail('not-found');
      await ref.set(prof, {merge: true});
    } else {
      sid = db.collection('schools').doc().id;
      const code = await uniqueCode();
      await db.doc(`schools/${sid}`).set(Object.assign({code, year: String(new Date().getFullYear()), createdAt: now}, prof));
      await db.doc(`schoolCodes/${code}`).set({schoolId: sid, at: now});
      const levels = (Array.isArray(data.levels) ? data.levels : []).filter((l) => LEVELS.includes(l)).slice(0, 20);
      const secs = Math.max(1, Math.min(4, parseInt(data.sections, 10) || 1));
      const batch = db.batch();
      levels.forEach((lv) => {
        for (let k = 0; k < secs; k++) {
          batch.set(db.collection(`schools/${sid}/grades`).doc(), {name: lv, section: String.fromCharCode(65 + k), order: LEVELS.indexOf(lv), tutorId: '',
            subjects: levelSubjects(lv).map((n, j) => ({id: 'sj' + j, name: n, color: COLORS[j % COLORS.length], teacherId: '', teacherName: ''}))});
        }
      });
      const ae = str(data.adminEmail, 80).toLowerCase();
      if (ae && isEmail(ae)) {
        const stRef = db.collection(`schools/${sid}/staff`).doc();
        batch.set(stRef, {role: 'admin', name: str(data.adminName, 60) || prof.responsible || 'Administración', email: ae, phone: '', hours: '', grades: [], access: 'invited', at: now});
        batch.set(db.doc(`staffInvites/${ae}__${sid}`), {email: ae, schoolId: sid, staffId: stRef.id, role: 'admin', schoolName: name, at: now});
      }
      await batch.commit();
    }
    await db.doc(`schoolsAdmin/${sid}`).set({notes: str(data.notes, 300), by: email, at: now}, {merge: true});
    return {id: sid};
  }

  /* ---------- Invitaciones para el personal ---------- */
  if (action === 'invites.mine') {
    if (!email) return {invites: []};
    if (!verified) return {invites: [], verify: true};
    const q = await db.collection('staffInvites').where('email', '==', email).get();
    return {invites: q.docs.map((d) => ({schoolId: d.data().schoolId, schoolName: d.data().schoolName, role: d.data().role}))};
  }
  if (action === 'invite.accept') {
    if (!verified) fail('verify');
    const sid = str(data.schoolId, 60);
    const inv = await db.doc(`staffInvites/${email}__${sid}`).get();
    if (!inv.exists) fail('no-invite');
    const st = await db.doc(`schools/${sid}/staff/${inv.data().staffId}`).get();
    if (!st.exists) { await inv.ref.delete(); fail('no-invite'); }
    const sc = (await db.doc(`schools/${sid}`).get()).data() || {};
    const entry = {schoolId: sid, schoolName: sc.name || '', role: st.data().role, staffId: st.id};
    await st.ref.set({uid, access: 'active', joinedAt: now}, {merge: true});
    await db.doc(`schools/${sid}/staffUids/${uid}`).set({staffId: st.id, role: st.data().role, at: now});
    const u = await db.doc(`users/${uid}`).get();
    const list = ((u.exists && u.data().staff) || []).filter((x) => x.schoolId !== sid).concat([entry]);
    await db.doc(`users/${uid}`).set({staff: list, name: (u.exists && u.data().name) || st.data().name}, {merge: true});
    await inv.ref.delete();
    return entry;
  }

  /* ---------- Estudiante: unirse a su colegio ---------- */
  if (action === 'stu.lookup' || action === 'stu.request') {
    const code = str(data.code, 6).toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) fail('bad-code');
    const c = await db.doc(`schoolCodes/${code}`).get();
    if (!c.exists) fail('bad-code');
    const sid = c.data().schoolId;
    const sdoc = await db.doc(`schools/${sid}`).get();
    if (!sdoc.exists || sdoc.data().code !== code) fail('bad-code');
    const sc = sdoc.data();
    if (!schoolActive(sc)) fail('inactive');
    const gq = await db.collection(`schools/${sid}/grades`).get();
    const grades = gq.docs.map((d) => Object.assign({id: d.id}, d.data())).sort((a, b) => (a.order || 0) - (b.order || 0) || (gName(a) < gName(b) ? -1 : 1));
    if (action === 'stu.lookup') return {schoolId: sid, name: sc.name, grades: grades.map((g) => ({id: g.id, name: gName(g)}))};
    // Solicitud: solo estudiantes que pertenecen a una familia
    const u = (await db.doc(`users/${uid}`).get()).data() || {};
    const fid = u.familyId;
    if (!fid) fail('forbidden');
    const mem = await db.doc(`families/${fid}/members/${uid}`).get();
    if (!mem.exists || mem.data().role !== 'student') fail('forbidden');
    const g = grades.find((x) => x.id === str(data.gradeId, 60));
    if (!g) fail('invalid');
    if ((await db.doc(`schools/${sid}/members/${uid}`).get()).exists) fail('already');
    const prev = u.school;
    if (prev && prev.schoolId && prev.schoolId !== sid) {
      await db.doc(`schools/${prev.schoolId}/reqs/${uid}`).delete().catch(() => {});
      if ((await db.doc(`schools/${prev.schoolId}/members/${uid}`).get()).exists) {
        await db.doc(`schools/${prev.schoolId}/members/${uid}`).delete();
        await syncFamAccess(prev.schoolId, fid);
      }
    }
    const fam = (await db.doc(`families/${fid}`).get()).data() || {};
    await db.doc(`schools/${sid}/reqs/${uid}`).set({name: str(mem.data().name || u.name, 60) || 'Estudiante', gradeId: g.id, familyId: fid, family: str(fam.name, 60), at: now, status: 'pending'});
    await db.doc(`users/${uid}`).set({school: {schoolId: sid, schoolName: sc.name, gradeId: g.id, gradeName: gName(g), status: 'pending'}}, {merge: true});
    return {};
  }
  if (action === 'stu.leave') {
    const u = (await db.doc(`users/${uid}`).get()).data() || {};
    const l = u.school;
    if (l && l.schoolId) {
      await db.doc(`schools/${l.schoolId}/reqs/${uid}`).delete().catch(() => {});
      const m = await db.doc(`schools/${l.schoolId}/members/${uid}`).get();
      if (m.exists) { await m.ref.delete(); await syncFamAccess(l.schoolId, m.data().familyId); }
    }
    await db.doc(`users/${uid}`).set({school: FieldValue.delete()}, {merge: true});
    return {};
  }

  /* ---------- Personal del colegio ---------- */
  const sid = str(data.schoolId, 60);
  const ctx = await staffCtx(sid, uid);
  const isAdmin = ADMIN_ROLES.includes(ctx.role);
  const needAdmin = () => { if (!isAdmin) fail('forbidden'); };

  if (action === 'sch.profile') {
    needAdmin();
    const o = {};
    ['name', 'responsible', 'address', 'phone', 'email', 'city', 'year', 'hours', 'motto'].forEach((k) => { if (data[k] != null) o[k] = str(data[k], 120); });
    if (o.name === '') fail('invalid');
    o.updatedAt = now;
    await db.doc(`schools/${sid}`).set(o, {merge: true});
    return {};
  }
  if (action === 'sch.code') {
    needAdmin();
    const code = await uniqueCode();
    await db.doc(`schoolCodes/${code}`).set({schoolId: sid, at: now});
    if (ctx.school.code) await db.doc(`schoolCodes/${ctx.school.code}`).delete();
    await db.doc(`schools/${sid}`).set({code}, {merge: true});
    return {code};
  }
  if (action === 'grade.save' || action === 'grades.quick') {
    needAdmin();
    const teachers = await teachersOf(sid);
    const touched = [];
    if (action === 'grades.quick') {
      const levels = (Array.isArray(data.levels) ? data.levels : []).filter((l) => LEVELS.includes(l)).slice(0, 20);
      const secs = Math.max(1, Math.min(4, parseInt(data.sections, 10) || 1));
      const have = (await db.collection(`schools/${sid}/grades`).get()).docs.map((d) => d.data().name + '|' + (d.data().section || ''));
      const batch = db.batch();
      levels.forEach((lv) => {
        for (let k = 0; k < secs; k++) {
          const sec = String.fromCharCode(65 + k);
          if (have.includes(lv + '|' + sec)) continue;
          batch.set(db.collection(`schools/${sid}/grades`).doc(), {name: lv, section: sec, order: LEVELS.indexOf(lv), tutorId: '',
            subjects: levelSubjects(lv).map((n, j) => ({id: 'sj' + j, name: n, color: COLORS[j % COLORS.length], teacherId: '', teacherName: ''}))});
        }
      });
      await batch.commit();
      return {};
    }
    const name = str(data.name, 40);
    if (!name) fail('invalid');
    const gid = str(data.id, 60);
    const ref = gid ? db.doc(`schools/${sid}/grades/${gid}`) : db.collection(`schools/${sid}/grades`).doc();
    if (gid && !(await ref.get()).exists) fail('not-found');
    const subjects = cleanSubjects(data.subjects || [], teachers);
    const tutorId = teachers[str(data.tutorId, 40)] ? str(data.tutorId, 40) : '';
    await ref.set({name, section: str(data.section, 10), order: LEVELS.includes(name) ? LEVELS.indexOf(name) : 99, subjects, tutorId}, {merge: true});
    // Los docentes con materias en este grado quedan asignados al grado
    const batch = db.batch();
    Object.keys(teachers).forEach((tid) => {
      const uses = subjects.some((x) => x.teacherId === tid) || tutorId === tid;
      const g = teachers[tid].grades || [];
      if (uses && !g.includes(ref.id)) { batch.set(db.doc(`schools/${sid}/staff/${tid}`), {grades: g.concat([ref.id])}, {merge: true}); touched.push(tid); }
    });
    if (touched.length) await batch.commit();
    return {id: ref.id};
  }
  if (action === 'grade.del') {
    needAdmin();
    const gid = str(data.id, 60);
    const m = await db.collection(`schools/${sid}/members`).where('gradeId', '==', gid).limit(1).get();
    if (!m.empty) fail('invalid');
    const evs = await db.collection(`schools/${sid}/grades/${gid}/events`).get();
    const batch = db.batch();
    evs.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(db.doc(`schools/${sid}/grades/${gid}`));
    await batch.commit();
    return {};
  }
  if (action === 'staff.save') {
    needAdmin();
    const role = STAFF_ROLES.includes(data.role) ? data.role : '';
    const name = str(data.name, 60);
    const em = str(data.email, 80).toLowerCase();
    if (!role || !name || (em && !isEmail(em))) fail('invalid');
    const id = str(data.id, 60);
    const ref = id ? db.doc(`schools/${sid}/staff/${id}`) : db.collection(`schools/${sid}/staff`).doc();
    const old = id ? await ref.get() : null;
    if (id && !old.exists) fail('not-found');
    const prev = old ? old.data() : {access: 'none'};
    if (em) {
      const dup = await db.collection(`schools/${sid}/staff`).where('email', '==', em).get();
      if (dup.docs.some((d) => d.id !== ref.id)) fail('exists');
    }
    if (id === ctx.staffId && role !== prev.role) fail('forbidden');
    const gq = await db.collection(`schools/${sid}/grades`).get();
    const gids = gq.docs.map((d) => d.id);
    const grades = role === 'teacher' ? (Array.isArray(data.grades) ? data.grades : []).filter((g) => gids.includes(g)).slice(0, 60) : [];
    const wantAccess = !!data.access && !!em;
    let access = prev.access || 'none';
    // Si cambió el correo o el cargo de alguien con acceso, se revoca y se invita de nuevo
    if (prev.access === 'active' && (prev.email !== em || prev.role !== role || !wantAccess)) { await revokeStaff(sid, prev); access = 'none'; }
    if (prev.email && prev.email !== em) await db.doc(`staffInvites/${prev.email}__${sid}`).delete();
    const o = {role, name, email: em, phone: str(data.phone, 20), hours: str(data.hours, 60), grades, at: now};
    if (wantAccess && access !== 'active') {
      access = 'invited';
      await db.doc(`staffInvites/${em}__${sid}`).set({email: em, schoolId: sid, staffId: ref.id, role, schoolName: ctx.school.name || '', at: now});
    }
    if (!wantAccess && access === 'invited') { await db.doc(`staffInvites/${em}__${sid}`).delete(); access = 'none'; }
    o.access = access;
    if (access !== 'active') o.uid = FieldValue.delete();
    await ref.set(o, {merge: true});
    if (access === 'active' && prev.uid) await db.doc(`schools/${sid}/staffUids/${prev.uid}`).set({staffId: ref.id, role, at: now});
    // Nombre del docente en las materias (los alumnos no leen la lista de personal)
    if (role === 'teacher' && prev.name !== name) {
      const b2 = db.batch();
      let n = 0;
      gq.docs.forEach((d) => {
        const subs = d.data().subjects || [];
        if (subs.some((x) => x.teacherId === ref.id)) { b2.set(d.ref, {subjects: subs.map((x) => x.teacherId === ref.id ? Object.assign({}, x, {teacherName: name}) : x)}, {merge: true}); n++; }
      });
      if (n) await b2.commit();
    }
    return {id: ref.id};
  }
  // El administrador crea (o restablece) usuario y contraseña de su personal
  if (action === 'staff.login') {
    needAdmin();
    const id = str(data.id, 60);
    const pw = String(data.password || '');
    if (pw.length < 8 || pw.length > 64) fail('invalid');
    const ref = db.doc(`schools/${sid}/staff/${id}`);
    const st = await ref.get();
    if (!st.exists) fail('not-found');
    const em = String(st.data().email || '').toLowerCase();
    if (!isEmail(em)) fail('invalid');
    let user = null;
    try { user = await getAuth().getUserByEmail(em); } catch (e) { user = null; }
    if (user) {
      // Solo se cambia la contraseña de una cuenta que ya pertenece a ESTE registro del colegio
      const idx = await db.doc(`schools/${sid}/staffUids/${user.uid}`).get();
      if (!idx.exists || idx.data().staffId !== id) fail('exists');
      await getAuth().updateUser(user.uid, {password: pw});
    } else {
      user = await getAuth().createUser({email: em, password: pw, emailVerified: true, displayName: st.data().name || ''});
    }
    await ref.set({access: 'active', uid: user.uid}, {merge: true});
    await db.doc(`schools/${sid}/staffUids/${user.uid}`).set({staffId: id, role: st.data().role, at: now});
    const entry = {schoolId: sid, schoolName: ctx.school.name || '', role: st.data().role, staffId: id};
    const u = await db.doc(`users/${user.uid}`).get();
    await db.doc(`users/${user.uid}`).set({name: (u.exists && u.data().name) || st.data().name || '',
      staff: ((u.exists && u.data().staff) || []).filter((x) => x.schoolId !== sid).concat([entry])}, {merge: true});
    await db.doc(`staffInvites/${em}__${sid}`).delete();
    return {email: em};
  }
  if (action === 'staff.del') {
    needAdmin();
    const id = str(data.id, 60);
    if (id === ctx.staffId) fail('forbidden');
    const ref = db.doc(`schools/${sid}/staff/${id}`);
    const st = await ref.get();
    if (!st.exists) return {};
    await revokeStaff(sid, st.data());
    const gq = await db.collection(`schools/${sid}/grades`).get();
    const batch = db.batch();
    gq.docs.forEach((d) => {
      const subs = d.data().subjects || [];
      if (subs.some((x) => x.teacherId === id) || d.data().tutorId === id) {
        batch.set(d.ref, {subjects: subs.map((x) => x.teacherId === id ? Object.assign({}, x, {teacherId: '', teacherName: ''}) : x), tutorId: d.data().tutorId === id ? '' : d.data().tutorId || ''}, {merge: true});
      }
    });
    batch.delete(ref);
    await batch.commit();
    return {};
  }
  if (action === 'req.approve' || action === 'member.move') {
    needAdmin();
    const suid = str(data.uid, 128);
    const g = await db.doc(`schools/${sid}/grades/${str(data.gradeId, 60)}`).get();
    if (!g.exists) fail('invalid');
    const gname = gName(g.data());
    let fid;
    if (action === 'req.approve') {
      const r = await db.doc(`schools/${sid}/reqs/${suid}`).get();
      if (!r.exists) fail('not-found');
      const cnt = (await db.collection(`schools/${sid}/members`).count().get()).data().count;
      if (ctx.school.seats && cnt >= ctx.school.seats) fail('no-seats');
      fid = r.data().familyId;
      await db.doc(`schools/${sid}/members/${suid}`).set({name: r.data().name, family: r.data().family || '', familyId: fid, gradeId: g.id, at: now, by: ctx.staffId});
      await r.ref.delete();
    } else {
      const m = await db.doc(`schools/${sid}/members/${suid}`).get();
      if (!m.exists) fail('not-found');
      fid = m.data().familyId;
      await m.ref.set({gradeId: g.id}, {merge: true});
    }
    await syncFamAccess(sid, fid);
    await db.doc(`users/${suid}`).set({school: {schoolId: sid, schoolName: ctx.school.name || '', gradeId: g.id, gradeName: gname, status: 'approved'}}, {merge: true});
    return {};
  }
  if (action === 'req.reject') {
    needAdmin();
    const suid = str(data.uid, 128);
    const r = await db.doc(`schools/${sid}/reqs/${suid}`).get();
    if (r.exists) {
      await r.ref.delete();
      const u = await db.doc(`users/${suid}`).get();
      if (u.exists && u.data().school && u.data().school.schoolId === sid) await u.ref.set({school: Object.assign({}, u.data().school, {status: 'rejected'})}, {merge: true});
    }
    return {};
  }
  if (action === 'member.remove') {
    needAdmin();
    const suid = str(data.uid, 128);
    const m = await db.doc(`schools/${sid}/members/${suid}`).get();
    if (!m.exists) return {};
    await m.ref.delete();
    await syncFamAccess(sid, m.data().familyId);
    const u = await db.doc(`users/${suid}`).get();
    if (u.exists && u.data().school && u.data().school.schoolId === sid) await u.ref.set({school: FieldValue.delete()}, {merge: true});
    return {};
  }
  // Tipos de actividad propios del colegio (los agregan docentes o administración)
  if (action === 'sch.addType') {
    if (!isAdmin && ctx.role !== 'teacher') fail('forbidden');
    const name = str(data.name, 30);
    if (!name) fail('invalid');
    const list = (ctx.school.types || []).filter((x) => x && x.name);
    if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) return {};
    if (list.length >= 30) fail('invalid');
    await db.doc(`schools/${sid}`).set({types: list.concat([{name, emoji: str(data.emoji, 8) || '🗂️'}])}, {merge: true});
    return {};
  }
  // Temario completo: muchos temas de una materia y grado en una sola vez
  if (action === 'ev.bulk') {
    const gid = str(data.gradeId, 60);
    // El temario lo carga la administración (una vez para todas las secciones)
    if (!isAdmin) fail('forbidden');
    const g = await db.doc(`schools/${sid}/grades/${gid}`).get();
    if (!g.exists) fail('not-found');
    const subjectId = str(data.subjectId, 40);
    if (!(g.data().subjects || []).some((x) => x.id === subjectId)) fail('invalid');
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 200).map((x) => Object.assign({title: str(x && x.title, 120), date: x && isDate(x.date) ? x.date : ''}, temaFields(x))).filter((x) => x.title);
    if (!items.length) fail('invalid');
    const batch = db.batch();
    items.forEach((x) => batch.set(db.collection(`schools/${sid}/grades/${gid}/events`).doc(), Object.assign({type: 'tema', typeName: '', typeEmoji: '', subjectId, time: '', note: '', by: ctx.staffId, byName: ctx.staff.name || '', at: now}, x)));
    await batch.commit();
    return {n: items.length};
  }
  if (action === 'ev.save' || action === 'ev.del') {
    const gid = str(data.gradeId, 60);
    if (!isAdmin && !(ctx.role === 'teacher' && (ctx.staff.grades || []).includes(gid))) fail('forbidden');
    const g = await db.doc(`schools/${sid}/grades/${gid}`).get();
    if (!g.exists) fail('not-found');
    const eid = str(data.id, 60);
    const ref = eid ? db.doc(`schools/${sid}/grades/${gid}/events/${eid}`) : db.collection(`schools/${sid}/grades/${gid}/events`).doc();
    const cur = eid ? await ref.get() : null;
    // La docente no crea, cambia ni borra temas del temario
    if (!isAdmin && cur && cur.exists && cur.data().type === 'tema') fail('forbidden');
    if (action === 'ev.del') { await ref.delete(); return {}; }
    if (eid && !cur.exists) fail('not-found');
    const type = EV_TYPES.includes(data.type) ? data.type : '';
    if (type === 'tema' && !isAdmin) fail('forbidden');
    const title = str(data.title, 120);
    const subjectId = str(data.subjectId, 40);
    if (!type || !title || !(isDate(data.date) || (type === 'tema' && !data.date)) || !isTime(data.time || '')) fail('invalid');
    if (subjectId && !(g.data().subjects || []).some((x) => x.id === subjectId)) fail('invalid');
    if (!subjectId && !isAdmin && ['tarea', 'examen', 'proyecto', 'actividad', 'lectura', 'laboratorio', 'cuaderno', 'exposicion', 'tema', 'otro'].includes(type)) fail('invalid');
    const typeName = type === 'otro' ? str(data.typeName, 30) : '';
    if (type === 'otro' && !typeName) fail('invalid');
    const topicId = str(data.topicId, 60);
    if (topicId) { const tp = await db.doc(`schools/${sid}/grades/${gid}/events/${topicId}`).get(); if (!tp.exists || tp.data().type !== 'tema') fail('invalid'); }
    const extra = type === 'tema' ? temaFields(data) : {rems: cleanEvRems(data.rems)};
    // Al editar un tema se conserva la fecha que puso la docente, salvo que venga una nueva
    const date = type === 'tema' && !data.date && cur && cur.exists ? (cur.data().date || '') : (data.date || '');
    await ref.set(Object.assign({topicId: type === 'tema' ? '' : topicId, type, typeName, typeEmoji: type === 'otro' ? str(data.typeEmoji, 8) : '', title, subjectId, date, time: data.time || '', note: str(data.note, 300), by: ctx.staffId, byName: ctx.staff.name || '', at: now}, extra));
    return {id: ref.id};
  }
  // La docente pone (o quita) la fecha en que verá un tema
  if (action === 'tema.date') {
    const gid = str(data.gradeId, 60);
    if (!isAdmin && !(ctx.role === 'teacher' && (ctx.staff.grades || []).includes(gid))) fail('forbidden');
    const ids = (Array.isArray(data.items) ? data.items : [{id: data.id, date: data.date}]).slice(0, 100);
    if (!ids.length) fail('invalid');
    const g = await db.doc(`schools/${sid}/grades/${gid}`).get();
    if (!g.exists) fail('not-found');
    const subs = g.data().subjects || [];
    const batch = db.batch();
    for (const it of ids) {
      const date = it && it.date ? String(it.date) : '';
      if (date && !isDate(date)) fail('invalid');
      const ref = db.doc(`schools/${sid}/grades/${gid}/events/${str(it && it.id, 60)}`);
      const cur = await ref.get();
      if (!cur.exists || cur.data().type !== 'tema') fail('not-found');
      const sj = subs.find((x) => x.id === cur.data().subjectId);
      if (!isAdmin && sj && sj.teacherId && sj.teacherId !== ctx.staffId) fail('forbidden');
      batch.set(ref, {date, dateBy: ctx.staff.name || '', dateAt: now}, {merge: true});
    }
    await batch.commit();
    return {n: ids.length};
  }
  // Trimestre en curso y cuántos tiene el año (3 trimestres o 4 periodos)
  if (action === 'sch.tri') {
    needAdmin();
    const o = {};
    if (data.cur != null) o.curTri = int(data.cur, 1, 4);
    if (data.n != null) o.nTri = int(data.n, 3, 4);
    if (!Object.keys(o).length) fail('invalid');
    await db.doc(`schools/${sid}`).set(o, {merge: true});
    return {};
  }
  if (action === 'nurse.send') {
    if (!isAdmin && ctx.role !== 'nurse') fail('forbidden');
    const suid = str(data.uid, 128);
    const text = str(data.text, 500);
    const kind = NURSE_KINDS[data.kind] ? data.kind : 'otro';
    if (!text) fail('invalid');
    const m = await db.doc(`schools/${sid}/members/${suid}`).get();
    if (!m.exists) fail('not-found');
    const day = new Date().toISOString().slice(0, 10);
    const cref = db.doc(`schools/${sid}/usage/nurse_${day}`);
    await db.runTransaction(async (t) => {
      const c = await t.get(cref);
      if ((c.exists ? c.data().n || 0 : 0) >= 300) fail('invalid');
      t.set(cref, {n: FieldValue.increment(1)}, {merge: true});
    });
    const rec = {student: suid, studentName: m.data().name || '', gradeId: m.data().gradeId || '', kind, text, at: now, by: ctx.staffId, byName: ctx.staff.name || ''};
    await db.collection(`schools/${sid}/nurse`).add(rec);
    await db.collection(`families/${m.data().familyId}/schoolNotes`).add({student: suid, kind: 'nurse', title: NURSE_KINDS[kind], text, from: ctx.staff.name || 'Enfermería', school: ctx.school.name || '', schoolId: sid, at: now});
    return {};
  }
  fail('invalid');
});
