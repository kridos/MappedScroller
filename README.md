# MappedScroller

A browser extension (Chrome / Edge / Brave / Arc) that links two tabs and scrolls them together.
Matching sections stay lined up, not just the same percentage down the page. Scroll a practice test
and its answer key, and **Question 7** in one tab stays level with **Question 7** in the other, even
when one page has a long explanation and the other a one-line answer.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Optional: pin the extension to the toolbar.

To use it on local `file://` pages, open the extension's **Details** and turn on **Allow access to file URLs**.

## Use

1. Open the two pages.
2. Click the MappedScroller icon, pick the **First tab** and **Second tab**, and click **Link & sync**.
3. Click **Show side by side** to put the two tabs in two windows, one on each half of the screen.
4. Scroll either tab and the other one follows.

The popup shows how many headings it matched. **Alt+Shift+S** pauses and resumes syncing.
You can change the shortcut at `chrome://extensions/shortcuts`.

## How matching works

Each tab collects **anchors**:

| Found on the page | Becomes key |
|---|---|
| `<h1>`–`<h6>` / `role="heading"` text | `h:<normalised text>` (lower-case, no punctuation, words like "answers", "solutions" and "key" removed, so "Practice Test 3" = "Practice Test 3 – Answer Key") |
| A block starting with `1.`, `(1)`, `Q1`, `Question 1`, `Problem 1`, … | `q:1` |
| A block starting with `Section 2`, `Part B`, `Chapter IV`, … | `s:2`, `s:b`, `s:iv` |
| Items of a top-level `<ol>` (auto-numbered) | `q:<n>` |

Repeated keys get an occurrence suffix (`q:1#0`, `q:1#1`, …), so numbering that restarts in each section still pairs up.

The two tabs exchange anchors. Keys found on both pages become matching points, and matches that are
out of order are dropped (longest increasing chain). Between two matching points the scroll position
is interpolated linearly. Headings are lined up about 30% of the way down the window. That point slides
to the very top or bottom of the window near the ends of the page, so top lines up with top and bottom with bottom.

If no headings match, or you pick **Same % down the page**, the tabs scroll by percentage instead.

### File viewers and graders

Sites that preview files (LMS file previews, SpeedGrader-style grading pages, document viewers) usually show
the document inside an embedded frame, often from a different domain. The extension runs in every frame of a
linked tab and syncs the frame that holds the document: the one with the largest scrollable area, or the one you
last scrolled. Smaller scrolling panels next to it, such as a grading sidebar, don't take over. When the viewer
loads a new file in its frame (e.g. switching students), the new frame is picked up automatically. The popup shows,
for each tab, whether it's syncing the main page or an embedded viewer, and how many headings it found there.

Anchors are recalculated when the page changes (content loads, images resize, window resize), and
re-sent automatically if a linked tab reloads or navigates.

## Limitations

- **PDFs in Chrome's built-in viewer can't be synced.** Browsers don't let extensions read or scroll that viewer.
  Workaround: use the HTML version of the document, or open the PDF in a web-based viewer that renders text (e.g. pdf.js).
- Browser-internal pages (`chrome://…`, the Web Store) are off-limits to all extensions.
- Viewers that draw the file as **images** (scanned PDFs, some document viewers that render pages to a canvas
  with no text) have no headings to match. *Same % down the page* still works there.

## Try it

`demo/practice-test.html` and `demo/answers.html` are a test and its answer key with very different section lengths:

```bash
cd demo && python3 -m http.server 8000
```

Open http://localhost:8000/practice-test.html and http://localhost:8000/answers.html, link them, and scroll.

## Files

```
extension/
  manifest.json   MV3 manifest
  background.js   service worker: remembers the linked pair, relays messages, re-injects on reload
  content.js      anchor detection, position mapping, scroll sync
  popup.html/js/css  the toolbar popup
  icons/
demo/             sample pages
```
