# Phase 8.1a slot memory

Early collection uses the existing BookingDraft fields with step `collecting_slots`.
It is not a proposal, confirmation, payment request, or calendar hold. Only
`awaiting_confirmation` and `payment_pending` drafts updated within fifteen minutes
hold slots. Dashboard booking lists query Booking, not BookingDraft.

## Temporary expiry limitation

The fourteen-day clock measures BookingDraft.createdAt, not the latest stated slot.
There is no existing slot-specific timestamp: updatedAt changes for unrelated work,
and cancelProposedAt belongs exclusively to cancellation proposals. An older
`service` row converted to collection retains its original creation date. A customer
still actively collecting at day fourteen can therefore lose package/date/time
context. This limitation is accepted only as the temporary 8.1a behavior, not as
the intended long-term policy. Phase 8.1b needs its own slotsUpdatedAt timestamp,
refreshed only when the customer states a slot, and an approved migration.
Customer profile names are not erased when the early draft expires.

## Names and staff visibility

First names are sufficient during collection. Collection and proposal handling
must not replace an existing fuller profile name with its shorter prefix. Proposal
validation rejects empty and placeholder names; the prompt requests a full name
when preparing a proposal, but word count is not a hard full-name validator.

Out-of-window orphan add-ons remain pending and unlinked, with their notes and
sessionNoteId retained. Existing staff customer session-note views expose the
source requests; there is no dedicated orphan line-item dashboard. Records without
a source session note are retained in storage but are not directly exposed there.
No deletion or automatic invoice attachment is introduced for these old rows.

Follow-up: expose orphan add-on line items in a staff view with review and action
controls; retained source notes are not a substitute for actionable line items.

## Deployment restrictions

The additive SQL is review-only, not an applied migration or a database baseline.
Phase 8.1b is blocked on migration approval. Cancellation requires cancelProposedAt
in the target database. Do not test against real customers or the production number.
Credential rotation, a safe development database, and the stale lashes vector
remain separate unresolved deployment/data tasks.

## Phase 8.2 calendar checks

Date-only input is interpreted in Africa/Nairobi, independently of host timezone.
Calendar facts include the computed weekday, Monday closure, and whether the date
is in the past. Explicit years are preserved. Next week is the following
Monday-Sunday range in Nairobi, including the midnight boundary on Sunday.

The get_available_dates tool shares get_available_slots platform/exposure rules.
It accepts a recognised package and an inclusive range of at most fourteen days,
rejects invalid ranges, clamps partially past ranges to Nairobi today, and reports
fully past ranges as passed rather than fully booked. It skips Mondays and fully booked dates, and
returns up to three example slots per open date. Next-week requests use a stored
non-expired package and code-computed bounds rather than model-generated bounds.
An unknown or expired package prompts only for the package, not the name.
Each range loads occupancy once: one bookings query, one active-holds query, and
one Google Calendar request. Slots are calculated locally from that snapshot.
Repeated checks of the same range within a turn reuse the result. Empty ranges
explicitly report that all days are closed or fully booked. Sunday evening in
Nairobi intentionally means the coming Monday-Sunday; Monday is absent from the
open-date results, so Tuesday is the first possible date.

Calendar-only availability replies and weekday answers are built from computed
facts, not model weekday guesses. Booking/reschedule confirmation guards remain
unchanged. Availability is a current check, not a reservation or a guarantee until
the existing proposal and payment flow completes. Tests use mocked integration
boundaries and do not certify the production database or live provider.