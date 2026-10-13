# tylerhannan.com

Static site, no build step. Everything served lives in `public/`.

Preview locally (pages fetch JSON, so opening the files directly won't work):

```
cd public && python3 -m http.server 8000
```

## Adding photos

Export from Lightroom with:

| Setting | Value |
|---|---|
| Format | JPEG, quality 90+ |
| Color space | sRGB |
| Size | Long edge 2000 px or larger (don't enlarge) |
| Metadata | Copyright only, **Remove Location Info** checked |

Then add each one:

```
scripts/add-photo.sh ~/Pictures/Export/IMG_1234.jpg "Title" "Place" "YYYY-MM"
```

The script shrinks the long edge to 2000 px (smaller photos stay as they are), removes GPS location data, saves it as `public/photos/<title>.jpg`, and adds it to the top of `public/photos.json`. Commit and push to publish.

- **Location data is stripped by the script** (EXIF GPS and Lightroom's XMP). Ticking "Remove Location Info" in Lightroom is still a good habit. Other metadata, like camera and copyright, is kept.
- The grid crops every photo to a 4:3 landscape box. The full-size viewer shows the whole photo. If the crop cuts off the subject, add `"focus": "top"` (or `bottom`, `left`, `right`) to that photo in `photos.json`.
- Titles become filenames, so a repeated title overwrites the earlier photo.
- Optional fields in `photos.json`: `camera` (shown in the viewer caption) and `alt` (a short description for screen readers; the title is used if empty).
- Delete the `"example": true` entries once real photos are in.

## Talks

Edit `public/talks.json`. Each talk has `date`, `title`, `event`, `location`, `type` (keynote / talk / webinar / video), `url`, `youtube` (the 11-character video ID, or `null`) and an optional `note`. To show a talk in **Highlighted videos** on the home page, give it `"highlight": 1` to `6` (the number sets its position).

## Old blog

`scripts/import_wordpress.py backup/<dump>.sql` regenerates the archive from the WordPress export. `backup/` is gitignored and must never be committed, because the export contains password hashes and email addresses.
