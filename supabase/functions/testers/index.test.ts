import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', 'test-token');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('APP_URL', 'https://kimardenmiller.github.io/bayview-boarding');

const { handleRequest, buildTesterMessage } = await import('./index.ts');

function stubEnvironment(initialTesters: Record<string, unknown>[] = [], opts: { smsFails?: boolean } = {}) {
  const db = { testers: initialTesters.map((t) => ({ ...t })) };
  const smsCalls: { to: string; body: string }[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();

    if (url.hostname === 'api.twilio.com') {
      const params = new URLSearchParams(String(init?.body));
      smsCalls.push({ to: params.get('To') || '', body: params.get('Body') || '' });
      if (opts.smsFails) return new Response(JSON.stringify({ message: 'Twilio down' }), { status: 500 });
      return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
    }

    if (url.pathname.endsWith('/testers')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'GET') {
        const activeOnly = url.searchParams.get('active') === 'eq.true';
        const rows = activeOnly ? db.testers.filter((t) => t.active !== false) : db.testers;
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (method === 'POST') {
        const row = { id: `tester-${db.testers.length + 1}`, active: true, created_at: '2026-09-17T12:00:00Z', ...body };
        db.testers.push(row);
        return new Response(JSON.stringify([row]), { status: 201 });
      }
      if (method === 'DELETE') {
        const id = url.searchParams.get('id')?.replace('eq.', '');
        db.testers = db.testers.filter((t) => t.id !== id);
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }
    throw new Error(`stubEnvironment: unhandled request ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  return { db, smsCalls, restore: () => { globalThis.fetch = original; } };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/testers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('rejects non-POST requests', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/testers', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/testers', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('rejects every action without the correct password', async () => {
  const stub = stubEnvironment();
  try {
    const noPw = await handleRequest(postRequest({ action: 'list' }));
    assertEquals(noPw.status, 401);
    const wrongPw = await handleRequest(postRequest({ password: 'nope', action: 'notify', message: 'hi' }));
    assertEquals(wrongPw.status, 401);
  } finally {
    stub.restore();
  }
});

Deno.test('list: returns every tester', async () => {
  const stub = stubEnvironment([
    { id: 't1', name: 'Jane', phone: '4155550100', email: null, active: true, created_at: '2026-09-17T12:00:00Z' },
    { id: 't2', name: 'Bob', phone: '4155550101', email: null, active: false, created_at: '2026-09-16T12:00:00Z' },
  ]);
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'list' }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.testers.length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test('add: requires a name and phone, then appears in the list', async () => {
  const stub = stubEnvironment();
  try {
    const missingName = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'add', phone: '4155550100' }));
    assertEquals(missingName.status, 400);
    const missingPhone = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'add', name: 'Jane' }));
    assertEquals(missingPhone.status, 400);

    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'add', name: 'Jane', phone: '4155550100' }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.testers.length, 1);
    assertEquals(data.testers[0].name, 'Jane');
    assertEquals(stub.db.testers.length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test('remove: deletes by id', async () => {
  const stub = stubEnvironment([{ id: 't1', name: 'Jane', phone: '4155550100', active: true, created_at: '2026-09-17T12:00:00Z' }]);
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'remove', id: 't1' }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).testers.length, 0);
    assertEquals(stub.db.testers.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('buildTesterMessage: greets the tester by their first name, then the message verbatim', () => {
  const result = buildTesterMessage('Jane Tester', "We've made a few changes, please have a look!");
  assertEquals(result, "Hi Jane, We've made a few changes, please have a look!");
});

Deno.test('buildTesterMessage: falls back to "there" for a blank name', () => {
  assertEquals(buildTesterMessage('', 'Hello!'), 'Hi there, Hello!');
});

Deno.test('notify: requires a message', async () => {
  const stub = stubEnvironment([{ id: 't1', name: 'Jane', phone: '4155550100', active: true, created_at: '2026-09-17T12:00:00Z' }]);
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'notify' }));
    assertEquals(res.status, 400);
    assertEquals(stub.smsCalls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('notify: texts only active testers, each personally greeted by their own first name', async () => {
  const stub = stubEnvironment([
    { id: 't1', name: 'Jane Tester', phone: '4155550100', active: true, created_at: '2026-09-17T12:00:00Z' },
    { id: 't2', name: 'Bob', phone: '4155550101', active: false, created_at: '2026-09-16T12:00:00Z' },
    { id: 't3', name: 'Sam', phone: '4155550102', active: true, created_at: '2026-09-15T12:00:00Z' },
  ]);
  try {
    const res = await handleRequest(postRequest({
      password: ADMIN_PASSWORD, action: 'notify', message: "We've made a few changes, please have a look!",
    }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.sent, 2);
    assertEquals(data.failed, 0);
    assertEquals(data.total, 2);
    assertEquals(stub.smsCalls.length, 2); // Bob (inactive) never texted
    assertEquals(stub.smsCalls[0].body, "Hi Jane, We've made a few changes, please have a look!");
    assertEquals(stub.smsCalls[1].body, "Hi Sam, We've made a few changes, please have a look!");
  } finally {
    stub.restore();
  }
});

Deno.test('notify: counts a failed send without stopping the rest', async () => {
  const stub = stubEnvironment(
    [{ id: 't1', name: 'Jane', phone: '4155550100', active: true, created_at: '2026-09-17T12:00:00Z' }],
    { smsFails: true },
  );
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'notify', message: 'hi' }));
    const data = await res.json();
    assertEquals(data.sent, 0);
    assertEquals(data.failed, 1);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an unknown action', async () => {
  const stub = stubEnvironment();
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, action: 'delete-everything' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});
