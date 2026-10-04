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

## Deployment restrictions

The additive SQL is review-only, not an applied migration or a database baseline.
Phase 8.1b is blocked on migration approval. Cancellation requires cancelProposedAt
in the target database. Do not test against real customers or the production number.
Credential rotation, a safe development database, and the stale lashes vector
remain separate unresolved deployment/data tasks.