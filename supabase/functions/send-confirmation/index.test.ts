import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', 'test-token');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('KIM_PHONE', '4155550101');
Deno.env.set('ESTEE_PHONE', '4155550102');

const { handleRequest, fillTemplate, formatDollars, dogVerb } = await import('./index.ts');

function stubTwilio() {
  const original = globalThis.fetch;
  const calls: { to: string; body: string }[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    calls.push({ to: params.get('To') || '', body: params.get('Body') || '' });
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

Deno.test('formatDollars: whole dollars only, rounding up at exactly .50, with a thousands comma', () => {
  assertEquals(formatDollars(1795.5), '1,796');
  assertEquals(formatDollars('1795.5'), '1,796');
  assertEquals(formatDollars(1795.49), '1,795');
  assertEquals(formatDollars(210), '210');
  assertEquals(formatDollars(1000), '1,000');
});

Deno.test('formatDollars: passes through empty/non-numeric input unchanged', () => {
  assertEquals(formatDollars(''), '');
  assertEquals(formatDollars(null), '');
  assertEquals(formatDollars(undefined), '');
});

Deno.test('dogVerb: "is" for one dog, "are" for a shared " & "-joined stay', () => {
  assertEquals(dogVerb('Rex'), 'is');
  assertEquals(dogVerb('Don & Bob'), 'are');
  assertEquals(dogVerb(undefined), 'is');
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

Deno.test('with no message_template, type billing: "is" for one dog, formatted cost, STOP below the signature', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', final_cost: 1795.5, // rounds up to $1,796
    }));
    assertEquals(
      stub.calls[0].body,
      "Hi Kim! Rex is ready for pickup. Your total for this stay is $1,796. Thanks for choosing Bayview Boarding! — Kim & Estee\n\nReply STOP to opt out.\nReplies to this number aren't monitored. For questions, please group-text Kim 4155550101 & Estee 4155550102.",
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type billing: "are" for a shared multi-dog stay', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Don & Bob', final_cost: 210,
    }));
    assertEquals(stub.calls[0].body.startsWith('Hi Kim! Don & Bob are ready for pickup.'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type reminder: STOP moved below the signature, with a blank line before it', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      drop_time: '09:00:00', packing_list: 'Food, Leash',
    }));
    assertEquals(
      stub.calls[0].body,
      "Hi Kim! Just a reminder that Rex's stay at Bayview Boarding starts tomorrow at 09:00. Please bring: Food, Leash. See you then! — Kim & Estee\n\nReply STOP to opt out.\nReplies to this number aren't monitored. For questions, please group-text Kim 4155550101 & Estee 4155550102.",
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
    // Each send fires 3 Twilio calls now (client, then Kim, then Estee) -
    // the 2nd invocation's client call is the 4th call overall.
    assertEquals(stub.calls[3].body.includes('Please bring: Food, Leash & doggy bags,'), true);
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

Deno.test('with a message_template: fills {dogVerb} for a billing send, agreeing with the dog name', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Don & Bob',
      final_cost: 100, message_template: '{dogName} {dogVerb} ready.',
    }));
    assertEquals(stub.calls[0].body, 'Don & Bob are ready.');
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

// ── Kim/Estee copy of every client text (Sept 18, 2026) ─────────────────────

Deno.test('after a successful client send, also texts Kim and Estee a copy identifying who it went to', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Jane Smith', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
    }));
    assertEquals(stub.calls.length, 3); // client, then Kim, then Estee
    const clientMessage = stub.calls[0].body;
    assertEquals(stub.calls[1].to, '+14155550101'); // KIM_PHONE
    assertEquals(stub.calls[2].to, '+14155550102'); // ESTEE_PHONE
    for (const call of [stub.calls[1], stub.calls[2]]) {
      assertEquals(call.body.includes('Jane Smith'), true);
      assertEquals(call.body.includes('4155550199'), true);
      assertEquals(call.body.includes(clientMessage), true);
    }
  } finally {
    stub.restore();
  }
});

Deno.test('sends a Kim/Estee copy for every message type (billing, reminder, pickup), not just confirmation', async () => {
  const stub = stubTwilio();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Jane Smith', owner_phone: '4155550199', dog_name: 'Rex', final_cost: 210,
    }));
    assertEquals(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

Deno.test('does not text Kim/Estee if the client send itself fails', async () => {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
  }) as typeof fetch;
  try {
    const res = await handleRequest(sendRequest({ owner_name: 'Jane', owner_phone: '4155550199', dog_name: 'Rex' }));
    assertEquals(res.status, 500);
    assertEquals(callCount, 1); // only the (failed) client attempt - no copies fired
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('a failed Kim/Estee copy does not fail the overall response - the client already got their text', async () => {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    // 1st call (to the client) succeeds; the Kim/Estee copies both fail.
    if (callCount === 1) return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
    return new Response(JSON.stringify({ message: 'copy failed' }), { status: 500 });
  }) as typeof fetch;
  try {
    const res = await handleRequest(sendRequest({
      owner_name: 'Jane', owner_phone: '4155550199', dog_name: 'Rex', estimated_cost: 100,
    }));
    assertEquals(res.status, 200);
    assertEquals(callCount, 3); // client + 2 attempted (failed) copies
  } finally {
    globalThis.fetch = original;
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
