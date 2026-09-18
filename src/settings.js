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
  // sms_reminder/sms_billing/sms_pickup_reminder/sms_footer columns).
  // App.js fetches them and passes the resolved template to
  // send-confirmation as message_template; this file is just what's used
  // before that fetch resolves, or if it fails - no more hand-syncing two
  // copies.
  //
  // Variables: {firstName}, {dogName}, {dogVerb} ("is"/"are", agreeing with
  //            {dogName} - a shared multi-dog stay's dogName is "Don & Bob"),
  //            {dropDate}, {dropTime}, {pickDate}, {pickTime},
  //            {estimatedCost}, {finalCost} (both already formatted as
  //            whole dollars with commas - a bare $ prefix is baked into
  //            the template text itself, not part of the placeholder),
  //            {billingBreakdown} (the full line-item math behind
  //            {finalCost}, already formatted as its own multi-line block
  //            - see formatCostBreakdownText in App.js), {packingList}
  //            (already formatted as one "• item" bullet per line),
  //            {primaryManagerPhone}, {secondaryManagerPhone} (renamed
  //            from {kimPhone}/{esteePhone} Sept 18, 2026)
  //
  // None of the 4 templates below end with "Reply STOP to opt out..."
  // any more (Sept 18, 2026) - that's now SMS_FOOTER, a single shared
  // block send-confirmation appends once to every outbound message
  // itself, so it can't drift out of sync across 4 separate copies the
  // way it already had once. {primaryManagerPhone}/{secondaryManagerPhone}
  // are placeholders, not real numbers — the actual values live in the
  // `settings` table's primary_manager_phone/secondary_manager_phone
  // columns, admin-only readable (see settings/index.ts) - never in this
  // file, which ships in the public client JS bundle.

  SMS_CONFIRMATION: `Hi {firstName}! {dogName}'s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${'{estimatedCost}'}. — Kim & Estee`,

  SMS_REMINDER: `Hi {firstName}! Just a reminder that {dogName}'s stay at Bayview Boarding starts tomorrow at {dropTime}. Here's what to bring:\n{packingList}\nSee you then! — Kim & Estee`,

  SMS_BILLING: `Hi {firstName}! Thank you for visiting Bayview Boarding with {dogName}. Here's your billing detail:\n{billingBreakdown}\nTotal: ${'{finalCost}'}\n\nThanks for choosing Bayview Boarding! — Kim & Estee`,

  SMS_PICKUP_REMINDER: `It's been wonderful having {dogName}! We have you down for pick up at {pickupDate} {pickupTime}. Please let us know in our shared group text thread if anything has changed. Otherwise, we'll see you tomorrow at {pickupTime}. — Kim & Estee`,

  // Appended once, server-side, to the end of every outbound client SMS
  // (Sept 18, 2026 - "Text Message Footer") - not stored per-template.
  SMS_FOOTER: `Reply STOP to opt out. Replies to this number aren't monitored. For questions, please group-text Kim {primaryManagerPhone} & Estee {secondaryManagerPhone}.`,

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
