import { useState } from 'react';
import { supabase } from './supabase';
import { WAIVER_SECTIONS } from './waiver';
import { formatDate, calcAge, todayISO, calcCostBreakdown, formatMoney, emptyDog, dogIsComplete, vetDropdownOptions } from './calc';
import CostBreakdown from './CostBreakdown';
import Field from './Field';

// The entire booking wizard (Owner Info -> Dog pages -> Stay Dates ->
// Waiver -> Sign -> Confirmation) - split into its own lazy-loaded chunk
// (Sept 30, 2026, on request - code-splitting for mobile PageSpeed),
// since a first-time visitor's very first paint is the Landing page,
// which needs none of this. App.js loads this behind React.lazy() only
// once the visitor actually clicks "Book a Stay" (or lands on the
// bookmarked ?book URL).

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

// The wrapper App.js actually lazy-loads - same props/JSX shape as what
// used to be inline in App()'s own render (the `else` branch of
// pageContent), just relocated so it can be its own chunk. App.js still
// owns all the real state (form, step, submitted, etc.) and the pricing
// settings (rate/minimumStay/multiDogDiscount/holidayUpcharge/vets) -
// this component is pure presentation/step-routing over what it's given.
export default function BookingFlow({
  onTitleClick, step, setStep, submitted, form, onChange, vets,
  multiDogDiscount, rate, minimumStay, holidayUpcharge,
  onSubmit, submitting, currentStay, onNewBooking,
}) {
  return (
    <>
      <Header onTitleClick={onTitleClick} />
      <main className="main">
        {!submitted ? (
          <>
            <Progress step={step} />
            {step === 0 && (
              <StepOwner
                data={form}
                onChange={onChange}
                onNext={() => setStep(1)}
                vetOptions={vetDropdownOptions(vets)}
                multiDogDiscount={multiDogDiscount}
              />
            )}
            {step === 1 && (
              <StepDates
                data={form}
                onChange={onChange}
                onNext={() => setStep(step + 1)}
                onBack={() => setStep(0)}
                rate={rate}
                minimumStay={minimumStay}
                multiDogDiscount={multiDogDiscount}
                holidayUpcharge={holidayUpcharge}
              />
            )}
            {step === 2 && <StepWaiver onNext={() => setStep(step + 1)} onBack={() => setStep(step - 1)} />}
            {step === 3 && <StepSign data={form} onChange={onChange} onSubmit={onSubmit} onBack={() => setStep(step - 1)} ownerName={form.ownerName} submitting={submitting} />}
          </>
        ) : (
          <Confirmation stay={currentStay} onNewBooking={onNewBooking} />
        )}
      </main>
    </>
  );
}
