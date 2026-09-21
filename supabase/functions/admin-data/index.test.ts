import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

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

function stubSupabase(opts: { dogs?: unknown[]; totalStays?: number } = {}) {
  const dogs = opts.dogs ?? DOGS_FIXTURE;
  const totalStays = opts.totalStays ?? 2;
  const calls: { method: string; table: string; body?: unknown; search?: string }[] = [];

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const table = url.pathname.split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, table, body, search: url.search });

    if (table === 'dogs' && method === 'GET') {
      return new Response(JSON.stringify(dogs), { status: 200 });
    }
    if (table === 'stays' && method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-range': `0-0/${totalStays}` } });
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
