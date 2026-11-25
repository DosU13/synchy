# SYNCHY: cinematic photo booth

A guest steps up and picks one of this year's films. A film-leader countdown runs and the camera takes the photo. While the photo "develops", the AI turns the guest into the star of a widescreen poster for that film, in the style of its official poster and stills. When nobody is at the booth, the projector plays a montage of shots from the films' trailers, mixed with the photos guests have taken.

## Start it on the event laptop

1. **Get a Gemini API key** at Google AI Studio (aistudio.google.com, "Get API key"). Image generation is paid there, so billing must be on. It costs about $0.03–0.07 per photo, so 300 photos is roughly $10–20.
2. In this folder, copy `.env.example`, name the copy `.env`, and paste the key after `GEMINI_API_KEY=`.
3. Connect the projector, press **Win+P** and choose **Duplicate** (or **Second screen only**).
4. Double-click **`start-booth.bat`**. Chrome opens full screen. The first time, click **Allow** for the camera.
5. Take one test photo and look at the small dot in the top-left corner: green means the AI works.

To close it, press **Alt+F4** on the booth screen, then close the black server window.

With no key or no internet, the booth still works. Guests get the film's color look, grain and vignette without the AI, and the dot turns amber.

## Guest controls

A wireless presentation clicker makes a good "button":

- **▶** (Next / PageDown / → / Space / Enter / mouse click): start, then shoot.
- **◀** (Back / PageUp / ←): switch to another film.

## Operator keys

| Key | What it does |
|---|---|
| D | status panel: camera, AI, last error |
| A | AI on/off |
| M | montage sound on/off (the trailer clips are silent) |
| N | next montage clip |
| X | hide the montage clip on screen for good |
| C | switch to the next camera |
| R | reload `films.json`, `config.json` and the montage |
| F | full screen |
| Esc | back to the idle screen |

Status dot colors:

- **Green:** the AI is ready.
- **Amber:** the AI is off or there's no key, so photos get the offline look.
- **Red:** there's no camera, or the last AI photo failed.
- **Blue:** test mode.

## The montage

The montage is made from the films' trailers. It is silent, and every film gets the same screen time. Each round shows one short clip from every film in a random order, with crossfades. The film's title appears in the bottom-left corner.

1. Put the trailers (.mp4) in the **`trailers`** folder. The file name must contain the film's title or one of its other names (the `aliases` in `films.json`), in Latin or Cyrillic letters: `Мерген трейлер.mp4`, `MERGEN trailer.mp4` and `SHADOW trailer.mp4` all work. The server window lists any name it can't match.
2. Start the booth. It cuts new trailers into clips on its own, in the background, in about 10 seconds per trailer. New clips join the montage within a minute. To cut them without starting the booth, double-click **`build-montage.bat`**.
3. Watch the montage once. If a clip shows subtitles, a logo or something you don't want, press **X** while it plays and it never comes back. Hidden clips are listed in `montage/hidden.txt`; delete a line there to bring one back.

How the clips are chosen:

- For each film, the booth picks up to 8 clips of 3–6 seconds.
- It skips black frames, title cards, logos and shots with subtitles or other text.
- Clips are cropped to the widescreen frame and saved in `montage/clips/`.

Cutting needs **ffmpeg**, which is installed on this PC. The event laptop doesn't need it: copy the whole `Synchy` folder, including `montage/clips`, and the montage plays as it is. Videos you put straight into `montage/` play too, without a title.

Films with no trailer yet (25 Nov): Нелегал, Өч 2, Мафия, Кассандра, Мерген, Кудай сактасын 2, Сезимдер, Жез кемпир, Жалын, Бейиш, апама кат, Псы, Panic Button, Курак. The server window prints the current list when it starts.

## The AI look: the films' promo pictures

Each guest photo becomes a widescreen poster for the chosen film. With the photo, the booth sends the AI up to 2 of the film's official promo pictures (poster and stills). The AI follows their idea, composition, colors, light, clothes and setting. It is told never to copy the actors' faces. Nothing has to be trained: the pictures go along with every photo.

The poster has no lettering, because AI often misspells Cyrillic titles. The booth shows the film's title below the picture itself.

- The pictures are in **`refs/<film id>/`**, named `ref-1.jpg` and `ref-2.jpg`. The `originals` subfolder holds the downloads and is not sent. `about.txt` says where each picture comes from.
- 19 films have pictures: posters from Kinoafisha, stills, and frames from the trailers. Posters that show blood, wounds or guns (Жетишет, Кассандра, Шерменделик карнавалы, Өч 2) were cropped or replaced by calm frames from the trailer or stills.
- Жез кемпир, Псы, Panic Button and Курак have no pictures yet and get only the text in `films.json`. To add one, save a still or poster as `ref-1.jpg` in the film's folder. About 1280 px is enough; files over 4 MB are skipped.
- `ai.references.max` in `config.json` sets how many are sent (0 turns them off). `ai.referencePromptTemplate` is the prompt used with pictures.
- The pictures are the films' own promotional material. Ask the organizer whether the distributors are fine with using them this way, or ask for the official press kits.

## Files you can edit (press R on the booth afterwards)

- **`films.json`** lists the films.
  - `title` is shown on screen.
  - `look` tells the AI what the film looks like; English works best.
  - `grade` is the color of the live view.
  - Entries whose `info` starts with `guess` were written from the title alone and need a real description.
- **`config.json`** holds the timings, the event name, the on-screen texts (Kyrgyz and Russian), the AI settings and the prompt.
  - `montage.crossfadeSeconds` sets the length of the crossfade.
  - `clipsPerFilm`, `minClipSeconds` and `maxClipSeconds` decide how the trailers are cut. Changing them cuts every trailer again.
- **`trailers/`** holds the trailers. **`montage/hidden.txt`** lists the clips you hid with X.
- **`refs/<film id>/`** holds the promo pictures the AI gets with each photo (no restart needed).

## Photos and privacy

The results are saved in `captures/`, because the idle gallery shows them. The original camera photos are not kept. Put up a small sign saying photos are processed by AI and shown on screen. After the event, delete `captures/` unless you agreed to keep the photos.

## On the day

- **Internet:** test the venue Wi-Fi. Keep a phone hotspot as a backup.
- **Light:** put a lamp on the guest's face. It's dark around a projector.
- **Camera:** put it right next to the projected image, at eye level.
- **Laptop:** keep it plugged in, with sleep turned off in the Windows power settings.
- **Montage:** if the booth runs on another laptop, copy the whole folder there after the last trailers are cut. Check that the server window says "Montage: … clips from … films".
- **Rehearsal without AI calls:** run `node server.js --open --mock` (photos come back unchanged).
