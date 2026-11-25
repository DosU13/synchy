# SYNCHY: plan and context

Status, decisions and open items for the projection installation at the Kyrgyz film critics' event. Written so that you or a new Claude session can pick up the work. How to run the booth is in [README.md](README.md).

Last updated: 25 November 2026.

## Claude sessions

| Session | ID | What it did |
|---|---|---|
| Main chat | `73f1721e-3a8b-427d-b42e-afbe1fff224d` | Built the photo booth, the trailer cutter and the promo-picture references. |
| Montage player | `9c0d0037-019e-4ebe-a5d7-5195602fd4cc` | Finished the montage player in the booth (crossfades, titles, X and N keys). |

To continue a session, open it from the Claude desktop app's sidebar, or run `claude --resume <ID>` in a terminal in this folder. A new session can start from this file.

## The event

- **When:** Sunday, 29 November 2026. Critics judge last year's Kyrgyz films (23 titles, listed in `films.json`).
- **Space:** a projector above the stairs (tested, works) and a small area for one person or group at a time.
- **Organizer:** liked the earlier ornaments installation and suggested showing it here too.

## What is built

### Photo booth

1. A guest presses ▶ on a presentation clicker, and a random film comes up. ◀ switches to another film.
2. A 3-2-1 countdown runs, styled like an old film leader, and the camera takes the photo.
3. The photo "develops" from a negative under a red darkroom light while the AI works.
4. The guest appears as the star of a widescreen poster for that film. The idle screen then shows the poster in its gallery.

Details:

- **AI:** Gemini image models, tried in this order: `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`. The working model is remembered.
- **Without AI:** with no key, no internet or an AI error, the photo gets the film's color look offline, so the screen never breaks.
- **Frame:** 2.39:1, with letterbox bars that hold the texts. The texts are in Kyrgyz and Russian (`config.json` → `texts`).

### AI look: promo pictures, poster style

- **How it works:** with each photo, the booth sends up to 2 of the film's official promo pictures from `refs/<film id>/ref-*.jpg`. The AI follows their idea, composition, colors, light and costumes, and never copies the actors' faces. No model training is involved.
- **Style:** the user chose poster style on 25 Nov: widescreen key art with no lettering. AI often misspells Cyrillic titles, so the booth shows the title itself.
- **Sources:** mostly official posters from kinoafisha.info, plus official stills and trailer frames. Each `refs/<film>/about.txt` lists the source.
- **What was left out:**
  - Posters with blood, wounds or guns (Жетишет, Кассандра, Шерменделик карнавалы, Өч 2) were cropped or replaced by calm trailer frames or stills.
  - The Курак festival photos and the Panic Button protest still show real people, so they are not used.
- **Descriptions:** each film's `look` in `films.json` was rewritten from its poster and plot summary.

### Montage (idle screen)

- **Clips:** `tools/build-montage.js` cuts the trailers in `trailers/` into short silent clips in `montage/clips/`. It skips black frames, title cards, logos and subtitles, and crops to 2.39:1. `montage/clips.json` lists the clips.
- **Playback:** every round plays one clip from every film, in random order, with 1.2 s crossfades. The film's title shows at the bottom left. Guests' posters fade in between.
- **New trailers:** the booth cuts them when it starts, using ffmpeg (installed on the build PC via winget). The event laptop only needs the copied folder.
- **Operator keys:** X hides a clip for good (listed in `montage/hidden.txt`). N skips to the next clip.
- **Now:** 68 clips from 10 films.

### Files

| Path | What it is |
|---|---|
| `server.js` | Node server (no npm install): the AI requests, the montage list, file serving. It listens on this computer only. |
| `public/` | The booth page: `index.html`, `app.js`, `style.css`. |
| `tools/build-montage.js` | The trailer cutter. |
| `films.json` | The films: title, aliases for trailer file names, color grade, AI look. |
| `config.json` | Timings, texts, AI settings and prompts, montage settings. |
| `refs/` | Promo pictures for the AI. `originals/` holds the downloads, which are not sent. |
| `trailers/` | Trailers, added by the user. Not in git. |
| `montage/` | Cut clips, `clips.json`, `hidden.txt`. Not in git. |
| `captures/` | Guests' results. Not in git. Delete after the event. |
| `start-booth.bat`, `build-montage.bat` | Double-click to start the booth, or to cut trailers without starting it. |

## Films

| Film | Trailer | Promo pictures | Description from |
|---|---|---|---|
| Напарниктер 3 | yes (file "THE CHILDREN 3") | poster + trailer frame | Kinoafisha, trailer |
| Эсимде | yes | poster + trailer frame | Kinoafisha, trailer |
| Полчанки | yes | 2 trailer frames (no poster online) | trailer |
| Кыял | yes (file "DREAM") | poster + trailer frame | Kinoafisha, trailer |
| Черный двор | yes (file "Black Yard") | 2 trailer frames (no poster online) | trailer |
| Аян | yes | poster + trailer frame | Kinoafisha, trailer |
| Көлөкө | yes (file "SHADOW") | poster + trailer frame | Kinoafisha, trailer |
| Нелегал. Дорога в Мексику | no | poster (cropped) | Kinoafisha |
| Өч 2: Карындаш | no | poster (cropped) | Kinoafisha (poster only, no plot) |
| Мафия: Миллиондор изи | no | poster | Kinoafisha |
| Кассандра | no | 2 stills | Kinoafisha |
| Шерменделик карнавалы | yes | 2 trailer frames | Kinoafisha, trailer |
| Жетишет | yes (file "SEVENTEEN") | 2 trailer frames | Kinoafisha, trailer |
| Мерген | no | poster + still | Kinoafisha, IFFR |
| Окен ава | yes | poster + trailer frame | Kinoafisha, trailer |
| Кудай сактасын 2 | no | poster | Kinoafisha |
| Сезимдер | no | poster | Kinoafisha |
| Жез кемпир | no | none | **guess** (nothing found online) |
| Жалын | no | poster | Kinoafisha |
| Бейиш, апама кат | no | 1 picture | IMDb, ivi.tv, afisha.uz |
| Псы | no | none | partly (documentary, subject unknown) |
| Panic Button | no | none | UPI, Czech Film Center |
| Курак | no | none | 24.kg |

## Open items

1. **Gemini API key** (paid, from Google AI Studio) goes in `.env`. Until then the AI is untested with the real model. One poster costs about 3–7 cents. Once the key is in, ask Claude to make test posters.
2. **13 trailers** still missing (the user can download 10 videos a day). Put them in `trailers/`. A file name must contain the film title or an alias from `films.json`.
3. **Promo pictures** are missing for Жез кемпир, Псы, Panic Button and Курак. Ask the organizer for press kits, then save a picture as `refs/<film id>/ref-1.jpg`.
4. **Kyrgyz texts** in `config.json` need proofreading by a native speaker.
5. **Not tested yet:** the real webcam, the projector (check that dark clips are visible), and a whole run on the event laptop.
6. **Rights:** the posters and trailers belong to the distributors. Ask the organizer whether they're fine with this use. If the GitHub repo is public, make it private, because `refs/` holds the posters.
7. **Event laptop:** copy the whole folder, including `montage/clips` and `refs`, then install Node.js 18+ and Chrome and add `.env` with the key. Follow the "On the day" checklist in the README.

## Decisions and why

- **No model training:** fine-tuning by Sunday isn't realistic and isn't needed. Sending reference pictures with each photo gives the film's look.
- **Poster style without lettering:** the user's choice. Leaving out lettering avoids misspelled Cyrillic titles in front of critics.
- **No blood or weapons** in the prompts or the reference pictures.
- **Silent montage with equal screen time:** it's a critics' event, so every film gets the same time on screen.
- **Offline fallback everywhere:** venue internet is unknown, and the screen must never break.
