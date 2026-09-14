import { assertEquals, assert } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { FakeTime } from 'https://deno.land/std@0.168.0/testing/time.ts';

// See receive-sms/index.test.ts for why this needs a dynamic import: the
// module reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY from env at import
// time, so they must be set first.
const SUPABASE_URL = 'https://example.supabase.co';
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

// A minimal in-memory stand-in for the PostgREST endpoints submit-booking
// talks to (owners/dogs/stays/stay_dogs), routed by table + HTTP method,
// so tests exercise the real find-or-create logic without hitting a real
// database or a real Supabase project.
function stubSupabase() {
  const db = {
    owners: [] as Record<string, unknown>[],
    dogs: [] as Record<string, unknown>[],
    stays: [] as Record<string, unknown>[],
    stayDogs: [] as Record<string, unknown>[],
  };
  let ownerSeq = 0, dogSeq = 0, staySeq = 0;
  const calls: { method: string; table: string; body: unknown }[] = [];

  function eqValue(params: URLSearchParams, key: string): string | null {
    const raw = params.get(key);
    if (!raw || !raw.startsWith('eq.')) return null;
    return decodeURIComponent(raw.slice(3));
  }

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const rawBody = init?.body ? String(init.body) : undefined;
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const table = url.pathname.split('/').pop()!;
    calls.push({ method, table, body });

    if (table === 'owners') {
      if (method === 'GET') {
        const phone = eqValue(url.searchParams, 'phone');
        const rows = db.owners.filter((o) => o.phone === phone);
        return new Response(JSON.stringify(rows.map((o) => ({ id: o.id }))), { status: 200 });
      }
      if (method === 'POST') {
        const row = { id: `owner-${++ownerSeq}`, ...body };
        db.owners.push(row);
        return new Response(JSON.stringify([{ id: row.id }]), { status: 201 });
      }
      if (method === 'PATCH') {
        const id = eqValue(url.searchParams, 'id');
        const row = db.owners.find((o) => o.id === id);
        if (row) Object.assign(row, body);
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    if (table === 'dogs') {
      if (method === 'GET') {
        const ownerId = eqValue(url.searchParams, 'owner_id');
        const rows = db.dogs.filter((d) => d.owner_id === ownerId);
        return new Response(JSON.stringify(rows.map((d) => ({ id: d.id, name: d.name }))), { status: 200 });
      }
      if (method === 'POST') {
        const row = { id: `dog-${++dogSeq}`, ...body };
        db.dogs.push(row);
        return new Response(JSON.stringify([{ id: row.id }]), { status: 201 });
      }
      if (method === 'PATCH') {
        const id = eqValue(url.searchParams, 'id');
        const row = db.dogs.find((d) => d.id === id);
        if (row) Object.assign(row, body);
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    if (table === 'stays' && method === 'POST') {
      const row = { id: `stay-${++staySeq}`, submitted_at: new Date().toISOString(), ...body };
      db.stays.push(row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }

    if (table === 'stay_dogs' && method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      db.stayDogs.push(...rows);
      return new Response(JSON.stringify([]), { status: 201 });
    }

    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { db, calls, restore: () => { globalThis.fetch = original; } };
}

function validBooking(overrides: Record<string, unknown> = {}) {
  return {
    owner: { name: 'Kim Miller', phone: '4155550100', email: 'kim@test.com', vetName: 'Marin Pet Hospital' },
    dogs: [{ name: 'Rex', breed: 'Labrador', dob: '2020-01-01', spayNeuter: 'yes' }],
    checkIn: '2026-10-01',
    checkOut: '2026-10-03',
    dropTime: '09:00',
    pickupTime: '09:00',
    notes: '',
    estimatedCost: 210,
    signature: 'Kim Miller',
    ...overrides,
  };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/submit-booking', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('rejects non-POST requests', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(new Request('https://x/functions/v1/submit-booking', { method: 'GET' }));
    assertEquals(res.status, 405);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a booking missing required fields, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ owner: { name: 'Kim' } }));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('owner.phone'));
    assert(data.error.includes('dogs'));
    assert(data.error.includes('checkIn'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a dog missing name/breed', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({ dogs: [{ name: '', breed: '' }] })));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('dogs[0].name'));
    assert(data.error.includes('dogs[0].breed'));
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a check-in date in the past, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({ checkIn: '2020-01-01', checkOut: '2020-01-02' })));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('checkIn'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a check-out before check-in, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({ checkIn: '2026-10-05', checkOut: '2026-10-01' })));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('checkOut'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a same-day pick-up at or before drop-off, without touching the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      checkIn: '2026-10-01', checkOut: '2026-10-01', dropTime: '17:00', pickupTime: '09:00',
    })));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('pickupTime'));
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('allows an evening drop-off and a next-morning pick-up across different days', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      checkIn: '2026-10-01', checkOut: '2026-10-02', dropTime: '17:00', pickupTime: '09:00',
    })));
    assertEquals(res.status, 200);
  } finally {
    stub.restore();
  }
});

Deno.test('computes "today" from clientTimezone, not UTC - accepts a same-day Pacific booking made in the evening', async () => {
  // 06:00 UTC = 11pm PDT the previous evening. A plain UTC "today" would
  // be one calendar day ahead of Pacific's actual today, and would wrongly
  // reject a checkIn of that Pacific today as "in the past" - exactly the
  // bug this guards against (see todayISO's comment).
  const time = new FakeTime('2026-03-16T06:00:00Z');
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      checkIn: '2026-03-15', checkOut: '2026-03-16', clientTimezone: 'America/Los_Angeles',
    })));
    assertEquals(res.status, 200);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('still rejects a date genuinely before the client\'s local today', async () => {
  const time = new FakeTime('2026-03-16T06:00:00Z'); // Pacific "today" is Mar 15
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      checkIn: '2026-03-14', checkOut: '2026-03-15', clientTimezone: 'America/Los_Angeles',
    })));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('falls back to UTC "today" when clientTimezone is missing or invalid', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      checkIn: '2020-01-01', checkOut: '2020-01-02', clientTimezone: 'Not/ARealZone',
    })));
    assertEquals(res.status, 400); // still rejected as past, just via the UTC fallback
  } finally {
    stub.restore();
  }
});

Deno.test('a new owner with a new dog creates one owner, one dog, one stay, one link', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking()));
    assertEquals(res.status, 200);
    const data = await res.json();

    assertEquals(stub.db.owners.length, 1);
    assertEquals(stub.db.dogs.length, 1);
    assertEquals(stub.db.stays.length, 1);
    assertEquals(stub.db.stayDogs.length, 1);
    assertEquals(stub.db.owners[0].vet_name, 'Marin Pet Hospital');
    assertEquals(stub.db.stays[0].number_of_dogs, 1);

    assertEquals(data.stay.owner_name, 'Kim Miller');
    assertEquals(data.stay.dog_names, ['Rex']);
  } finally {
    stub.restore();
  }
});

Deno.test('a booking with multiple dogs creates a dog + link per dog', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest(validBooking({
      dogs: [
        { name: 'Rex', breed: 'Labrador' },
        { name: 'Fido', breed: 'Poodle' },
      ],
    })));
    assertEquals(res.status, 200);
    const data = await res.json();

    assertEquals(stub.db.dogs.length, 2);
    assertEquals(stub.db.stayDogs.length, 2);
    assertEquals(stub.db.stays[0].number_of_dogs, 2);
    assertEquals(data.stay.dog_names, ['Rex', 'Fido']);
  } finally {
    stub.restore();
  }
});

Deno.test('a returning owner (same phone) updates their existing owner record instead of duplicating', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest(validBooking()));
    const res2 = await handleRequest(postRequest(validBooking({
      owner: { name: 'Kim Miller', phone: '4155550100', email: 'kim@test.com', vetName: 'Marin Pet Hospital' },
      dogs: [{ name: 'Rex', breed: 'Labrador' }],
    })));
    assertEquals(res2.status, 200);

    assertEquals(stub.db.owners.length, 1); // still just the one owner
    assertEquals(stub.db.stays.length, 2);  // but a second stay
  } finally {
    stub.restore();
  }
});

Deno.test('a returning dog (same owner, case-insensitive name match) updates instead of duplicating', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest(validBooking({ dogs: [{ name: 'Rex', breed: 'Labrador' }] })));
    await handleRequest(postRequest(validBooking({ dogs: [{ name: 'REX', breed: 'Labrador Retriever' }] })));

    assertEquals(stub.db.dogs.length, 1); // matched case-insensitively, not duplicated
    assertEquals(stub.db.dogs[0].breed, 'Labrador Retriever'); // profile updated to the latest values
  } finally {
    stub.restore();
  }
});

Deno.test('stay_dogs carries a frozen snapshot of what was declared for that stay, separate from the current profile', async () => {
  const stub = stubSupabase();
  try {
    // First stay: aggression "no". Second stay (same dog, matched by name): aggression "yes".
    await handleRequest(postRequest(validBooking({
      dogs: [{ name: 'Rex', breed: 'Labrador', aggressionHistory: 'no' }],
    })));
    await handleRequest(postRequest(validBooking({
      dogs: [{ name: 'Rex', breed: 'Labrador', aggressionHistory: 'yes', aggressionDetail: 'Growls at the mail carrier' }],
    })));

    assertEquals(stub.db.dogs.length, 1); // one profile, matched across both stays
    assertEquals(stub.db.dogs[0].aggression_history, 'yes'); // profile holds only the latest

    assertEquals(stub.db.stayDogs.length, 2);
    assertEquals(stub.db.stayDogs[0].aggression_history, 'no');       // first stay's signed snapshot is untouched
    assertEquals(stub.db.stayDogs[1].aggression_history, 'yes');
    assertEquals(stub.db.stayDogs[1].aggression_detail, 'Growls at the mail carrier');
    assertEquals(stub.db.stayDogs[0].name, 'Rex');
    assertEquals(stub.db.stayDogs[0].breed, 'Labrador');
  } finally {
    stub.restore();
  }
});

Deno.test('a new dog for an existing owner is added without touching their other dogs', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest(validBooking({ dogs: [{ name: 'Rex', breed: 'Labrador' }] })));
    await handleRequest(postRequest(validBooking({ dogs: [{ name: 'Fido', breed: 'Poodle' }] })));

    assertEquals(stub.db.owners.length, 1);
    assertEquals(stub.db.dogs.length, 2);
    assertEquals(stub.db.dogs.find((d) => d.name === 'Rex')?.breed, 'Labrador');
  } finally {
    stub.restore();
  }
});
