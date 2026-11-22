#!/usr/bin/env python3
"""Create the static welcome narration locally, without member voice services.

Requires kokoro-onnx==0.6.1, soundfile, and the official v1.0 model/voices.
Model: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1
The renderer consumes narration.wav and the updated storyboard. No model ships to browsers.
"""
import argparse
from difflib import SequenceMatcher
import hashlib
import html
import json
import math
from pathlib import Path
import re
import textwrap

import numpy as np
import onnxruntime as ort
import soundfile as sf
from kokoro_onnx import Kokoro


def speech(text):
    return text.replace("OM AI", "O M A I").replace("GENX", "Gen X").replace("FLOW", "Flow").replace("BUY", "Buy").replace("SELL", "Sell").replace("AI", "A I")


def stamp(seconds):
    ms = round(max(0, seconds) * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02}.{ms % 1000:03}"


def caption_chunks(text):
    # Balance complete sentences into readable two-line cues. Avoid one-word
    # flashes and keep article/verb phrases together when a sentence must split.
    chunks = []
    dangling = {"a", "the", "and", "or", "with", "to", "of", "on", "then", "for", "your", "as", "in", "at", "by", "any", "analyze", "generate", "tradelocker", "om", "ai"}
    for sentence in re.split(r"(?<=[.!?])\s+|(?<=[.!?][”’])\s+", text):
        words = sentence.split()
        cost, take = {len(words): 0}, {}
        for start in range(len(words) - 1, -1, -1):
            best = float("inf")
            for end in range(start + 1, min(len(words), start + 12) + 1):
                candidate = " ".join(words[start:end])
                if len(textwrap.wrap(candidate, 39, break_long_words=False, break_on_hyphens=False)) > 2:
                    break
                length = end - start
                score = 100 + (length - 8) ** 2 + cost[end]
                if length < 3 and len(words) > 3: score += 180
                if end < len(words) and words[end - 1].lower() in dangling: score += 90
                if words[end - 1].endswith((",", ";", ":")): score -= 12
                if score < best: best, take[start] = score, end
            cost[start] = best
        cursor = 0
        while cursor < len(words):
            end = take[cursor]
            chunks.append(" ".join(words[cursor:end])); cursor = end
    return chunks


def phoneme_boundaries(kokoro, captions, spoken):
    # Match each caption's pronunciation to the actual model phonemes. Contextual
    # pronunciation differences are aligned, never estimated from character counts.
    phrases = [kokoro.tokenizer.known(" ".join(kokoro.tokenizer.phonemize(speech(c), "en-us").split())) for c in captions]
    expected = " ".join(phrases)
    actual = "".join(item["phoneme"] for item in spoken)
    matcher = SequenceMatcher(None, expected, actual, autojunk=False)
    assert matcher.ratio() > .90, f"Caption pronunciation alignment needs review ({matcher.ratio():.3f})"
    mapped = {}
    for op, a0, a1, b0, b1 in matcher.get_opcodes():
        if op == "equal":
            for n in range(a1 - a0): mapped[a0 + n] = b0 + n
        elif a1 > a0:
            for n in range(a1 - a0): mapped[a0 + n] = min(len(actual) - 1, b0 + round(n * max(0, b1 - b0 - 1) / max(1, a1 - a0 - 1)))
    offset, windows = 0, []
    for phrase in phrases:
        a = mapped[offset]
        b = mapped[offset + len(phrase) - 1]
        windows.append((spoken[a]["start"], spoken[b]["end"]))
        offset += len(phrase) + 1
    return windows, round(matcher.ratio(), 5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--voices", type=Path, required=True)
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--storyboard", type=Path, default=Path("scripts/media/welcome-storyboard.json"))
    parser.add_argument("--metadata", type=Path, default=Path("src/lib/onboarding/welcome.ts"))
    parser.add_argument("--captions", type=Path, default=Path("public/videos/welcome-v1.vtt"))
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=.95)
    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    board = json.loads(args.storyboard.read_text())
    options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
    model = Kokoro.from_session(ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"]), str(args.voices))
    assert model.has_timings, "This model must expose phoneme duration timings"
    rate = 24000
    parts, cues, report = [], [], []
    cursor = 0
    for chapter in board["chapters"]:
        text = speech(chapter["narration"])
        digest = hashlib.sha256(f"{args.voice}:{args.speed}:{text}".encode()).hexdigest()
        wav = args.workdir / f"{chapter['id']}.wav"
        timing_path = args.workdir / f"{chapter['id']}.json"
        saved = json.loads(timing_path.read_text()) if timing_path.exists() else {}
        if saved.get("digest") == digest and wav.exists():
            audio, read_rate = sf.read(wav, dtype="float32"); assert read_rate == rate
            spoken = saved["timings"]
        else:
            audio, read_rate, timings = model.create_timed(text, voice=args.voice, speed=args.speed, lang="en-us", sentence_pause=.3, clause_pause=.1)
            assert read_rate == rate and len(timings) > 0
            spoken = [{"phoneme": t.phoneme, "start": float(t.start), "end": float(t.end)} for t in timings]
            sf.write(wav, audio, rate, subtype="PCM_16")
            timing_path.write_text(json.dumps({"digest": digest, "timings": spoken}, ensure_ascii=False))
        lead = np.zeros(round(.35 * rate), dtype=np.float32)
        tail = np.zeros(round((1.8 if chapter["id"] == "next" else .45) * rate), dtype=np.float32)
        part = np.concatenate([lead, audio, tail])
        chapter["start"] = round(cursor / rate, 4)
        chunks = caption_chunks(chapter["narration"])
        windows, ratio = phoneme_boundaries(model, chunks, spoken)
        for j, (caption, (start, end)) in enumerate(zip(chunks, windows)):
            next_start = windows[j + 1][0] if j + 1 < len(windows) else len(audio) / rate
            cues.append({"start": cursor / rate + .35 + start, "end": cursor / rate + .35 + min(next_start, end + .08), "text": caption})
        parts.append(part); cursor += len(part)
        chapter["end"] = round(cursor / rate, 4)
        report.append({"id": chapter["id"], "start": chapter["start"], "end": chapter["end"], "alignment": ratio})
        print(json.dumps(report[-1]), flush=True)
    all_audio = np.concatenate(parts)
    # Pad the last frame boundary so captions, media and chapter metadata share one duration.
    duration = math.ceil(len(all_audio) / rate * 24) / 24
    all_audio = np.pad(all_audio, (0, round(duration * rate) - len(all_audio)))
    sf.write(args.workdir / "narration.wav", all_audio, rate, subtype="PCM_16")
    board["durationSeconds"] = round(duration, 4)
    board["chapters"][-1]["end"] = board["durationSeconds"]
    board["timingStatus"] = "audio-aligned"
    board["narration"] = {"engine": "Kokoro-82M v1.0", "runtime": "kokoro-onnx 0.6.1", "voice": args.voice, "speed": args.speed, "modelSha256": hashlib.sha256(args.model.read_bytes()).hexdigest(), "voicesSha256": hashlib.sha256(args.voices.read_bytes()).hexdigest()}
    board["productionNotes"][0] = "Chapters and captions follow the narration's model-derived phoneme timings. The final frame holds after the voice finishes."
    args.storyboard.write_text(json.dumps(board, ensure_ascii=False, indent=2) + "\n")
    metadata = {key: board[key] for key in ("key", "title", "videoSrc", "posterSrc", "captionsSrc", "durationSeconds")}
    metadata["chapters"] = [{key: chapter[key] for key in ("id", "title", "start", "end", "narration")} for chapter in board["chapters"]]
    args.metadata.write_text("/** Shared metadata aligned to the published welcome narration. */\nexport const WELCOME_TUTORIAL = " + json.dumps(metadata, ensure_ascii=False, indent=2) + " as const;\n")
    args.captions.parent.mkdir(parents=True, exist_ok=True)
    rendered = []
    for i, cue in enumerate(cues):
        lines = textwrap.wrap(cue["text"], 39, break_long_words=False, break_on_hyphens=False)
        assert len(lines) <= 2 and cue["start"] < cue["end"] <= duration
        if i: assert cues[i - 1]["end"] <= cue["start"] + .001, "Overlapping captions"
        rendered.append(f"{i+1}\n{stamp(cue['start'])} --> {stamp(cue['end'])}\n" + html.escape("\n".join(lines), quote=False))
    args.captions.write_text("WEBVTT\n\n" + "\n\n".join(rendered) + "\n")
    (args.workdir / "report.json").write_text(json.dumps({"seconds": duration, "chapters": report, "captionCues": len(cues)}, indent=2))
    print(json.dumps({"seconds": duration, "captionCues": len(cues), "wav": str(args.workdir / "narration.wav")}), flush=True)


if __name__ == "__main__":
    main()
