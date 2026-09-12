// Bayview Boarding — Settings
// Edit this file to update rates, messages, and lists without touching app code.

export const SETTINGS = {

  // ── Pricing ───────────────────────────────────────────────────────────────
  DEFAULT_DAY_RATE: 105,         // $ per 24 hours
  MIN_HOURS: 24,                 // minimum billable hours

  // ── Business Info ─────────────────────────────────────────────────────────
  BUSINESS_NAME: 'Bayview Boarding',
  OWNERS: 'Kim & Estee',
  ADDRESS: '210 Bayview Drive, San Rafael, CA 94901',
  PHONE: '(650) 252-2433',
  APP_URL: 'https://kimardenmiller.github.io/bayview-boarding',

  // ── Packing List ──────────────────────────────────────────────────────────
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
  // Variables: {firstName}, {dogName}, {dropDate}, {dropTime}, {pickDate},
  //            {pickTime}, {estimatedCost}, {packingList}

  SMS_CONFIRMATION: `Hi {firstName}! {dogName}'s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${'{estimatedCost}'}. Questions? Reply to this text. — Kim & Estee`,

  SMS_REMINDER: `Hi {firstName}! Just a reminder that {dogName}'s stay at Bayview Boarding starts tomorrow at {dropTime}. Here's what to bring: {packingList}. See you then! Reply STOP to opt out. — Kim & Estee`,

  SMS_BILLING: `Hi {firstName}! {dogName} is ready for pickup. Your total for this stay is ${'{finalCost}'}. Thanks for choosing Bayview Boarding! Reply STOP to opt out. — Kim & Estee`,

  // ── Vet Dropdown ──────────────────────────────────────────────────────────
  SAN_RAFAEL_VETS: [
    'Select a veterinarian',
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
