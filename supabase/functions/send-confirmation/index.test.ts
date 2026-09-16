import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', 'test-token');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('KIM_PHONE', '4155550101');
Deno.env.set('ESTEE_PHONE', '4155550102');

const { handleRequest, fillTemplate } = await import('./index.ts');

function stubTwilio() {
  const original = globalThis.fetch;
  const calls: { body: string }[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: new URLSearchParams(String(init?.body)).get('Body') || '' });
    return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function sendRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/send-confirmation', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('fillTemplate: fills every placeholder present in vars', () => {
  const result = fillTemplate('Hi {firstName}, total ${finalCost}', { firstName: 'Kim', finalCost: '210' });
  assertEquals(result, 'Hi Kim, total $210');
});

Deno.test('fillTemplate: leaves a placeholder untouched if no matching var was given', () => {
  const result = fillTemplate('Hi {firstName}, {missing}', { firstName: 'Kim' });
  assertEquals(result, 'Hi Kim, {missing}');
});

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/send-confirmation', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('rejects an empty body', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/send-confirmation', { method: 'POST', body: '' }));
  assertEquals(res.status, 400);
});

Deno.test('with no message_template: builds the default confirmation message and appends the contact note', async () => {
  const stub = stubTwilio();
  try {
    const res = await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
    }));
    assertEquals(res.status, 200);
    assertEquals(
      stub.calls[0].body,
      "Hi Kim! Rex's stay at Bayview Boarding is confirmed. Drop-off: Thu, Oct 1 at 09:00. Pick-up: Sat, Oct 3 at 10:00. Estimated cost: $210. — Kim & Estee\nReplies to this number aren't monitored. For questions, please group-text Kim 4155550101 & Estee 4155550102.",
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type reminder: uses packing_list if given, DEFAULT_PACKING_LIST otherwise', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      drop_time: '09:00:00', packing_list: 'Food, Leash',
    }));
    assertEquals(stub.calls[0].body.includes('Please bring: Food, Leash.'), true);

    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', drop_time: '09:00:00',
    }));
    assertEquals(stub.calls[1].body.includes('Please bring: Food, Leash & doggy bags,'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: substitutes placeholders including kimPhone/esteePhone, and does NOT double the contact note', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
      message_template: 'Hi {firstName}! {dogName} confirmed ${estimatedCost}. Text Kim {kimPhone} or Estee {esteePhone}.',
    }));
    assertEquals(
      stub.calls[0].body,
      'Hi Kim! Rex confirmed $210. Text Kim 4155550101 or Estee 4155550102.',
    );
    // exactly one contact note's worth of phone numbers - not duplicated
    assertEquals((stub.calls[0].body.match(/4155550101/g) || []).length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {packingList} from an array packing_list, joined', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', drop_time: '09:00:00',
      packing_list: ['Food', 'Leash'],
      message_template: 'Bring: {packingList}',
    }));
    assertEquals(stub.calls[0].body, 'Bring: Food, Leash');
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {finalCost} for a billing send', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      final_cost: 315, message_template: 'Total due: ${finalCost}',
    }));
    assertEquals(stub.calls[0].body, 'Total due: $315');
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type pickup: builds the pickup-tomorrow message', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'pickup', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_out: '2026-10-03', pickup_time: '09:00:00',
    }));
    assertEquals(
      stub.calls[0].body,
      "It's been wonderful having Rex! We have you down for pick up at Sat, Oct 3 09:00. Please let us know in our shared group text thread if anything has changed. Otherwise, we'll see you tomorrow at 09:00.",
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {pickupDate}/{pickupTime} for a pickup send', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'pickup', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_out: '2026-10-03', pickup_time: '09:00:00',
      message_template: 'Bye {dogName}! See you {pickupDate} at {pickupTime}.',
    }));
    assertEquals(stub.calls[0].body, 'Bye Rex! See you Sat, Oct 3 at 09:00.');
  } finally {
    stub.restore();
  }
});

Deno.test('returns 500 with the Twilio error body if the send fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'bad request' }), { status: 400 })) as typeof fetch;
  try {
    const res = await handleRequest(sendRequest({ owner_name: 'Kim', owner_phone: '4155550199', dog_name: 'Rex' }));
    assertEquals(res.status, 500);
  } finally {
    globalThis.fetch = original;
  }
});
