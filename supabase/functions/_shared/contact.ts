// Shared, pure text-building + security helpers for the inbound/outbound SMS
// functions (receive-sms, send-confirmation). Kept pure and framework-free so
// they can be unit-tested directly with `deno test`, without spinning up an
// HTTP server.

/** The note appended to every outbound message, telling clients replies to
 * this number aren't monitored and how to actually reach us. */
export function buildContactNote(kimPhone: string, esteePhone: string): string {
  return `Replies to this number aren't monitored. For questions, please group-text Kim ${kimPhone} & Estee ${esteePhone}.`;
}

/** Appends the contact note to an outbound message body, on its own line
 * (Sept 16, 2026 - was a single space, read as one run-on sentence). */
export function appendContactNote(message: string, kimPhone: string, esteePhone: string): string {
  return `${message}\n${buildContactNote(kimPhone, esteePhone)}`;
}

/** The auto-reply TwiML sends back to anyone who texts the business number
 * directly. */
export function buildAutoReply(kimPhone: string, esteePhone: string): string {
  return `Apologies, but direct replies to this number aren't supported. Please reach us by group-texting both Kim ${kimPhone} and Estee ${esteePhone}. — Bayview Boarding`;
}

/** The message relayed to Kim & Estee when a client replies directly instead
 * of using the group text, so nothing gets silently dropped. */
export function buildRelayWarning(fromNumber: string, body: string): string {
  return `⚠️ ${fromNumber} replied directly instead of using the group text: "${body}"`;
}

/**
 * Validates that an inbound webhook request genuinely came from Twilio.
 * Implements Twilio's documented request-validation algorithm:
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * @param authToken   Twilio auth token (the shared secret; never sent by Twilio itself)
 * @param url         the exact webhook URL Twilio was configured to call (including query string, if any)
 * @param params      all POST body parameters, as sent by Twilio
 * @param signature   the value of the X-Twilio-Signature request header
 */
export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  return computed === signature;
}

/** Escapes text for safe inclusion inside TwiML XML. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
