# Chrome Web Store submission

Everything to paste into the developer dashboard, plus the steps.

## 1. Build the upload zip

```bash
python3 scripts/package.py
```

Upload `dist/mappedscroller-<version>.zip`. For every later update, raise `"version"` in
`extension/manifest.json` first (0.0.0.1 → 0.0.0.2 …), then rebuild.

Manifest fields (fixed after upload):

| Field | Value |
|---|---|
| name | MappedScroller |
| version | 0.0.0.1 |
| description (119/132) | Scroll two tabs together with matching headings and question numbers lined up, like a practice test and its answer key. |
| icons | 16, 32, 48, 128 (128 has 96px artwork + 16px transparent padding, per store guidelines) |

## 2. Store listing tab

**Category:** Productivity → Tools (or Education)
**Language:** English

**Detailed description:**

```
Compare two pages side by side without scrolling each one separately.

MappedScroller links two tabs so they scroll together. It doesn't just keep them at the same percentage: it finds the headings and question numbers the pages have in common and keeps them level. Question 7 in a practice test stays next to Question 7 in its answer key, even when one has a long explanation and the other a one-line answer.

HOW TO USE
1. Open the two pages.
2. Click the MappedScroller icon, pick the two tabs, and click "Link & sync".
3. Click "Show side by side" to put them in two half-screen windows.
4. Scroll either one, and the other follows.

FEATURES
• Matches headings, plus numbered labels like "1.", "Q1", "Question 1", "Part B" and numbered lists
• Ignores words like "Answers", "Solutions" and "Key", so "Test 3" matches "Test 3 – Answer Key"
• Works inside file viewers and grading pages that show documents in embedded frames
• Option to scroll by the same percentage instead
• Alt+Shift+S pauses and resumes syncing
• The popup shows how many headings matched in each tab

GOOD FOR
Practice tests and answer keys, assignments and rubrics, two versions of a document, a translation and its original, lecture notes and slides.

PRIVACY
Everything happens in your browser. MappedScroller reads only the two tabs you link, sends nothing anywhere, and has no tracking.

LIMITATIONS
Chrome's built-in PDF viewer can't be accessed by extensions, so PDFs opened directly in Chrome can't be synced.
```

**Graphics** (in `store/`):

| Asset | File |
|---|---|
| Store icon 128×128 | `extension/icons/icon128.png` |
| Screenshot 1280×800 | `store/screenshot-1-side-by-side.png` |
| Screenshot 1280×800 | `store/screenshot-2-popup.png` |
| Small promo tile 440×280 | `store/promo-small-440x280.png` |

## 3. Privacy tab

**Single purpose:**

```
Scroll two browser tabs chosen by the user together, keeping matching headings and question numbers aligned.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | Lists the user's open tabs (titles and URLs) in the popup so they can choose which two to link, and detects when a linked tab is closed. |
| `scripting` | Injects the scroll-sync script into the two tabs the user links, only when the user clicks "Link & sync". |
| `storage` | Remembers which two tabs are linked and the user's settings in session storage, which is cleared when the browser closes. |
| `webNavigation` | Detects when a linked tab, or a document viewer frame inside it, loads a new page, so syncing keeps working after navigation or when a viewer loads a file. |
| Host permission `<all_urls>` | The user can link tabs on any website (course sites, document viewers, grading pages), and those viewers often load the document in a frame from a different domain. The script runs only in the two tabs the user explicitly links. |

**Remote code:** No, I am not using remote code.

**Data usage:** check **none** of the data categories. Page headings and scroll positions are read and used only on the
device and are never transmitted, so they don't count as collected data. Then certify all three statements
(no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** host `PRIVACY.md` somewhere public and paste the link. For example, the GitHub file
URL if the repo is public, or a GitHub Gist, or Google Sites.

## 4. Distribution tab

Visibility: start with **Unlisted** if you want to test the store install yourself before making it public.

## Review notes

The broad host permission (`<all_urls>`) usually means a longer, in-depth review (often several days).
That's expected. The justification above explains why it's needed.
