// Bayview Boarding — Settings
// Edit this file to update rates, messages, and lists without touching app code.

export const SETTINGS = {

  // ── Pricing ───────────────────────────────────────────────────────────────
  DEFAULT_DAY_RATE: 105,         // $ per 24 hours
  MIN_HOURS: 24,                 // minimum billable hours
  MULTI_DOG_DISCOUNT: 0.10,      // 10% off the per-night rate for each additional dog (uncapped)
  HOLIDAY_UPCHARGE: 0.30,        // +30% on any night inside a holiday window (see calcHolidayWindows)

  // ── Business Info ─────────────────────────────────────────────────────────
  BUSINESS_NAME: 'Bayview Boarding',
  OWNERS: 'Kim & Estee',
  ADDRESS: '210 Bayview Drive, San Rafael, CA 94901',
  PHONE: '(650) 252-2433',
  APP_URL: 'https://kimardenmiller.github.io/bayview-boarding',

  // ── Packing List ──────────────────────────────────────────────────────────
  // Fallback default only (Sept 16, 2026) - the real, admin-editable value
  // now lives in Supabase's `settings` table (packing_list column), same
  // pattern as day rate/vets. This is just what's shown before that fetch
  // resolves, or if it fails.
  PACKING_LIST: [
    'Food',
    'Leash & doggy bags',
    'Bed & favorite blanket',
    'Favorite treats',
    'Favorite toys',
    'Favorite food bowl (we provide a water bowl)',
    'Written special instructions including vet name, address, and phone',
  ],

  // ── SMS Message Templates ─────────────────────────────────────────────────
  // Fallback defaults only (Sept 16, 2026) - the real, admin-editable
  // values now live in Supabase's `settings` table (sms_confirmation/
  // sms_reminder/sms_billing columns). App.js fetches them and passes the
  // resolved template to send-confirmation as message_template; this file
  // is just what's used before that fetch resolves, or if it fails - no
  // more hand-syncing two copies.
  //
  // Variables: {firstName}, {dogName}, {dropDate}, {dropTime}, {pickDate},
  //            {pickTime}, {estimatedCost}, {packingList}, {kimPhone},
  //            {esteePhone}
  //
  // {kimPhone}/{esteePhone} are placeholders, not real numbers — the actual
  // values live only as the KIM_PHONE/ESTEE_PHONE Supabase secrets, read
  // server-side. This file ships in the public client JS bundle, so real
  // personal phone numbers must never be filled in here directly.

  SMS_CONFIRMATION: `Hi {firstName}! {dogName}'s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${'{estimatedCost}'}. — Kim & Estee Replies to this number aren't monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.`,

  SMS_REMINDER: `Hi {firstName}! Just a reminder that {dogName}'s stay at Bayview Boarding starts tomorrow at {dropTime}. Here's what to bring: {packingList}. See you then! Reply STOP to opt out. — Kim & Estee Replies to this number aren't monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.`,

  SMS_BILLING: `Hi {firstName}! {dogName} is ready for pickup. Your total for this stay is ${'{finalCost}'}. Thanks for choosing Bayview Boarding! Reply STOP to opt out. — Kim & Estee Replies to this number aren't monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.`,

  // ── Vet Dropdown ──────────────────────────────────────────────────────────
  SAN_RAFAEL_VETS: [
    'Select a Vet',
    'Marin Pet Hospital — (415) 479-8387',
    'VCA Marin Animal Hospital — (415) 454-5225',
    'Bel Marin Animal Hospital — (415) 883-1700',
    'Lucas Valley Animal Hospital — (415) 472-4552',
    'Northgate Animal Hospital — (415) 472-1000',
    'San Rafael Animal Hospital — (415) 456-1411',
    'Canal Animal Hospital — (415) 455-9855',
    'Marin Humane Veterinary Services — (415) 506-6225',
    'Other — see notes',
  ],
};
