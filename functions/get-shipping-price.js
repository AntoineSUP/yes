// functions/get-shipping-price.js

const fetch = require('node-fetch');

exports.handler = async (event) => {
  const SITE_URL = process.env.SITE_URL;

  // 1) CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin' : SITE_URL,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  // 2) POST only
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': SITE_URL,
        'Allow': 'POST, OPTIONS'
      },
      body: 'Method Not Allowed'
    };
  }

  // 3) Parse JSON
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': SITE_URL },
      body: 'Invalid JSON'
    };
  }

  const shipping = payload.shipping;
  if (!shipping) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': SITE_URL },
      body: 'Missing parameter: shipping'
    };
  }

  // 4) Sendcloud auth
  const scAuth = 'Basic ' + Buffer.from(
    `${process.env.SENDCLOUD_PUBLIC_KEY}:${process.env.SENDCLOUD_SECRET_KEY}`
  ).toString('base64');

  try {
    // 5) Build v3 request
    const bodyV3 = {
      from_country_code: process.env.SENDCLOUD_SENDER_COUNTRY || 'FR',
      from_postal_code:  process.env.SENDCLOUD_SENDER_POSTAL,
      to_country_code:   shipping.country || 'FR',
      to_postal_code:    shipping.postal_code,
      weight: { value: '1', unit: 'kg' },
      functionalities: { b2c: true }
    };
    if (shipping.id) {
      bodyV3.functionalities.is_service_point_required = true;
    }

    console.log('📦 Fetching Sendcloud v3 with:', bodyV3);

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
    console.log('📦 Sendcloud v3 response:', json);

    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error('no options returned');
    }

    // 6) Choose best option
    let option = null;
    if (shipping.id) {
      option = json.data.find(o => o.requirements.is_service_point_required);
    }
    if (!option) {
      option = json.data.find(o => o.code.startsWith('colissimo:home'));
    }
    if (!option) {
      option = json.data[0];
    }

    // 7) Extract quote
    const quotes = option.quotes || [];
    if (quotes.length === 0) {
      throw new Error('no quotes returned');
    }
    const totalValue = parseFloat(quotes[0].price.total.value);
    if (isNaN(totalValue)) throw new Error('invalid quote price');
    const amountCents = Math.round(totalValue * 100);

    // 8) Return
    return {
      statusCode: 200,
      headers:    { 'Access-Control-Allow-Origin': SITE_URL },
      body:       JSON.stringify({ amount: amountCents })
    };

  } catch (err) {
    console.error('❌ get-shipping-price error:', err.message);
    return {
      statusCode: 500,
      headers:    { 'Access-Control-Allow-Origin': SITE_URL },
      body:       err.message
    };
  }
};