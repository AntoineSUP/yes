// functions/create-checkout.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch  = require('node-fetch');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin' : process.env.SITE_URL,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function getShippingAmountCents(shipping) {
  const scAuth = 'Basic ' + Buffer.from(
    `${process.env.SENDCLOUD_PUBLIC_KEY}:${process.env.SENDCLOUD_SECRET_KEY}`
  ).toString('base64');

  const bodyV3 = {
    from_country_code: process.env.SENDCLOUD_SENDER_COUNTRY || 'FR',
    from_postal_code:  process.env.SENDCLOUD_SENDER_POSTAL,
    to_country_code:   shipping.country || 'FR',
    to_postal_code:    shipping.postal_code,
    weight:            { value: '1', unit: 'kg' },
    functionalities:   { b2c: true }
  };

  if (shipping.id) {
    // point relais
    bodyV3.functionalities.is_service_point_required = true;
    bodyV3.carrier_code = shipping.carrier_code;
  } else {
    // à domicile, par défaut Colissimo
    bodyV3.carrier_code = shipping.carrier_code || 'colissimo';
  }

  const res  = await fetch(
    'https://panel.sendcloud.sc/api/v3/fetch-shipping-options',
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': scAuth
      },
      body: JSON.stringify(bodyV3)
    }
  );
  const json = await res.json();

  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error('Aucune option de livraison disponible');
  }

  // on sélectionne soit précisément le service point, soit colissimo home
  let option = shipping.id
    ? json.data.find(o => o.requirements.is_service_point_required)
    : json.data.find(o => o.code.startsWith('colissimo:home'));
  if (!option) option = json.data[0];

  const quote = option.quotes?.[0];
  const value = parseFloat(quote.price.total.value);
  if (isNaN(value)) {
    throw new Error('Prix de livraison invalide');
  }
  return Math.round(value * 100);
}

exports.handler = async (event) => {
  // 1) CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  // 2) Only POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers:    { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
      body:       JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  // 3) Parse body
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers:    CORS_HEADERS,
      body:       JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { shipping, name, email, dedicace } = payload;
  if (!shipping || !name || !email) {
    return {
      statusCode: 400,
      headers:    CORS_HEADERS,
      body:       JSON.stringify({ error: 'Missing parameters: shipping, name or email' })
    };
  }

  try {
    // 4) Calculate shipping amount (en centimes)
    const shippingAmount = typeof shipping.amountCents === 'number'
      ? shipping.amountCents
      : await getShippingAmountCents(shipping);

    // 5) Préparer la metadata.shipping
    const metadataShipping = {
      ...shipping,
      service_point_name: shipping.service_point_name || '',
      brand_id: process.env.SENDCLOUD_BRAND_ID
    };

    // 6) Créer la session Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: 'Livre' },
            unit_amount: 3000
          },
          quantity: 1
        },
        {
          price_data: {
            currency: 'eur',
            product_data: { name: 'Frais de livraison' },
            unit_amount: shippingAmount
          },
          quantity: 1
        }
      ],
      metadata: {
        shipping: JSON.stringify(metadataShipping),
        name,
        email,
        dedicace: dedicace || ''
      },
      success_url: `${process.env.SITE_URL}/mon-livre/remerciement`,
      cancel_url:  `${process.env.SITE_URL}/mon-livre/paiement`
    });

    return {
      statusCode: 200,
      headers:    { ...CORS_HEADERS, 'Content-Type':'application/json' },
      body:       JSON.stringify({ sessionId: session.id })
    };

  } catch (err) {
    console.error('🔥 create-checkout error:', err);
    return {
      statusCode: 500,
      headers:    CORS_HEADERS,
      body:       JSON.stringify({ error: err.message })
    };
  }
};