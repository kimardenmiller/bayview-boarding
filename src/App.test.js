import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { formatDate, calcAge, calcCost, isHolidayNight, getHolidayWindows } from './App';
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

function mockInvokeDefaults(overrides = {}) {
  supabase.functions.invoke.mockImplementation((fn, opts) => {
    if (overrides[fn]) return overrides[fn](opts);
    if (fn === 'lookup-client') return Promise.resolve({ data: { found: false }, error: null });
    if (fn === 'submit-booking') return Promise.resolve({ data: { stay: DEFAULT_STAY }, error: null });
    if (fn === 'send-confirmation') return Promise.resolve({ data: {}, error: null });
    if (fn === 'admin-data') return Promise.resolve({ data: null, error: { message: 'not mocked in this test' } });
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
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Renders and advances only to the Owner Information page - for tests
// that check that page's own fields (vet, Number of Dogs) directly,
// without also filling and leaving it.
async function goToOwnerStep() {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await screen.findByText('Owner Information');
}

// Fills Owner Information (name/phone/email/vet/Number of Dogs) and
// advances to Dog 1. Vet and dog count live here now, not on the dog
// pages. "Number of Dogs" defaults to 0, so this always sets it to 1
// unless a test explicitly wants otherwise.
async function fillStep1(phone = '4155550100', name = 'Kim Miller', email = 'kim@test.com', numberOfDogs = 1) {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), phone);
  await userEvent.type(screen.getByPlaceholderText('Jane Smith'), name);
  await userEvent.type(screen.getByPlaceholderText('jane@email.com'), email);
  fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(numberOfDogs) } });
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Dog 1');
}

// Fills whichever dog page is currently showing and clicks Continue.
// Does not assert where it lands - the caller checks ("Dog 2" for an
// earlier dog, "Stay Dates" for the last one).
async function fillDogPage({ name = 'Rex', breed = 'Labrador', dob = '2020-01-01' } = {}) {
  await userEvent.type(screen.getByPlaceholderText('Buddy'), name);
  await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), breed);
  fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: dob } });
  const selects = document.querySelectorAll('select');
  fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
  fireEvent.change(selects[1], { target: { value: 'no' } });  // aggression
  fireEvent.change(selects[2], { target: { value: 'no' } });  // health
  fireEvent.click(screen.getByText('Continue'));
}

// Single-dog case (the default form state) - fills Dog 1 and lands on
// Stay Dates. Multi-dog flows call fillDogPage() directly per dog.
async function fillStep2() {
  await fillDogPage();
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
    stays: [
      {
        id: 'stay-1', check_in: '2026-09-01', check_out: '2026-09-03', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 210, submitted_at: '2026-08-30T10:00:00Z', notes: 'Loves belly rubs', number_of_dogs: 1,
        dob: '2020-01-01', aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
      },
      {
        id: 'stay-3', check_in: '2026-06-01', check_out: '2026-06-02', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 105, submitted_at: '2026-05-30T10:00:00Z', notes: '', number_of_dogs: 1,
        dob: null, aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
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
        health_concerns: 'yes', health_detail: 'Mild hip dysplasia',
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

  test('charges a 1-day minimum for a short same-day stay', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('100.00');
  });

  test('rounds up partial days', () => {
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100)).toBe('200.00'); // 25 hrs -> 2 days
  });

  test('defaults to 1 dog when numberOfDogs is omitted', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('100.00');
  });
});

describe('calcCost — multi-dog discount', () => {
  test('charges the 2nd dog at 90% of the nightly rate (10% discount)', () => {
    // 1 night @ $100: dog 1 = $100, dog 2 = $100 * 0.9 = $90 -> $190
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 2)).toBe('190.00');
  });

  test('discount is uncapped - applies to every additional dog', () => {
    // dog 1 = $100, dogs 2 & 3 = $90 each -> $280
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 3)).toBe('280.00');
  });

  test('treats 0 or invalid dog counts as 1 dog', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 0)).toBe('100.00');
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, null)).toBe('100.00');
  });

  test('applies across multiple nights', () => {
    // 2 nights, 2 dogs @ $100/night -> ($100 + $90) * 2 = $380
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100, 2)).toBe('380.00');
  });
});

describe('calcCost — holiday upcharge', () => {
  test('adds 30% on New Year\'s Day', () => {
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100)).toBe('130.00');
  });

  test('does not upcharge the day right after a holiday', () => {
    expect(calcCost('2026-01-02', '2026-01-02', '09:00', '15:00', 100)).toBe('100.00');
  });

  test('combines the holiday upcharge with the multi-dog discount', () => {
    // nightly rate = $100 * 1.3 = $130; dog 2 = $130 * 0.9 = $117 -> $247
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100, 2)).toBe('247.00');
  });

  test('only upcharges the holiday night within a multi-night stay', () => {
    // check-in Jan 1 (holiday, $130) -> check-out Jan 2 (ordinary night, $100)
    // = 2 nights total, only the first is upcharged -> $230
    expect(calcCost('2026-01-01', '2026-01-02', '09:00', '10:00', 100)).toBe('230.00');
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

// ── Step 1: Owner Info (now also vet + Number of Dogs) ──────────────────────
describe('Step 1 — Owner Info', () => {
  test('shows required errors when submitting empty form, including the vet and dog count', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Continue'));
    // phone, name, email, vet
    expect(await screen.findAllByText('Required')).toHaveLength(4);
    // Number of Dogs defaults to 0 - its own, differently-worded error
    expect(screen.getByText('Must be at least 1')).toBeInTheDocument();
  });

  test('advances to Dog 1 when all required fields filled', async () => {
    await fillStep1();
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
  });

  test('vet defaults to the "Select a Vet" placeholder', async () => {
    await goToOwnerStep();
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
  });

  test('Number of Dogs defaults to 0 and does not show a discount note', async () => {
    await goToOwnerStep();
    expect(screen.getByRole('spinbutton')).toHaveValue(0);
    expect(screen.queryByText(/off each additional dog/)).not.toBeInTheDocument();
  });

  test('blocks Continue with "Must be at least 1" while Number of Dogs is still 0', async () => {
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Must be at least 1')).toBeInTheDocument();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
  });

  test('shows the multi-dog discount note once more than 1 dog is entered', async () => {
    await goToOwnerStep();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    expect(await screen.findByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('lets the field go blank while editing, instead of snapping back on every keystroke', async () => {
    // Regression test for the actual reported bug: clearing "1" before
    // typing "2" used to clamp straight back to 1 on the empty
    // intermediate state, so the field could never actually change.
    await goToOwnerStep();
    const spinbutton = screen.getByRole('spinbutton');
    fireEvent.change(spinbutton, { target: { value: '1' } });
    expect(spinbutton).toHaveValue(1);
    fireEvent.change(spinbutton, { target: { value: '' } }); // simulates backspacing to clear
    expect(spinbutton).toHaveValue(null); // genuinely blank, not reverted to 1
    fireEvent.change(spinbutton, { target: { value: '2' } });
    expect(spinbutton).toHaveValue(2);
  });

  test('blank Number of Dogs reverts to the last committed count on blur', async () => {
    await goToOwnerStep();
    const spinbutton = screen.getByRole('spinbutton');
    fireEvent.change(spinbutton, { target: { value: '3' } });
    fireEvent.change(spinbutton, { target: { value: '' } });
    fireEvent.blur(spinbutton);
    expect(spinbutton).toHaveValue(3);
  });

  test('looks up a returning client by phone and autofills name/email', async () => {
    supabase.functions.invoke.mockResolvedValueOnce({
      data: { found: true, client: { owner_name: 'Found Person', owner_email: 'found@test.com' } },
      error: null,
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    expect(await screen.findByText(/Info found/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Found Person');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('found@test.com');
    expect(supabase.functions.invoke).toHaveBeenCalledWith('lookup-client', { body: { phone: '4155550100' } });
  });

  test('the same lookup also autofills the vet and dog profile, visible once advanced to Dog 1', async () => {
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

    fireEvent.click(screen.getByText('Continue'));
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
    expect(screen.getByRole('spinbutton')).toHaveValue(2); // count grew to match, not left at 1
    // this mock's client has no owner_name/owner_email - fill those
    // manually so Continue's own validation isn't what's under test here
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    // lookup-client never returns aggression/health (re-confirmed fresh
    // each stay, not carried forward) - still required to advance
    let selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'no' } });
    fireEvent.change(selects[2], { target: { value: 'no' } });
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Dog 2');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Fido');
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
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  test('handles an entirely empty lookup record without crashing', async () => {
    // real records can have gaps (e.g. an older submission missing every
    // field) - the `field || ''` fallbacks exist for exactly this case, so
    // controlled inputs never receive null/undefined
    supabase.functions.invoke.mockResolvedValueOnce({ data: { found: true, client: {} }, error: null });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('');
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(0);
  });
});

// ── Dog pages ────────────────────────────────────────────────────────────────
describe('Dog pages', () => {
  test('shows required errors (including the aggression/health warning) when submitting an empty dog form', async () => {
    await fillStep1();
    fireEvent.click(screen.getByText('Continue'));
    // name, breed, dob, spayNeuter
    expect(await screen.findAllByText('Required')).toHaveLength(4);
    // aggressionHistory, healthConcerns - previously silent even though
    // required; now warn the user so they know to fill them in
    expect(screen.getAllByText('Please select an answer')).toHaveLength(2);
  });

  test('warns independently - answering one still warns about the other', async () => {
    await fillStep1();
    await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
    await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), 'Labrador');
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2020-01-01' } });
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
    fireEvent.change(selects[2], { target: { value: 'no' } });  // health answered, aggression left blank
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Please select an answer')).toHaveLength(1);
  });

  test('calculates age from DOB', async () => {
    await fillStep1();
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: isoMonthsAgo(36) } });
    expect(await screen.findByText('Age: 3 years')).toBeInTheDocument();
  });

  test('reveals the aggression detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'yes' } }); // aggression
    const detail = await screen.findByPlaceholderText(/known triggers/);
    await userEvent.type(detail, 'Growls at squirrels');
    expect(detail).toHaveValue('Growls at squirrels');
  });

  test('reveals the health detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[2], { target: { value: 'yes' } }); // health
    const detail = await screen.findByPlaceholderText(/conditions, limitations/);
    await userEvent.type(detail, 'Mild arthritis');
    expect(detail).toHaveValue('Mild arthritis');
  });

  test('Back returns to Step 1 with owner info preserved', async () => {
    await fillStep1('4155550100', 'Kim Miller', 'kim@test.com');
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Kim Miller');
  });

  test('a 2nd dog gets its own page, titled "Dog 2"', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    expect(await screen.findByText('Dog 2')).toBeInTheDocument();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
    // dog 1's data isn't lost - just off-screen, verified via a later test
    // that submits a 2-dog booking and checks both dogs made it to the
    // payload (see Step 5 - Signature)
  });

  test('Back from Dog 2 returns to Dog 1 with its data preserved', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    await screen.findByText('Dog 2');
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Dog 1')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
  });
});

// ── Step 3: Stay Dates ───────────────────────────────────────────────────────
describe('Step 3 — Stay Dates', () => {
  test('shows required errors when submitting empty dates form', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(4);
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

  test('shows an estimated cost once valid dates/times are entered', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-03' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(await screen.findByText('$210.00')).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });
    await screen.findByText('Stay Dates');

    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-02' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    // 1 night @ $105: dog 1 = $105, dog 2 = $105 * 0.9 = $94.50 -> $199.50
    expect(await screen.findByText('$199.50')).toBeInTheDocument();
    expect(screen.getByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('Back returns to Dog 1', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Dog 1')).toBeInTheDocument();
  });
});

// ── Step 5: Signature & Submission ──────────────────────────────────────────
describe('Step 5 — Signature', () => {
  test('requires checkbox before submitting', async () => {
    await fillThrough();
    fireEvent.click(screen.getByText('Submit Agreement'));
    expect(await screen.findByText(/must check this box/i)).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });
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

  test('accepts the correct password and shows the stay list', async () => {
    await loginAsAdmin();
    expect(screen.getByText('3 signed agreements on file')).toBeInTheDocument();
    expect(screen.getByText('Bud')).toBeInTheDocument();
    expect(screen.getByText('Choco')).toBeInTheDocument();
  });

  test('shows the singular label for exactly one record', async () => {
    await loginAsAdmin([{ ...SAMPLE_DOGS[0], stays: [SAMPLE_DOGS[0].stays[0]] }], 1);
    expect(screen.getByText('1 signed agreement on file')).toBeInTheDocument();
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

  test('has no visible Admin button anywhere in the normal booking flow', async () => {
    render(<App />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Book My Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});

// ── Admin: logged in ─────────────────────────────────────────────────────────
describe('Admin — logged in', () => {
  test('filters the dog list by search term', async () => {
    await loginAsAdmin();
    await userEvent.type(screen.getByPlaceholderText('Search by dog or owner name...'), 'Bud');
    expect(screen.getByText('Bud')).toBeInTheDocument();
    expect(screen.queryByText('Choco')).not.toBeInTheDocument();
  });

  test('close button closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByText('Bayview Boarding — Admin')).not.toBeInTheDocument();
  });

  test('selecting a dog shows its full stay history, including flags and notes', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    expect(await screen.findByRole('heading', { name: 'Bud' })).toBeInTheDocument();
    // owner name shares a line with the dog's current breed/age, so this
    // is a partial match rather than the line's full text
    expect(screen.getByText(/Kim/)).toBeInTheDocument();
    expect(screen.getByText('Est. $210')).toBeInTheDocument();
    expect(screen.getByText(/Loves belly rubs/)).toBeInTheDocument();
    expect(screen.getByText(/DOB:/)).toBeInTheDocument();

    // Bud has 2 stays (Sept + June) — most recent check-in sorts first
    const budCards = document.querySelectorAll('.stay-card');
    expect(budCards).toHaveLength(2);
    expect(budCards[0].textContent).toContain('09/01/2026');
    expect(budCards[1].textContent).toContain('06/01/2026');

    fireEvent.click(screen.getByText(/All Dogs/));
    fireEvent.click(screen.getByText('Choco'));
    expect(await screen.findByRole('heading', { name: 'Choco' })).toBeInTheDocument();
    expect(screen.getByText(/Aggression noted: Barks at mail carrier/)).toBeInTheDocument();
    expect(screen.getByText(/Health note: Mild hip dysplasia/)).toBeInTheDocument();
  });

  test('back button returns from the detail view to the dog list', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });
    fireEvent.click(screen.getByText(/All Dogs/));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });

  test('close button in the detail view closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByRole('heading', { name: 'Bud' })).not.toBeInTheDocument();
  });

  test('updates and displays the day rate after Save', async () => {
    await loginAsAdmin();
    const rateInput = document.querySelector('input[type="number"]');
    fireEvent.change(rateInput, { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/Current rate: \$150\/day/)).toBeInTheDocument();
  });
});
