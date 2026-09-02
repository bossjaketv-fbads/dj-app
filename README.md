# Spinner App

Simple DJ soundboard para sa mga events ug wedding — tap lang sa button, mo-tingog dayon. Gibuhat para maka-install sa Xiaomi Pad 6/7 (o bisan unsang Android tablet/phone) as an app, walay backend/server nga gikinahanglan.

## Features (base sa sketch)

- **4x4 grid sa mga pads (16 total)** — i-tap para motingog. Pwede overlapping/paspas nga tap (dili mag-block ang uban).
- **Playlist** — para sa mas taas nga kanta/music (background music), naay play/pause, next/prev, seek bar.
- **Upload** — pag-dugang ug bag-ong sounds/songs (mp3, wav, m4a, ogg) gikan sa tablet storage.
- **Master Volume** — usa ka slider nga nagkontrolar sa tanang volume (pads ug playlist), plus "Stop All" para pahunongon dayon ang tanang tingog.
- **Edit mode** (button sa taas, "Edit") — i-toggle para ma-set/rename/color ang matag pad. Pwede pud **long-press** sa usa ka pad bisan wala sa edit mode para i-edit dayon.
- Ang tanang sounds ug pad settings **na-save sa mismong tablet** (IndexedDB + localStorage) — dili mawala bisan ma-close ang app o ma-refresh.
- Naay **PWA support** (manifest + service worker), so pwede i-"Add to Home Screen" para maglihok siya og daghang klase og app, ug mo-load bisan walay stable internet human na-open sa una.

## Paggamit sa Xiaomi Pad

### Option A — Host via GitHub Pages (recommended, para naay HTTPS ug ma-"install" siya)

1. Sa GitHub repo settings > Pages, i-enable Pages gikan sa branch nga naa ning code (o i-merge una sa main/default branch).
2. Ablihi ang published URL gamit ang Chrome sa Xiaomi Pad.
3. Sa Chrome menu, pilia **"Add to Home screen"** — mahimo na siyang installed app nga naay icon.

### Option B — Local lang, walay internet

1. I-download/i-copy ang entire folder (`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `icons/`) sa tablet.
2. Gamit ug simple static server app (pananglitan "HTTP Server" app gikan sa Play Store, o `python3 -m http.server` kung naay computer nga pwede i-connect sa parehas nga WiFi), i-serve ang folder.
3. Ablihi ang address (e.g. `http://localhost:8000`) sa Chrome, then "Add to Home screen".

> Note: Ang audio recording/playback ug pag-save sa mga sounds mo-work bisan direct file open (`file://`), pero ang "Add to Home Screen" install ug offline caching (service worker) nagkinahanglan og http(s) server — mao nang gi-suggest ang Option A o B.

## Pag-set-up sa mga pads sa una nga gamit

1. I-tap ang **Edit** sa taas.
2. I-tap ang usa ka pad — makapili ka og sound gikan sa library, o **Upload new sound** kung wala pa siya.
3. Pwede pud i-rename ang label ug pilian og color matag pad.
4. Kung tapos na, i-tap **Done**.
5. Sa normal mode, i-tap ra ang pad para motingog dayon.

## File structure

```
index.html     — markup/layout
style.css      — dark theme, tablet-friendly nga sizing
app.js         — logic (audio engine, IndexedDB storage, UI)
sw.js          — service worker para sa offline caching
manifest.json  — PWA manifest (icon, name, "Add to Home Screen")
icons/         — app icons
```

No build step, no dependencies — plain HTML/CSS/JS ra tanan.
