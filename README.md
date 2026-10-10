# Echo Recall

> **Memorize your notes and paragraphs actively with spaced repetition and retrospective revision timetable directly inside Obsidian.**

<table>
<tr>
<td width="50%">
<img src="https://raw.githubusercontent.com/sajee05/echo-recall/main/banner.png" width="100%">
</td>
<td width="50%">
<img src="https://raw.githubusercontent.com/sajee05/echo-recall/main/main.png" width="100%">
</td>
</tr>
</table>

![Obsidian](https://img.shields.io/badge/Obsidian-v1.4.0+-483699.svg?style=for-the-badge&logo=obsidian&logoColor=white)
![Release](https://img.shields.io/badge/Release-v1.2.0-success.svg?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

Echo Recall turns your own notes into an active-recall study tool. It turns your long study notes into a dynamic memory game. You read your real note, parts of it get hidden, and you try to remember them before revealing.

---

## 1. What problem does this solve?

Flashcard apps (like Anki) chop your notes into tiny, out-of-context cards. You lose the "big picture." Echo Recall keeps your note whole and just hides pieces of it, step by step, so you're always recalling things *in context*.


## 2. Recall Modes

Go to **Settings → Echo Recall → Recall Mode** and pick ONE. Only one mode runs at a time.

| Mode | What gets hidden | Best for |
|---|---|---|
| **Heading Recall** (default) | The entire content under one heading at a time | Concepts, ideas, theories, summaries and explanations |
| **Fill in the Blank** | Individual words and phrases, turned into blanks (`____`) | Poetry, speeches, quotations, definitions, and anything you must get word-for-word |


## 3. Workflow (3 steps)

1. Open any note you want to revise.
2. Click the **[▶ echo]** button at the top-right of the note (or run the command **"Revise active note"**).
3. Follow the on-screen steps: read, recall, reveal, repeat.

That's it. 


## 4. How a Fill in the Blank session works

1. **Step 1 — Read it.** Full text shown, no blanks. Just read it a couple of times.
2. **Step 2 — Light blanks.** Some words are hidden. Try to say the missing words out loud.
3. **Step 3 — Heavy blanks.** More words hidden. If you get stuck, go back a step and re-read.

At the end, you grade how well you remembered it (Hard / Moderate / Easy), and the app decides when to show you this note again.


## 5. Scheduling — when will I see this note again?

Two modes, pick one in Settings:

- **Confidence mode (simple, default):**
  - Hard → see it again tomorrow
  - Moderate → see it again in 7 days
  - Easy → see it again in 14 days
- **Adaptive (SM-2) mode:** A smarter algorithm (same one Anki uses) that adjusts the gap based on how well you actually remembered it, every time.

**Exam deadline:** You can set a deadline date on any note. If the deadline is close, Echo Recall automatically shortens the gap so you don't fall behind before your exam.


## 6. The Dashboard

Click the brain icon in the left sidebar to open it. It shows:

- How many notes are **due today**, with a "Start Due Notes" button to revise them all in one go
- A **heatmap** of your past revision activity (like GitHub's contribution graph)
- Your current **streak**, total revisions, and a breakdown by confidence level
- A table of every note you're tracking — tags, last revised date, confidence, deadline — all editable right there
- **Tag-wise view** — group notes by tag and revise a whole tag at once
- **Archive** — notes you're done with, so they stop showing up as "due"


## 7. Exporting to Anki (optional)

If you'd rather revise on your phone using Anki, you can export your notes as Anki flashcards.

### 7.1 One-time setup (do this first!)
1. Open **Anki** (the desktop app) and keep it running.
2. In Anki: **Tools → Add-ons → Get Add-ons…**
3. Paste this code: `2055492159` and click OK. This installs **AnkiConnect** <= Echo Recall talks to Anki through it.
4. Restart Anki.
5. (Optional) In Obsidian Settings → Echo Recall, check the **AnkiConnect port** — it should say `8765`. Only change this if you edited AnkiConnect's own config to use a different port.

> ⚠️ Anki must be **open in the background** every time you export or update — Echo Recall sends your notes to it live over that port.

### 7.2 Exporting
- Click the "cards/layers icon" in the sidebar (or run **"Export active note to Anki"**) while viewing a note.
- Your note is split the same way it's chunked for revision (in heading recall mode), and each piece becomes one Anki card with a "View Full Note" button so you never lose context.
- Images and linked notes are carried over automatically.

### 7.3 Updating after you edit a note
- Instead of re-exporting (which can create duplicates), run **"Differential update Anki cards"**. It only pushes what actually changed, and resets the card's Anki schedule for anything that changed.

## 8. Where is my data stored?

Nowhere external. Everything: confidence, next revision date, deadline, tags, history = is saved as plain YAML **properties at the top of the note itself**. Your data lives in your vault, in your notes, no cloud.


## 9. All Settings simplified: 

| Setting | What it does |
|---|---|
| **Recall Mode** | Pick Heading Recall (default) or Fill in the Blank, plus the optional "full note" checkbox — see section 3 |
| **AnkiConnect port** | The port number Anki listens on for exports. Default `8765` — don't touch unless you know you changed it |
| **Deck name** | Which Anki deck your exported cards land in |
| **Tags** | Tags added to every exported Anki card |
| **Scheduling mode** | Confidence (fixed days) or Adaptive SM-2 (smart) — see section 5 |
| **Simplify SM-2 grades** | Shows only "Good"/"Again" instead of 4 grade buttons, if SM-2 is on |
| **Cueing mode** | How a hidden word looks: fully blank, first-letter shown, or "graduated" (starts with a hint, removes it later) |
| **Enable typed recall** | Adds a box to type out the passage from memory and get a % score |
| **Enable [▶ echo] button** | Shows/hides the quick-start button at the top of your notes |
| **Chunking** | How a long note is split into revision pieces: by heading (recommended), by paragraph, by sentence, or not at all |
| **Interleave due notes** | Mixes topics together when revising several due notes, instead of doing them one tag at a time (proven to help memory) |
| **Click-to-reveal blanks** | Lets you click a blank to peek at the answer (shown in red, so you know you cheated) |
| **Don't revise callouts / checkboxes / quotes** | Skip masking text inside these block types |
| **Exclude internal/external links, embeds** | Skip masking text inside `[[links]]`, `[links](url)`, or `![[embeds]]` |
| **Custom regex** | Advanced: skip masking anything matching your own pattern |


## 10. Credits

Open source - contributions welcome. ⭐ 

* **[sxjeel](https://github.com/sajee05):** Creator and maintainer, Ideation, UI/UX, Dashboard, analytics, Context-aware chunking, etc. ☕
* **[@DocGRD](https://github.com/DocGRD):** Core contributor of the Adaptive SM-2 logic, base Chunking engine, Graduated cueing, and Typed-recall scoring. 🧩
