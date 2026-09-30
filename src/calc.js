// Pure calculation/formatting helpers - no React, no JSX. Split out of
// App.js (Sept 30, 2026, on request - code-splitting for mobile
// PageSpeed) so both the lazy-loaded BookingFlow.js and AdminPanel.js
// chunks can import just this shared logic without pulling in the
// other's component code (or App.js's own top-level orchestration)
// along with it. Also directly unit-tested (see App.test.js's
// `describe('calcCost'...)` etc. blocks) - a plain, dependency-free
// module makes that straightforward.
import { DEFAULT_MULTI_DOG_DISCOUNT, DEFAULT_HOLIDAY_UPCHARGE, DEFAULT_MINIMUM_STAY } from './defaults';

export function vetDropdownOptions(vets) {
  return ['Select a Vet', ...vets, 'Other — see notes'];
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// Rounds to the nearest whole dollar (ties round up - same as Math.round
// for a positive amount) and adds thousands commas - no cents anywhere
// (Sept 18, 2026, on request: "drop cents on all dollar amounts,
// rounding up at .5 dollars" - previously this just added commas while
// preserving whatever decimal form the caller already had).
export function formatMoney(amount) {
  if (amount === null || amount === undefined || amount === '') return amount;
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return Math.round(n).toLocaleString('en-US');
}

// Always one decimal place (Sept 18, 2026, on request) - e.g. "1.5", "0.3",
// "2.0" - so a fractional day reads clearly as a fraction everywhere the
// math is shown, rather than trimming a whole day down to "2".
export function formatDays(n) {
  return n.toFixed(1);
}

// NOT `new Date().toISOString().slice(0,10)` - toISOString() is always
// UTC. In the evening Pacific time (after ~5pm PDT / 4pm PST), UTC has
// already rolled to tomorrow, so that would compute "today" as tomorrow -
// making the actual local today (and the date-picker's min) reject a
// check-in of today, and make an already-chosen near date look like it's
// "in the past" when you go back to edit it. Use local calendar fields
// instead (see isoFromLocalDate).
export function todayISO() {
  return isoFromLocalDate(new Date());
}

export function calcAge(dob) {
  if (!dob) return '';
  const today = new Date();
  const birth = new Date(dob);
  const years = today.getFullYear() - birth.getFullYear();
  const months = today.getMonth() - birth.getMonth();
  const totalMonths = years * 12 + months;
  if (totalMonths < 12) return `${totalMonths} month${totalMonths !== 1 ? 's' : ''}`;
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  return m > 0 ? `${y} yr ${m} mo` : `${y} year${y !== 1 ? 's' : ''}`;
}

export function isoFromLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// nth weekday of a given month (weekday: 0=Sun..6=Sat, n: 1st/2nd/3rd/4th...)
export function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(year, month, 1);
  let count = 0;
  while (true) {
    if (d.getDay() === weekday) {
      count++;
      if (count === n) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
}

export function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

// Computes every holiday-upcharge date window for a given year, as
// [startISO, endISO] pairs (inclusive). Algorithmic (not hardcoded dates)
// so it doesn't need yearly maintenance. See FIXES.txt item 7 for the list.
export function getHolidayWindows(year) {
  const windows = [];
  const single = (date) => windows.push([isoFromLocalDate(date), isoFromLocalDate(date)]);

  single(new Date(year, 0, 1));                       // New Year's Day
  single(nthWeekdayOfMonth(year, 0, 1, 3));            // MLK Day - 3rd Monday of January

  // Presidents' Day / Ski Week - the week containing the 3rd Monday of
  // February, plus the Sat-Sun weekends immediately surrounding it.
  const presidentsDay = nthWeekdayOfMonth(year, 1, 1, 3);
  windows.push([
    isoFromLocalDate(addDays(presidentsDay, -2)), // Saturday before
    isoFromLocalDate(addDays(presidentsDay, 6)),  // Sunday after
  ]);

  single(lastWeekdayOfMonth(year, 4, 1));              // Memorial Day - last Monday of May
  single(new Date(year, 6, 4));                        // July 4th
  single(nthWeekdayOfMonth(year, 8, 1, 1));            // Labor Day - 1st Monday of September

  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  windows.push([isoFromLocalDate(thanksgiving), isoFromLocalDate(addDays(thanksgiving, 1))]); // + day after

  single(new Date(year, 11, 25));                      // Christmas
  single(new Date(year, 11, 31));                      // New Year's Eve

  return windows;
}

// Whether a given calendar night (YYYY-MM-DD) falls inside a holiday window.
export function isHolidayNight(dateISO) {
  const year = Number(dateISO.slice(0, 4));
  return getHolidayWindows(year).some(([start, end]) => dateISO >= start && dateISO <= end);
}

// numberOfDogs: additional dogs beyond the first are each charged at
// (1 - multiDogDiscount) of that day's per-dog rate, uncapped. Holiday
// nights (see getHolidayWindows) upcharge the base rate by
// holidayUpcharge before the multi-dog discount is applied, so the
// discount always tracks the actual (possibly holiday) rate. Both are
// admin-configurable (see the settings table) - the parameter defaults
// here are only a fallback for direct/pure-function callers.
//
// Billed fractionally, down to the actual fraction of a day (Sept 18,
// 2026, on request - previously rounded every partial day UP to a full
// day via Math.ceil, with a 1-day minimum even for a same-day stay of a
// few hours). A stay of exactly N whole days still bills N full days;
// anything in between bills the exact fraction (e.g. 36 hours = 1.5
// days = 1.5x the daily rate) - EXCEPT the stay is shorter than
// minimumStay, in which case it's billed as exactly minimumStay days,
// no more (Sept 24, 2026, on request from Estee via Submit Idea: "24
// hour minimum needs updating. It's now prorating for less than 24
// hour stay" - the Sept 18 change above removed a minimum entirely
// rather than actually leaving one properly in place, so a 6-hour
// same-day stay was billing at 25% of a full day's rate with nothing
// to catch it). This is deliberately a FLOOR on the total, not the old
// Sept 18 behavior of rounding every partial day up - a 30-hour stay
// still bills 1.25 days, not 2, when minimumStay is 1.
export function calcCostBreakdown(
  checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs = 1,
  multiDogDiscount = DEFAULT_MULTI_DOG_DISCOUNT, holidayUpcharge = DEFAULT_HOLIDAY_UPCHARGE,
  minimumStay = DEFAULT_MINIMUM_STAY
) {
  if (!checkIn || !checkOut || !dropTime || !pickupTime) return null;
  const drop = new Date(`${checkIn}T${dropTime}`);
  const pickup = new Date(`${checkOut}T${pickupTime}`);
  const hours = (pickup - drop) / 3600000;
  if (hours <= 0) return null;
  const nights = Math.max(hours / 24, minimumStay); // fractional number of days billed, floored at minimumStay
  // Float-safe: an exact multiple of 24h (e.g. 48.00000000000001 due to
  // DST-free millisecond math) must still count as whole days, not spill
  // a near-zero fraction into an extra billed day.
  const fullDays = Math.round(nights * 1e6) % 1e6 === 0 ? Math.round(nights) : Math.floor(nights);
  const remainder = nights - fullDays;
  const dayCount = remainder > 1e-9 ? fullDays + 1 : fullDays;
  const dogs = Math.max(1, Number(numberOfDogs) || 1);
  const perNightDogMultiplier = 1 + (dogs - 1) * (1 - multiDogDiscount);

  const [y, m, d] = checkIn.split('-').map(Number);
  let holidayNights = 0;
  let subtotal = 0;
  let holidayExtra = 0;
  for (let i = 0; i < dayCount; i++) {
    const fraction = i < fullDays ? 1 : remainder;
    const nightISO = isoFromLocalDate(new Date(y, m - 1, d + i));
    subtotal += rate * perNightDogMultiplier * fraction;
    if (isHolidayNight(nightISO)) {
      holidayNights += fraction;
      holidayExtra += rate * holidayUpcharge * perNightDogMultiplier * fraction;
    }
  }
  // Split out of subtotal (not summed separately in the loop above) so the
  // UI can show "1st dog" and "additional dogs" as their own line items -
  // exact by construction: firstDogSubtotal + additionalDogsSubtotal ===
  // subtotal, since perNightDogMultiplier is constant across every night.
  const firstDogSubtotal = rate * nights;
  const additionalDogsSubtotal = subtotal - firstDogSubtotal;
  return {
    nights, holidayNights, dogs, rate, holidayUpcharge, perNightDogMultiplier,
    firstDogSubtotal, additionalDogsSubtotal, subtotal, holidayExtra, total: subtotal + holidayExtra,
  };
}

// Same math as calcCostBreakdown, just the final total - kept as a
// separate export since most call sites only need the number.
export function calcCost(
  checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs = 1,
  multiDogDiscount = DEFAULT_MULTI_DOG_DISCOUNT, holidayUpcharge = DEFAULT_HOLIDAY_UPCHARGE,
  minimumStay = DEFAULT_MINIMUM_STAY
) {
  const breakdown = calcCostBreakdown(checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs, multiDogDiscount, holidayUpcharge, minimumStay);
  return breakdown ? breakdown.total.toFixed(2) : null;
}

// Plain-text equivalent of <CostBreakdown> (src/CostBreakdown.js) - kept
// in sync by hand (same reasoning as dogIsComplete/StepDogPage's
// getErrors: small enough that sharing a single implementation across
// JSX and plain text wasn't worth the indirection), embedded directly in
// the outbound billing SMS itself (Sept 19, 2026, on request: "text
// should show full billing math that makes up the total", not just
// admin's own on-screen display). Deliberately omits the final
// "= $total" line - the SMS states the total separately (via
// {finalCost}), which can differ from this calculated total if admin
// hand-adjusted the amount after Recalculate, and showing two
// potentially-different totals would be more confusing than showing one.
export function formatCostBreakdownText(breakdown, multiDogDiscount) {
  if (!breakdown) return '';
  const days = formatDays(breakdown.nights);
  const additionalDogs = breakdown.dogs - 1;
  const lines = [
    `$${formatMoney(breakdown.rate)}/day × ${days} day${breakdown.nights !== 1 ? 's' : ''} × 1st dog = $${formatMoney(breakdown.firstDogSubtotal)}`,
  ];
  if (additionalDogs > 0) {
    lines.push(`$${formatMoney(breakdown.rate)}/day × ${days} day${breakdown.nights !== 1 ? 's' : ''} × ${additionalDogs} additional dog${additionalDogs !== 1 ? 's' : ''} × ${100 - multiDogDiscount * 100}% (${multiDogDiscount * 100}% off each) = $${formatMoney(breakdown.additionalDogsSubtotal)}`);
  }
  if (breakdown.holidayNights > 0) {
    lines.push(`+ Holiday upcharge: ${formatDays(breakdown.holidayNights)} day${breakdown.holidayNights !== 1 ? 's' : ''} × ${breakdown.holidayUpcharge * 100}% = $${formatMoney(breakdown.holidayExtra)}`);
  }
  return lines.join('\n');
}

export function emptyDog() {
  return {
    name: '', breed: '', dob: '', spayNeuter: '',
    aggressionHistory: '', aggressionDetail: '',
    healthConcerns: '', healthDetail: '',
    // Any number of photos (Sept 21, 2026, multiple since Sept 22,
    // 2026), each tracking its own upload lifecycle - path (the
    // dog-photos Edge Function's Storage path once uploaded),
    // previewUrl (a local createObjectURL blob, shown immediately and
    // kept around so re-opening this dog's Edit page later in the same
    // session still shows a thumbnail - the bucket is private, so
    // there's no signed URL a booking-form visitor could re-fetch),
    // uploading, and error. Lives on the dog itself, not StepDogPage's
    // own component state, so it survives the owner navigating to a
    // different dog's page and back (StepDogPage remounts between
    // dogs). Optional, never required to advance (see dogIsComplete
    // below, deliberately unchanged).
    photos: [],
  };
}

// Same required fields as StepDogPage's own getErrors() - kept in sync by
// hand (small enough that a shared helper would need passing the whole
// errors shape back and forth for little benefit). Used by StepOwner to
// know which dogs still need attention before Continue can advance past
// the owner page at all (Sept 17, 2026 - dog editing moved off a forced
// sequential per-dog flow and onto this "Edit" list instead).
export function dogIsComplete(dog) {
  return !!(dog.name.trim() && dog.breed.trim() && dog.dob && dog.spayNeuter && dog.aggressionHistory && dog.healthConcerns);
}
