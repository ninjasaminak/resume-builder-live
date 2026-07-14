import Stripe from 'stripe';
import admin from 'firebase-admin';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

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

// Using the Web-standard Request/Response signature (rather than Node's req/res)
// so the raw body comes straight from request.text() with no framework-level
// JSON parsing in between — that parsing was silently mangling the bytes Stripe
// signed, which broke signature verification under the (req, res) style handler.
export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(
      'Webhook signature verification failed:', err.message,
      '| rawBody length:', rawBody.length,
      '| has signature header:', Boolean(signature)
    );
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return Response.json({ received: true });
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
    return Response.json({ received: true, warning: 'unrecognized tier' });
  }

  if (!customerEmail) {
    console.error(`Session ${session.id} has no customer email`);
    return Response.json({ received: true, warning: 'no customer email' });
  }

  try {
    // Using the Checkout Session id as the Firestore doc id makes this idempotent —
    // if Stripe retries the webhook, we won't mint a second code for the same purchase.
    const docRef = db.collection('licenseCodes').doc(session.id);
    const existing = await docRef.get();
    if (existing.exists) {
      return Response.json({ received: true, duplicate: true });
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

    return Response.json({ received: true, code });
  } catch (err) {
    console.error('Error processing checkout.session.completed:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
}
