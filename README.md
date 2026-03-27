# Media Scout Downloader

Media Scout Downloader is a Manifest V3 Chrome/Chromium extension that detects publicly accessible media on the active tab and lets you inspect, filter, copy, open, and download those resources from a compact popup UI.

It is built for accessible media discovery only. It does not bypass DRM, encrypted streams, paywalls, signed session logic, or protected delivery systems.

## Why This Project Exists

When a page loads multiple videos, audios, alternate qualities, or playlist manifests, browser devtools can get noisy fast. Media Scout Downloader gives you a focused per-tab catalog so you can quickly see what media was found and act on it.

## Core Capabilities

- Detects media from two sources:
  - DOM scanning for `<video>`, `<audio>`, and `<source>` elements already on the page or injected later
  - Network inspection through response headers for media that never appears directly in the DOM
- Supports common media categories:
  - Video
  - Audio
  - Playlist manifests such as `.m3u8` and `.mpd`
- Groups related detections and keeps the popup usable with:
  - Search by file name, host, URL, quality, MIME type, and related labels
  - Type filters for videos, audios, and playlists
  - Sorting by recency, size, or host
- Lets you act on detected entries:
  - Download
  - Copy URL
  - Open URL in a new tab
- Persists a temporary catalog per tab so detections survive service worker restarts
- Includes an options page to tune detection behavior and reduce noise

## What It Does Not Do

- Rebuild HLS or DASH segmented streams automatically from inside the extension
- Circumvent DRM, encryption, authentication barriers, or access restrictions
- Guarantee downloads for URLs that depend on cookies, expiring signatures, or custom request headers
- Convert playlist manifests to a final media file inside the popup

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome or Chromium.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the project root folder.

There is no build step. The extension loads directly from source.

## Quick Start

1. Open a page that loads accessible media.
2. Let the page start loading or playing the target media.
3. Open the Media Scout Downloader popup.
4. Review the detected entries.
5. Use the popup tools:
   - `Actualizar` to rescan the current tab
   - `Limpiar pestaña` to clear the current tab catalog
   - `Ajustes` to open the settings page
6. For each result, choose the action you need:
   - `Download`
   - `Copy URL`
   - `Open URL`

## Settings

The built-in options page exposes the current detection and download controls:

- Enable or disable DOM detection
- Enable or disable network detection
- Set a minimum audio size threshold to ignore tiny UI sounds
- Limit the number of stored entries per tab
- Choose whether downloads should always show the Save As dialog
- Block specific hosts and their subdomains

Current defaults from the codebase:

- DOM detection: enabled
- Network detection: enabled
- Minimum audio size: `50 KB`
- Max entries per tab: `250`
- Prefer Save As: enabled
- Blocked hosts: empty

## Permissions

The extension requests the following permissions:

- `downloads`: starts browser-managed downloads
- `scripting`: reinjects the content scanner when a manual rescan is needed
- `storage`: stores settings and the temporary tab catalog
- `tabs`: reads the active tab context and opens detected URLs when requested
- `webRequest`: inspects response headers to detect media resources
- `host_permissions: <all_urls>`: allows detection on arbitrary sites instead of a fixed allowlist

## How Detection Works

At a high level, the extension keeps a tab-scoped media catalog in the background service worker.

1. A content script scans the page for media elements and can rescan on demand.
2. The background worker listens to response headers and classifies likely media responses.
3. Entries are normalized, deduplicated, and merged into a per-tab catalog.
4. The popup fetches that catalog, groups related variants, and exposes actions.

The catalog stores metadata when available, including URL, MIME type, host, source, file name, duration, thumbnail, size, platform hints, and stream-role hints such as muxed, video-only, or audio-only.

## Repository Layout

```text
.
|-- assets/
|   `-- img/
|-- scripts/
|   `-- m3u8-to-mp4.js
|-- src/
|   |-- background/
|   |-- content/
|   |-- options/
|   |-- shared/
|   `-- ui/
|-- manifest.json
|-- release.ps1
|-- release.sh
`-- README.md
```

## Helper Script

This repository also includes a small Node.js helper for converting an HLS manifest URL to MP4 using `ffmpeg`.

Requirements:

- Node.js
- `ffmpeg` available in `PATH`

Usage:

```bash
node scripts/m3u8-to-mp4.js "https://example.com/stream.m3u8" output.mp4
```

This helper is separate from the extension UI. It is only a local CLI utility.

## Development Notes

- Plain JavaScript project
- No bundler
- No `package.json`
- No dependency installation required for the extension itself
- Source files are loaded directly by the browser

Main areas:

- `src/background/`: catalog management, persistence, network detection, downloads
- `src/content/`: DOM scanning and page-side detection hooks
- `src/ui/`: popup interface and actions
- `src/options/`: extension settings page
- `src/shared/`: shared settings helpers and normalization logic

## Limitations and Expected Edge Cases

- Playlist manifests may be detected even when the final segments are not directly downloadable as one file
- Some media URLs expire quickly or work only during an authenticated browser session
- Some sites expose many low-value media requests such as UI sounds; the audio threshold exists to reduce that noise
- Detection quality depends on what the page exposes through DOM elements or response headers

## Legal Notice

Use this project only for media you are allowed to access, inspect, or download. You are responsible for complying with copyright law, platform rules, and the terms of service of the sites you visit.

## Status

Current repository status:

- Functional local extension
- Manual installation through unpacked mode
- No automated test suite yet
- Room to improve playlist workflows, export tooling, and broader validation
