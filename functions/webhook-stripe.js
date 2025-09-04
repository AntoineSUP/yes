// functions/stripe-webhook.js

const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch      = require('node-fetch');
const nodemailer = require('nodemailer');

// ── Configuration Nodemailer (Gmail) ────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});
transporter.verify()
  .then(() => console.log('✅ Gmail SMTP prêt'))
  .catch(err => console.error('❌ Erreur configuration Gmail SMTP:', err));

exports.handler = async (event) => {
  // 1) rawBody & signature
  const sig   = event.headers['stripe-signature'];
  let rawBody = event.body;
  if (event.isBase64Encoded) rawBody = Buffer.from(rawBody, 'base64').toString('utf8');

  // 2) verify Stripe signature
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // 3) only handle checkout.session.complete
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }
  const session = stripeEvent.data.object;

  // 4) parse metadata
  let shipping = {}, formName = '', formEmail = '', dedicace = '';
  try {
    shipping  = JSON.parse(session.metadata.shipping   || '{}');
    formName  = session.metadata.name                  || '';
    formEmail = session.metadata.email                 || '';
    dedicace  = session.metadata.dedicace              || '';
  } catch (err) {
    console.error('⚠️ Invalid metadata:', err);
    return { statusCode: 400, body: 'Invalid metadata' };
  }
  if (!shipping.country && shipping.country_code) {
    shipping.country = shipping.country_code;
  }
  const code = shipping.shipping_option_code || shipping.shipping_method;
  if (!code) {
    console.error('⚠️ Missing shipping option code');
    return { statusCode: 400, body: 'Missing shipping option code' };
  }

  // 5) build Sendcloud payload (identique à l’existant, inchangé)
  const phone = shipping.phone || session.customer_details.phone || '';
  const postal = (shipping.postal_code||'').replace(/\s+/g,'');
  const NEED_STATE = ['US','CA','AU','NZ'];
  let stateProvinceCode;
  if (shipping.state_province_code && NEED_STATE.includes(shipping.country)) {
    const raw = shipping.state_province_code;
    stateProvinceCode = raw.includes('-') ? raw : `${shipping.country}-${raw}`;
  }

  const toBase = {
    email:          formEmail,
    address_line_1: `${shipping.street||''} ${shipping.house_number||''}`.trim(),
    address_line_2: '',
    postal_code:    postal,
    city:           shipping.city,
    country_code:   shipping.country,
    phone_number:   phone,
    ...(stateProvinceCode ? { state_province_code: stateProvinceCode } : {})
  };

  let toAddress;
  if (shipping.id) {
    const [firstName, ...rest] = formName.split(' ');
    toAddress = {
      name:       formName,
      first_name: firstName,
      last_name:  rest.join(' ')||firstName,
      ...toBase
    };
  } else {
    toAddress = { name: formName, ...toBase };
  }

  const isIntl    = shipping.country !== 'FR';
  const invoiceNr = session.id.slice(0,40);

  const payload = {
    external_reference: session.id,
    telephone:          phone,
    from_address: {
      name:           process.env.SENDCLOUD_SENDER_NAME,
      email:          process.env.SENDCLOUD_SENDER_EMAIL,
      address_line_1: process.env.SENDCLOUD_SENDER_STREET,
      address_line_2: process.env.SENDCLOUD_SENDER_STREET2||'',
      postal_code:    process.env.SENDCLOUD_SENDER_POSTAL_CODE,
      city:           process.env.SENDCLOUD_SENDER_CITY,
      country_code:   process.env.SENDCLOUD_SENDER_COUNTRY_CODE
    },
    to_address: toAddress,
    ship_with: {
      type: 'shipping_option_code',
      properties: { shipping_option_code: code }
    },
    parcels: [
      {
        weight:     { value: 0.5, unit: 'kg' },
        dimensions: { length: '30', width: '20', height: '5', unit: 'cm' }
      }
    ],
    brand_id: parseInt(process.env.SENDCLOUD_BRAND_ID, 10)
  };

  if (shipping.id) {
    payload.to_service_point = { id: shipping.id };
  }
  if (isIntl && !shipping.id) {
    payload.parcels[0].parcel_items = [{
      description:    'Livre',
      quantity:       1,
      weight:         { value: 0.5, unit: 'kg' },
      price:          { value: 30.00, currency: 'EUR' },
      origin_country: 'FR',
      hs_code:        '490199'
    }];
    payload.customs_information = {
      invoice_number: invoiceNr,
      export_type:    'private',
      export_reason:  'commercial_goods'
    };
  }

  console.log('📦 Payload Sendcloud:', JSON.stringify(payload,null,2));

  // 6) call Sendcloud
  const scAuth   = 'Basic '+Buffer.from(`${process.env.SENDCLOUD_PUBLIC_KEY}:${process.env.SENDCLOUD_SECRET_KEY}`).toString('base64');
  const endpoint = (isIntl && !shipping.id)
    ? 'https://panel.sendcloud.sc/api/v3/shipments/announce'
    : 'https://panel.sendcloud.sc/api/v3/shipments';
  try {
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Authorization': scAuth, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const scResponse = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(scResponse.errors||scResponse));
    console.log('✅ Sendcloud response:', scResponse);
  } catch (err) {
    console.error('🔥 Échec création shipment:', err);
  }

  // 7) send notification email (ajout de la dédicace)
  const fullAddress = `${toAddress.address_line_1}, ${toAddress.postal_code} ${toAddress.city}, ${toAddress.country_code}`;

  const mailOptions = {
    from:    process.env.GMAIL_USER,
    to:      [
      process.env.NOTIFY_EMAIL_TO,
      process.env.NOTIFY_EMAIL_FROM
    ],
    subject: `Nouvelle commande ${session.id}`,
    text: `
  Nouvelle commande reçue
  Nom       : ${formName}
  Email     : ${formEmail}
  Téléphone : ${phone}
  Adresse   : ${fullAddress}
  Dédicace  : ${dedicace}
  Total     : ${(session.amount_total/100).toFixed(2)} €
    `.trim()
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email notification envoyé — Dédicace : ${dedicace} — Nom : ${formName}`);
  } catch (err) {
    console.error('❌ Erreur envoi email:', err);
    console.error('📧 Options du mail étaient :', mailOptions);
  }

  return { statusCode: 200, body: 'OK' };
};