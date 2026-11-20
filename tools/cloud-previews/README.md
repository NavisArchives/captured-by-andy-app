# Previews made in Google's cloud

Making a clip's 720p preview on the Mac means downloading the whole original
once (about 150 GB for every kept clip, a day and more on a slow line). This
does it inside Google's network instead, where reading from Drive is fast, so
the Mac only downloads the previews (a few MB each).

1. Captured by Andy writes the list of clips to
   `My Drive/STORAGE/CBA-PREVIEWS/manifest.json` a minute after it opens
   (Drive id, path in My Drive, S-Log3 or not).
2. Open `Captured_by_Andy_previews.ipynb` in Google Colab (free), *Runtime →
   Run all*, allow Google Drive. It writes `<drive id>.mp4` previews into
   `My Drive/STORAGE/CBA-PREVIEWS-720`, a folder Colab makes itself: 1280×720 H.264 ~2.5 Mbit/s, AAC 64 kbit/s, at most 50 fps, with
   the app's own S-Log3 colour maths (`make_previews.py`, same table as
   `src-tauri/helpers/review.swift`).
3. The app takes a cloud preview when there is one before it would download
   an original (`review::from_cloud`).

   When the Google Drive app on the Mac can't upload the list, build a
   notebook that carries it: `python3 build_notebook.py <manifest.json>
   ready/Captured_by_Andy_previews.ipynb` (`ready/` is not in git).
   `python3 build_notebook.py` alone rebuilds the plain notebook after a
   change to `make_previews.py`.

Originals are only read; nothing in Drive is changed except those folders.
Tested locally on one clip (worker output 960×540 at the first 540p setting, colours matching the app's
helper). Not yet run in Colab itself.
