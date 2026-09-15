import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { FakeTime } from 'https://deno.land/std@0.168.0/testing/time.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const CRON_SECRET = 'test-cron-secret';
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
Deno.env.set('CRON_SECRET', CRON_SECRET);

const { handleRequest } = await import('./index.ts');

interface StayRow {
  id: string;
  check_in: string;
  drop_time: string | null;
  reminder_sent_at: string | null;
  owners: { name: string; phone: string };
  stay_dogs: { name: string }[];
}

// Fakes both the Supabase REST API (stays select/update) and the
// function-to-function call this function makes to send-confirmation -
// distinguished by pathname, since both go through the same global fetch.
function stubEnvironment(
  stays: StayRow[],
  opts: { confirmationFails?: boolean; settings?: { sms_reminder: string; packing_list: string[] } | null } = {},
) {
  const db = { stays: stays.map((s) => ({ ...s })) };
  const confirmationCalls: unknown[] = [];
  const original = globalThis.fetch;
  // Defaults to a settings row present (the common case) unless a test
  // explicitly opts into simulating it missing/unreadable.
  const settingsRow = opts.settings === undefined
    ? { sms_reminder: 'Hi {firstName}! bring {packingList}', packing_list: ['Food', 'Leash'] }
    : opts.settings;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.pathname === '/functions/v1/send-confirmation') {
      confirmationCalls.push(body);
      if (opts.confirmationFails) return new Response(JSON.stringify({ error: 'twilio down' }), { status: 500 });
      return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
    }

    if (url.pathname.endsWith('/settings') && method === 'GET') {
      // .maybeSingle() expects a single object (or null), not an array.
      return new Response(settingsRow ? JSON.stringify(settingsRow) : 'null', { status: 200 });
    }

    if (url.pathname.endsWith('/stays')) {
      if (method === 'GET') {
        const checkIn = url.searchParams.get('check_in')?.replace('eq.', '');
        const reminderNull = url.searchParams.get('reminder_sent_at') === 'is.null';
        const matches = db.stays.filter((s) =>
          (!checkIn || s.check_in === checkIn) && (!reminderNull || s.reminder_sent_at === null)
        );
        return new Response(JSON.stringify(matches), { status: 200 });
      }
      if (method === 'PATCH') {
        const id = url.searchParams.get('id')?.replace('eq.', '');
        const row = db.stays.find((s) => s.id === id);
        if (row) Object.assign(row, body);
        return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
      }
    }

    throw new Error(`stubEnvironment: unhandled request ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  return { db, confirmationCalls, restore: () => { globalThis.fetch = original; } };
}

function cronRequest(headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }): Request {
  return new Request(`${SUPABASE_URL}/functions/v1/send-reminders`, { method: 'POST', headers });
}

function stayDueTomorrow(overrides: Partial<StayRow> = {}, time: FakeTime): StayRow {
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
    .format(new Date(time.now + 24 * 60 * 60 * 1000));
  return {
    id: 'stay-1', check_in: tomorrow, drop_time: '09:00:00', reminder_sent_at: null,
    owners: { name: 'Kim Miller', phone: '4155550100' },
    stay_dogs: [{ name: 'Rex' }],
    ...overrides,
  };
}

Deno.test('rejects requests without the correct cron secret, without touching the database', async () => {
  const stub = stubEnvironment([]);
  try {
    const missing = await handleRequest(cronRequest({}));
    assertEquals(missing.status, 401);
    const wrong = await handleRequest(cronRequest({ 'x-cron-secret': 'wrong' }));
    assertEquals(wrong.status, 401);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects non-POST requests', async () => {
  const stub = stubEnvironment([]);
  try {
    const res = await handleRequest(new Request(`${SUPABASE_URL}/functions/v1/send-reminders`, {
      method: 'GET', headers: { 'x-cron-secret': CRON_SECRET },
    }));
    assertEquals(res.status, 405);
  } finally {
    stub.restore();
  }
});

Deno.test('sends a reminder for a stay checking in tomorrow, then marks it sent', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z'); // an ordinary UTC afternoon
  const stub = stubEnvironment([stayDueTomorrow({}, time)]);
  try {
    const res = await handleRequest(cronRequest());
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.sent, 1);
    assertEquals(data.failed, 0);

    assertEquals(stub.confirmationCalls.length, 1);
    assertEquals(stub.confirmationCalls[0], {
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550100',
      dog_name: 'Rex', drop_time: '09:00:00',
      message_template: 'Hi {firstName}! bring {packingList}', packing_list: ['Food', 'Leash'],
    });
    assertEquals(stub.db.stays[0].reminder_sent_at !== null, true);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('joins multiple dog names on a shared stay with " & "', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([stayDueTomorrow({ stay_dogs: [{ name: 'Rex' }, { name: 'Fido' }] }, time)]);
  try {
    await handleRequest(cronRequest());
    assertEquals(stub.confirmationCalls[0], {
      type: 'reminder', owner_name: 'Kim Miller', owner_phone: '4155550100',
      dog_name: 'Rex & Fido', drop_time: '09:00:00',
      message_template: 'Hi {firstName}! bring {packingList}', packing_list: ['Food', 'Leash'],
    });
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('does not re-send to a stay that already has a reminder recorded', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([stayDueTomorrow({ reminder_sent_at: '2026-10-01T16:00:00Z' }, time)]);
  try {
    const res = await handleRequest(cronRequest());
    const data = await res.json();
    assertEquals(data.sent, 0);
    assertEquals(stub.confirmationCalls.length, 0);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('ignores stays checking in on a different day', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([stayDueTomorrow({ check_in: '2026-10-05' }, time)]);
  try {
    const res = await handleRequest(cronRequest());
    const data = await res.json();
    assertEquals(data.sent, 0);
    assertEquals(stub.confirmationCalls.length, 0);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('does not mark reminder_sent_at if the underlying SMS send fails, so it can retry later', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([stayDueTomorrow({}, time)], { confirmationFails: true });
  try {
    const res = await handleRequest(cronRequest());
    const data = await res.json();
    assertEquals(data.sent, 0);
    assertEquals(data.failed, 1);
    assertEquals(stub.db.stays[0].reminder_sent_at, null);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('processes several due stays independently in one run', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([
    stayDueTomorrow({ id: 'stay-1' }, time),
    stayDueTomorrow({ id: 'stay-2', owners: { name: 'Estee Owner', phone: '4155550200' }, stay_dogs: [{ name: 'Buddy' }] }, time),
  ]);
  try {
    const res = await handleRequest(cronRequest());
    const data = await res.json();
    assertEquals(data.sent, 2);
    assertEquals(stub.confirmationCalls.length, 2);
    assertEquals(stub.db.stays.every((s) => s.reminder_sent_at !== null), true);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('still sends (via send-confirmation\'s own fallback) if the settings row is missing', async () => {
  const time = new FakeTime('2026-10-01T18:00:00Z');
  const stub = stubEnvironment([stayDueTomorrow({}, time)], { settings: null });
  try {
    const res = await handleRequest(cronRequest());
    const data = await res.json();
    assertEquals(data.sent, 1);
    const call = stub.confirmationCalls[0] as Record<string, unknown>;
    assertEquals(call.message_template, undefined);
    assertEquals(call.packing_list, undefined);
  } finally {
    time.restore();
    stub.restore();
  }
});

Deno.test('returns sent:0 with no error when nothing is due', async () => {
  const stub = stubEnvironment([]);
  try {
    const res = await handleRequest(cronRequest());
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.sent, 0);
    assertEquals(data.found, 0);
  } finally {
    stub.restore();
  }
});
