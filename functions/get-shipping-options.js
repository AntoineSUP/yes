// functions/get-shipping-options.js

const fetch = require('node-fetch');

// On autorise tous les origines ici, ou vous pouvez remplacer '*' par process.env.SITE_URL
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  // Méthode uniquement POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
      body: 'Method Not Allowed'
    };
  }

  // Lecture du body
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Invalid JSON' };
  }

  const { shipping } = payload;
  if (!shipping) {
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Missing parameter: shipping' };
  }

  // Auth Sendcloud
  const scAuth = 'Basic ' + Buffer.from(
    `${process.env.SENDCLOUD_PUBLIC_KEY}:${process.env.SENDCLOUD_SECRET_KEY}`
  ).toString('base64');

  // Construction du body v3 avec dimensions du coli
  const bodyV3 = {
    from_country_code: process.env.SENDCLOUD_SENDER_COUNTRY || 'FR',
    from_postal_code: process.env.SENDCLOUD_SENDER_POSTAL,
    to_country_code: shipping.country || 'FR',
    to_postal_code: shipping.postal_code,
    weight: {
      value: 0.5,
      unit: 'kg'
    },
    dimensions: {
      length: 30,
      width: 20,
      height: 5,
      unit: 'cm'
    },
    functionalities: {
      b2c: true,
      is_service_point_required: Boolean(shipping.id)
    }
  };

  // Si on a un point-relais
  if (shipping.id) {
    bodyV3.service_point_id = shipping.id;
  }

  try {
    // Appel API Sendcloud v3
    const res = await fetch(
      'https://panel.sendcloud.sc/api/v3/fetch-shipping-options',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': scAuth
        },
        body: JSON.stringify(bodyV3)
      }
    );
    const json = await res.json();

    // Pas d’options dispo
    if (!Array.isArray(json.data) || json.data.length === 0) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ options: [] })
      };
    }

    // Filtrage de base
    let opts = json.data.filter(o =>
      Array.isArray(o.quotes) &&
      o.quotes[0]?.price?.total?.value != null &&
      !o.code.startsWith('sendcloud:letter')
    );

    // Séparation domicile vs point-relais
    if (shipping.id) {
      // Point-relais : on ne garde que les options service point + même transporteur
      opts = opts.filter(o =>
        o.requirements.is_service_point_required &&
        o.carrier.code === shipping.carrier_code
      );
    } else {
      // Livraison à domicile : on prend les 3 transporteurs distincts les moins chers
      const homeOnly = opts.filter(o => !o.requirements.is_service_point_required);
      homeOnly.sort((a, b) =>
        parseFloat(a.quotes[0].price.total.value) - parseFloat(b.quotes[0].price.total.value)
      );
      const distinct = [];
      const seen = new Set();
      for (const o of homeOnly) {
        if (!seen.has(o.carrier.code)) {
          distinct.push(o);
          seen.add(o.carrier.code);
        }
        if (distinct.length === 3) break;
      }
      opts = distinct;
    }

    // Tri final par prix croissant
    opts.sort((a, b) =>
      parseFloat(a.quotes[0].price.total.value) - parseFloat(b.quotes[0].price.total.value)
    );

    // Retour au front
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: opts })
    };
  } catch (err) {
    console.error('❌ Error fetching shipping options:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: err.message
    };
  }
};