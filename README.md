# Jellyfin Clip Export

Adds **Set In**, **Set Out** and **Export Clip** buttons to the Jellyfin Web video player OSD. Pick a range while watching, press export, and the clip lands in your Downloads folder.

Two parts:

- `Jellyfin.Plugin.ClipExport` — a server plugin that does the cut with the server's own ffmpeg
- `Jellyfin-VideoOSD-Clip-Export-v2.js` — an injected script that adds the OSD buttons and calls it

Built against **Jellyfin 12.1** (`net10.0`). For a 10.x server, pin the
`Jellyfin.Controller`/`Jellyfin.Model` package references back to `10.11.5`,
set `<TargetFramework>net9.0</TargetFramework>`, and set `targetAbi` to
`10.11.0.0` in `build.yaml`.

## Install

**1. The server plugin**

Easiest is the plugin repository. In Jellyfin: **Dashboard → Plugins →
Repositories → +**, name it anything, and use this URL:

```
https://raw.githubusercontent.com/circle3451/jellyfin-plugin-clipexport/main/repo/manifest.json
```

Then install **Clip Export** from **Dashboard → Plugins → Catalog** and
restart Jellyfin.

<details>
<summary>Or install the DLL by hand</summary>

```shell
dotnet build Jellyfin.Plugin.ClipExport/Jellyfin.Plugin.ClipExport.csproj -c Release
```

Copy `Jellyfin.Plugin.ClipExport/bin/Release/net10.0/Jellyfin.Plugin.ClipExport.dll` into a folder named `ClipExport` inside your Jellyfin `plugins` directory, then **restart Jellyfin**.

Typical locations:

| Platform | Path |
|---|---|
| Linux | `/var/lib/jellyfin/plugins/ClipExport/` |
| Docker | `/config/plugins/ClipExport/` |
| macOS | `~/.local/share/jellyfin/plugins/ClipExport/` |
| Windows | `%LOCALAPPDATA%\jellyfin\plugins\ClipExport\` |

</details>

Settings appear under **Dashboard → Plugins → Clip Export**.

**2. The OSD buttons**

Copy the contents of `Jellyfin-VideoOSD-Clip-Export-v2.js` and inject it with the **JavaScript Injector** plugin, or install it in a userscript manager. Reload Jellyfin Web.

During playback the three buttons appear next to the rating/favorite buttons.

## Use

| Button | Action |
|---|---|
| ⟢ Set In | Marks the clip start at the current playback position |
| ⟣ Set Out | Marks the clip end |
| ✂ Export Clip | Cuts and downloads |

The marks show next to the buttons as `12:30 → 13:45`. They reset when you switch to a different video.

## Cut modes

Configured under **Dashboard → Plugins → Clip Export**, or overridden per-request with `CONFIG.cutMode` in the script.

### `copy` (default)

Lossless stream copy. The cut starts at the keyframe at or before your in-point, so the clip can begin **up to one keyframe interval early** (typically 0–2s) and runs that much longer.

That is extra *real* footage, not dead video — the stream is continuous from the first frame, and nothing you selected is ever missing. The output is bit-for-bit identical to the source.

### `exact`

Re-encodes so the clip begins precisely on the in-point. Frame-accurate, but slower and re-compressed (H.264/AAC at the configured CRF). Worth it only when you need the exact frame.

Because this runs on the server rather than in the browser, even `exact` is reasonably quick — the server's ffmpeg is multi-threaded and native.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| Cut mode | `copy` | `copy` (lossless, fast) or `exact` (re-encode) |
| Maximum clip length | 1800s | Requests longer than this are refused |
| x264 preset | `veryfast` | Used in exact mode |
| CRF | 18 | Quality in exact mode; lower is better and larger |

## Why this is a server plugin

The first version did everything in the browser with ffmpeg.wasm. That works for small files and is a genuinely nice install story — one JS file, no restart — but it cannot handle a feature film. Measured in Chrome:

- `ffmpeg.writeFile()` succeeds at 1536 MB and fails at 2048 MB with `Array buffer allocation failed`
- Mounting the source as a `Blob` via `WORKERFS` avoids the heap, but **a Blob the size of a 1.5 GB film is unreadable**: even a 64 KB read from it throws `NotReadableError`, while an 8 MB Blob reads fine

Several cleverer schemes were tried and measured before concluding this:

- **Prefix fetch** (bytes 0..out-point) — works, but a clip an hour into a film pulls an hour of data
- **Sparse buffer at original offsets** — only needs ~6% of the file, but is the size of the source by construction, which is exactly what the browser cannot hold
- **Header + mid-range concatenation** — corrupts the container, since the byte offsets shift. Produced 134s of garbage for a 10s request

The server has the file on local disk and a real ffmpeg. None of these limits apply, any file size works, and the cut is effectively instant.

## Notes

- The endpoint sits behind Jellyfin's `Download` policy, so users need download permission.
- **No files are left behind.** The clip is written to a `clip-export` folder inside Jellyfin's own temp directory and deleted the moment the download finishes — verified that this holds both for a normal download and for a client that disconnects mid-transfer. The one case it cannot cover is the server being killed while a download is open; a leftover file then survives, so the plugin also sweeps anything in that folder older than 6 hours on each export. Files still in flight, and anything not written by the plugin, are never touched.
- Subtitles are dropped from exported clips.
- In exact mode only the first video and audio track are exported.
- A WebM source in exact mode is written as `.mkv`, since WebM cannot carry H.264. In copy mode the source container is always kept.
- **HEVC clips are retagged `hvc1`.** QuickTime plays HEVC in MP4 only when the video track carries the `hvc1` tag; many encoders write the equally legal `hev1`, and QuickTime silently refuses those while VLC plays them fine. The plugin rewrites the tag on HEVC MP4 output — pure metadata, byte-identical, still a lossless stream copy. H.264 and Matroska output are untouched, since tagging those would break the file.

## Licence

MIT
