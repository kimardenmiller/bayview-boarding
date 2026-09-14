import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

function stubSupabase(ownerRows: unknown[]) {
  const calls: { method: string; table: string; url: URL }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method || 'GET').toUpperCase();
    const table = url.pathname.split('/').pop()!;
    calls.push({ method, table, url });

    if (table === 'owners' && method === 'GET') {
      return new Response(JSON.stringify(ownerRows), { status: 200 });
    }
    throw new Error(`stubSupabase: unhandled request ${method} ${url.pathname}`);
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function postRequest(body: unknown): Request {
  return new Request('https://example.supabase.co/functions/v1/lookup-client', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

Deno.test('returns found:false without querying when phone is empty', async () => {
  const stub = stubSupabase([]);
  try {
    const res = await handleRequest(postRequest({ phone: '  ' }));
    const data = await res.json();
    assertEquals(data.found, false);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test('returns found:false when no owner matches the phone', async () => {
  const stub = stubSupabase([]);
  try {
    const res = await handleRequest(postRequest({ phone: '4155550100' }));
    const data = await res.json();
    assertEquals(data.found, false);
  } finally {
    stub.restore();
  }
});

Deno.test('returns the owner, vet (once, not per-dog), and every dog on file', async () => {
  const stub = stubSupabase([
    {
      name: 'Kim Miller', email: 'kim@test.com', vet_name: 'Marin Pet Hospital',
      dogs: [
        { name: 'Rex', breed: 'Labrador', dob: '2020-01-01', spay_neuter: 'yes' },
        { name: 'Fido', breed: 'Poodle', dob: '2021-06-01', spay_neuter: 'no' },
      ],
    },
  ]);
  try {
    const res = await handleRequest(postRequest({ phone: '4155550100' }));
    const data = await res.json();

    assertEquals(data.found, true);
    assertEquals(data.client.owner_name, 'Kim Miller');
    assertEquals(data.client.vet_name, 'Marin Pet Hospital');
    assertEquals(data.client.dogs.length, 2);
    assertEquals(data.client.dogs[0], { dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01', spay_neuter: 'yes' });
    assertEquals(data.client.dogs[1].dog_name, 'Fido');
  } finally {
    stub.restore();
  }
});

Deno.test('does not return aggression or health fields', async () => {
  const stub = stubSupabase([
    { name: 'Kim Miller', email: 'kim@test.com', vet_name: null, dogs: [{ name: 'Rex', breed: 'Labrador', dob: null, spay_neuter: null }] },
  ]);
  try {
    const res = await handleRequest(postRequest({ phone: '4155550100' }));
    const data = await res.json();
    const dog = data.client.dogs[0];
    assertEquals('aggression_history' in dog, false);
    assertEquals('health_concerns' in dog, false);
  } finally {
    stub.restore();
  }
});

Deno.test('handles an owner with no dogs on file without crashing', async () => {
  const stub = stubSupabase([{ name: 'Kim Miller', email: 'kim@test.com', vet_name: null, dogs: [] }]);
  try {
    const res = await handleRequest(postRequest({ phone: '4155550100' }));
    const data = await res.json();
    assertEquals(data.client.dogs, []);
  } finally {
    stub.restore();
  }
});
