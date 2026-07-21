# public/fonts/ — self-hosted webfonts

**Bundled:** four display faces for the neon clock style (`clockStyle: "neon"`),
picked in Settings via `clockFont`, plus two for the standard clock style
picked via `standardFont`. Self-hosted here instead of linked from Google
Fonts, matching this app's offline-first rule (no runtime dependency on an
external CDN).

- `monoton-latin.woff2` — "Monoton" (the default: bold tube-outline numerals).
  Latin subset (digits, punctuation), ~16KB.
- `neonderthaw-latin.woff2` — "Neonderthaw" (cursive neon-script sign look).
- `wallpoet-latin.woff2` — "Wallpoet" (blocky sci-fi/LED look).
- `fasterone-latin.woff2` — "Faster One" (streaked retro-diner look).
- `roboto-latin.woff2` — "Roboto Clock" (clean sans, standardFont: "roboto").
- `caveat-latin.woff2` — "Caveat Clock" (handwritten script, standardFont: "handwritten").

All but the Monoton file are subset to just digits + colon (the only glyphs
the clock ever renders) via Google's `text=` subsetting parameter, so each is
a few KB.

Sources: <https://fonts.google.com/specimen/Monoton> (Vernon Adams),
<https://fonts.google.com/specimen/Neonderthaw>,
<https://fonts.google.com/specimen/Wallpoet>,
<https://fonts.google.com/specimen/Faster+One>,
<https://fonts.google.com/specimen/Roboto>,
<https://fonts.google.com/specimen/Caveat>.
License: SIL Open Font License 1.1 (free to embed/redistribute).
