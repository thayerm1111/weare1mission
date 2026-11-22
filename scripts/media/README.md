# One Mission welcome film

The published welcome is a static, narrated portrait film. Watching it never calls
Atlas, a paid signal engine, or a broker endpoint. The app player uses native video
controls, English captions, chapter seeking and the same written transcript.

## Published assets

- `public/videos/welcome-v1.mp4` — H.264 / AAC, 720 × 1280 at 24 fps.
- `public/videos/welcome-v1-poster.webp` — lightweight still shown before playback.
- `public/videos/welcome-v1.vtt` — two-line captions from the narration's phoneme timings.
- `src/lib/onboarding/welcome.ts` — player metadata and transcript.
- `scripts/media/welcome-storyboard.json` — visual directions, timed chapters and voice provenance.

The illustration uses the real OM mark geometry and the existing Atlas orbit
artwork. Account fields, order levels and performance values are labels or
placeholders. No private member data is present in the film.

## Recreate the narration

Use an isolated Python environment with `kokoro-onnx==0.6.1` and `soundfile`.
Download `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the
[maintainer's model-files-v1.1 release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1).
The source model is [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M),
published with Apache-2.0 weights; the ONNX runtime wrapper is MIT licensed.
Model and voice-file SHA-256 digests are recorded in the storyboard. Model weights
are build-time inputs and are not committed or downloaded by members.

```sh
python scripts/media/narrate_welcome.py \
  --model /path/kokoro-v1.0.onnx \
  --voices /path/voices-v1.0.bin \
  --workdir /path/welcome-narration
```

The script produces `narration.wav` and per-chapter checkpoints in the work
directory, then updates the storyboard, TypeScript metadata and VTT. It reuses
matching checkpoints. Captions are matched to model-derived phoneme timings;
alignment below 90%, invalid intervals and overlapping captions stop the build.
The narration uses `af_heart` at 0.95 speed. No API credentials are required.

## Render and inspect

Install Pillow and NumPy in the render environment, and make FFmpeg/ffprobe
available. Lato is preferred; DejaVu Sans is the fallback font.

```sh
python scripts/media/render_welcome.py \
  --audio /path/welcome-narration/narration.wav \
  --output public/videos/welcome-v1.mp4 \
  --poster public/videos/welcome-v1-poster.webp \
  --contact-sheet /path/welcome-storyboard.png
```

Use `--stills-only` for visual review or `--test-seconds 9` for a short encode.
Production rendering requires narration and refuses to truncate it. Review each
scene and both panels of FLOW/manual execution, caption readability, actual video
playback, duration and seeking before releasing a new version.

## First-visit behavior

The member's first eligible portal visit offers `one_mission_welcome_v1` after the
existing disclosure settles. Automatic credit notices wait until the welcome
closes. Playback requires a gesture; closing, navigation or hiding the page pauses
it. Explicit skip, completion or Start exploring acknowledges the version through
the existing `portal_announcements_seen` table. Failed reads do not claim a member
has seen it. Replay tutorial remains available in the account menu, including in
the Command Center. Samples do not fetch announcement state.

The production narration export helper used during development was removed.
There is no paid narration-generation endpoint in this release.
