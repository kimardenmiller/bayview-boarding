import { assertEquals, assert } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

// The module reads its Twilio/contact config from env vars at import time
// (top-level consts), so they must be set before the (dynamic) import below.
// A dynamic import is required here specifically because static imports are
// hoisted and would run before these Deno.env.set calls.
const FAKE_AUTH_TOKEN = 'test-auth-token';
const WEBHOOK_URL = 'https://example.supabase.co/functions/v1/receive-sms';
const KIM_PHONE = '(650) 302-0731';
const ESTEE_PHONE = '(510) 432-9791';

Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', FAKE_AUTH_TOKEN);
Deno.env.set('TWILIO_PHONE', '+16502522433');
Deno.env.set('KIM_PHONE', KIM_PHONE);
Deno.env.set('ESTEE_PHONE', ESTEE_PHONE);
Deno.env.set('RECEIVE_SMS_WEBHOOK_URL', WEBHOOK_URL);

const { handleRequest } = await import('./index.ts');

// Twilio's own signing algorithm (the counterpart to contact.ts's validator),
// used here purely to construct realistic signed test requests - not a
// re-test of the validator itself, which already has its own suite checked
// against Twilio's published example.
async function signParams(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

async function signedRequest(params: Record<string, string>): Promise<Request> {
  const signature = await signParams(FAKE_AUTH_TOKEN, WEBHOOK_URL, params);
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': signature, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// Records every fetch call made during a test, standing in for Twilio's own
// Messages API so tests never make a real network call / send a real SMS.
function stubFetch() {
  const calls: { url: string; body: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return Promise.resolve(new Response(JSON.stringify({ sid: 'SMtest' }), { status: 201 }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.test('rejects non-POST requests without touching Twilio', async () => {
  const { calls, restore } = stubFetch();
  try {
    const res = await handleRequest(new Request(WEBHOOK_URL, { method: 'GET' }));
    assertEquals(res.status, 405);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test('rejects a request with a missing signature, and sends nothing', async () => {
  const { calls, restore } = stubFetch();
  try {
    const res = await handleRequest(new Request(WEBHOOK_URL, {
      method: 'POST',
      body: 'From=%2B14155551234&Body=hello',
    }));
    assertEquals(res.status, 403);
    assertEquals(calls.length, 0); // the whole point of validating first: no relay, no auto-reply, no cost
  } finally {
    restore();
  }
});

Deno.test('rejects a request with a wrong signature, and sends nothing', async () => {
  const { calls, restore } = stubFetch();
  try {
    const res = await handleRequest(new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'X-Twilio-Signature': 'forged' },
      body: 'From=%2B14155551234&Body=hello',
    }));
    assertEquals(res.status, 403);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test('a validly-signed request relays to both Kim and Estee, and auto-replies to the client', async () => {
  const { calls, restore } = stubFetch();
  try {
    const req = await signedRequest({ From: '+14155551234', Body: 'Can I drop off early?' });
    const res = await handleRequest(req);

    assertEquals(res.status, 200);
    assertEquals(res.headers.get('Content-Type'), 'text/xml');

    const twiml = await res.text();
    assert(twiml.includes(KIM_PHONE), 'auto-reply should include Kim\'s number');
    assert(twiml.includes(ESTEE_PHONE), 'auto-reply should include Estee\'s number');
    assert(twiml.includes('<Message>'), 'should be a TwiML <Message> response');

    // exactly two relay sends: one to Kim, one to Estee, each correctly
    // naming the original sender and quoting their message
    assertEquals(calls.length, 2);
    const parsedBodies = calls.map(c => new URLSearchParams(c.body));
    for (const params of parsedBodies) {
      assert(params.get('Body')?.includes('+14155551234'), 'relay text should name the sender');
      assert(params.get('Body')?.includes('Can I drop off early?'), 'relay text should quote the message');
    }
    const toValues = parsedBodies.map(p => p.get('To'));
    assert(toValues.includes('+16503020731'), 'should relay to Kim');
    assert(toValues.includes('+15104329791'), 'should relay to Estee');
  } finally {
    restore();
  }
});

Deno.test('relays even when the client used a raw/unformatted From number', async () => {
  const { calls, restore } = stubFetch();
  try {
    const req = await signedRequest({ From: '+16505550000', Body: 'ok' });
    await handleRequest(req);
    const bodies = calls.map(c => new URLSearchParams(c.body).get('Body') || '');
    assert(bodies.every(b => b.includes('+16505550000')), 'relay text should name the actual sender');
  } finally {
    restore();
  }
});
