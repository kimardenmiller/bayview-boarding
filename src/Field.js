// A labeled form field wrapper (label + optional hint + children +
// error) - shared by both lazy-loaded chunks (BookingFlow.js's own
// steps, and AdminPanel.js's settings/billing-edit forms), split into
// its own tiny module (Sept 30, 2026, code-splitting) rather than
// living inside either one, so neither chunk has to import the other
// just for this.
export default function Field({ label, error, children, hint }) {
  return (
    <div className={`field${error ? ' field--error' : ''}`}>
      <label className="field-label">{label}</label>
      {hint && <div className="field-hint">{hint}</div>}
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
