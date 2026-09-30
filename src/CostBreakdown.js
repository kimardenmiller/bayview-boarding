import { formatDays, formatMoney } from './calc';

// The on-screen line-item math behind a cost total - shared by both
// lazy-loaded chunks (BookingFlow.js's StepDates, and AdminPanel.js's
// Requests/Unbilled Stays Edit views), split into its own tiny module
// (Sept 30, 2026, code-splitting) rather than living inside either one,
// so neither chunk has to import the other just for this. See
// formatCostBreakdownText in calc.js for the plain-text SMS equivalent -
// kept in sync by hand.
export default function CostBreakdown({ breakdown, multiDogDiscount }) {
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
