# Phase 8.3 customer reply approval

Copy approved for a separate 8.3 commit. Examples use seed rows, not verified
production rows. No edition data has been confirmed by the studio owner in this
thread. Bloom's 1.5 hours and six photos come from the seed; the user explicitly
corrected the earlier owner-confirmation claim on 2026-10-04.
Empress duration and inclusions await owner confirmation and are
withheld. Runtime count, deposit, location, prices and recorded fields come from
the DB. No inclusion is inferred from an edition name. No source rows were edited.

## Booking process

Link-first update (2026-10-05): the wording below is pending approval, not a
renewal of the earlier approval. The catalog below is retained as a last resort.

## Link-first replies (pending approval)

Generic edition request, including repeats:

```text
You can see all our editions, inclusions and prices here: https://www.fiestahousematernity.com/session-packages
Tell me which edition catches your eye.
```

Generic add-on request, including repeats:

```text
All the optional extras and their prices are here: https://www.fiestahousematernity.com/session-packages
Tell me which you would like for your session.
```

Website-first correction (2026-10-07): specific items keep their existing verified
answer and append the same link. Comparisons remain limited to two editions. Only
an explicit request to list it in chat or a broken-link follow-up uses the existing
full-list builder. Repeated generic requests, "show me the packages in the studio",
and old catalog markers do not authorize a full catalog. Bare "yes" or "show me"
after a generic link is not full-list consent.
During slot collection the second sentence is replaced by the next missing
edition/date/time/name question, without saving or proposing anything.

Legacy namespaced catalog-link markers remain available to existing model-link
bookkeeping, but their presence or expiry no longer decides deterministic catalog
display. Generic requests return the website link without reading or claiming
those markers; no marker cleanup or memory reset is needed for this correction.
No schema migration, price/deposit edit, booking mutation or ingestion was run.

Website-first correction validation, 2026-10-07: seven focused catalog/copy checks
passed; full suite 511 passed with five existing 6 October date-dependent failures.
TypeScript and editor diagnostics pass. No live request or deployment performed.

Offline validation, 2026-10-05: full backend suite 421/421 passed (exit 0),
TypeScript no-emit check passed (exit 0), and diff whitespace check passed.
Focused verifier/policy run: 19/19 passed. Additional real persistence regression
confirms wig hire after the link still saves unit/total Ksh 4,000 with the draft
unchanged. Tests were written red first for URL preservation, state, follow-ups,
specific-item links, collecting-booking continuation and verifier false positives.
Replay: 13/15 passed (exit 1); the date/time child and parent fail because the
existing bookingProgressReply fixture does not mock customerSessionNote.findFirst.
The new link-first replay assertion passes. All checks redirected DATABASE_URL
to an unreachable local endpoint; no live booking/payment/Calendar run was done.
Overall live validation remains unverified and replay remains failing. Changes
are uncommitted pending wording approval; unrelated concurrent edits are retained.

## Booking process (pending link-first approval)

```text
Here is how booking works:
1. Choose from our 7 editions. See them here: https://www.fiestahousematernity.com/session-packages
2. Share your preferred date and time. We are closed on Mondays.
3. Choose any optional extras from the same page: https://www.fiestahousematernity.com/session-packages
4. We check availability; a Ksh 2,000 deposit secures your slot.
5. Once you confirm the proposal, we send the M-Pesa prompt. Your booking is confirmed after the deposit is received.
6. Come for your session at 4th Avenue Parklands, Diamond Plaza Annex, 2nd Floor, Nairobi.
7. Pay the remaining balance after your session by M-Pesa or cash.
Edited photos are ready 10 working days after your session and shared through a secure download link.

Would you like to check available dates?
```

## Compact catalog: one message

The heading, overview and closing line remain one message. No separate-send
mechanism is proposed or implemented. This is the complete current reply:

```text
Fiesta House Maternity - Rate Card 2026

Here are our maternity editions:
THE BLOOM - Ksh 15,000 | 1.5 hours | 6 edited photos
THE MUSE - Ksh 25,000 | 2 hours | 12 edited photos
THE ICON - Ksh 35,000 | 2.5 hours | 15 edited photos
THE LEGEND - Ksh 45,000 | 2.5 hours | 15 edited photos
THE QUEEN - Ksh 55,000 | 3 hours | 20 edited photos
THE EMPRESS - Ksh 70,000 | Ask me for details
THE GODDESS - Ksh 120,000 | 5 hours | 30 edited photos

Tell me which edition you're considering and I'll share its inclusions and anything the team still needs to confirm.
```

## Requested detail: THE ICON

```text
THE ICON - Ksh 35,000
- Session length: 2.5 hours
- 15 final edited photos
- Professional makeup
- 4 studio outfits with styling
- 1 A3 fine art mount
https://www.fiestahousematernity.com/session-packages
```

An Empress detail request receives:
"The team will confirm the exact inclusions for you."
A Bloom runtime row contradicting the seed's 1.5-hour duration is withheld for
review, not silently overwritten. The same review wording applies to that mismatch.

Catalog unavailable reply:
"The studio team will share our current rate card and edition details. I cannot verify the catalog right now."

When the configured deposit cannot be validated, booking-process step 4 becomes:
"4. We quote your deposit once you choose an edition; the studio team will confirm it before any payment prompt is sent."

When all deposits validate but differ, step 4 is:
"4. We check availability; deposits start from Ksh 2,000, and I'll quote the exact amount for your edition."
The value is the minimum validated row, not a hardcoded Ksh 2,000.
The optional 72-hour policy addition is not included in this reply.

## Missing structured fields

Missing fields: wig count, Reel inclusion/count, Power Suit inclusion, outfit
ownership/notes, mount size/count, backdrop design and photobook cover type.
Existing booleans do not represent quantities/designs/sizes. The six uncontested
edition cards use explicit inclusion lists transcribed from seed/FAQ text in
src/config/edition-inclusions.ts, not name-based renderer rules. The original
selling points are retained, including A3/A2 mounts, wig counts and the Goddess
Reel/Power Suit. Empress has no reference list and is withheld. Runtime structured
fields are compared with the reference; mismatches are logged by field name and
withheld. No automatic choice between conflicting sources or DB updates occurs.
This is a temporary seed reference, not live-DB certification. Free-text runtime
notes are not parsed to manufacture facts.

The review-only SQL now includes nullable packages.inclusions JSONB, intended as
an owner-filled list of display strings. No default/backfill, application, Prisma
schema edit or dashboard inclusion editor is implemented. Those await the same
approved migration as cancelProposedAt and the 8.1b columns.

## Source discrepancy report

### Public pricing-page audit, 2026-10-05

Public source: https://www.fiestahousematernity.com/session-packages was fetched
and includes all seven editions and the add-ons below. Compared read-only with
scripts/seed-packages.ts, src/config/edition-inclusions.ts and ADDON_CATALOG in
src/config/constants.ts. No live DB connection/inspection or seed execution
was performed. Matching seed values do NOT certify current database rows or
constitute studio-owner confirmation. Recheck this audit when the page changes.

| Edition | Website price (Ksh) | Hours / photos / outfits | Comparison with local seed/reference |
| --- | --- | --- | --- |
| Bloom | 15,000 | 1.5 / 6 / 2 | Price, duration, photos, outfits, makeup and styling match. |
| Muse | 25,000 | 2 / 12 / 3 | All listed core inclusions match. |
| Icon | 35,000 | 2.5 / 15 / 4 | Matches, including one A3 mount. |
| Legend | 45,000 | 2.5 / 15 / 4 | Price/core fields and 8x8 hardcover photobook match. Seed notes/reference also include one styled wig; website does not list a wig. Resolve before certifying inclusions. |
| Queen | 55,000 | 3 / 20 / 4 | Matches, including balloon backdrop with flowers, one styled wig and one A3 mount. |
| Empress | 70,000 | 3.5 / 25 / 4 | Website matches seed notes: Power Suit, two wigs, backdrop with flowers, 8x8 hardcover photobook and A3 mount. Runtime detail withholding remains pending owner/source resolution; there is no Empress inclusion reference. |
| Goddess | 120,000 | 5 / 30 / 5 | Seed notes match Power Suit, two wigs, Reel, 8x8 hardcover photobook and A2 mount. Website backdrop option includes flowers; the short inclusion reference omits the word flowers. |

All seven website editions list professional makeup and studio outfits with
styling. Their seed booleans match. The website lists no numeric deposit here;
it says a non-refundable deposit is required. Seed deposits remain Ksh 2,000,
and runtime deposit validation/charging is unchanged.

| Add-on | Website price (Ksh) | Local comparison / qualification gaps |
| --- | --- | --- |
| Extra edited photo | 1,000 per photo | Unit price and quantity pricing match. |
| Extra digital art edit | 3,000 per photo | Unit price and quantity pricing match. |
| Raw files | Quoted by package tier | Local zero is a quote-required sentinel, not free; matches. |
| Extra outfit beyond package | 4,000 per outfit | Unit price and quantity pricing match. |
| Extra professional makeup | 3,500 per session | Price matches; local catalog has no explicit per-session label. |
| Fiesta House Power Suit | 10,000 where not included | Price matches; local add-on entry does not encode the inclusion qualifier. |
| Styled wig hire | 4,000 per wig, book in advance | Price/quantity match; local catalog has no book-in-advance field. |
| Wig styling only | 3,000 per wig, book in advance | Price/quantity match; local catalog has no book-in-advance field. |
| Suspending Concept | 7,000 | Price matches. |
| Goddess Sculpture Set | 15,000 where not included | Price matches; local add-on entry does not encode the inclusion qualifier. |
| Professional Reel | Quoted by package tier, book in advance | Quote-required sentinel matches; local catalog has no book-in-advance field. |

Bespoke experiences and travelling-mother concierge arrangements are also
listed by consultation, without fixed prices; their existing reply paths remain.
This audit does not import website marketing copy or add unconfirmed facts to
RAG. Studio approval and an authorised refresh remain necessary to resolve
Legend/Empress and represent missing structured qualifications in AI data.

### Earlier source conflicts (unchanged)

| Fact | Seed and current local FAQ | User-reported transcript/retrieval | Previous card | Current treatment |
| --- | --- | --- | --- | --- |
| Bloom duration | 1.5 hours | 5 hours | 1.5 hours | Owner unverified; conflicting DB row withheld |
| Empress duration | 3.5 hours | 3 hours | 3.5 hours | Withheld pending owner |
| Empress photos | 25 | 20 | 25 | Withheld pending owner |
| Empress wigs | Notes/FAQ: 2; seed column: wig=true | 1 | Name rule asserted 2 | Quantity missing; withheld |
| Empress photobook | 8x8 hardcover in FAQ/notes; seed has boolean and size | None | 8x8 hardcover | Cover field missing; withheld |
| Empress Power Suit | FAQ/notes include it; no dedicated column | Not listed | Name rule asserted included | No inclusion/exclusion claim |
| Empress Reel | Not listed | 1 produced Reel | Only Goddess received a Reel by name | No inclusion/exclusion claim |

Verified local sources: scripts/seed-packages.ts, knowledge_base_rows.json,
scripts/knowledge_base_rows.json. Current local FAQ copies agree with the seed;
they do not reproduce the transcript's Empress variant. Scrape matches examined
were script text, not usable edition facts. Older reported values are not labelled
as verified current FAQ rows. No winner is chosen for Empress. Live DB and live
retrieval index comparison remains blocked on the safe dev database and approved
access. No DB credentials, migrations or Pinecone operations were used.

Heading, invitation and edition-term constants are shared with matchers. Tests
generate the reply and verify inclusion follow-ups plus both package/edition input.

No real-customer testing is authorised. The stale lashes vector must be deleted
through an approved Pinecone operation before customer testing; no Pinecone
operation has been performed here. Other development-database and migration
restrictions remain in force.

The Empress hold above applies to catalog disclosure; this change does not certify
or repair its availability duration constants or other retrieval/booking paths.
No deployment or real-customer booking is authorised while these conflicts remain.

Before launch, obtain owner confirmation of Bloom's duration/photo count, the full
Empress inclusions, and all other cards. Read-only non-production DB comparison
is still blocked on a safe dev database and approved access. Tests cover absent
and null inclusions columns falling back to seed strings; the undeployed column
is not selected. Credential rotation and migration baseline/application remain
user-side tasks. Staging must monitor field-conflict warnings before rollout.