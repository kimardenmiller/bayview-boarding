import React, { useState, useEffect, useRef } from 'react';
import { WAIVER_SECTIONS } from './waiver';
import { supabase } from './supabase';
import { SETTINGS } from './settings';
import heroDog from './img/hero-dog.jpg';
import './App.css';

// Fallback defaults, used until the `settings` Edge Function's response
// loads (App's useEffect below) and as calcCost's own parameter defaults
// for direct/pure-function callers (e.g. existing tests). The live,
// admin-configurable values come from Supabase - see the settings table
// migration and supabase/functions/settings/index.ts.
const DEFAULT_RATE = SETTINGS.DEFAULT_DAY_RATE;
const DEFAULT_MINIMUM_STAY = SETTINGS.DEFAULT_MINIMUM_STAY;
const DEFAULT_MULTI_DOG_DISCOUNT = SETTINGS.MULTI_DOG_DISCOUNT;
const DEFAULT_HOLIDAY_UPCHARGE = SETTINGS.HOLIDAY_UPCHARGE;
// The editable vet clinic list, without the structural placeholder/"Other"
// entries the app always adds itself (see vetDropdownOptions).
const DEFAULT_VETS = SETTINGS.SAN_RAFAEL_VETS.slice(1, -1);
const DEFAULT_PACKING_LIST = SETTINGS.PACKING_LIST;
const DEFAULT_SMS_TEMPLATES = {
  confirmation: SETTINGS.SMS_CONFIRMATION,
  reminder: SETTINGS.SMS_REMINDER,
  billing: SETTINGS.SMS_BILLING,
  pickupReminder: SETTINGS.SMS_PICKUP_REMINDER,
  requestReceived: SETTINGS.SMS_REQUEST_RECEIVED,
  denied: SETTINGS.SMS_DENIED,
};
const DEFAULT_SMS_FOOTER = SETTINGS.SMS_FOOTER;

// "On List" = promoted into FIXES.txt's NEXT CHANGE LIST; "Rejected" =
// decided not to do it - both set manually by admin from this list, same
// as "Done" already was (Sept 18, 2026, on request; "On List" replaces
// the old "Considered").
const FEEDBACK_STATUSES = [
  { key: 'open', label: 'Open' },
  { key: 'on_list', label: 'On List' },
  { key: 'done', label: 'Done' },
  { key: 'rejected', label: 'Rejected' },
];

// Suggested starting text for the admin "Testers" broadcast box (Sept 17,
// 2026), admin-editable and persisted since Sept 19, 2026 (see settings'
// default_broadcast_message column/migration and saveBroadcastDefault
// below) - this constant is now only the FALLBACK, used before the
// admin-authenticated settings fetch resolves at login, same role
// DEFAULT_SMS_TEMPLATES/DEFAULT_SMS_FOOTER already play above. Points at
// the staging sandbox (not production) since Sept 19, 2026, once that
// environment existed for testers to freely book/add dogs/etc. in
// without touching real client data - kept in sync with the migration's
// own default wording. Distinct from "Hi {name}, " which the server
// prepends per-recipient using each tester's own name, not something
// typed here at all.
const DEFAULT_BROADCAST_MESSAGE =
  "We've made a few changes to the Bayview Boarding site below. Please have a look and tell us what you think!\n" +
  'https://bayviewboarding.com/staging\n' +
  'This is our testing sandbox - feel free to make bookings, add dogs, and try anything. None of it touches real client data.\n' +
  'Then just tap the (☰) menu and choose "Submit Idea" to share your feedback with us.';

function vetDropdownOptions(vets) {
  return ['Select a Vet', ...vets, 'Other — see notes'];
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// Rounds to the nearest whole dollar (ties round up - same as Math.round
// for a positive amount) and adds thousands commas - no cents anywhere
// (Sept 18, 2026, on request: "drop cents on all dollar amounts,
// rounding up at .5 dollars" - previously this just added commas while
// preserving whatever decimal form the caller already had).
function formatMoney(amount) {
  if (amount === null || amount === undefined || amount === '') return amount;
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return Math.round(n).toLocaleString('en-US');
}

// Always one decimal place (Sept 18, 2026, on request) - e.g. "1.5", "0.3",
// "2.0" - so a fractional day reads clearly as a fraction everywhere the
// math is shown, rather than trimming a whole day down to "2".
function formatDays(n) {
  return n.toFixed(1);
}

// NOT `new Date().toISOString().slice(0,10)` - toISOString() is always
// UTC. In the evening Pacific time (after ~5pm PDT / 4pm PST), UTC has
// already rolled to tomorrow, so that would compute "today" as tomorrow -
// making the actual local today (and the date-picker's min) reject a
// check-in of today, and make an already-chosen near date look like it's
// "in the past" when you go back to edit it. Use local calendar fields
// instead (see isoFromLocalDate).
function todayISO() {
  return isoFromLocalDate(new Date());
}

function calcAge(dob) {
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

function isoFromLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// nth weekday of a given month (weekday: 0=Sun..6=Sat, n: 1st/2nd/3rd/4th...)
function nthWeekdayOfMonth(year, month, weekday, n) {
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

function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

// Computes every holiday-upcharge date window for a given year, as
// [startISO, endISO] pairs (inclusive). Algorithmic (not hardcoded dates)
// so it doesn't need yearly maintenance. See FIXES.txt item 7 for the list.
function getHolidayWindows(year) {
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
function isHolidayNight(dateISO) {
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
function calcCostBreakdown(
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
function calcCost(
  checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs = 1,
  multiDogDiscount = DEFAULT_MULTI_DOG_DISCOUNT, holidayUpcharge = DEFAULT_HOLIDAY_UPCHARGE,
  minimumStay = DEFAULT_MINIMUM_STAY
) {
  const breakdown = calcCostBreakdown(checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs, multiDogDiscount, holidayUpcharge, minimumStay);
  return breakdown ? breakdown.total.toFixed(2) : null;
}

// Named exports alongside the default App export, purely so pure helper
// functions can be unit-tested directly instead of only through full
// multi-step form flows. No behavior change.
export { formatDate, calcAge, calcCost, calcCostBreakdown, formatCostBreakdownText, isHolidayNight, getHolidayWindows, todayISO, formatMoney, vetDropdownOptions };

function Header({ onTitleClick }) {
  return (
    <header className="header">
      <div className="header-inner">
        <button className="wordmark wordmark--link" onClick={onTitleClick}>Bayview Boarding</button>
        <div className="header-sub">San Rafael, California</div>
      </div>
    </header>
  );
}

// Step count is dynamic: Owner + one page per dog + Dates + Agreement +
// Sign, so the labels/total must be computed from numberOfDogs rather
// than hardcoded.
// Fixed 4-step model (Sept 17, 2026 - dog pages moved off the top-level
// wizard entirely and into an "Edit" sub-view launched from the owner
// page's dog list, so they no longer add their own steps here).
function Progress({ step }) {
  const labels = ['Your Info', 'Stay Dates', 'Agreement', 'Sign'];
  const total = labels.length;
  return (
    <div className="progress-wrap">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${(step / (total - 1)) * 100}%` }} />
      </div>
      <div className="progress-label">{labels[step]} — Step {step + 1} of {total}</div>
    </div>
  );
}

function Field({ label, error, children, hint }) {
  return (
    <div className={`field${error ? ' field--error' : ''}`}>
      <label className="field-label">{label}</label>
      {hint && <div className="field-hint">{hint}</div>}
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

function emptyDog() {
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
function dogIsComplete(dog) {
  return !!(dog.name.trim() && dog.breed.trim() && dog.dob && dog.spayNeuter && dog.aggressionHistory && dog.healthConcerns);
}

// Owner info, the vet, and "Number of Dogs" are all asked once per
// booking here (Sept 14 scope decision, moved off the dog page Sept 15)
// - a returning-client lookup on this page autofills all of it, plus
// every known dog's own profile, growing the dog-page count to match.
function StepOwner({ data, onChange, onNext, vetOptions, multiDogDiscount }) {
  const [errors, setErrors] = useState({});
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState(false);
  // Set while a dog's own page is open in place of the owner page's usual
  // JSX (Sept 17, 2026 - dog editing moved off a forced sequential per-dog
  // flow and onto this "Edit" list instead, so Continue here can go
  // straight to Stay Dates once every dog on the list is complete).
  const [editingDogIndex, setEditingDogIndex] = useState(null);

  async function lookupPhone() {
    if (!data.ownerPhone.trim()) return;
    setLooking(true);
    const { data: result } = await supabase.functions.invoke('lookup-client', {
      body: { phone: data.ownerPhone.trim() },
    });
    if (result?.found) {
      const r = result.client;
      onChange('ownerName', r.owner_name || '');
      onChange('ownerEmail', r.owner_email || '');
      if (r.vet_name) onChange('vetName', r.vet_name);
      if (r.dogs && r.dogs.length > 0) {
        // Grow the dog-page count to match every known dog, not just slot
        // 0 - a returning owner with 2 dogs on file should see both
        // prefilled without having to know to bump "Number of Dogs" first.
        const base = data.dogs.slice(0, Math.max(data.dogs.length, r.dogs.length));
        while (base.length < r.dogs.length) base.push(emptyDog());
        onChange('dogs', base.map((dog, i) => {
          const rd = r.dogs[i];
          if (!rd) return dog;
          return {
            ...dog,
            name: rd.dog_name || dog.name,
            breed: rd.dog_breed || dog.breed,
            dob: rd.dog_dob || dog.dob,
            spayNeuter: rd.spay_neuter || dog.spayNeuter,
          };
        }));
      }
      setFound(true);
    } else {
      setFound(false);
    }
    setLooking(false);
  }

  // "Add Dog" / delete (Sept 17, 2026 - replaced the old "Number of Dogs"
  // number input entirely). Always keeps at least one dog - removeDog is
  // a no-op at length 1, and the Delete button itself is hidden then, so
  // dogs.length can never reach 0 and there's no longer a "must be at
  // least 1" error state to report. A newly added dog opens straight into
  // its own edit page, same as clicking Edit on an existing one.
  function addDog() {
    onChange('dogs', [...data.dogs, emptyDog()]);
    setEditingDogIndex(data.dogs.length);
  }

  function removeDog(index) {
    if (data.dogs.length <= 1) return;
    onChange('dogs', data.dogs.filter((_, i) => i !== index));
  }

  // Pure - no state writes - so it can also drive the Continue button's
  // disabled state on every render, not just report errors after a click.
  function getErrors() {
    const e = {};
    if (!data.ownerPhone.trim()) e.ownerPhone = 'Required';
    if (!data.ownerName.trim()) e.ownerName = 'Required';
    if (!data.ownerEmail.trim()) e.ownerEmail = 'Required';
    if (!data.vetName || data.vetName === 'Select a Vet') e.vetName = 'Required';
    if (!data.dogs.every(dogIsComplete)) e.dogs = 'Every dog needs its full profile filled in - click Edit on each one below.';
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const canContinue = Object.keys(getErrors()).length === 0;

  if (editingDogIndex !== null) {
    return (
      <StepDogPage
        data={data}
        onChange={onChange}
        index={editingDogIndex}
        onNext={() => setEditingDogIndex(null)}
        onBack={() => setEditingDogIndex(null)}
      />
    );
  }

  return (
    <div className="step">
      {/* Moved here from the landing page (Sept 21, 2026, on request) -
          the actual booking page, right above the first field, is where
          this matters most. */}
      <p className="request-notice">
        You are entering a non-binding booking request that will be reviewed and confirmed,
        usually within a few hours, always within 24 hours. In the event we need to turn down
        your request we'll explain why.
      </p>
      <h2 className="step-title">Owner Information</h2>
      <p className="step-intro">
        First time boarding with us? Fill out your info below, then click
        Edit on each dog to fill out their profile — we ask everything up
        front so nothing's missing when you drop off.
      </p>
      <Field label="Phone Number" hint="Returning client? Enter your number and click Look up to auto-fill." error={errors.ownerPhone}>
        <div className="email-row">
          <input value={data.ownerPhone} onChange={e => onChange('ownerPhone', e.target.value)} placeholder="(415) 555-0100" type="tel" />
          <button className="btn-secondary" onClick={lookupPhone} style={{ whiteSpace: 'nowrap', padding: '10px 14px' }}>
            {looking ? '...' : 'Look up'}
          </button>
        </div>
        {found && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>✓ Info found — please review below</div>}
      </Field>
      <Field label="Your Full Name" error={errors.ownerName}>
        <input value={data.ownerName} onChange={e => onChange('ownerName', e.target.value)} placeholder="Jane Smith" />
      </Field>
      <Field label="Email Address" error={errors.ownerEmail}>
        <input value={data.ownerEmail} onChange={e => onChange('ownerEmail', e.target.value)} placeholder="jane@email.com" type="email" />
      </Field>
      <Field label="Veterinarian" error={errors.vetName}>
        <select value={data.vetName} onChange={e => onChange('vetName', e.target.value)}>
          {vetOptions.map((v, i) => <option key={i} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Dogs" error={errors.dogs}>
        <div className="dog-count-list">
          {data.dogs.map((dog, i) => (
            <div className="dog-count-row" key={i}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{dog.name.trim() || `Dog ${i + 1}`}</span>
                {!dogIsComplete(dog) && <span className="dog-needs-updating">Needs updating</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn-secondary" onClick={() => setEditingDogIndex(i)}>Edit</button>
                {data.dogs.length > 1 && (
                  <button type="button" className="btn-secondary" onClick={() => removeDog(i)}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary" onClick={addDog}>+ Add Dog</button>
        {data.dogs.length > 1 && (
          <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 8 }}>
            {multiDogDiscount * 100}% off each additional dog's nightly rate.
          </div>
        )}
      </Field>
      <div className="step-actions">
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!canContinue}>Continue</button>
      </div>
    </div>
  );
}

// One page per dog, titled "Dog 1", "Dog 2", etc. - `index` picks which
// entry of data.dogs this page edits. Vet and dog count live on the
// owner page now (see StepOwner); only per-dog fields live here.
function StepDogPage({ data, onChange, index, onNext, onBack }) {
  const [errors, setErrors] = useState({});
  const dog = data.dogs[index];
  const age = calcAge(dog.dob);

  function updateDog(field, value) {
    onChange('dogs', data.dogs.map((d, i) => i === index ? { ...d, [field]: value } : d));
  }

  // Any number of photos (Sept 21, 2026, on request; multiple since
  // Sept 22, 2026, also on request) - never blocks Continue either way,
  // whether an upload is still in flight or fails outright (see
  // dogIsComplete/getErrors below, deliberately unchanged). Each
  // selected file gets an instant local preview (createObjectURL),
  // independent of its own upload actually finishing - no need to wait
  // on a signed URL just to show the owner their own just-picked files
  // (the bucket is private anyway, so there's no signed URL to fetch
  // even after upload completes), and it works even if the upload
  // itself fails. Files upload one at a time (not in parallel) so each
  // one's own updateDog call sees the previous one's result already
  // applied, rather than racing on this closure's now-stale `dog.photos`.
  async function handlePhotoChange(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    let photos = dog.photos.concat(files.map(file => ({
      path: null, previewUrl: URL.createObjectURL(file), uploading: true, error: null,
    })));
    const startAt = dog.photos.length;
    updateDog('photos', photos);

    for (let i = 0; i < files.length; i++) {
      const form = new FormData();
      form.append('file', files[i]);
      const { data: result, error: fnError } = await supabase.functions.invoke('dog-photos', { body: form });
      const failed = fnError || result?.error;
      photos = photos.map((p, j) => j !== startAt + i ? p : {
        ...p, uploading: false,
        path: failed ? null : result.path,
        error: failed ? "Couldn't upload this photo." : null,
      });
      updateDog('photos', photos);
    }
  }

  function removePhoto(i) {
    updateDog('photos', dog.photos.filter((_, j) => j !== i));
  }

  function getErrors() {
    const e = {};
    if (!dog.name.trim()) e.name = 'Required';
    if (!dog.breed.trim()) e.breed = 'Required';
    if (!dog.dob) e.dob = 'Required';
    if (!dog.spayNeuter) e.spayNeuter = 'Required';
    if (!dog.aggressionHistory) e.aggressionHistory = 'Please select an answer';
    if (!dog.healthConcerns) e.healthConcerns = 'Please select an answer';
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const canContinue = Object.keys(getErrors()).length === 0;

  return (
    <div className="step">
      <h2 className="step-title">Dog {index + 1}</h2>
      <Field label="Dog's Name" error={errors.name}>
        <input value={dog.name} onChange={e => updateDog('name', e.target.value)} placeholder="Buddy" />
      </Field>
      <Field label="Photos (optional)">
        {dog.photos.length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {dog.photos.map((p, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img
                  src={p.previewUrl}
                  alt={`${dog.name || 'Dog'}'s photo ${i + 1}`}
                  className="dog-photo-thumb dog-photo-thumb--lg"
                  style={{ opacity: p.uploading ? 0.6 : 1 }}
                />
                <button
                  type="button"
                  aria-label={`Remove photo ${i + 1}`}
                  onClick={() => removePhoto(i)}
                  style={{ position: 'absolute', top: -7, right: -7, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#C0392B', color: '#fff', fontSize: '0.72rem', lineHeight: '20px', padding: 0, cursor: 'pointer' }}
                >×</button>
                {p.uploading && <div style={{ fontSize: '0.7rem', color: '#6B7A8A', marginTop: 2 }}>Uploading...</div>}
                {p.error && <div className="field-error" style={{ fontSize: '0.72rem', marginTop: 2 }}>{p.error}</div>}
              </div>
            ))}
          </div>
        )}
        <input type="file" accept="image/*" multiple aria-label="Photos (optional)" onChange={handlePhotoChange} />
      </Field>
      <Field label="Breed" error={errors.breed}>
        <input value={dog.breed} onChange={e => updateDog('breed', e.target.value)} placeholder="Golden Retriever" />
      </Field>
      <Field label="Date of Birth" error={errors.dob}>
        <input type="date" value={dog.dob} max={todayISO()} onChange={e => updateDog('dob', e.target.value)} />
        {age && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>Age: {age}</div>}
      </Field>
      <Field label="Spayed / Neutered?" error={errors.spayNeuter}>
        <select value={dog.spayNeuter} onChange={e => updateDog('spayNeuter', e.target.value)}>
          <option value="">Select one</option>
          <option value="yes">Yes</option>
          <option value="no">No (over 1 year)</option>
          <option value="under1">Not yet (under 1 year)</option>
        </select>
      </Field>
      <Field label="Any aggression history toward people or dogs?" error={errors.aggressionHistory}>
        <select value={dog.aggressionHistory} onChange={e => updateDog('aggressionHistory', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.aggressionHistory === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.aggressionDetail} onChange={e => updateDog('aggressionDetail', e.target.value)} rows={3} placeholder="Describe any known triggers or incidents" />
        </Field>
      )}
      <Field label="Any health conditions or heat sensitivity?" error={errors.healthConcerns}>
        <select value={dog.healthConcerns} onChange={e => updateDog('healthConcerns', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.healthConcerns === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.healthDetail} onChange={e => updateDog('healthDetail', e.target.value)} rows={3} placeholder="Describe any conditions, limitations, or sensitivities" />
        </Field>
      )}
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>← Back to Dogs</button>
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!canContinue}>Done</button>
      </div>
    </div>
  );
}

// Shared line-item math display for every "Estimated cost" (StepDates,
// Confirmation) and "Billed cost" (Admin Edit) figure in the app - one
// place so a client and an admin see the exact same breakdown shape for
// the exact same underlying calcCostBreakdown() result.
function CostBreakdown({ breakdown, multiDogDiscount }) {
  if (!breakdown) return null;
  const days = formatDays(breakdown.nights);
  const additionalDogs = breakdown.dogs - 1;
  return (
    <div className="cost-breakdown">
      ${formatMoney(breakdown.rate)}/day × {days} day{breakdown.nights !== 1 ? 's' : ''} × 1st dog = ${formatMoney(breakdown.firstDogSubtotal)}
      {additionalDogs > 0 && (
        <>
          <br />
          ${formatMoney(breakdown.rate)}/day × {days} day{breakdown.nights !== 1 ? 's' : ''} × {additionalDogs} additional dog{additionalDogs !== 1 ? 's' : ''} × {100 - multiDogDiscount * 100}% ({multiDogDiscount * 100}% off each) = ${formatMoney(breakdown.additionalDogsSubtotal)}
        </>
      )}
      {breakdown.holidayNights > 0 && (
        <>
          <br />
          + Holiday upcharge: {formatDays(breakdown.holidayNights)} day{breakdown.holidayNights !== 1 ? 's' : ''} × {breakdown.holidayUpcharge * 100}% = ${formatMoney(breakdown.holidayExtra)}
        </>
      )}
      <br />= ${formatMoney(breakdown.total)}
    </div>
  );
}

// Plain-text equivalent of <CostBreakdown> above (kept in sync by hand -
// same reasoning as dogIsComplete/StepDogPage's getErrors: small enough
// that sharing a single implementation across JSX and plain text wasn't
// worth the indirection), embedded directly in the outbound billing SMS
// itself (Sept 19, 2026, on request: "text should show full billing math
// that makes up the total", not just admin's own on-screen display).
// Deliberately omits the final "= $total" line - the SMS states the
// total separately (via {finalCost}), which can differ from this
// calculated total if admin hand-adjusted the amount after Recalculate,
// and showing two potentially-different totals would be more confusing
// than showing one.
function formatCostBreakdownText(breakdown, multiDogDiscount) {
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

function StepDates({ data, onChange, onNext, onBack, rate, minimumStay, multiDogDiscount, holidayUpcharge }) {
  const [errors, setErrors] = useState({});

  function getErrors() {
    const e = {};
    if (!data.checkIn) e.checkIn = 'Required';
    if (!data.checkOut) e.checkOut = 'Required';
    if (!data.dropTime) e.dropTime = 'Required';
    if (!data.pickupTime) e.pickupTime = 'Required';
    // The date input's min attribute is only a UI hint - a real check is
    // needed here too (e.g. a stale page left open overnight, or a value
    // set some other way than the picker).
    if (data.checkIn && data.checkIn < todayISO()) e.checkIn = 'Check-in cannot be in the past';
    if (data.checkIn && data.checkOut && data.checkOut < data.checkIn) e.checkOut = 'Check-out must be after check-in';
    // A same-day stay has drop-off and pick-up on the same calendar date,
    // so pick-up must actually be later in the day - a multi-day stay has
    // no such constraint (an evening drop-off and a morning pick-up two
    // days later is completely normal).
    if (data.checkIn && data.checkOut && data.checkIn === data.checkOut &&
        data.dropTime && data.pickupTime && data.pickupTime <= data.dropTime) {
      e.pickupTime = 'Pick-up must be after drop-off for a same-day stay';
    }
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Continue is greyed out only while a field is genuinely empty - a
  // filled-in but semantically invalid date (past check-in, check-out
  // before check-in) stays clickable, so the specific error message from
  // getErrors() above can actually be seen instead of leaving an
  // unexplained grey button once every field has *something* in it.
  const isComplete = !!(data.checkIn && data.checkOut && data.dropTime && data.pickupTime);

  const breakdown = calcCostBreakdown(data.checkIn, data.checkOut, data.dropTime, data.pickupTime, rate, data.dogs.length, multiDogDiscount, holidayUpcharge, minimumStay);

  return (
    <div className="step">
      <h2 className="step-title">Stay Dates</h2>
      <div className="field-row">
        <Field label="Check-in Date" error={errors.checkIn}>
          <input type="date" value={data.checkIn} min={todayISO()} onChange={e => onChange('checkIn', e.target.value)} />
        </Field>
        <Field label="Check-out Date" error={errors.checkOut}>
          <input type="date" value={data.checkOut} min={data.checkIn || todayISO()} onChange={e => onChange('checkOut', e.target.value)} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Drop-off Time" error={errors.dropTime}>
          <input type="time" value={data.dropTime} onChange={e => onChange('dropTime', e.target.value)} />
        </Field>
        <Field label="Pick-up Time" error={errors.pickupTime}>
          <input type="time" value={data.pickupTime} onChange={e => onChange('pickupTime', e.target.value)} />
        </Field>
      </div>
      {breakdown && (
        <div className="cost-estimate">
          <span>Estimated cost</span>
          <strong>${formatMoney(breakdown.total)}</strong>
          <CostBreakdown breakdown={breakdown} multiDogDiscount={multiDogDiscount} />
          <div className="cost-note">
            Based on ${formatMoney(rate)}/day, billed for the actual length of your dog's stay ({minimumStay}-day minimum) · +{holidayUpcharge * 100}% on holidays
            {data.dogs.length > 1 && ` · ${multiDogDiscount * 100}% off each additional dog`}
            {' '}· Final invoice at pickup
          </div>
        </div>
      )}
      <Field label="Notes (medications, feeding schedule, special instructions)">
        <textarea value={data.notes} onChange={e => onChange('notes', e.target.value)} rows={4} placeholder="Any instructions we should know for this stay..." />
      </Field>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!isComplete}>Continue</button>
      </div>
    </div>
  );
}

function StepWaiver({ onNext, onBack }) {
  return (
    <div className="step">
      <h2 className="step-title">Boarding Agreement</h2>
      <p className="waiver-intro">Please read each section carefully before signing.</p>
      <div className="waiver-scroll">
        {WAIVER_SECTIONS.map((s, i) => (
          <div key={i} className="waiver-section">
            <div className="waiver-section-title">{s.title}</div>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={onNext}>I Have Read the Agreement</button>
      </div>
    </div>
  );
}

function StepSign({ data, onChange, onSubmit, onBack, ownerName, submitting }) {
  const [errors, setErrors] = useState({});
  function getErrors() {
    const e = {};
    if (!data.agreed) e.agreed = 'You must check this box to proceed';
    if (!data.signature.trim()) e.signature = 'Please type your full legal name';
    else if (data.signature.trim().toLowerCase() !== ownerName.trim().toLowerCase()) {
      e.signature = 'Signature must match the name you entered on step 1';
    }
    return e;
  }
  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }
  // Greyed out only while genuinely incomplete (box unchecked, signature
  // blank) - a filled-in but mismatched signature stays clickable so the
  // "must match" message can actually be seen.
  const isComplete = data.agreed && !!data.signature.trim();
  return (
    <div className="step">
      <h2 className="step-title">Sign & Submit</h2>
      <div className="sign-confirm">
        <label className="checkbox-label">
          <input type="checkbox" checked={data.agreed} onChange={e => onChange('agreed', e.target.checked)} />
          <span>I have read the Bayview Boarding agreement in full and agree to its terms on behalf of myself and my dog.</span>
        </label>
        {errors.agreed && <div className="field-error">{errors.agreed}</div>}
      </div>
      <Field label="Electronic Signature — type your full legal name exactly as entered on step 1" error={errors.signature}>
        <input value={data.signature} onChange={e => onChange('signature', e.target.value)} placeholder={ownerName || 'Your full legal name'} className="signature-input" />
      </Field>
      <p className="esign-note">
        Typing your name above constitutes your electronic signature and is legally binding under the federal E-SIGN Act and California's Uniform Electronic Transactions Act (UETA).
      </p>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onSubmit()} disabled={submitting || !isComplete}>
          {submitting ? 'Saving...' : 'Submit Agreement'}
        </button>
      </div>
    </div>
  );
}

function Confirmation({ stay, onNewBooking }) {
  return (
    <div className="step confirmation">
      <div className="confirm-icon">✓</div>
      <h2>Request received, {stay.owner_name?.split(' ')[0]}!</h2>
      <p>
        We've received your booking request and signed agreement for <strong>{stay.dog_name}</strong>.
        We'll review it and text you within 24 hours to confirm it - or let you know if we can't
        accommodate it.
      </p>
      <div className="confirm-blocks">
        <div className="confirm-block">
          <div className="confirm-block-label">Drop-off</div>
          <div className="confirm-block-date">{formatDate(stay.check_in)}</div>
          <div className="confirm-block-time">{stay.drop_time?.slice(0,5)}</div>
        </div>
        <div className="confirm-arrow">→</div>
        <div className="confirm-block">
          <div className="confirm-block-label">Pick-up</div>
          <div className="confirm-block-date">{formatDate(stay.check_out)}</div>
          <div className="confirm-block-time">{stay.pickup_time?.slice(0,5)}</div>
        </div>
      </div>
      {stay.estimated_cost && (
        <div className="cost-estimate">
          <span>Estimated cost</span>
          <strong>${formatMoney(stay.estimated_cost)}</strong>
          <CostBreakdown breakdown={stay.cost_breakdown} multiDogDiscount={stay.multi_dog_discount} />
          <div className="cost-note">Final invoice at pickup</div>
        </div>
      )}
      <p className="confirm-sub">We'll be in touch if we have any questions. Thanks for your patience!</p>
      <button className="btn-secondary" onClick={onNewBooking}>Book Another Stay</button>
    </div>
  );
}

function AdminView({
  onClose, rate, setRate, minimumStay, setMinimumStay, multiDogDiscount, setMultiDogDiscount,
  holidayUpcharge, setHolidayUpcharge, vets, setVets,
  packingList, setPackingList, aboutPhotos, setAboutPhotos,
  smsTemplates, setSmsTemplates,
  smsFooter, setSmsFooter,
}) {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState('');
  const [dogs, setDogs] = useState([]);
  const [totalStays, setTotalStays] = useState(0);
  const [search, setSearch] = useState('');
  // Past Stays opens an owner (not a dog) - see pastStaysOwners below.
  const [selectedOwnerPhone, setSelectedOwnerPhone] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editRate, setEditRate] = useState(rate);
  const [editMinimumStay, setEditMinimumStay] = useState(String(minimumStay));
  const [editMultiDogDiscount, setEditMultiDogDiscount] = useState(String(multiDogDiscount * 100));
  const [editHolidayUpcharge, setEditHolidayUpcharge] = useState(String(holidayUpcharge * 100));
  const [editVets, setEditVets] = useState(vets);
  const [newVetText, setNewVetText] = useState('');
  const [editPackingList, setEditPackingList] = useState(packingList);
  const [newPackingItemText, setNewPackingItemText] = useState('');
  // About page photos (Sept 21, 2026) - editAboutPhotos mirrors
  // editPackingList's pattern (reorder/alt-text edits are local until
  // "Save Photo Order" is clicked), but Upload/Remove are each their own
  // immediate, atomic server call (via the about-photos Edge Function,
  // not settings) since they touch actual Storage files, not just this
  // JSON array - see approveRequest/denyRequest above for the same
  // "destructive/creating actions are immediate" reasoning.
  const [editAboutPhotos, setEditAboutPhotos] = useState(aboutPhotos);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [deletingPhotoPath, setDeletingPhotoPath] = useState(null);
  const [photoActionError, setPhotoActionError] = useState('');
  const [editSms, setEditSms] = useState(smsTemplates);
  const [editSmsFooter, setEditSmsFooter] = useState(smsFooter);
  // Manager phone numbers (Sept 18, 2026) - unlike every other field
  // here, these are never in the public settings fetch (see
  // settings/index.ts's PUBLIC_COLUMNS vs ADMIN_COLUMNS split - a public
  // read must never leak a personal cell number to every site visitor),
  // so there's no App-level prop to seed from. Populated only once,
  // right at login, by a dedicated admin-authenticated settings read.
  const [editPrimaryManagerPhone, setEditPrimaryManagerPhone] = useState('');
  const [editSecondaryManagerPhone, setEditSecondaryManagerPhone] = useState('');
  // The tester broadcast's saved default text (Sept 19, 2026) - same
  // admin-only pattern as the manager phone numbers just above: only ever
  // populated by the admin-authenticated settings read at login, never
  // the public fetch. broadcastMessage (below) is seeded from this once
  // login's fetch resolves, and resets to THIS (not the hardcoded
  // DEFAULT_BROADCAST_MESSAGE constant) after every send, so a saved
  // customization actually sticks instead of reverting.
  const [editDefaultBroadcastMessage, setEditDefaultBroadcastMessage] = useState(DEFAULT_BROADCAST_MESSAGE);
  const [broadcastSaveStatus, setBroadcastSaveStatus] = useState('idle'); // idle | saving | saved
  const [settingsError, setSettingsError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  // One-time "add existing stays to the calendar" utility (Sept 25,
  // 2026, on request) - a plain button rather than something that runs
  // automatically, since it's a catch-up action, not a recurring one;
  // safe to click more than once (admin-data's backfillCalendarEvents
  // action only ever touches stays missing at least one of the 3
  // calendar event ids - see admin-data's backfillCalendarEvents).
  const [backfillingCalendar, setBackfillingCalendar] = useState(false);
  const [backfillCalendarStatus, setBackfillCalendarStatus] = useState('');
  // "Submit Idea" queue - fetched alongside the dog list at login, shown
  // as its own sub-view (see showFeedback) rather than mixed into the dog
  // list, since it's a different kind of thing to triage.
  const [feedback, setFeedback] = useState([]);
  const [showFeedback, setShowFeedback] = useState(false);
  const [updatingFeedbackId, setUpdatingFeedbackId] = useState(null);
  // Tester broadcast list - fetched alongside the dog list at login, its
  // own sub-view like feedback (see showTesters). No public read at all
  // (unlike settings/feedback) - a tester's phone number is contact info.
  const [testers, setTesters] = useState([]);
  const [showTesters, setShowTesters] = useState(false);
  const [newTesterName, setNewTesterName] = useState('');
  const [newTesterPhone, setNewTesterPhone] = useState('');
  const [testersError, setTestersError] = useState('');
  const [savingTester, setSavingTester] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState(DEFAULT_BROADCAST_MESSAGE);
  const [broadcastStatus, setBroadcastStatus] = useState('idle'); // idle | sending | sent | error
  const [broadcastResult, setBroadcastResult] = useState(null);
  // Stay billing review (Sept 17, 2026; shared by Unbilled Stays and Past
  // Stays "resend" since Sept 18, 2026 - same fields, same sendBill call)
  // - local edits per stay id, only committed (and the stay (re)marked
  // billed) once the bill is actually sent; a failed send leaves the
  // stay's edits intact rather than silently marking it billed anyway.
  const [billingEdits, setBillingEdits] = useState({});
  const [billingSendStatus, setBillingSendStatus] = useState({});
  const [sendingBillId, setSendingBillId] = useState(null);
  // Booking request review (Sept 21, 2026, on request - see Submit Idea
  // from Estee) - a new stay starts 'pending' until admin approves or
  // denies it here. denyReasonDrafts is a free-text optional reason per
  // stay id, included in the denial text if given (no confirmation step
  // for either action, same as every other admin decision in this
  // panel - see Rules/CLAUDE.md on that established pattern).
  const [sendingRequestId, setSendingRequestId] = useState(null);
  const [requestActionStatus, setRequestActionStatus] = useState({});
  const [denyReasonDrafts, setDenyReasonDrafts] = useState({});
  // Editing a request's own dates/times/estimated cost before deciding
  // (Sept 24, 2026, on request) - separate from sendingRequestId (that
  // one specifically gates Approve/Deny, which send an SMS first; saving
  // an edit here never does). Reuses editingStayId/billingEdits/
  // billingFieldFor/costBreakdownFor - all already keyed by stay id and
  // generic, same as Unbilled Stays' own Edit.
  const [savingRequestEditId, setSavingRequestEditId] = useState(null);
  // Payment tracking (Sept 21, 2026, on request) - "billed" alone never
  // answered "has this actually been paid?"; marking paid is a plain
  // admin decision, not tied to any text send (unlike approve/deny/bill,
  // which all send first, then persist) - there's no client-facing
  // message this action is confirming actually went out.
  const [markingPaidId, setMarkingPaidId] = useState(null);
  const [paidStatus, setPaidStatus] = useState({});
  // Click-to-expand (Sept 17, 2026 - replaced "every field always visible
  // inline" now that the list includes every unbilled stay, not just
  // already-checked-out ones, and would otherwise be a wall of inputs).
  // Shared by both stay lists - a stay id can only appear in one of them
  // at a time (unbilled vs. billed), so there's no collision risk.
  const [expandedStayId, setExpandedStayId] = useState(null);
  const [editingStayId, setEditingStayId] = useState(null);
  // Which stay's signed waiver snapshot is currently expanded, if any -
  // one at a time, collapsed by default so the stay history doesn't turn
  // into a wall of legal text.
  const [expandedWaiver, setExpandedWaiver] = useState(null);

  async function login() {
    setError('');
    setLoading(true);
    const { data: result, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw },
    });
    setLoading(false);
    if (fnError || !result?.dogs) {
      setError('Incorrect password');
      return;
    }
    setAuthed(true);
    setDogs(result.dogs);
    setTotalStays(result.totalStays || 0);
    // Fetched alongside the dog list - a failure here shouldn't block
    // getting into the admin panel at all, just leaves the queue empty.
    supabase.functions.invoke('feedback', { body: { password: pw } }).then(({ data }) => {
      if (data && !data.error) setFeedback(data.feedback || []);
    }).catch(() => {});
    supabase.functions.invoke('testers', { body: { password: pw, action: 'list' } }).then(({ data }) => {
      if (data && !data.error) setTesters(data.testers || []);
    }).catch(() => {});
    // The manager phone numbers only ever come from this admin-
    // authenticated read (password, no updates) - see settings/index.ts.
    // A failure here shouldn't block getting into the admin panel, same
    // as feedback/testers above; it just leaves both fields blank until
    // admin reloads or retries.
    supabase.functions.invoke('settings', { body: { password: pw } }).then(({ data }) => {
      if (data && !data.error) {
        setEditPrimaryManagerPhone(data.primaryManagerPhone || '');
        setEditSecondaryManagerPhone(data.secondaryManagerPhone || '');
        const savedDefault = data.defaultBroadcastMessage || DEFAULT_BROADCAST_MESSAGE;
        setEditDefaultBroadcastMessage(savedDefault);
        setBroadcastMessage(savedDefault);
      }
    }).catch(() => {});
    // editRate/editMultiDogDiscount/editHolidayUpcharge/editVets were
    // seeded from these same-named props back when this component first
    // mounted - but App's own settings fetch (a separate network call)
    // may not have resolved yet at that point, so those props could still
    // have been the hardcoded fallback defaults, not the real saved
    // values. Re-sync now, right as the settings UI actually becomes
    // visible, rather than on every prop change (which would risk
    // clobbering an admin's in-progress, unsaved edits).
    setEditRate(rate);
    setEditMinimumStay(String(minimumStay));
    setEditMultiDogDiscount(String(multiDogDiscount * 100));
    setEditHolidayUpcharge(String(holidayUpcharge * 100));
    setEditVets(vets);
    setEditPackingList(packingList);
    setEditAboutPhotos(aboutPhotos);
    setEditSms(smsTemplates);
    setEditSmsFooter(smsFooter);
  }

  // Shared save path for every settings field below - persists to
  // Supabase (see supabase/functions/settings/index.ts) and syncs the
  // whole app's live state so the change takes effect immediately,
  // rather than only on next reload.
  async function saveSettings(updates) {
    setSettingsError('');
    setSavingSettings(true);
    const { data, error: fnError } = await supabase.functions.invoke('settings', {
      body: { password: pw, updates },
    });
    setSavingSettings(false);
    if (fnError || !data || data.error) {
      setSettingsError(data?.error || 'Failed to save. Please try again.');
      return false;
    }
    setRate(data.dayRate);
    setMinimumStay(data.minimumStay);
    setMultiDogDiscount(data.multiDogDiscount);
    setHolidayUpcharge(data.holidayUpcharge);
    setVets(data.vets);
    setEditRate(data.dayRate);
    setEditMinimumStay(String(data.minimumStay));
    setEditMultiDogDiscount(String(data.multiDogDiscount * 100));
    setEditHolidayUpcharge(String(data.holidayUpcharge * 100));
    setEditVets(data.vets);
    if (data.packingList) {
      setPackingList(data.packingList);
      setEditPackingList(data.packingList);
    }
    // Array.isArray, not a truthy check - an empty photo list is valid
    // (see App's own public-fetch handling above), and `updates` is the
    // only reliable signal this write actually touched aboutPhotos at
    // all (unlike packingList above, [] is still truthy in JS, so a
    // plain `if (data.aboutPhotos)` would technically also work here,
    // but this stays consistent with the primaryManagerPhone/
    // defaultBroadcastMessage pattern below of checking what was
    // actually sent, not just what came back).
    if (updates.aboutPhotos !== undefined && Array.isArray(data.aboutPhotos)) {
      setAboutPhotos(data.aboutPhotos);
      setEditAboutPhotos(data.aboutPhotos);
    }
    if (data.smsConfirmation || data.smsReminder || data.smsBilling || data.smsPickupReminder || data.smsRequestReceived || data.smsDenied) {
      const next = {
        confirmation: data.smsConfirmation ?? smsTemplates.confirmation,
        reminder: data.smsReminder ?? smsTemplates.reminder,
        billing: data.smsBilling ?? smsTemplates.billing,
        pickupReminder: data.smsPickupReminder ?? smsTemplates.pickupReminder,
        requestReceived: data.smsRequestReceived ?? smsTemplates.requestReceived,
        denied: data.smsDenied ?? smsTemplates.denied,
      };
      setSmsTemplates(next);
      setEditSms(next);
    }
    if (data.smsFooter) {
      setSmsFooter(data.smsFooter);
      setEditSmsFooter(data.smsFooter);
    }
    // primaryManagerPhone/secondaryManagerPhone only come back on a
    // write that actually touched them (a write is always the full
    // admin shape - see settings/index.ts - but a blank saved value
    // would be `''`, which the write API still returns, just never
    // treated as "no manager numbers in this response" the way
    // `data.smsFooter` truthy-checks above would wrongly do for an
    // intentionally-cleared field).
    if (updates.primaryManagerPhone !== undefined) setEditPrimaryManagerPhone(data.primaryManagerPhone ?? '');
    if (updates.secondaryManagerPhone !== undefined) setEditSecondaryManagerPhone(data.secondaryManagerPhone ?? '');
    if (updates.defaultBroadcastMessage !== undefined) {
      setEditDefaultBroadcastMessage(data.defaultBroadcastMessage ?? DEFAULT_BROADCAST_MESSAGE);
    }
    return true;
  }

  function addVet() {
    const name = newVetText.trim();
    if (!name) return;
    setEditVets(v => [...v, name]);
    setNewVetText('');
  }

  function removeVet(index) {
    setEditVets(v => v.filter((_, i) => i !== index));
  }

  function addPackingItem() {
    const item = newPackingItemText.trim();
    if (!item) return;
    setEditPackingList(l => [...l, item]);
    setNewPackingItemText('');
  }

  function removePackingItem(index) {
    setEditPackingList(l => l.filter((_, i) => i !== index));
  }

  // In-place text edit, plus Up/Down reordering (Sept 19, 2026, on
  // request) - previously the only way to change an item's wording or
  // position was Remove + re-Add at the end, losing its original spot
  // in the list.
  function editPackingItem(index, value) {
    setEditPackingList(l => l.map((item, i) => (i === index ? value : item)));
  }

  function movePackingItem(index, direction) {
    setEditPackingList(l => {
      const target = index + direction;
      if (target < 0 || target >= l.length) return l;
      const next = [...l];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // About page photos (Sept 21, 2026) - editAlt/movePhoto are local-only,
  // same as packing list's editPackingItem/movePackingItem (persisted
  // only once "Save Photo Order" is clicked). uploadPhoto/removePhoto are
  // each their own immediate server call instead (see the state
  // declarations above for why) - both hit the about-photos Edge
  // Function, not settings, since they touch actual Storage files.
  function editPhotoAlt(index, value) {
    setEditAboutPhotos(list => list.map((p, i) => (i === index ? { ...p, alt: value } : p)));
  }

  function movePhoto(index, direction) {
    setEditAboutPhotos(list => {
      const target = index + direction;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function uploadPhoto(file) {
    if (!file) return;
    setUploadingPhoto(true);
    setPhotoActionError('');
    const form = new FormData();
    form.append('password', pw);
    form.append('file', file);
    const { data, error: fnError } = await supabase.functions.invoke('about-photos', { body: form });
    setUploadingPhoto(false);
    if (fnError || data?.error) {
      setPhotoActionError(data?.error || 'Failed to upload. Please try again.');
      return;
    }
    setAboutPhotos(data.aboutPhotos);
    setEditAboutPhotos(data.aboutPhotos);
  }

  async function removePhoto(path) {
    setDeletingPhotoPath(path);
    setPhotoActionError('');
    const { data, error: fnError } = await supabase.functions.invoke('about-photos', {
      body: { password: pw, action: 'delete', path },
    });
    setDeletingPhotoPath(null);
    if (fnError || data?.error) {
      setPhotoActionError(data?.error || 'Failed to remove. Please try again.');
      return;
    }
    setAboutPhotos(data.aboutPhotos);
    setEditAboutPhotos(data.aboutPhotos);
  }

  async function updateFeedbackStatus(id, status) {
    setUpdatingFeedbackId(id);
    const { data, error: fnError } = await supabase.functions.invoke('feedback', {
      body: { password: pw, id, status },
    });
    setUpdatingFeedbackId(null);
    if (fnError || data?.error) return;
    setFeedback(list => list.map(f => (f.id === id ? data.feedback : f)));
  }

  // Permanent, no confirmation step (Sept 18, 2026) - same pattern as
  // testers' own "remove" elsewhere in this admin panel.
  async function deleteFeedback(id) {
    setUpdatingFeedbackId(id);
    const { data, error: fnError } = await supabase.functions.invoke('feedback', {
      body: { password: pw, id, action: 'delete' },
    });
    setUpdatingFeedbackId(null);
    if (fnError || data?.error) return;
    setFeedback(list => list.filter(f => f.id !== id));
  }

  async function addTester() {
    setTestersError('');
    if (!newTesterName.trim() || !newTesterPhone.trim()) {
      setTestersError('Name and phone are both required');
      return;
    }
    setSavingTester(true);
    const { data, error: fnError } = await supabase.functions.invoke('testers', {
      body: { password: pw, action: 'add', name: newTesterName.trim(), phone: newTesterPhone.trim() },
    });
    setSavingTester(false);
    if (fnError || data?.error) {
      setTestersError(data?.error || 'Failed to save. Please try again.');
      return;
    }
    setTesters(data.testers);
    setNewTesterName('');
    setNewTesterPhone('');
  }

  async function removeTester(id) {
    const { data, error: fnError } = await supabase.functions.invoke('testers', {
      body: { password: pw, action: 'remove', id },
    });
    if (!fnError && !data?.error) setTesters(data.testers);
  }

  async function sendBroadcast() {
    if (!broadcastMessage.trim()) return;
    setBroadcastStatus('sending');
    const { data, error: fnError } = await supabase.functions.invoke('testers', {
      body: { password: pw, action: 'notify', message: broadcastMessage.trim() },
    });
    if (fnError || data?.error) {
      setBroadcastStatus('error');
      return;
    }
    setBroadcastResult(data);
    setBroadcastStatus('sent');
    // Reset to the saved default rather than leaving it blank - it's
    // meant to be a reusable starting point, ready for next time. Uses
    // whatever's actually saved (editDefaultBroadcastMessage), not the
    // hardcoded DEFAULT_BROADCAST_MESSAGE constant, so a customized
    // default actually sticks across sends (Sept 19, 2026).
    setBroadcastMessage(editDefaultBroadcastMessage);
  }

  // Persists whatever's currently in the compose box as the new default
  // (Sept 19, 2026, on request) - distinct from sendBroadcast, which
  // sends but never saves. Reuses the shared saveSettings path/error
  // state, same as every other settings field.
  async function saveBroadcastDefault() {
    setBroadcastSaveStatus('saving');
    const ok = await saveSettings({ defaultBroadcastMessage: broadcastMessage });
    setBroadcastSaveStatus(ok ? 'saved' : 'idle');
  }

  // Lazily falls back to the stay's actual stored value until admin
  // touches that field.
  function billingFieldFor(stay, field, fallback) {
    return billingEdits[stay.id]?.[field] ?? fallback;
  }

  function updateBillingField(stayId, field, value) {
    setBillingEdits(prev => ({ ...prev, [stayId]: { ...prev[stayId], [field]: value } }));
  }

  // Admin: Stay Editing (Sept 18, 2026) - Daily Rate and Holiday Upcharge
  // are now per-stay editable fields too (defaulting to the current global
  // settings), not just dates/times, so a one-off correction or discount
  // doesn't require changing the site-wide rate. Returns the full line-item
  // breakdown (calcCostBreakdown) so the edit view can show the math, not
  // just the final number.
  function costBreakdownFor(stay) {
    const checkIn = billingFieldFor(stay, 'checkIn', stay.check_in);
    const checkOut = billingFieldFor(stay, 'checkOut', stay.check_out);
    const dropTime = billingFieldFor(stay, 'dropTime', stay.drop_time ? stay.drop_time.slice(0, 5) : '');
    const pickupTime = billingFieldFor(stay, 'pickupTime', stay.pickup_time ? stay.pickup_time.slice(0, 5) : '');
    const dayRate = Number(billingFieldFor(stay, 'dayRate', String(rate)));
    const holidayPct = Number(billingFieldFor(stay, 'holidayUpchargePct', String(holidayUpcharge * 100)));
    const numberOfDogs = stay.number_of_dogs || (stay.dogNames ? stay.dogNames.length : 1);
    return calcCostBreakdown(checkIn, checkOut, dropTime, pickupTime, dayRate, numberOfDogs, multiDogDiscount, holidayPct / 100, minimumStay);
  }

  // Recomputes a suggested total from the (possibly-just-edited)
  // dates/times/rate/holiday-upcharge using the site's real cost logic -
  // still just a suggestion, landing in the same editable Final Cost field
  // so admin can hand-adjust it further before sending.
  function recalculateBilling(stay) {
    const breakdown = costBreakdownFor(stay);
    updateBillingField(stay.id, 'finalCost', breakdown ? breakdown.total.toFixed(2) : '');
  }

  // Sends the bill THEN marks it billed - in that order, deliberately:
  // "billed" should mean the text actually went out, not just that admin
  // clicked a button. If the send fails, nothing is persisted and the
  // stay stays on the unbilled list with the edits still in place to
  // retry. Any corrected dates/times/cost are saved in the same call
  // that marks it billed (admin-data's billStay action).
  // Works equally for an unbilled stay's first bill and a Past Stays
  // "resend" (Sept 18, 2026) - billStay always just patches the given
  // fields and stamps billed_at fresh, whether or not one was already set.
  async function sendBill(stay) {
    const checkIn = billingFieldFor(stay, 'checkIn', stay.check_in);
    const checkOut = billingFieldFor(stay, 'checkOut', stay.check_out);
    const dropTime = billingFieldFor(stay, 'dropTime', stay.drop_time ? stay.drop_time.slice(0, 5) : '');
    const pickupTime = billingFieldFor(stay, 'pickupTime', stay.pickup_time ? stay.pickup_time.slice(0, 5) : '');
    const finalCost = Number(billingFieldFor(stay, 'finalCost', stay.estimated_cost != null ? String(stay.estimated_cost) : ''));
    if (!finalCost || finalCost <= 0) {
      setBillingSendStatus(prev => ({ ...prev, [stay.id]: 'Enter a valid amount first' }));
      return;
    }
    setSendingBillId(stay.id);
    setBillingSendStatus(prev => ({ ...prev, [stay.id]: null }));

    // The actual outbound text includes the full line-item math via
    // {billingBreakdown} (Sept 19, 2026), built from the same edited
    // dates/times/rate/holiday-% admin just reviewed - not just the
    // final total.
    const billingBreakdown = formatCostBreakdownText(costBreakdownFor(stay), multiDogDiscount);
    const { data: smsData, error: smsErr } = await supabase.functions.invoke('send-confirmation', {
      body: {
        type: 'billing', owner_name: stay.ownerName, owner_phone: stay.ownerPhone,
        dog_name: stay.dogNames.join(' & '), final_cost: finalCost, message_template: smsTemplates.billing,
        billing_breakdown: billingBreakdown,
      },
    });
    if (smsErr || smsData?.error) {
      setSendingBillId(null);
      setBillingSendStatus(prev => ({ ...prev, [stay.id]: 'Failed to send. Please try again.' }));
      return;
    }

    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: {
        password: pw, action: 'billStay', stayId: stay.id,
        checkIn, checkOut, dropTime: dropTime || null, pickupTime: pickupTime || null, estimatedCost: finalCost,
      },
    });
    setSendingBillId(null);
    if (fnError || data?.error) {
      // The text already went out - just couldn't record it as billed.
      // Log-worthy but not something to block the admin over; the stay
      // stays on the list (unbilled, or still showing its old billed
      // state) so it isn't lost.
      setBillingSendStatus(prev => ({ ...prev, [stay.id]: 'Sent, but failed to save - it may show as unbilled again.' }));
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
  }

  // Saves a request's corrected dates/times/estimated cost (Sept 24,
  // 2026, on request - "allow editing of the stay while it is still in
  // the request stage") via admin-data's editStay action - unlike
  // billStay/approveRequest/denyRequest below, this never sends any SMS
  // and never touches approval_status - it's a plain field correction,
  // still fully pending afterward, so admin can review the corrected
  // numbers before actually deciding.
  async function saveRequestEdits(stay) {
    const checkIn = billingFieldFor(stay, 'checkIn', stay.check_in);
    const checkOut = billingFieldFor(stay, 'checkOut', stay.check_out);
    const dropTime = billingFieldFor(stay, 'dropTime', stay.drop_time ? stay.drop_time.slice(0, 5) : '');
    const pickupTime = billingFieldFor(stay, 'pickupTime', stay.pickup_time ? stay.pickup_time.slice(0, 5) : '');
    const estimatedCostRaw = billingFieldFor(stay, 'finalCost', stay.estimated_cost != null ? String(stay.estimated_cost) : '');
    setSavingRequestEditId(stay.id);
    setRequestActionStatus(prev => ({ ...prev, [stay.id]: null }));
    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: {
        password: pw, action: 'editStay', stayId: stay.id,
        checkIn, checkOut, dropTime: dropTime || null, pickupTime: pickupTime || null,
        estimatedCost: estimatedCostRaw ? Number(estimatedCostRaw) : null,
      },
    });
    setSavingRequestEditId(null);
    if (fnError || data?.error) {
      setRequestActionStatus(prev => ({ ...prev, [stay.id]: 'Failed to save. Please try again.' }));
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
    setEditingStayId(null);
  }

  // Approve/deny a pending request (Sept 21, 2026) - same "send the text
  // FIRST, then persist the decision" ordering as sendBill above: the
  // status should only change once the client has actually been texted,
  // not just because admin clicked a button.
  async function approveRequest(stay) {
    setSendingRequestId(stay.id);
    setRequestActionStatus(prev => ({ ...prev, [stay.id]: null }));
    const { data: smsData, error: smsErr } = await supabase.functions.invoke('send-confirmation', {
      body: {
        type: 'confirmation', owner_name: stay.ownerName, owner_phone: stay.ownerPhone,
        dog_name: stay.dogNames.join(' & '), check_in: stay.check_in, check_out: stay.check_out,
        drop_time: stay.drop_time, pickup_time: stay.pickup_time, estimated_cost: stay.estimated_cost,
        message_template: smsTemplates.confirmation,
      },
    });
    if (smsErr || smsData?.error) {
      setSendingRequestId(null);
      setRequestActionStatus(prev => ({ ...prev, [stay.id]: 'Failed to send. Please try again.' }));
      return;
    }
    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw, action: 'approveStay', stayId: stay.id },
    });
    setSendingRequestId(null);
    if (fnError || data?.error) {
      setRequestActionStatus(prev => ({ ...prev, [stay.id]: 'Sent, but failed to save - it may show as pending again.' }));
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
  }

  async function denyRequest(stay) {
    const reason = (denyReasonDrafts[stay.id] || '').trim();
    setSendingRequestId(stay.id);
    setRequestActionStatus(prev => ({ ...prev, [stay.id]: null }));
    const { data: smsData, error: smsErr } = await supabase.functions.invoke('send-confirmation', {
      body: {
        type: 'denied', owner_name: stay.ownerName, owner_phone: stay.ownerPhone,
        dog_name: stay.dogNames.join(' & '), check_in: stay.check_in, check_out: stay.check_out,
        message_template: smsTemplates.denied, denial_reason: reason || null,
      },
    });
    if (smsErr || smsData?.error) {
      setSendingRequestId(null);
      setRequestActionStatus(prev => ({ ...prev, [stay.id]: 'Failed to send. Please try again.' }));
      return;
    }
    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw, action: 'denyStay', stayId: stay.id, denialReason: reason || null },
    });
    setSendingRequestId(null);
    if (fnError || data?.error) {
      setRequestActionStatus(prev => ({ ...prev, [stay.id]: 'Sent, but failed to save - it may show as pending again.' }));
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
  }

  // Just a status flip, unlike approve/deny/bill above - no text to send
  // first, so no "send then persist" ordering needed here.
  async function markPaid(stay) {
    setMarkingPaidId(stay.id);
    setPaidStatus(prev => ({ ...prev, [stay.id]: null }));
    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw, action: 'markPaid', stayId: stay.id },
    });
    setMarkingPaidId(null);
    if (fnError || data?.error) {
      setPaidStatus(prev => ({ ...prev, [stay.id]: 'Failed to save. Please try again.' }));
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
  }

  // Catch-up for stays approved before the calendar feature existed, or
  // from any stretch when Google Calendar was unreachable (Sept 25,
  // 2026, on request - "can we update the calendar with existing
  // stays?"). Best-effort like everything else calendar-related - a
  // failure here just means try again later, never an error the admin
  // has to do anything about.
  async function backfillCalendar() {
    setBackfillingCalendar(true);
    setBackfillCalendarStatus('');
    const { data, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw, action: 'backfillCalendarEvents' },
    });
    setBackfillingCalendar(false);
    if (fnError || data?.error) {
      setBackfillCalendarStatus('Failed to sync. Please try again.');
      return;
    }
    setDogs(data.dogs);
    setTotalStays(data.totalStays);
    setBackfillCalendarStatus(
      data.backfilledCount === 0
        ? 'Already up to date - nothing to add.'
        : `Added ${data.backfilledCount} stay${data.backfilledCount === 1 ? '' : 's'} to the calendar.`
    );
  }

  if (!authed) {
    return (
      <div className="admin-overlay">
        <div className="admin-login">
          <h2>Admin Access</h2>
          <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()} />
          {error && <div className="field-error">{error}</div>}
          <div className="step-actions">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={login}>Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  const feedbackOpenCount = feedback.filter(f => f.status === 'open').length;

  // Each dog's own frozen breed/DOB/aggression/health snapshot for a
  // specific stay, plus its photos - shared by every admin list below
  // (Requests/Unbilled Stays/Awaiting Payment/Past Stays) so admin sees
  // the same dog detail no matter which list a stay happens to be in
  // right now (Sept 24, 2026, on request - "show the dogs with the
  // stays in the admin panel" - previously only Past Stays actually
  // showed breed/DOB/aggression/health, which meant a pending REQUEST,
  // of all things, showed the least detail admin has to decide whether
  // to approve).
  function perDogEntryFor(d, s) {
    return {
      name: d.name, breed: s.breed, dob: s.dob,
      aggression_history: s.aggression_history, aggression_detail: s.aggression_detail,
      health_concerns: s.health_concerns, health_detail: s.health_detail,
      photoUrls: s.photoUrls || [],
    };
  }

  // Every never-decided stay, across all dogs, deduped by stay id (a
  // shared multi-dog booking otherwise appears once per dog) - the new
  // top-of-panel Requests section (Sept 21, 2026). Sorted earliest
  // check-in first, same as Unbilled Stays below.
  const pendingByStayId = new Map();
  dogs.forEach(d => {
    (d.stays || []).forEach(s => {
      if (s.approval_status === 'pending') {
        if (pendingByStayId.has(s.id)) {
          const entry = pendingByStayId.get(s.id);
          entry.dogNames.push(d.name);
          entry.perDog.push(perDogEntryFor(d, s));
        } else {
          pendingByStayId.set(s.id, {
            ...s, dogNames: [d.name], perDog: [perDogEntryFor(d, s)],
            ownerName: d.owner?.name, ownerPhone: d.owner?.phone,
          });
        }
      }
    });
  });
  const pendingRequests = Array.from(pendingByStayId.values()).sort((a, b) => a.check_in.localeCompare(b.check_in));

  // Every dog's stay history already carries billed_at - no separate
  // fetch needed, just flatten across dogs and dedupe by stay id (a
  // shared multi-dog stay otherwise appears once per dog). "Unbilled"
  // means approved but never billed - future and in-progress stays are
  // included too (Sept 17, 2026 - previously limited to already-checked-
  // out stays), sorted earliest check-in first so admin sees what's
  // coming up, not just what's overdue. A still-pending or denied stay
  // isn't a real booking yet (or ever), so it stays out of this list -
  // see Requests above (Sept 21, 2026).
  const unbilledByStayId = new Map();
  dogs.forEach(d => {
    (d.stays || []).forEach(s => {
      if (s.approval_status === 'approved' && !s.billed_at) {
        if (unbilledByStayId.has(s.id)) {
          const entry = unbilledByStayId.get(s.id);
          entry.dogNames.push(d.name);
          entry.perDog.push(perDogEntryFor(d, s));
        } else {
          unbilledByStayId.set(s.id, {
            ...s, dogNames: [d.name], perDog: [perDogEntryFor(d, s)],
            ownerName: d.owner?.name, ownerPhone: d.owner?.phone,
          });
        }
      }
    });
  });
  const unbilledStays = Array.from(unbilledByStayId.values()).sort((a, b) => a.check_in.localeCompare(b.check_in));

  // "Awaiting Payment" (Sept 21, 2026, on request) = billed but not yet
  // marked paid - the gap "billed" alone used to leave unanswered
  // ("has this actually been paid?"). Sorted earliest check-in first,
  // same as the other lists. Still fully editable/re-billable here (see
  // renderStayCard) in case the billed amount needs correcting before
  // payment - only actually marking it paid makes it a closed record.
  const awaitingPaymentByStayId = new Map();
  dogs.forEach(d => {
    (d.stays || []).forEach(s => {
      if (s.approval_status === 'approved' && s.billed_at && !s.paid_at) {
        if (awaitingPaymentByStayId.has(s.id)) {
          const entry = awaitingPaymentByStayId.get(s.id);
          entry.dogNames.push(d.name);
          entry.perDog.push(perDogEntryFor(d, s));
        } else {
          awaitingPaymentByStayId.set(s.id, {
            ...s, dogNames: [d.name], perDog: [perDogEntryFor(d, s)],
            ownerName: d.owner?.name, ownerPhone: d.owner?.phone,
          });
        }
      }
    });
  });
  const awaitingPaymentStays = Array.from(awaitingPaymentByStayId.values()).sort((a, b) => a.check_in.localeCompare(b.check_in));

  // "Past Stays" = fully billed AND paid stays, PLUS denied requests kept here as
  // a record (marked "Rejected" - Sept 21, 2026, on request; previously
  // a denied request just vanished from admin entirely once decided).
  // Together with Unbilled Stays, this covers every signed agreement on
  // file plus every decided-against request. Grouped by owner rather
  // than by dog (Sept 18, 2026) - an owner with 2 dogs used to get 2
  // separate rows; now one row per owner, and opening it lists their
  // past STAYS (deduped by stay id across a shared multi-dog booking,
  // same as Unbilled Stays) rather than one dog's history alone. perDog
  // keeps each dog's own frozen aggression/health/DOB snapshot for that
  // specific stay, since only name/dates/cost/notes/waiver are actually
  // shared across dogs on the same stay.
  const pastStaysByOwnerPhone = new Map();
  dogs.forEach(d => {
    const phone = d.owner?.phone;
    if (!phone) return;
    (d.stays || []).forEach(s => {
      const isPaid = s.approval_status === 'approved' && s.billed_at && s.paid_at;
      const isDenied = s.approval_status === 'denied';
      if (!isPaid && !isDenied) return;
      if (!pastStaysByOwnerPhone.has(phone)) {
        pastStaysByOwnerPhone.set(phone, { ownerName: d.owner?.name, ownerPhone: phone, staysById: new Map() });
      }
      const perDogEntry = perDogEntryFor(d, s);
      const owner = pastStaysByOwnerPhone.get(phone);
      if (owner.staysById.has(s.id)) {
        const existing = owner.staysById.get(s.id);
        existing.dogNames.push(d.name);
        existing.perDog.push(perDogEntry);
      } else {
        owner.staysById.set(s.id, { ...s, dogNames: [d.name], perDog: [perDogEntry], ownerName: d.owner?.name, ownerPhone: phone });
      }
    });
  });
  const pastStaysOwners = Array.from(pastStaysByOwnerPhone.values()).map(o => ({
    ownerName: o.ownerName,
    ownerPhone: o.ownerPhone,
    dogNames: [...new Set(Array.from(o.staysById.values()).flatMap(s => s.dogNames))],
    stays: Array.from(o.staysById.values()).sort((a, b) => b.check_in.localeCompare(a.check_in)),
  }));
  const filteredOwners = pastStaysOwners.filter(o =>
    o.ownerName?.toLowerCase().includes(search.toLowerCase()) ||
    o.dogNames.some(n => n.toLowerCase().includes(search.toLowerCase()))
  );
  const selectedOwner = pastStaysOwners.find(o => o.ownerPhone === selectedOwnerPhone) || null;

  // The Requests section (Sept 21, 2026) - a simpler sibling of
  // renderStayCard below: view-only details plus Approve/Deny, and (Sept
  // 24, 2026, on request - "allow editing of the stay while it is still
  // in the request stage") its own Edit toggle for correcting dates/
  // times/estimated cost before deciding, via admin-data's editStay
  // action (see saveRequestEdits - deliberately separate from
  // billStay/approveRequest/denyRequest: never sends any SMS, never
  // touches approval_status). Shares expandedStayId/expandedWaiver/
  // editingStayId/billingEdits with the other stay lists - a stay id
  // can only appear in one section at a time (pending vs. approved), so
  // there's no collision risk.
  function renderRequestCard(s) {
    const isExpanded = expandedStayId === s.id;
    const isEditingRequest = editingStayId === s.id;
    // Same shape/flattening as renderStayCard's photoEntries below.
    const photoEntries = s.perDog.flatMap(pd => (pd.photoUrls || []).map((url, pi) => ({ name: pd.name, photoUrl: url, photoIndex: pi + 1 })));
    return (
      <div key={s.id} className="stay-card">
        <div
          className="stay-dates"
          style={{ cursor: 'pointer', justifyContent: 'space-between' }}
          onClick={() => setExpandedStayId(isExpanded ? null : s.id)}
        >
          <span>{s.dogNames.join(' & ')} — {s.ownerName}</span>
          <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem', flexShrink: 0 }}>
            {isExpanded ? 'Hide' : 'View'}
          </button>
        </div>
        <div className="stay-meta">{formatDate(s.check_in)} – {formatDate(s.check_out)}</div>
        {isExpanded && (
          <div style={{ marginTop: 8 }}>
            <div className="stay-meta">{s.ownerPhone}</div>
            {photoEntries.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, marginBottom: 6 }}>
                {photoEntries.map((p, i) => (
                  <img
                    key={i}
                    src={p.photoUrl}
                    alt={`${p.name}'s photo ${p.photoIndex}`}
                    className="dog-photo-thumb"
                  />
                ))}
              </div>
            )}
            {!isEditingRequest ? (
              <>
                <div className="stay-meta">
                  Drop-off: {s.drop_time ? s.drop_time.slice(0, 5) : '—'} · Pickup: {s.pickup_time ? s.pickup_time.slice(0, 5) : '—'}
                </div>
                <div className="stay-meta">
                  Estimated cost: {s.estimated_cost != null ? `$${formatMoney(s.estimated_cost)}` : '—'}
                </div>
                {s.perDog.map((pd, i) => (
                  <div key={i}>
                    {pd.breed && (
                      <div className="stay-meta">
                        {s.perDog.length > 1 ? `${pd.name} — ` : ''}{pd.breed}
                        {pd.dob && ` · DOB: ${formatDate(pd.dob)} · Age: ${calcAge(pd.dob)}`}
                      </div>
                    )}
                    {pd.aggression_history === 'yes' && <div className="stay-flag">⚠ {s.perDog.length > 1 ? `${pd.name}: ` : ''}Aggression noted: {pd.aggression_detail}</div>}
                    {pd.health_concerns === 'yes' && <div className="stay-flag">⚕ {s.perDog.length > 1 ? `${pd.name}: ` : ''}Health note: {pd.health_detail}</div>}
                  </div>
                ))}
                {s.notes && <div className="stay-notes">"{s.notes}"</div>}
                {Array.isArray(s.waiver_snapshot) && s.waiver_snapshot.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      className="back-btn"
                      style={{ fontSize: '0.78rem' }}
                      onClick={() => setExpandedWaiver(w => (w === s.id ? null : s.id))}
                    >
                      {expandedWaiver === s.id ? 'Hide waiver as signed' : 'View waiver as signed'}
                    </button>
                    {expandedWaiver === s.id && (
                      <div className="waiver-scroll" style={{ marginTop: 8, maxHeight: 260 }}>
                        {s.waiver_snapshot.map((section, si) => (
                          <div className="waiver-section" key={si}>
                            <div className="waiver-section-title">{section.title}</div>
                            <p>{section.body}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <input
                    placeholder="Reason for declining (optional, included in the text if you deny)"
                    value={denyReasonDrafts[s.id] || ''}
                    onChange={e => setDenyReasonDrafts(prev => ({ ...prev, [s.id]: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => setEditingStayId(s.id)}>
                    Edit
                  </button>
                  <button
                    className="btn-primary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                    disabled={sendingRequestId === s.id}
                    onClick={() => approveRequest(s)}
                  >
                    {sendingRequestId === s.id ? 'Sending...' : 'Approve'}
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem', color: '#C0392B', borderColor: '#C0392B' }}
                    disabled={sendingRequestId === s.id}
                    onClick={() => denyRequest(s)}
                  >
                    Deny
                  </button>
                  {requestActionStatus[s.id] && (
                    <span className="field-error" style={{ fontSize: '0.78rem' }}>{requestActionStatus[s.id]}</span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="field-row" style={{ marginTop: 8 }}>
                  <Field label="Check-in">
                    <input type="date" value={billingFieldFor(s, 'checkIn', s.check_in)} onChange={e => updateBillingField(s.id, 'checkIn', e.target.value)} />
                  </Field>
                  <Field label="Check-out">
                    <input type="date" value={billingFieldFor(s, 'checkOut', s.check_out)} onChange={e => updateBillingField(s.id, 'checkOut', e.target.value)} />
                  </Field>
                </div>
                <div className="field-row">
                  <Field label="Drop-off time">
                    <input type="time" value={billingFieldFor(s, 'dropTime', s.drop_time ? s.drop_time.slice(0, 5) : '')} onChange={e => updateBillingField(s.id, 'dropTime', e.target.value)} />
                  </Field>
                  <Field label="Pickup time">
                    <input type="time" value={billingFieldFor(s, 'pickupTime', s.pickup_time ? s.pickup_time.slice(0, 5) : '')} onChange={e => updateBillingField(s.id, 'pickupTime', e.target.value)} />
                  </Field>
                </div>
                <CostBreakdown breakdown={costBreakdownFor(s)} multiDogDiscount={multiDogDiscount} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem' }}>$</span>
                  <input
                    type="number"
                    value={billingFieldFor(s, 'finalCost', s.estimated_cost != null ? String(s.estimated_cost) : '')}
                    onChange={e => updateBillingField(s.id, 'finalCost', e.target.value)}
                    style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem' }}
                  />
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => recalculateBilling(s)}>Recalculate</button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn-primary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                    disabled={savingRequestEditId === s.id}
                    onClick={() => saveRequestEdits(s)}
                  >
                    {savingRequestEditId === s.id ? 'Saving...' : 'Save'}
                  </button>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => setEditingStayId(null)}>
                    Cancel
                  </button>
                  {requestActionStatus[s.id] && (
                    <span className="field-error" style={{ fontSize: '0.78rem' }}>{requestActionStatus[s.id]}</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // Shared by Unbilled Stays and Past Stays (Sept 18, 2026) - same
  // click-to-expand card, same Edit/Recalculate/Send Billing Text
  // controls, whether the stay has never been billed or is being
  // corrected and resent. Notes and a signed-waiver toggle show whenever
  // the stay actually has them (every real booking does).
  function renderStayCard(s) {
    const isExpanded = expandedStayId === s.id;
    const isEditing = editingStayId === s.id;
    // Computed whenever the card is expanded, not just while editing, so
    // the math behind "Estimated cost"/"Billed cost" is always visible
    // once a card is opened - not only after clicking into Edit.
    const breakdown = isExpanded ? costBreakdownFor(s) : null;
    // s.perDog (Requests/Unbilled Stays/Awaiting Payment/Past Stays all
    // build this now - Sept 24, 2026) is one entry per dog, each with
    // its own photoUrls array - flatten to the {name, photoUrl,
    // photoIndex} shape the thumbnail row below wants.
    const photoEntries = s.perDog.flatMap(pd => (pd.photoUrls || []).map((url, pi) => ({ name: pd.name, photoUrl: url, photoIndex: pi + 1 })));
    return (
      <div key={s.id} className="stay-card">
        <div
          className="stay-dates"
          style={{ cursor: 'pointer', justifyContent: 'space-between' }}
          onClick={() => {
            setExpandedStayId(isExpanded ? null : s.id);
            if (isExpanded) setEditingStayId(null);
          }}
        >
          <span>
            {s.dogNames.join(' & ')} — {s.ownerName}
            {s.approval_status === 'denied' && (
              <span className="stay-flag" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Rejected</span>
            )}
            {s.paid_at && (
              <span className="stay-paid-badge" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Paid</span>
            )}
          </span>
          <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem', flexShrink: 0 }}>
            {isExpanded ? 'Hide' : 'View'}
          </button>
        </div>
        <div className="stay-meta">{formatDate(s.check_in)} – {formatDate(s.check_out)}</div>
        {isExpanded && (
          <div style={{ marginTop: 8 }}>
            <div className="stay-meta">{s.ownerPhone}</div>
            {s.approval_status === 'denied' && s.denial_reason && (
              <div className="stay-notes">Reason given: "{s.denial_reason}"</div>
            )}
            {photoEntries.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, marginBottom: 6 }}>
                {photoEntries.map((p, i) => (
                  <img
                    key={i}
                    src={p.photoUrl}
                    alt={`${p.name}'s photo ${p.photoIndex}`}
                    className="dog-photo-thumb"
                  />
                ))}
              </div>
            )}
            {!isEditing ? (
              <>
                <div className="stay-meta">
                  Drop-off: {billingFieldFor(s, 'dropTime', s.drop_time ? s.drop_time.slice(0, 5) : '') || '—'} · Pickup: {billingFieldFor(s, 'pickupTime', s.pickup_time ? s.pickup_time.slice(0, 5) : '') || '—'}
                </div>
                <div className="stay-meta">
                  {s.paid_at ? 'Paid cost' : s.billed_at ? 'Billed cost' : 'Estimated cost'}: {(() => {
                    const fc = billingFieldFor(s, 'finalCost', s.estimated_cost != null ? String(s.estimated_cost) : '');
                    return fc ? `$${formatMoney(fc)}` : '—';
                  })()}
                </div>
                <CostBreakdown breakdown={breakdown} multiDogDiscount={multiDogDiscount} />
                {s.perDog.map((pd, i) => (
                  <div key={i}>
                    {(pd.breed || pd.dob) && (
                      <div className="stay-meta">
                        {s.perDog.length > 1 ? `${pd.name} — ` : ''}{pd.breed}
                        {pd.dob && `${pd.breed ? ' · ' : ''}DOB: ${formatDate(pd.dob)} · Age at stay: ${calcAge(pd.dob)}`}
                      </div>
                    )}
                    {pd.aggression_history === 'yes' && <div className="stay-flag">⚠ {s.perDog.length > 1 ? `${pd.name}: ` : ''}Aggression noted: {pd.aggression_detail}</div>}
                    {pd.health_concerns === 'yes' && <div className="stay-flag">⚕ {s.perDog.length > 1 ? `${pd.name}: ` : ''}Health note: {pd.health_detail}</div>}
                  </div>
                ))}
                {s.notes && <div className="stay-notes">"{s.notes}"</div>}
                {Array.isArray(s.waiver_snapshot) && s.waiver_snapshot.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      className="back-btn"
                      style={{ fontSize: '0.78rem' }}
                      onClick={() => setExpandedWaiver(w => (w === s.id ? null : s.id))}
                    >
                      {expandedWaiver === s.id ? 'Hide waiver as signed' : 'View waiver as signed'}
                    </button>
                    {expandedWaiver === s.id && (
                      <div className="waiver-scroll" style={{ marginTop: 8, maxHeight: 260 }}>
                        {s.waiver_snapshot.map((section, si) => (
                          <div className="waiver-section" key={si}>
                            <div className="waiver-section-title">{section.title}</div>
                            <p>{section.body}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="field-row" style={{ marginTop: 8 }}>
                  <Field label="Check-in">
                    <input type="date" value={billingFieldFor(s, 'checkIn', s.check_in)} onChange={e => updateBillingField(s.id, 'checkIn', e.target.value)} />
                  </Field>
                  <Field label="Check-out">
                    <input type="date" value={billingFieldFor(s, 'checkOut', s.check_out)} onChange={e => updateBillingField(s.id, 'checkOut', e.target.value)} />
                  </Field>
                </div>
                <div className="field-row">
                  <Field label="Drop-off time">
                    <input type="time" value={billingFieldFor(s, 'dropTime', s.drop_time ? s.drop_time.slice(0, 5) : '')} onChange={e => updateBillingField(s.id, 'dropTime', e.target.value)} />
                  </Field>
                  <Field label="Pickup time">
                    <input type="time" value={billingFieldFor(s, 'pickupTime', s.pickup_time ? s.pickup_time.slice(0, 5) : '')} onChange={e => updateBillingField(s.id, 'pickupTime', e.target.value)} />
                  </Field>
                </div>
                <div className="field-row">
                  <Field label="Daily Rate">
                    <input type="number" value={billingFieldFor(s, 'dayRate', String(rate))} onChange={e => updateBillingField(s.id, 'dayRate', e.target.value)} />
                  </Field>
                  <Field label="Holiday Upcharge %">
                    <input type="number" value={billingFieldFor(s, 'holidayUpchargePct', String(holidayUpcharge * 100))} onChange={e => updateBillingField(s.id, 'holidayUpchargePct', e.target.value)} />
                  </Field>
                </div>
                <CostBreakdown breakdown={breakdown} multiDogDiscount={multiDogDiscount} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem' }}>$</span>
                  <input
                    type="number"
                    value={billingFieldFor(s, 'finalCost', s.estimated_cost != null ? String(s.estimated_cost) : '')}
                    onChange={e => updateBillingField(s.id, 'finalCost', e.target.value)}
                    style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem' }}
                  />
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => recalculateBilling(s)}>Recalculate</button>
                </div>
              </>
            )}
            {s.approval_status === 'approved' && !s.paid_at && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => setEditingStayId(isEditing ? null : s.id)}>
                  {isEditing ? 'Done Editing' : 'Edit'}
                </button>
                <button
                  className="btn-primary"
                  style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                  disabled={sendingBillId === s.id}
                  onClick={() => sendBill(s)}
                >
                  {sendingBillId === s.id ? 'Sending...' : 'Send Billing Text'}
                </button>
                {s.billed_at && (
                  <button
                    className="btn-primary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem', background: '#7D9B76' }}
                    disabled={markingPaidId === s.id}
                    onClick={() => markPaid(s)}
                  >
                    {markingPaidId === s.id ? 'Saving...' : 'Mark Paid'}
                  </button>
                )}
                {billingSendStatus[s.id] && (
                  <span className="field-error" style={{ fontSize: '0.78rem' }}>{billingSendStatus[s.id]}</span>
                )}
                {paidStatus[s.id] && (
                  <span className="field-error" style={{ fontSize: '0.78rem' }}>{paidStatus[s.id]}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (showFeedback) {
    return (
      <div className="admin-overlay">
        <div className="admin-panel">
          <div className="admin-header">
            <button className="back-btn" onClick={() => setShowFeedback(false)}>← Admin</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <h2>Ideas &amp; Bugs</h2>
          <div className="admin-count">
            {feedback.length} submission{feedback.length !== 1 ? 's' : ''} · {feedbackOpenCount} open
          </div>
          {feedback.length === 0 && <p className="empty">Nothing submitted yet.</p>}
          <div className="stay-history">
            {feedback.map(f => (
              <div key={f.id} className="stay-card">
                <div className="stay-meta">{formatDate(f.created_at?.slice(0, 10))}</div>
                <div className="stay-notes" style={{ fontStyle: 'normal', marginTop: 6, whiteSpace: 'pre-wrap' }}>{f.message}</div>
                <div className="stay-meta" style={{ marginTop: 6 }}>
                  {[f.name, f.contact].filter(Boolean).join(' · ')}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  {FEEDBACK_STATUSES.map(({ key, label }) => (
                    <button
                      key={key}
                      className={key === f.status ? 'btn-primary' : 'btn-secondary'}
                      style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                      disabled={updatingFeedbackId === f.id || key === f.status}
                      onClick={() => updateFeedbackStatus(f.id, key)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem', color: '#C0392B', borderColor: '#C0392B' }}
                    disabled={updatingFeedbackId === f.id}
                    onClick={() => deleteFeedback(f.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (showTesters) {
    return (
      <div className="admin-overlay">
        <div className="admin-panel">
          <div className="admin-header">
            <button className="back-btn" onClick={() => setShowTesters(false)}>← Admin</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <h2>Testers</h2>

          <div className="rate-setting">
            <label className="field-label">Broadcast a Message</label>
            <div style={{ fontSize: '0.72rem', color: '#6B7A8A', marginBottom: 8 }}>
              Each active tester gets their own text starting "Hi [their name], " followed by
              whatever's below - a suggested starting point, fully editable before you send.
            </div>
            <textarea
              value={broadcastMessage}
              onChange={e => { setBroadcastMessage(e.target.value); setBroadcastSaveStatus('idle'); }}
              rows={5}
              style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem', fontFamily: 'inherit' }}
            />
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn-primary"
                style={{ padding: '6px 14px' }}
                disabled={!broadcastMessage.trim() || broadcastStatus === 'sending' || testers.filter(t => t.active).length === 0}
                onClick={sendBroadcast}
              >
                {broadcastStatus === 'sending' ? 'Sending...' : `Send to ${testers.filter(t => t.active).length} tester${testers.filter(t => t.active).length !== 1 ? 's' : ''}`}
              </button>
              <button
                className="btn-secondary"
                style={{ padding: '6px 14px' }}
                disabled={!broadcastMessage.trim() || savingSettings}
                onClick={saveBroadcastDefault}
              >
                {broadcastSaveStatus === 'saving' ? 'Saving...' : 'Save as Default'}
              </button>
              {broadcastStatus === 'sent' && broadcastResult && (
                <span style={{ color: '#7D9B76', fontSize: '0.78rem' }}>
                  ✓ Sent to {broadcastResult.sent}{broadcastResult.failed > 0 ? `, ${broadcastResult.failed} failed` : ''}
                </span>
              )}
              {broadcastStatus === 'error' && <span className="field-error">Failed to send. Please try again.</span>}
              {broadcastSaveStatus === 'saved' && (
                <span style={{ color: '#7D9B76', fontSize: '0.78rem' }}>✓ Saved as default</span>
              )}
              {settingsError && <span className="field-error">{settingsError}</span>}
            </div>
          </div>

          <div className="rate-setting">
            <label className="field-label">Tester List</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {testers.map(t => (
                <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85rem' }}>
                  <span style={{ flex: 1 }}>{t.name} — {t.phone}</span>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => removeTester(t.id)}>Remove</button>
                </div>
              ))}
              {testers.length === 0 && <p className="empty" style={{ padding: '8px 0' }}>No testers added yet.</p>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Name"
                value={newTesterName}
                onChange={e => setNewTesterName(e.target.value)}
                style={{ flex: 1, minWidth: 100, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.9rem' }}
              />
              <input
                placeholder="(415) 555-0100"
                value={newTesterPhone}
                onChange={e => setNewTesterPhone(e.target.value)}
                style={{ flex: 1, minWidth: 130, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.9rem' }}
              />
              <button className="btn-secondary" style={{ padding: '6px 14px' }} disabled={savingTester} onClick={addTester}>Add</button>
            </div>
            {testersError && <div className="field-error" style={{ marginTop: 8 }}>{testersError}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (selectedOwner) {
    // Past Stays opens an owner, not a dog (Sept 18, 2026) - stays are
    // rendered with the same shared card as Unbilled Stays (see
    // renderStayCard above), so "resend" is really just sendBill again:
    // any correction is saved and billed_at is stamped fresh.
    return (
      <div className="admin-overlay">
        <div className="admin-panel">
          <div className="admin-header">
            <button className="back-btn" onClick={() => setSelectedOwnerPhone(null)}>← All Owners</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <h2>{selectedOwner.ownerName}</h2>
          <p className="admin-owner">{selectedOwner.dogNames.join(', ')}</p>
          <div className="stay-history">
            {selectedOwner.stays.map(renderStayCard)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-overlay">
      <div className="admin-panel">
        <div className="admin-header">
          <h2>Bayview Boarding — Admin</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="rate-setting requests-section">
          <label className="field-label">
            Requests {pendingRequests.length > 0 && <span className="feedback-badge" style={{ marginLeft: 6 }}>{pendingRequests.length}</span>}
          </label>
          {pendingRequests.length === 0 && <p className="empty" style={{ padding: '8px 0' }}>No pending requests right now.</p>}
          <div className="stay-history">
            {pendingRequests.map(renderRequestCard)}
          </div>
        </div>

        <div className="rate-setting unbilled-section">
          <label className="field-label">
            Unbilled Stays {unbilledStays.length > 0 && <span className="feedback-badge" style={{ marginLeft: 6 }}>{unbilledStays.length}</span>}
          </label>
          {unbilledStays.length === 0 && <p className="empty" style={{ padding: '8px 0' }}>Nothing to bill right now.</p>}
          <div className="stay-history">
            {unbilledStays.map(renderStayCard)}
          </div>
        </div>

        <div className="rate-setting awaiting-payment-section">
          <label className="field-label">
            Awaiting Payment {awaitingPaymentStays.length > 0 && <span className="feedback-badge" style={{ marginLeft: 6 }}>{awaitingPaymentStays.length}</span>}
          </label>
          {awaitingPaymentStays.length === 0 && <p className="empty" style={{ padding: '8px 0' }}>Nothing billed and awaiting payment right now.</p>}
          <div className="stay-history">
            {awaitingPaymentStays.map(renderStayCard)}
          </div>
        </div>

        <div className="rate-setting past-stays-section">
          <label className="field-label">Past Stays</label>
          <input className="search-input" placeholder="Search by owner or dog name..." value={search} onChange={e => setSearch(e.target.value)} />
          {filteredOwners.length === 0 && !loading && <p className="empty">No records found.</p>}
          <div className="dog-list">
            {filteredOwners.map((o, i) => (
              <div key={i} className="dog-row" onClick={() => setSelectedOwnerPhone(o.ownerPhone)}>
                <div className="dog-row-left">
                  <div className="dog-row-name">{o.ownerName}</div>
                  <div className="dog-row-owner">{o.dogNames.join(', ')}</div>
                </div>
                <div className="dog-row-right">
                  <span className="stay-count">{o.stays.length} stay{o.stays.length !== 1 ? 's' : ''}</span>
                  <span className="chevron">›</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <h3 className="admin-section-header">Site Settings</h3>

        <div className="rate-setting calendar-backfill">
          <label className="field-label">Google Calendar</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-secondary" style={{ padding: '6px 14px' }} disabled={backfillingCalendar} onClick={backfillCalendar}>
              {backfillingCalendar ? 'Adding…' : 'Add Existing Stays to Calendar'}
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>
            {backfillCalendarStatus || 'One-time catch-up for approved, upcoming stays booked before the calendar sync existed. Safe to click more than once.'}
          </div>
        </div>

        <div className="rate-setting day-rate-editor">
          <label className="field-label">Day Rate (per 24 hours)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>$</span>
            <input type="number" value={editRate} onChange={e => setEditRate(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ dayRate: Number(editRate) })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>Billed by the fraction of a day · Current rate: ${formatMoney(rate)}/day</div>
        </div>

        <div className="rate-setting minimum-stay-editor">
          <label className="field-label">Minimum Stay (days)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" value={editMinimumStay} onChange={e => setEditMinimumStay(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ minimumStay: Number(editMinimumStay) })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>The shortest a stay is ever billed as, even for a same-day drop-in · Current: {minimumStay}-day minimum</div>
        </div>

        <div className="rate-setting discount-editor">
          <label className="field-label">2nd+ Dog Discount</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" value={editMultiDogDiscount} onChange={e => setEditMultiDogDiscount(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <span>%</span>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ multiDogDiscount: Number(editMultiDogDiscount) / 100 })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>Off each additional dog's nightly rate · Current: {multiDogDiscount * 100}%</div>
        </div>

        <div className="rate-setting holiday-editor">
          <label className="field-label">Holiday Upcharge</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" value={editHolidayUpcharge} onChange={e => setEditHolidayUpcharge(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <span>%</span>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ holidayUpcharge: Number(editHolidayUpcharge) / 100 })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>On holiday nights (New Year's, MLK, Ski Week, etc.) · Current: {holidayUpcharge * 100}%</div>
        </div>

        <div className="rate-setting vet-editor">
          <label className="field-label">Vet Clinics (booking form dropdown)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {editVets.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85rem' }}>
                <span style={{ flex: 1 }}>{v}</span>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => removeVet(i)}>Remove</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Clinic Name — (415) 555-0100"
              value={newVetText}
              onChange={e => setNewVetText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addVet()}
              style={{ flex: 1, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.9rem' }}
            />
            <button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={addVet}>Add</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ vets: editVets })}>Save Vet List</button>
          </div>
        </div>

        <div className="rate-setting packing-editor">
          <label className="field-label">Packing List (shown in reminder texts)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {editPackingList.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
                <input
                  aria-label={`Packing list item ${i + 1}`}
                  value={item}
                  onChange={e => editPackingItem(i, e.target.value)}
                  style={{ flex: 1, padding: '4px 8px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem', fontFamily: 'inherit' }}
                />
                <button
                  className="btn-secondary"
                  aria-label={`Move item ${i + 1} up`}
                  style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                  disabled={i === 0}
                  onClick={() => movePackingItem(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn-secondary"
                  aria-label={`Move item ${i + 1} down`}
                  style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                  disabled={i === editPackingList.length - 1}
                  onClick={() => movePackingItem(i, 1)}
                >
                  ↓
                </button>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => removePackingItem(i)}>Remove</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Item to bring"
              value={newPackingItemText}
              onChange={e => setNewPackingItemText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addPackingItem()}
              style={{ flex: 1, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.9rem' }}
            />
            <button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={addPackingItem}>Add</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ packingList: editPackingList })}>Save Packing List</button>
          </div>
        </div>

        <div className="rate-setting about-photos-editor">
          <label className="field-label">About Photos (shown on the home page)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {editAboutPhotos.map((p, i) => (
              <div key={p.path || p.src || i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
                <img
                  src={aboutPhotoSrc(p)}
                  alt={p.alt}
                  style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                />
                <input
                  aria-label={`Photo ${i + 1} alt text`}
                  placeholder="Alt text"
                  value={p.alt}
                  onChange={e => editPhotoAlt(i, e.target.value)}
                  style={{ flex: 1, padding: '4px 8px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem', fontFamily: 'inherit' }}
                />
                <button
                  className="btn-secondary"
                  aria-label={`Move photo ${i + 1} up`}
                  style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                  disabled={i === 0}
                  onClick={() => movePhoto(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn-secondary"
                  aria-label={`Move photo ${i + 1} down`}
                  style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                  disabled={i === editAboutPhotos.length - 1}
                  onClick={() => movePhoto(i, 1)}
                >
                  ↓
                </button>
                <button
                  className="btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                  disabled={!p.path || deletingPhotoPath === p.path}
                  onClick={() => removePhoto(p.path)}
                >
                  {deletingPhotoPath === p.path ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ))}
            {editAboutPhotos.length === 0 && <p className="empty" style={{ padding: '8px 0' }}>No photos yet.</p>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept="image/*"
              aria-label="Upload a photo"
              disabled={uploadingPhoto}
              onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; uploadPhoto(file); }}
            />
            {uploadingPhoto && <span style={{ fontSize: '0.78rem', color: '#6B7A8A' }}>Uploading...</span>}
          </div>
          {photoActionError && <div className="field-error" style={{ marginTop: 6 }}>{photoActionError}</div>}
          <div style={{ marginTop: 8 }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ aboutPhotos: editAboutPhotos })}>Save Photo Order</button>
          </div>
        </div>

        <div className="rate-setting sms-editor">
          <label className="field-label">SMS Message Templates</label>
          <div style={{ fontSize: '0.72rem', color: '#6B7A8A', marginBottom: 10 }}>
            Placeholders: {'{firstName} {dogName} {dogVerb} {dropDate} {dropTime} {pickDate} {pickTime} {estimatedCost} {finalCost} {billingBreakdown} {packingList} {primaryManagerPhone} {secondaryManagerPhone} {denialReason} (Booking Declined only)'}
          </div>

          <div className="text-footer-editor" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#2C3E50', marginBottom: 4 }}>Text Message Footer</div>
            <div style={{ fontSize: '0.72rem', color: '#6B7A8A', marginBottom: 4 }}>
              Appended once, automatically, to the end of every outbound text below - not stored in each one separately.
            </div>
            <textarea
              value={editSmsFooter}
              onChange={e => setEditSmsFooter(e.target.value)}
              rows={2}
              style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.82rem', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <button
                className="btn-primary"
                style={{ padding: '6px 14px' }}
                disabled={savingSettings}
                onClick={() => saveSettings({ smsFooter: editSmsFooter })}
              >
                Save Footer Text
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ padding: '6px 14px' }}
                onClick={() => setEditSmsFooter(DEFAULT_SMS_FOOTER)}
              >
                Reset to Default
              </button>
            </div>
          </div>

          <div className="manager-phones-editor" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#2C3E50', marginBottom: 4 }}>Manager Phone Numbers</div>
            <div style={{ fontSize: '0.72rem', color: '#6B7A8A', marginBottom: 4 }}>
              Fill {'{primaryManagerPhone}'}/{'{secondaryManagerPhone}'} above and anywhere else used in a template - never shown to a public site visitor.
            </div>
            <div className="field-row">
              <Field label="Manager 1 Phone">
                <input
                  type="tel"
                  value={editPrimaryManagerPhone}
                  onChange={e => setEditPrimaryManagerPhone(e.target.value)}
                  placeholder="(415) 555-0100"
                />
              </Field>
              <Field label="Manager 2 Phone">
                <input
                  type="tel"
                  value={editSecondaryManagerPhone}
                  onChange={e => setEditSecondaryManagerPhone(e.target.value)}
                  placeholder="(415) 555-0100"
                />
              </Field>
            </div>
            <button
              className="btn-primary"
              style={{ padding: '6px 14px', marginTop: 6 }}
              disabled={savingSettings}
              onClick={() => saveSettings({ primaryManagerPhone: editPrimaryManagerPhone, secondaryManagerPhone: editSecondaryManagerPhone })}
            >
              Save Phone Numbers
            </button>
          </div>

          {[
            { key: 'requestReceived', label: 'Booking Request Received' },
            { key: 'confirmation', label: 'Booking Confirmation' },
            { key: 'denied', label: 'Booking Declined' },
            { key: 'reminder', label: 'Drop-off Reminder' },
            { key: 'pickupReminder', label: 'Pickup Reminder' },
            { key: 'billing', label: 'Billing' },
          ].map(({ key, label }) => (
            <div key={key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#2C3E50', marginBottom: 4 }}>{label}</div>
              <textarea
                value={editSms[key]}
                onChange={e => setEditSms(s => ({ ...s, [key]: e.target.value }))}
                rows={3}
                style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.82rem', fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <button
                  className="btn-primary"
                  style={{ padding: '6px 14px' }}
                  disabled={savingSettings}
                  onClick={() => saveSettings({ [`sms${key.charAt(0).toUpperCase()}${key.slice(1)}`]: editSms[key] })}
                >
                  Save {label} Text
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: '6px 14px' }}
                  onClick={() => setEditSms(s => ({ ...s, [key]: DEFAULT_SMS_TEMPLATES[key] }))}
                >
                  Reset to Default
                </button>
              </div>
            </div>
          ))}
        </div>
        {settingsError && <div className="field-error" style={{ marginBottom: 12 }}>{settingsError}</div>}

        <div className="admin-entry-row">
          <button className="btn-secondary feedback-entry" onClick={() => setShowFeedback(true)}>
            <span>💡 Ideas &amp; Bugs</span>
            {feedbackOpenCount > 0 && <span className="feedback-badge">{feedbackOpenCount}</span>}
          </button>
          <button className="btn-secondary feedback-entry" onClick={() => setShowTesters(true)}>
            <span>📢 Testers</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// The About content used to live on its own separate page, one tap away
// via "Learn more" - a real tester ("JK") flagged that extra tap as
// unnecessary friction (Submit Idea, Sept 19, 2026): "I should be able
// to scroll down and see everything you currently have on the About Us
// page." Landing now renders its own hero, then AboutContent directly
// below it in normal page flow - "Learn more" (and the nav menu's
// "About Us", from anywhere else in the app - see App's scrollToAbout)
// scrolls to it instead of navigating to a separate screen.
function Landing({ onStart, onLearnMore, aboutSectionRef, aboutPhotos }) {
  return (
    <>
      <div className="landing">
        <img className="landing-img" src={heroDog} alt="A happy dog boarding with Bayview Boarding on a Marin hillside trail" />
        <div className="landing-overlay">
          <div className="landing-top">
            <h1 className="landing-title landing-title--link" onClick={onLearnMore}>Bayview Boarding</h1>
          </div>
          <div className="landing-bottom">
            <button className="landing-cta" onClick={onStart}>Book My Stay</button>
            <button className="landing-learn-more" onClick={onLearnMore}>New? Learn more →</button>
          </div>
        </div>
      </div>
      <div className="about" ref={aboutSectionRef}>
        <div className="about-content">
          <AboutContent onStart={onStart} aboutPhotos={aboutPhotos} />
        </div>
      </div>
    </>
  );
}

// Every 5-star review from the Rover profile's 18 reviews, newest first -
// the one 4-star review (Megan S., Aug 23 2023, a mixed "somewhat awkward
// introductions" note) is deliberately left out since it isn't glowing.
const ABOUT_REVIEWS = [
  { author: 'Aiste B.', date: 'Jun 15, 2026', quote: "Kim and Estee were amazing! They took care of our boy Lincoln like he was their own and gave him all the love, patience and off leash time. We're very lucky to have found them and will definitely work with them again!" },
  { author: 'Sue E.', date: 'Apr 30, 2026', quote: 'Great. Very flexible host easy to work with. Dog centric.' },
  { author: 'Caitlin C.', date: 'Apr 06, 2026', quote: 'We are very particular with who we leave our dog with since he needs lots of exercise and attention to be his best self. Kim and Estee took great care of him - from long hikes from the house to playing with other dogs in their beautiful backyard, he got plenty of exercise. They have a great setup for hosting dogs and were very communicative - sending pictures during his stay and taking time before hand to learn his routines and preferences. We were very happy to find a wonderful place for Moxie to get such great care when we are away - thank you!' },
  { author: 'Jordan & Kyle R.', date: 'Mar 14, 2026', quote: 'Took great care of our pup. Very communicative. Sent photos regularly. Would definitely have our pup board with Kim again. Thanks!' },
  { author: 'Andi H.', date: 'Oct 24, 2025', quote: 'My dog wagged her tail from beginning to end. She loved going on off leash hikes in the trails right outside their door. Very friendly "dog people", just my kind of people.' },
  { author: 'Ellie L.', date: 'Aug 15, 2025', quote: "Pemmy had the most fantastic time, and I was always at ease that she was being treated well. I feel okay about traveling now because I know she'll be cared for." },
  { author: 'Christian M.', date: 'Apr 18, 2025', quote: "Can't recommend enough. Home was a dream for our Goldie." },
  { author: 'Todd S.', date: 'Jan 08, 2025', quote: "We couldn't be happier with the care Kim provided for our dog, Boots! From the very start, during the initial meet and greet, we knew Boots was in excellent hands. Kim's calm and friendly demeanor immediately put us at ease, and Boots took to him right away. Throughout Boots' stay, Kim kept us updated with regular messages and adorable photos, which really helped us feel connected while we were away. Our travel plans unexpectedly changed, and Kim was incredibly accommodating, extending Boots' stay without hesitation. We wholeheartedly recommend Kim to anyone looking for a trustworthy, attentive, and compassionate dog sitter." },
  { author: 'John K.', date: 'Dec 02, 2024', quote: 'Kim provided excellent care of our dog Jasper. We recommend him highly for your pets care and will not hesitate to use him ourselves when the need arises.' },
  { author: 'Kristine Q.', date: 'Dec 05, 2023', quote: "Kim was an amazing Rover! He was very kind and communicative and clearly just has a deep love of all dogs. We really appreciated him taking great care of our pup (who isn't always the easiest dog to manage) and being so great throughout!" },
  { author: 'Steve C.', date: 'Nov 27, 2023', quote: 'Great experience having Kim and Estee care for our dog this past week. Great care and our dog Tyson was happy playing with other well behaved dogs. Will be book again, no question.' },
  { author: 'Avi D.', date: 'Nov 27, 2023', quote: 'Kim and Estee were great. Our Daisy seemed happy and well cared for and it sounded like she got lots of exercise doing long hikes during her stay. Very grateful to have found this option for when we travel. Will definitely book again.' },
  { author: 'Jennifer G.', date: 'Oct 09, 2023', quote: 'Our dog had an immediate connection with them and seemed happy and at ease when we picked her up from her short stay. Communication was easy. We will definitely book another stay.' },
  { author: 'Stephen D.', date: 'Sep 29, 2023', quote: 'Our pup had a great time with Kim and his wife! They went for a few local hikes and hung out by the pool. Communication was super easy. Happy to have Kim watch our pup again anytime.' },
  { author: 'Peter S.', date: 'Aug 17, 2023', quote: 'Kim was great with our Buddy. We had another sitter fall through about a week before our trip and found Kim just in the nick of time. Kim and Estee were warm and welcoming to us and to Buddy. Throughout the stay Kim was communicative and shared photos of their hiking adventures. We will definitely be booking with Kim again!' },
  { author: 'Megan O.', date: 'Nov 29, 2022', quote: 'Kim was wonderful. They have a very comfortable and welcoming home. He sent several pictures with my puppy, so that I could be updated on his well-being. Overall; I would highly recommend Kim!' },
  { author: 'Rennie G.', date: 'Nov 18, 2022', quote: "We are very happy with Kim's care of Dusty for this one night stay. Kim was very attentive and kept us informed. We are comfortable leaving Dusty in Kim's care and will be boarding Dusty for longer stays with Kim in the near future." },
];

// Fallback only (Sept 21, 2026) - used until the public settings fetch
// resolves, or if it/Supabase Storage is ever unreachable, so the About
// section never shows literally no photos at all. The real,
// admin-manageable list now lives in Supabase (settings.about_photos,
// see the migration + Admin > About Photos) with the actual image files
// in Storage instead of this git-tracked public/ folder - these 6 were
// migrated there directly, so in normal operation this constant is
// never actually rendered, only kept as a safety net.
const DEFAULT_ABOUT_PHOTOS = [
  { src: `${process.env.PUBLIC_URL}/img/about/1-choco.jpeg`, alt: 'Choco' },
  { src: `${process.env.PUBLIC_URL}/img/about/2-milo.jpeg`, alt: 'Milo' },
  { src: `${process.env.PUBLIC_URL}/img/about/3-china-camp-shoreline-trail.jpg`, alt: 'China Camp shoreline trail' },
  { src: `${process.env.PUBLIC_URL}/img/about/4-bayview-dog-room.jpg`, alt: 'The dog room at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/5-bayview-acre.jpg`, alt: 'The acre at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/6-china-camp-bay-line.jpg`, alt: 'China Camp, along the bay' },
];

// Resolves either shape a photo entry can be in: the hardcoded fallback
// above (already a full `src` URL, no Supabase Storage involved at all -
// deliberately self-contained so it still works even if Storage itself
// is ever unreachable) or a live one fetched from settings.about_photos
// (just a `path` within the "about-photos" Storage bucket - getPublicUrl
// is a pure string-construction call, not a network request, so this is
// cheap to call inline at render time for every photo).
function aboutPhotoSrc(photo) {
  if (photo.src) return photo.src;
  return supabase.storage.from('about-photos').getPublicUrl(photo.path).data.publicUrl;
}

// Approximate-location map (About page "Location" section). A specific
// point Kim placed ~300 yards past the actual address (Sept 16, 2026),
// not the real street address itself - see the note in that section's
// own text. The embed (iframe) uses the coordinates directly; the click-
// through link reuses Kim's own Google Maps short link verbatim rather
// than reconstructing one, so it's guaranteed to open the exact same spot
// he picked.
const ABOUT_MAP_COORDS = '37.980802,-122.484319';
const ABOUT_MAP_EMBED_URL = `https://maps.google.com/maps?q=${ABOUT_MAP_COORDS}&z=16&output=embed`;
const ABOUT_MAP_LINK_URL = 'https://maps.app.goo.gl/xWg4sCFVpevDCKd16';

// The base profile URL, reused as-is by both the visible "21 ratings on
// Rover" link below (with its own #:~:text= scroll-to-review fragment
// appended) and the LocalBusiness structured data's sameAs (Sept 23,
// 2026) - kept as one constant so the two can't drift apart.
const ROVER_PROFILE_URL = 'https://www.rover.com/members/kim-m-dog-paradise-above-loch-lomond/';

// Content adapted from the Bayview Boarding Rover profile - embedded
// directly on the Landing page (see Landing above) rather than behind
// its own "Learn more" tap, so first-time visitors can see who they're
// trusting with their dog just by scrolling, before they commit to
// starting the booking flow.
function AboutContent({ onStart, aboutPhotos }) {
  // Injects LocalBusiness structured data (Sept 23, 2026, on request) -
  // every field here mirrors something already visibly on this page
  // (name, phone, city/state, the same already-fuzzed map point used by
  // the Location section below - never the exact address, same privacy
  // stance - and the 5.0/21-ratings figures shown just below the
  // gallery), which is what Google's structured-data guidelines
  // actually require: it must match visible content, not add anything
  // new. AboutContent only renders as part of Landing, so this only
  // mounts once per visit to the landing page - but Landing itself
  // unmounts/remounts when navigating mid-booking back to it via the
  // header wordmark (see that test), so cleanup on unmount matters here
  // to avoid piling up duplicate <script> tags in <head> each time.
  useEffect(() => {
    const [latitude, longitude] = ABOUT_MAP_COORDS.split(',').map(Number);
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'Bayview Boarding',
      // Kept in sync by hand with public/index.html's meta description -
      // same duplication trade-off already accepted there for og:image
      // (see CLAUDE.md's SEO & Analytics section).
      description: 'Home-based dog boarding in San Rafael, CA, run by Kim Miller and Estee Fletter. Book a stay, see photos and reviews, and get an instant cost estimate.',
      image: `${window.location.origin}${process.env.PUBLIC_URL}/img/hero-dog.jpg`,
      url: `${window.location.origin}${process.env.PUBLIC_URL}/`,
      telephone: SETTINGS.PHONE,
      address: { '@type': 'PostalAddress', addressLocality: 'San Rafael', addressRegion: 'CA', addressCountry: 'US' },
      geo: { '@type': 'GeoCoordinates', latitude, longitude },
      sameAs: [ROVER_PROFILE_URL],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '5.0', reviewCount: '21', bestRating: '5' },
    });
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  return (
    <>
      <h1 className="about-title about-title--center">Dog Paradise <br />Above <br />Loch Lomond</h1>
      <p className="about-tagline">
        Home-based dog boarding in San Rafael, CA, in Marin County's Loch
        Lomond neighborhood, right at the China Camp State Park trailhead.
      </p>
      <p>
          We specialize in providing a consistent family experience for your
          dog to come back to time and again. Our home sits on the China Camp
          State Park trailhead, a favorite location for dogs to take every
          kind of walk from short walks to vigorous hikes all the way up to
          the top.
        </p>
        <p>
          Being retired, we look after dogs for the love of dogs and nothing
          more. We do best with well-trained dogs who thrive on long,
          off-leash hikes. Generally we like to build long-term relationships
          where we can get to know your lovely family member and be the
          country home your pup comes back to again and again.
        </p>

        <div className="about-gallery">
          {aboutPhotos.map((p, i) => (
            <img key={p.path || p.src || i} className="about-gallery-img" src={aboutPhotoSrc(p)} alt={p.alt} loading="lazy" />
          ))}
        </div>

        <h2 className="about-subhead">Where your pet will stay</h2>
        <ul className="about-facts">
          <li>Lives in a house</li>
          <li>Has a fenced yard</li>
          <li>Non-smoking household</li>
          <li>Has no pets</li>
          <li>No children present</li>
          <li>Dogs not allowed on bed</li>
          <li>Dogs not allowed on furniture</li>
          <li>Potty breaks every 0-2 hours</li>
        </ul>

        <h3 className="about-subhead about-subhead--minor">Safety, trust &amp; environment</h3>
        <p>
          Our mid-century modern home is perched over the Bay and has a
          special dog room that is also our office - so we are with your dog
          the whole time. The dog room has access to the outdoors if your dog is
          smaller and can be kept in with fencing, or closed off for larger
          dogs if necessary.
        </p>

        <h2 className="about-subhead">A typical day</h2>
        <p>
          We will go on frequent walks, including more vigorous walks if
          appropriate, in the adjacent 1,500-acre China Camp State Park that
          is steps from our home.
        </p>

        <h2 className="about-subhead">Location</h2>
        <p>
          We're in the Loch Lomond neighborhood of San Rafael, right at the
          China Camp State Park trailhead - map below shows a nearby point,
          not our exact address; we'll share that once your stay is booked.
        </p>
        <div className="about-map">
          <iframe
            title="Approximate location - Loch Lomond, San Rafael, CA"
            src={ABOUT_MAP_EMBED_URL}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
          <a
            className="about-map-overlay"
            href={ABOUT_MAP_LINK_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open this location in Google Maps"
          />
        </div>

        <h2 className="about-subhead">Schedule</h2>
        <p>
          We are home throughout the week, early risers, and readily
          available to care for your dog with walks, play time, and fetch.
        </p>

        <div className="about-rating">
          <span className="stars-inline">★★★★★</span> <strong>5.0</strong> ·{' '}
          <a
            className="link-blue"
            href={`${ROVER_PROFILE_URL}#:~:text=be%20cared%20for.-,View,-all`}
            target="_blank"
            rel="noopener noreferrer"
          >
            21 ratings on Rover
          </a>
        </div>
        <div className="about-reviews">
          {ABOUT_REVIEWS.map((r, i) => (
            <div className="about-review" key={i}>
              <p className="about-review-stars" aria-label="5 out of 5 stars">★★★★★</p>
              <p className="about-review-quote">"{r.quote}"</p>
              <p className="about-review-author">— {r.author} · {r.date}</p>
            </div>
          ))}
        </div>

      <button className="landing-cta" onClick={onStart}>Book My Stay</button>
    </>
  );
}

// Hamburger nav - one instance, rendered by App itself on every screen
// (landing+about, contact, and the booking flow), rather than duplicated
// per page. Fixed-position, dark translucent pill so it reads over both
// the hero photo and plain white pages without needing per-page theming.
// Admin is back in this menu (Sept 2026), a deliberate reversal of the
// earlier "no visible Admin entry point" decision (v1.5.13) per explicit
// request - it's still fully password-gated server-side (see AdminView),
// so this trades obscurity for convenience, not security.
function NavMenu({ onAbout, onContact, onSubmitIdea, onBookStay, onAdmin }) {
  const [open, setOpen] = useState(false);

  function go(handler) {
    setOpen(false);
    handler();
  }

  return (
    <div className="nav-menu">
      <button
        className="nav-menu-toggle"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {open ? '✕' : '☰'}
      </button>
      {open && (
        <>
          <div className="nav-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="nav-menu-panel">
            <button className="nav-menu-item" onClick={() => go(onBookStay)}>Book a Stay</button>
            <button className="nav-menu-item" onClick={() => go(onAbout)}>About Us</button>
            <button className="nav-menu-item" onClick={() => go(onContact)}>Contact Us</button>
            <button className="nav-menu-item" onClick={() => go(onSubmitIdea)}>Submit Idea</button>
            <button className="nav-menu-item" onClick={() => go(onAdmin)}>Admin</button>
          </div>
        </>
      )}
    </div>
  );
}

// Public contact form - relayed via SMS to Kim & Estee by the send-contact
// Edge Function (reuses the KIM_PHONE/ESTEE_PHONE secrets already set up
// for receive-sms, rather than standing up a separate email service).
function ContactUs({ onBack }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  // Pure - no state writes - so it can drive the Send button's disabled
  // state on every render (see the established getErrors/validate split
  // used throughout the booking flow).
  function getErrors() {
    const e = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.message.trim()) e.message = 'Required';
    if (!form.email.trim() && !form.phone.trim()) e.contact = 'Enter an email or phone number';
    return e;
  }

  const canSend = Object.keys(getErrors()).length === 0;

  async function handleSend() {
    const e = getErrors();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setStatus('sending');
    const { data, error } = await supabase.functions.invoke('send-contact', { body: form });
    if (error || data?.error) {
      setStatus('error');
      return;
    }
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="about">
        <div className="about-content">
          <button className="back-btn" onClick={onBack}>← Back</button>
          <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Message sent!</h1>
          <p style={{ textAlign: 'center' }}>Thanks, {form.name.split(' ')[0]} — we'll get back to you soon.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="about">
      <div className="about-content">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Contact Us</h1>
        <p>
          Questions about a stay, availability, or anything else - send us a
          message and we'll get back to you.
        </p>
        <Field label="Your Name" error={errors.name}>
          <input value={form.name} onChange={e => update('name', e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Email" error={errors.contact}>
          <input value={form.email} onChange={e => update('email', e.target.value)} placeholder="jane@email.com" type="email" />
        </Field>
        <Field label="Phone (optional if email given)">
          <input value={form.phone} onChange={e => update('phone', e.target.value)} placeholder="(415) 555-0100" type="tel" />
        </Field>
        <Field label="Message" error={errors.message}>
          <textarea value={form.message} onChange={e => update('message', e.target.value)} placeholder="How can we help?" rows={5} />
        </Field>
        {status === 'error' && (
          <div className="field-error" style={{ marginBottom: 12 }}>
            Something went wrong sending your message. Please try again, or text us directly.
          </div>
        )}
        <button className="landing-cta" style={{ width: '100%', boxShadow: 'none' }} disabled={!canSend || status === 'sending'} onClick={handleSend}>
          {status === 'sending' ? 'Sending...' : 'Send Message'}
        </button>
      </div>
    </div>
  );
}

// "Submit Idea" - lets testers report bugs/ideas without costing anything
// per submission (SMS costs money; this is just a DB write). Persisted in
// `feedback` rather than texted, so it's an actual reviewable queue in
// admin (open/considered/done) instead of scrollback in a text thread -
// see the migration for the full rationale.
function SubmitIdea({ onBack }) {
  const [form, setForm] = useState({ message: '', name: '', contact: '' });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  function getErrors() {
    const e = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.message.trim()) e.message = 'Required';
    return e;
  }

  const canSend = Object.keys(getErrors()).length === 0;

  async function handleSend() {
    const e = getErrors();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setStatus('sending');
    const { data, error } = await supabase.functions.invoke('feedback', { body: form });
    if (error || data?.error) {
      setStatus('error');
      return;
    }
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="about">
        <div className="about-content">
          <button className="back-btn" onClick={onBack}>← Back</button>
          <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Thanks!</h1>
          <p style={{ textAlign: 'center' }}>We've got it and will take a look.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="about">
      <div className="about-content">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Submit Idea</h1>
        <p>
          Found a bug, or have an idea to make this better? List as many as
          you'd like in one message - every one gets reviewed.
        </p>
        <Field label="Your Name" error={errors.name}>
          <input value={form.name} onChange={e => update('name', e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Ideas / Bugs" error={errors.message}>
          <textarea
            value={form.message}
            onChange={e => update('message', e.target.value)}
            placeholder={'Feel free to list as many as you\'d like, e.g.:\n1. ...\n2. ...\n3. ...'}
            rows={8}
          />
        </Field>
        <Field label="Email or Phone (optional, in case we follow up)">
          <input value={form.contact} onChange={e => update('contact', e.target.value)} placeholder="jane@email.com" />
        </Field>
        {status === 'error' && (
          <div className="field-error" style={{ marginBottom: 12 }}>
            Something went wrong sending this. Please try again.
          </div>
        )}
        <button className="landing-cta" style={{ width: '100%', boxShadow: 'none' }} disabled={!canSend || status === 'sending'} onClick={handleSend}>
          {status === 'sending' ? 'Sending...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [showLanding, setShowLanding] = useState(true);
  const [showContact, setShowContact] = useState(false);
  const [showSubmitIdea, setShowSubmitIdea] = useState(false);
  const [step, setStep] = useState(0);
  // Admin has no visible entry point in the UI anymore - reached only via a
  // bookmarked URL (?admin), e.g. https://.../bayview-boarding/?admin
  const [showAdmin, setShowAdmin] = useState(() => new URLSearchParams(window.location.search).has('admin'));
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [currentStay, setCurrentStay] = useState(null);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [minimumStay, setMinimumStay] = useState(DEFAULT_MINIMUM_STAY);
  const [multiDogDiscount, setMultiDogDiscount] = useState(DEFAULT_MULTI_DOG_DISCOUNT);
  const [holidayUpcharge, setHolidayUpcharge] = useState(DEFAULT_HOLIDAY_UPCHARGE);
  const [vets, setVets] = useState(DEFAULT_VETS);
  const [packingList, setPackingList] = useState(DEFAULT_PACKING_LIST);
  const [aboutPhotos, setAboutPhotos] = useState(DEFAULT_ABOUT_PHOTOS);
  const [smsTemplates, setSmsTemplates] = useState(DEFAULT_SMS_TEMPLATES);
  const [smsFooter, setSmsFooter] = useState(DEFAULT_SMS_FOOTER);

  // Admin-configurable settings (day rate, multi-dog discount, holiday
  // upcharge, vet list, packing list, SMS templates - Sept 16, 2026 added
  // the last two) are persisted in Supabase now, not hardcoded - every
  // visitor needs the current values to see correct pricing and the
  // current vet list, so this is a public, unauthenticated read (see
  // supabase/functions/settings/index.ts), not gated behind admin login.
  // The hook-declared defaults above are just what's shown until this
  // resolves.
  useEffect(() => {
    supabase.functions.invoke('settings', { body: {} }).then(({ data, error }) => {
      if (error || !data || data.error) return; // keep the defaults
      if (typeof data.dayRate === 'number') setRate(data.dayRate);
      if (typeof data.minimumStay === 'number') setMinimumStay(data.minimumStay);
      if (typeof data.multiDogDiscount === 'number') setMultiDogDiscount(data.multiDogDiscount);
      if (typeof data.holidayUpcharge === 'number') setHolidayUpcharge(data.holidayUpcharge);
      if (Array.isArray(data.vets)) setVets(data.vets);
      if (Array.isArray(data.packingList)) setPackingList(data.packingList);
      if (data.smsConfirmation || data.smsReminder || data.smsBilling || data.smsPickupReminder || data.smsRequestReceived || data.smsDenied) {
        setSmsTemplates({
          confirmation: data.smsConfirmation ?? DEFAULT_SMS_TEMPLATES.confirmation,
          reminder: data.smsReminder ?? DEFAULT_SMS_TEMPLATES.reminder,
          billing: data.smsBilling ?? DEFAULT_SMS_TEMPLATES.billing,
          pickupReminder: data.smsPickupReminder ?? DEFAULT_SMS_TEMPLATES.pickupReminder,
          requestReceived: data.smsRequestReceived ?? DEFAULT_SMS_TEMPLATES.requestReceived,
          denied: data.smsDenied ?? DEFAULT_SMS_TEMPLATES.denied,
        });
      }
      if (data.smsFooter) setSmsFooter(data.smsFooter);
      // Unlike vets/packingList, an empty list here is valid (a real,
      // if unlikely, "no photos uploaded yet" state) - always trust the
      // live fetch once it resolves, rather than only overriding the
      // fallback when non-empty.
      if (Array.isArray(data.aboutPhotos)) setAboutPhotos(data.aboutPhotos);
    }).catch(() => {}); // network hiccup - keep the defaults, don't crash the page
  }, []);

  function emptyForm() {
    return {
      ownerName: '', ownerPhone: '', ownerEmail: '',
      vetName: 'Select a Vet',
      dogs: [emptyDog()], // "Number of Dogs" defaults to 1, but is still freely editable (see setDogCountText)
      checkIn: '', checkOut: '', dropTime: '', pickupTime: '', notes: '',
      agreed: false, signature: '',
    };
  }

  const [form, setForm] = useState(emptyForm);

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  async function handleSubmit() {
    setSubmitting(true);
    const breakdown = calcCostBreakdown(form.checkIn, form.checkOut, form.dropTime, form.pickupTime, rate, form.dogs.length, multiDogDiscount, holidayUpcharge, minimumStay);
    const payload = {
      owner: {
        name: form.ownerName,
        phone: form.ownerPhone,
        email: form.ownerEmail.toLowerCase(),
        vetName: form.vetName,
      },
      dogs: form.dogs.map(d => ({
        name: d.name,
        breed: d.breed,
        dob: d.dob || null,
        spayNeuter: d.spayNeuter,
        aggressionHistory: d.aggressionHistory,
        aggressionDetail: d.aggressionDetail,
        healthConcerns: d.healthConcerns,
        healthDetail: d.healthDetail,
        photoPaths: d.photos.filter(p => p.path).map(p => p.path),
      })),
      checkIn: form.checkIn,
      checkOut: form.checkOut,
      dropTime: form.dropTime || null,
      pickupTime: form.pickupTime || null,
      notes: form.notes,
      estimatedCost: breakdown ? parseFloat(breakdown.total.toFixed(2)) : null,
      signature: form.signature,
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Exactly what was shown and agreed to at StepWaiver, captured at
      // submission time so a later edit to src/waiver.js can never
      // retroactively change what this client is on record as having
      // signed (Sept 16, 2026) - see the migration for the full rationale.
      waiverSnapshot: WAIVER_SECTIONS,
    };
    const { data: result, error } = await supabase.functions.invoke('submit-booking', { body: payload });
    setSubmitting(false);
    if (!error && result?.stay) {
      const stay = result.stay;
      const confirmation = {
        owner_name: stay.owner_name,
        dog_name: stay.dog_names.join(' & '),
        check_in: stay.check_in,
        check_out: stay.check_out,
        drop_time: stay.drop_time,
        pickup_time: stay.pickup_time,
        estimated_cost: stay.estimated_cost,
        cost_breakdown: breakdown,
        multi_dog_discount: multiDogDiscount,
      };
      setCurrentStay(confirmation);
      setSubmitted(true);
      // A submission is a request now, not an instant booking (Sept 21,
      // 2026, on request - see Submit Idea from Estee) - this text just
      // acknowledges receipt; the real confirmation only goes out once
      // admin approves it from the new admin Requests section
      // (approveRequest below).
      try {
        await supabase.functions.invoke('send-confirmation', {
          body: {
            type: 'request_received',
            owner_name: confirmation.owner_name,
            owner_phone: form.ownerPhone,
            dog_name: confirmation.dog_name,
            check_in: confirmation.check_in,
            check_out: confirmation.check_out,
            drop_time: confirmation.drop_time,
            pickup_time: confirmation.pickup_time,
            estimated_cost: confirmation.estimated_cost,
            message_template: smsTemplates.requestReceived,
          }
        });
      } catch (textErr) {
        console.error('Text send failed:', textErr);
      }
    } else {
      alert('There was an error saving. Please try again.');
    }
  }

  function reset() {
    setForm(emptyForm());
    setStep(0); setSubmitted(false); setCurrentStay(null);
  }

  const adminProps = {
    onClose: () => setShowAdmin(false),
    rate, setRate,
    minimumStay, setMinimumStay,
    multiDogDiscount, setMultiDogDiscount,
    holidayUpcharge, setHolidayUpcharge,
    vets, setVets,
    packingList, setPackingList,
    aboutPhotos, setAboutPhotos,
    smsTemplates, setSmsTemplates,
    smsFooter, setSmsFooter,
  };

  // Mutually-exclusive top-level views. Each nav function clears the
  // others explicitly rather than relying on ordering, so there's no way
  // to land on two views at once regardless of which one was previously
  // showing. About is no longer its own view (see Landing/AboutContent
  // above) - scrollToAbout below is what "About Us" and "Learn more"
  // both call instead of a goToAbout nav function.
  function goToLanding() { setShowLanding(true); setShowContact(false); setShowSubmitIdea(false); }
  function goToContact() { setShowContact(true); setShowLanding(false); setShowSubmitIdea(false); }
  function goToSubmitIdea() { setShowSubmitIdea(true); setShowLanding(false); setShowContact(false); }
  function goToBooking() { setShowLanding(false); setShowContact(false); setShowSubmitIdea(false); }

  // Scrolls to the embedded About section on the Landing page - if
  // Landing isn't currently showing, navigates there first and scrolls
  // once it's mounted (see the effect below, keyed off pendingScrollToAbout).
  const aboutSectionRef = useRef(null);
  const [pendingScrollToAbout, setPendingScrollToAbout] = useState(false);
  function scrollToAbout() {
    if (showLanding && aboutSectionRef.current) {
      aboutSectionRef.current.scrollIntoView({ behavior: 'smooth' });
    } else {
      goToLanding();
      setPendingScrollToAbout(true);
    }
  }
  useEffect(() => {
    if (showLanding && pendingScrollToAbout && aboutSectionRef.current) {
      aboutSectionRef.current.scrollIntoView({ behavior: 'smooth' });
      setPendingScrollToAbout(false);
    }
  }, [showLanding, pendingScrollToAbout]);

  const navMenu = (
    <NavMenu onAbout={scrollToAbout} onContact={goToContact} onSubmitIdea={goToSubmitIdea} onBookStay={goToBooking} onAdmin={() => setShowAdmin(true)} />
  );

  let pageContent;
  if (showContact) {
    pageContent = <ContactUs onBack={goToLanding} />;
  } else if (showSubmitIdea) {
    pageContent = <SubmitIdea onBack={goToLanding} />;
  } else if (showLanding) {
    pageContent = <Landing onStart={goToBooking} onLearnMore={scrollToAbout} aboutSectionRef={aboutSectionRef} aboutPhotos={aboutPhotos} />;
  } else {
    pageContent = (
      <>
        <Header onTitleClick={scrollToAbout} />
        <main className="main">
          {!submitted ? (
            <>
              <Progress step={step} />
              {step === 0 && (
                <StepOwner
                  data={form}
                  onChange={update}
                  onNext={() => setStep(1)}
                  vetOptions={vetDropdownOptions(vets)}
                  multiDogDiscount={multiDogDiscount}
                />
              )}
              {step === 1 && (
                <StepDates
                  data={form}
                  onChange={update}
                  onNext={() => setStep(step + 1)}
                  onBack={() => setStep(0)}
                  rate={rate}
                  minimumStay={minimumStay}
                  multiDogDiscount={multiDogDiscount}
                  holidayUpcharge={holidayUpcharge}
                />
              )}
              {step === 2 && <StepWaiver onNext={() => setStep(step + 1)} onBack={() => setStep(step - 1)} />}
              {step === 3 && <StepSign data={form} onChange={update} onSubmit={handleSubmit} onBack={() => setStep(step - 1)} ownerName={form.ownerName} submitting={submitting} />}
            </>
          ) : (
            <Confirmation stay={currentStay} onNewBooking={reset} />
          )}
        </main>
      </>
    );
  }

  return (
    <div className="app">
      {pageContent}
      {navMenu}
      {showAdmin && <AdminView {...adminProps} />}
    </div>
  );
}
