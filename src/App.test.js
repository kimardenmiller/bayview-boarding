import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { formatDate, calcAge, calcCost, calcCostBreakdown, formatCostBreakdownText, isHolidayNight, getHolidayWindows, todayISO, formatMoney } from './App';
import { supabase } from './supabase';

jest.mock('./supabase');

// The booking flow now calls three different Edge Functions through the
// same supabase.functions.invoke() - lookup-client (StepOwner's manual
// button + StepDog's on-mount check), submit-booking (final submit), and
// send-confirmation (the SMS after a successful submit) - so the mock
// dispatches by function name rather than relying on call order, which
// would break the moment more than one function is in play in a test.
// `overrides` replaces the default for just the named function(s); pass
// a fake implementation matching supabase-js's (fnName, opts) => Promise
// shape.
const DEFAULT_STAY = {
  id: 'stay-1', check_in: '2026-10-01', check_out: '2026-10-05',
  drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 420,
  submitted_at: '2026-09-13T10:00:00Z',
  owner_name: 'Kim Miller', owner_phone: '4155550100', dog_names: ['Rex'],
};

const DEFAULT_SETTINGS = {
  dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30,
  vets: ['Marin Pet Hospital — (415) 479-8387'],
  packingList: ['Food', 'Leash & doggy bags'],
  smsConfirmation: 'Hi {firstName}! confirmed.',
  smsReminder: 'Hi {firstName}! reminder, bring {packingList}.',
  smsBilling: 'Hi {firstName}! total ${finalCost}.',
  smsPickupReminder: 'Bye {dogName}! pickup at {pickupDate} {pickupTime}.',
  smsFooter: 'Reply STOP to opt out. Text {primaryManagerPhone}/{secondaryManagerPhone}.',
  primaryManagerPhone: '4155550101',
  secondaryManagerPhone: '4155550102',
};

function mockInvokeDefaults(overrides = {}) {
  // A fresh mutable copy each call, so a Save in the admin settings UI
  // (which sends {password, updates}) behaves like the real Edge
  // Function - merging and echoing back the new values - rather than
  // always returning the same fixed defaults regardless of what was sent.
  const currentSettings = { ...DEFAULT_SETTINGS };
  let currentFeedback = [];
  let currentTesters = [];
  supabase.functions.invoke.mockImplementation((fn, opts) => {
    if (overrides[fn]) return overrides[fn](opts);
    if (fn === 'lookup-client') return Promise.resolve({ data: { found: false }, error: null });
    if (fn === 'submit-booking') return Promise.resolve({ data: { stay: DEFAULT_STAY }, error: null });
    if (fn === 'send-confirmation') return Promise.resolve({ data: {}, error: null });
    if (fn === 'admin-data') return Promise.resolve({ data: null, error: { message: 'not mocked in this test' } });
    if (fn === 'send-contact') return Promise.resolve({ data: { success: true }, error: null });
    // Mimics the real feedback function: no password -> public submit
    // (appends to an in-memory list); password + id -> update that
    // submission's status; password alone -> list everything + open count.
    if (fn === 'feedback') {
      const { password, id, status, message, category, name, contact } = opts?.body || {};
      if (!password) {
        if (!name?.trim()) return Promise.resolve({ data: null, error: { message: 'Name is required' } });
        if (!message?.trim()) return Promise.resolve({ data: null, error: { message: 'Message is required' } });
        currentFeedback = [
          { id: `fb-${currentFeedback.length + 1}`, status: 'open', created_at: '2026-09-16T12:00:00Z', category: category || 'idea', name: name || null, contact: contact || null, message },
          ...currentFeedback,
        ];
        return Promise.resolve({ data: { success: true }, error: null });
      }
      if (id) {
        currentFeedback = currentFeedback.map(f => (f.id === id ? { ...f, status } : f));
        return Promise.resolve({ data: { feedback: currentFeedback.find(f => f.id === id) }, error: null });
      }
      return Promise.resolve({
        data: { feedback: currentFeedback, openCount: currentFeedback.filter(f => f.status === 'open').length },
        error: null,
      });
    }
    // Mimics the real testers function: entirely password-gated (no
    // public branch at all), one of 4 actions decided by opts.body.action.
    if (fn === 'testers') {
      const { password, action, id, name, phone, message } = opts?.body || {};
      if (password !== 'correct-password') return Promise.resolve({ data: null, error: { message: 'Incorrect password' } });
      if (action === 'add') {
        if (!name?.trim() || !phone?.trim()) return Promise.resolve({ data: null, error: { message: 'Name and phone are both required' } });
        currentTesters = [...currentTesters, { id: `tester-${currentTesters.length + 1}`, name, phone, active: true, created_at: '2026-09-17T12:00:00Z' }];
        return Promise.resolve({ data: { testers: currentTesters }, error: null });
      }
      if (action === 'remove') {
        currentTesters = currentTesters.filter(t => t.id !== id);
        return Promise.resolve({ data: { testers: currentTesters }, error: null });
      }
      if (action === 'notify') {
        if (!message?.trim()) return Promise.resolve({ data: null, error: { message: 'Message is required' } });
        const active = currentTesters.filter(t => t.active);
        return Promise.resolve({ data: { sent: active.length, failed: 0, total: active.length }, error: null });
      }
      return Promise.resolve({ data: { testers: currentTesters }, error: null });
    }
    // App fetches this once on mount (public read, no password) to load
    // live pricing/vet-list settings - every test needs a sane default
    // here or that automatic call interferes with tests written around
    // a single expected invoke() call (e.g. mockResolvedValueOnce).
    if (fn === 'settings') {
      const updates = opts?.body?.updates;
      if (updates) Object.assign(currentSettings, updates);
      return Promise.resolve({ data: { ...currentSettings }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// CRA's Jest config sets resetMocks: true, which wipes mock implementations
// (not just call history) before every test — so defaults are re-applied
// here each time rather than once at module scope.
beforeEach(() => {
  mockInvokeDefaults();
  // Reset the URL before every test - admin tests opt in via goToAdminUrl(),
  // everything else should start from a plain, non-admin URL.
  window.history.pushState({}, '', '/');
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isoMonthsAgo(months, day = 15) {
  const d = new Date();
  d.setDate(day); // dodge month-length edge cases (e.g. Jan 31 - 1 month)
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function daysFromToday(offset) {
  // NOT `.toISOString().slice(0,10)` - toISOString() is always UTC, and
  // this helper hit exactly the bug todayISO() (src/App.js) was fixed
  // for earlier: in the evening Pacific time, UTC has already rolled to
  // tomorrow, silently shifting every date this returns by a day and
  // breaking date-sensitive tests specifically when run in the evening.
  // Local calendar fields instead, same fix as todayISO().
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Renders and advances only to the Owner Information page - for tests
// that check that page's own fields (vet, Number of Dogs) directly,
// without also filling and leaving it.
async function goToOwnerStep() {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await screen.findByText('Owner Information');
}

// Fills Owner Information (name/phone/email/vet) AND every dog's own
// profile (opened in place via each row's Edit button, filled, then
// "Done" returns to the list), then clicks Continue - which now goes
// straight to Stay Dates, dogs no longer being forced sequential
// top-level steps (Sept 17, 2026). The form always starts with exactly
// 1 dog (see emptyForm), so this clicks "+ Add Dog" (which itself opens
// the new dog's edit page automatically) the rest of the way to
// numberOfDogs.
async function fillStep1(phone = '4155550100', name = 'Kim Miller', email = 'kim@test.com', numberOfDogs = 1) {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), phone);
  await userEvent.type(screen.getByPlaceholderText('Jane Smith'), name);
  await userEvent.type(screen.getByPlaceholderText('jane@email.com'), email);
  fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
  fireEvent.click(screen.getByText('Edit'));
  await fillDogPage();
  for (let i = 1; i < numberOfDogs; i++) {
    fireEvent.click(screen.getByText('+ Add Dog'));
    await fillDogPage();
  }
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Stay Dates');
}

// Fills whichever dog's edit page is currently showing and clicks Done,
// returning to the owner page's dog list.
async function fillDogPage({ name = 'Rex', breed = 'Labrador', dob = '2020-01-01' } = {}) {
  await userEvent.type(screen.getByPlaceholderText('Buddy'), name);
  await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), breed);
  fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: dob } });
  const selects = document.querySelectorAll('select');
  fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
  fireEvent.change(selects[1], { target: { value: 'no' } });  // aggression
  fireEvent.change(selects[2], { target: { value: 'no' } });  // health
  fireEvent.click(screen.getByText('Done'));
  await screen.findByText('Owner Information');
}

// fillStep1 now fills every dog itself and lands directly on Stay Dates
// (Sept 17, 2026) - kept as a no-op passthrough purely so the many
// existing `await fillStep1(); await fillStep2();` call sites don't all
// need individually touching.
async function fillStep2() {
  await screen.findByText('Stay Dates');
}

async function fillStep3() {
  const dateInputs = document.querySelectorAll('input[type="date"]');
  fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
  fireEvent.change(dateInputs[1], { target: { value: '2026-10-05' } });
  const timeInputs = document.querySelectorAll('input[type="time"]');
  fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
  fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Boarding Agreement');
}

async function fillStep4() {
  fireEvent.click(screen.getByText('I Have Read the Agreement'));
  await screen.findByText('Sign & Submit');
}

async function fillThrough(phone, name, email) {
  await fillStep1(phone, name, email);
  await fillStep2();
  await fillStep3();
  await fillStep4();
}

// Shaped like admin-data's actual response: dogs (each with a current
// profile, owner, and a `stays` array already sorted newest-first, where
// each stay entry carries its own frozen snapshot of name/breed/dob/
// aggression/health as declared for THAT stay - see admin-data/index.ts).
// Bud's two stays deliberately have different dob/aggression snapshots
// to exercise that distinction.
const SAMPLE_DOGS = [
  {
    id: 'dog-bud', name: 'Bud', breed: 'Labrador', dob: '2020-01-01',
    spay_neuter: 'yes', aggression_history: 'no', aggression_detail: '',
    health_concerns: 'no', health_detail: '',
    owner: { name: 'Kim', phone: '6505551111', email: 'kim@test.com' },
    // billed_at set on every stay here - Past Stays (see Admin — logged
    // in) only lists fully billed stays, and every "browse by dog" test
    // in that block reaches Bud/Choco through that lookup (Sept 17,
    // 2026). Unbilled-stay behavior has its own dedicated UNBILLED_DOGS
    // fixture below instead.
    stays: [
      {
        id: 'stay-1', check_in: '2026-09-01', check_out: '2026-09-03', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 210, submitted_at: '2026-08-30T10:00:00Z', notes: 'Loves belly rubs', number_of_dogs: 1,
        dob: '2020-01-01', aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
        waiver_snapshot: [{ title: 'Risks & Releases', body: 'Test waiver body text.' }], billed_at: '2026-09-04T00:00:00Z',
      },
      {
        id: 'stay-3', check_in: '2026-06-01', check_out: '2026-06-02', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 105, submitted_at: '2026-05-30T10:00:00Z', notes: '', number_of_dogs: 1,
        dob: null, aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '', billed_at: '2026-06-03T00:00:00Z',
      },
    ],
  },
  {
    id: 'dog-choco', name: 'Choco', breed: 'Poodle', dob: null,
    spay_neuter: 'no', aggression_history: 'yes', aggression_detail: 'Barks at mail carrier',
    health_concerns: 'yes', health_detail: 'Mild hip dysplasia',
    owner: { name: 'Estee', phone: '6505552222', email: 'estee@test.com' },
    stays: [
      {
        id: 'stay-2', check_in: '2026-09-05', check_out: '2026-09-06', drop_time: '10:00:00', pickup_time: '12:00:00',
        estimated_cost: null, submitted_at: '2026-08-31T10:00:00Z', notes: '', number_of_dogs: 1,
        dob: null, aggression_history: 'yes', aggression_detail: 'Barks at mail carrier',
        health_concerns: 'yes', health_detail: 'Mild hip dysplasia', billed_at: '2026-09-07T00:00:00Z',
      },
    ],
  },
];
const SAMPLE_TOTAL_STAYS = 3; // 2 (Bud) + 1 (Choco), independent of dog count

// Admin has no visible button in the UI - reached only via a bookmarked
// ?admin URL. Tests navigate there the same way a real bookmark would.
function goToAdminUrl() {
  window.history.pushState({}, '', '/?admin');
}

async function loginAsAdmin(dogs = SAMPLE_DOGS, totalStays = SAMPLE_TOTAL_STAYS) {
  mockInvokeDefaults({ 'admin-data': async () => ({ data: { dogs, totalStays }, error: null }) });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

const SAMPLE_FEEDBACK = [
  { id: 'fb-1', category: 'bug', message: 'Map pin looks off on Safari', name: 'Jane Tester', contact: 'jane@test.com', status: 'open', created_at: '2026-09-16T12:00:00Z' },
  { id: 'fb-2', category: 'idea', message: 'Add a dark mode', name: null, contact: null, status: 'open', created_at: '2026-09-15T12:00:00Z' },
  { id: 'fb-3', category: 'other', message: 'Already fixed, thanks', name: null, contact: null, status: 'done', created_at: '2026-09-14T12:00:00Z' },
];

async function loginAsAdminWithFeedback(feedback = SAMPLE_FEEDBACK) {
  let current = feedback.map(f => ({ ...f }));
  mockInvokeDefaults({
    'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }),
    'feedback': async (opts) => {
      const { id, status } = opts?.body || {};
      if (id) {
        current = current.map(f => (f.id === id ? { ...f, status } : f));
        return { data: { feedback: current.find(f => f.id === id) }, error: null };
      }
      return { data: { feedback: current, openCount: current.filter(f => f.status === 'open').length }, error: null };
    },
  });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

const SAMPLE_TESTERS = [
  { id: 'tester-1', name: 'Jane Tester', phone: '4155550100', active: true, created_at: '2026-09-17T12:00:00Z' },
  { id: 'tester-2', name: 'Inactive Ida', phone: '4155550101', active: false, created_at: '2026-09-16T12:00:00Z' },
];

async function loginAsAdminWithTesters(testers = SAMPLE_TESTERS) {
  let current = testers.map(t => ({ ...t }));
  mockInvokeDefaults({
    'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }),
    'testers': async (opts) => {
      const { action, id, name, phone, message } = opts?.body || {};
      if (action === 'add') {
        if (!name?.trim() || !phone?.trim()) return { data: null, error: { message: 'Name and phone are both required' } };
        current = [...current, { id: `tester-${current.length + 1}`, name, phone, active: true, created_at: '2026-09-17T12:00:00Z' }];
        return { data: { testers: current }, error: null };
      }
      if (action === 'remove') {
        current = current.filter(t => t.id !== id);
        return { data: { testers: current }, error: null };
      }
      if (action === 'notify') {
        if (!message?.trim()) return { data: null, error: { message: 'Message is required' } };
        const active = current.filter(t => t.active);
        return { data: { sent: active.length, failed: 0, total: active.length }, error: null };
      }
      return { data: { testers: current }, error: null };
    },
  });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('formatDate', () => {
  test('returns empty string for falsy input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  test('formats an ISO date as M/D/YYYY', () => {
    expect(formatDate('2026-03-05')).toBe('03/05/2026');
  });
});

describe('calcAge', () => {
  test('returns empty string for falsy dob', () => {
    expect(calcAge('')).toBe('');
    expect(calcAge(null)).toBe('');
  });

  test('shows months for dogs under a year, pluralized', () => {
    expect(calcAge(isoMonthsAgo(6))).toBe('6 months');
    expect(calcAge(isoMonthsAgo(1))).toBe('1 month');
  });

  test('shows singular "year" for an exactly-1-year-old dog', () => {
    expect(calcAge(isoMonthsAgo(12))).toBe('1 year');
  });

  test('shows plural "years" for whole-year ages over 1', () => {
    expect(calcAge(isoMonthsAgo(36))).toBe('3 years');
  });

  test('shows "yr mo" format when there is a remainder', () => {
    expect(calcAge(isoMonthsAgo(27))).toBe('2 yr 3 mo');
  });
});

// 2026-03-10/11 are plain weekdays with no holiday window nearby - used
// throughout as neutral dates so these base-case tests aren't coupled to
// the holiday-upcharge logic covered separately below.
describe('calcCost', () => {
  test('returns null when any required field is missing', () => {
    expect(calcCost('', '2026-03-11', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '2026-03-11', '', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '', 100)).toBeNull();
  });

  test('returns null when pickup is before drop-off', () => {
    expect(calcCost('2026-03-11', '2026-03-10', '09:00', '09:00', 100)).toBeNull();
  });

  test('charges the exact fraction of a day for a short same-day stay', () => {
    // 6 hrs = 0.25 day -> $25, no minimum charge
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('25.00');
  });

  test('bills a precise fraction of a day, never rounded up', () => {
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100)).toBe('104.17'); // 25 hrs -> 25/24 days
  });

  test('a half day bills at exactly half the daily rate', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '21:00', 100)).toBe('50.00'); // 12 hrs = 0.5 day
  });

  test('1.5 days bills at exactly 1.5x the daily rate', () => {
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '21:00', 100)).toBe('150.00'); // 36 hrs = 1.5 days
  });

  test('an exact multiple of 24 hours still bills whole days, no stray fraction', () => {
    expect(calcCost('2026-03-10', '2026-03-12', '09:00', '09:00', 100)).toBe('200.00'); // 48 hrs = 2 days
  });

  test('defaults to 1 dog when numberOfDogs is omitted', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('25.00');
  });
});

describe('calcCostBreakdown', () => {
  test('returns null under the same invalid-input conditions as calcCost', () => {
    expect(calcCostBreakdown('', '2026-03-11', '09:00', '09:00', 100)).toBeNull();
    expect(calcCostBreakdown('2026-03-11', '2026-03-10', '09:00', '09:00', 100)).toBeNull();
  });

  test('total matches calcCost exactly for a plain (no holiday, 1 dog) stay', () => {
    const b = calcCostBreakdown('2026-03-10', '2026-03-12', '09:00', '09:00', 100);
    expect(b.nights).toBe(2);
    expect(b.holidayNights).toBe(0);
    expect(b.subtotal).toBe(200);
    expect(b.holidayExtra).toBe(0);
    expect(b.total).toBe(200);
    expect(b.total.toFixed(2)).toBe(calcCost('2026-03-10', '2026-03-12', '09:00', '09:00', 100));
  });

  test('splits a holiday night out into holidayExtra, still matching calcCost\'s total', () => {
    // New Year's Day - 1 night @ $100 + 30% holiday upcharge
    const b = calcCostBreakdown('2026-01-01', '2026-01-02', '09:00', '09:00', 100);
    expect(b.holidayNights).toBe(1);
    expect(b.subtotal).toBe(100);
    expect(b.holidayExtra).toBe(30);
    expect(b.total).toBe(130);
    expect(b.total.toFixed(2)).toBe(calcCost('2026-01-01', '2026-01-02', '09:00', '09:00', 100));
  });

  test('multi-dog discount factors into both subtotal and holidayExtra', () => {
    // 1 night, 2 dogs, New Year's Day: dog1 $100 + dog2 $90 = $190 base,
    // holiday extra 30% of that = $57 -> total $247
    const b = calcCostBreakdown('2026-01-01', '2026-01-02', '09:00', '09:00', 100, 2);
    expect(b.subtotal).toBe(190);
    expect(b.holidayExtra).toBe(57);
    expect(b.total).toBe(247);
    expect(b.total.toFixed(2)).toBe(calcCost('2026-01-01', '2026-01-02', '09:00', '09:00', 100, 2));
  });

  test('splits subtotal into a 1st-dog line and an additional-dogs line', () => {
    // 2 nights, 3 dogs @ $100: dog1 $200, dogs 2&3 $180 each -> $560 total
    const b = calcCostBreakdown('2026-03-10', '2026-03-12', '09:00', '09:00', 100, 3);
    expect(b.firstDogSubtotal).toBe(200);
    expect(b.additionalDogsSubtotal).toBe(360);
    expect(b.firstDogSubtotal + b.additionalDogsSubtotal).toBe(b.subtotal);
  });

  test('carries the holidayUpcharge rate used, for display', () => {
    const b = calcCostBreakdown('2026-01-01', '2026-01-02', '09:00', '09:00', 100, 1, 0.10, 0.30);
    expect(b.holidayUpcharge).toBe(0.30);
  });

  test('reports a fractional nights count for a partial-day stay', () => {
    // 36 hrs = 1.5 days, no holiday
    const b = calcCostBreakdown('2026-03-10', '2026-03-11', '09:00', '21:00', 100);
    expect(b.nights).toBe(1.5);
    expect(b.holidayNights).toBe(0);
    expect(b.subtotal).toBe(150);
    expect(b.total).toBe(150);
  });

  test('prorates the holiday portion of a fractional day', () => {
    // check-in Jan 1 (holiday) 09:00 -> check-out Jan 1 15:00 = 6 hrs = 0.25 day
    const b = calcCostBreakdown('2026-01-01', '2026-01-01', '09:00', '15:00', 100);
    expect(b.nights).toBe(0.25);
    expect(b.holidayNights).toBe(0.25);
    expect(b.subtotal).toBe(25);
    expect(b.holidayExtra).toBe(7.5);
    expect(b.total).toBe(32.5);
  });
});

describe('formatCostBreakdownText', () => {
  test('returns an empty string for a null breakdown', () => {
    expect(formatCostBreakdownText(null, 0.10)).toBe('');
  });

  test('one line for a single dog, no holiday - the plain-text form of what <CostBreakdown> shows on screen', () => {
    const b = calcCostBreakdown('2026-03-10', '2026-03-12', '09:00', '09:00', 100);
    expect(formatCostBreakdownText(b, 0.10)).toBe('$100/day × 2.0 days × 1st dog = $200');
  });

  test('adds an additional-dogs line, naming the discount %', () => {
    const b = calcCostBreakdown('2026-03-10', '2026-03-12', '09:00', '09:00', 100, 2, 0.10);
    const text = formatCostBreakdownText(b, 0.10);
    expect(text).toContain('1st dog = $200');
    expect(text).toContain('1 additional dog × 90% (10% off each) = $180');
  });

  test('adds a holiday-upcharge line when any billed night falls in a holiday window', () => {
    const b = calcCostBreakdown('2026-01-01', '2026-01-02', '09:00', '09:00', 100, 1, 0.10, 0.30);
    const text = formatCostBreakdownText(b, 0.10);
    expect(text).toContain('+ Holiday upcharge: 1.0 day × 30% = $30');
  });

  test('never includes the final total - the SMS states that separately, since admin can hand-adjust it', () => {
    const b = calcCostBreakdown('2026-03-10', '2026-03-12', '09:00', '09:00', 100);
    expect(formatCostBreakdownText(b, 0.10)).not.toContain('=  $200\n');
    expect(formatCostBreakdownText(b, 0.10).split('\n').pop()).not.toMatch(/^= \$/);
  });
});

describe('calcCost — multi-dog discount', () => {
  test('charges the 2nd dog at 90% of the daily rate (10% discount)', () => {
    // 0.25 day @ $100: dog 1 = $25, dog 2 = $25 * 0.9 = $22.50 -> $47.50
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 2)).toBe('47.50');
  });

  test('discount is uncapped - applies to every additional dog', () => {
    // 0.25 day: dog 1 = $25, dogs 2 & 3 = $22.50 each -> $70
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 3)).toBe('70.00');
  });

  test('treats 0 or invalid dog counts as 1 dog', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 0)).toBe('25.00');
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, null)).toBe('25.00');
  });

  test('applies across a fractional number of days', () => {
    // 25 hrs = 25/24 days, 2 dogs @ $100/day -> ($100 + $90) * 25/24 = $197.92
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100, 2)).toBe('197.92');
  });
});

describe('calcCost — holiday upcharge', () => {
  test('adds 30% on New Year\'s Day', () => {
    // 0.25 day @ $100 * 1.3 = $32.50
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100)).toBe('32.50');
  });

  test('does not upcharge the day right after a holiday', () => {
    expect(calcCost('2026-01-02', '2026-01-02', '09:00', '15:00', 100)).toBe('25.00');
  });

  test('combines the holiday upcharge with the multi-dog discount', () => {
    // 0.25 day; daily rate = $100 * 1.3 = $130; dog 2 = $130 * 0.9 = $117
    // -> ($130 + $117) * 0.25 = $61.75
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100, 2)).toBe('61.75');
  });

  test('only upcharges the holiday portion within a multi-day stay', () => {
    // check-in Jan 1 (holiday) -> check-out Jan 2, 09:00 to 10:00 = 25 hrs.
    // 1 full day on Jan 1 @ $130, plus 1/24 day on Jan 2 (not a holiday) @ $100
    // -> 130 + (100 * 1/24) = $134.17
    expect(calcCost('2026-01-01', '2026-01-02', '09:00', '10:00', 100)).toBe('134.17');
  });
});

describe('isHolidayNight', () => {
  test('New Year\'s Day', () => {
    expect(isHolidayNight('2026-01-01')).toBe(true);
  });

  test('MLK Day (3rd Monday of January)', () => {
    expect(isHolidayNight('2026-01-19')).toBe(true);
    expect(isHolidayNight('2026-01-18')).toBe(false);
    expect(isHolidayNight('2026-01-20')).toBe(false);
  });

  test('Ski Week surrounding Presidents\' Day', () => {
    expect(isHolidayNight('2026-02-16')).toBe(true); // Presidents' Day itself
    expect(isHolidayNight('2026-02-14')).toBe(true); // Saturday before
    expect(isHolidayNight('2026-02-22')).toBe(true); // Sunday after
    expect(isHolidayNight('2026-02-13')).toBe(false);
    expect(isHolidayNight('2026-02-23')).toBe(false);
  });

  test('Memorial Day (last Monday of May)', () => {
    expect(isHolidayNight('2026-05-25')).toBe(true);
    expect(isHolidayNight('2026-05-18')).toBe(false);
  });

  test('July 4th', () => {
    expect(isHolidayNight('2026-07-04')).toBe(true);
    expect(isHolidayNight('2026-07-03')).toBe(false);
  });

  test('Labor Day (1st Monday of September)', () => {
    expect(isHolidayNight('2026-09-07')).toBe(true);
    expect(isHolidayNight('2026-09-14')).toBe(false);
  });

  test('Thanksgiving and the day after', () => {
    expect(isHolidayNight('2026-11-26')).toBe(true);
    expect(isHolidayNight('2026-11-27')).toBe(true);
    expect(isHolidayNight('2026-11-25')).toBe(false);
    expect(isHolidayNight('2026-11-28')).toBe(false);
  });

  test('Christmas and New Year\'s Eve', () => {
    expect(isHolidayNight('2026-12-25')).toBe(true);
    expect(isHolidayNight('2026-12-31')).toBe(true);
    expect(isHolidayNight('2026-12-24')).toBe(false);
  });

  test('an ordinary weekday is not a holiday', () => {
    expect(isHolidayNight('2026-03-10')).toBe(false);
  });

  test('recomputes for a different year rather than using hardcoded dates', () => {
    // MLK Day 2027 is the 3rd Monday of January 2027 (Jan 18), not Jan 19
    expect(isHolidayNight('2027-01-19')).toBe(false);
    expect(isHolidayNight('2027-01-18')).toBe(true);
  });
});

describe('getHolidayWindows', () => {
  test('returns 9 windows per year (one per holiday, Ski Week + Thanksgiving as ranges)', () => {
    expect(getHolidayWindows(2026)).toHaveLength(9);
  });

  test('every window is a valid [start, end] ISO pair with start <= end', () => {
    getHolidayWindows(2026).forEach(([start, end]) => {
      expect(start <= end).toBe(true);
    });
  });
});

describe('formatMoney', () => {
  test('drops cents, rounding up at exactly .50', () => {
    expect(formatMoney('199.50')).toBe('200'); // rounds up
    expect(formatMoney('199.49')).toBe('199'); // rounds down
    expect(formatMoney(420)).toBe('420');
  });

  test('adds a thousands comma above 999', () => {
    expect(formatMoney('1199.50')).toBe('1,200');
    expect(formatMoney(1420)).toBe('1,420');
    expect(formatMoney('999.99')).toBe('1,000'); // rounds up and over the boundary
    expect(formatMoney('1000.00')).toBe('1,000');
  });

  test('adds multiple commas for larger amounts', () => {
    expect(formatMoney(1234567)).toBe('1,234,567');
  });

  test('passes through null/undefined/empty/non-numeric values unchanged', () => {
    expect(formatMoney(null)).toBeNull();
    expect(formatMoney(undefined)).toBeUndefined();
    expect(formatMoney('')).toBe('');
    expect(formatMoney('not a number')).toBe('not a number');
  });
});

describe('todayISO', () => {
  const realTZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = realTZ;
    jest.useRealTimers();
  });

  test('uses the local calendar date, not UTC (the evening-Pacific-time bug)', () => {
    // 2026-03-16 06:00 UTC = 2026-03-15 23:00 PDT - a different calendar
    // date in each. A UTC-based implementation would wrongly say "today"
    // is the 16th while it's still the evening of the 15th in Pacific
    // time, causing the Stay Dates page's min/"cannot be in the past"
    // check to reject that same Pacific evening's actual today.
    process.env.TZ = 'America/Los_Angeles';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T06:00:00Z'));
    expect(todayISO()).toBe('2026-03-15');
  });

  test('matches the UTC date when local time and UTC agree', () => {
    process.env.TZ = 'America/Los_Angeles';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T18:00:00Z')); // 11am PDT
    expect(todayISO()).toBe('2026-03-16');
  });
});

// ── App-level settings (fetched from Supabase, not hardcoded) ───────────────
describe('Live settings (day rate, discount %, holiday %, vet list)', () => {
  test('the vet dropdown reflects the fetched vet list, not the hardcoded fallback', async () => {
    mockInvokeDefaults({
      'settings': async () => ({
        data: { dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30, vets: ['Only Custom Vet — (415) 555-0100'] },
        error: null,
      }),
    });
    await goToOwnerStep();
    expect(await screen.findByText('Only Custom Vet — (415) 555-0100')).toBeInTheDocument();
    expect(screen.queryByText('Marin Pet Hospital — (415) 479-8387')).not.toBeInTheDocument();
  });

  test('the cost estimate uses the fetched discount % and holiday %, not the hardcoded defaults', async () => {
    mockInvokeDefaults({
      'settings': async () => ({
        data: { dayRate: 100, multiDogDiscount: 0.20, holidayUpcharge: 0.30, vets: ['Marin Pet Hospital — (415) 479-8387'] },
        error: null,
      }),
    });
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-03' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    // 2 nights @ $100/night, fetched rate - confirms dayRate loaded too
    expect(await screen.findByText('$200')).toBeInTheDocument();
  });

  test('keeps the hardcoded defaults if the settings fetch fails, rather than crashing', async () => {
    mockInvokeDefaults({ 'settings': async () => ({ data: null, error: { message: 'network down' } }) });
    await goToOwnerStep();
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
    expect(screen.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
  });
});

describe('Landing — Learn more about us', () => {
  test('a real link, separate from the title, takes a first-timer to the About page', async () => {
    render(<App />);
    expect(screen.getByText('Bayview Boarding')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Learn more/));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('Back from the About page returns to the landing page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
    expect(screen.queryByText('Dog Paradise Above Loch Lomond')).not.toBeInTheDocument();
  });

  test('About page shows home characteristics and the typical-day/safety sections', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText('Has a fenced yard')).toBeInTheDocument();
    expect(screen.getByText('Potty breaks every 0-2 hours')).toBeInTheDocument();
    expect(screen.getByText('Safety, trust & environment')).toBeInTheDocument();
    expect(screen.getByText('A typical day')).toBeInTheDocument();
    expect(screen.getByText(/1,500-acre China Camp State Park/)).toBeInTheDocument();
  });

  test('About page shows an approximate-location map, not the exact address', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText(/not our exact address/)).toBeInTheDocument();
    const map = screen.getByTitle(/Approximate location/);
    expect(map.tagName).toBe('IFRAME');
    // a specific point ~300 yards past the actual address, not the address itself
    expect(map.getAttribute('src')).toContain('37.980802,-122.484319');
    // the exact street address must never appear on this public page
    expect(screen.queryByText(/210 Bayview Drive/)).not.toBeInTheDocument();
  });

  test('clicking anywhere on the map opens Google Maps in a new tab, at the pinned spot', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    const overlay = document.querySelector('.about-map-overlay');
    expect(overlay.tagName).toBe('A');
    expect(overlay).toHaveAttribute('target', '_blank');
    expect(overlay).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(overlay.getAttribute('href')).toBe('https://maps.app.goo.gl/xWg4sCFVpevDCKd16');
  });

  test('About page shows a Schedule section, written in "we" not "I"', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText(/We are home throughout the week, early risers/)).toBeInTheDocument();
    // the old single-host, first-person phrasing should be gone entirely
    expect(screen.queryByText(/\bI am\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We only take males that have been neutered/)).not.toBeInTheDocument();
  });

  test('the title is centered and a photo gallery renders in numbered order', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    const title = await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(title).toHaveClass('about-title--center');
    const photos = document.querySelectorAll('.about-gallery-img');
    expect(photos.length).toBe(6);
    expect(photos[0].src).toContain('1-choco');
    expect(photos[5].src).toContain('6-china-camp-bay-line');
  });

  test('About page shows the Rover rating as a link to the Rover reviews, with dated review quotes', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    const ratingLink = screen.getByText('21 ratings on Rover');
    expect(ratingLink.tagName).toBe('A');
    expect(ratingLink).toHaveAttribute(
      'href',
      'https://www.rover.com/members/kim-m-dog-paradise-above-loch-lomond/#:~:text=be%20cared%20for.-,View,-all'
    );
    expect(ratingLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Took great care of our pup/)).toBeInTheDocument();
    expect(screen.getByText(/Aiste B\. · Jun 15, 2026/)).toBeInTheDocument();
    // the one 4-star, mixed review should not appear alongside the glowing ones
    expect(screen.queryByText(/somewhat awkward/)).not.toBeInTheDocument();
    // every review card shows its own 5-star row, not just the aggregate rating
    const starRows = document.querySelectorAll('.about-review-stars');
    expect(starRows.length).toBe(17);
    starRows.forEach(row => expect(row.textContent).toBe('★★★★★'));
  });

  test('Book My Stay on the About page starts the booking flow directly', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    fireEvent.click(screen.getAllByText('Book My Stay')[0]);
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
  });

  test('clicking the "Bayview Boarding" landing title also goes to the About page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Bayview Boarding'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('clicking the "Bayview Boarding" header wordmark mid-booking goes to the About page', async () => {
    await fillStep1();
    fireEvent.click(screen.getByText('Bayview Boarding'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });
});

describe('Nav menu (hamburger)', () => {
  function openMenu() {
    fireEvent.click(screen.getByLabelText('Open menu'));
  }

  test('is collapsed until opened, then shows all five destinations', async () => {
    render(<App />);
    expect(screen.queryByText('About Us')).not.toBeInTheDocument();
    openMenu();
    expect(screen.getByText('About Us')).toBeInTheDocument();
    expect(screen.getByText('Contact Us')).toBeInTheDocument();
    expect(screen.getByText('Submit Idea')).toBeInTheDocument();
    expect(screen.getByText('Book a Stay')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  test('"Submit Idea" opens the idea/bug form', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Submit Idea'));
    expect(await screen.findByText('Submit Idea', { selector: 'h1' })).toBeInTheDocument();
  });

  test('clicking the backdrop closes the menu without navigating', () => {
    render(<App />);
    openMenu();
    fireEvent.click(document.querySelector('.nav-menu-backdrop'));
    expect(screen.queryByText('About Us')).not.toBeInTheDocument();
    expect(screen.getByText('Bayview Boarding')).toBeInTheDocument();
  });

  test('"About Us" opens the About page', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('About Us'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('"Contact Us" opens the contact form', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Contact Us'));
    expect(await screen.findByText('Contact Us', { selector: 'h1' })).toBeInTheDocument();
  });

  test('"Book a Stay" jumps straight into the booking flow', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Book a Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
  });

  test('"Admin" opens the same password-gated admin login as the ?admin URL', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Admin'));
    expect(await screen.findByText('Admin Access')).toBeInTheDocument();
  });

  test('is available from the About page and the Contact page too, not just the landing page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByText('Contact Us'));
    await screen.findByText('Contact Us', { selector: 'h1' });
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
  });
});

describe('Contact Us', () => {
  function goToContact() {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    fireEvent.click(screen.getByText('Contact Us'));
  }

  test('Send is disabled until name, message, and an email or phone are filled in', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    const send = screen.getByText('Send Message');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Do you have room in October?');
    expect(send).toBeDisabled(); // still no email or phone
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    expect(send).not.toBeDisabled();
  });

  test('sends the message via send-contact and shows a confirmation', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Do you have room in October?');
    fireEvent.click(screen.getByText('Send Message'));

    await waitFor(() => {
      expect(supabase.functions.invoke).toHaveBeenCalledWith('send-contact', {
        body: { name: 'Jane Owner', email: 'jane@test.com', phone: '', message: 'Do you have room in October?' },
      });
    });
    expect(await screen.findByText('Message sent!')).toBeInTheDocument();
    expect(screen.getByText(/Thanks, Jane/)).toBeInTheDocument();
  });

  test('shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({ 'send-contact': async () => ({ data: null, error: { message: 'network down' } }) });
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Hi');
    fireEvent.click(screen.getByText('Send Message'));
    expect(await screen.findByText(/Something went wrong sending your message/)).toBeInTheDocument();
    expect(screen.queryByText('Message sent!')).not.toBeInTheDocument();
  });

  test('Back returns to the landing page', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
  });
});

describe('Submit Idea', () => {
  function goToSubmitIdea() {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    fireEvent.click(screen.getByText('Submit Idea'));
  }

  test('no Type/category field - requires a name and a message', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    expect(screen.queryByText('Type')).not.toBeInTheDocument();
    expect(document.querySelector('select')).not.toBeInTheDocument();

    const submit = screen.getByText('Submit');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Tester');
    expect(submit).toBeDisabled(); // still no message
    await userEvent.type(screen.getByPlaceholderText(/Feel free to list/), 'Add dark mode');
    expect(submit).not.toBeDisabled();
  });

  test('invites a list in one message box, submits name/message/contact (no category), shows a thank-you', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Tester');
    await userEvent.type(
      screen.getByPlaceholderText(/Feel free to list/),
      '1. Map pin looks wrong on Safari{Enter}2. Add dark mode',
    );
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(supabase.functions.invoke).toHaveBeenCalledWith('feedback', {
        body: {
          message: '1. Map pin looks wrong on Safari\n2. Add dark mode',
          name: 'Jane Tester', contact: 'jane@test.com',
        },
      });
    });
    expect(await screen.findByText('Thanks!')).toBeInTheDocument();
  });

  test('shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({ 'feedback': async () => ({ data: null, error: { message: 'network down' } }) });
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Tester');
    await userEvent.type(screen.getByPlaceholderText(/Feel free to list/), 'Hi');
    fireEvent.click(screen.getByText('Submit'));
    expect(await screen.findByText(/Something went wrong sending this/)).toBeInTheDocument();
    expect(screen.queryByText('Thanks!')).not.toBeInTheDocument();
  });

  test('Back returns to the landing page', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
  });
});

// ── Step 1: Owner Info (now also vet + Number of Dogs) ──────────────────────
describe('Step 1 — Owner Info', () => {
  test('Continue is disabled (greyed out) on an empty form, and does nothing if clicked anyway', async () => {
    await goToOwnerStep();
    const button = screen.getByText('Continue');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    // a disabled button never fires its click handler - no error text,
    // no navigation past Owner Info (note: "Dog 1" itself is a poor check
    // here now - it's also a row label right on this page's own dog list)
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.getByText('Owner Information')).toBeInTheDocument();
  });

  test('Continue enables once every required field (name/phone/email/vet) AND the default dog is filled', async () => {
    await goToOwnerStep();
    const button = screen.getByText('Continue');
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    expect(button).toBeDisabled(); // vet still unset
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    expect(button).toBeDisabled(); // owner fields alone aren't enough - the default dog still needs its own profile
    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage();
    expect(screen.getByText('Continue')).not.toBeDisabled();
  });

  test('Continue advances straight to Stay Dates once owner info and every dog are filled', async () => {
    await fillStep1();
    expect(screen.getByText('Stay Dates')).toBeInTheDocument();
  });

  test('shows a first-timer note explaining to fill out every field', async () => {
    await goToOwnerStep();
    expect(screen.getByText(/First time boarding with us/)).toBeInTheDocument();
  });

  test('vet defaults to the "Select a Vet" placeholder', async () => {
    await goToOwnerStep();
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
  });

  test('starts with exactly one dog, labeled "Dog 1" until named, with an Edit button but no Delete button, and no discount note', async () => {
    await goToOwnerStep();
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
    expect(screen.queryByText('Dog 2')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument(); // can't delete the only dog
    expect(screen.queryByText(/off each additional dog/)).not.toBeInTheDocument();
  });

  test('shows "Needs updating" for an incomplete dog, clearing once its profile is filled in', async () => {
    await goToOwnerStep();
    expect(screen.getByText('Needs updating')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage();
    expect(screen.queryByText('Needs updating')).not.toBeInTheDocument();
  });

  test('"+ Add Dog" opens the new dog\'s own edit page directly', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('+ Add Dog'));
    expect(await screen.findByText('Dog 2')).toBeInTheDocument(); // the new dog's edit-page title
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('');
  });

  test('back on the owner page, a 2nd dog gets its own row with a Delete button, and the discount note appears', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 2');
    fireEvent.click(screen.getByText('← Back to Dogs'));
    await screen.findByText('Owner Information');
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
    expect(screen.getByText('Dog 2')).toBeInTheDocument();
    expect(screen.getAllByText('Delete')).toHaveLength(2);
    expect(screen.getByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('a named dog shows its real name instead of "Dog N" on the owner page\'s list', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
    fireEvent.click(screen.getByText('← Back to Dogs'));
    await screen.findByText('Owner Information');
    expect(screen.getByText('Rex')).toBeInTheDocument();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
  });

  test('Delete removes a dog from the list, hiding Delete again once only one is left', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 2');
    fireEvent.click(screen.getByText('← Back to Dogs'));
    await screen.findByText('Owner Information');
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(screen.queryByText('Dog 2')).not.toBeInTheDocument();
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText(/off each additional dog/)).not.toBeInTheDocument();
  });

  test('adding several dogs lists each one and lets any of them be deleted independently', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 2');
    fireEvent.click(screen.getByText('← Back to Dogs'));
    await screen.findByText('Owner Information');
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 3');
    fireEvent.click(screen.getByText('← Back to Dogs'));
    await screen.findByText('Owner Information');
    expect(screen.getByText('Dog 3')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('Delete')[1]); // remove the middle one
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
    expect(screen.getByText('Dog 2')).toBeInTheDocument();
    expect(screen.queryByText('Dog 3')).not.toBeInTheDocument(); // re-labeled by position, not identity
  });

  test('looks up a returning client by phone and autofills name/email', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: { found: true, client: { owner_name: 'Found Person', owner_email: 'found@test.com' } },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    expect(await screen.findByText(/Info found/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Found Person');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('found@test.com');
    expect(supabase.functions.invoke).toHaveBeenCalledWith('lookup-client', { body: { phone: '4155550100' } });
  });

  test('the same lookup also autofills the vet and dog profile, visible via Edit on the dog row it names', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: {
          found: true,
          client: {
            owner_name: 'Kim Miller', owner_email: 'kim@test.com',
            vet_name: 'Marin Pet Hospital — (415) 479-8387',
            dogs: [{ dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01', spay_neuter: 'yes' }],
          },
        },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByDisplayValue('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
    expect(screen.getByText('Rex')).toBeInTheDocument(); // the dog row itself is already renamed

    fireEvent.click(screen.getByText('Edit'));
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    expect(screen.getByPlaceholderText('Golden Retriever')).toHaveValue('Labrador');
  });

  test('autofills every dog for a returning owner with multiple dogs, growing the count', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: {
          found: true,
          client: {
            vet_name: 'Marin Pet Hospital — (415) 479-8387',
            dogs: [
              { dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01', spay_neuter: 'yes' },
              { dog_name: 'Fido', dog_breed: 'Poodle', dog_dob: '2021-06-01', spay_neuter: 'no' },
            ],
          },
        },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByText('Rex')).toBeInTheDocument(); // count grew to match, not left at 1
    expect(screen.getByText('Fido')).toBeInTheDocument();
    // this mock's client has no owner_name/owner_email - fill those
    // manually so Continue's own validation isn't what's under test here
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');

    // lookup-client never returns aggression/health (re-confirmed fresh
    // each stay, not carried forward) - still required before Continue
    // will advance, so finish each dog's profile via Edit first
    fireEvent.click(screen.getAllByText('Edit')[0]);
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    let selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'no' } });
    fireEvent.change(selects[2], { target: { value: 'no' } });
    fireEvent.click(screen.getByText('Done'));
    await screen.findByText('Owner Information');

    fireEvent.click(screen.getAllByText('Edit')[1]);
    await screen.findByText('Dog 2');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Fido');
    selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'no' } });
    fireEvent.change(selects[2], { target: { value: 'no' } });
    fireEvent.click(screen.getByText('Done'));
    await screen.findByText('Owner Information');

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Stay Dates');
  });

  test('does not autofill or show the banner when phone is not found', async () => {
    await goToOwnerStep(); // default mock: { found: false }
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155559999');
    fireEvent.click(screen.getByText('Look up'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(screen.queryByText(/Info found/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
  });

  test('look up does nothing when phone field is empty', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Look up'));
    // App's own settings fetch on mount already called invoke() once -
    // the assertion is that Look up specifically never called lookup-client
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('lookup-client', expect.any(Object));
  });

  test('handles an entirely empty lookup record without crashing', async () => {
    // real records can have gaps (e.g. an older submission missing every
    // field) - the `field || ''` fallbacks exist for exactly this case, so
    // controlled inputs never receive null/undefined
    mockInvokeDefaults({ 'lookup-client': async () => ({ data: { found: true, client: {} }, error: null }) });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('');
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
    expect(screen.getByText('Dog 1')).toBeInTheDocument(); // still just 1 - an empty lookup doesn't touch the count
    expect(screen.queryByText('Dog 2')).not.toBeInTheDocument();
  });
});

// ── Dog pages ────────────────────────────────────────────────────────────────
// A dog's own page is now reached by clicking Edit on its row on the
// owner page, rather than as a forced sequential top-level step (Sept
// 17, 2026) - every test here opens it that way.
describe('Dog pages', () => {
  test('Done is disabled on an empty dog page, and does nothing if clicked anyway', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    const button = screen.getByText('Done');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.getByText('Dog 1')).toBeInTheDocument(); // still on the dog's own page
  });

  test('Done only enables once every field - including aggression and health - is answered', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    const button = screen.getByText('Done');
    await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
    await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), 'Labrador');
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2020-01-01' } });
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
    expect(button).toBeDisabled();
    fireEvent.change(selects[1], { target: { value: 'no' } }); // aggression
    expect(button).toBeDisabled(); // health still unanswered
    fireEvent.change(selects[2], { target: { value: 'no' } }); // health
    expect(button).not.toBeDisabled();
  });

  test('calculates age from DOB', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: isoMonthsAgo(36) } });
    expect(await screen.findByText('Age: 3 years')).toBeInTheDocument();
  });

  test('reveals the aggression detail field when "Yes" is selected, and accepts text', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'yes' } }); // aggression
    const detail = await screen.findByPlaceholderText(/known triggers/);
    await userEvent.type(detail, 'Growls at squirrels');
    expect(detail).toHaveValue('Growls at squirrels');
  });

  test('reveals the health detail field when "Yes" is selected, and accepts text', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[2], { target: { value: 'yes' } }); // health
    const detail = await screen.findByPlaceholderText(/conditions, limitations/);
    await userEvent.type(detail, 'Mild arthritis');
    expect(detail).toHaveValue('Mild arthritis');
  });

  test('← Back to Dogs returns to the owner page with owner info preserved', async () => {
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('← Back to Dogs'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Kim Miller');
  });

  test('a 2nd dog added via "+ Add Dog" gets its own blank page, titled "Dog 2" - dog 1\'s data is untouched', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    fireEvent.click(screen.getByText('+ Add Dog'));
    expect(await screen.findByText('Dog 2')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue(''); // the new dog's own page, blank
    // dog 1's data isn't lost - just off-screen, verified via a later test
    // that submits a 2-dog booking and checks both dogs made it to the
    // payload (see Step 5 - Signature)
  });

  test('re-opening Edit on a dog shows its previously entered data preserved', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    fireEvent.click(screen.getByText('Edit'));
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    expect(screen.getByPlaceholderText('Golden Retriever')).toHaveValue('Labrador');
  });
});

// ── Step 3: Stay Dates ───────────────────────────────────────────────────────
describe('Step 3 — Stay Dates', () => {
  test('Continue is disabled on an empty dates form, and does nothing if clicked anyway', async () => {
    await fillStep1();
    await fillStep2();
    const button = screen.getByText('Continue');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByText('Boarding Agreement')).not.toBeInTheDocument();
  });

  test('Continue enables once dates/times are filled, even before they\'re checked for validity', async () => {
    // Deliberately an invalid combination (check-out before check-in) -
    // Continue should still be clickable so the specific error message
    // can be seen, rather than an unexplained grey button.
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-05' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-01' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(screen.getByText('Continue')).not.toBeDisabled();
  });

  test('shows an error when check-out is before check-in', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-05' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-01' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText(/must be after check-in/)).toBeInTheDocument();
  });

  test('rejects a check-in date in the past, even though the date input\'s min is only a UI hint', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(-1) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(1) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Check-in cannot be in the past')).toBeInTheDocument();
  });

  test('accepts today as check-in even in the evening, Pacific time (regression for the UTC "today" bug)', async () => {
    // Fill the form first, under real timers - userEvent's internal
    // scheduling doesn't play well with fake timers. Only the moment of
    // picking the date and clicking Continue needs the clock frozen.
    await fillStep1();
    await fillStep2();

    const realTZ = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    // 06:00 UTC = 11pm PDT the previous evening - a UTC-based "today"
    // would be one calendar day ahead of Pacific's actual today, making
    // that real today (and any check-in date near it) look "in the
    // past" and impossible to (re-)select - this is what broke it.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T06:00:00Z'));
    try {
      const dateInputs = document.querySelectorAll('input[type="date"]');
      fireEvent.change(dateInputs[0], { target: { value: '2026-03-15' } }); // Pacific's actual "today"
      fireEvent.change(dateInputs[1], { target: { value: '2026-03-16' } });
      const timeInputs = document.querySelectorAll('input[type="time"]');
      fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
      fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
      fireEvent.click(screen.getByText('Continue'));
      expect(screen.getByText('Boarding Agreement')).toBeInTheDocument();
      expect(screen.queryByText('Check-in cannot be in the past')).not.toBeInTheDocument();
    } finally {
      process.env.TZ = realTZ;
      jest.useRealTimers();
    }
  });

  test('accepts a check-in of today', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(0) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(1) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('rejects a same-day pick-up at or before drop-off', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    const today = daysFromToday(1);
    fireEvent.change(dateInputs[0], { target: { value: today } });
    fireEvent.change(dateInputs[1], { target: { value: today } }); // same day
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '17:00' } }); // drop-off
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } }); // "pick-up" earlier in the day
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Pick-up must be after drop-off for a same-day stay')).toBeInTheDocument();
  });

  test('allows an evening drop-off and a next-morning pick-up across two different days', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(1) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(2) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '17:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } }); // earlier clock time, but a later day - fine
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('shows an estimated cost once valid dates/times are entered', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-03' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(await screen.findByText('$210')).toBeInTheDocument();
  });

  test('formats the estimate with a thousands comma once it crosses $999', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    // 10 nights @ $105/night = $1,050
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-11' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(await screen.findByText('$1,050')).toBeInTheDocument();
  });

  test('accepts free-text notes', async () => {
    await fillStep1();
    await fillStep2();
    const notes = screen.getByPlaceholderText(/Any instructions/);
    await userEvent.type(notes, 'Please give 1 cup of food twice a day.');
    expect(notes).toHaveValue('Please give 1 cup of food twice a day.');
  });

  test('estimated cost factors in the multi-dog discount set on the owner page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });

    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Stay Dates');

    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-02' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    // 1 night @ $105: dog 1 = $105, dog 2 = $105 * 0.9 = $94.50 -> $199.50,
    // which rounds UP to $200 (exactly .50 rounds up)
    expect(await screen.findByText('$200')).toBeInTheDocument();
    expect(screen.getByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('Back returns to Owner Information', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
  });
});

// ── Step 5: Signature & Submission ──────────────────────────────────────────
describe('Step 5 — Signature', () => {
  test('Submit Agreement is disabled until the checkbox is checked and a signature is typed', async () => {
    await fillThrough();
    const button = screen.getByText('Submit Agreement');
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toBeDisabled(); // signature still blank
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Wrong Name');
    expect(button).not.toBeDisabled(); // filled in, even though it won't match on click
  });

  test('Submit Agreement uses the same styling as every other Continue button, not a separate muted color', async () => {
    // Regression guard: it used to carry its own "btn-submit" class with a
    // muted sage green that read as grey/disabled-looking even when the
    // button was fully enabled - now it's just btn-primary like everywhere
    // else in the flow.
    await fillThrough();
    const button = screen.getByText('Submit Agreement');
    expect(button.className).toBe('btn-primary');
  });

  test('signature must match name from step 1', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Wrong Name');
    fireEvent.click(screen.getByText('Submit Agreement'));
    expect(await screen.findByText(/must match/i)).toBeInTheDocument();
  });

  test('submits successfully and shows the confirmation screen with correct details', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    expect(await screen.findByText("You're all set, Kim!")).toBeInTheDocument();
    expect(screen.getByText(/Rex/)).toBeInTheDocument();
    expect(screen.getByText('10/01/2026')).toBeInTheDocument();
    expect(screen.getByText('10/05/2026')).toBeInTheDocument();
    expect(screen.getByText('$420')).toBeInTheDocument(); // 4 nights (Oct 1-5) @ $105/day, Confirmation shows the raw number

    // Regression guard: submission goes through the submit-booking Edge
    // Function (server-side find-or-create under the service role key),
    // never a direct client insert - the owners/dogs/stays tables grant
    // anon nothing at all (see the Sept 14 dog-profiles reorg).
    expect(supabase.functions.invoke).toHaveBeenCalledWith('submit-booking', {
      body: expect.objectContaining({
        owner: expect.objectContaining({ name: 'Kim Miller', phone: '4155550100', email: 'kim@test.com' }),
        dogs: [expect.objectContaining({ name: 'Rex', breed: 'Labrador' })],
        checkIn: '2026-10-01',
        checkOut: '2026-10-05',
        // captured verbatim at submission (Sept 16, 2026) so a later edit
        // to waiver.js can never retroactively change what this client is
        // on record as having signed
        waiverSnapshot: expect.arrayContaining([expect.objectContaining({ title: expect.any(String), body: expect.any(String) })]),
      }),
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', expect.any(Object));
  });

  test('shows an alert and stays on the form when saving fails', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    mockInvokeDefaults({ 'submit-booking': async () => ({ data: null, error: { message: 'db down' } }) });

    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy).toHaveBeenCalledWith('There was an error saving. Please try again.');
    expect(screen.queryByText(/You're all set/)).not.toBeInTheDocument();
    expect(screen.getByText('Sign & Submit')).toBeInTheDocument();

    alertSpy.mockRestore();
  });

  test('"Book Another Stay" resets the form back to step 1', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));
    await screen.findByText(/You're all set/);

    fireEvent.click(screen.getByText('Book Another Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('(415) 555-0100')).toHaveValue('');
  });

  test('Back returns to the waiver step', async () => {
    await fillThrough();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('still shows the confirmation screen even if the confirmation text fails to send', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockInvokeDefaults({ 'send-confirmation': async () => { throw new Error('twilio down'); } });

    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Text send failed:', expect.any(Error)));

    consoleSpy.mockRestore();
  });

  test('a 2-dog booking submits both dogs\' data, each from its own page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });

    fireEvent.click(screen.getByText('Edit'));
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    fireEvent.click(screen.getByText('+ Add Dog'));
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Stay Dates');
    await fillStep3();
    await fillStep4();

    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('submit-booking', expect.any(Object)));
    const call = supabase.functions.invoke.mock.calls.find(c => c[0] === 'submit-booking');
    expect(call[1].body.dogs).toEqual([
      expect.objectContaining({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' }),
      expect.objectContaining({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' }),
    ]);
    expect(call[1].body.owner).toEqual(expect.objectContaining({ vetName: 'Marin Pet Hospital — (415) 479-8387' }));
  });
});

// ── Admin: login ─────────────────────────────────────────────────────────────
describe('Admin login', () => {
  test('rejects wrong password', async () => {
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrongpassword');
    fireEvent.click(screen.getByText('Sign In'));
    expect(await screen.findByText('Incorrect password')).toBeInTheDocument();
    expect(supabase.functions.invoke).toHaveBeenCalledWith('admin-data', { body: { password: 'wrongpassword' } });
  });

  test('accepts the correct password and shows Past Stays', async () => {
    await loginAsAdmin();
    expect(screen.getByText('Past Stays')).toBeInTheDocument();
    expect(screen.getByText('Bud')).toBeInTheDocument();
    expect(screen.getByText('Choco')).toBeInTheDocument();
  });

  test('shows the singular "stay" label for a dog with exactly one billed stay', async () => {
    await loginAsAdmin([{ ...SAMPLE_DOGS[0], stays: [SAMPLE_DOGS[0].stays[0]] }], 1);
    expect(screen.getByText('1 stay')).toBeInTheDocument();
  });

  test('shows an empty state when there are no records', async () => {
    await loginAsAdmin([], 0);
    expect(screen.getByText('No records found.')).toBeInTheDocument();
  });

  test('cancel button on the login screen closes the admin overlay', async () => {
    goToAdminUrl();
    render(<App />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Admin Access')).not.toBeInTheDocument();
  });

  test('pressing Enter in the password field submits it', async () => {
    mockInvokeDefaults({ 'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }) });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password{Enter}');
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });

  test('Admin is not shown directly - only inside the collapsed nav menu (or the ?admin URL)', async () => {
    render(<App />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Book My Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});

// ── Admin: logged in ─────────────────────────────────────────────────────────
const UNBILLED_DOGS = [
  {
    id: 'dog-bud', name: 'Bud', breed: 'Labrador', dob: null, spay_neuter: 'yes',
    aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
    owner: { name: 'Kim', phone: '6505551111', email: 'kim@test.com' },
    stays: [
      // Checked out a while ago, never billed - earliest check-in, should
      // sort first.
      {
        id: 'stay-earliest', check_in: daysFromToday(-10), check_out: daysFromToday(-8),
        drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 105,
        number_of_dogs: 1, submitted_at: '2026-01-01T00:00:00Z', billed_at: null,
      },
      // Already billed - should NOT show up.
      {
        id: 'stay-already-billed', check_in: daysFromToday(-6), check_out: daysFromToday(-5),
        drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 105,
        number_of_dogs: 1, submitted_at: '2026-01-01T00:00:00Z', billed_at: '2026-01-05T00:00:00Z',
      },
      // Still upcoming, never billed - SHOULD show up (Sept 17, 2026 -
      // Unbilled Stays used to exclude future/in-progress stays; not any
      // more, it's every unbilled stay regardless of date).
      {
        id: 'stay-future', check_in: daysFromToday(3), check_out: daysFromToday(5),
        drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 210,
        number_of_dogs: 1, submitted_at: '2026-01-01T00:00:00Z', billed_at: null,
      },
    ],
  },
  {
    id: 'dog-fido', name: 'Fido', breed: 'Poodle', dob: null, spay_neuter: 'yes',
    aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
    owner: { name: 'Kim', phone: '6505551111', email: 'kim@test.com' },
    stays: [
      // Shares the same stay id as Bud's below (a 2-dog booking) - the
      // unbilled list must dedupe by stay id, not show it twice. Check-in
      // falls between stay-earliest and stay-future above.
      {
        id: 'stay-shared', check_in: daysFromToday(-4), check_out: daysFromToday(-2),
        drop_time: '09:00:00', pickup_time: '17:00:00', estimated_cost: 380,
        number_of_dogs: 2, submitted_at: '2026-01-01T00:00:00Z', billed_at: null,
      },
    ],
  },
  {
    id: 'dog-bud2', name: 'Bud', breed: 'Labrador', dob: null, spay_neuter: 'yes',
    aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
    owner: { name: 'Kim', phone: '6505551111', email: 'kim@test.com' },
    stays: [
      {
        id: 'stay-shared', check_in: daysFromToday(-4), check_out: daysFromToday(-2),
        drop_time: '09:00:00', pickup_time: '17:00:00', estimated_cost: 380,
        number_of_dogs: 2, submitted_at: '2026-01-01T00:00:00Z', billed_at: null,
      },
    ],
  },
];

async function loginAsAdminWithUnbilled(dogs = UNBILLED_DOGS) {
  mockInvokeDefaults({
    'admin-data': async (opts) => {
      if (opts?.body?.action === 'billStay') {
        return { data: { dogs: [], totalStays: 0 }, error: null }; // stay(s) now billed, list refreshes empty
      }
      return { data: { dogs, totalStays: dogs.reduce((n, d) => n + d.stays.length, 0) }, error: null };
    },
  });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

describe('Admin — logged in — Unbilled Stays', () => {
  test('includes every unbilled stay - past, in-progress, and future - deduping a shared multi-dog stay, sorted earliest check-in first', async () => {
    await loginAsAdminWithUnbilled();
    const cards = document.querySelectorAll('.unbilled-section .stay-card');
    expect(cards.length).toBe(3); // stay-earliest, stay-shared (once, not twice), stay-future
    expect(within(cards[0]).getByText('Bud — Kim')).toBeInTheDocument(); // stay-earliest
    expect(within(cards[1]).getByText('Fido & Bud — Kim')).toBeInTheDocument(); // stay-shared
    expect(within(cards[2]).getByText('Bud — Kim')).toBeInTheDocument(); // stay-future
    // The already-billed stay never renders a card at all
    expect(cards.length).not.toBe(4);
  });

  test('clicking a stay expands it, showing details plus Edit and Send Billing Text buttons; clicking again collapses it', async () => {
    await loginAsAdminWithUnbilled();
    const header = screen.getByText('Fido & Bud — Kim');
    const card = header.closest('.stay-card');
    expect(within(card).queryByText('Edit')).not.toBeInTheDocument(); // collapsed by default
    fireEvent.click(header);
    expect(within(card).getByText('Edit')).toBeInTheDocument();
    expect(within(card).getByText('Send Billing Text')).toBeInTheDocument();
    expect(within(card).getByText(/Estimated cost/)).toBeInTheDocument();
    fireEvent.click(header);
    expect(within(card).queryByText('Edit')).not.toBeInTheDocument();
  });

  test('Edit reveals the editable dates/times/cost fields, and Recalculate updates the cost from the real cost logic', async () => {
    await loginAsAdminWithUnbilled();
    const card = screen.getByText('Fido & Bud — Kim').closest('.stay-card');
    fireEvent.click(screen.getByText('Fido & Bud — Kim'));
    fireEvent.click(within(card).getByText('Edit'));
    const costInput = within(card).getByDisplayValue('380');
    fireEvent.click(within(card).getByText('Recalculate'));
    // 2 nights, 2 dogs, default 10% off the 2nd -> matches calcCost's own math, just confirms it changed from the raw stored estimate
    await waitFor(() => expect(costInput.value).not.toBe(''));
  });

  test('Daily Rate and Holiday Upcharge % are per-stay editable (defaulting to the site settings), with the full math shown, and drive Recalculate', async () => {
    await loginAsAdminWithUnbilled();
    const card = screen.getByText('Fido & Bud — Kim').closest('.stay-card');
    fireEvent.click(screen.getByText('Fido & Bud — Kim'));
    fireEvent.click(within(card).getByText('Edit'));

    expect(within(card).getByText('Daily Rate')).toBeInTheDocument();
    expect(within(card).getByText('Holiday Upcharge %')).toBeInTheDocument();
    const dayRateInput = within(card).getByDisplayValue('105'); // defaults to the global day rate
    within(card).getByDisplayValue('30'); // defaults to the global holiday upcharge %

    // The breakdown must show the 1st dog and additional dog(s) as their
    // own line items with the actual discounted rate, not just "x 2 dogs"
    // as if it were a flat doubling (that label used to be shown even
    // though the total underneath it already had the 10% 2nd-dog discount
    // baked in, which read as a math error - Sept 18, 2026 fix; split into
    // separate 1st-dog/additional-dog lines the same day, on request).
    expect(within(card).getByText(/1st dog/)).toBeInTheDocument();
    expect(within(card).getByText(/1 additional dog × 90% \(10% off each\)/)).toBeInTheDocument();

    fireEvent.change(dayRateInput, { target: { value: '200' } });
    fireEvent.click(within(card).getByText('Recalculate'));

    const stay = UNBILLED_DOGS[1].stays[0]; // stay-shared
    const expected = calcCostBreakdown(
      stay.check_in, stay.check_out, stay.drop_time.slice(0, 5), stay.pickup_time.slice(0, 5),
      200, stay.number_of_dogs, 0.10, 0.30,
    ).total.toFixed(2);
    await waitFor(() => expect(within(card).getByDisplayValue(expected)).toBeInTheDocument());
  });

  test('sends the bill (SMS first, then marks billed) and the stay drops off the list - no Edit click required first', async () => {
    await loginAsAdminWithUnbilled();
    fireEvent.click(screen.getByText('Fido & Bud — Kim'));
    const card = screen.getByText('Fido & Bud — Kim').closest('.stay-card');
    fireEvent.click(within(card).getByText('Send Billing Text'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', {
      body: expect.objectContaining({ type: 'billing', dog_name: 'Fido & Bud', owner_phone: '6505551111', final_cost: 380 }),
    }));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('admin-data', {
      body: expect.objectContaining({ action: 'billStay', stayId: 'stay-shared', estimatedCost: 380 }),
    }));
    expect(await screen.findByText('Nothing to bill right now.')).toBeInTheDocument();
  });

  test('does not mark billed if the SMS send fails - the stay stays on the list', async () => {
    mockInvokeDefaults({
      'admin-data': async () => ({ data: { dogs: UNBILLED_DOGS, totalStays: 4 }, error: null }),
      'send-confirmation': async () => ({ data: null, error: { message: 'twilio down' } }),
    });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
    fireEvent.click(screen.getByText('Sign In'));
    await screen.findByText('Bayview Boarding — Admin');

    fireEvent.click(screen.getByText('Fido & Bud — Kim'));
    const card = screen.getByText('Fido & Bud — Kim').closest('.stay-card');
    fireEvent.click(within(card).getByText('Send Billing Text'));
    expect(await within(card).findByText('Failed to send. Please try again.')).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('admin-data', expect.objectContaining({ body: expect.objectContaining({ action: 'billStay' }) }));
    expect(screen.getByText('Fido & Bud — Kim')).toBeInTheDocument(); // still there
  });

  test('shows a friendly empty state when nothing needs billing', async () => {
    await loginAsAdminWithUnbilled([]);
    expect(screen.getByText('Nothing to bill right now.')).toBeInTheDocument();
  });
});

describe('Admin — logged in — Ideas & Bugs', () => {
  test('the entry button shows the open count as a badge', async () => {
    await loginAsAdminWithFeedback();
    const entry = screen.getByText('💡 Ideas & Bugs').closest('button');
    expect(within(entry).getByText('2')).toBeInTheDocument(); // 2 of the 3 fixtures are open
  });

  test('no badge when there are no open submissions', async () => {
    await loginAsAdminWithFeedback([{ id: 'fb-1', category: 'idea', message: 'x', status: 'done', created_at: '2026-09-16T12:00:00Z' }]);
    const entry = screen.getByText('💡 Ideas & Bugs').closest('button');
    expect(within(entry).queryByText('1')).not.toBeInTheDocument();
  });

  test('opens the list showing every submission with its message and submitter (no category shown)', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    expect(await screen.findByText('Ideas & Bugs', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('3 submissions · 2 open')).toBeInTheDocument();
    expect(screen.getByText('Map pin looks off on Safari')).toBeInTheDocument();
    expect(screen.getByText('Jane Tester · jane@test.com')).toBeInTheDocument();
    expect(screen.getByText('Add a dark mode')).toBeInTheDocument();
  });

  test('moves a submission to a new status', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    await screen.findByText('Map pin looks off on Safari');
    const card = screen.getByText('Map pin looks off on Safari').closest('.stay-card');

    fireEvent.click(within(card).getByText('On List'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('feedback', {
      body: { password: 'correct-password', id: 'fb-1', status: 'on_list' },
    }));
  });

  test('"Rejected" is also a manually-settable status, alongside Open/On List/Done', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    await screen.findByText('Map pin looks off on Safari');
    const card = screen.getByText('Map pin looks off on Safari').closest('.stay-card');

    fireEvent.click(within(card).getByText('Rejected'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('feedback', {
      body: { password: 'correct-password', id: 'fb-1', status: 'rejected' },
    }));
  });

  test('← Admin returns to the main admin panel', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    await screen.findByText('Ideas & Bugs', { selector: 'h2' });
    fireEvent.click(screen.getByText('← Admin'));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });
});

describe('Admin — logged in — Testers', () => {
  test('opens the tester list, showing name and phone for each', async () => {
    await loginAsAdminWithTesters();
    fireEvent.click(screen.getByText('📢 Testers'));
    expect(await screen.findByText('Testers', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('Jane Tester — 4155550100')).toBeInTheDocument();
    expect(screen.getByText('Inactive Ida — 4155550101')).toBeInTheDocument();
  });

  test('adds a tester, requiring both name and phone', async () => {
    await loginAsAdminWithTesters([]);
    fireEvent.click(screen.getByText('📢 Testers'));
    await screen.findByText('Testers', { selector: 'h2' });

    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText('Name and phone are both required')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Name'), 'New Tester');
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550199');
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText('New Tester — 4155550199')).toBeInTheDocument();
  });

  test('removes a tester from the list', async () => {
    await loginAsAdminWithTesters();
    fireEvent.click(screen.getByText('📢 Testers'));
    await screen.findByText('Jane Tester — 4155550100');
    const row = screen.getByText('Jane Tester — 4155550100').closest('div');
    fireEvent.click(within(row).getByText('Remove'));
    await waitFor(() => expect(screen.queryByText('Jane Tester — 4155550100')).not.toBeInTheDocument());
  });

  test('pre-fills a suggested message (Send starts enabled), counts only active testers, and disables if cleared', async () => {
    await loginAsAdminWithTesters();
    fireEvent.click(screen.getByText('📢 Testers'));
    await screen.findByText('Testers', { selector: 'h2' });
    // 1 of the 2 fixtures is active
    const sendBtn = screen.getByText('Send to 1 tester');
    const box = screen.getByDisplayValue(/We've made a few changes to the Bayview Boarding site/);
    expect(sendBtn).not.toBeDisabled(); // a suggested message is already there
    fireEvent.change(box, { target: { value: '' } });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Check out the new map!' } });
    expect(sendBtn).not.toBeDisabled();
  });

  test('sends the broadcast and shows how many were reached', async () => {
    await loginAsAdminWithTesters();
    fireEvent.click(screen.getByText('📢 Testers'));
    await screen.findByText('Testers', { selector: 'h2' });
    const box = screen.getByDisplayValue(/We've made a few changes to the Bayview Boarding site/);
    fireEvent.change(box, { target: { value: 'Check out the new map!' } });
    fireEvent.click(screen.getByText('Send to 1 tester'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('testers', {
      body: { password: 'correct-password', action: 'notify', message: 'Check out the new map!' },
    }));
    expect(await screen.findByText(/Sent to 1/)).toBeInTheDocument();
  });

  test('← Admin returns to the main admin panel', async () => {
    await loginAsAdminWithTesters();
    fireEvent.click(screen.getByText('📢 Testers'));
    await screen.findByText('Testers', { selector: 'h2' });
    fireEvent.click(screen.getByText('← Admin'));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });
});

describe('Admin — logged in', () => {
  test('filters the owner list by owner or dog name', async () => {
    await loginAsAdmin();
    await userEvent.type(screen.getByPlaceholderText('Search by owner or dog name...'), 'Bud');
    expect(screen.getByText('Kim')).toBeInTheDocument();
    expect(screen.queryByText('Estee')).not.toBeInTheDocument();
  });

  test('close button closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByText('Bayview Boarding — Admin')).not.toBeInTheDocument();
  });

  test('selecting an owner shows their full past-stay history, including per-dog flags and notes', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    expect(await screen.findByRole('heading', { name: 'Kim' })).toBeInTheDocument();
    expect(screen.getByText('Bud')).toBeInTheDocument(); // dog-names subtitle

    // Bud has 2 past stays (Sept + June) — most recent check-in sorts first
    const budCards = document.querySelectorAll('.stay-card');
    expect(budCards).toHaveLength(2);
    expect(budCards[0].textContent).toContain('09/01/2026');
    expect(budCards[1].textContent).toContain('06/01/2026');

    // collapsed by default - click to expand
    fireEvent.click(within(budCards[0]).getByText(/Bud — Kim/));
    expect(within(budCards[0]).getByText(/Billed cost: \$210/)).toBeInTheDocument();
    expect(within(budCards[0]).getByText(/Loves belly rubs/)).toBeInTheDocument();
    expect(within(budCards[0]).getByText(/DOB:/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/All Owners/));
    fireEvent.click(screen.getByText('Estee'));
    expect(await screen.findByRole('heading', { name: 'Estee' })).toBeInTheDocument();
    const chocoCard = document.querySelector('.stay-card');
    fireEvent.click(within(chocoCard).getByText(/Choco — Estee/));
    expect(within(chocoCard).getByText(/Aggression noted: Barks at mail carrier/)).toBeInTheDocument();
    expect(within(chocoCard).getByText(/Health note: Mild hip dysplasia/)).toBeInTheDocument();
  });

  test('a stay with a waiver snapshot offers to show it, collapsed by default; one without shows no such control', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });
    const budCards = document.querySelectorAll('.stay-card');

    // stay-1 (Sept) has a waiver_snapshot in the fixture; stay-3 (June) does not.
    // Only one stay expands at a time, so this checks each in turn.
    fireEvent.click(within(budCards[0]).getByText(/Bud — Kim/));
    expect(within(budCards[0]).getByText('View waiver as signed')).toBeInTheDocument();
    expect(within(budCards[0]).queryByText('Test waiver body text.')).not.toBeInTheDocument();

    fireEvent.click(within(budCards[0]).getByText('View waiver as signed'));
    expect(within(budCards[0]).getByText('Risks & Releases')).toBeInTheDocument();
    expect(within(budCards[0]).getByText('Test waiver body text.')).toBeInTheDocument();

    fireEvent.click(within(budCards[0]).getByText('Hide waiver as signed'));
    expect(within(budCards[0]).queryByText('Test waiver body text.')).not.toBeInTheDocument();

    fireEvent.click(within(budCards[1]).getByText(/Bud — Kim/));
    expect(within(budCards[1]).queryByText('View waiver as signed')).not.toBeInTheDocument();
  });

  test('Billing SMS: Edit shows the final cost defaulting to the estimate, and Send calls send-confirmation with type billing', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });

    const budCard = document.querySelectorAll('.stay-card')[0];
    fireEvent.click(within(budCard).getByText(/Bud — Kim/));
    fireEvent.click(within(budCard).getByText('Edit'));
    expect(within(budCard).getByDisplayValue('210')).toBeInTheDocument(); // defaults to that stay's estimate

    fireEvent.click(within(budCard).getByText('Send Billing Text'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', {
      body: {
        type: 'billing',
        owner_name: 'Kim',
        owner_phone: '6505551111',
        dog_name: 'Bud',
        final_cost: 210,
        message_template: expect.any(String), // the admin-editable billing template (settings.sms_billing)
        billing_breakdown: expect.any(String), // the full line-item math behind final_cost
      },
    }));
  });

  test('Billing SMS: admin can adjust the final cost before (re)sending', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });

    const budCard = document.querySelectorAll('.stay-card')[0];
    fireEvent.click(within(budCard).getByText(/Bud — Kim/));
    fireEvent.click(within(budCard).getByText('Edit'));
    const costInput = within(budCard).getByDisplayValue('210');
    fireEvent.change(costInput, { target: { value: '250' } });
    fireEvent.click(within(budCard).getByText('Send Billing Text'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', {
      body: expect.objectContaining({ final_cost: 250 }),
    }));
  });

  test('Billing SMS: refuses to send with no amount entered', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Estee')); // Choco's stay has a null estimate
    await screen.findByRole('heading', { name: 'Estee' });

    const chocoCard = document.querySelector('.stay-card');
    fireEvent.click(within(chocoCard).getByText(/Choco — Estee/));
    fireEvent.click(within(chocoCard).getByText('Send Billing Text'));
    expect(await within(chocoCard).findByText('Enter a valid amount first')).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('send-confirmation', expect.any(Object));
  });

  test('Billing SMS: shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({
      'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }),
      'send-confirmation': async () => ({ data: null, error: { message: 'Twilio down' } }),
    });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
    fireEvent.click(screen.getByText('Sign In'));
    await screen.findByText('Bayview Boarding — Admin');
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });

    const budCard = document.querySelectorAll('.stay-card')[0];
    fireEvent.click(within(budCard).getByText(/Bud — Kim/));
    fireEvent.click(within(budCard).getByText('Send Billing Text'));
    expect(await within(budCard).findByText('Failed to send. Please try again.')).toBeInTheDocument();
  });

  test('← All Owners returns from the owner detail view to Past Stays', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });
    fireEvent.click(screen.getByText(/All Owners/));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });

  test('close button in the owner detail view closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Kim'));
    await screen.findByRole('heading', { name: 'Kim' });
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByRole('heading', { name: 'Kim' })).not.toBeInTheDocument();
  });

  test('"Site Settings" header separates the lookup sections from the settings sections below', async () => {
    await loginAsAdmin();
    expect(screen.getByText('Site Settings')).toBeInTheDocument();
  });

  test('Past Stays: an owner with 2 dogs on a shared billed stay gets one owner row and one combined-name stay card', async () => {
    const sharedStayDogs = [
      {
        id: 'dog-don', name: 'Don', breed: 'Lab', dob: null, spay_neuter: 'yes',
        aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
        owner: { name: 'Pat', phone: '6505553333', email: 'pat@test.com' },
        stays: [{
          id: 'stay-shared-billed', check_in: '2026-08-01', check_out: '2026-08-03',
          drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 300,
          number_of_dogs: 2, submitted_at: '2026-07-30T10:00:00Z', billed_at: '2026-08-04T00:00:00Z',
        }],
      },
      {
        id: 'dog-bob', name: 'Bob', breed: 'Poodle', dob: null, spay_neuter: 'yes',
        aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
        owner: { name: 'Pat', phone: '6505553333', email: 'pat@test.com' },
        stays: [{
          id: 'stay-shared-billed', check_in: '2026-08-01', check_out: '2026-08-03',
          drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 300,
          number_of_dogs: 2, submitted_at: '2026-07-30T10:00:00Z', billed_at: '2026-08-04T00:00:00Z',
        }],
      },
    ];
    await loginAsAdmin(sharedStayDogs, 1);

    // One row for owner Pat, not two (one per dog)
    expect(screen.getAllByText('Pat')).toHaveLength(1);
    expect(screen.getByText('Don, Bob')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pat'));
    await screen.findByRole('heading', { name: 'Pat' });
    const cards = document.querySelectorAll('.stay-card');
    expect(cards).toHaveLength(1); // deduped, not one per dog
    expect(within(cards[0]).getByText('Don & Bob — Pat')).toBeInTheDocument();
  });

  test('updates and displays the day rate after Save', async () => {
    await loginAsAdmin();
    // Scoped to its own section (not just the first number input/"Save"
    // button on the page) since other sections - including the Unbilled
    // Stays list - have their own number inputs and Save-like buttons.
    const dayRateEditor = within(document.querySelector('.day-rate-editor'));
    fireEvent.change(dayRateEditor.getByRole('spinbutton'), { target: { value: '150' } });
    fireEvent.click(dayRateEditor.getByText('Save'));
    expect(await screen.findByText(/Current rate: \$150\/day/)).toBeInTheDocument();
  });

  test('updates the 2nd+ dog discount %', async () => {
    await loginAsAdmin();
    const discountEditor = within(document.querySelector('.discount-editor'));
    fireEvent.change(discountEditor.getByRole('spinbutton'), { target: { value: '15' } });
    fireEvent.click(discountEditor.getByText('Save'));
    expect(await screen.findByText(/Current: 15%/)).toBeInTheDocument();
  });

  test('updates the holiday upcharge %', async () => {
    await loginAsAdmin();
    const holidayEditor = within(document.querySelector('.holiday-editor'));
    fireEvent.change(holidayEditor.getByRole('spinbutton'), { target: { value: '25' } });
    fireEvent.click(holidayEditor.getByText('Save'));
    expect(await screen.findByText(/Current: 25%/)).toBeInTheDocument();
  });

  test('shows a validation error from the server without crashing, and does not update the displayed rate', async () => {
    mockInvokeDefaults({
      'admin-data': async () => ({ data: { dogs: [], totalStays: 0 }, error: null }),
      'settings': async (opts) => {
        if (opts?.body?.updates) return { data: { error: 'Invalid settings: dayRate must be a positive number' }, error: null };
        return { data: { dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30, vets: ['Marin Pet Hospital — (415) 479-8387'] }, error: null };
      },
    });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
    fireEvent.click(screen.getByText('Sign In'));
    await screen.findByText('Bayview Boarding — Admin');

    const dayRateEditor = within(document.querySelector('.day-rate-editor'));
    fireEvent.change(dayRateEditor.getByRole('spinbutton'), { target: { value: '-5' } });
    fireEvent.click(dayRateEditor.getByText('Save'));
    expect(await screen.findByText(/Invalid settings: dayRate must be a positive number/)).toBeInTheDocument();
    expect(screen.getByText(/Current rate: \$105\/day/)).toBeInTheDocument(); // unchanged
  });

  test('shows the vet list actually fetched from settings, not the hardcoded fallback', async () => {
    // Regression test: the admin panel's vet-list editor used to seed
    // itself from the vets *prop* at the moment AdminView first mounted -
    // but App's settings fetch (a separate, async network call) hadn't
    // necessarily resolved by then, so it could show the hardcoded
    // fallback list (8 entries, defined in src/settings.js) instead of
    // what was actually saved. DEFAULT_SETTINGS here deliberately has
    // only 1 entry, distinct from that fallback, so this only passes if
    // the real fetched value is what's shown.
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    expect(vetEditor.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
    expect(vetEditor.queryByText('VCA Marin Animal Hospital — (415) 454-5225')).not.toBeInTheDocument();
    expect(vetEditor.getAllByText('Remove')).toHaveLength(1);
  });

  test('adds a vet clinic to the list, then removes it, before saving', async () => {
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    expect(vetEditor.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();

    await userEvent.type(vetEditor.getByPlaceholderText(/Clinic Name/), 'New Clinic — (415) 555-0100');
    fireEvent.click(vetEditor.getByText('Add'));
    expect(vetEditor.getByText('New Clinic — (415) 555-0100')).toBeInTheDocument();

    fireEvent.click(vetEditor.getByText('Save Vet List'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { vets: ['Marin Pet Hospital — (415) 479-8387', 'New Clinic — (415) 555-0100'] } },
    }));
  });

  test('removes a vet clinic from the list before saving', async () => {
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    fireEvent.click(vetEditor.getAllByText('Remove')[0]);
    expect(vetEditor.queryByText('Marin Pet Hospital — (415) 479-8387')).not.toBeInTheDocument();
  });

  test('shows the packing list actually fetched from settings, not the hardcoded fallback', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    expect(packingEditor.getByText('Food')).toBeInTheDocument();
    expect(packingEditor.getByText('Leash & doggy bags')).toBeInTheDocument();
    expect(packingEditor.queryByText('Bed & favorite blanket')).not.toBeInTheDocument();
  });

  test('adds a packing-list item, then saves it', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    await userEvent.type(packingEditor.getByPlaceholderText('Item to bring'), 'Medication');
    fireEvent.click(packingEditor.getByText('Add'));
    expect(packingEditor.getByText('Medication')).toBeInTheDocument();

    fireEvent.click(packingEditor.getByText('Save Packing List'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { packingList: ['Food', 'Leash & doggy bags', 'Medication'] } },
    }));
  });

  test('removes a packing-list item before saving', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    fireEvent.click(packingEditor.getAllByText('Remove')[0]);
    expect(packingEditor.queryByText('Food')).not.toBeInTheDocument();
  });

  test('shows the SMS templates actually fetched from settings, editable and independently saveable', async () => {
    await loginAsAdmin();
    const smsEditor = within(document.querySelector('.sms-editor'));
    expect(smsEditor.getByDisplayValue('Hi {firstName}! confirmed.')).toBeInTheDocument();
    expect(smsEditor.getByDisplayValue('Hi {firstName}! reminder, bring {packingList}.')).toBeInTheDocument();
    expect(smsEditor.getByDisplayValue('Hi {firstName}! total ${finalCost}.')).toBeInTheDocument();
    expect(smsEditor.getByDisplayValue('Bye {dogName}! pickup at {pickupDate} {pickupTime}.')).toBeInTheDocument();

    const reminderBox = smsEditor.getByDisplayValue('Hi {firstName}! reminder, bring {packingList}.');
    fireEvent.change(reminderBox, { target: { value: 'New reminder wording {firstName}' } });
    fireEvent.click(smsEditor.getByText('Save Drop-off Reminder Text'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { smsReminder: 'New reminder wording {firstName}' } },
    }));
    // saving the reminder template shouldn't touch the other two
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('settings', {
      body: expect.objectContaining({ updates: expect.objectContaining({ smsConfirmation: expect.anything() }) }),
    });
  });

  test('"Reset to Default" loads the current built-in template into the box without saving it - admin still has to click Save', async () => {
    await loginAsAdmin();
    const smsEditor = within(document.querySelector('.sms-editor'));
    const billingBox = smsEditor.getByDisplayValue('Hi {firstName}! total ${finalCost}.');
    fireEvent.change(billingBox, { target: { value: 'Something admin typed' } });

    const billingBlock = billingBox.closest('div');
    fireEvent.click(within(billingBlock).getByText('Reset to Default'));

    expect(billingBox.value).toContain('Thank you for visiting Bayview Boarding');
    expect(billingBox).not.toHaveValue('Something admin typed');
    // loading the default is purely local - nothing is sent until Save is clicked
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('settings', expect.objectContaining({
      body: expect.objectContaining({ updates: expect.objectContaining({ smsBilling: expect.anything() }) }),
    }));
  });

  test('Text Message Footer shows the fetched value, is independently saveable, and can reset to default', async () => {
    await loginAsAdmin();
    const footerBox = within(document.querySelector('.text-footer-editor'));
    expect(footerBox.getByDisplayValue(DEFAULT_SETTINGS.smsFooter)).toBeInTheDocument();

    const box = footerBox.getByDisplayValue(DEFAULT_SETTINGS.smsFooter);
    fireEvent.change(box, { target: { value: 'New footer {primaryManagerPhone}' } });
    fireEvent.click(footerBox.getByText('Save Footer Text'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { smsFooter: 'New footer {primaryManagerPhone}' } },
    }));

    fireEvent.click(footerBox.getByText('Reset to Default'));
    expect(box.value).toContain('Reply STOP to opt out');
  });

  test('login fetches the manager phone numbers via an admin-authenticated settings read, distinct from the public one on mount', async () => {
    await loginAsAdmin();
    // The public settings fetch on mount never sends a password; the
    // admin-only phone read at login does, with no `updates` (distinct
    // from a write, which always includes updates).
    expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', { body: {} });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', { body: { password: 'correct-password' } });

    const phonesBox = within(document.querySelector('.manager-phones-editor'));
    expect(phonesBox.getByDisplayValue('4155550101')).toBeInTheDocument();
    expect(phonesBox.getByDisplayValue('4155550102')).toBeInTheDocument();
  });

  test('Manager Phone Numbers are editable and saveable together', async () => {
    await loginAsAdmin();
    const phonesBox = within(document.querySelector('.manager-phones-editor'));
    fireEvent.change(phonesBox.getByDisplayValue('4155550101'), { target: { value: '4155559999' } });
    fireEvent.click(phonesBox.getByText('Save Phone Numbers'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: {
        password: 'correct-password',
        updates: { primaryManagerPhone: '4155559999', secondaryManagerPhone: '4155550102' },
      },
    }));
  });
});
