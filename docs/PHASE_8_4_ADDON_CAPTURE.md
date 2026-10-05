# Phase 8.4 add-on capture

Capture uses a shared consent parser at routing and the session-note tool boundary.
Questions and hypotheticals do not save extras, even when a model invents an
add_session_note call. An explicit choice saves each selected SKU; a yes applies
only to an unambiguous single add-on offer. Quantities are scoped to the item clause
and validated. Replies distinguish saved, already-recorded and unsaved requests.
Companion details such as extra makeup for a sister remain in the operational note.
Declined clauses are ignored; a mixed decline/choice saves only the chosen item.
Extra makeup requires another-person clarification before saving. A yes to a
multi-item offer asks which item; only single-item consent saves directly.
Explicit "another" requests increment the selected SKU; repeat source text within
the existing 24-hour guard does not increment again. This is a sequential text
deduplication guarantee, not stable external-event-id or concurrent idempotency.
Zero-price quote requests stay out of invoice lines/totals and are not marked
invoiced until a price is assigned. Reply/matcher phrases use shared constants.

Extras go to the balance, never the deposit. Capture does not change package,
date, protected draft step, or create a booking. An unfinished new-session draft
must not attach its extras to the customer's older upcoming booking.

## Storage limitation

The existing pending BookingAddon rows and staff operational notes remain the
temporary persistence path. No customer-memory slots are stored in staff-note JSON.
Pre-booking extras stay pending and unlinked; the existing confirmation flow uses
the previously approved fourteen-day orphan-attachment window. This is not a
draft-bound identity guarantee. True draft-bound add-ons require the 8.1b
slotContext migration and a later approved attachment change. That portion of
8.4 is blocked; no schema change or fake in-memory-only persistence substitutes
for it. Pending orphans still need the previously recorded staff line-item view.

## Deployment and owner checks

No edition facts have been verified by the studio owner. Bloom's 1.5 hours and
six photos are seed values only. Forward to the owner: confirm Bloom duration and
edited-photo count, Empress duration/photos/wigs/Reel/photobook/Power Suit, and
quickly verify all other edition cards. No external owner message was sent here.

No safe dev database is available for a read-only runtime comparison. Credential
rotation, safe dev DB setup, migration baseline and applying cancelProposedAt,
the 8.1b fields and packages.inclusions together remain user-side prerequisites.
The stale lashes vector must be removed through an approved Pinecone operation
before testing with real customers. No deployment or real-customer testing is
authorised. An early affirmative fixture allowed an unintended catalog lookup;
the route was repaired and a fail-fast stub added before rerunning validation.
That run did not establish a live-data comparison. Persistence tests mock the
database and notification boundaries; no migrations or application writes to a
live database were performed by this task.

The lookup bug was in production routing predicates, not just fixture code: yes
to a specific offer could fall into addonListFollowUp and call getAdditionsReply,
which looks up the configured deposit. It was not an extra call on every add-on
message. Explicit selections and ambiguous-offer clarifications now bypass that
list path; genuine "what extras do you have?" requests still reach it deliberately.
No live production trace or confirmed live lookup is available from these tests.