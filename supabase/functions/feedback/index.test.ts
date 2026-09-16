import { assertEquals, assert } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

function stubSupabase(initial: Record<string, unknown>[] = []) {
  const db = { feedback: initial.map((f) => ({ ...f })) };
  const calls: { method: string; body: unknown; search: string }[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body, search: url.search });

    if (url.pathname.endsWith('/feedback')) {
      if (method === 'POST') {
        const row = { id: `fb-${db.feedback.length + 1}`, status: 'open', created_at: '2026-09-16T12:00:00Z', ...body };
        db.feedback.push(row);
        return new Response(JSON.stringify([row]), { status: 201 });
      }
      if (method === 'GET') {
        return new Response(JSON.stringify(db.feedback), { status: 200 });
      }
      if (method === 'PATCH') {
        const id = url.searchParams.get('id')?.replace('eq.', '');
        const row = db.feedback.find((f) => f.id === id);
        if (row) Object.assign(row, body);
        return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
      }
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  return { db, calls, restore: () => { globalThis.fetch = original; } };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('rejects non-POST requests', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/feedback', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/feedback', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('public submit: requires a message, no password needed', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ name: 'Jane' }));
    assertEquals(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('Message'));
  } finally {
    stub.restore();
  }
});

Deno.test('public submit: stores name/contact/category/message, defaults category to idea', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(postRequest({ message: 'The booking flow is confusing on step 2' }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).success, true);
    assertEquals(stub.db.feedback.length, 1);
    assertEquals(stub.db.feedback[0].category, 'idea');
    assertEquals(stub.db.feedback[0].status, 'open');
  } finally {
    stub.restore();
  }
});

Deno.test('public submit: accepts a valid category, ignores an invalid one', async () => {
  const stub = stubSupabase();
  try {
    await handleRequest(postRequest({ message: 'Found a bug', category: 'bug', name: 'Jane', contact: 'jane@test.com' }));
    assertEquals(stub.db.feedback[0].category, 'bug');
    assertEquals(stub.db.feedback[0].name, 'Jane');
    assertEquals(stub.db.feedback[0].contact, 'jane@test.com');

    await handleRequest(postRequest({ message: 'Second one', category: 'not-a-real-category' }));
    assertEquals(stub.db.feedback[1].category, 'idea'); // falls back to the default
  } finally {
    stub.restore();
  }
});

Deno.test('admin list: requires the correct password', async () => {
  const stub = stubSupabase([{ id: 'fb-1', message: 'x', category: 'idea', status: 'open', created_at: '2026-09-16T12:00:00Z' }]);
  try {
    const wrong = await handleRequest(postRequest({ password: 'nope' }));
    assertEquals(wrong.status, 401);
  } finally {
    stub.restore();
  }
});

Deno.test('admin list: returns every submission newest-first-from-the-db plus the open count', async () => {
  const stub = stubSupabase([
    { id: 'fb-1', message: 'Bug one', category: 'bug', status: 'open', created_at: '2026-09-16T12:00:00Z' },
    { id: 'fb-2', message: 'Idea one', category: 'idea', status: 'done', created_at: '2026-09-15T12:00:00Z' },
    { id: 'fb-3', message: 'Bug two', category: 'bug', status: 'open', created_at: '2026-09-14T12:00:00Z' },
  ]);
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.feedback.length, 3);
    assertEquals(data.openCount, 2);
  } finally {
    stub.restore();
  }
});

Deno.test('admin update status: requires the correct password and a valid status', async () => {
  const stub = stubSupabase([{ id: 'fb-1', message: 'x', category: 'idea', status: 'open', created_at: '2026-09-16T12:00:00Z' }]);
  try {
    const wrongPw = await handleRequest(postRequest({ password: 'nope', id: 'fb-1', status: 'done' }));
    assertEquals(wrongPw.status, 401);

    const badStatus = await handleRequest(postRequest({ password: ADMIN_PASSWORD, id: 'fb-1', status: 'not-a-status' }));
    assertEquals(badStatus.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('admin update status: moves a submission through open -> considered -> done', async () => {
  const stub = stubSupabase([{ id: 'fb-1', message: 'x', category: 'idea', status: 'open', created_at: '2026-09-16T12:00:00Z' }]);
  try {
    const res1 = await handleRequest(postRequest({ password: ADMIN_PASSWORD, id: 'fb-1', status: 'considered' }));
    assertEquals((await res1.json()).feedback.status, 'considered');
    assertEquals(stub.db.feedback[0].status, 'considered');

    const res2 = await handleRequest(postRequest({ password: ADMIN_PASSWORD, id: 'fb-1', status: 'done' }));
    assertEquals((await res2.json()).feedback.status, 'done');
  } finally {
    stub.restore();
  }
});

Deno.test('admin update status: 404 for an id that does not exist', async () => {
  const stub = stubSupabase([]);
  try {
    const res = await handleRequest(postRequest({ password: ADMIN_PASSWORD, id: 'nope', status: 'done' }));
    assertEquals(res.status, 404);
  } finally {
    stub.restore();
  }
});
