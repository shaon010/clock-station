# public/audio/ — adhan files (drop-in)

**Bundled now:** `mishary.mp3` (regular adhan) and `mishary-fajr.mp3` (Fajr adhan),
Mishary Rashid Alafasy, downloaded from the Internet Archive (archive.org) for
free personal/religious use. The default config already uses `mishary`, so the
adhan works out of the box. `iqamah.mp3` is **not** bundled — the iqamah chime is
off by default; add a file only if you enable it in Settings.

Sources: <https://archive.org/details/AdhanMisharyRashid> (regular) and
<https://archive.org/details/AdhanFajrAndDuaBySyeikhMisharyRashidAlAfasy> (Fajr).

Put your adhan MP3s in this folder. The muezzin dropdown in Settings lists
whatever it finds here. Expected filenames:

| File | Used for |
|------|----------|
| `mishary.mp3` | regular adhan (Dhuhr, Asr, Maghrib, Isha) |
| `mishary-fajr.mp3` | Fajr adhan (has *"aṣ-ṣalātu khayrun min an-nawm"*) — falls back to `mishary.mp3` if missing |
| `iqamah.mp3` | short iqamah chime (only if "Iqamah chime" is enabled) |

Add more muezzins the same way, e.g. `sudais.mp3` + `sudais-fajr.mp3`; they’ll
appear in the dropdown automatically. Naming rule: `<name>.mp3` and optional
`<name>-fajr.mp3`. Files literally named `iqamah` or ending in `-fajr` are not
listed as separate muezzins.

## Where to get them (free, for religious use)

- **archive.org** — search "Adhan Mishary Rashid Alafasy" (downloadable MP3s).
- **islamcan.com/adhan** — several muezzins including Mishary, Makkah, Madinah.
- **assabile.com** — adhan recordings by reciter.

Download the full adhan and the Fajr adhan, rename to match the table above, and
drop them here. That’s it — no server restart needed; reopen Settings to see them.

> Note: recordings are the work of their reciters/publishers. Use versions offered
> for free personal/religious use.
