import { assertEquals, assert } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

const DEFAULT_ROW = {
  day_rate: 105,
  multi_dog_discount: 0.10,
  holiday_upcharge: 0.30,
  vets: ['Marin Pet Hospital — (415) 479-8387', 'VCA Marin Animal Hospital — (415) 454-5225'],
  packing_list: ['Food', 'Leash & doggy bags'],
  sms_confirmation: 'Hi {firstName}! confirmed.',
  sms_reminder: 'Hi {firstName}! reminder, bring: {packingList}.',
  sms_billing: 'Hi {firstName}! total: ${finalCost}.',
  sms_pickup_reminder: 'Bye {dogName}! pickup at {pickupDate} {pickupTime}.',
  sms_footer: 'Reply STOP to opt out. Text Kim {primaryManagerPhone} & Estee {secondaryManagerPhone}.',
  sms_request_received: 'Hi {firstName}! Request received for {dogName}.',
  sms_denied: 'Hi {firstName}! Sorry, we can\'t take {dogName}.{denialReason}',
  about_photos: [{ path: 'abc123.jpg', alt: 'Choco' }, { path: 'def456.jpg', alt: 'Milo' }],
  primary_manager_phone: '4155550101',
  secondary_manager_phone: '4155550102',
  default_broadcast_message: 'Please have a look at our staging site and tell us what you think!',
};

// Filters the stubbed row down to whatever `select=col1,col2` the real
// call asked for - real Postgrest only ever returns selected columns, so
// the stub has to behave the same way for the PUBLIC_COLUMNS vs
// ADMIN_COLUMNS split (see settings/index.ts) to actually be testable:
// a test asserting the manager-phone columns are absent from a public
// read would otherwise pass for the wrong reason (a stub that always
// returns everything, regardless of what was selected).
function selectColumns(row: Record<string, unknown>, selectParam: string | null): Record<string, unknown> {
  if (!selectParam) return { ...row };
  const cols = selectParam.split(',').map((c) => c.trim());
  const out: Record<string, unknown> = {};
  for (const c of cols) if (c in row) out[c] = row[c];
  return out;
}

function stubSupabase(initial: typeof DEFAULT_ROW = DEFAULT_ROW) {
  const db = { settings: { ...initial } };
  const calls: { method: string; table: string; body: unknown }[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const table = url.pathname.split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, table, body });

    if (table === 'settings') {
      if (method === 'GET') {
        return new Response(JSON.stringify([selectColumns(db.settings, url.searchParams.get('select'))]), { status: 200 });
      }
      if (method === 'PATCH') {
        Object.assign(db.settings, body);
        return new Response(JSON.stringify([selectColumns(db.settings, url.searchParams.get('select'))]), { status: 200 });
      }
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { db, calls, restore: () => { globalThis.fetch = original; } };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('rejects non-POST requests', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(new Request('https://x/functions/v1/settings', { method: 'GET' }));
    assertEquals(res.status, 405);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('a plain read requires no password (public) and never includes the manager phone numbers', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({}));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data, {
      dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30,
      vets: DEFAULT_ROW.vets,
      packingList: DEFAULT_ROW.packing_list,
      smsConfirmation: DEFAULT_ROW.sms_confirmation,
      smsReminder: DEFAULT_ROW.sms_reminder,
      smsBilling: DEFAULT_ROW.sms_billing,
      smsPickupReminder: DEFAULT_ROW.sms_pickup_reminder,
      smsFooter: DEFAULT_ROW.sms_footer,
      smsRequestReceived: DEFAULT_ROW.sms_request_received,
      smsDenied: DEFAULT_ROW.sms_denied,
      aboutPhotos: DEFAULT_ROW.about_photos,
    });
    assertEquals('primaryManagerPhone' in data, false);
    assertEquals('secondaryManagerPhone' in data, false);
    assertEquals('defaultBroadcastMessage' in data, false);
    assertEquals(stub.calls[0].method, 'GET');
  } finally {
    stub.restore();
  }
});

Deno.test('an admin-authenticated read (password, no updates) includes the manager phone numbers', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.primaryManagerPhone, '4155550101');
    assertEquals(data.secondaryManagerPhone, '4155550102');
    assertEquals(data.smsFooter, DEFAULT_ROW.sms_footer);
    assertEquals(data.defaultBroadcastMessage, DEFAULT_ROW.default_broadcast_message);
  } finally {
    stub.restore();
  }
});

Deno.test('an admin-authenticated read rejects the wrong password, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: 'nope' }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a write with no password, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ updates: { dayRate: 120 } }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a write with the wrong password', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: 'nope', updates: { dayRate: 120 } }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('updates just the day rate, leaving other fields untouched', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { dayRate: 120 } }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.dayRate, 120);
    assertEquals(data.multiDogDiscount, 0.10); // unchanged
    assertEquals(stub.db.settings.day_rate, 120);
  } finally {
    stub.restore();
  }
});

Deno.test('updates the multi-dog discount and holiday upcharge together', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { multiDogDiscount: 0.15, holidayUpcharge: 0.25 },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.multiDogDiscount, 0.15);
    assertEquals(data.holidayUpcharge, 0.25);
  } finally {
    stub.restore();
  }
});

Deno.test('updates the vet list, trimming each entry', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { vets: ['  New Vet Clinic — (415) 555-0000  ', 'Second Vet — (415) 555-0001'] },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.vets, ['New Vet Clinic — (415) 555-0000', 'Second Vet — (415) 555-0001']);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a non-positive day rate, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { dayRate: 0 } }));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('dayRate'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a multi-dog discount outside [0, 1)', async () => {
  const stub = stubSupabase();
  try {
    const tooHigh = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { multiDogDiscount: 1 } }));
    assertEquals(tooHigh.status, 400);
    const negative = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { multiDogDiscount: -0.1 } }));
    assertEquals(negative.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a negative holiday upcharge', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { holidayUpcharge: -0.05 } }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an empty vet list', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { vets: [] } }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a vet list with a blank entry', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, updates: { vets: ['Real Vet — (415) 555-0000', '   '] },
    }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a vet list with a case-insensitive duplicate', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { vets: ['Marin Pet Hospital — (415) 479-8387', 'marin pet hospital — (415) 479-8387'] },
    }));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('duplicate'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('updates the packing list, trimming each entry', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { packingList: ['  Food  ', 'Leash'] },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.packingList, ['Food', 'Leash']);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an empty packing list, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { packingList: [] } }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a packing list with a blank entry', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, updates: { packingList: ['Food', '   '] },
    }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('updates an SMS template, trimming it', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { smsReminder: '  New reminder text {firstName}  ' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.smsReminder, 'New reminder text {firstName}');
    assertEquals(data.smsConfirmation, DEFAULT_ROW.sms_confirmation); // unchanged
  } finally {
    stub.restore();
  }
});

Deno.test('updates the pickup-reminder template, trimming it', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { smsPickupReminder: '  New pickup text {dogName}  ' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.smsPickupReminder, 'New pickup text {dogName}');
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a blank SMS template, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const confirmation = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsConfirmation: '   ' } }));
    assertEquals(confirmation.status, 400);
    const billing = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsBilling: '' } }));
    assertEquals(billing.status, 400);
    const pickup = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsPickupReminder: '   ' } }));
    assertEquals(pickup.status, 400);
    const footer = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsFooter: '   ' } }));
    assertEquals(footer.status, 400);
    const broadcast = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { defaultBroadcastMessage: '   ' } }));
    assertEquals(broadcast.status, 400);
    const requestReceived = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsRequestReceived: '   ' } }));
    assertEquals(requestReceived.status, 400);
    const denied = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { smsDenied: '' } }));
    assertEquals(denied.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('updates the shared SMS footer, trimming it', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { smsFooter: '  New footer {primaryManagerPhone}  ' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.smsFooter, 'New footer {primaryManagerPhone}');
  } finally {
    stub.restore();
  }
});

Deno.test('updates the request-received and denied templates, trimming each', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { smsRequestReceived: '  New request text  ', smsDenied: '  New denied text  ' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.smsRequestReceived, 'New request text');
    assertEquals(data.smsDenied, 'New denied text');
  } finally {
    stub.restore();
  }
});

Deno.test('updates the default broadcast message, trimming it', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { defaultBroadcastMessage: '  New default broadcast text  ' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.defaultBroadcastMessage, 'New default broadcast text');
  } finally {
    stub.restore();
  }
});

Deno.test('updates the about-page photo list, trimming each path/alt, and allows an empty list', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { aboutPhotos: [{ path: '  new123.jpg  ', alt: '  A new photo  ' }] },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.aboutPhotos, [{ path: 'new123.jpg', alt: 'A new photo' }]);

    const cleared = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { aboutPhotos: [] } }));
    assertEquals(cleared.status, 200);
    assertEquals((await cleared.json()).aboutPhotos, []);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an aboutPhotos update that is not a list, or has an entry with no path', async () => {
  const stub = stubSupabase();
  try {
    const notList = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { aboutPhotos: 'nope' } }));
    assertEquals(notList.status, 400);
    const noPath = await handleRequest(postRequest({ password: ADMIN_PASSWORD, updates: { aboutPhotos: [{ alt: 'Missing path' }] } }));
    assertEquals(noPath.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('updates the manager phone numbers, trimming them, and allows clearing one to blank', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD,
      updates: { primaryManagerPhone: '  4155559999  ', secondaryManagerPhone: '4155558888' },
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.primaryManagerPhone, '4155559999');
    assertEquals(data.secondaryManagerPhone, '4155558888');

    const cleared = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, updates: { secondaryManagerPhone: '' },
    }));
    assertEquals(cleared.status, 200);
    assertEquals((await cleared.json()).secondaryManagerPhone, '');
  } finally {
    stub.restore();
  }
});
