import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

function stubSupabase() {
  const calls: { method: string; pathname: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    if (url.pathname.startsWith('/storage/v1/object/')) {
      calls.push({ method, pathname: url.pathname });
      return new Response(JSON.stringify({ Key: url.pathname }), { status: 200 });
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function uploadRequest(file?: { name: string; type: string; content?: string }): Request {
  const form = new FormData();
  if (file) {
    form.append('file', new File([file.content ?? 'fake-image-bytes'], file.name, { type: file.type }));
  }
  return new Request('https://example.supabase.co/functions/v1/dog-photos', { method: 'POST', body: form });
}

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/dog-photos', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('rejects non-POST requests', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/dog-photos', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('rejects a plain JSON body (multipart/form-data required)', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/dog-photos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }));
  assertEquals(res.status, 400);
});

Deno.test('requires a file', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest());
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects a non-image file', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ name: 'doc.pdf', type: 'application/pdf' }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('stores the file under a fresh random name (never the client\'s own filename) and returns its path', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ name: '../../etc/passwd.jpg', type: 'image/jpeg' }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.path.includes('passwd'), false);
    assertEquals(data.path.includes('..'), false);
    assertEquals(/^[0-9a-f-]+\.jpg$/.test(data.path), true);

    const uploadCall = stub.calls.find((c) => c.pathname.startsWith('/storage/v1/object/'));
    assertEquals(uploadCall?.method, 'POST');
    assertEquals(uploadCall?.pathname.includes('/dog-photos/'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('picks the extension up from content type when the filename has none usable', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ name: 'photo', type: 'image/png' }));
    const data = await res.json();
    assertEquals(data.path.endsWith('.png'), true);
  } finally {
    stub.restore();
  }
});
