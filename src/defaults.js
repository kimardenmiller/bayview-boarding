import { SETTINGS } from './settings';

// Fallback defaults, used until the `settings` Edge Function's response
// loads (App's useEffect) and as calcCost's own parameter defaults for
// direct/pure-function callers (e.g. existing tests). The live,
// admin-configurable values come from Supabase - see the settings table
// migration and supabase/functions/settings/index.ts.
//
// Split into their own module (Sept 30, 2026, on request - code-
// splitting for mobile PageSpeed) since both App.js (for its own
// initial useState values) and the lazy-loaded AdminPanel.js (for its
// own "Reset to Default" buttons) need these same constants - keeping
// one shared source avoids either duplicating them or pulling the
// whole App.js module (defeating the point of splitting it) into
// AdminPanel's chunk just to read a few constants.
export const DEFAULT_RATE = SETTINGS.DEFAULT_DAY_RATE;
export const DEFAULT_MINIMUM_STAY = SETTINGS.DEFAULT_MINIMUM_STAY;
export const DEFAULT_MULTI_DOG_DISCOUNT = SETTINGS.MULTI_DOG_DISCOUNT;
export const DEFAULT_HOLIDAY_UPCHARGE = SETTINGS.HOLIDAY_UPCHARGE;
// The editable vet clinic list, without the structural placeholder/"Other"
// entries the app always adds itself (see vetDropdownOptions in calc.js).
export const DEFAULT_VETS = SETTINGS.SAN_RAFAEL_VETS.slice(1, -1);
export const DEFAULT_PACKING_LIST = SETTINGS.PACKING_LIST;
export const DEFAULT_SMS_TEMPLATES = {
  confirmation: SETTINGS.SMS_CONFIRMATION,
  reminder: SETTINGS.SMS_REMINDER,
  billing: SETTINGS.SMS_BILLING,
  pickupReminder: SETTINGS.SMS_PICKUP_REMINDER,
  requestReceived: SETTINGS.SMS_REQUEST_RECEIVED,
  denied: SETTINGS.SMS_DENIED,
  paid: SETTINGS.SMS_PAID,
};
export const DEFAULT_SMS_FOOTER = SETTINGS.SMS_FOOTER;

// "On List" = promoted into FIXES.txt's NEXT CHANGE LIST; "Rejected" =
// decided not to do it - both set manually by admin from this list, same
// as "Done" already was (Sept 18, 2026, on request; "On List" replaces
// the old "Considered"). Admin-only (Ideas & Bugs), lives here purely
// because it's a fallback-style constant like the others above.
export const FEEDBACK_STATUSES = [
  { key: 'open', label: 'Open' },
  { key: 'on_list', label: 'On List' },
  { key: 'done', label: 'Done' },
  { key: 'rejected', label: 'Rejected' },
];

// Suggested starting text for the admin "Testers" broadcast box (Sept 17,
// 2026), admin-editable and persisted since Sept 19, 2026 (see settings'
// default_broadcast_message column/migration and AdminPanel's
// saveBroadcastDefault) - this constant is now only the FALLBACK, used
// before the admin-authenticated settings fetch resolves at login, same
// role DEFAULT_SMS_TEMPLATES/DEFAULT_SMS_FOOTER already play above.
// Pointed at the staging sandbox from Sept 19, 2026 (once that
// environment existed for testers to freely book/add dogs/etc. in
// without touching real client data) until Oct 8, 2026, on request -
// staging was retired (never actually diverged from main in practice,
// and had accumulated real upkeep cost: no Twilio/Calendar credentials,
// a `db push` that reliably fails, columns that had silently gone
// missing from its bootstrap, and it kept auto-pausing from inactivity)
// - testers now point at the live site instead. The "feel free to try
// anything, none of it touches real client data" wording was
// deliberately LEFT AS-IS despite no longer being accurate (a conscious
// choice, not an oversight) - test bookings now land in the real
// database and can trigger real SMS sends. Distinct from "Hi {name}, "
// which the server prepends per-recipient using each tester's own name,
// not something typed here at all.
export const DEFAULT_BROADCAST_MESSAGE =
  "We've made a few changes to the Bayview Boarding site below. Please have a look and tell us what you think!\n" +
  'https://bayviewboarding.com\n' +
  'This is our testing sandbox - feel free to make bookings, add dogs, and try anything. None of it touches real client data.\n' +
  'Then just tap the (☰) menu and choose "Submit Idea" to share your feedback with us.';
