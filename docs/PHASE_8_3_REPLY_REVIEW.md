# Phase 8.3 customer reply approval

Copy approved for a separate 8.3 commit. Examples use seed rows, not verified
production rows. No edition data has been confirmed by the studio owner in this
thread. Bloom's 1.5 hours and six photos come from the seed; the user explicitly
corrected the earlier owner-confirmation claim on 2026-10-04.
Empress duration and inclusions await owner confirmation and are
withheld. Runtime count, deposit, location, prices and recorded fields come from
the DB. No inclusion is inferred from an edition name. No source rows were edited.

## Booking process

```text
Here is how booking works:
1. Choose from our 7 editions.
2. Share your preferred date and time. We are closed on Mondays.
3. Add any optional extras you would like, such as an extra outfit, wig hire or extra photos.
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