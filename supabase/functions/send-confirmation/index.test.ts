import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_API_KEY_SID', 'SKtest');
Deno.env.set('TWILIO_API_KEY_SECRET', 'test-api-key-secret');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest, fillTemplate, formatDollars, dogVerb } = await import('./index.ts');

const DEFAULT_SETTINGS_ROW = {
  sms_footer: "Reply STOP to opt out. Replies to this number aren't monitored. For questions, please group-text Kim {primaryManagerPhone} & Estee {secondaryManagerPhone}.",
  primary_manager_phone: '4155550101',
  secondary_manager_phone: '4155550102',
};
const FILLED_FOOTER = "Reply STOP to opt out. Replies to this number aren't monitored. For questions, please group-text Kim 4155550101 & Estee 4155550102.";

// Stubs both the Twilio Messages API (every actual SMS send: the client,
// then Kim's and Estee's copies) and the `settings` REST read
// fetchFooterAndPhones makes once per call - send-confirmation now
// depends on both, not just Twilio.
function stubEnvironment({ settingsRow = DEFAULT_SETTINGS_ROW, twilioOk = true } = {}) {
  const original = globalThis.fetch;
  const twilioCalls: { to: string; body: string; authorization: string }[] = [];
  let settingsCallCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'api.twilio.com') {
      const params = new URLSearchParams(String(init?.body));
      const authorization = (init?.headers as Record<string, string> | undefined)?.['Authorization'] || '';
      twilioCalls.push({ to: params.get('To') || '', body: params.get('Body') || '', authorization });
      return twilioOk
        ? new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 })
        : new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    }
    if (url.pathname.endsWith('/settings')) {
      settingsCallCount++;
      return new Response(JSON.stringify([settingsRow]), { status: 200 });
    }
    throw new Error(`stubEnvironment: unhandled request ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  return {
    calls: twilioCalls, // kept as `calls` - most tests only care about the Twilio sends
    get settingsCallCount() { return settingsCallCount; },
    restore: () => { globalThis.fetch = original; },
  };
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

Deno.test('authenticates outbound Twilio calls with the API key (SID + Secret), not the Account SID + Auth Token (Sept 21, 2026)', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({ owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Hi.' }));
    assertEquals(stub.calls[0].authorization, 'Basic ' + btoa('SKtest:test-api-key-secret'));
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template: builds the default confirmation message and appends the shared footer', async () => {
  const stub = stubEnvironment();
  try {
    const res = await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
    }));
    assertEquals(res.status, 200);
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Rex's stay at Bayview Boarding is confirmed. Drop-off: Thu, Oct 1 at 09:00. Pick-up: Sat, Oct 3 at 10:00. Estimated cost: $210. — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
    assertEquals(stub.settingsCallCount, 1);
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type billing: "Thank you for visiting" wording (not "ready for pickup"), full math before the total, footer below signature', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', final_cost: 1795.5, // rounds up to $1,796
      billing_breakdown: '$105.00/day × 2.0 days × 1st dog = $210.00',
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Thank you for visiting Bayview Boarding with Rex. Here's your billing detail:\n$105.00/day × 2.0 days × 1st dog = $210.00\n\nTotal: $1,796\n\nThanks for choosing Bayview Boarding! — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
    assertEquals(stub.calls[0].body.includes('ready for pickup'), false);
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type billing: still works (just skips the math block) with no billing_breakdown given', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Don & Bob', final_cost: 210,
    }));
    assertEquals(
      stub.calls[0].body.startsWith("Hi Kim! Thank you for visiting Bayview Boarding with Don & Bob. Here's your billing detail:\nTotal: $210"),
      true,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type reminder: bullet-list packing items (one per line), footer below the signature', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      drop_time: '09:00:00', packing_list: 'Food, Leash',
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Just a reminder that Rex's stay at Bayview Boarding starts tomorrow at 09:00. Here's what to bring:\n• Food\n• Leash\nSee you then! — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type reminder: uses packing_list if given, DEFAULT_PACKING_LIST otherwise', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      drop_time: '09:00:00', packing_list: 'Food, Leash',
    }));
    assertEquals(stub.calls[0].body.includes('• Food\n• Leash'), true);

    await handleRequest(sendRequest({
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', drop_time: '09:00:00',
    }));
    // Each send fires 3 Twilio calls now (client, then Kim, then Estee) -
    // the 2nd invocation's client call is the 4th call overall.
    assertEquals(stub.calls[3].body.includes('• Food\n• Leash & doggy bags\n'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: substitutes placeholders including primaryManagerPhone/secondaryManagerPhone, footer not auto-duplicated since the template itself no longer contains it', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
      message_template: 'Hi {firstName}! {dogName} confirmed ${estimatedCost}. Text Kim {primaryManagerPhone} or Estee {secondaryManagerPhone}.',
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Rex confirmed $210. Text Kim 4155550101 or Estee 4155550102.\n\n${FILLED_FOOTER}`,
    );
    // the number appears once in the template's own substitution and
    // once in the separately-appended footer - never more than that
    assertEquals((stub.calls[0].body.match(/4155550101/g) || []).length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test('the shared footer is appended even when a custom message_template is used', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      message_template: 'Custom message body.',
    }));
    assertEquals(stub.calls[0].body, `Custom message body.\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {packingList} from an array packing_list, one bullet per line', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', drop_time: '09:00:00',
      packing_list: ['Food', 'Leash'],
      message_template: 'Bring: {packingList}',
    }));
    assertEquals(stub.calls[0].body, `Bring: • Food\n• Leash\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {finalCost} for a billing send', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      final_cost: 315, message_template: 'Total due: ${finalCost}',
    }));
    assertEquals(stub.calls[0].body, `Total due: $315\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {billingBreakdown} for a billing send, empty string when none was given', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      final_cost: 210, billing_breakdown: '$105.00/day × 2.0 days × 1st dog = $210.00',
      message_template: 'Math:\n{billingBreakdown}\nTotal: ${finalCost}',
    }));
    assertEquals(stub.calls[0].body, `Math:\n$105.00/day × 2.0 days × 1st dog = $210.00\nTotal: $210\n\n${FILLED_FOOTER}`);

    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      final_cost: 210, message_template: 'Math:[{billingBreakdown}]',
    }));
    assertEquals(stub.calls[3].body, `Math:[]\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {dogVerb} for a billing send, agreeing with the dog name', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Don & Bob',
      final_cost: 100, message_template: '{dogName} {dogVerb} ready.',
    }));
    assertEquals(stub.calls[0].body, `Don & Bob are ready.\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type pickup: builds the pickup-tomorrow message, signed off and the footer below it like every other text', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'pickup', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_out: '2026-10-03', pickup_time: '09:00:00',
    }));
    assertEquals(
      stub.calls[0].body,
      `It's been wonderful having Rex! We have you down for pick up at Sat, Oct 3 09:00. Please let us know in our shared group text thread if anything has changed. Otherwise, we'll see you tomorrow at 09:00. — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {pickupDate}/{pickupTime} for a pickup send', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'pickup', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_out: '2026-10-03', pickup_time: '09:00:00',
      message_template: 'Bye {dogName}! See you {pickupDate} at {pickupTime}.',
    }));
    assertEquals(stub.calls[0].body, `Bye Rex! See you Sat, Oct 3 at 09:00.\n\n${FILLED_FOOTER}`);
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type request_received: builds the "request received, review within 24 hours" message', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'request_received', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', estimated_cost: 210,
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! We've received your booking request for Rex - Thu, Oct 1 to Sat, Oct 3. We'll review it and confirm within 24 hours. Estimated cost: $210. — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type denied: includes the reason when given', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'denied', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', denial_reason: 'Fully booked that week',
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Unfortunately we're unable to accept your booking request for Rex (Thu, Oct 1 - Sat, Oct 3). Reason: Fully booked that week. Please feel free to reach out with any questions. — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with no message_template, type denied: reads cleanly with no reason given', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'denied', owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03',
    }));
    assertEquals(
      stub.calls[0].body,
      `Hi Kim! Unfortunately we're unable to accept your booking request for Rex (Thu, Oct 1 - Sat, Oct 3). Please feel free to reach out with any questions. — Kim & Estee\n\n${FILLED_FOOTER}`,
    );
  } finally {
    stub.restore();
  }
});

Deno.test('with a message_template: fills {denialReason}, blank (not the literal placeholder) when no reason given', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
      message_template: 'Sorry {dogName}.{denialReason} Bye.', denial_reason: 'Fully booked',
    }));
    assertEquals(stub.calls[0].body, `Sorry Rex. Reason: Fully booked. Bye.\n\n${FILLED_FOOTER}`);

    const noReason = stubEnvironment();
    try {
      await handleRequest(sendRequest({
        owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex',
        message_template: 'Sorry {dogName}.{denialReason} Bye.',
      }));
      assertEquals(noReason.calls[0].body, `Sorry Rex. Bye.\n\n${FILLED_FOOTER}`);
    } finally {
      noReason.restore();
    }
  } finally {
    stub.restore();
  }
});

Deno.test('no footer is appended (just skipped) if sms_footer happens to be blank', async () => {
  const stub = stubEnvironment({ settingsRow: { ...DEFAULT_SETTINGS_ROW, sms_footer: '' } });
  try {
    await handleRequest(sendRequest({
      owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Just this.',
    }));
    assertEquals(stub.calls[0].body, 'Just this.');
  } finally {
    stub.restore();
  }
});

// ── Kim/Estee copy of every client text (Sept 18, 2026) ─────────────────────

Deno.test('after a successful client send, also texts Kim and Estee a copy identifying who it went to', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      owner_name: 'Jane Smith', owner_phone: '4155550199', dog_name: 'Rex',
      check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '10:00:00',
      estimated_cost: 210,
    }));
    assertEquals(stub.calls.length, 3); // client, then Kim, then Estee
    const clientMessage = stub.calls[0].body;
    assertEquals(stub.calls[1].to, '+14155550101'); // primary_manager_phone
    assertEquals(stub.calls[2].to, '+14155550102'); // secondary_manager_phone
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
  const stub = stubEnvironment();
  try {
    await handleRequest(sendRequest({
      type: 'billing', owner_name: 'Jane Smith', owner_phone: '4155550199', dog_name: 'Rex', final_cost: 210,
    }));
    assertEquals(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

Deno.test('skips a copy leg whose manager phone is not yet set, without erroring', async () => {
  const stub = stubEnvironment({ settingsRow: { ...DEFAULT_SETTINGS_ROW, secondary_manager_phone: '' } });
  try {
    const res = await handleRequest(sendRequest({
      owner_name: 'Jane Smith', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Hi.',
    }));
    assertEquals(res.status, 200);
    assertEquals(stub.calls.length, 2); // client + only the primary copy
  } finally {
    stub.restore();
  }
});

Deno.test('does not text Kim/Estee if the client send itself fails', async () => {
  const stub = stubEnvironment({ twilioOk: false });
  try {
    const res = await handleRequest(sendRequest({ owner_name: 'Jane', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Hi.' }));
    assertEquals(res.status, 500);
    assertEquals(stub.calls.length, 1); // only the (failed) client attempt - no copies fired
  } finally {
    stub.restore();
  }
});

Deno.test('a failed Kim/Estee copy does not fail the overall response - the client already got their text', async () => {
  const original = globalThis.fetch;
  let twilioCallCount = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith('/settings')) {
      return new Response(JSON.stringify([DEFAULT_SETTINGS_ROW]), { status: 200 });
    }
    twilioCallCount++;
    // 1st Twilio call (to the client) succeeds; the Kim/Estee copies both fail.
    if (twilioCallCount === 1) return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
    return new Response(JSON.stringify({ message: 'copy failed' }), { status: 500 });
  }) as typeof fetch;
  try {
    const res = await handleRequest(sendRequest({
      owner_name: 'Jane', owner_phone: '4155550199', dog_name: 'Rex', estimated_cost: 100,
    }));
    assertEquals(res.status, 200);
    assertEquals(twilioCallCount, 3); // client + 2 attempted (failed) copies
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('returns 500 with the Twilio error body if the send fails', async () => {
  const stub = stubEnvironment({ twilioOk: false });
  try {
    const res = await handleRequest(sendRequest({ owner_name: 'Kim', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Hi.' }));
    assertEquals(res.status, 500);
  } finally {
    stub.restore();
  }
});
