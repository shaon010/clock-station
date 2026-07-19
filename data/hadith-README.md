# hadith.json — how to complete & verify to 100

This file feeds the **"Hadith of the day"** card. The app picks one entry per
calendar day (deterministically, cycling through all before repeating), so the
quality of this file is the quality of what your family reads every day.

## ⚠️ Integrity first

The 10 entries shipped here are **well-known hadith from Riyad as-Salihin**, each
anchored to a checkable **Bukhari/Muslim/Tirmidhi reference + a sunnah.com URL**.
Every entry is marked `"verified": false` **on purpose** — the Bangla wording was
not taken from a published, authoritative Bangla edition and **must be checked**
before you rely on it. Do not treat `verified: false` entries as final.

**Never** add a hadith without a real, checkable source. Do not paraphrase from
memory. When in doubt, leave it out.

## Entry schema

```json
{
  "id": 11,
  "chapter": "অধ্যায়ের নাম (Bangla)",
  "bn": "বাংলা অনুবাদ",
  "collection": "রিয়াদুস সালিহীন",
  "ref": "Bukhari 1 · Muslim 1907",     // primary, verifiable source
  "grading": "Sahih (muttafaqun alayh)",
  "source_url": "https://sunnah.com/bukhari:1",
  "verified": true                       // set true only after checking
}
```

Only `chapter`, `bn`, `ref`, and `source_url` are shown on screen (`grading` too).
`id` just needs to be unique; `verified` is for your own tracking.

## Suggested workflow to reach 100

1. **Pick 100 hadith across chapters** of Riyad as-Salihin (Imam an-Nawawi) from
   an authentic Bangla print/edition you trust, spread across topics (intention,
   patience, truthfulness, salah, parents, neighbours, dhikr, manners, etc.).
2. For each, open its page on **sunnah.com/riyadussalihin** (or the Bukhari/Muslim
   source) and copy the exact reference number into `ref` + `source_url`.
3. Paste the **Bangla text from your trusted edition** into `bn` — not an
   improvised translation.
4. Confirm `ref`/`grading` against `source_url`, then set `verified: true`.
5. **Have a knowledgeable person / scholar review the final file** before launch.

## Notes

- The card renders Bangla with the OS font (Nirmala UI on Windows), so conjuncts
  display correctly with no font download.
- You can add fewer or more than 100 — the rotation adapts to the array length.
- After editing this file, the display refreshes the hadith on its next daily
  rollover, or immediately if you change any setting (which pushes an update).
