const crypto = require('crypto');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const { Resend } = require('resend');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function readRawBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

const TIER_PREFIX = { premium: 'PREM', luxury: 'LUX', elite: 'ELITE' };

// Payment Links don't expose a metadata field in the current Stripe dashboard UI,
// so tiers are identified by which Price was purchased instead. Set these env vars
// to the Price IDs (price_...) behind each tier's Payment Link.
function priceIdToTier(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_PREMIUM]: 'premium',
    [process.env.STRIPE_PRICE_LUXURY]: 'luxury',
    [process.env.STRIPE_PRICE_ELITE]: 'elite',
  };
  return map[priceId];
}

function generateLicenseCode(tier) {
  const prefix = TIER_PREFIX[tier] || 'GEN';
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${random}`;
}

// Manually recomputes the HMAC Stripe should have sent, purely for diagnostics
// when verification fails — lets us tell apart "wrong secret" from "wrong body"
// without exposing the secret itself in logs.
function debugSignatureMismatch(rawBody, signatureHeader, secret) {
  try {
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((p) => p.split('='))
    );
    const timestamp = parts.t;
    const expectedSig = parts.v1;
    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const computedSig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return {
      timestamp,
      expectedSigPrefix: expectedSig ? expectedSig.slice(0, 8) : null,
      computedSigPrefix: computedSig.slice(0, 8),
      match: computedSig === expectedSig,
    };
  } catch (e) {
    return { debugError: e.message };
  }
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  let event;
  let rawBody;
  const signature = req.headers['stripe-signature'];
  try {
    rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const debug = signature && rawBody
      ? debugSignatureMismatch(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)
      : { note: 'missing signature header or empty body' };
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
    console.error(
      'Webhook signature verification failed:', err.message,
      '| rawBody length:', rawBody ? rawBody.length : 'undefined',
      '| debug:', JSON.stringify(debug),
      '| secretHash:', secretHash,
      '| secretLength:', secret.length
    );
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ received: true });
    return;
  }

  const session = event.data.object;
  const customerEmail = session.customer_details && session.customer_details.email;

  let tier;
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const priceId = lineItems.data[0] && lineItems.data[0].price && lineItems.data[0].price.id;
    tier = priceIdToTier(priceId);
  } catch (err) {
    console.error(`Failed to look up line items for session ${session.id}:`, err.message);
  }

  if (!tier) {
    console.error(`Session ${session.id} price did not match any known tier`);
    res.status(200).json({ received: true, warning: 'unrecognized tier' });
    return;
  }

  if (!customerEmail) {
    console.error(`Session ${session.id} has no customer email`);
    res.status(200).json({ received: true, warning: 'no customer email' });
    return;
  }

  try {
    // Using the Checkout Session id as the Firestore doc id makes this idempotent —
    // if Stripe retries the webhook, we won't mint a second code for the same purchase.
    const docRef = db.collection('licenseCodes').doc(session.id);
    const existing = await docRef.get();
    if (existing.exists) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    const code = generateLicenseCode(tier);
    await docRef.set({
      code,
      tier,
      isUsed: false,
      usedBy: 'unused',
    });

    await resend.emails.send({
      from: 'Atelier Resume <onboarding@resend.dev>',
      to: customerEmail,
      subject: 'Your Atelier Resume license code',
      html: `<p>Thanks for subscribing to the <strong>${tier}</strong> tier!</p>
             <p>Your license code is:</p>
             <p style="font-size:20px; font-weight:bold;">${code}</p>
             <p>Enter this code when creating your account at resume-builder-live-sepia.vercel.app</p>`,
    });

    res.status(200).json({ received: true, code });
  } catch (err) {
    console.error('Error processing checkout.session.completed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};

// Vercel parses the body as JSON by default, which breaks Stripe's signature check —
// this opts the function out so we can read the exact raw bytes Stripe signed.
// Must be set directly on the exported handler, since reassigning module.exports
// afterward would wipe out a config set on a separate object.
handler.config = { api: { bodyParser: false } };
module.exports = handler;
