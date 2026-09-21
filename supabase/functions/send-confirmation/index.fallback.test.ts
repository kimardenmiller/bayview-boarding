import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

// A separate file (not just a test within index.test.ts) so the module
// loads fresh with NO TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET set at
// all - this is what staging looks like today, and genuine Twilio "Test
// Credentials" have no API-key equivalent (see index.ts's comment) -
// index.test.ts's own import already has both set, and Deno caches a
// module's top-level env reads for the life of that import, so testing
// "no API key configured" needs its own fresh process/import, not a
// second Deno.test in the same file.
Deno.env.set('TWILIO_ACCOUNT_SID', 'ACtest');
Deno.env.set('TWILIO_AUTH_TOKEN', 'test-auth-token');
Deno.env.set('TWILIO_PHONE', '+14155550100');
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

const { handleRequest } = await import('./index.ts');

function stubEnvironment() {
  const original = globalThis.fetch;
  const calls: { authorization: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'api.twilio.com') {
      const authorization = (init?.headers as Record<string, string> | undefined)?.['Authorization'] || '';
      calls.push({ authorization });
      return new Response(JSON.stringify({ success: true, sid: 'SMtest' }), { status: 200 });
    }
    if (url.pathname.endsWith('/settings')) {
      return new Response(JSON.stringify([{ sms_footer: '', primary_manager_phone: '', secondary_manager_phone: '' }]), { status: 200 });
    }
    throw new Error(`stubEnvironment: unhandled request ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.test('falls back to Account SID + Auth Token when no API key is configured (staging)', async () => {
  const stub = stubEnvironment();
  try {
    await handleRequest(new Request('https://example.supabase.co/functions/v1/send-confirmation', {
      method: 'POST',
      body: JSON.stringify({ owner_name: 'Kim Miller', owner_phone: '4155550199', dog_name: 'Rex', message_template: 'Hi.' }),
    }));
    assertEquals(stub.calls[0].authorization, 'Basic ' + btoa('ACtest:test-auth-token'));
  } finally {
    stub.restore();
  }
});
