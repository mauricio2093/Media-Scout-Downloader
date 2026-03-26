# Media Scout Downloader

Media Scout Downloader is a Chrome/Chromium extension built with Manifest V3 that detects accessible media resources from the active tab and lets you inspect, filter, copy, open, and download them from a lightweight popup.

It is designed for publicly accessible media and does not attempt to bypass DRM, encryption, or protected delivery systems.

## Features

- Detects media from both the page DOM and network responses
- Supports video, audio, and HLS/DASH playlists such as `.m3u8` and `.mpd`
- Shows detected items in a clean popup with search, filters, and sorting
- Lets you download media, copy the direct URL, or open it in a new tab
- Stores a temporary per-tab catalog so detections survive service worker restarts
- Includes a settings page to control detection behavior and reduce noise

## Settings

The extension includes a built-in options page where you can:

- Enable or disable DOM detection
- Enable or disable network detection
- Set a minimum audio size threshold to ignore tiny UI sounds
- Limit the number of stored items per tab
- Choose whether downloads should always show the Save As dialog
- Block specific hosts and subdomains

## How It Works

Media Scout Downloader combines two detection strategies:

- DOM scanning: looks for `<video>`, `<audio>`, and `<source>` elements already present in the page or injected dynamically
- Network inspection: listens to response headers to identify media resources that may not be visible in the DOM

Detected entries are merged into a tab-specific catalog and enriched with available metadata such as MIME type, host, size, thumbnail, duration, and source.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions/` in Chrome or Chromium.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the project root folder.

## Usage

1. Open a page with accessible media content.
2. Play or load the media so the extension can detect it.
3. Open the extension popup.
4. Search, filter, or sort results if needed.
5. Choose one of the available actions:

- `Download`
- `Copy URL`
- `Open URL`

Use `Refresh` to force a new scan or `Settings` to change detection behavior.

## Permissions

The extension uses these permissions:

- `downloads`: start file downloads
- `tabs`: access the active tab and open detected URLs
- `storage`: save temporary catalog data and user settings
- `webRequest`: detect media resources from network responses
- `host_permissions: <all_urls>`: inspect supported pages and requests across sites

## Project Structure

```text
.
|-- manifest.json
|-- README.md
|-- assets/
|-- scripts/
`-- src/
    |-- background/
    |-- content/
    |-- options/
    |-- shared/
    `-- ui/
```

## Local Utility Script

This repository also includes a small helper script for converting HLS manifests to MP4 with `ffmpeg`:

```bash
node scripts/m3u8-to-mp4.js "https://example.com/stream.m3u8" output.mp4
```

This script is optional and separate from the browser extension.

## Limitations

- HLS and DASH playlists may be detected as manifests, but the extension does not reconstruct segmented streams automatically
- Some media URLs may expire quickly or depend on cookies, headers, or session state
- Preview behavior depends on whether the media is directly playable from the extension context
- DRM-protected or encrypted content is out of scope

## Legal Notice

Use this project only for content you are allowed to access, download, or process. Respect copyright, platform rules, and the terms of service of the sites you visit.

## Development

This project is a plain JavaScript Chrome extension with no build step and no `package.json` dependency pipeline.

Main areas:

- `src/background/`: catalog, persistence, network detection, downloads
- `src/content/`: DOM scanning and dynamic media detection
- `src/ui/`: popup interface
- `src/options/`: public settings page
- `src/shared/`: shared settings helpers

## Status

The extension is functional and actively structured for further improvements such as better playlist handling, export tools, and broader automated testing.
