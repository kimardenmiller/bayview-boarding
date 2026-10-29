import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', 'test-token');
Deno.env.set('TWILIO_PHONE', '+14155550100');

const { handleRequest, normalizePhone, sha256Hex, MAX_CODES_PER_HOUR, MAX_ATTEMPTS_PER_CODE } = await import('./index.ts');

type Row = Record<string, unknown>;

// A tiny in-memory PostgREST: just enough eq/gt/gte filtering, insert,
// update and delete for what this function actually sends, so the tests
// exercise real round trips (a code inserted by requestCode is the one
// verifyCode later finds) rather than canned per-call responses.
function stubBackend(tables: Record<string, Row[]>, { twilioOk = true } = {}) {
  const texts: { to: string; body: string }[] = [];
  const original = globalThis.fetch;

  function matches(row: Row, params: URLSearchParams): boolean {
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'columns'].includes(key)) continue;
      const [op, ...rest] = raw.split('.');
      const value = rest.join('.');
      const actual = String(row[key] ?? '');
      if (op === 'eq' && actual !== value) return false;
      if (op === 'gt' && !(actual > value)) return false;
      if (op === 'gte' && !(actual >= value)) return false;
    }
    return true;
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();

    if (url.hostname === 'api.twilio.com') {
      const form = new URLSearchParams(String(init?.body));
      texts.push({ to: form.get('To')!, body: form.get('Body')! });
      return new Response('{}', { status: twilioOk ? 201 : 400 });
    }

    const table = url.pathname.split('/').pop()!;
    const rows = (tables[table] ||= []);
    const params = url.searchParams;

    if (method === 'GET') {
      let found = rows.filter((r) => matches(r, params));
      if (params.get('order')?.startsWith('created_at.desc')) {
        found = [...found].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      return new Response(JSON.stringify(found), { status: 200 });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      for (const r of Array.isArray(body) ? body : [body]) {
        rows.push({ id: crypto.randomUUID(), attempts: 0, created_at: new Date().toISOString(), ...r });
      }
      return new Response(null, { status: 201 });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body));
      rows.filter((r) => matches(r, params)).forEach((r) => Object.assign(r, patch));
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      tables[table] = rows.filter((r) => !matches(r, params));
      return new Response(null, { status: 204 });
    }
    throw new Error(`stubBackend: unhandled ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { tables, texts, restore: () => { globalThis.fetch = original; } };
}

function post(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/portal', { method: 'POST', body: JSON.stringify(body) });
}

const OWNER = { id: 'owner-1', phone: '4155550199', name: 'Jane Smith' };
const FUTURE = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

Deno.test('normalizePhone accepts any formatting and a leading 1, rejects anything else', () => {
  assertEquals(normalizePhone('(415) 555-0199'), '4155550199');
  assertEquals(normalizePhone('+1 415 555 0199'), '4155550199');
  assertEquals(normalizePhone('555-0199'), null);
  assertEquals(normalizePhone(undefined), null);
});

Deno.test('requestCode texts a 6-digit code to a known owner and stores only its hash', async () => {
  const stub = stubBackend({ owners: [OWNER] });
  try {
    const res = await handleRequest(post({ action: 'requestCode', phone: '(415) 555-0199' }));
    assertEquals(res.status, 200);
    assertEquals(stub.texts.length, 1);
    assertEquals(stub.texts[0].to, '+14155550199');
    const code = stub.texts[0].body.match(/\b(\d{6})\b/)![1];
    const stored = stub.tables.portal_login_codes[0];
    assertEquals(stored.phone, '4155550199');
    assertEquals(stored.code_hash, await sha256Hex(`4155550199:${code}`));
    assert(!JSON.stringify(stored).includes(code));
  } finally {
    stub.restore();
  }
});

Deno.test('requestCode returns 404 (and texts nothing) for a phone with no owner on file', async () => {
  const stub = stubBackend({ owners: [OWNER] });
  try {
    const res = await handleRequest(post({ action: 'requestCode', phone: '4155550111' }));
    assertEquals(res.status, 404);
    assertEquals(stub.texts.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('requestCode rejects an invalid phone number', async () => {
  const stub = stubBackend({ owners: [OWNER] });
  try {
    const res = await handleRequest(post({ action: 'requestCode', phone: '12345' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('requestCode is rate-limited per phone per hour', async () => {
  const now = new Date().toISOString();
  const recent = Array.from({ length: MAX_CODES_PER_HOUR }, () => ({ phone: OWNER.phone, code_hash: 'x', created_at: now, expires_at: FUTURE() }));
  const stub = stubBackend({ owners: [OWNER], portal_login_codes: recent });
  try {
    const res = await handleRequest(post({ action: 'requestCode', phone: OWNER.phone }));
    assertEquals(res.status, 429);
    assertEquals(stub.texts.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('requestCode reports a failed text rather than claiming success', async () => {
  const stub = stubBackend({ owners: [OWNER] }, { twilioOk: false });
  try {
    const res = await handleRequest(post({ action: 'requestCode', phone: OWNER.phone }));
    assertEquals(res.status, 502);
  } finally {
    stub.restore();
  }
});

Deno.test('verifyCode with the texted code returns a session token good for ~6 months, and the code is single use', async () => {
  const stub = stubBackend({ owners: [OWNER] });
  try {
    await handleRequest(post({ action: 'requestCode', phone: OWNER.phone }));
    const code = stub.texts[0].body.match(/\b(\d{6})\b/)![1];

    const res = await handleRequest(post({ action: 'verifyCode', phone: OWNER.phone, code }));
    assertEquals(res.status, 200);
    const { token } = await res.json();
    assert(typeof token === 'string' && token.length >= 32);

    const session = stub.tables.portal_sessions[0];
    assertEquals(session.owner_id, OWNER.id);
    assertEquals(session.token_hash, await sha256Hex(token));
    const days = (new Date(String(session.expires_at)).getTime() - Date.now()) / 86400000;
    assert(days > 180 && days < 190, `expected ~6 months, got ${days} days`);

    const again = await handleRequest(post({ action: 'verifyCode', phone: OWNER.phone, code }));
    assertEquals(again.status, 401);
  } finally {
    stub.restore();
  }
});

Deno.test('verifyCode rejects a wrong code and counts the attempt', async () => {
  const stub = stubBackend({ owners: [OWNER] });
  try {
    await handleRequest(post({ action: 'requestCode', phone: OWNER.phone }));
    const code = stub.texts[0].body.match(/\b(\d{6})\b/)![1];
    const wrong = code === '000000' ? '111111' : '000000';

    const res = await handleRequest(post({ action: 'verifyCode', phone: OWNER.phone, code: wrong }));
    assertEquals(res.status, 401);
    assertEquals(stub.tables.portal_login_codes[0].attempts, 1);
    assertEquals(stub.tables.portal_sessions?.length ?? 0, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('verifyCode locks the code out after too many wrong tries, even if the right code is then given', async () => {
  const code = '123456';
  const stub = stubBackend({
    owners: [OWNER],
    portal_login_codes: [{
      id: 'c1', phone: OWNER.phone, code_hash: await sha256Hex(`${OWNER.phone}:${code}`),
      attempts: MAX_ATTEMPTS_PER_CODE, created_at: new Date().toISOString(), expires_at: FUTURE(),
    }],
  });
  try {
    const res = await handleRequest(post({ action: 'verifyCode', phone: OWNER.phone, code }));
    assertEquals(res.status, 429);
  } finally {
    stub.restore();
  }
});

Deno.test('verifyCode rejects an expired code', async () => {
  const code = '123456';
  const stub = stubBackend({
    owners: [OWNER],
    portal_login_codes: [{
      id: 'c1', phone: OWNER.phone, code_hash: await sha256Hex(`${OWNER.phone}:${code}`),
      attempts: 0, created_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString(),
    }],
  });
  try {
    const res = await handleRequest(post({ action: 'verifyCode', phone: OWNER.phone, code }));
    assertEquals(res.status, 401);
  } finally {
    stub.restore();
  }
});

Deno.test("stays returns only the session owner's own stays, with dog names flattened", async () => {
  const token = 'a'.repeat(64);
  const stub = stubBackend({
    owners: [OWNER, { id: 'owner-2', phone: '4155550198', name: 'Someone Else' }],
    portal_sessions: [{ token_hash: await sha256Hex(token), owner_id: OWNER.id, expires_at: new Date(Date.now() + 86400000).toISOString() }],
    stays: [
      { id: 's1', owner_id: OWNER.id, check_in: '2026-12-20', approval_status: 'approved', stay_dogs: [{ name: 'Rex' }, { name: 'Fido' }] },
      { id: 's2', owner_id: 'owner-2', check_in: '2026-12-21', approval_status: 'approved', stay_dogs: [{ name: 'Other' }] },
    ],
  });
  try {
    const res = await handleRequest(post({ action: 'stays', token }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.ownerName, 'Jane Smith');
    assertEquals(data.stays.map((s: Row) => s.id), ['s1']);
    assertEquals(data.stays[0].dogNames, ['Rex', 'Fido']);
    assertEquals(data.stays[0].stay_dogs, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test('stays rejects an unknown or expired session with expired:true', async () => {
  const token = 'b'.repeat(64);
  const stub = stubBackend({
    owners: [OWNER],
    portal_sessions: [{ token_hash: await sha256Hex(token), owner_id: OWNER.id, expires_at: new Date(Date.now() - 1000).toISOString() }],
  });
  try {
    for (const t of [token, 'not-a-real-token', undefined]) {
      const res = await handleRequest(post({ action: 'stays', token: t }));
      assertEquals(res.status, 401);
      assertEquals((await res.json()).expired, true);
    }
  } finally {
    stub.restore();
  }
});

Deno.test('logout deletes the session so the token stops working', async () => {
  const token = 'c'.repeat(64);
  const stub = stubBackend({
    owners: [OWNER],
    portal_sessions: [{ token_hash: await sha256Hex(token), owner_id: OWNER.id, expires_at: new Date(Date.now() + 86400000).toISOString() }],
    stays: [],
  });
  try {
    assertEquals((await handleRequest(post({ action: 'logout', token }))).status, 200);
    assertEquals(stub.tables.portal_sessions.length, 0);
    assertEquals((await handleRequest(post({ action: 'stays', token }))).status, 401);
  } finally {
    stub.restore();
  }
});
