import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const ADMIN_PASSWORD = 'test-admin-password';
Deno.env.set('ADMIN_PASSWORD', ADMIN_PASSWORD);
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

interface AboutPhoto { path: string; alt: string }

// Stubs both Storage (upload/remove - the response content is never
// actually read by index.ts, only whether the call succeeded) and the
// `settings` REST endpoint's about_photos column, which upload/delete
// both read-modify-write.
function stubSupabase(existingPhotos: AboutPhoto[] = []) {
  let aboutPhotos = existingPhotos;
  const calls: { method: string; pathname: string; body?: unknown }[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();

    if (url.pathname.startsWith('/storage/v1/object/')) {
      calls.push({ method, pathname: url.pathname });
      return new Response(JSON.stringify({ Key: url.pathname }), { status: 200 });
    }
    if (url.pathname.endsWith('/settings')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, pathname: url.pathname, body });
      if (method === 'GET') {
        return new Response(JSON.stringify([{ about_photos: aboutPhotos }]), { status: 200 });
      }
      if (method === 'PATCH') {
        if (body?.about_photos !== undefined) aboutPhotos = body.about_photos;
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { calls, get aboutPhotos() { return aboutPhotos; }, restore: () => { globalThis.fetch = original; } };
}

function uploadRequest(fields: Record<string, string>, file?: { name: string; type: string; content?: string }): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) {
    form.append('file', new File([file.content ?? 'fake-image-bytes'], file.name, { type: file.type }));
  }
  return new Request('https://example.supabase.co/functions/v1/about-photos', { method: 'POST', body: form });
}

function deleteRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/about-photos', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('answers CORS preflight', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/about-photos', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('rejects non-POST requests', async () => {
  const res = await handleRequest(new Request('https://x/functions/v1/about-photos', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('upload: rejects an incorrect password without touching storage or the database', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ password: 'wrong' }, { name: 'dog.jpg', type: 'image/jpeg' }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('upload: requires a file', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ password: ADMIN_PASSWORD }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('upload: rejects a non-image file', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ password: ADMIN_PASSWORD }, { name: 'doc.pdf', type: 'application/pdf' }));
    assertEquals(res.status, 400);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('upload: stores the file under a fresh random name (never the client\'s own filename) and appends {path, alt}', async () => {
  const stub = stubSupabase([{ path: 'existing.jpg', alt: 'Existing photo' }]);
  try {
    const res = await handleRequest(uploadRequest(
      { password: ADMIN_PASSWORD, alt: '  Bud on the trail  ' },
      { name: '../../etc/passwd.jpg', type: 'image/jpeg' },
    ));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.aboutPhotos.length, 2);
    assertEquals(data.aboutPhotos[0], { path: 'existing.jpg', alt: 'Existing photo' });
    assertEquals(data.aboutPhotos[1].alt, 'Bud on the trail');
    // A fresh UUID-based name, not the client's own filename or path
    assertEquals(data.aboutPhotos[1].path.includes('passwd'), false);
    assertEquals(data.aboutPhotos[1].path.includes('..'), false);
    assertEquals(/^[0-9a-f-]+\.jpg$/.test(data.aboutPhotos[1].path), true);

    const uploadCall = stub.calls.find((c) => c.pathname.startsWith('/storage/v1/object/'));
    assertEquals(uploadCall?.method, 'POST');
    const patchCall = stub.calls.find((c) => c.pathname.endsWith('/settings') && c.method === 'PATCH');
    assertEquals((patchCall?.body as { about_photos: AboutPhoto[] }).about_photos.length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test('upload: alt text defaults to an empty string when not given', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(uploadRequest({ password: ADMIN_PASSWORD }, { name: 'dog.png', type: 'image/png' }));
    const data = await res.json();
    assertEquals(data.aboutPhotos[0].alt, '');
    assertEquals(data.aboutPhotos[0].path.endsWith('.png'), true);
  } finally {
    stub.restore();
  }
});

Deno.test('delete: rejects an incorrect password without touching storage or the database', async () => {
  const stub = stubSupabase([{ path: 'a.jpg', alt: 'A' }]);
  try {
    const res = await handleRequest(deleteRequest({ password: 'wrong', action: 'delete', path: 'a.jpg' }));
    assertEquals(res.status, 401);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('delete: requires a path', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(deleteRequest({ password: ADMIN_PASSWORD, action: 'delete' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});

Deno.test('delete: removes the file from storage and drops just that entry from about_photos', async () => {
  const stub = stubSupabase([{ path: 'a.jpg', alt: 'A' }, { path: 'b.jpg', alt: 'B' }]);
  try {
    const res = await handleRequest(deleteRequest({ password: ADMIN_PASSWORD, action: 'delete', path: 'a.jpg' }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.aboutPhotos, [{ path: 'b.jpg', alt: 'B' }]);

    const removeCall = stub.calls.find((c) => c.pathname.startsWith('/storage/v1/object/'));
    assertEquals(removeCall !== undefined, true);
  } finally {
    stub.restore();
  }
});

Deno.test('rejects an unknown JSON action', async () => {
  const stub = stubSupabase();
  try {
    const res = await handleRequest(deleteRequest({ password: ADMIN_PASSWORD, action: 'launchMissiles' }));
    assertEquals(res.status, 400);
  } finally {
    stub.restore();
  }
});
