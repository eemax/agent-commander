---
name: send-file
description: "Send files from the filesystem as Telegram attachments. USE WHEN: the user asks you to send, share, deliver, or attach a file — or when your task produces an output file the user needs to receive directly in the chat."
---

# Send File

## Overview

Embed attachment markers in your response to send files to the user via Telegram.

## Workflow

1. Ensure the file exists on disk (create it with `write_file` or `bash` if needed).
2. Use absolute paths. If you only know a relative path, resolve it first.
3. Include one marker per file in your response text:
   `<!-- attach: /absolute/path/to/file.ext -->`
4. Always include a text explanation alongside the markers.
5. Multiple markers are allowed for multiple files.

## Format Rules

- Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) render inline as photos.
- All other file types are sent as documents.
- Maximum size: 10 MB for photos, 50 MB for documents.
- Markers are invisible to the user — they are stripped before the text reply is sent.

## Constraints

- Paths must be absolute.
- File must exist at send time.
- Do not attach files the user did not request or expect.
