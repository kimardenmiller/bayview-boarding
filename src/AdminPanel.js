import { useState } from 'react';
import { supabase } from './supabase';
import { formatDate, calcAge, calcCostBreakdown, formatCostBreakdownText, formatMoney } from './calc';
import { DEFAULT_BROADCAST_MESSAGE, DEFAULT_SMS_FOOTER, DEFAULT_SMS_TEMPLATES, FEEDBACK_STATUSES } from './defaults';
import CostBreakdown from './CostBreakdown';
import Field from './Field';
import aboutPhotoSrc from './aboutPhotoSrc';

// The entire admin panel - split into its own lazy-loaded chunk (Sept
// 30, 2026, on request - code-splitting for mobile PageSpeed), since
// it's roughly half this app's total JS, fully password-gated, and
// used by exactly two people (Kim and Estee) - no regular visitor ever
// needs any of this code, yet it used to ship in everyone's initial
// bundle regardless. App.js loads this behind React.lazy() only once
// someone actually opens the nav menu's "Admin" item or lands on the
// bookmarked ?admin URL.

export default function AdminView({
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

  // Resyncs every approved, upcoming stay's calendar events (Sept 25-26,
  // 2026, on request - "can we update the calendar with existing
  // stays?", then "does not seem to be working" once a stay with a
  // stale/wrong-format event turned out to need more than just filling
  // in what was missing). Safe to click any time, not just once:
  // creates whatever's actually missing (including an event deleted
  // directly in Google Calendar - see admin-data's syncStayCalendarEvent
  // "not-found" handling), and refreshes everything else in place.
  // Best-effort like everything else calendar-related - a failure here
  // just means try again later, never an error the admin has to do
  // anything about.
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
            {backfillCalendarStatus || 'Resyncs approved, upcoming stays with the calendar - fixes anything missing or deleted. Safe to click any time.'}
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
