# hadith.json — provenance & verification

This file feeds the **"Hadith of the day"** card. The app picks one entry per
calendar day (deterministically, cycling through all before repeating), so the
quality of this file is the quality of what your family reads every day.

## Provenance

All **26 entries** are **direct, verbatim Bangla text** copied from a printed
Bangla translation of **Riyad as-Salihin** (Imam an-Nawawi), volume 1 —
sourced from the PDF at `https://shibircloud.com/pdf/riyadus_salehin_1.pdf`
(ICS Bangla edition, translator/publisher credit inside the PDF itself). No
retranslation, paraphrase, or outside wording was introduced: each `bn` field
is exactly what is printed on the cited page, including the narrator
attribution sentence, minus only the trailing grading note in parentheses
(which is pulled into its own `grading` field) and the leading hadith-number
digit (which is a list marker, not part of the sentence).

**Why hadithbd.com wasn't used:** the site's `robots.txt` explicitly disallows
AI crawlers (including Claude) and its Cloudflare bot-check blocks automated
fetches, so it was not scraped. This PDF, provided directly, was used instead.

## Selection criteria — "small" hadith only

Per instruction, only **short, self-contained** hadith were selected — single
narrations that read fully within one printed page, without long chains of
dialogue, multi-page narratives, or the well-known very long hadith (e.g. the
"actions are by intentions" hadith with its full explanation, or the Jibril
hadith defining Islam/Iman/Ihsan). Many chapters contain only long hadith and
were skipped entirely rather than force a fit.

## Verification performed

Every entry was checked **one by one, directly against the source PDF**:
1. Each candidate page was rendered to an image and read visually (not OCR —
   the PDF is a scanned book with no extractable text layer, so an OCR error
   could have silently corrupted the Bangla script; each page was instead
   read directly).
2. The **chapter attribution** was confirmed by locating the nearest
   `অনুচ্ছেদ ঃ N` heading actually printed on/before that page (headings and
   hadith text don't always share a page boundary — a new chapter's heading
   can appear partway down a page, after the tail end of the previous
   chapter's last hadith. This was checked hadith-by-hadith, not assumed from
   a table-of-contents page range).
3. `bn` was transcribed to match the page image exactly; `grading` was taken
   from the page's own closing citation (e.g. "মুত্তাফাকুন আলাইহি", "রাওয়াহু
   মুসলিম").
4. `source` records the exact page number so any entry can be re-checked
   against the same PDF.

All 26 are marked `"verified": true` on this basis.

**Never** add a hadith without a real, checkable source. Do not paraphrase or
retranslate. When in doubt, leave it out.

## Entry schema

```json
{
  "id": 1,
  "chapter": "ইখলাস (নিষ্ঠা) ও নিয়াত (অভিপ্রায়)",
  "bn": "আয়িশা (রা) থেকে বর্ণিত। ...",
  "collection": "রিয়াদুস সালেহীন",
  "ref": "রিয়াদুস সালেহীন, হাদীস ৩",
  "grading": "মুত্তাফাকুন আলাইহি (বুখারী, মুসলিম)",
  "source": "রিয়াদুস সালেহীন (বাংলা অনুবাদ), ১ম খণ্ড, পৃষ্ঠা ১৮",
  "verified": true
}
```

Only `chapter`, `bn`, `ref`, `grading`, and `collection` are shown on screen.
`id` just needs to be unique; `source`/`verified` are for your own tracking.

## Extending further

This PDF is only **volume 1** (covers roughly the first 48 chapters / ~389
hadith of Riyad as-Salihin — it ends mid-book, at "সৎ লোক, দুর্বল ও
মিসকীনদের কষ্ট দেয়ার বিরুদ্ধে সতর্কীকরণ"). To add more:
- Stay with **short, self-contained** hadith — the point of this file is a
  daily card someone reads in a few seconds, not a study text.
- Verify chapter attribution by checking which `অনুচ্ছেদ` heading actually
  precedes the hadith on the page, not just a table-of-contents page range.
- Copy the Bangla verbatim from a real printed/PDF source — never translate
  or paraphrase from memory.

## Notes

- The card renders Bangla with the OS font (Nirmala UI on Windows), so conjuncts
  display correctly with no font download.
- You can add fewer or more than 26 — the rotation adapts to the array length.
- After editing this file, the display refreshes the hadith on its next daily
  rollover, or immediately if you change any setting (which pushes an update).
