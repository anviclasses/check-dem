# AI MCQs Global Quiz Engine v2

Host once on GitHub → serve anywhere via jsDelivr CDN.

## Repository structure

```
aimcq-engine/
├── aimcq.css          ← all styles (scoped to #aimcq-root-scope)
├── aimcq.js           ← full engine (initAimcqQuiz + loadAimcqFromDrive)
├── embed-snippet.html ← ready-to-paste code for any website
└── README.md
```

## 1 — Push to GitHub & create a release tag

```bash
git init
git add aimcq.css aimcq.js README.md
git commit -m "v2.0.0 — initial CDN release"
git remote add origin https://github.com/YOUR-USER/aimcq-engine.git
git push -u origin main
git tag v2.0.0
git push origin v2.0.0
```

## 2 — CDN URLs (available ~10 min after tagging)

```
https://cdn.jsdelivr.net/gh/YOUR-USER/aimcq-engine@2.0.0/aimcq.css
https://cdn.jsdelivr.net/gh/YOUR-USER/aimcq-engine@2.0.0/aimcq.js
```

> Always pin a version tag. Never use `@latest` in production.

## 3 — Embed on any website

See `embed-snippet.html` for the full copy-paste block.

**Head tags (once per site):**
```html
<link  rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
<link  rel="stylesheet" href="https://cdn.jsdelivr.net/gh/YOUR-USER/aimcq-engine@2.0.0/aimcq.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js"></script>
<script defer src="https://unpkg.com/smiles-drawer@2.0.1/dist/smiles-drawer.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/gh/YOUR-USER/aimcq-engine@2.0.0/aimcq.js"></script>
```

**Optional global config (once per site, after the script tags above):**
```html
<script>
  window.AIMCQ_CONFIG = {
    appsScriptUrl: 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec'
  };
</script>
```

**Quiz block — Method 1: Inline JSON**
```html
<div id="aimcq-quiz-1"></div>
<script>
document.addEventListener('DOMContentLoaded', function () {
  window.initAimcqQuiz('aimcq-quiz-1', /* quizDataJSON */, {
    title: "My Quiz", timer: 10,
    shuffle_questions: true, shuffle_options: true, quiz_questions: 10
  });
});
</script>
```

**Quiz block — Method 2: Single JSON from jsDelivr / CDN URL**
```html
<div id="aimcq-quiz-2"></div>
<script>
document.addEventListener('DOMContentLoaded', function () {
  window.loadAimcqFromDrive('aimcq-quiz-2', {
    jsonUrl: 'https://cdn.jsdelivr.net/gh/USER/REPO@TAG/path/quiz.json',
    settings: { title: "My Quiz", timer: 10, shuffle_questions: true, quiz_questions: 10 }
  });
});
</script>
```

**Quiz block — Method 3: Multiple JSON files merged (topic tabs + section headings)**
```html
<div id="aimcq-quiz-3"></div>
<script>
document.addEventListener('DOMContentLoaded', function () {
  window.loadAimcqFromDrive('aimcq-quiz-3', {
    jsonUrls: [
      { jsonUrl: 'https://cdn.jsdelivr.net/gh/USER/REPO@TAG/ch1.json', topic: 'Chapter 1' },
      { jsonUrl: 'https://cdn.jsdelivr.net/gh/USER/REPO@TAG/ch2.json', topic: 'Chapter 2' }
    ],
    settings: {
      title: "My Multi-Chapter Quiz", timer: 20,
      shuffle_questions: true, shuffle_options: true, quiz_questions: 20,
      topic_order: ['Chapter 1', 'Chapter 2']
    }
  });
});
</script>
```

> See `embed-snippet.html` for Method 4 (Google Drive via Apps Script proxy).

## Exam interface — basic vs professional

Every method above accepts an `exam_interface` setting that selects which
quiz UI is rendered. It works identically for Methods 1, 2 and 3.

```js
exam_interface: 'basic'         // default — lightweight in-page interface
exam_interface: 'professional'  // full-screen SSC-style CBT exam interface
```

The **professional** interface is a full-screen Computer Based Test that
mirrors real SSC/competitive-exam software:

- Full-screen exam overlay with bilingual (EN/HI) instructions and an
  "I agree" declaration screen
- Top bar with quiz title and a live countdown timer
- Left question-palette panel — Not Visited / Not Answered / Answered /
  Marked for Review / Answered & Marked counters, per-topic section tabs,
  a clickable jump grid, and a Submit button
- Right question area with passage display, EN/HI language switcher,
  lettered options and explanations
- Bottom action bar — Mark for Review, Clear Response, Save & Next
  (plus Check Answer in revision mode)
- localStorage session persistence (resume after reload)
- Results screen with a per-section score breakdown table

Two extra settings apply **only** to the professional interface in exam
(non-revision) mode:

```js
marks_per_question: 1   // marks awarded for each correct answer
negative_marks:     0   // marks deducted for each wrong answer
```

All other settings (`title`, `timer`, `shuffle_questions`,
`shuffle_options`, `quiz_questions`, `topic_order`, etc.) behave the same
in both interfaces. If `exam_interface` is omitted, the basic interface is
used, so existing embeds are unaffected.

```html
<div id="aimcq-quiz-pro"></div>
<script>
document.addEventListener('DOMContentLoaded', function () {
  window.initAimcqQuiz('aimcq-quiz-pro', /* quizDataJSON */, {
    title: "SSC Mock Test", timer: 60,
    shuffle_questions: true, shuffle_options: true, quiz_questions: 100,
    exam_interface: 'professional',
    marks_per_question: 2,
    negative_marks: 0.5
  });
});
</script>
```

## Platforms confirmed compatible

- Blogger (original home)
- WordPress (paste in Custom HTML block)
- Plain HTML pages
- Any site that allows injecting `<script>` tags

## Updating the engine

1. Edit `aimcq.css` / `aimcq.js`
2. Commit and push a new tag (`v2.1.0`)
3. Update the version in your site's `<link>` and `<script>` src URLs
4. Old tagged versions remain available — existing embeds never break
