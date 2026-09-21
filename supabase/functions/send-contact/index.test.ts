import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_API_KEY_SID', 'SKtest');
Deno.env.set('TWILIO_API_KEY_SECRET', 'test-api-key-secret');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('KIM_PHONE', '4155550101');
Deno.env.set('ESTEE_PHONE', '4155550102');

const { handleRequest } = await import('./index.ts');

function contactRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/send-contact', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function stubTwilio(opts: { fail?: 'kim' | 'estee' | 'both' } = {}) {
  const original = globalThis.fetch;
  const calls: { to: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    const to = params.get('To') || '';
    calls.push({ to, body: params.get('Body') || '' });
    const failsThis =
      opts.fail === 'both' ||
      (opts.fail === 'kim' && to === '+14155550101') ||
      (opts.fail === 'estee' && to === '+14155550102');
    if (failsThis) return new Response(JSON.stringify({ message: 'Twilio error' }), { status: 500 });
    return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.test('rejects non-POST requests', async () => {
  const res = await handleRequest(new Request('https://example.supabase.co/functions/v1/send-contact', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('requires a name', async () => {
  const res = await handleRequest(contactRequest({ email: 'a@test.com', message: 'Hi' }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'Name is required');
});

Deno.test('requires a message', async () => {
  const res = await handleRequest(contactRequest({ name: 'Jane', email: 'a@test.com' }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'Message is required');
});

Deno.test('requires an email or phone', async () => {
  const res = await handleRequest(contactRequest({ name: 'Jane', message: 'Hi' }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'An email or phone number is required');
});

Deno.test('relays the message to both Kim and Estee by SMS', async () => {
  const stub = stubTwilio();
  try {
    const res = await handleRequest(contactRequest({
      name: 'Jane Smith', email: 'jane@test.com', phone: '4155550199', message: 'Do you have room in October?',
    }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).success, true);
    assertEquals(stub.calls.length, 2);
    assertEquals(stub.calls.map((c) => c.to).sort(), ['+14155550101', '+14155550102']);
    assertEquals(
      stub.calls[0].body,
      'Contact form from Jane Smith (jane@test.com / 4155550199): Do you have room in October?',
    );
  } finally {
    stub.restore();
  }
});

Deno.test('succeeds if only one of Kim/Estee actually receives it', async () => {
  const stub = stubTwilio({ fail: 'estee' });
  try {
    const res = await handleRequest(contactRequest({ name: 'Jane', email: 'jane@test.com', message: 'Hi' }));
    assertEquals(res.status, 200);
  } finally {
    stub.restore();
  }
});

Deno.test('fails only if neither leg sends', async () => {
  const stub = stubTwilio({ fail: 'both' });
  try {
    const res = await handleRequest(contactRequest({ name: 'Jane', email: 'jane@test.com', message: 'Hi' }));
    assertEquals(res.status, 502);
  } finally {
    stub.restore();
  }
});

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://example.supabase.co/functions/v1/send-contact', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});
