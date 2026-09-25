import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
Deno.env.set('GOOGLE_CALENDAR_CLIENT_ID', 'test-google-client-id');
Deno.env.set('GOOGLE_CALENDAR_CLIENT_SECRET', 'test-google-client-secret');
Deno.env.set('GOOGLE_CALENDAR_REFRESH_TOKEN', 'test-google-refresh-token');
Deno.env.set('GOOGLE_CALENDAR_ID', 'test-calendar-id@group.calendar.google.com');

const { handleRequest } = await import('./index.ts');

// Fixture shaped like PostgREST's actual embed response for
// dogs -> owner:owners(...) and dogs -> stay_dogs(..., stay:stays(...)) -
// deliberately out of chronological order, to verify handleRequest sorts
// each dog's stays newest-first rather than trusting insertion order.
// The two stay_dogs rows carry different aggression_history snapshots
// (the profile has since been updated between the two stays) to verify
// the per-stay historical snapshot survives distinct from the current
// dog-level profile.
const DOGS_FIXTURE = [
  {
    id: 'dog-1', name: 'Rex', breed: 'Labrador', dob: '2020-01-01', spay_neuter: 'yes',
    aggression_history: 'yes', aggression_detail: 'Growls at the mail carrier', health_concerns: 'no', health_detail: null,
    owner: { name: 'Kim Miller', phone: '4155550100', email: 'kim@test.com' },
    stay_dogs: [
      {
        name: 'Rex', breed: 'Labrador', dob: '2020-01-01', spay_neuter: 'yes',
        aggression_history: 'no', aggression_detail: null, health_concerns: 'no', health_detail: null,
        stay: { id: 'stay-1', check_in: '2026-08-01', check_out: '2026-08-03', drop_time: '09:00:00', pickup_time: '09:00:00', notes: '', estimated_cost: 210, number_of_dogs: 1, submitted_at: '2026-07-01T00:00:00Z' },
      },
      {
        name: 'Rex', breed: 'Labrador', dob: '2020-01-01', spay_neuter: 'yes',
        aggression_history: 'yes', aggression_detail: 'Growls at the mail carrier', health_concerns: 'no', health_detail: null,
        stay: { id: 'stay-2', check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '09:00:00', notes: '', estimated_cost: 210, number_of_dogs: 1, submitted_at: '2026-09-01T00:00:00Z' },
      },
    ],
  },
];

// The row syncStayCalendarEvent's own .single() select reads - a
// separate, minimal fixture from DOGS_FIXTURE above (which shapes the
// *response* of the admin dog listing, not this internal lookup).
// null means "not found" (a 406, matching real PostgREST .single()
// behavior on 0 rows) - not used by default, only by tests that need it.
const DEFAULT_STAY_ROW = {
  calendar_event_id: null,
  check_in: '2026-10-01', check_out: '2026-10-03', drop_time: '09:00:00', pickup_time: '17:00:00',
  stay_dogs: [{ name: 'Rex', dogs: { owner: { name: 'Kim Miller', phone: '4155550100' } } }],
};

function stubSupabase(opts: {
  dogs?: unknown[]; totalStays?: number;
  stayRow?: Record<string, unknown> | null;
  googleTokenStatus?: number; googleEventStatus?: number;
} = {}) {
  const dogs = opts.dogs ?? DOGS_FIXTURE;
  const totalStays = opts.totalStays ?? 2;
  const stayRow = opts.stayRow !== undefined ? opts.stayRow : DEFAULT_STAY_ROW;
  const calls: { method: string; table: string; body?: unknown; search?: string }[] = [];

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();

    // Google's OAuth token endpoint - a URL-encoded form body, not JSON,
    // so this has to be handled before the generic JSON.parse below.
    if (url.hostname === 'oauth2.googleapis.com') {
      const params = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ method, table: 'google-token', body: Object.fromEntries(params), search: url.search });
      if (opts.googleTokenStatus && opts.googleTokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: opts.googleTokenStatus });
      }
      return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3599 }), { status: 200 });
    }
    // Google Calendar's events endpoint (create: POST .../events, update:
    // PATCH .../events/{id}).
    if (url.hostname === 'www.googleapis.com' && url.pathname.includes('/calendar/v3/calendars/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, table: 'google-calendar-event', body, search: url.pathname });
      if (opts.googleEventStatus && opts.googleEventStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: opts.googleEventStatus });
      }
      return new Response(JSON.stringify({ id: 'fake-event-id' }), { status: 200 });
    }

    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : { paths: [] };
      calls.push({ method, table: 'storage-sign', body, search: url.search });
      // storage-js's client prepends "{SUPABASE_URL}/storage/v1" itself -
      // the raw REST response's signedURL only has the path after that.
      const signed = (body.paths as string[]).map((path) => ({
        path, signedURL: `/object/sign/dog-photos/${path}?token=fake`, error: null,
      }));
      return new Response(JSON.stringify(signed), { status: 200 });
    }

    const table = url.pathname.split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, table, body, search: url.search });

    if (table === 'dogs' && method === 'GET') {
      return new Response(JSON.stringify(dogs), { status: 200 });
    }
    if (table === 'stays' && method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-range': `0-0/${totalStays}` } });
    }
    // syncStayCalendarEvent's own .single() lookup - real PostgREST
    // returns the object directly (not array-wrapped) for .single(), or
    // a 406 if no row matches.
    if (table === 'stays' && method === 'GET') {
      if (stayRow === null) return new Response(JSON.stringify({ message: 'not found' }), { status: 406 });
      return new Response(JSON.stringify(stayRow), { status: 200 });
    }
    if (table === 'stays' && method === 'PATCH') {
      return new Response(JSON.stringify([{ id: url.searchParams.get('id')?.replace('eq.', ''), ...body }]), { status: 200 });
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/admin-data', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('rejects an incorrect password without querying the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: 'wrong' }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('returns dogs (each with owner + stay history) and the total stays count', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    assertEquals(res.status, 200);
    const data = await res.json();

    assertEquals(data.totalStays, 2);
    assertEquals(data.dogs.length, 1);
    assertEquals(data.dogs[0].name, 'Rex');
    assertEquals(data.dogs[0].owner.name, 'Kim Miller');
    assertEquals(data.dogs[0].owner.phone, '4155550100');
  } finally {
    stub.restore();
  }
});

Deno.test('flattens stay_dogs into a plain stays array, sorted newest check-in first', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    const data = await res.json();

    const stays = data.dogs[0].stays;
    assertEquals(stays.length, 2);
    assertEquals(stays[0].check_in, '2026-10-01'); // newest first, despite fixture order
    assertEquals(stays[1].check_in, '2026-08-01');
    assertEquals(data.dogs[0].stay_dogs, undefined); // join rows should not leak through
  } finally {
    stub.restore();
  }
});

Deno.test('each stay keeps its own frozen aggression snapshot, distinct from the dog\'s current profile', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    const data = await res.json();
    const dog = data.dogs[0];
    const stays = dog.stays;

    // Current profile (top-level) reflects the latest answer.
    assertEquals(dog.aggression_history, 'yes');

    // But each stay shows exactly what was declared/signed at the time.
    const older = stays.find((s: { check_in: string }) => s.check_in === '2026-08-01');
    const newer = stays.find((s: { check_in: string }) => s.check_in === '2026-10-01');
    assertEquals(older.aggression_history, 'no');
    assertEquals(newer.aggression_history, 'yes');
    assertEquals(newer.aggression_detail, 'Growls at the mail carrier');
  } finally {
    stub.restore();
  }
});

Deno.test('a dog with no stays gets an empty stays array, not an error', async () => {
  const stub = stubSupabase({
    dogs: [{ ...DOGS_FIXTURE[0], stay_dogs: [] }],
  });
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    const data = await res.json();
    assertEquals(data.dogs[0].stays, []);
  } finally {
    stub.restore();
  }
});

Deno.test('a stay with multiple photo_paths gets signed photoUrls, in order (the "dog-photos" bucket is private, Sept 21-22, 2026)', async () => {
  const dogs = [{
    ...DOGS_FIXTURE[0],
    stay_dogs: [
      { ...DOGS_FIXTURE[0].stay_dogs[0], photo_paths: ['photo-abc.jpg', 'photo-def.jpg'] },
      { ...DOGS_FIXTURE[0].stay_dogs[1], photo_paths: [] },
    ],
  }];
  const stub = stubSupabase({ dogs });
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    const data = await res.json();
    const stays = data.dogs[0].stays;
    const withPhotos = stays.find((s: { id: string }) => s.id === 'stay-1');
    const withoutPhotos = stays.find((s: { id: string }) => s.id === 'stay-2');

    assertEquals(withPhotos.photoUrls, [
      'https://example.supabase.co/storage/v1/object/sign/dog-photos/photo-abc.jpg?token=fake',
      'https://example.supabase.co/storage/v1/object/sign/dog-photos/photo-def.jpg?token=fake',
    ]);
    assertEquals(withoutPhotos.photoUrls, []);

    const signCall = stub.calls.find((c) => c.table === 'storage-sign');
    assertEquals((signCall?.body as { paths: string[] }).paths, ['photo-abc.jpg', 'photo-def.jpg']);
  } finally {
    stub.restore();
  }
});

Deno.test('never calls the Storage sign endpoint when nothing has a photo', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    const data = await res.json();
    assertEquals(data.dogs[0].stays[0].photoUrls, []);
    assertEquals(stub.calls.some((c) => c.table === 'storage-sign'), false);
  } finally {
    stub.restore();
  }
});

Deno.test('billStay: requires stayId', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'billStay' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('billStay: patches only the fields given, plus billed_at, then returns the refreshed dog list', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'billStay', stayId: 'stay-2',
      checkOut: '2026-10-04', pickupTime: '11:00:00', estimatedCost: 250,
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.dogs.length, 1); // still returns the normal dogs+totalStays shape

    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    assertEquals(patchCall.search, '?id=eq.stay-2');
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(body.check_out, '2026-10-04');
    assertEquals(body.pickup_time, '11:00:00');
    assertEquals(body.estimated_cost, 250);
    assertEquals(typeof body.billed_at, 'string');
    assertEquals('check_in' in body, false); // not sent, not touched
  } finally {
    stub.restore();
  }
});

Deno.test('billStay: marks billed_at even with no date/cost corrections', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'billStay', stayId: 'stay-2' }));
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(Object.keys(body), ['billed_at']);
  } finally {
    stub.restore();
  }
});

Deno.test('editStay: requires stayId', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'editStay' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('editStay: patches only the fields given, and never touches billed_at or approval_status (Sept 24, 2026)', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'editStay', stayId: 'stay-2',
      checkOut: '2026-10-04', pickupTime: '11:00:00', estimatedCost: 250,
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.dogs.length, 1); // still returns the normal dogs+totalStays shape

    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    assertEquals(patchCall.search, '?id=eq.stay-2');
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(body.check_out, '2026-10-04');
    assertEquals(body.pickup_time, '11:00:00');
    assertEquals(body.estimated_cost, 250);
    assertEquals('check_in' in body, false); // not sent, not touched
    assertEquals('billed_at' in body, false);
    assertEquals('approval_status' in body, false);
  } finally {
    stub.restore();
  }
});

Deno.test('editStay: with no fields given, patches nothing at all', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'editStay', stayId: 'stay-2' }));
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(Object.keys(body), []);
  } finally {
    stub.restore();
  }
});

Deno.test('approveStay: requires stayId', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'approveStay' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('approveStay: sets approval_status approved and stamps approved_at', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'approveStay', stayId: 'stay-2' }));
    assertEquals(res.status, 200);
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    assertEquals(patchCall.search, '?id=eq.stay-2');
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(body.approval_status, 'approved');
    assertEquals(typeof body.approved_at, 'string');
  } finally {
    stub.restore();
  }
});

Deno.test('approveStay: creates a Google Calendar event and saves its id (Sept 25, 2026, on request)', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'approveStay', stayId: 'stay-2' }));
    assertEquals(res.status, 200);

    const tokenCall = stub.calls.find((c) => c.table === 'google-token')!;
    assertEquals((tokenCall.body as Record<string, unknown>).refresh_token, 'test-google-refresh-token');
    assertEquals((tokenCall.body as Record<string, unknown>).grant_type, 'refresh_token');

    const eventCall = stub.calls.find((c) => c.table === 'google-calendar-event')!;
    assertEquals(eventCall.method, 'POST');
    const eventBody = eventCall.body as Record<string, unknown>;
    assertEquals(eventBody.summary, 'Rex — Bayview Boarding');
    assertEquals(eventBody.description, 'Owner: Kim Miller (4155550100)');
    assertEquals((eventBody.start as Record<string, unknown>).dateTime, '2026-10-01T09:00:00');
    assertEquals((eventBody.end as Record<string, unknown>).dateTime, '2026-10-03T17:00:00');

    // The event's id came back from the (stubbed) Google API and got
    // saved on the stay in a follow-up patch.
    const patchCalls = stub.calls.filter((c) => c.table === 'stays' && c.method === 'PATCH');
    assertEquals(patchCalls.length, 2); // the approval patch, then this one
    const calendarPatch = patchCalls.find((c) => (c.body as Record<string, unknown>).calendar_event_id)!;
    assertEquals((calendarPatch.body as Record<string, unknown>).calendar_event_id, 'fake-event-id');
  } finally {
    stub.restore();
  }
});

Deno.test('approveStay: still succeeds even when Google Calendar is unreachable (best-effort, Sept 25, 2026)', async () => {
  const stub = stubSupabase({ googleTokenStatus: 500 });
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'approveStay', stayId: 'stay-2' }));
    assertEquals(res.status, 200); // approving the stay itself never fails because of this
    const data = await res.json();
    assertEquals(data.dogs.length, 1);

    // The approval patch happened; no second patch, since there's no
    // event id to save when creation failed.
    const patchCalls = stub.calls.filter((c) => c.table === 'stays' && c.method === 'PATCH');
    assertEquals(patchCalls.length, 1);
    assertEquals((patchCalls[0].body as Record<string, unknown>).approval_status, 'approved');
  } finally {
    stub.restore();
  }
});

Deno.test('billStay: updates the existing calendar event when dates/times change (Sept 25, 2026)', async () => {
  const stub = stubSupabase({ stayRow: { ...DEFAULT_STAY_ROW, calendar_event_id: 'existing-event-id' } });
  try {
    await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'billStay', stayId: 'stay-2', checkOut: '2026-10-04',
    }));
    const eventCall = stub.calls.find((c) => c.table === 'google-calendar-event')!;
    assertEquals(eventCall.method, 'PATCH');
    assertEquals(eventCall.search?.endsWith('/existing-event-id'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('billStay: never touches the calendar when only the cost changes, not dates/times', async () => {
  const stub = stubSupabase({ stayRow: { ...DEFAULT_STAY_ROW, calendar_event_id: 'existing-event-id' } });
  try {
    await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'billStay', stayId: 'stay-2', estimatedCost: 300 }));
    assertEquals(stub.calls.some((c) => c.table === 'google-token' || c.table === 'google-calendar-event'), false);
  } finally {
    stub.restore();
  }
});

Deno.test('editStay: a still-pending stay with no calendar event yet is left alone, even if dates change', async () => {
  const stub = stubSupabase({ stayRow: DEFAULT_STAY_ROW }); // calendar_event_id: null
  try {
    await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'editStay', stayId: 'stay-2', checkOut: '2026-10-04',
    }));
    // Looked the stay up (to check for an event id) but never created one -
    // editStay/billStay only ever update an existing event, never create.
    assertEquals(stub.calls.some((c) => c.table === 'google-calendar-event'), false);
  } finally {
    stub.restore();
  }
});

Deno.test('denyStay: requires stayId', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'denyStay' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('denyStay: sets approval_status denied, stamps denied_at, and saves a trimmed reason', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'denyStay', stayId: 'stay-2', denialReason: '  Fully booked that week  ',
    }));
    assertEquals(res.status, 200);
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(body.approval_status, 'denied');
    assertEquals(typeof body.denied_at, 'string');
    assertEquals(body.denial_reason, 'Fully booked that week');
  } finally {
    stub.restore();
  }
});

Deno.test('denyStay: a blank/missing reason is saved as null, not an empty string', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'denyStay', stayId: 'stay-2' }));
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(body.denial_reason, null);
  } finally {
    stub.restore();
  }
});

Deno.test('markPaid: requires stayId', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'markPaid' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('markPaid: sets paid_at, nothing else', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'markPaid', stayId: 'stay-2' }));
    assertEquals(res.status, 200);
    const patchCall = stub.calls.find((c) => c.table === 'stays' && c.method === 'PATCH')!;
    assertEquals(patchCall.search, '?id=eq.stay-2');
    const body = patchCall.body as Record<string, unknown>;
    assertEquals(Object.keys(body), ['paid_at']);
    assertEquals(typeof body.paid_at, 'string');
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an unknown action', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'deleteEverything' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});
