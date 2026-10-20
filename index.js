/* StudyFlow: función "ai".
   Recibe las preguntas de la app, revisa el plan y los límites de la familia,
   y llama a la API de Claude con tu llave secreta (que nunca llega al celular). */
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
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
  const plan = planDoc.plan === 'pro' ? 'pro' : 'free';
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

  // Llamada a Claude
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY.value(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({model: MODEL, max_tokens: MAX_TOKENS, messages: clean}),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('Anthropic', res.status, body.slice(0, 500));
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'busy');
    throw new HttpsError('unavailable', 'ai_error');
  }
  const out = await res.json();
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return {text, truncated: out.stop_reason === 'max_tokens'};
});
