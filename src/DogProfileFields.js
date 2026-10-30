import { supabase } from './supabase';
import { calcAge, todayISO } from './calc';
import Field from './Field';

// A dog's profile fields (name, photos, breed, DOB, spay/neuter,
// aggression, health) - moved out of BookingFlow's dog page (Oct 30,
// 2026) so My Stays' profile editor asks exactly the same questions the
// same way. Its own module, like Field/CostBreakdown, so neither lazy
// chunk has to import the other. `onField(field, value)` sets one field
// of `dog`; `showName` is false in My Stays, where a dog's name isn't
// editable (see the portal function's updateDog).
export default function DogProfileFields({ dog, onField, errors, showName = true }) {
  const age = calcAge(dog.dob);

  // Any number of photos (Sept 21, 2026, on request; multiple since
  // Sept 22, 2026, also on request) - never blocks Continue either way,
  // whether an upload is still in flight or fails outright (see
  // dogIsComplete/dogProfileErrors, deliberately unchanged). Each
  // selected file gets an instant local preview (createObjectURL),
  // independent of its own upload actually finishing - no need to wait
  // on a signed URL just to show the owner their own just-picked files
  // (the bucket is private anyway, so there's no signed URL to fetch
  // even after upload completes), and it works even if the upload
  // itself fails. Files upload one at a time (not in parallel) so each
  // one's own onField call sees the previous one's result already
  // applied, rather than racing on this closure's now-stale `dog.photos`.
  async function handlePhotoChange(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    let photos = dog.photos.concat(files.map(file => ({
      path: null, previewUrl: URL.createObjectURL(file), uploading: true, error: null,
    })));
    const startAt = dog.photos.length;
    onField('photos', photos);

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
      onField('photos', photos);
    }
  }

  function removePhoto(i) {
    onField('photos', dog.photos.filter((_, j) => j !== i));
  }

  return (
    <>
      {showName && (
        <Field label="Dog's Name" error={errors.name}>
          <input value={dog.name} onChange={e => onField('name', e.target.value)} placeholder="Buddy" />
        </Field>
      )}
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
        <input value={dog.breed} onChange={e => onField('breed', e.target.value)} placeholder="Golden Retriever" />
      </Field>
      <Field label="Date of Birth" error={errors.dob}>
        <input type="date" value={dog.dob} max={todayISO()} onChange={e => onField('dob', e.target.value)} />
        {age && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>Age: {age}</div>}
      </Field>
      <Field label="Spayed / Neutered?" error={errors.spayNeuter}>
        <select value={dog.spayNeuter} onChange={e => onField('spayNeuter', e.target.value)}>
          <option value="">Select one</option>
          <option value="yes">Yes</option>
          <option value="no">No (over 1 year)</option>
          <option value="under1">Not yet (under 1 year)</option>
        </select>
      </Field>
      <Field label="Any aggression history toward people or dogs?" error={errors.aggressionHistory}>
        <select value={dog.aggressionHistory} onChange={e => onField('aggressionHistory', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.aggressionHistory === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.aggressionDetail} onChange={e => onField('aggressionDetail', e.target.value)} rows={3} placeholder="Describe any known triggers or incidents" />
        </Field>
      )}
      <Field label="Any health conditions or heat sensitivity?" error={errors.healthConcerns}>
        <select value={dog.healthConcerns} onChange={e => onField('healthConcerns', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.healthConcerns === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.healthDetail} onChange={e => onField('healthDetail', e.target.value)} rows={3} placeholder="Describe any conditions, limitations, or sensitivities" />
        </Field>
      )}
    </>
  );
}
