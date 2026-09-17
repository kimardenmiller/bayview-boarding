import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import {
  buildContactNote,
  appendContactNote,
  buildAutoReply,
  buildRelayWarning,
  buildOwnerCopyNotice,
  validateTwilioSignature,
  escapeXml,
} from './contact.ts';

const KIM = '(650) 302-0731';
const ESTEE = '(510) 432-9791';

Deno.test('buildContactNote includes both phone numbers and the "not monitored" warning', () => {
  const note = buildContactNote(KIM, ESTEE);
  assertEquals(note.includes(KIM), true);
  assertEquals(note.includes(ESTEE), true);
  assertEquals(note.includes("aren't monitored"), true);
});

Deno.test('appendContactNote appends the note after the original message, on its own line', () => {
  const result = appendContactNote('Hi Jane! Your stay is confirmed.', KIM, ESTEE);
  assertEquals(result.startsWith('Hi Jane! Your stay is confirmed.\n'), true);
  assertEquals(result.includes(KIM), true);
  assertEquals(result.includes(ESTEE), true);
});

Deno.test('buildAutoReply includes both numbers and an apology', () => {
  const reply = buildAutoReply(KIM, ESTEE);
  assertEquals(reply.includes(KIM), true);
  assertEquals(reply.includes(ESTEE), true);
  assertEquals(reply.toLowerCase().includes('apolog'), true);
});

Deno.test('buildRelayWarning includes the sender, the message, and a warning marker', () => {
  const warning = buildRelayWarning('+14155551234', 'Can I drop off early?');
  assertEquals(warning.includes('+14155551234'), true);
  assertEquals(warning.includes('Can I drop off early?'), true);
  assertEquals(warning.includes('⚠️'), true);
});

Deno.test('buildOwnerCopyNotice includes the owner name, phone, and the full original message', () => {
  const notice = buildOwnerCopyNotice('Jane Smith', '4155550199', 'Hi Jane! Your stay is confirmed.');
  assertEquals(notice.includes('Jane Smith'), true);
  assertEquals(notice.includes('4155550199'), true);
  assertEquals(notice.includes('Hi Jane! Your stay is confirmed.'), true);
});

Deno.test('escapeXml escapes all five reserved XML characters', () => {
  assertEquals(escapeXml(`< > & " '`), '&lt; &gt; &amp; &quot; &apos;');
});

Deno.test('escapeXml leaves plain text untouched', () => {
  assertEquals(escapeXml('Can I drop off 30 min early?'), 'Can I drop off 30 min early?');
});

// ── Twilio signature validation ─────────────────────────────────────────────
// Test vector published directly in Twilio's own docs:
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
const TWILIO_DOC_AUTH_TOKEN = '12345';
const TWILIO_DOC_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const TWILIO_DOC_PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675309',
  Digits: '1234',
  From: '+14158675309',
  To: '+18005551212',
};
const TWILIO_DOC_SIGNATURE = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

Deno.test('validateTwilioSignature accepts Twilio\'s own published example (known-correct)', async () => {
  const valid = await validateTwilioSignature(
    TWILIO_DOC_AUTH_TOKEN,
    TWILIO_DOC_URL,
    TWILIO_DOC_PARAMS,
    TWILIO_DOC_SIGNATURE,
  );
  assertEquals(valid, true);
});

Deno.test('validateTwilioSignature rejects a tampered parameter', async () => {
  const tampered = { ...TWILIO_DOC_PARAMS, Digits: '9999' };
  const valid = await validateTwilioSignature(
    TWILIO_DOC_AUTH_TOKEN,
    TWILIO_DOC_URL,
    tampered,
    TWILIO_DOC_SIGNATURE,
  );
  assertEquals(valid, false);
});

Deno.test('validateTwilioSignature rejects a wrong auth token', async () => {
  const valid = await validateTwilioSignature(
    'wrong-token',
    TWILIO_DOC_URL,
    TWILIO_DOC_PARAMS,
    TWILIO_DOC_SIGNATURE,
  );
  assertEquals(valid, false);
});

Deno.test('validateTwilioSignature rejects an empty/missing signature', async () => {
  const valid = await validateTwilioSignature(TWILIO_DOC_AUTH_TOKEN, TWILIO_DOC_URL, TWILIO_DOC_PARAMS, '');
  assertEquals(valid, false);
});
