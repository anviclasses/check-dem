/* ==============================================================
   AI MCQs Global Quiz Engine v2 - Conflict-Free Edition
   JS  — host this file on GitHub and serve via jsDelivr CDN:
   https://cdn.jsdelivr.net/gh/YOUR-USER/aimcq-engine@VERSION/aimcq.js

   External dependencies (load BEFORE this file):
     - KaTeX CSS:  https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css
     - KaTeX JS:   https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js
     - KaTeX auto: https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js
     - SMILES:     https://unpkg.com/smiles-drawer@2.0.1/dist/smiles-drawer.min.js
   ============================================================== */
window.AIMCQ_CONFIG = window.AIMCQ_CONFIG || {};

/* ==================================================================
   MULTI-QUIZ COORDINATION (single page, multiple containers)
   ==================================================================
   When a page has several quiz containers (e.g. quiz-1, quiz-2, quiz-3)
   and the user starts or resumes one of them, the other containers are
   hidden until that quiz finishes. This prevents the user from seeing
   other "Start Quiz" panels competing for attention while they're mid-exam,
   and also physically prevents them from opening a second quiz in parallel
   (which would corrupt each quiz's scroll / keyboard state).

   - `_aimcqHideOtherContainers(activeId)` hides every element whose id
     starts with "aimcq-app-container-" except the one passed in.
   - `_aimcqShowAllContainers()` restores all of them (called on finish).
   - `window.__aimcqActiveQuizId` tracks which quiz is currently "owning"
     the page so a late-loading quiz can check whether it should start
     hidden.

   Containers are matched by id prefix so the convention
   `aimcq-app-container-unique-quiz-1`, `…-quiz-2`, etc. works out of
   the box. Elements that were hidden by another mechanism are not touched.
   ================================================================== */

function _aimcqHideOtherContainers(activeId) {
    window.__aimcqActiveQuizId = activeId;
    var all = document.querySelectorAll('[id^="aimcq-app-container-"]');
    all.forEach(function(el) {
        if (el.id === activeId) return;
        // Remember the inline display value (if any) so we can restore it later.
        if (el.dataset._aimcqPrevDisplay == null) {
            el.dataset._aimcqPrevDisplay = el.style.display || '';
        }
        el.style.display = 'none';
    });
}

function _aimcqShowAllContainers() {
    window.__aimcqActiveQuizId = null;
    var all = document.querySelectorAll('[id^="aimcq-app-container-"]');
    all.forEach(function(el) {
        var prev = el.dataset._aimcqPrevDisplay;
        el.style.display = (prev != null) ? prev : '';
        delete el.dataset._aimcqPrevDisplay;
    });
}

window.initAimcqQuiz = function(containerId, rawJSONData, customSettings) {
    customSettings = customSettings || {};

    var defaultSettings = {
        title: rawJSONData.terms ? rawJSONData.terms[rawJSONData.terms.length - 1].name : "Daily Quiz",
                                   // Custom quiz title shown on the start screen AND in the exam header.
                                   // If not provided, auto-generates from the last term in the JSON's
                                   // `terms` array (often unpredictable with merged multi-file quizzes).
                                   // e.g. "SSC CGL Tier 1 Mock Test" or "Chapter 5: Reading Comprehension"
        description: "Test your knowledge with these automatically generated questions.",
                                   // Subtitle shown under the title on the start screen only.
                                   // e.g. "SSC-style mock test: 4 sections, 100 MCQs"
        display_mode: 'single',
        feedback_mode: 'end_of_exam',
        timer: 0,
        show_explanation: true,
        shuffle_questions: false,
        shuffle_options: false,
        quiz_questions: 0,         // 0 = all questions; >0 = limit for quiz mode only
        reload_after: 0,           // 0 = disabled; 1/3/7/15 = reload page after X answered questions
        topic_order: null,         // optional array of topic names/slugs to force a custom topic sequence;
                                   // e.g. ['General Intelligence','General Knowledge','Quantitative Aptitude','English Language']
                                   // Topics not listed keep their source-order position (appended at the end).
        exam_interface: 'basic',   // 'basic'        = original lightweight engine interface
                                   // 'professional' = full SSC/CBT-style fullscreen interface
                                   //   (instruction start screen + declaration, colour-coded
                                   //   question palette, top/bottom action bars).
        marks_per_question: 1,     // marks awarded per correct answer  (professional results)
        negative_marks: 0          // marks deducted per wrong answer    (professional results)
    };

    var S = Object.assign({}, defaultSettings, customSettings);
    var OPT_LETTERS = ['A','B','C','D','E','F','G','H'];

    // Fisher-Yates shuffle utility (returns a new array)
    function shuffleArray(arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
        }
        return a;
    }

    function processContent(text) {
        if (!text) return '';
        var t = text.trim();
        if (!t.startsWith('<')) {
            t = t.split(/\n\s*\n/).map(function(p){ return '<p>' + p.replace(/\n/g,'<br>') + '</p>'; }).join('');
        }
        t = t.replace(/\[SMILES\]([\s\S]*?)\[\/SMILES\]/gi, function(m, s) {
            var clean = s.replace(/<[^>]+>/g,'').trim();
            return '<canvas data-smiles="' + clean + '"></canvas>';
        });
        return t;
    }

    function ensureOpt(o) {
        return typeof o === 'string' ? {text: o, image: ''} : {text: o.text||'', image: o.image||''};
    }

    // Build passageData map from post_type === 'passage' entries
    var passageData = {};
    (rawJSONData.posts || []).forEach(function(post) {
        if (post.post_type === 'passage') {
            var m = post.meta_input || {};
            passageData[post.id] = {
                id: post.id,
                en: {
                    title: m._aimcq_passage_display_title_en || post.post_title || '',
                    content: processContent(post.post_content)
                },
                hi: {
                    title: m._aimcq_passage_display_title_hi || m._aimcq_passage_display_title_en || post.post_title || '',
                    content: processContent(m._aimcq_passage_content_hi || post.post_content)
                }
            };
        }
    });

    // ---- Topic registry: slug -> {slug, name} ----
    // Built from `rawJSONData.terms` so we can resolve a question's taxonomy slug
    // (e.g. "general-intelligence-gi") back to a human-readable name.
    var topicRegistry = {};
    (rawJSONData.terms || []).forEach(function(t) {
        if (!t || !t.slug) return;
        // We treat all non-empty taxonomies as topic candidates; "topic" is the default
        // but different exports may use different taxonomy names.
        topicRegistry[t.slug] = { slug: t.slug, name: t.name || t.slug };
    });
    function _slugify(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
    }
    // Resolve a question's topic from (in priority order):
    //   1. post._aimcq_source_topic (explicit stamp from the multi-file loader)
    //   2. first slug in post.taxonomies.topic → topicRegistry lookup
    //   3. first slug in post.taxonomies (any taxonomy) → topicRegistry lookup
    //   4. fallback: "General"
    function resolvePostTopic(post) {
        if (post._aimcq_source_topic && post._aimcq_source_topic.slug) {
            var st = post._aimcq_source_topic;
            return { slug: st.slug, name: st.name || st.slug };
        }
        var tax = post.taxonomies || {};
        var tried = [];
        if (Array.isArray(tax.topic)) tried = tried.concat(tax.topic);
        // also merge in any other taxonomy arrays the export might use
        Object.keys(tax).forEach(function(k) {
            if (k !== 'topic' && Array.isArray(tax[k])) tried = tried.concat(tax[k]);
        });
        for (var i = 0; i < tried.length; i++) {
            var slug = tried[i];
            if (topicRegistry[slug]) return topicRegistry[slug];
        }
        // If terms[] had exactly one entry and the post has NO usable taxonomy info,
        // fall back to that single term. This keeps single-topic bundles working
        // even when posts don't carry a taxonomies field (legacy exports).
        var termList = Object.keys(topicRegistry);
        if (termList.length === 1 && tried.length === 0) {
            return topicRegistry[termList[0]];
        }
        return { slug: 'general', name: 'General' };
    }

    var questions = (rawJSONData.posts || [])
        .filter(function(post) { return post.post_type !== 'passage'; })
        .map(function(post, idx) {
        var m = post.meta_input || {};
        var topic = resolvePostTopic(post);
        return {
            id: post.id || idx,
            is_passage_question: m._aimcq_is_passage_question === 'yes',
            passage_id: parseInt(m._aimcq_passage_id) || 0,
            correct: m._aimcq_correct_answers || [],
            image_width: parseInt(m._aimcq_image_width) || 0,
            image_height: parseInt(m._aimcq_image_height) || 0,
            topic: topic,
            en: {
                content: processContent(post.post_content),
                options: (m._aimcq_options || []).map(function(o){ var e=ensureOpt(o); return {text: processContent(e.text), image: e.image}; }),
                explanation: processContent(m._aimcq_explanation)
            },
            hi: {
                content: processContent(m._aimcq_question_content_hi),
                options: (m._aimcq_options_hi || []).map(function(o){ var e=ensureOpt(o); return {text: processContent(e.text), image: e.image}; }),
                explanation: processContent(m._aimcq_explanation_hi)
            }
        };
    });

    // Generate a unique fingerprint for this quiz based on question IDs + count.
    // This ensures each post/page stores quiz state independently even when
    // multiple posts reuse the same containerId (e.g. 'aimcq-app-container-unique-quiz-1').
    var _quizFingerprint = (function() {
        var ids = questions.map(function(q){ return q.id; }).sort(function(a,b){ return a-b; });
        // Simple hash: djb2 on the joined ID string
        var str = ids.join(',');
        var hash = 5381;
        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit int
        }
        return Math.abs(hash).toString(36);
    })();

    var container = document.getElementById(containerId);
    if (!container) return;

    function formatTitle(title) {
        if (title.indexOf('(') !== -1) {
            return title.replace(/\s*\(/, '<br><span class="aq-title-sub">(') + '</span>';
        }
        return title;
    }

    // Build start screen
    var quizCount = (S.quiz_questions > 0 && S.quiz_questions < questions.length) ? S.quiz_questions : questions.length;
    var quizBtnLabel = ' Start Quiz Mode' + (quizCount < questions.length ? ' (' + quizCount + '/' + questions.length + ' Qs)' : ' (' + questions.length + ' Qs)');
    var revBtnLabel = ' Revision Mode (' + questions.length + ' Qs)';
    container.innerHTML = '<div id="aimcq-root-scope"><div class="aq-wrapper" id="aq-wrap-' + containerId + '">'
        + '<div class="aq-start" id="aq-start-' + containerId + '">'
        + '<h2>' + formatTitle(S.title) + '</h2>'
        + '<p class="aq-desc">' + S.description + '</p>'
        + '<div class="aq-mode-btns">'
        + '<button type="button" class="aq-start-btn aq-btn-quiz" data-mode="exam">'
        + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
        + quizBtnLabel + '</button>'
        + '<button type="button" class="aq-start-btn aq-btn-revision" data-mode="revision">'
        + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-9 5 18 2-9h5"/></svg>'
        + revBtnLabel + '</button>'
        + '</div></div>'
        + '<div id="aq-ph-' + containerId + '"></div>'
        + '</div></div>';

    var menuSVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
    var closeSVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    function getExamHTML(activeQs, pdataArg) {
        var qs = activeQs || questions;
        var pdata = pdataArg || passageData;
        var isSingle = S.display_mode === 'single';
        var hasNav = isSingle ? ' has-nav' : '';

        // ---- Build topic ordering + per-topic question index lists from the active set ----
        // We use the order in which topics first appear in the (already prepared) question list,
        // so this matches what the user will actually see.
        var topicOrderLocal = [];           // e.g. ['general-intelligence-gi','general-knowledge-gk']
        var topicBySlug = {};               // slug -> {slug, name, indices:[...]}
        qs.forEach(function(q, i) {
            var t = q.topic || { slug: 'general', name: 'General' };
            if (!topicBySlug[t.slug]) {
                topicBySlug[t.slug] = { slug: t.slug, name: t.name || t.slug, indices: [] };
                topicOrderLocal.push(t.slug);
            }
            topicBySlug[t.slug].indices.push(i);
        });
        var hasMultipleTopics = topicOrderLocal.length > 1;

        // ---- Topic tabs (shown only when there are >= 2 topics) ----
        // Rendered inside the nav panel, below the heading. Clicking a tab
        // filters the nav grid to show ONLY that topic's question buttons.
        // The first topic is active by default — there is no "All" view; the
        // sidebar always shows exactly one topic's questions at a time.
        var topicTabsHTML = '';
        if (hasMultipleTopics) {
            var tabs = '';
            topicOrderLocal.forEach(function(slug, ti) {
                var t = topicBySlug[slug];
                tabs += '<button type="button" class="aq-topic-tab' + (ti === 0 ? ' active' : '') + '" data-topic-slug="' + slug + '">'
                    + escapeAttr(t.name)
                    + ' <span class="aq-topic-count">' + t.indices.length + '</span>'
                    + '</button>';
            });
            topicTabsHTML = '<div class="aq-topic-tabs" role="tablist" aria-label="Filter by topic">' + tabs + '</div>';
        }

        // ---- Nav panel: heading + topic tabs + grouped question buttons ----
        // With the "All" view removed, only the FIRST topic's group is visible
        // initially; the rest start with `aq-hidden`. Switching tabs flips
        // which group is visible — `filterByTopic()` does the toggling.
        var navPanelHTML = '';
        if (isSingle) {
            var navGroupsHTML = '';
            if (hasMultipleTopics) {
                topicOrderLocal.forEach(function(slug, ti) {
                    var t = topicBySlug[slug];
                    var btns = t.indices.map(function(qi) {
                        return '<button type="button" class="aq-q-btn" data-qi="' + qi + '" data-topic-slug="' + slug + '">' + (qi+1) + '</button>';
                    }).join('');
                    navGroupsHTML +=
                        '<div class="aq-nav-topic-group' + (ti === 0 ? '' : ' aq-hidden') + '" data-topic-slug="' + slug + '">'
                        + '<div class="aq-nav-topic-label">' + escapeAttr(t.name) + ' <span style="opacity:.7;font-weight:500;">(' + t.indices.length + ')</span></div>'
                        + '<div class="aq-nav-grid">' + btns + '</div>'
                        + '</div>';
                });
            } else {
                // Single-topic quiz: flat grid, no group labels (keeps legacy look).
                var btns = qs.map(function(_, i) {
                    return '<button type="button" class="aq-q-btn" data-qi="' + i + '">' + (i+1) + '</button>';
                }).join('');
                navGroupsHTML = '<div class="aq-nav-grid">' + btns + '</div>';
            }
            navPanelHTML = '<div class="aq-nav-panel"><h4>Question Navigation</h4>' + topicTabsHTML + navGroupsHTML + '</div>';
        }

        // ---- Build separate passage boxes (one per unique passage, hidden by default) ----
        // These live OUTSIDE the question elements, above the form.
        // On jumpTo, all are hidden then the relevant one is shown — exactly like the plugin shortcode.
        var passageBoxesHTML = '';
        var _seenPassageIds = {};
        qs.forEach(function(q) {
            if (q.is_passage_question && q.passage_id && pdata[q.passage_id] && !_seenPassageIds[q.passage_id]) {
                _seenPassageIds[q.passage_id] = true;
                var pd = pdata[q.passage_id];
                var pdTitle = (pd.en && pd.en.title) ? pd.en.title : '';
                // Both EN and HI content pre-rendered; CSS display toggled by question lang switch
                var hasHiContent = pd.hi && pd.hi.content && pd.hi.content.trim() !== '' && pd.hi.content !== pd.en.content;
                passageBoxesHTML +=
                    '<div class="aq-passage-display" id="aq-passage-display-' + q.passage_id + '" data-passage-id="' + q.passage_id + '" style="display:none;" aria-label="Reading passage">'
                    + (pdTitle
                        ? '<h3 class="aq-passage-title-en">' + pdTitle + '</h3>'
                          + (hasHiContent ? '<h3 class="aq-passage-title-hi" style="display:none;">' + (pd.hi.title || pdTitle) + '</h3>' : '')
                        : '')
                    + '<div class="aq-passage-content-en">' + pd.en.content + '</div>'
                    + (hasHiContent ? '<div class="aq-passage-content-hi" style="display:none;">' + pd.hi.content + '</div>' : '')
                    + '</div>';
            }
        });

        // ---- Build question elements with inline section headings ----
        // A section heading is injected BEFORE the first question of each topic group
        // (when there are multiple topics). In single-question display mode, these
        // headings are nested inside each question's element so they show/hide together.
        var lastTopicSlug = null;
        var qsHTML = qs.map(function(q, idx) {
            var isMulti = q.correct.length > 1;
            var hasHindi = q.hi.content && q.hi.content.trim() !== '';
            var imgStyle = 'width:' + (q.image_width > 0 ? q.image_width + 'px' : 'auto') + ';height:' + (q.image_height > 0 ? q.image_height + 'px;object-fit:cover;' : 'auto') + ';';
            var optsHTML = q.en.options.map(function(opt, oi) {
                return '<li><label>'
                    + '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="q_' + q.id + '[]" value="' + oi + '">'
                    + '<div class="aq-opt-wrap">'
                    + '<span class="aq-opt-lbl">' + (OPT_LETTERS[oi] || (oi+1)) + '</span>'
                    + '<div class="aq-opt-text">'
                    + (opt.image ? '<img src="' + opt.image + '" class="aq-opt-img" style="' + imgStyle + '" alt="">' : '')
                    + '<div class="aq-opt-text">' + opt.text + '</div>'
                    + '</div></div></label></li>';
            }).join('');

            var footerHTML = '';
            if (S.feedback_mode === 'end_of_exam') {
                footerHTML = '<div class="aq-q-footer">'
                    + (isSingle ? '<div class="aq-review-wrap"><label><input type="checkbox" class="aq-mark-review"> Mark for Review</label></div>' : '')
                    + '<button type="button" class="aq-clear-btn">Clear Selection</button>'
                    + '</div>';
            }

            var passageIndicatorHTML = q.is_passage_question
                ? '<span class="aq-passage-indicator" title="This question is based on the passage shown above.">'
                  + '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>'
                  + ' Passage Q</span>'
                : '';

            // Section heading: emitted when this question's topic differs from the previous one.
            // Only shown if the quiz actually has >= 2 topics (no point otherwise).
            var sectionHeadingHTML = '';
            var curSlug = q.topic ? q.topic.slug : 'general';
            if (hasMultipleTopics && curSlug !== lastTopicSlug) {
                var curName = (q.topic && q.topic.name) || 'General';
                var t = topicBySlug[curSlug];
                var posInTopic = t ? (t.indices.indexOf(idx) + 1) : 1;
                var totalInTopic = t ? t.indices.length : 1;
                sectionHeadingHTML =
                    '<div class="aq-section-heading" data-topic-slug="' + curSlug + '">'
                    + '<span class="aq-section-icon" aria-hidden="true">' + (topicOrderLocal.indexOf(curSlug) + 1) + '</span>'
                    + '<div class="aq-section-title">' + escapeAttr(curName) + '</div>'
                    + '<div class="aq-section-meta">Section ' + (topicOrderLocal.indexOf(curSlug) + 1) + ' / ' + topicOrderLocal.length + ' · ' + totalInTopic + ' Qs</div>'
                    + '</div>';
                lastTopicSlug = curSlug;
            }

            // In single-question mode, nest the section heading inside the question element
            // so showing/hiding the question also shows/hides the heading.
            var questionEl = '<div class="aq-question hidden" id="aqq-' + q.id + '" data-qid="' + q.id + '" data-qi="' + idx + '" data-passage-id="' + (q.passage_id || '') + '" data-topic-slug="' + curSlug + '">'
                + sectionHeadingHTML
                + '<div class="aq-q-header">'
                + '<span class="aq-q-num">' + (idx+1) + '.</span>'
                + passageIndicatorHTML
                + (hasHindi ? '<div class="aq-lang-sw"><button type="button" class="aq-lang-btn active" data-lang="en">EN</button><button type="button" class="aq-lang-btn" data-lang="hi">HI</button></div>' : '')
                + '</div>'
                + '<div class="aq-q-body">' + q.en.content + '</div>'
                + '<div class="aq-options"><ul>' + optsHTML + '</ul></div>'
                + footerHTML
                + '<div class="aq-explanation" style="display:none;"></div>'
                + '</div>';

            return questionEl;
        }).join('');

        var toggleBtn = isSingle
            ? '' /* toggle button is now portal-injected into document.body — see ExamRunner.init() */
            : '';

        var timerHTML = S.timer > 0 ? '<div class="aq-timer" id="aq-timer-' + containerId + '">--:--</div>' : '';
        var progressHTML = isSingle ? '<div class="aq-progress"><div class="aq-progress-inner"></div></div>' : '';

        return '<div class="aq-exam' + hasNav + '">'
            + '<div class="aq-layout' + (isSingle ? ' has-nav' : '') + '">'
            + navPanelHTML
            + '<div class="aq-main">'
            + '<div class="aq-header"><div class="aq-header-title"><h2>' + formatTitle(S.title) + '</h2>' + (hasMultipleTopics ? '<span class="aq-current-topic" style="display:none;"></span>' : '') + '</div>' + timerHTML + '</div>'
            + progressHTML
            + passageBoxesHTML
            + '<form class="aq-form">'
            + qsHTML
            + '<div class="aq-nav-row"></div>'
            + '</form>'
            + '<div class="aq-results"></div>'
            + '</div></div>'
            + toggleBtn
            + '</div>'
            + '<div class="aq-modal-overlay" id="aq-modal-' + containerId + '">'
            + '<div class="aq-modal"><h3></h3><p></p><div class="aq-modal-btns"></div></div>'
            + '</div>';
    }

    // Small HTML-attribute escape used for topic names coming from JSON.
    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---- ExamRunner ----
    function ExamRunner(cid, settings, qs, pdata, fingerprint) {
        this.cid = cid;
        this._fp = fingerprint || '';
        this.S = settings;
        this.S._passageData = pdata || {};
        this.qs = qs;
        this.total = qs.length;
        this.cur = 0;
        this.timerInt = null;
        this.score = 0;
        this.states = qs.map(function(){ return {answered: false, review: false}; });
        this.selections = {};
        this.langs = qs.map(function(){ return 'en'; });
        // Per-topic cursor: remembers the last question index the user visited
        // in each topic, so clicking back to a previously-viewed tab restores
        // them to where they left off (instead of always jumping to question 1).
        // Map shape: { 'general-intelligence': 5, 'general-knowledge': 28, ... }
        this._topicCursors = {};

        var wrap = document.getElementById('aq-wrap-' + cid);
        this.wrap = wrap;
        this.exam = wrap.querySelector('.aq-exam');
        this.form = wrap.querySelector('.aq-form');
        this.navRow = wrap.querySelector('.aq-nav-row');
        this.resultsEl = wrap.querySelector('.aq-results');
        this.qElems = wrap.querySelectorAll('.aq-question');
        this.prog = wrap.querySelector('.aq-progress-inner');
        this.navPanel = wrap.querySelector('.aq-nav-panel');
        this.navBtns = this.navPanel ? this.navPanel.querySelectorAll('.aq-q-btn') : [];
        this.modalEl = document.getElementById('aq-modal-' + cid);

        /* --- Portal strategy:
           - Toggle button → document.body (position:fixed, truly viewport-pinned)
           - Overlay        → inside .aq-exam (position:absolute, scoped to post only)
           This way the drawer + dim effect are contained within the quiz/post box,
           while the toggle FAB always stays visible at the bottom of the screen. */
        var isSingle = settings.display_mode === 'single';
        if (isSingle) {
            // Remove any pre-existing portal elements for this quiz (e.g. on re-init)
            var oldToggle = document.getElementById('aq-portal-toggle-' + cid);
            var oldOverlay = document.getElementById('aq-portal-overlay-' + cid);
            if (oldToggle) oldToggle.parentNode.removeChild(oldToggle);
            if (oldOverlay) oldOverlay.parentNode.removeChild(oldOverlay);

            // Create overlay — absolute child of .aq-exam so it's clipped to the post
            var overlayEl = document.createElement('div');
            overlayEl.id = 'aq-portal-overlay-' + cid;
            overlayEl.className = 'aq-nav-overlay-scoped';
            this.exam.appendChild(overlayEl);

            // Create toggle button — appended to body so position:fixed works viewport-wide
            var toggleEl = document.createElement('button');
            toggleEl.id = 'aq-portal-toggle-' + cid;
            toggleEl.type = 'button';
            toggleEl.className = 'aq-nav-toggle-portal';
            toggleEl.setAttribute('aria-label', 'Toggle question navigation');
            toggleEl.innerHTML = '<span class="aq-toggle-icon-portal">' + menuSVG + '</span>';
            document.body.appendChild(toggleEl);

            this.navToggle = toggleEl;
            this.navOverlay = overlayEl;
        } else {
            this.navToggle = null;
            this.navOverlay = null;
        }
    }

    ExamRunner.prototype.init = function() {
        var self = this;
        if (this.navToggle) this.navToggle.addEventListener('click', function(){ self.toggleNav(); });
        if (this.navOverlay) this.navOverlay.addEventListener('click', function(){ self.toggleNav(false); });
    };

    ExamRunner.prototype.toggleNav = function(force) {
        var open = force === undefined ? !this.navPanel.classList.contains('drawer-open') : force;
        if (this.navPanel) this.navPanel.classList.toggle('drawer-open', open);
        if (this.navOverlay) this.navOverlay.classList.toggle('active', open);
        if (this.navToggle) {
            var icon = this.navToggle.querySelector('.aq-toggle-icon-portal');
            if (icon) icon.innerHTML = open ? closeSVG : menuSVG;
        }
    };

    // ---- Protect literal "$" signs from KaTeX's auto-render -----------------
    // KaTeX uses `$...$` as inline-math delimiters. Quiz questions often use
    // `$` as a literal operator symbol (e.g. "If 7 $ 3 = 58, what is 5 $ 1?")
    // which KaTeX would greedily pair into bogus math expressions. We solve
    // this in three steps around each renderMath() call:
    //
    //   1. Before render: walk text nodes inside `el` and replace each
    //      "literal $" with a placeholder character. Two patterns count as
    //      literal:
    //        a) An explicit escape `\$` written by the content author
    //           (e.g. for currency: "\$5 per item").
    //        b) An arithmetic-operator usage with REQUIRED whitespace on
    //           BOTH sides: e.g. "7 $ 3", "x $ 2", "(a) $ (b)". Real LaTeX
    //           delimiters never have whitespace adjacent to them — the
    //           opening "$" sits flush against the math expression — so this
    //           pattern reliably distinguishes "operator $" from "math $".
    //   2. Run KaTeX auto-render. The placeholders aren't `$`, so KaTeX
    //      ignores them and only matches genuine math delimiters.
    //   3. After render: walk text nodes again and convert placeholders
    //      back to literal `$`.
    //
    // The placeholder is the U+0001 control character — never legal in HTML
    // text content, so it can't collide with anything the user wrote.
    var DOLLAR_PLACEHOLDER = '\u0001';

    // Pattern matches a "literal arithmetic dollar":
    //   - operand char (digit / letter / right paren or bracket)
    //   - REQUIRED whitespace (1–3 chars)
    //   - $
    //   - REQUIRED whitespace (1–3 chars)
    //   - operand char or = (digit / letter / left paren or bracket / equals)
    // Examples that match: "7 $ 3", "x $ 2", "(a) $ b", "5 $ ="
    // Examples that DON'T match (intentionally left for KaTeX):
    //   "$x = 5$"       (no whitespace around opening $ — this is LaTeX)
    //   "$5"            (currency, single $ — KaTeX won't pair without a closer)
    //   "ab$cd"         (no whitespace — could be variable name in LaTeX)
    // The required spaces are the key signal: real arithmetic operators are
    // visually separated from operands; LaTeX delimiters never are.
    var LITERAL_DOLLAR_OPERATOR = /([0-9A-Za-z\)\]])(\s{1,3})\$(\s{1,3})(?=[0-9A-Za-z\(\[=])/g;

    function _walkTextNodes(root, fn) {
        if (!root || !root.childNodes) return;
        // Skip nodes already rendered by KaTeX (they have .katex class on parent).
        // Walk children first so we don't recurse into KaTeX-rendered subtrees.
        var walker = (root.ownerDocument || document).createTreeWalker(
            root, NodeFilter.SHOW_TEXT, {
                acceptNode: function(n) {
                    var p = n.parentNode;
                    while (p && p !== root) {
                        if (p.classList && (p.classList.contains('katex')
                            || p.classList.contains('katex-display')
                            || p.classList.contains('katex-html')
                            || p.classList.contains('katex-mathml'))) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        // Don't muck with form inputs or scripts/styles.
                        var tag = p.tagName;
                        if (tag === 'SCRIPT' || tag === 'STYLE'
                            || tag === 'TEXTAREA' || tag === 'INPUT') {
                            return NodeFilter.FILTER_REJECT;
                        }
                        p = p.parentNode;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }, false
        );
        var nodes = [];
        var node;
        while ((node = walker.nextNode())) nodes.push(node);
        nodes.forEach(fn);
    }

    function _protectLiteralDollars(el) {
        if (!el) return;
        _walkTextNodes(el, function(textNode) {
            var t = textNode.nodeValue;
            if (t.indexOf('$') === -1) return;
            // Step 1: handle explicit `\$` escape — author-written literal.
            if (t.indexOf('\\$') !== -1) {
                t = t.replace(/\\\$/g, DOLLAR_PLACEHOLDER);
            }
            // Step 2: heuristic — arithmetic-operator dollar.
            t = t.replace(LITERAL_DOLLAR_OPERATOR, function(_match, left, sp1, sp2) {
                return left + sp1 + DOLLAR_PLACEHOLDER + sp2;
            });
            if (t !== textNode.nodeValue) textNode.nodeValue = t;
        });
    }

    function _restoreLiteralDollars(el) {
        if (!el) return;
        _walkTextNodes(el, function(textNode) {
            if (textNode.nodeValue.indexOf(DOLLAR_PLACEHOLDER) === -1) return;
            textNode.nodeValue = textNode.nodeValue.split(DOLLAR_PLACEHOLDER).join('$');
        });
    }
    // -------------------------------------------------------------------------

    ExamRunner.prototype.renderMath = function(el) {
        if (window.renderMathInElement) {
            _protectLiteralDollars(el);
            renderMathInElement(el, {
                delimiters: [
                    {left:'$$',right:'$$',display:true},
                    {left:'$',right:'$',display:false},
                    {left:'\\(',right:'\\)',display:false},
                    {left:'\\[',right:'\\]',display:true}
                ]
            });
            _restoreLiteralDollars(el);
        }
    };

    ExamRunner.prototype.renderChem = function(el) {
        if (typeof SmilesDrawer === 'undefined') return;
        var canvases = el.querySelectorAll('canvas[data-smiles]:not([data-drawn])');
        canvases.forEach(function(c) {
            var sm = c.getAttribute('data-smiles');
            var w = parseInt(c.getAttribute('width') || 300);
            var h = parseInt(c.getAttribute('height') || 200);
            if (!c.hasAttribute('width')) c.width = w;
            if (!c.hasAttribute('height')) c.height = h;
            var dr = new SmilesDrawer.Drawer({width:w,height:h});
            SmilesDrawer.parse(sm, function(tree){
                dr.draw(tree, c, 'light', false);
                c.setAttribute('data-drawn','true');
            }, function(err){ console.log('SmilesDrawer:',err); });
        });
    };

    ExamRunner.prototype.start = function() {
        var self = this;
        // Hide any other quiz containers on the page so the user isn't
        // distracted by competing "Start Quiz" panels mid-exam. Siblings
        // reappear when this quiz finishes (see finishExam).
        _aimcqHideOtherContainers(this.cid);
        this.exam.style.display = 'block';
        if (this.S.shuffle_options && !this._restored) this.shuffleOptions();
        if (this.S.timer > 0) this.startTimer();
        this.setupEvents();
        // Initialize the topic filter on quiz start. We always start with EXACTLY
        // ONE topic visible in the navigation (there is no "All" view). The chosen
        // topic is the one belonging to the current question — usually the first
        // topic on a fresh start, but when restoring a saved session it matches
        // wherever the user left off so the sidebar opens on the right group.
        // No-op when the quiz has only one topic (topicTabBar doesn't exist).
        if (this.topicTabBar) {
            var startIdx = this._restored ? this.cur : 0;
            var startTopic = (this.qs[startIdx] && this.qs[startIdx].topic) ? this.qs[startIdx].topic.slug : null;
            if (startTopic) this.filterByTopic(startTopic, true /* skipJump */);
        }
        this.renderControls();
        this.updateProg();
        this.updateNav();
        this._saveOptionOrder();
        setTimeout(function(){
            self.renderMath(self.exam);
            self.renderChem(self.exam);
        }, 100);
        if (this.S.display_mode === 'all') {
            this.qElems.forEach(function(q){ q.classList.remove('hidden'); });
            // In all-mode, show all passage boxes
            this.wrap.querySelectorAll('.aq-passage-display').forEach(function(pd) {
                pd.style.display = 'block';
            });
        } else {
            this.jumpTo(this._restored ? this.cur : 0);
        }
        this.saveState();
    };

    /* ---- Session Persistence ----
       Storage key includes both containerId and a content fingerprint so that
       different posts/pages with different quizzes never collide, even when
       they share the same container ID. */
    ExamRunner.prototype._sk = function() { return 'aimcq_state_' + this.cid + '_' + this._fp; };

    ExamRunner.prototype._saveOptionOrder = function() {
        var order = [];
        this.qElems.forEach(function(qEl) {
            var inputs = qEl.querySelectorAll('.aq-options input');
            var vals = [];
            inputs.forEach(function(inp) { vals.push(inp.value); });
            order.push(vals);
        });
        this._optOrder = order;
    };

    ExamRunner.prototype.saveState = function() {
        // Once the exam is finished the results are rendered and the session
        // state has been cleared by finishExam(). Any saveState() call after
        // that point would incorrectly resurrect the state (a pending timer
        // tick, an MCQ onchange that somehow fires, etc.), causing the next
        // page load to auto-restore onto the last question instead of the
        // start screen. Refuse to write anything once _finished is true.
        if (this._finished) return;
        if (this._restoring) return;
        try {
            var checkedFlags = [];
            this.qElems.forEach(function(qEl) {
                checkedFlags.push(qEl.dataset.checked === 'true');
            });
            var obj = {
                cur: this.cur,
                score: this.score,
                states: this.states,
                selections: this.selections,
                langs: this.langs,
                timerRem: this._timerRem || 0,
                mode: this.S.feedback_mode === 'instant' && this.S.timer === 0 ? 'revision' : 'exam',
                feedbackMode: this.S.feedback_mode,
                displayMode: this.S.display_mode,
                timer: this.S.timer,
                optOrder: this._optOrder || [],
                checkedFlags: checkedFlags,
                questionIds: this.qs.map(function(q){ return q.id; }),
                answeredSinceReload: this._answeredSinceReload || 0,
                topicCursors: this._topicCursors || {},
                fingerprint: this._fp,
                ts: Date.now()
            };
            sessionStorage.setItem(this._sk(), JSON.stringify(obj));
        } catch(e) { /* storage unavailable */ }
    };

    ExamRunner.prototype.clearState = function() {
        try { sessionStorage.removeItem(this._sk()); } catch(e) {}
    };

    ExamRunner.loadSaved = function(cid, fp) {
        try {
            var raw = sessionStorage.getItem('aimcq_state_' + cid + '_' + fp);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch(e) { return null; }
    };

    ExamRunner.prototype.restoreState = function(saved) {
        var self = this;
        this._restored = true;
        this._restoring = true;
        this.cur = saved.cur || 0;
        this.score = saved.score || 0;
        this.states = saved.states || this.states;
        this.selections = saved.selections || {};
        var savedLangs = saved.langs || this.langs;
        this._timerRem = saved.timerRem || 0;
        this._answeredSinceReload = saved.answeredSinceReload || 0;
        // Restore per-topic cursors so tab switches still snap back to where
        // the user left off in each topic, even after a page reload.
        this._topicCursors = saved.topicCursors || {};

        // Restore shuffled option order
        if (saved.optOrder && saved.optOrder.length) {
            this.qElems.forEach(function(qEl, qi) {
                var order = saved.optOrder[qi];
                if (!order || !order.length) return;
                var ul = qEl.querySelector('.aq-options ul');
                if (!ul) return;
                var items = Array.from(ul.children);
                var byVal = {};
                items.forEach(function(li) {
                    var inp = li.querySelector('input');
                    if (inp) byVal[inp.value] = li;
                });
                order.forEach(function(val, idx) {
                    if (byVal[val]) {
                        ul.appendChild(byVal[val]);
                        var lbl = byVal[val].querySelector('.aq-opt-lbl');
                        if (lbl) lbl.textContent = OPT_LETTERS[idx] || (idx + 1);
                    }
                });
            });
        }

        // Restore selections into DOM
        this.qElems.forEach(function(qEl, qi) {
            var sel = self.selections[qi] || [];
            if (!sel.length) return;
            qEl.querySelectorAll('.aq-options input').forEach(function(inp) {
                if (sel.indexOf(inp.value) !== -1) {
                    inp.checked = true;
                    inp.parentElement.classList.add('selected');
                }
            });
            // Restore review marks
            if (self.states[qi] && self.states[qi].review) {
                var cb = qEl.querySelector('.aq-mark-review');
                if (cb) cb.checked = true;
            }
        });

        // Restore language switches, then re-apply shuffle order and selections
        var needsLangRestore = false;
        this.qElems.forEach(function(qEl, qi) {
            var lang = savedLangs[qi];
            if (lang && lang !== 'en') {
                needsLangRestore = true;
                // switchLang rebuilds DOM with sequential values, so we need to
                // re-apply shuffle order and selections after
                self.switchLang(qi, lang);
                // Re-apply shuffled option order after lang rebuild
                if (saved.optOrder && saved.optOrder[qi]) {
                    var order = saved.optOrder[qi];
                    var ul = qEl.querySelector('.aq-options ul');
                    if (ul) {
                        var items = Array.from(ul.children);
                        var byVal = {};
                        items.forEach(function(li) {
                            var inp = li.querySelector('input');
                            if (inp) byVal[inp.value] = li;
                        });
                        order.forEach(function(val, idx) {
                            if (byVal[val]) {
                                ul.appendChild(byVal[val]);
                                var lbl = byVal[val].querySelector('.aq-opt-lbl');
                                if (lbl) lbl.textContent = OPT_LETTERS[idx] || (idx + 1);
                            }
                        });
                    }
                }
                // Re-apply selections for this question after lang rebuild
                var sel = self.selections[qi] || [];
                qEl.querySelectorAll('.aq-options label').forEach(function(l){ l.classList.remove('selected'); });
                qEl.querySelectorAll('.aq-options input').forEach(function(inp) {
                    if (sel.indexOf(inp.value) !== -1) {
                        inp.checked = true;
                        inp.parentElement.classList.add('selected');
                    }
                });
            }
        });

        // Restore instant-mode checked flags (disable answered questions, show explanations)
        if (saved.checkedFlags && saved.checkedFlags.length) {
            saved.checkedFlags.forEach(function(isChecked, qi) {
                if (!isChecked) return;
                var qEl = self.qElems[qi];
                var qd = self.qs[qi];
                qEl.dataset.checked = 'true';
                self.evalQ(qEl, qd, true);
                if (self.S.show_explanation) {
                    var lang = self.langs[qi];
                    var exp = qd[lang].explanation;
                    var expDiv = qEl.querySelector('.aq-explanation');
                    if (exp && expDiv) {
                        expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                        expDiv.style.display = 'block';
                    }
                }
            });
        }
        this._restoring = false;
    };

    // Auto-reload after X answered questions (reload_after setting)
    // Counts answered questions; when threshold hit, flags a pending reload.
    // The actual reload fires on the next forward navigation (Next button).
    ExamRunner.prototype._trackAnswer = function() {
        var limit = this.S.reload_after;
        if (!limit || limit <= 0) return;
        this._answeredSinceReload = (this._answeredSinceReload || 0) + 1;
        if (this._answeredSinceReload >= limit) {
            this._reloadPending = true;
        }
    };

    ExamRunner.prototype._doReloadIfPending = function() {
        if (!this._reloadPending) return false;
        this._reloadPending = false;
        this._answeredSinceReload = 0;
        this.saveState();
        // Reload the top-level page (works when embedded in Blogger or any parent page)
        try {
            if (window.top && window.top.location) {
                window.top.location.reload();
            } else {
                window.location.reload();
            }
        } catch(e) {
            // Cross-origin restriction — fall back to current window
            window.location.reload();
        }
        return true;
    };

    ExamRunner.prototype.shuffleOptions = function() {
        this.qElems.forEach(function(qEl) {
            var ul = qEl.querySelector('.aq-options ul');
            if (!ul) return;
            var items = Array.from(ul.children);
            for (var i = items.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i+1));
                var tmp = items[i]; items[i] = items[j]; items[j] = tmp;
            }
            items.forEach(function(item, idx) {
                var lbl = item.querySelector('.aq-opt-lbl');
                if (lbl) lbl.textContent = OPT_LETTERS[idx] || (idx+1);
                ul.appendChild(item);
            });
        });
    };

    ExamRunner.prototype.setupEvents = function() {
        var self = this;

        this.form.addEventListener('submit', function(e) {
            e.preventDefault();
            self.showModal('Confirm Submission', 'Are you sure you want to finish and submit?', [
                {text:'Confirm', cls:'aq-modal-confirm', fn: function(){ self.finishExam(); }},
                {text:'Cancel', cls:'aq-modal-cancel', fn: function(){ self.hideModal(); }}
            ]);
        });

        this.form.addEventListener('change', function(e) {
            var qEl = e.target.closest('.aq-question');
            if (!qEl) return;
            var qi = parseInt(qEl.dataset.qi, 10);
            if (e.target.name && e.target.name.startsWith('q_')) {
                var inputs = qEl.querySelectorAll('input[name="' + e.target.name + '"]');
                qEl.querySelectorAll('.aq-options label').forEach(function(l){ l.classList.remove('selected'); });
                inputs.forEach(function(i){ if (i.checked) i.parentElement.classList.add('selected'); });
                var checked = qEl.querySelectorAll('input[name="' + e.target.name + '"]:checked');
                var wasAnswered = self.states[qi].answered;
                self.states[qi].answered = checked.length > 0;
                self.selections[qi] = Array.from(checked).map(function(i){ return i.value; });
                self.updateNav();
                self.updateProg();
                self.saveState();
                // Track answered count for reload_after
                if (!wasAnswered && self.states[qi].answered) {
                    self._trackAnswer();
                }
            }
            if (e.target.classList.contains('aq-mark-review')) {
                self.states[qi].review = e.target.checked;
                self.updateNav();
                self.saveState();
            }
        });

        this.form.addEventListener('click', function(e) {
            if (e.target.classList.contains('aq-clear-btn')) {
                var qEl = e.target.closest('.aq-question');
                if (qEl) self.clearQ(parseInt(qEl.dataset.qi, 10));
            }
            if (e.target.classList.contains('aq-lang-btn')) {
                var qEl = e.target.closest('.aq-question');
                self.switchLang(parseInt(qEl.dataset.qi, 10), e.target.dataset.lang);
            }
        });

        if (this.navPanel) {
            this.navPanel.addEventListener('click', function(e) {
                if (e.target.classList.contains('aq-q-btn')) {
                    self.jumpTo(parseInt(e.target.dataset.qi, 10));
                }
            });
        }

        // Topic tab bar (only exists when multiple topics are present).
        // Now rendered inside the nav-panel sidebar, not the main area.
        this.topicTabBar = this.wrap.querySelector('.aq-topic-tabs');
        if (this.topicTabBar) {
            this.topicTabBar.addEventListener('click', function(e) {
                var btn = e.target.closest('.aq-topic-tab');
                if (!btn) return;
                self.filterByTopic(btn.dataset.topicSlug);
            });
        }

        // Current-topic badge shown in the quiz header. Only exists when the
        // quiz has multiple topics. Updated from jumpTo on every navigation.
        this.topicBadge = this.wrap.querySelector('.aq-current-topic');
    };

    // Filter the navigation sidebar to a single topic.
    // - Sidebar shows ONLY that topic's question buttons (other topic groups hidden)
    // - The corresponding tab pill becomes active
    // - Jumps to the first question of that topic (unless skipJump is true)
    //
    // Switching tabs is purely a VIEW filter on the navigation sidebar — it does
    // not touch this.states / this.selections / .aq-question DOM, so answered &
    // marked-for-review states for questions in any topic persist across tab
    // switches. (You can answer 5 GI questions, switch to GK, come back, and
    // those 5 GI buttons are still green.)
    //
    // The `skipJump` flag is used by start() to set the initial filter without
    // forcing a redundant jumpTo (since start() calls jumpTo separately).
    ExamRunner.prototype.filterByTopic = function(slug, skipJump) {
        if (!slug) return;
        this.activeTopicSlug = slug;

        // Toggle active tab styling.
        if (this.topicTabBar) {
            this.topicTabBar.querySelectorAll('.aq-topic-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.topicSlug === slug);
            });
        }

        // Hide non-matching topic groups in the nav panel — only the selected
        // topic's question buttons are visible. Their answered/review classes
        // remain intact (handled by updateNav, indexed by global qi).
        if (this.navPanel) {
            this.navPanel.querySelectorAll('.aq-nav-topic-group').forEach(function(g) {
                var match = (g.dataset.topicSlug === slug);
                g.classList.toggle('aq-hidden', !match);
                g.classList.remove('aq-dim'); // clear legacy state if any
            });
        }

        // Jump to the last-visited question of the selected topic — or the
        // first question of that topic if the user has never visited it before
        // (or if the caller passes skipJump=true and wants to handle navigation
        // separately, e.g. start() during session restore, or navigate() when
        // crossing topic boundaries backwards).
        if (skipJump) return;
        var remembered = this._topicCursors[slug];
        // Validate the remembered index still belongs to this topic (defensive
        // check in case the question list changed between sessions).
        if (typeof remembered === 'number'
                && remembered >= 0 && remembered < this.qs.length
                && this.qs[remembered].topic
                && this.qs[remembered].topic.slug === slug) {
            this.jumpTo(remembered);
            return;
        }
        // Fallback: first question of this topic.
        for (var i = 0; i < this.qs.length; i++) {
            var qt = this.qs[i].topic;
            if (qt && qt.slug === slug) { this.jumpTo(i); break; }
        }
    };

    ExamRunner.prototype.switchLang = function(qi, lang) {
        if (this.langs[qi] === lang) return;
        this.langs[qi] = lang;
        var qEl = this.qElems[qi];
        var qd = this.qs[qi];
        var ld = qd[lang];
        var isMulti = qd.correct.length > 1;
        var imgStyle = 'width:' + (qd.image_width > 0 ? qd.image_width+'px' : 'auto') + ';height:' + (qd.image_height > 0 ? qd.image_height+'px;object-fit:cover;' : 'auto') + ';';

        // Scope to .aq-q-header so passage lang btns are NOT affected here
        var qHeader = qEl.querySelector('.aq-q-header');
        if (qHeader) {
            qHeader.querySelectorAll('.aq-lang-btn').forEach(function(b){ b.classList.remove('active'); });
            var activeBtn = qHeader.querySelector('.aq-lang-btn[data-lang="' + lang + '"]');
            if (activeBtn) activeBtn.classList.add('active');
        }
        qEl.querySelector('.aq-q-body').innerHTML = ld.content;

        // Sync separate passage display box language (no switcher in box — driven by question lang btn)
        if (qd.is_passage_question && qd.passage_id) {
            var passageDisplayEl = this.wrap.querySelector('#aq-passage-display-' + qd.passage_id);
            if (passageDisplayEl) {
                var isHi = lang === 'hi';
                var titleEn = passageDisplayEl.querySelector('.aq-passage-title-en');
                var titleHi = passageDisplayEl.querySelector('.aq-passage-title-hi');
                var contentEn = passageDisplayEl.querySelector('.aq-passage-content-en');
                var contentHi = passageDisplayEl.querySelector('.aq-passage-content-hi');
                if (titleEn) titleEn.style.display = isHi ? 'none' : 'block';
                if (titleHi) titleHi.style.display = isHi ? 'block' : 'none';
                if (contentEn) contentEn.style.display = isHi ? 'none' : 'block';
                if (contentHi) contentHi.style.display = isHi ? 'block' : 'none';
                this.renderMath(passageDisplayEl);
            }
        }

        var ul = qEl.querySelector('.aq-options ul');
        var selVals = Array.from(ul.querySelectorAll('input:checked')).map(function(i){ return i.value; });
        ul.innerHTML = '';

        ld.options.forEach(function(opt, oi) {
            var li = document.createElement('li');
            var label = document.createElement('label');
            var inp = document.createElement('input');
            inp.type = isMulti ? 'checkbox' : 'radio';
            inp.name = 'q_' + qd.id + '[]';
            inp.value = oi;
            if (selVals.indexOf(String(oi)) !== -1) { inp.checked = true; label.classList.add('selected'); }
            label.appendChild(inp);
            var wrap = document.createElement('div'); wrap.className = 'aq-opt-wrap';
            var lbl = document.createElement('span'); lbl.className = 'aq-opt-lbl'; lbl.textContent = OPT_LETTERS[oi] || (oi+1);
            wrap.appendChild(lbl);
            var ct = document.createElement('div'); ct.className = 'aq-opt-text';
            var enImg = qd.en.options[oi] ? qd.en.options[oi].image : '';
            if (enImg) { var img = document.createElement('img'); img.src = enImg; img.className = 'aq-opt-img'; img.style.cssText = imgStyle; ct.appendChild(img); }
            var txt = document.createElement('div'); txt.className = 'aq-opt-text'; txt.innerHTML = opt.text;
            ct.appendChild(txt); wrap.appendChild(ct); label.appendChild(wrap); li.appendChild(label); ul.appendChild(li);
        });

        if (this.form.dataset.finished === 'true' || (this.S.feedback_mode === 'instant' && qEl.dataset.checked === 'true')) {
            this.evalQ(qEl, qd, true);
            var expDiv = qEl.querySelector('.aq-explanation');
            if (expDiv.style.display !== 'none') {
                expDiv.innerHTML = '<strong>Explanation:</strong> ' + ld.explanation;
            }
        }
        this.renderMath(qEl);
        this.renderChem(qEl);
        this.saveState();
    };

    ExamRunner.prototype.startTimer = function() {
        var self = this;
        // Compute starting remaining-time. Restored sessions provide _timerRem
        // (positive number); fresh starts use the full configured duration.
        var rem = this._timerRem > 0 ? this._timerRem : this.S.timer * 60;
        var el = document.getElementById('aq-timer-' + this.cid);
        if (!el) return;

        // CRITICAL: write _timerRem immediately, BEFORE the first setInterval tick
        // fires. Without this, any saveState() triggered in the first second
        // (e.g. from a click on the first option, or jumpTo) would persist
        // _timerRem = 0, and a page reload right after starting would restart
        // the timer from full duration, giving the user free time.
        this._timerRem = rem;

        // Render the initial timer value immediately so the user doesn't see
        // a placeholder for ~1 second after the exam starts.
        var m0 = Math.floor(rem/60), s0 = rem%60;
        el.textContent = (m0<10?'0':'')+m0+':'+(s0<10?'0':'')+s0;

        this.timerInt = setInterval(function() {
            rem--;
            self._timerRem = rem;
            var m = Math.floor(rem/60), s = rem%60;
            el.textContent = (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
            // Periodic auto-save so a reload during quiet periods (no clicks /
            // navigation) still preserves the latest remaining-time value.
            // The state is also saved after every user action via the change /
            // jumpTo / clearQ / etc. handlers, which is the primary mechanism.
            if (rem % 10 === 0) self.saveState();
            if (rem <= 0) {
                clearInterval(self.timerInt);
                self.showModal("Time's Up!", 'Time expired. The exam will now be submitted.', [
                    {text:'OK', cls:'aq-modal-confirm', fn: function(){ self.finishExam(); }}
                ]);
            }
        }, 1000);
    };

    ExamRunner.prototype.renderControls = function() {
        var self = this;
        this.navRow.innerHTML = '';
        var isLast = this.cur === this.total - 1;
        var isSingle = this.S.display_mode === 'single';

        if (!isSingle) {
            var sb = document.createElement('button');
            sb.type = 'submit'; sb.textContent = 'Submit Exam'; sb.className = 'aq-btn aq-btn-submit';
            sb.style.margin = '0 auto';
            this.navRow.appendChild(sb);
            return;
        }

        var prevBtn = document.createElement('button');
        prevBtn.type = 'button'; prevBtn.innerHTML = '&larr; Previous'; prevBtn.className = 'aq-btn aq-btn-prev';
        if (this.cur === 0) prevBtn.style.visibility = 'hidden';
        prevBtn.onclick = function(){ self.navigate(-1); };
        this.navRow.appendChild(prevBtn);

        var right = document.createElement('div'); right.className = 'aq-nav-right';
        this.navRow.appendChild(right);

        var qEl = this.qElems[this.cur];
        var isChecked = qEl.dataset.checked === 'true';

        if (this.S.feedback_mode === 'instant') {
            if (isChecked) {
                if (!isLast) {
                    var nb = document.createElement('button');
                    nb.type = 'button'; nb.innerHTML = 'Next &rarr;'; nb.className = 'aq-btn aq-btn-next';
                    nb.onclick = function(){ self.navigate(1); };
                    right.appendChild(nb);
                } else {
                    var sb2 = document.createElement('button');
                    sb2.type = 'submit'; sb2.textContent = 'Submit Exam'; sb2.className = 'aq-btn aq-btn-submit';
                    right.appendChild(sb2);
                }
            } else {
                var cb = document.createElement('button');
                cb.type = 'button'; cb.textContent = 'Check Answer'; cb.className = 'aq-btn aq-btn-check';
                cb.onclick = function(){ self.checkInstant(); };
                right.appendChild(cb);
            }
        } else {
            if (!isLast) {
                var nb2 = document.createElement('button');
                nb2.type = 'button'; nb2.innerHTML = 'Next &rarr;'; nb2.className = 'aq-btn aq-btn-next';
                nb2.onclick = function(){ self.navigate(1); };
                right.appendChild(nb2);
            } else {
                var sb3 = document.createElement('button');
                sb3.type = 'submit'; sb3.textContent = 'Submit Exam'; sb3.className = 'aq-btn aq-btn-submit';
                right.appendChild(sb3);
            }
        }
    };

    // Prev/Next navigation across topics.
    //
    // - Single-topic quiz (no filter set) → plain cur + delta.
    // - Multi-topic quiz → a topic filter is always active. Prev/Next skips
    //   within that topic. When the user hits the boundary (last question in
    //   the filtered topic and clicks Next, or first and clicks Prev) we cross
    //   into the next/previous topic and auto-switch the filter so the sidebar
    //   tab + nav grid update in sync. This way:
    //     * Submit never appears until the absolute last question (`cur === total-1`)
    //     * The user is never stuck at an artificial boundary
    //     * Cross-topic navigation feels seamless from the question pane
    ExamRunner.prototype.navigate = function(d) {
        var filter = this.activeTopicSlug;
        var step = d > 0 ? 1 : -1;

        // No filter (single-topic quiz) → plain linear navigation.
        if (!filter) {
            var target = this.cur + step;
            if (target < 0 || target >= this.total) return;
            this.jumpTo(target);
            return;
        }

        // Filter active — look for the next/prev question within the same topic first.
        var i = this.cur + step;
        while (i >= 0 && i < this.total) {
            var t = this.qs[i].topic;
            if (t && t.slug === filter) { this.jumpTo(i); return; }
            i += step;
        }

        // Reached the boundary of the filtered topic in this direction.
        // Cross into the adjacent topic: find the first (or last) question of
        // whichever topic comes next, then switch the active filter to it so
        // the tab + nav grid update in sync. If there is no adjacent topic in
        // this direction, do nothing (user must hit Submit or scroll the tabs).
        var crossSlug = null;
        var crossIdx = -1;
        var j = (step > 0) ? 0 : this.total - 1;
        var end = (step > 0) ? this.total : -1;
        // Re-scan from scratch in the direction of travel to find the first
        // question whose topic differs from the active filter AND appears
        // AFTER (or BEFORE) this.cur.
        for (j = this.cur + step; j !== end; j += step) {
            var tj = this.qs[j].topic;
            var sj = tj ? tj.slug : 'general';
            if (sj !== filter) { crossSlug = sj; crossIdx = j; break; }
        }
        if (crossIdx === -1) return; // no adjacent topic — stay put
        this.filterByTopic(crossSlug);
        // filterByTopic jumps to the FIRST question of crossSlug. When moving
        // backward, we actually want the LAST question of the previous topic
        // (the one adjacent to our starting point), so correct that here.
        if (step < 0) {
            // Find the last question index belonging to crossSlug.
            for (var k = this.total - 1; k >= 0; k--) {
                var tk = this.qs[k].topic;
                if (tk && tk.slug === crossSlug) { this.jumpTo(k); break; }
            }
        }
    };

    ExamRunner.prototype.jumpTo = function(idx) {
        if (idx < 0 || idx >= this.total) return;
        var movingForward = idx > this.cur;
        if (this.qElems[this.cur]) this.qElems[this.cur].classList.add('hidden');
        this.cur = idx;
        this.qElems[this.cur].classList.remove('hidden');

        // ---- Show/hide passage display boxes (plugin shortcode parity) ----
        var curPassageId = this.qElems[this.cur].dataset.passageId || '';
        this.wrap.querySelectorAll('.aq-passage-display').forEach(function(pd) {
            pd.style.display = (curPassageId && pd.dataset.passageId === curPassageId) ? 'block' : 'none';
        });

        // ---- Sync the active topic-tab (if the tab bar exists) ----
        // Reflects the topic of the current question. With the "All" view removed,
        // the active filter and current question's topic are always in sync via
        // navigate() (cross-topic boundaries auto-switch the filter), so we just
        // follow the current question. This also self-heals if external code
        // does a raw jumpTo() that crosses a topic boundary.
        var curTopic = this.qs[this.cur].topic || null;
        var curTopicSlug = curTopic ? curTopic.slug : 'general';
        if (this.topicTabBar) {
            // If the current question's topic differs from the active filter
            // (e.g. external jumpTo across a boundary), update the filter so
            // the sidebar tab + nav group also flip to the right topic.
            if (this.activeTopicSlug !== curTopicSlug) {
                this.filterByTopic(curTopicSlug, true /* skipJump */);
            }
            this.topicTabBar.querySelectorAll('.aq-topic-tab').forEach(function(t) {
                if (t.classList.contains('active')) {
                    var bar = t.parentElement;
                    var bRect = bar.getBoundingClientRect();
                    var tRect = t.getBoundingClientRect();
                    if (tRect.left < bRect.left || tRect.right > bRect.right) {
                        bar.scrollTo({ left: t.offsetLeft - 16, behavior: 'smooth' });
                    }
                }
            });
        }

        // ---- Update the current-topic badge in the header ----
        // Shows the topic name of whichever question is on screen. Hidden for
        // single-topic quizzes (the badge element isn't even rendered in that case).
        if (this.topicBadge) {
            var topicName = (curTopic && curTopic.name) ? curTopic.name : '';
            if (topicName) {
                this.topicBadge.textContent = topicName;
                this.topicBadge.style.display = '';
            } else {
                this.topicBadge.style.display = 'none';
            }
        }

        // ---- Remember the last-visited question per topic ----
        // Updated on every jumpTo so that switching tabs and coming back
        // restores the user to where they left off, not the start of the topic.
        // Ignored for the synthetic "general" fallback used when a question
        // somehow has no topic at all.
        if (curTopicSlug && curTopicSlug !== 'general') {
            this._topicCursors[curTopicSlug] = this.cur;
        }

        this.renderControls();
        this.updateProg();
        this.updateNav();
        if (this.navPanel && this.navPanel.classList.contains('drawer-open')) {
            this.toggleNav(false);
        }
        this.saveState();
        // Reload page if pending (reload_after threshold met) and moving forward
        if (movingForward && this._doReloadIfPending()) return;
        // Auto-scroll to quiz top so the question is fully visible
        var scrollTarget = this.wrap.querySelector('.aq-header') || this.wrap;
        var rect = scrollTarget.getBoundingClientRect();
        var offset = 20; // px breathing room above the header
        var top = rect.top + window.pageYOffset - offset;
        if (rect.top < 0 || rect.top > window.innerHeight * 0.4) {
            window.scrollTo({ top: top, behavior: 'smooth' });
        }
    };

    ExamRunner.prototype.checkInstant = function() {
        var qEl = this.qElems[this.cur];
        var qd = this.qs[this.cur];
        if (this.evalQ(qEl, qd, true)) this.score++;
        if (this.S.show_explanation) {
            var lang = this.langs[this.cur];
            var exp = qd[lang].explanation;
            var expDiv = qEl.querySelector('.aq-explanation');
            if (exp && expDiv) {
                expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                expDiv.style.display = 'block';
                this.renderMath(expDiv);
                this.renderChem(expDiv);
            }
        }
        qEl.dataset.checked = 'true';
        this.renderControls();
        this.updateProg();
        this.saveState();
        this._trackAnswer();
    };

    ExamRunner.prototype.clearQ = function(qi) {
        var qEl = this.qElems[qi];
        if (!qEl) return;
        qEl.querySelectorAll('input:checked').forEach(function(i){ i.checked = false; });
        qEl.querySelectorAll('.aq-options label').forEach(function(l){ l.classList.remove('selected'); });
        this.states[qi].answered = false;
        delete this.selections[qi];
        this.updateNav();
        this.updateProg();
        this.saveState();
    };

    ExamRunner.prototype.updateProg = function() {
        if (!this.prog) return;
        var self = this;
        var count = this.S.feedback_mode === 'instant'
            ? Array.from(this.qElems).filter(function(q){ return q.dataset.checked === 'true'; }).length
            : this.states.filter(function(s){ return s.answered; }).length;
        this.prog.style.width = (count / this.total * 100) + '%';
    };

    ExamRunner.prototype.updateNav = function() {
        var self = this;
        if (!this.navPanel) return;
        this.navBtns.forEach(function(btn, idx) {
            var st = self.states[idx];
            btn.className = 'aq-q-btn';
            if (st.review) btn.classList.add('q-review');
            else if (st.answered) btn.classList.add('q-answered');
            if (idx === self.cur) btn.classList.add('q-current');
        });
    };

    ExamRunner.prototype.evalQ = function(qEl, qd, disable) {
        var correct = (qd.correct || []).map(String);
        var qi = parseInt(qEl.dataset.qi, 10);
        var selected = this.selections[qi] || [];
        var isOk = selected.length > 0 && selected.length === correct.length
            && selected.every(function(v){ return correct.indexOf(v) !== -1; });

        qEl.querySelectorAll('.aq-options label').forEach(function(label) {
            var inp = label.querySelector('input');
            var val = inp.value;
            label.classList.remove('correct','incorrect','missed','selected');
            if (correct.indexOf(val) !== -1) {
                if (selected.indexOf(val) !== -1) label.classList.add('correct');
                else label.classList.add('missed');
            } else if (selected.indexOf(val) !== -1) {
                label.classList.add('incorrect');
            }
            if (disable) { inp.disabled = true; label.classList.add('disabled'); }
        });
        return isOk;
    };

    ExamRunner.prototype.showModal = function(title, body, btns) {
        this.hideModal();
        var m = this.modalEl.querySelector('.aq-modal');
        m.querySelector('h3').textContent = title;
        m.querySelector('p').textContent = body;
        var bc = m.querySelector('.aq-modal-btns');
        var self = this;
        btns.forEach(function(bi) {
            var b = document.createElement('button');
            b.textContent = bi.text;
            b.className = bi.cls;
            b.addEventListener('click', bi.fn, {once: true});
            bc.appendChild(b);
        });
        this.modalEl.style.display = 'flex';
    };

    ExamRunner.prototype.hideModal = function() {
        this.modalEl.style.display = 'none';
        this.modalEl.querySelector('.aq-modal-btns').innerHTML = '';
    };

    ExamRunner.prototype.finishExam = function() {
        var self = this;
        // --- ORDER-SENSITIVE: clear the timer and mark the exam as finished
        //     BEFORE calling clearState(). Otherwise a pending timer tick
        //     (the 10-second auto-save inside startTimer) could fire in the
        //     gap between clearState() and the timer being cleared, which
        //     would re-write the quiz state into sessionStorage at its final
        //     position (cur = total-1) — causing the next page load to
        //     auto-restore onto the last question with a Submit button
        //     instead of showing the Start screen.
        this._finished = true;               // gates all future saveState() calls
        if (this.timerInt) {
            clearInterval(this.timerInt);
            this.timerInt = null;
        }
        // Bring back any sibling quiz containers that were hidden when this
        // quiz started — so the user can take the next one after finishing.
        _aimcqShowAllContainers();
        this.clearState();
        this.hideModal();
        if (this.navPanel) this.navPanel.style.display = 'none';
        // Topic tabs aren't useful on the finished result screen — hide them.
        if (this.topicTabBar) this.topicTabBar.style.display = 'none';
        // Same for the current-topic badge in the header.
        if (this.topicBadge) this.topicBadge.style.display = 'none';
        // Remove portal toggle & overlay from document.body on exam finish
        if (this.navToggle && this.navToggle.parentNode) {
            this.navToggle.parentNode.removeChild(this.navToggle);
            this.navToggle = null;
        }
        if (this.navOverlay && this.navOverlay.parentNode) {
            this.navOverlay.parentNode.removeChild(this.navOverlay);
            this.navOverlay = null;
        }
        this.form.dataset.finished = 'true';
        this.wrap.querySelectorAll('.aq-q-footer').forEach(function(f){ f.style.display = 'none'; });

        // ---- Evaluate all questions ----
        // Also tally per-topic stats so the results screen can show a sectional breakdown.
        var totalCorrect = 0, totalWrong = 0, totalAttempted = 0;
        var topicStats = {};       // slug -> {slug, name, total, correct, wrong, attempted}
        var topicStatsOrder = [];  // preserve insertion order (= topic order in the quiz)
        function bumpTopic(q, field) {
            var t = q.topic || { slug: 'general', name: 'General' };
            if (!topicStats[t.slug]) {
                topicStats[t.slug] = { slug: t.slug, name: t.name || t.slug, total: 0, correct: 0, wrong: 0, attempted: 0 };
                topicStatsOrder.push(t.slug);
            }
            topicStats[t.slug][field]++;
        }
        // Count totals once for every question.
        this.qs.forEach(function(q) { bumpTopic(q, 'total'); });

        if (this.S.feedback_mode !== 'instant') {
            this.score = 0;
            this.qElems.forEach(function(qEl, idx) {
                var qd = self.qs[idx];
                var isCorrect = self.evalQ(qEl, qd, true);
                if (isCorrect) { self.score++; totalCorrect++; bumpTopic(qd, 'correct'); }
                else {
                    var sel = self.selections[idx] || [];
                    if (sel.length > 0) { totalWrong++; bumpTopic(qd, 'wrong'); }
                }
                if ((self.selections[idx] || []).length > 0) { totalAttempted++; bumpTopic(qd, 'attempted'); }
                if (self.S.show_explanation) {
                    var lang = self.langs[idx];
                    var exp = qd[lang].explanation;
                    var expDiv = qEl.querySelector('.aq-explanation');
                    if (exp && expDiv) {
                        expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                        expDiv.style.display = 'block';
                        self.renderMath(expDiv);
                        self.renderChem(expDiv);
                    }
                }
            });
        } else {
            // instant mode — tally from already-checked questions
            this.qElems.forEach(function(qEl, idx) {
                var sel = self.selections[idx] || [];
                if (sel.length > 0) {
                    totalAttempted++;
                    var qd = self.qs[idx];
                    bumpTopic(qd, 'attempted');
                    var correct = (qd.correct || []).map(String);
                    var isOk = sel.length === correct.length && sel.every(function(v){ return correct.indexOf(v) !== -1; });
                    if (isOk) { totalCorrect++; bumpTopic(qd, 'correct'); }
                    else { totalWrong++; bumpTopic(qd, 'wrong'); }
                }
            });
        }

        // ---- Reveal all questions ----
        this.qElems.forEach(function(q){ q.classList.remove('hidden'); });
        this.navRow.style.display = 'none';
        if (this.prog) this.prog.parentElement.style.display = 'none';

        // ---- Reorder DOM: move each passage box to just before its FIRST question ----
        // Track placed IDs so each box is inserted exactly once — before question[0] of that group.
        // The loop visits qElems in DOM order (which matches question index order), so the first
        // encounter per passage_id is always the first question in that group.
        var form = this.form;
        var _placedPassages = {};
        this.qElems.forEach(function(qEl) {
            var pid = qEl.dataset.passageId;
            if (!pid || _placedPassages[pid]) return;   // skip non-passage or already placed
            var passageBox = self.wrap.querySelector('#aq-passage-display-' + pid);
            if (!passageBox) return;
            _placedPassages[pid] = true;
            form.insertBefore(passageBox, qEl);          // move box to just before this question
        });

        // ---- Show all passage boxes ----
        this.wrap.querySelectorAll('.aq-passage-display').forEach(function(pd) {
            pd.style.display = 'block';
        });

        // ---- Score summary table ----
        var pct = this.total > 0 ? Math.round(this.score / this.total * 100) : 0;
        var unanswered = this.total - totalAttempted;
        var pctColor = pct >= 50 ? 'var(--aq-success)' : 'var(--aq-danger)';

        // ---- Per-topic breakdown (only when quiz spans >= 2 topics) ----
        var topicBreakdownHTML = '';
        if (topicStatsOrder.length >= 2) {
            var rows = topicStatsOrder.map(function(slug) {
                var s = topicStats[slug];
                var tPct = s.total > 0 ? Math.round(s.correct / s.total * 100) : 0;
                var barColor = tPct >= 50 ? 'var(--aq-success)' : 'var(--aq-danger)';
                return '<div class="aq-topic-breakdown-row">'
                    + '<div class="aq-topic-breakdown-name">' + escapeAttr(s.name) + '</div>'
                    + '<div class="aq-topic-breakdown-stats">' + s.correct + ' / ' + s.total + '</div>'
                    + '<div class="aq-topic-breakdown-bar"><span style="width:' + tPct + '%;background:' + barColor + ';"></span></div>'
                    + '<div class="aq-topic-breakdown-pct" style="color:' + barColor + ';">' + tPct + '%</div>'
                    + '</div>';
            }).join('');
            topicBreakdownHTML =
                '<div class="aq-topic-breakdown">'
                + '<h4>Sectional Breakdown</h4>'
                + rows
                + '</div>';
        }

        this.resultsEl.innerHTML =
            '<h3>Exam Finished!</h3>'
            + '<table class="aq-results-table">'
            + '<tbody>'
            + '<tr><th>Total Questions</th><td>' + this.total + '</td></tr>'
            + '<tr><th>Attempted</th><td>' + totalAttempted + '</td></tr>'
            + '<tr><th>Unanswered</th><td>' + unanswered + '</td></tr>'
            + '<tr><th>Correct</th><td style="color:var(--aq-success);">' + totalCorrect + '</td></tr>'
            + '<tr><th>Wrong</th><td style="color:var(--aq-danger);">' + totalWrong + '</td></tr>'
            + '<tr class="aq-results-highlight"><th>Score</th><td style="color:' + pctColor + ';font-size:1.2rem;">' + pct + '%</td></tr>'
            + '</tbody></table>'
            + topicBreakdownHTML;
        this.resultsEl.style.display = 'block';
        this.resultsEl.className = 'aq-results ' + (pct >= 50 ? 'pass' : 'fail');
        this.resultsEl.scrollIntoView({behavior:'smooth'});

        this.renderMath(this.form);
        this.renderChem(this.form);

        // Final safety-net clearState(): in the highly unlikely event that
        // something in the evaluation loop above managed to save state
        // (e.g. a synthetic event fired as a side-effect of DOM mutation),
        // this second call guarantees the session is clean. Combined with
        // the _finished flag in saveState(), this eliminates the "reload
        // lands on last question" class of bug entirely.
        this.clearState();
    };

    // ---- Bind start buttons ----
    if (questions.length > 0) {

        // Prepare questions for a given mode: group by topic, then by passage within each topic.
        // Shuffling preserves topic cohesion (shuffle within topic, then shuffle topic order),
        // so the resulting quiz still flows as clean sectional groups.
        function prepareQuestions(mode) {
            var pool = questions;

            // STEP 1: bucket questions by topic-slug, preserving input order within each bucket.
            var topicBuckets = {};
            var topicOrder = [];
            pool.forEach(function(q) {
                var ts = (q.topic && q.topic.slug) || 'general';
                if (!topicBuckets[ts]) { topicBuckets[ts] = []; topicOrder.push(ts); }
                topicBuckets[ts].push(q);
            });

            // STEP 2: within each topic, group passage-questions together (same passage = one group).
            function bucketToGroups(bucket) {
                var groups = [];
                var gmap = {};
                bucket.forEach(function(q) {
                    if (q.is_passage_question && q.passage_id) {
                        var gk = 'p_' + q.passage_id;
                        if (!gmap[gk]) { gmap[gk] = []; groups.push(gmap[gk]); }
                        gmap[gk].push(q);
                    } else {
                        groups.push([q]);
                    }
                });
                return groups;
            }

            // Build groups per topic.
            var topicGroups = {}; // slug -> array of groups
            topicOrder.forEach(function(ts) {
                topicGroups[ts] = bucketToGroups(topicBuckets[ts]);
            });

            if (S.shuffle_questions) {
                // Shuffle groups within each topic (and questions within each passage group).
                // NOTE: we deliberately do NOT shuffle topicOrder — topic sequence must stay
                // stable across sessions so question numbering (1..25 = topic A, 26..50 =
                // topic B, …) reflects the author's intended topic order.
                topicOrder.forEach(function(ts) {
                    topicGroups[ts] = topicGroups[ts].map(function(g) {
                        return g.length > 1 ? shuffleArray(g) : g;
                    });
                    topicGroups[ts] = shuffleArray(topicGroups[ts]);
                });
            }

            // ---- Apply custom topic order (S.topic_order) if provided ----
            // Entries can be topic names ("General Intelligence") or slugs
            // ("general-intelligence"). Topics not listed keep their source-order
            // position, appended after the explicitly-ordered ones.
            if (Array.isArray(S.topic_order) && S.topic_order.length > 0) {
                var seenSlugs = {};
                var wanted = [];
                S.topic_order.forEach(function(entry) {
                    if (!entry) return;
                    var wantSlug;
                    if (typeof entry === 'string') {
                        wantSlug = _slugify(entry);
                    } else if (entry && typeof entry === 'object') {
                        wantSlug = entry.slug || _slugify(entry.name || '');
                    }
                    if (!wantSlug) return;
                    // Match by slug first, else by slugified name
                    var matchSlug = null;
                    for (var k = 0; k < topicOrder.length; k++) {
                        var ts = topicOrder[k];
                        if (ts === wantSlug || _slugify(ts) === wantSlug) { matchSlug = ts; break; }
                        // Also match on display name (so "General Intelligence" works when
                        // the stored slug is "general-intelligence-gi" or similar).
                        var topicName = (topicBuckets[ts][0].topic && topicBuckets[ts][0].topic.name) || '';
                        if (_slugify(topicName) === wantSlug) { matchSlug = ts; break; }
                    }
                    if (matchSlug && !seenSlugs[matchSlug]) {
                        seenSlugs[matchSlug] = true;
                        wanted.push(matchSlug);
                    }
                });
                // Append any topics the user didn't mention, in their original order.
                topicOrder.forEach(function(ts) {
                    if (!seenSlugs[ts]) { wanted.push(ts); seenSlugs[ts] = true; }
                });
                topicOrder = wanted;
            }

            // STEP 3: apply quiz_questions limit proportionally across topics so every topic
            // is represented in the quiz (instead of the limit cutting off the last topic).
            var limit = (mode !== 'revision' && S.quiz_questions > 0) ? S.quiz_questions : 0;
            if (limit > 0) {
                var totalAvail = 0;
                topicOrder.forEach(function(ts) {
                    topicGroups[ts].forEach(function(g) { totalAvail += g.length; });
                });
                if (limit < totalAvail) {
                    // Compute a per-topic quota proportional to each topic's size, at least 1 each.
                    var quotas = {};
                    var assigned = 0;
                    topicOrder.forEach(function(ts) {
                        var size = 0;
                        topicGroups[ts].forEach(function(g) { size += g.length; });
                        var q = Math.max(1, Math.round(limit * size / totalAvail));
                        quotas[ts] = q;
                        assigned += q;
                    });
                    // Fix rounding drift so quotas sum to exactly `limit`.
                    var drift = assigned - limit;
                    var orderForDrift = topicOrder.slice();
                    while (drift > 0) {
                        var ts = orderForDrift.pop();
                        if (ts == null) break;
                        if (quotas[ts] > 1) { quotas[ts]--; drift--; }
                    }
                    while (drift < 0) {
                        orderForDrift = topicOrder.slice();
                        var ts2 = orderForDrift.shift();
                        if (ts2 == null) break;
                        quotas[ts2]++;
                        drift++;
                    }
                    // Trim each topic's groups to its quota, keeping passage groups whole.
                    topicOrder.forEach(function(ts) {
                        var groups = topicGroups[ts];
                        var cap = quotas[ts];
                        var kept = [];
                        var count = 0;
                        for (var gi = 0; gi < groups.length; gi++) {
                            var g = groups[gi];
                            if (count + g.length <= cap) { kept.push(g); count += g.length; }
                            else if (g.length === 1 && count < cap) { kept.push(g); count++; }
                            if (count >= cap) break;
                        }
                        topicGroups[ts] = kept;
                    });
                }
            }

            // STEP 4: flatten in topic order, then group order, then question order.
            var flat = [];
            topicOrder.forEach(function(ts) {
                topicGroups[ts].forEach(function(g) {
                    g.forEach(function(q) { flat.push(q); });
                });
            });
            return flat;
        }

        // Rebuild questions array from saved IDs (for session restore)
        function restoreQuestionsById(ids) {
            var byId = {};
            questions.forEach(function(q){ byId[q.id] = q; });
            var restored = [];
            ids.forEach(function(id){ if (byId[id]) restored.push(byId[id]); });
            return restored.length > 0 ? restored : questions;
        }

        // Check for saved session state and auto-restore
        // Migration: remove any old-format key (without fingerprint) to prevent stale cross-post collisions
        try {
            var oldKey = 'aimcq_state_' + containerId;
            var oldRaw = sessionStorage.getItem(oldKey);
            if (oldRaw) {
                sessionStorage.removeItem(oldKey);
                // Attempt to migrate: if the old state's questionIds match this quiz, re-save under the new key
                try {
                    var oldSaved = JSON.parse(oldRaw);
                    if (oldSaved.questionIds) {
                        var oldIds = oldSaved.questionIds.slice().sort(function(a,b){ return a-b; }).join(',');
                        var curIds = questions.map(function(q){ return q.id; }).sort(function(a,b){ return a-b; }).join(',');
                        if (oldIds === curIds) {
                            oldSaved.fingerprint = _quizFingerprint;
                            sessionStorage.setItem('aimcq_state_' + containerId + '_' + _quizFingerprint, JSON.stringify(oldSaved));
                        }
                    }
                } catch(me) { /* migration parse failed, discard */ }
            }
        } catch(e) { /* storage unavailable */ }

        var saved = ExamRunner.loadSaved(containerId, _quizFingerprint);
        // Validate: if saved fingerprint doesn't match (shouldn't happen, but guard), discard
        if (saved && saved.fingerprint && saved.fingerprint !== _quizFingerprint) {
            try { sessionStorage.removeItem('aimcq_state_' + containerId + '_' + _quizFingerprint); } catch(e) {}
            saved = null;
        }
        // Multi-quiz coordination: if another quiz on this page has already
        // auto-restored and taken ownership, don't auto-restore this one too
        // (two simultaneously-active quizzes would hide each other in a loop
        // and confuse the user). Fall through to the start-screen path instead —
        // the saved state remains in sessionStorage and this quiz will resume
        // normally once the user clicks Start (or after the active quiz finishes).
        if (saved && window.__aimcqActiveQuizId && window.__aimcqActiveQuizId !== containerId) {
            saved = null;
        }

        // ---- Professional interface helper -------------------------------
        // Mounts the SSC/CBT-style professional exam interface for the given
        // question set. Used by all three embed methods whenever the quiz's
        // `exam_interface` setting is 'professional'. Falls back gracefully
        // to the basic ExamRunner if the professional module failed to load.
        function _mountProfessional(activeQs) {
            if (!window.AIMCQ_PRO || typeof window.AIMCQ_PRO.mount !== 'function') {
                return null;   // module missing -> caller falls back to basic
            }
            // Provide the engine's KaTeX/SMILES helpers (with literal-$ guard)
            // to the professional runner so math/chemistry render identically.
            var _mathProxy = ExamRunner.prototype.renderMath;
            var _chemProxy = ExamRunner.prototype.renderChem;
            var helpers = {
                renderMath: function(el) { try { _mathProxy.call({}, el); } catch(e) {
                    if (window.renderMathInElement) window.renderMathInElement(el, {
                        delimiters: [
                            {left:'$$',right:'$$',display:true},
                            {left:'$',right:'$',display:false},
                            {left:'\\(',right:'\\)',display:false},
                            {left:'\\[',right:'\\]',display:true}
                        ]
                    });
                } },
                renderChem: function(el) { try { _chemProxy.call({}, el); } catch(e) {} }
            };
            return window.AIMCQ_PRO.mount(containerId, S, activeQs, passageData, _quizFingerprint, helpers);
        }

        // ---- Auto-resume a professional-interface session ----------------
        // The professional interface persists its own state under a separate
        // localStorage key. If such a session exists for this quiz, restore
        // straight into the professional interface (its start screen offers
        // a "Resume Test" button).
        if (S.exam_interface === 'professional'
            && !saved
            && window.AIMCQ_PRO
            && window.AIMCQ_PRO.hasSavedSession(containerId, _quizFingerprint)) {
            var proSaved = null;
            try {
                proSaved = JSON.parse(localStorage.getItem('aimcq_cbt_state_' + containerId + '_' + _quizFingerprint));
            } catch(e) {}
            if (proSaved && proSaved.questionIds) {
                // Re-apply the saved mode settings before mounting.
                S.feedback_mode = proSaved.feedbackMode || S.feedback_mode;
                S.display_mode = proSaved.displayMode || S.display_mode;
                S.timer = proSaved.timer != null ? proSaved.timer : S.timer;
                var proActiveQs = restoreQuestionsById(proSaved.questionIds);
                if (_mountProfessional(proActiveQs)) {
                    return; // professional runner is now in control
                }
            }
        }

        if (saved) {
            // Restore the mode settings
            if (saved.mode === 'revision') {
                S.feedback_mode = 'instant';
                S.display_mode = 'single';
                S.timer = 0;
            } else {
                S.feedback_mode = saved.feedbackMode || S.feedback_mode;
                S.display_mode = saved.displayMode || S.display_mode;
                S.timer = saved.timer != null ? saved.timer : S.timer;
            }
            // Restore exact question set & order from saved IDs
            var activeQs = saved.questionIds ? restoreQuestionsById(saved.questionIds) : questions;
            document.getElementById('aq-start-' + containerId).style.display = 'none';
            document.getElementById('aq-ph-' + containerId).innerHTML = getExamHTML(activeQs, passageData);
            var runner = new ExamRunner(containerId, S, activeQs, passageData, _quizFingerprint);
            runner._timerRem = saved.timerRem || 0;
            runner.restoreState(saved);
            runner.init();
            runner.start();
        } else {
            var startBtns = document.querySelectorAll('#aq-start-' + containerId + ' .aq-start-btn');
            startBtns.forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var mode = this.dataset.mode;
                    document.getElementById('aq-start-' + containerId).style.display = 'none';
                    if (mode === 'revision') {
                        S.feedback_mode = 'instant';
                        S.display_mode = 'single';
                        S.timer = 0;
                    }
                    var activeQs = prepareQuestions(mode);

                    // ---- Professional vs Basic interface execution setting ----
                    // When `exam_interface` is 'professional', hand the prepared
                    // question set to the CBT interface module. It renders its
                    // own instruction start screen + declaration before the
                    // exam begins. If the module is unavailable for any reason,
                    // fall through to the basic ExamRunner so the quiz still works.
                    if (S.exam_interface === 'professional') {
                        if (_mountProfessional(activeQs)) return;
                    }

                    document.getElementById('aq-ph-' + containerId).innerHTML = getExamHTML(activeQs, passageData);
                    var runner = new ExamRunner(containerId, S, activeQs, passageData, _quizFingerprint);
                    runner.init();
                    runner.start();
                });
            });
        }
    }
};

/* ==================================================================
/* ==================================================================
   REMOTE QUIZ LOADER  -  window.loadAimcqFromDrive(containerId, opts)
   ==================================================================
   Loads one or more quiz JSON files from public URLs (jsDelivr, CDN,
   raw.githubusercontent.com, your own server, etc.) and initialises
   the quiz engine. Google Drive is not supported.

   METHOD 2 - Single JSON URL:
     window.loadAimcqFromDrive('aimcq-quiz-2', {
         jsonUrl: 'https://cdn.jsdelivr.net/gh/USER/REPO@TAG/quiz.json',
         settings: {
             title: "My Quiz", timer: 10, quiz_questions: 10,
             shuffle_questions: true, shuffle_options: true
         }
     });

   METHOD 3 - Multiple JSON URLs merged into one quiz:
     window.loadAimcqFromDrive('aimcq-quiz-3', {
         jsonUrls: [
             { jsonUrl: 'https://.../ch1.json', topic: 'Chapter 1' },
             { jsonUrl: 'https://.../ch2.json', topic: 'Chapter 2' }
         ],
         settings: {
             title: "Multi-Chapter Quiz", timer: 20, quiz_questions: 20,
             shuffle_questions: true, shuffle_options: true,
             topic_order: ['Chapter 1', 'Chapter 2']
         }
     });
   ================================================================== */

window.loadAimcqFromDrive = function(containerId, opts) {
    opts = opts || {};
    var container = document.getElementById(containerId);
    if (!container) return;

    function renderLoading(msg) {
        container.innerHTML = '<div id="aimcq-root-scope"><div class="aq-wrapper">'
            + '<div class="aq-start" style="text-align:center;padding:3rem 2rem;">'
            + '<div class="aq-loader-spinner"></div>'
            + '<p style="margin-top:1.2rem;font-size:1.05rem;color:#6c757d;">' + (msg || 'Loading quiz\u2026') + '</p>'
            + '</div></div></div>';
    }
    function renderSleep() {
        container.innerHTML = '<div id="aimcq-root-scope"><div class="aq-wrapper">'
            + '<div class="aq-start" style="text-align:center;padding:3rem 2rem;">'
            + '<p style="text-align:center;font-size:2rem;margin-bottom:0.75rem;">&#128564;</p>'
            + '<p style="text-align:center;color:#343a40;font-weight:bold;font-size:1.15rem;">This quiz is in sleep mode</p>'
            + '<p style="text-align:center;color:#6c757d;font-size:0.95rem;margin-top:0.5rem;">Please refresh or try again later.</p>'
            + '</div></div></div>';
    }

    /* Build entries list from opts.jsonUrl / opts.jsonUrls */
    var entries = [];
    if (Array.isArray(opts.jsonUrls)) {
        opts.jsonUrls.forEach(function(u) {
            if (!u) return;
            if (typeof u === 'string') entries.push({ jsonUrl: u });
            else entries.push(u);
        });
    }
    if (opts.jsonUrl) entries.push({ jsonUrl: opts.jsonUrl, topic: opts.topic });

    if (entries.length === 0) { renderSleep(); return; }

    function slugifyTopic(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'topic';
    }
    function normalizeTopic(t) {
        if (!t) return null;
        if (typeof t === 'string') return { name: t, slug: slugifyTopic(t) };
        if (typeof t === 'object') {
            var name = t.name || t.label || '';
            return name ? { name: name, slug: t.slug || slugifyTopic(name) } : null;
        }
        return null;
    }

    renderLoading('Loading quiz data\u2026');

    function fetchOne(entry) {
        var url = entry.jsonUrl;
        if (!url) return Promise.resolve(null);
        var sourceTopic = normalizeTopic(entry && entry.topic);
        return fetch(url, { redirect: 'follow' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function(text) {
                var trimmed = (text || '').trim();
                if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
                    throw new Error('Response is not JSON');
                }
                var data = JSON.parse(trimmed);
                if (sourceTopic && data && Array.isArray(data.posts)) {
                    data.posts.forEach(function(p) {
                        if (p && typeof p === 'object' && !p._aimcq_source_topic) {
                            p._aimcq_source_topic = sourceTopic;
                        }
                    });
                    data.terms = Array.isArray(data.terms) ? data.terms : [];
                    var seen = data.terms.some(function(t) {
                        return t && (t.slug === sourceTopic.slug || t.name === sourceTopic.name);
                    });
                    if (!seen) {
                        data.terms.push({ taxonomy: 'topic', name: sourceTopic.name, slug: sourceTopic.slug, parent: '' });
                    }
                }
                return data;
            })
            .catch(function(err) {
                if (window.console && console.warn) console.warn('[aimcq] Failed to load:', url, err && err.message);
                return null;
            });
    }

    function mergeBundles(bundles) {
        var out = { version: '', export_type: '', terms: [], posts: [] };
        var seenPosts = {}, seenTerms = {};
        bundles.forEach(function(b) {
            if (!b || typeof b !== 'object') return;
            if (!out.version && b.version) out.version = b.version;
            if (!out.export_type && b.export_type) out.export_type = b.export_type;
            (b.terms || []).forEach(function(t) {
                if (!t) return;
                var k = (t.taxonomy || '') + '::' + (t.slug || t.name || '');
                if (!seenTerms[k]) { seenTerms[k] = true; out.terms.push(t); }
            });
            (b.posts || []).forEach(function(p) {
                if (!p) return;
                if (p.id != null && seenPosts[p.id]) return;
                if (p.id != null) seenPosts[p.id] = true;
                out.posts.push(p);
            });
        });
        return out;
    }

    Promise.all(entries.map(fetchOne)).then(function(results) {
        var allOk = results.length === entries.length
            && results.every(function(r) { return r && typeof r === 'object'; });
        if (!allOk) { renderSleep(); return; }
        var merged = results.length === 1 ? results[0] : mergeBundles(results);
        if (!merged.posts || merged.posts.length === 0) { renderSleep(); return; }
        container.innerHTML = '';
        container.id = containerId;
        window.initAimcqQuiz(containerId, merged, opts.settings || {});
    }).catch(function() { renderSleep(); });
};


/* ==================================================================
   PROFESSIONAL CBT EXAM INTERFACE  (ported from ai-mcqs-exam-maker)
   ==================================================================
   This module provides a second, "professional" exam interface that
   matches the SSC / CBT-style layout shipped by the AI MCQs Exam Maker
   WordPress plugin: a fullscreen overlay, an instruction start screen
   with a declaration checkbox, a colour-coded question palette, a top
   bar with timer, and a bottom action bar (Save & Next / Mark for
   Review / Clear Response / Check Answer).

   It is selected per quiz via the `exam_interface` setting:

       exam_interface: 'basic'         -> original engine interface
       exam_interface: 'professional'  -> this CBT interface

   The module is fully self-contained. It re-uses the question objects,
   passage map and settings already prepared by initAimcqQuiz, so all
   three embed methods (inline JSON, single remote JSON, multi-file
   merged JSON) support it identically.
   ================================================================== */

window.AIMCQ_PRO = (function () {
    'use strict';

    var OPT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

    function escAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ----------------------------------------------------------------
       Build the full professional CBT markup for one quiz.
       Returns an HTML string injected into the quiz placeholder.
       ---------------------------------------------------------------- */
    function buildHTML(cid, S, qs, pdata) {
        var isRevision = (S.feedback_mode === 'instant' && S.timer === 0);
        var marks = (S.marks_per_question != null) ? Number(S.marks_per_question) : 1;
        var neg = (S.negative_marks != null) ? Number(S.negative_marks) : 0;
        if (isNaN(marks)) marks = 1;
        if (isNaN(neg)) neg = 0;

        /* ---- topic / section grouping (for section tabs) ---- */
        var secOrder = [], secBySlug = {};
        qs.forEach(function (q, i) {
            var t = q.topic || { slug: 'general', name: 'General' };
            if (!secBySlug[t.slug]) {
                secBySlug[t.slug] = { slug: t.slug, name: t.name || t.slug, indices: [] };
                secOrder.push(t.slug);
            }
            secBySlug[t.slug].indices.push(i);
        });
        var hasSections = secOrder.length > 1;

        /* ---- start-screen instruction list ---- */
        var instEN, instHI;
        if (isRevision) {
            instEN = '<div class="cbt-inst-en">'
                + '<h3>Revision Instructions</h3>'
                + '<p>Please read the following instructions carefully before starting the revision:</p>'
                + '<ol>'
                + '<li>This is a practice mode designed for revision. There is no time limit.</li>'
                + '<li>You can check your answer instantly by clicking the <strong>Check Answer</strong> button below the question.</li>'
                + '<li>Detailed explanations for the questions (if available) will be displayed once you verify your answer.</li>'
                + '<li>There is no negative marking or final score penalty in this mode.</li>'
                + '<li>The Question Palette displayed on the left side of the screen will show the status of each question.</li>'
                + '<li>Click on the <strong>Question Number</strong> in the Question Palette to jump to that question directly.</li>'
                + '</ol>'
                + '<h4>Question Palette Legend:</h4></div>';
            instHI = '<div class="cbt-inst-hi" style="display:none;">'
                + '<h3>\u0930\u093f\u0935\u0940\u091c\u0928 \u0928\u093f\u0930\u094d\u0926\u0947\u0936</h3>'
                + '<p>\u0915\u0943\u092a\u092f\u093e \u0905\u092a\u0928\u093e \u0930\u093f\u0935\u0940\u091c\u0928 \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0938\u0947 \u092a\u0939\u0932\u0947 \u0928\u093f\u092e\u094d\u0928\u0932\u093f\u0916\u093f\u0924 \u0928\u093f\u0930\u094d\u0926\u0947\u0936\u094b\u0902 \u0915\u094b \u0927\u094d\u092f\u093e\u0928 \u0938\u0947 \u092a\u0922\u093c\u0947\u0902:</p>'
                + '<ol>'
                + '<li>\u092f\u0939 \u0905\u092d\u094d\u092f\u093e\u0938 \u0915\u0947 \u0932\u093f\u090f \u0921\u093f\u091c\u093c\u093e\u0907\u0928 \u0915\u093f\u092f\u093e \u0917\u092f\u093e \u090f\u0915 \u0930\u093f\u0935\u0940\u091c\u0928 \u092e\u094b\u0921 \u0939\u0948\u0964 \u0907\u0938\u092e\u0947\u0902 \u0915\u094b\u0908 \u0938\u092e\u092f \u0938\u0940\u092e\u093e \u0928\u0939\u0940\u0902 \u0939\u0948\u0964</li>'
                + '<li>\u0906\u092a \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u0947 \u0928\u0940\u091a\u0947 \u0926\u093f\u090f \u0917\u090f <strong>Check Answer</strong> \u092c\u091f\u0928 \u092a\u0930 \u0915\u094d\u0932\u093f\u0915 \u0915\u0930\u0915\u0947 \u0924\u0941\u0930\u0902\u0924 \u0905\u092a\u0928\u0947 \u0909\u0924\u094d\u0924\u0930 \u0915\u0940 \u091c\u093e\u0902\u091a \u0915\u0930 \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964</li>'
                + '<li>\u0905\u092a\u0928\u093e \u0909\u0924\u094d\u0924\u0930 \u091c\u093e\u0902\u091a\u0928\u0947 \u0915\u0947 \u092c\u093e\u0926 \u092a\u094d\u0930\u0936\u094d\u0928\u094b\u0902 \u0915\u0947 \u0935\u093f\u0938\u094d\u0924\u0943\u0924 \u0938\u094d\u092a\u0937\u094d\u091f\u0940\u0915\u0930\u0923 (\u092f\u0926\u093f \u0909\u092a\u0932\u092c\u094d\u0927 \u0939\u094b\u0902) \u092a\u094d\u0930\u0926\u0930\u094d\u0936\u093f\u0924 \u0915\u093f\u090f \u091c\u093e\u090f\u0902\u0917\u0947\u0964</li>'
                + '<li>\u0907\u0938 \u092e\u094b\u0921 \u092e\u0947\u0902 \u0915\u094b\u0908 \u0928\u0947\u0917\u0947\u091f\u093f\u0935 \u092e\u093e\u0930\u094d\u0915\u093f\u0902\u0917 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964</li>'
                + '<li>\u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0915\u0947 \u092c\u093e\u0908\u0902 \u0913\u0930 \u092a\u094d\u0930\u0926\u0930\u094d\u0936\u093f\u0924 \u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0948\u0932\u0947\u091f \u092a\u094d\u0930\u0924\u094d\u092f\u0947\u0915 \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u0940 \u0938\u094d\u0925\u093f\u0924\u093f \u0926\u093f\u0916\u093e\u090f\u0917\u093e\u0964</li>'
                + '<li>\u0909\u0938 \u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0930 \u0938\u0940\u0927\u0947 \u091c\u093e\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0948\u0932\u0947\u091f \u092e\u0947\u0902 <strong>\u092a\u094d\u0930\u0936\u094d\u0928 \u0938\u0902\u0916\u094d\u092f\u093e</strong> \u092a\u0930 \u0915\u094d\u0932\u093f\u0915 \u0915\u0930\u0947\u0902\u0964</li>'
                + '</ol>'
                + '<h4>\u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0948\u0932\u0947\u091f \u0932\u0947\u091c\u0947\u0902\u0921 (Legend):</h4></div>';
        } else {
            var negTextEN = neg > 0
                ? ', and each incorrect answer carries a penalty of <strong>-' + neg + '</strong> marks'
                : '. There is <strong>NO negative marking</strong> for incorrect answers';
            var negTextHI = neg > 0
                ? ', \u0914\u0930 \u092a\u094d\u0930\u0924\u094d\u092f\u0947\u0915 \u0917\u0932\u0924 \u0909\u0924\u094d\u0924\u0930 \u0915\u0947 \u0932\u093f\u090f <strong>-' + neg + '</strong> \u0905\u0902\u0915\u094b\u0902 \u0915\u0940 \u0928\u0947\u0917\u0947\u091f\u093f\u0935 \u092e\u093e\u0930\u094d\u0915\u093f\u0902\u0917 \u0939\u0948'
                : '\u0964 \u0917\u0932\u0924 \u0909\u0924\u094d\u0924\u0930\u094b\u0902 \u0915\u0947 \u0932\u093f\u090f <strong>\u0915\u094b\u0908 \u0928\u0947\u0917\u0947\u091f\u093f\u0935 \u092e\u093e\u0930\u094d\u0915\u093f\u0902\u0917 \u0928\u0939\u0940\u0902</strong> \u0939\u0948';
            instEN = '<div class="cbt-inst-en">'
                + '<h3>General Instructions</h3>'
                + '<p>Please read the following instructions carefully before starting the examination:</p>'
                + '<ol>'
                + '<li>The countdown timer at the top right corner of the screen will display the remaining time available to complete the examination. When the timer reaches zero, the examination will end automatically.</li>'
                + '<li>Each correct answer will be awarded <strong>+' + marks + '</strong> marks' + negTextEN + '.</li>'
                + '<li>Unanswered questions will receive <strong>0</strong> marks. Questions marked for review <strong>WITHOUT</strong> selecting an option will also not be evaluated.</li>'
                + '<li>Questions that are <strong>ANSWERED</strong> and marked for review will be considered for final evaluation.</li>'
                + '<li>The Question Palette displayed on the left side of the screen will show the status of each question.</li>'
                + '<li>Click on the <strong>Question Number</strong> in the Question Palette to go to that question directly.</li>'
                + '<li>To save your answer, you MUST click on the <strong>Save &amp; Next</strong> button.</li>'
                + '<li>To mark a question for review, click on the <strong>Mark for Review</strong> button.</li>'
                + '<li>To change an already-answered question, select it and then click the <strong>Clear Response</strong> button.</li>'
                + '</ol>'
                + '<h4>Question Palette Legend:</h4></div>';
            instHI = '<div class="cbt-inst-hi" style="display:none;">'
                + '<h3>\u0938\u093e\u092e\u093e\u0928\u094d\u092f \u0928\u093f\u0930\u094d\u0926\u0947\u0936</h3>'
                + '<p>\u0915\u0943\u092a\u092f\u093e \u092a\u0930\u0940\u0915\u094d\u0937\u093e \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0938\u0947 \u092a\u0939\u0932\u0947 \u0928\u093f\u092e\u094d\u0928\u0932\u093f\u0916\u093f\u0924 \u0928\u093f\u0930\u094d\u0926\u0947\u0936\u094b\u0902 \u0915\u094b \u0927\u094d\u092f\u093e\u0928 \u0938\u0947 \u092a\u0922\u093c\u0947\u0902:</p>'
                + '<ol>'
                + '<li>\u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0915\u0947 \u090a\u092a\u0930\u0940 \u0926\u093e\u090f\u0902 \u0915\u094b\u0928\u0947 \u092e\u0947\u0902 \u0915\u093e\u0909\u0902\u091f\u0921\u093e\u0909\u0928 \u091f\u093e\u0907\u092e\u0930 \u092a\u0930\u0940\u0915\u094d\u0937\u093e \u092a\u0942\u0930\u0940 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u0936\u0947\u0937 \u0938\u092e\u092f \u0926\u093f\u0916\u093e\u090f\u0917\u093e\u0964</li>'
                + '<li>\u092a\u094d\u0930\u0924\u094d\u092f\u0947\u0915 \u0938\u0939\u0940 \u0909\u0924\u094d\u0924\u0930 \u0915\u0947 \u0932\u093f\u090f <strong>+' + marks + '</strong> \u0905\u0902\u0915 \u0926\u093f\u090f \u091c\u093e\u090f\u0902\u0917\u0947' + negTextHI + '\u0964</li>'
                + '<li>\u0905\u0928\u0941\u0924\u094d\u0924\u0930\u093f\u0924 \u092a\u094d\u0930\u0936\u094d\u0928\u094b\u0902 \u0915\u094b <strong>0</strong> \u0905\u0902\u0915 \u092e\u093f\u0932\u0947\u0902\u0917\u0947\u0964</li>'
                + '<li>\u091c\u093f\u0928 \u092a\u094d\u0930\u0936\u094d\u0928\u094b\u0902 \u0915\u093e \u0909\u0924\u094d\u0924\u0930 \u0926\u093f\u092f\u093e \u0917\u092f\u093e \u0939\u0948 \u0914\u0930 \u0938\u092e\u0940\u0915\u094d\u0937\u093e \u0915\u0947 \u0932\u093f\u090f \u091a\u093f\u0939\u094d\u0928\u093f\u0924 \u0915\u093f\u092f\u093e \u0917\u092f\u093e \u0939\u0948, \u0909\u0928\u0915\u093e \u092e\u0942\u0932\u094d\u092f\u093e\u0902\u0915\u0928 \u0915\u093f\u092f\u093e \u091c\u093e\u090f\u0917\u093e\u0964</li>'
                + '<li>\u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0915\u0947 \u092c\u093e\u0908\u0902 \u0913\u0930 \u092a\u094d\u0930\u0926\u0930\u094d\u0936\u093f\u0924 \u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0948\u0932\u0947\u091f \u092a\u094d\u0930\u0924\u094d\u092f\u0947\u0915 \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u0940 \u0938\u094d\u0925\u093f\u0924\u093f \u0926\u093f\u0916\u093e\u090f\u0917\u093e\u0964</li>'
                + '<li>\u0905\u092a\u0928\u093e \u0909\u0924\u094d\u0924\u0930 \u0938\u0939\u0947\u091c\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f <strong>Save &amp; Next</strong> \u092c\u091f\u0928 \u092a\u0930 \u0915\u094d\u0932\u093f\u0915 \u0915\u0930\u0947\u0902\u0964</li>'
                + '<li>\u0915\u093f\u0938\u0940 \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u094b \u0938\u092e\u0940\u0915\u094d\u0937\u093e \u0915\u0947 \u0932\u093f\u090f \u091a\u093f\u0939\u094d\u0928\u093f\u0924 \u0915\u0930\u0928\u0947 \u0939\u0947\u0924\u0941 <strong>Mark for Review</strong> \u092c\u091f\u0928 \u092a\u0930 \u0915\u094d\u0932\u093f\u0915 \u0915\u0930\u0947\u0902\u0964</li>'
                + '</ol>'
                + '<h4>\u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0948\u0932\u0947\u091f \u0932\u0947\u091c\u0947\u0902\u0921 (Legend):</h4></div>';
        }

        /* ---- palette legend demo (inside instruction box) ---- */
        var demoHTML = '<div class="cbt-palette-demo">'
            + '<div class="cbt-demo-item"><span class="cbt-demo-icon cbt-icon-not-visited">1</span> '
            + '<span class="cbt-inst-en-i">You have not visited the question yet.</span>'
            + '<span class="cbt-inst-hi-i" style="display:none;">\u0906\u092a\u0928\u0947 \u0905\u092d\u0940 \u0924\u0915 \u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0930 \u0935\u093f\u091c\u093f\u091f \u0928\u0939\u0940\u0902 \u0915\u093f\u092f\u093e \u0939\u0948\u0964</span></div>'
            + '<div class="cbt-demo-item"><span class="cbt-demo-icon cbt-icon-unanswered">2</span> '
            + '<span class="cbt-inst-en-i">You have not answered the question.</span>'
            + '<span class="cbt-inst-hi-i" style="display:none;">\u0906\u092a\u0928\u0947 \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u093e \u0909\u0924\u094d\u0924\u0930 \u0928\u0939\u0940\u0902 \u0926\u093f\u092f\u093e \u0939\u0948\u0964</span></div>'
            + '<div class="cbt-demo-item"><span class="cbt-demo-icon cbt-icon-answered">3</span> '
            + '<span class="cbt-inst-en-i">You have answered the question.</span>'
            + '<span class="cbt-inst-hi-i" style="display:none;">\u0906\u092a\u0928\u0947 \u092a\u094d\u0930\u0936\u094d\u0928 \u0915\u093e \u0909\u0924\u094d\u0924\u0930 \u0926\u093f\u092f\u093e \u0939\u0948\u0964</span></div>'
            + (isRevision ? '' :
                '<div class="cbt-demo-item"><span class="cbt-demo-icon cbt-icon-review">4</span> '
                + '<span class="cbt-inst-en-i">Not answered, but marked for review.</span>'
                + '<span class="cbt-inst-hi-i" style="display:none;">\u0909\u0924\u094d\u0924\u0930 \u0928\u0939\u0940\u0902 \u0926\u093f\u092f\u093e, \u0932\u0947\u0915\u093f\u0928 \u0938\u092e\u0940\u0915\u094d\u0937\u093e \u0915\u0947 \u0932\u093f\u090f \u091a\u093f\u0939\u094d\u0928\u093f\u0924\u0964</span></div>'
                + '<div class="cbt-demo-item"><span class="cbt-demo-icon cbt-icon-answered-review">5</span> '
                + '<span class="cbt-inst-en-i">Answered and marked for review (will be evaluated).</span>'
                + '<span class="cbt-inst-hi-i" style="display:none;">\u0909\u0924\u094d\u0924\u0930 \u0926\u093f\u092f\u093e \u0917\u092f\u093e \u0914\u0930 \u0938\u092e\u0940\u0915\u094d\u0937\u093e \u0939\u0947\u0924\u0941 \u091a\u093f\u0939\u094d\u0928\u093f\u0924 (\u092e\u0942\u0932\u094d\u092f\u093e\u0902\u0915\u0928 \u0939\u094b\u0917\u093e)\u0964</span></div>')
            + '</div>';

        /* ---- exam summary chips ---- */
        var summaryHTML = '<div class="cbt-exam-summary">'
            + '<div class="cbt-summary-item"><strong>Total Questions</strong>' + qs.length + '</div>';
        if (isRevision) {
            summaryHTML += '<div class="cbt-summary-item"><strong>Mode</strong>Practice / Revision</div>'
                + '<div class="cbt-summary-item"><strong>Duration</strong>Untimed</div>'
                + '<div class="cbt-summary-item"><strong>Feedback</strong>Instant Verification</div>';
        } else {
            summaryHTML += '<div class="cbt-summary-item"><strong>Duration</strong>' + (S.timer > 0 ? S.timer + ' Minutes' : 'Untimed') + '</div>'
                + '<div class="cbt-summary-item"><strong>Correct Answer</strong>+' + marks + '</div>'
                + '<div class="cbt-summary-item"><strong>Negative Marking</strong>' + (neg > 0 ? '-' + neg : 'No Negative Marking') + '</div>';
        }
        summaryHTML += '</div>';

        var examDescHTML = '';
        if (S.description && String(S.description).trim() !== '') {
            examDescHTML = '<h4>Specific Instructions for this Exam:</h4>'
                + '<div class="cbt-exam-description">' + S.description + '</div>';
        }

        /* ---- section tabs ---- */
        var sectionTabsHTML = '';
        if (hasSections) {
            var tabs = '<button type="button" class="cbt-section-tab active" data-section-target="all">All</button>';
            secOrder.forEach(function (slug) {
                var s = secBySlug[slug];
                tabs += '<button type="button" class="cbt-section-tab" data-section-target="' + escAttr(slug) + '">' + escAttr(s.name) + '</button>';
            });
            sectionTabsHTML = '<div class="cbt-section-tabs">' + tabs + '</div>';
        }

        /* ---- palette buttons ---- */
        var navGridHTML = '';
        qs.forEach(function (q, i) {
            var slug = (q.topic && q.topic.slug) || 'general';
            navGridHTML += '<button type="button" class="cbt-q-btn q-not-visited" data-q-index="' + i + '" data-section="' + escAttr(slug) + '">' + (i + 1) + '</button>';
        });

        /* ---- passage boxes + question elements ---- */
        var seenPassage = {};
        var qsHTML = '';
        var lastSlug = null;
        qs.forEach(function (q, idx) {
            /* passage box: emitted once before the first question that uses it */
            if (q.is_passage_question && q.passage_id && pdata[q.passage_id] && !seenPassage[q.passage_id]) {
                seenPassage[q.passage_id] = true;
                var pd = pdata[q.passage_id];
                var pTitle = (pd.en && pd.en.title) ? pd.en.title : '';
                var hasHiP = pd.hi && pd.hi.content && pd.hi.content.trim() !== '' && pd.hi.content !== pd.en.content;
                qsHTML += '<div class="cbt-passage-display" id="cbt-passage-' + cid + '-' + q.passage_id + '" data-passage-id="' + q.passage_id + '" style="display:none;">'
                    + (pTitle ? '<h3 class="cbt-passage-title-en">' + pTitle + '</h3>'
                        + (hasHiP ? '<h3 class="cbt-passage-title-hi" style="display:none;">' + (pd.hi.title || pTitle) + '</h3>' : '') : '')
                    + '<div class="cbt-passage-content-en">' + pd.en.content + '</div>'
                    + (hasHiP ? '<div class="cbt-passage-content-hi" style="display:none;">' + pd.hi.content + '</div>' : '')
                    + '</div>';
            }

            var isMulti = q.correct.length > 1;
            var hasHi = q.hi.content && q.hi.content.trim() !== '';
            var imgStyle = 'width:' + (q.image_width > 0 ? q.image_width + 'px' : 'auto')
                + ';height:' + (q.image_height > 0 ? q.image_height + 'px;object-fit:cover;' : 'auto') + ';';

            var optsHTML = q.en.options.map(function (opt, oi) {
                return '<li><label>'
                    + '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="cbtq_' + q.id + '[]" value="' + oi + '">'
                    + '<div class="cbt-opt-inner">'
                    + '<span class="cbt-opt-letter">' + (OPT_LETTERS[oi] || (oi + 1)) + '</span>'
                    + (opt.image ? '<img src="' + opt.image + '" class="cbt-opt-img" style="' + imgStyle + '" alt="">' : '')
                    + '<div class="cbt-opt-text">' + opt.text + '</div>'
                    + '</div></label></li>';
            }).join('');

            var passInd = q.is_passage_question
                ? '<span class="cbt-passage-indicator" title="This question is based on the passage shown above.">'
                  + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg> Passage Question</span>'
                : '';

            var langSw = hasHi
                ? '<div class="cbt-lang-switcher"><button type="button" class="cbt-lang-btn active" data-lang="en">English</button><button type="button" class="cbt-lang-btn" data-lang="hi">\u0939\u093f\u0902\u0926\u0940</button></div>'
                : '';

            qsHTML += '<div class="cbt-question hidden" id="cbtq-' + cid + '-' + q.id + '" data-question-id="' + q.id + '" data-question-index="' + idx + '" data-passage-id="' + (q.passage_id || '') + '">'
                + '<div class="cbt-question-header">'
                + '<span class="cbt-question-number">Question ' + (idx + 1) + '.</span>'
                + passInd + langSw
                + '</div>'
                + '<div class="cbt-question-body">' + q.en.content + '</div>'
                + '<div class="cbt-options"><ul>' + optsHTML + '</ul></div>'
                + '<div class="cbt-explanation" style="display:none;"></div>'
                + '</div>';
            lastSlug = (q.topic && q.topic.slug) || 'general';
        });

        /* ---- legend in the nav panel ---- */
        var legendHTML = '<div class="cbt-legend">'
            + '<div class="cbt-legend-item"><span class="cbt-legend-icon cbt-icon-not-visited" id="cbt-count-not-visited-' + cid + '">0</span> Not Visited</div>'
            + '<div class="cbt-legend-item"><span class="cbt-legend-icon cbt-icon-unanswered" id="cbt-count-unanswered-' + cid + '">0</span> Not Answered</div>'
            + '<div class="cbt-legend-item"><span class="cbt-legend-icon cbt-icon-answered" id="cbt-count-answered-' + cid + '">0</span> Answered</div>'
            + (isRevision ? '' :
                '<div class="cbt-legend-item"><span class="cbt-legend-icon cbt-icon-review" id="cbt-count-review-' + cid + '">0</span> Marked for Review</div>'
                + '<div class="cbt-legend-item" style="grid-column:span 2;"><span class="cbt-legend-icon cbt-icon-answered-review" id="cbt-count-answered-review-' + cid + '">0</span> Answered &amp; Marked for Review</div>')
            + '</div>';

        /* ---- bottom action bar ---- */
        var bottomLeft = isRevision ? '' :
            '<div class="cbt-bottom-left">'
            + '<button type="button" class="cbt-action-btn cbt-btn-review" data-cbt-action="review">Mark for Review</button>'
            + '<button type="button" class="cbt-action-btn cbt-btn-clear" data-cbt-action="clear">Clear Response</button>'
            + '</div>';
        var bottomRight = '<div class="cbt-bottom-right"' + (isRevision ? ' style="width:100%;justify-content:center;"' : '') + '>'
            + ((S.feedback_mode === 'instant')
                ? '<button type="button" class="cbt-action-btn cbt-btn-check" data-cbt-action="check" style="flex:1;max-width:250px;justify-content:center;">Check Answer</button>'
                : '')
            + '<button type="button" class="cbt-action-btn cbt-btn-save" data-cbt-action="save"' + (isRevision ? ' style="flex:1;max-width:250px;justify-content:center;"' : '') + '>'
            + (isRevision ? 'Next Question' : 'Save &amp; Next') + '</button>'
            + '</div>';

        var timerHTML = (S.timer > 0)
            ? '<div class="cbt-timer-container">Time Left: <span class="cbt-timer" id="cbt-timer-' + cid + '">--:--</span></div>'
            : '';

        var menuSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';

        /* ---- full markup ---- */
        return '<div id="aimcq-root-scope"><div class="cbt-exam-wrapper" id="cbt-wrap-' + cid + '">'

            /* START SCREEN */
            + '<div class="cbt-start-screen">'
            + '<div class="cbt-start-header"><h2>' + escAttr(S.title) + '</h2></div>'
            + '<div class="cbt-content-area">'
            + '<div class="cbt-lang-select-container"><label><strong>View Instructions In:</strong> </label>'
            + '<select class="cbt-lang-select" id="cbt-inst-lang-' + cid + '"><option value="en">English</option><option value="hi">\u0939\u093f\u0902\u0926\u0940</option></select></div>'
            + summaryHTML
            + '<div class="cbt-instructions-box">' + instEN + instHI + demoHTML + examDescHTML + '</div>'
            + '<div class="cbt-declaration"><label>'
            + '<input type="checkbox" id="cbt-agree-' + cid + '">'
            + '<span class="cbt-inst-en-i">I have read and understood all the instructions carefully. I am ready to begin the test.</span>'
            + '<span class="cbt-inst-hi-i" style="display:none;">\u092e\u0948\u0902\u0928\u0947 \u0938\u092d\u0940 \u0928\u093f\u0930\u094d\u0926\u0947\u0936\u094b\u0902 \u0915\u094b \u0927\u094d\u092f\u093e\u0928 \u0938\u0947 \u092a\u0922\u093c \u0914\u0930 \u0938\u092e\u091d \u0932\u093f\u092f\u093e \u0939\u0948\u0964 \u092e\u0948\u0902 \u092a\u0930\u0940\u0915\u094d\u0937\u093e \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u0924\u0948\u092f\u093e\u0930 \u0939\u0942\u0902\u0964</span>'
            + '</label></div>'
            + '<div class="cbt-action-bar"><button type="button" class="cbt-start-btn" id="cbt-start-btn-' + cid + '" disabled>I am ready to begin</button></div>'
            + '</div></div>'

            /* EXAM CONTAINER */
            + '<div class="cbt-exam-container">'
            + '<div class="cbt-top-bar"><h2>' + escAttr(S.title) + '</h2>' + timerHTML + '</div>'
            + '<div class="cbt-exam-layout">'
            + '<div class="cbt-nav-panel">'
            + legendHTML
            + sectionTabsHTML
            + '<h4>' + (hasSections ? 'Questions' : 'Section') + '</h4>'
            + '<div class="cbt-nav-grid">' + navGridHTML + '</div>'
            + '<button type="button" class="cbt-btn-submit-nav" data-cbt-action="submit">Submit Exam</button>'
            + '</div>'
            + '<div class="cbt-main-content"><form class="cbt-exam-form">' + qsHTML + '</form>'
            + '<div class="cbt-results" style="display:none;"></div></div>'
            + '</div>'
            + '<div class="cbt-bottom-bar" id="cbt-bottom-' + cid + '">' + bottomLeft + bottomRight + '</div>'
            + '<button type="button" class="cbt-nav-toggle-btn" aria-label="Toggle Question Navigation">' + menuSVG + '</button>'
            + '<div class="cbt-nav-overlay"></div>'
            + '</div>'

            /* MODAL */
            + '<div class="cbt-modal-overlay" id="cbt-modal-' + cid + '">'
            + '<div class="cbt-modal-dialog"><h3 class="cbt-modal-title"></h3><div class="cbt-modal-body"></div><div class="cbt-modal-buttons"></div></div>'
            + '</div>'

            + '</div></div>';
    }

    /* ================================================================
       ProExamRunner — drives the professional CBT interface.
       ================================================================ */
    function ProExamRunner(cid, S, qs, pdata, fp, helpers) {
        this.cid = cid;
        this.S = S;
        this.qs = qs;
        this.pdata = pdata || {};
        this._fp = fp || '';
        this.helpers = helpers || {};   /* { renderMath, renderChem } */
        this.total = qs.length;
        this.cur = 0;
        this.timerInt = null;
        this.isRevision = (S.feedback_mode === 'instant' && S.timer === 0);
        this.timeRem = S.timer > 0 ? S.timer * 60 : 0;
        this.states = qs.map(function () { return { visited: false, answered: false, review: false }; });
        this.selections = {};
        this.langs = qs.map(function (q) {
            return (q.en && q.en.content && q.en.content.trim() !== '') ? 'en' : 'hi';
        });
        this._finished = false;
        this._restoring = false;

        var root = document.getElementById('cbt-wrap-' + cid);
        this.root = root;
        this.startScreen = root.querySelector('.cbt-start-screen');
        this.startBtn = document.getElementById('cbt-start-btn-' + cid);
        this.agreeBox = document.getElementById('cbt-agree-' + cid);
        this.examContainer = root.querySelector('.cbt-exam-container');
        this.form = root.querySelector('.cbt-exam-form');
        this.resultsEl = root.querySelector('.cbt-results');
        this.qElems = root.querySelectorAll('.cbt-question');
        this.navPanel = root.querySelector('.cbt-nav-panel');
        this.navBtns = this.navPanel.querySelectorAll('.cbt-q-btn');
        this.navToggle = root.querySelector('.cbt-nav-toggle-btn');
        this.navOverlay = root.querySelector('.cbt-nav-overlay');
        this.modalEl = document.getElementById('cbt-modal-' + cid);
        this.mainContent = root.querySelector('.cbt-main-content');
        this.bottomBar = document.getElementById('cbt-bottom-' + cid);
    }

    ProExamRunner.prototype._sk = function () {
        return 'aimcq_cbt_state_' + this.cid + '_' + this._fp;
    };

    /* ---- math / chemistry rendering (delegated to engine helpers) ---- */
    ProExamRunner.prototype.renderMath = function (el) {
        if (this.helpers.renderMath) this.helpers.renderMath(el);
        else if (window.renderMathInElement) {
            window.renderMathInElement(el, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ]
            });
        }
    };
    ProExamRunner.prototype.renderChem = function (el) {
        if (this.helpers.renderChem) { this.helpers.renderChem(el); return; }
        if (typeof window.SmilesDrawer === 'undefined') return;
        var canvases = el.querySelectorAll('canvas[data-smiles]:not([data-drawn="true"])');
        canvases.forEach(function (c) {
            var sm = c.getAttribute('data-smiles');
            var w = parseInt(c.getAttribute('width') || 300, 10);
            var h = parseInt(c.getAttribute('height') || 200, 10);
            if (!c.hasAttribute('width')) c.width = w;
            if (!c.hasAttribute('height')) c.height = h;
            var dr = new window.SmilesDrawer.Drawer({ width: w, height: h });
            window.SmilesDrawer.parse(sm, function (tree) {
                dr.draw(tree, c, 'light', false);
                c.setAttribute('data-drawn', 'true');
            }, function (err) { if (window.console) console.log('SmilesDrawer:', err); });
        });
    };

    /* ---- session persistence ---- */
    ProExamRunner.prototype.saveState = function () {
        if (this._finished || this._restoring) return;
        try {
            var checked = [];
            this.qElems.forEach(function (q) { checked.push(q.dataset.checked === 'true'); });
            var obj = {
                cbt: true,
                cur: this.cur,
                timeRem: this.timeRem,
                states: this.states,
                selections: this.selections,
                langs: this.langs,
                checkedFlags: checked,
                questionIds: this.qs.map(function (q) { return q.id; }),
                feedbackMode: this.S.feedback_mode,
                displayMode: this.S.display_mode,
                timer: this.S.timer,
                fingerprint: this._fp,
                ts: Date.now()
            };
            localStorage.setItem(this._sk(), JSON.stringify(obj));
        } catch (e) { /* storage unavailable */ }
    };
    ProExamRunner.prototype.clearState = function () {
        try { localStorage.removeItem(this._sk()); } catch (e) {}
    };
    ProExamRunner.loadSaved = function (cid, fp) {
        try {
            var raw = localStorage.getItem('aimcq_cbt_state_' + cid + '_' + fp);
            if (!raw) return null;
            var o = JSON.parse(raw);
            return o && o.cbt ? o : null;
        } catch (e) { return null; }
    };

    /* ---- init: wire start-screen events, detect a saved session ---- */
    ProExamRunner.prototype.init = function () {
        var self = this;

        var langSel = document.getElementById('cbt-inst-lang-' + this.cid);
        if (langSel) {
            langSel.addEventListener('change', function (e) {
                var lang = e.target.value;
                self.root.querySelectorAll('.cbt-inst-en').forEach(function (el) { el.style.display = lang === 'en' ? 'block' : 'none'; });
                self.root.querySelectorAll('.cbt-inst-hi').forEach(function (el) { el.style.display = lang === 'hi' ? 'block' : 'none'; });
                self.root.querySelectorAll('.cbt-inst-en-i').forEach(function (el) { el.style.display = lang === 'en' ? 'inline' : 'none'; });
                self.root.querySelectorAll('.cbt-inst-hi-i').forEach(function (el) { el.style.display = lang === 'hi' ? 'inline' : 'none'; });
                if (self.startBtn && !self.hasSaved) {
                    self.startBtn.textContent = lang === 'en' ? 'I am ready to begin' : '\u092e\u0948\u0902 \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u0924\u0948\u092f\u093e\u0930 \u0939\u0942\u0902';
                } else if (self.startBtn && self.hasSaved) {
                    self.startBtn.textContent = lang === 'en'
                        ? (self.isRevision ? 'Resume Practice' : 'Resume Test')
                        : (self.isRevision ? '\u0905\u092d\u094d\u092f\u093e\u0938 \u092b\u093f\u0930 \u0938\u0947 \u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902' : '\u092a\u0930\u0940\u0915\u094d\u0937\u093e \u092b\u093f\u0930 \u0938\u0947 \u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902');
                }
            });
        }

        if (this.agreeBox && this.startBtn) {
            this.agreeBox.addEventListener('change', function (e) {
                self.startBtn.disabled = !e.target.checked;
            });
        }
        if (this.startBtn) {
            this.startBtn.addEventListener('click', function () { self.startExam(); });
        }
        if (this.navToggle) this.navToggle.addEventListener('click', function () { self.toggleNav(); });
        if (this.navOverlay) this.navOverlay.addEventListener('click', function () { self.toggleNav(false); });

        /* security: block right-click within the exam */
        this.root.addEventListener('contextmenu', function (e) {
            if (self.root.classList.contains('exam-active')) e.preventDefault();
        });

        /* detect saved session */
        this.hasSaved = this.loadState();
        if (this.hasSaved && this.startBtn) {
            this.startBtn.textContent = this.isRevision ? 'Resume Practice' : 'Resume Test';
            this.startBtn.disabled = false;
            if (this.agreeBox) this.agreeBox.checked = true;
            var notice = document.createElement('p');
            notice.className = 'cbt-resume-notice';
            notice.textContent = this.isRevision
                ? 'You have not completed this revision yet.'
                : 'You have not completed this test yet.';
            this.startBtn.parentNode.insertBefore(notice, this.startBtn);
        }
    };

    ProExamRunner.prototype.loadState = function () {
        var saved = ProExamRunner.loadSaved(this.cid, this._fp);
        if (!saved) return false;
        /* validate question set matches */
        var savedIds = (saved.questionIds || []).slice().sort().join(',');
        var curIds = this.qs.map(function (q) { return q.id; }).slice().sort().join(',');
        if (savedIds !== curIds) { this.clearState(); return false; }
        this._savedState = saved;
        this.timeRem = saved.timeRem != null ? saved.timeRem : this.timeRem;
        this.cur = (saved.cur >= 0 && saved.cur < this.total) ? saved.cur : 0;
        this.states = saved.states || this.states;
        this.selections = saved.selections || {};
        if (saved.langs) this.langs = saved.langs;
        return true;
    };

    ProExamRunner.prototype.toggleNav = function (force) {
        var open = (force === undefined) ? !this.root.classList.contains('nav-panel-open') : force;
        this.root.classList.toggle('nav-panel-open', open);
    };

    /* ---- start / resume the exam ---- */
    ProExamRunner.prototype.startExam = function () {
        var self = this;
        /* ---- Blogger / themed-template fullscreen fix ----
         * Blogger (and many CMS themes) apply CSS transforms, filters, or
         * will-change on ancestor elements (.post-body, column wrappers, etc.).
         * Any such property creates a new containing block, breaking
         * position:fixed — the overlay attaches to that ancestor instead of
         * the viewport.  Fix: physically move the wrapper to <body> before
         * activating fullscreen, then restore it when the exam finishes.
         * -------------------------------------------------- */
        this._examOriginalParent      = this.root.parentNode;
        this._examOriginalNextSibling = this.root.nextSibling;
        document.body.appendChild(this.root);

        document.body.classList.add('aimcq-cbt-fullscreen');
        this.root.classList.add('exam-active');
        this.startScreen.style.display = 'none';

        if (this.S.shuffle_options && !this.hasSaved) this.shuffleOptions();
        if (this.hasSaved) this.restoreDOM();

        if (this.S.timer > 0) this.startTimer();
        this.setupEvents();
        this.renderMath(this.examContainer);
        this.renderChem(this.examContainer);

        this.states[this.cur].visited = true;
        this.jumpTo(this.cur);
    };

    ProExamRunner.prototype.shuffleOptions = function () {
        this.qElems.forEach(function (qEl) {
            var ul = qEl.querySelector('.cbt-options ul');
            if (!ul) return;
            var items = Array.prototype.slice.call(ul.children);
            for (var i = items.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var t = items[i]; items[i] = items[j]; items[j] = t;
            }
            items.forEach(function (it, idx) {
                var lt = it.querySelector('.cbt-opt-letter');
                if (lt) lt.textContent = OPT_LETTERS[idx] || (idx + 1);
                ul.appendChild(it);
            });
        });
    };

    ProExamRunner.prototype.restoreDOM = function () {
        var self = this;
        this._restoring = true;
        this.qElems.forEach(function (qEl, idx) {
            var qd = self.qs[idx];
            /* restore language */
            var lang = self.langs[idx];
            var def = (qd.en && qd.en.content && qd.en.content.trim() !== '') ? 'en' : 'hi';
            if (lang && lang !== def) {
                self.langs[idx] = def;
                self.switchLang(idx, lang, true);
            }
            /* restore selections */
            var sel = self.selections[idx];
            if (sel && sel.length) {
                sel.forEach(function (v) {
                    var inp = qEl.querySelector('input[value="' + v + '"]');
                    if (inp) { inp.checked = true; inp.parentElement.classList.add('selected'); }
                });
            }
            /* restore instant-mode checked questions */
            var checkedFlags = (self._savedState && self._savedState.checkedFlags) || [];
            if (self.S.feedback_mode === 'instant' && checkedFlags[idx]) {
                qEl.dataset.checked = 'true';
                self.evalQ(qEl, qd, true);
                if (self.S.show_explanation) {
                    var exp = qd[self.langs[idx]].explanation;
                    var expDiv = qEl.querySelector('.cbt-explanation');
                    if (exp && expDiv) {
                        expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                        expDiv.style.display = 'block';
                        self.renderMath(expDiv);
                        self.renderChem(expDiv);
                    }
                }
            }
        });
        this._restoring = false;
    };

    /* ---- event wiring for the running exam ---- */
    ProExamRunner.prototype.setupEvents = function () {
        var self = this;

        /* section tabs */
        var secTabs = this.navPanel.querySelectorAll('.cbt-section-tab');
        if (secTabs.length) {
            this.navPanel.addEventListener('click', function (e) {
                var tab = e.target.closest('.cbt-section-tab');
                if (!tab) return;
                secTabs.forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var target = tab.dataset.sectionTarget;
                self.navBtns.forEach(function (b) {
                    b.style.display = (target === 'all' || b.dataset.section === target) ? 'flex' : 'none';
                });
            });
        }

        /* palette navigation */
        this.navPanel.addEventListener('click', function (e) {
            var btn = e.target.closest('.cbt-q-btn');
            if (!btn) return;
            var qi = parseInt(btn.dataset.qIndex, 10);
            if (self.form.dataset.finished === 'true') {
                var tq = self.qElems[qi];
                if (tq && self.mainContent) {
                    self.mainContent.scrollTo({ top: tq.offsetTop - 20, behavior: 'smooth' });
                    if (window.innerWidth < 992) self.toggleNav(false);
                    var orig = tq.style.backgroundColor;
                    tq.style.transition = 'background-color 0.8s ease';
                    tq.style.backgroundColor = 'var(--aq-info-light)';
                    setTimeout(function () { tq.style.backgroundColor = orig; }, 1200);
                }
            } else {
                self.jumpTo(qi);
            }
        });

        /* bottom-bar + submit actions */
        var actionHandler = function (e) {
            var btn = e.target.closest('[data-cbt-action]');
            if (!btn) return;
            var action = btn.dataset.cbtAction;
            if (action === 'save') {
                self.saveState();
                if (self.cur < self.total - 1) {
                    self.jumpTo(self.cur + 1);
                } else {
                    self.updateNav();
                    if (self.isRevision) {
                        self.finishExam();
                    } else {
                        self.showModal('Confirm Submission',
                            'You have reached the end of the exam. Are you sure you want to submit?',
                            [{ text: 'Yes, Submit Exam', cls: 'cbt-modal-confirm', fn: function () { self.finishExam(); } },
                             { text: 'Cancel', cls: 'cbt-modal-cancel', fn: function () { self.hideModal(); } }]);
                    }
                }
            } else if (action === 'review') {
                self.states[self.cur].review = !self.states[self.cur].review;
                self.saveState();
                self.updateNav();
                btn.textContent = self.states[self.cur].review ? 'Unmark Review' : 'Mark for Review';
            } else if (action === 'clear') {
                self.clearQ(self.cur);
            } else if (action === 'check') {
                self.checkInstant();
            } else if (action === 'submit') {
                self.showModal('Confirm Submission',
                    'Are you sure you want to finish and submit the exam?',
                    [{ text: 'Yes, Submit Exam', cls: 'cbt-modal-confirm', fn: function () { self.finishExam(); } },
                     { text: 'Cancel', cls: 'cbt-modal-cancel', fn: function () { self.hideModal(); } }]);
            }
        };
        this.bottomBar.addEventListener('click', actionHandler);
        this.navPanel.addEventListener('click', actionHandler);

        /* answer selection */
        this.form.addEventListener('change', function (e) {
            var qEl = e.target.closest('.cbt-question');
            if (!qEl || !e.target.name || e.target.name.indexOf('cbtq_') !== 0) return;
            var qi = parseInt(qEl.dataset.questionIndex, 10);
            qEl.querySelectorAll('.cbt-options label').forEach(function (l) { l.classList.remove('selected'); });
            var checked = qEl.querySelectorAll('input[name="' + e.target.name + '"]:checked');
            checked.forEach(function (i) { i.parentElement.classList.add('selected'); });
            self.states[qi].answered = checked.length > 0;
            self.selections[qi] = Array.prototype.slice.call(checked).map(function (i) { return i.value; });
            self.updateNav();
            self.saveState();
        });

        /* language switch */
        this.form.addEventListener('click', function (e) {
            if (e.target.classList.contains('cbt-lang-btn')) {
                var qEl = e.target.closest('.cbt-question');
                self.switchLang(parseInt(qEl.dataset.questionIndex, 10), e.target.dataset.lang);
            }
        });
    };

    /* ---- timer ---- */
    ProExamRunner.prototype.startTimer = function () {
        var self = this;
        var el = document.getElementById('cbt-timer-' + this.cid);
        if (!el) return;
        function paint() {
            var m = Math.floor(self.timeRem / 60), s = self.timeRem % 60;
            el.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        }
        paint();
        this.timerInt = setInterval(function () {
            if (self.timeRem > 0) self.timeRem--;
            paint();
            if (self.timeRem % 5 === 0) self.saveState();
            if (self.timeRem <= 0) {
                clearInterval(self.timerInt);
                self.showModal("Time's Up!",
                    'Your time has expired. The exam will now be submitted automatically.',
                    [{ text: 'OK', cls: 'cbt-modal-confirm', fn: function () { self.finishExam(); } }]);
            }
        }, 1000);
    };

    /* ---- navigate to a question ---- */
    ProExamRunner.prototype.jumpTo = function (idx) {
        if (idx < 0 || idx >= this.total) return;
        if (this.qElems[this.cur]) this.qElems[this.cur].classList.add('hidden');
        this.cur = idx;
        this.states[idx].visited = true;
        var qEl = this.qElems[idx];
        var qd = this.qs[idx];
        qEl.classList.remove('hidden');
        var isLast = (idx === this.total - 1);
        var isChecked = qEl.dataset.checked === 'true';

        /* auto-switch section tab */
        var secTabs = this.navPanel.querySelectorAll('.cbt-section-tab');
        if (secTabs.length) {
            var slug = (qd.topic && qd.topic.slug) || 'general';
            var active = Array.prototype.slice.call(secTabs).find(function (t) { return t.classList.contains('active'); });
            if (active && active.dataset.sectionTarget !== 'all' && active.dataset.sectionTarget !== slug) {
                var tgt = Array.prototype.slice.call(secTabs).find(function (t) { return t.dataset.sectionTarget === slug; });
                if (tgt) tgt.click();
            }
        }

        /* bottom-bar button states */
        var checkBtn = this.bottomBar.querySelector('[data-cbt-action="check"]');
        if (checkBtn) checkBtn.style.display = isChecked ? 'none' : '';
        var saveBtn = this.bottomBar.querySelector('[data-cbt-action="save"]');
        if (saveBtn) {
            if (this.isRevision) {
                saveBtn.innerHTML = isLast ? 'Finish Revision' : 'Next Question';
                saveBtn.style.display = isChecked ? '' : 'none';
            } else {
                saveBtn.innerHTML = isLast ? 'Save &amp; Submit' : 'Save &amp; Next';
                saveBtn.style.display = '';
            }
        }
        var reviewBtn = this.bottomBar.querySelector('[data-cbt-action="review"]');
        if (reviewBtn) reviewBtn.textContent = this.states[idx].review ? 'Unmark Review' : 'Mark for Review';

        this.updateNav();

        /* passage display */
        this.root.querySelectorAll('.cbt-passage-display').forEach(function (p) { p.style.display = 'none'; });
        if (qd.is_passage_question && qd.passage_id) {
            var box = document.getElementById('cbt-passage-' + this.cid + '-' + qd.passage_id);
            if (box) {
                box.style.display = 'block';
                this._syncPassageLang(box, this.langs[idx]);
            }
        }

        if (window.innerWidth < 992) this.toggleNav(false);
        if (this.mainContent) this.mainContent.scrollTo({ top: 0, behavior: 'smooth' });
        this.saveState();
    };

    ProExamRunner.prototype._syncPassageLang = function (box, lang) {
        var isHi = lang === 'hi';
        var et = box.querySelector('.cbt-passage-title-en');
        var ht = box.querySelector('.cbt-passage-title-hi');
        var ec = box.querySelector('.cbt-passage-content-en');
        var hc = box.querySelector('.cbt-passage-content-hi');
        if (et) et.style.display = isHi ? 'none' : 'block';
        if (ht) ht.style.display = isHi ? 'block' : 'none';
        if (ec) ec.style.display = isHi ? 'none' : 'block';
        if (hc) hc.style.display = isHi ? 'block' : 'none';
        this.renderMath(box);
        this.renderChem(box);
    };

    /* ---- check answer (instant feedback / revision) ---- */
    ProExamRunner.prototype.checkInstant = function () {
        var qEl = this.qElems[this.cur];
        var qd = this.qs[this.cur];
        this.evalQ(qEl, qd, true);
        if (this.S.show_explanation) {
            var exp = qd[this.langs[this.cur]].explanation;
            var expDiv = qEl.querySelector('.cbt-explanation');
            if (exp && expDiv) {
                expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                expDiv.style.display = 'block';
                this.renderMath(expDiv);
                this.renderChem(expDiv);
            }
        }
        qEl.dataset.checked = 'true';
        this.states[this.cur].answered = (this.selections[this.cur] || []).length > 0;
        var checkBtn = this.bottomBar.querySelector('[data-cbt-action="check"]');
        if (checkBtn) checkBtn.style.display = 'none';
        var saveBtn = this.bottomBar.querySelector('[data-cbt-action="save"]');
        if (saveBtn && this.isRevision) saveBtn.style.display = '';
        this.updateNav();
        this.saveState();
    };

    /* ---- clear a question's selection ---- */
    ProExamRunner.prototype.clearQ = function (qi) {
        var qEl = this.qElems[qi];
        if (!qEl) return;
        qEl.querySelectorAll('input:checked').forEach(function (i) { i.checked = false; });
        qEl.querySelectorAll('.cbt-options label').forEach(function (l) { l.classList.remove('selected'); });
        this.states[qi].answered = false;
        delete this.selections[qi];
        this.updateNav();
        this.saveState();
    };

    /* ---- language switch (rebuilds options) ---- */
    ProExamRunner.prototype.switchLang = function (qi, lang, skipSave) {
        if (this.langs[qi] === lang) return;
        this.langs[qi] = lang;
        var qEl = this.qElems[qi];
        var qd = this.qs[qi];
        var ld = qd[lang];
        var isMulti = qd.correct.length > 1;
        var imgStyle = 'width:' + (qd.image_width > 0 ? qd.image_width + 'px' : 'auto')
            + ';height:' + (qd.image_height > 0 ? qd.image_height + 'px;object-fit:cover;' : 'auto') + ';';

        qEl.querySelectorAll('.cbt-lang-btn').forEach(function (b) { b.classList.remove('active'); });
        var ab = qEl.querySelector('.cbt-lang-btn[data-lang="' + lang + '"]');
        if (ab) ab.classList.add('active');

        qEl.querySelector('.cbt-question-body').innerHTML = ld.content;

        var ul = qEl.querySelector('.cbt-options ul');
        var selVals = Array.prototype.slice.call(ul.querySelectorAll('input:checked')).map(function (i) { return i.value; });
        ul.innerHTML = '';
        var enOpts = qd.en ? qd.en.options : [];
        ld.options.forEach(function (opt, oi) {
            var li = document.createElement('li');
            var label = document.createElement('label');
            var inp = document.createElement('input');
            inp.type = isMulti ? 'checkbox' : 'radio';
            inp.name = 'cbtq_' + qd.id + '[]';
            inp.value = oi;
            if (selVals.indexOf(String(oi)) !== -1) { inp.checked = true; label.classList.add('selected'); }
            label.appendChild(inp);
            var inner = document.createElement('div');
            inner.className = 'cbt-opt-inner';
            var lt = document.createElement('span');
            lt.className = 'cbt-opt-letter';
            lt.textContent = OPT_LETTERS[oi] || (oi + 1);
            inner.appendChild(lt);
            var img = opt.image || (enOpts[oi] ? enOpts[oi].image : '');
            if (img) {
                var im = document.createElement('img');
                im.src = img; im.className = 'cbt-opt-img'; im.style.cssText = imgStyle; im.alt = '';
                inner.appendChild(im);
            }
            var tx = document.createElement('div');
            tx.className = 'cbt-opt-text';
            tx.innerHTML = opt.text;
            inner.appendChild(tx);
            label.appendChild(inner);
            li.appendChild(label);
            ul.appendChild(li);
        });

        if (this.form.dataset.finished === 'true'
            || (this.S.feedback_mode === 'instant' && qEl.dataset.checked === 'true')) {
            this.evalQ(qEl, qd, true);
            var expDiv = qEl.querySelector('.cbt-explanation');
            if (expDiv && expDiv.style.display !== 'none') {
                expDiv.innerHTML = '<strong>Explanation:</strong> ' + ld.explanation;
            }
        }

        if (qd.is_passage_question && qd.passage_id) {
            var box = document.getElementById('cbt-passage-' + this.cid + '-' + qd.passage_id);
            if (box) this._syncPassageLang(box, lang);
        }
        this.renderMath(qEl);
        this.renderChem(qEl);
        if (!skipSave) this.saveState();
    };

    /* ---- update palette colours + counters ---- */
    ProExamRunner.prototype.updateNav = function () {
        var self = this;
        this.navBtns.forEach(function (btn, idx) {
            var st = self.states[idx];
            var disp = btn.style.display;
            btn.className = 'cbt-q-btn';
            if (st.review && st.answered) btn.classList.add('q-answered-review');
            else if (st.review) btn.classList.add('q-review');
            else if (st.answered) btn.classList.add('q-answered');
            else if (st.visited) btn.classList.add('q-unanswered');
            else btn.classList.add('q-not-visited');
            if (idx === self.cur) btn.classList.add('q-current');
            btn.style.display = disp;
        });
        var c = { nv: 0, un: 0, an: 0, rv: 0, ar: 0 };
        this.states.forEach(function (s) {
            if (!s.visited) c.nv++;
            else if (s.review && s.answered) c.ar++;
            else if (s.review) c.rv++;
            else if (s.answered) c.an++;
            else c.un++;
        });
        function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
        set('cbt-count-not-visited-' + this.cid, c.nv);
        set('cbt-count-unanswered-' + this.cid, c.un);
        set('cbt-count-answered-' + this.cid, c.an);
        set('cbt-count-review-' + this.cid, c.rv);
        set('cbt-count-answered-review-' + this.cid, c.ar);
    };

    /* ---- evaluate one question (mark correct / incorrect / missed) ---- */
    ProExamRunner.prototype.evalQ = function (qEl, qd, disable) {
        var correct = (qd.correct || []).map(String);
        var qi = parseInt(qEl.dataset.questionIndex, 10);
        var sel = this.selections[qi] || [];
        var isOk = sel.length > 0 && sel.length === correct.length
            && sel.every(function (v) { return correct.indexOf(v) !== -1; });
        qEl.querySelectorAll('.cbt-options label').forEach(function (label) {
            var inp = label.querySelector('input');
            label.classList.remove('correct', 'incorrect', 'missed', 'selected');
            if (correct.indexOf(inp.value) !== -1) {
                if (sel.indexOf(inp.value) !== -1) label.classList.add('correct');
                else label.classList.add('missed');
            } else if (sel.indexOf(inp.value) !== -1) {
                label.classList.add('incorrect');
            }
            if (disable) { inp.disabled = true; label.classList.add('disabled'); }
        });
        return isOk;
    };

    /* ---- modal ---- */
    ProExamRunner.prototype.showModal = function (title, body, btns) {
        this.hideModal();
        this.modalEl.querySelector('.cbt-modal-title').textContent = title;
        this.modalEl.querySelector('.cbt-modal-body').innerHTML = body;
        var bc = this.modalEl.querySelector('.cbt-modal-buttons');
        btns.forEach(function (bi) {
            var b = document.createElement('button');
            b.textContent = bi.text;
            b.className = bi.cls;
            b.addEventListener('click', bi.fn, { once: true });
            bc.appendChild(b);
        });
        this.modalEl.style.display = 'flex';
    };
    ProExamRunner.prototype.hideModal = function () {
        this.modalEl.style.display = 'none';
        this.modalEl.querySelector('.cbt-modal-buttons').innerHTML = '';
    };

    /* ---- finish + results ---- */
    ProExamRunner.prototype.finishExam = function () {
        var self = this;
        this._finished = true;
        if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; }
        this.clearState();
        this.hideModal();
        if (window.innerWidth < 992) this.toggleNav(false);
        this.form.dataset.finished = 'true';

        if (this.navToggle) this.navToggle.style.display = 'none';
        if (this.bottomBar) this.bottomBar.style.display = 'none';
        var submitNav = this.navPanel.querySelector('[data-cbt-action="submit"]');
        if (submitNav) submitNav.style.display = 'none';

        var marks = (this.S.marks_per_question != null) ? Number(this.S.marks_per_question) : 1;
        var neg = (this.S.negative_marks != null) ? Number(this.S.negative_marks) : 0;
        if (isNaN(marks)) marks = 1;
        if (isNaN(neg)) neg = 0;

        /* per-topic stats */
        var topicStats = {}, topicOrder = [];
        function bump(qd, field) {
            var t = qd.topic || { slug: 'general', name: 'General' };
            if (!topicStats[t.slug]) {
                topicStats[t.slug] = { name: t.name || t.slug, total: 0, correct: 0, wrong: 0, attempted: 0 };
                topicOrder.push(t.slug);
            }
            topicStats[t.slug][field]++;
        }
        this.qs.forEach(function (q) { bump(q, 'total'); });

        if (this.S.feedback_mode !== 'instant') {
            this.qElems.forEach(function (qEl, idx) {
                var qd = self.qs[idx];
                var sel = self.selections[idx] || [];
                var isOk = self.evalQ(qEl, qd, true);
                if (sel.length > 0) {
                    bump(qd, 'attempted');
                    if (isOk) bump(qd, 'correct'); else bump(qd, 'wrong');
                }
                if (self.S.show_explanation) {
                    var exp = qd[self.langs[idx]].explanation;
                    var expDiv = qEl.querySelector('.cbt-explanation');
                    if (exp && expDiv) {
                        expDiv.innerHTML = '<strong>Explanation:</strong> ' + exp;
                        expDiv.style.display = 'block';
                        self.renderMath(expDiv);
                        self.renderChem(expDiv);
                    }
                }
            });
        } else {
            this.qElems.forEach(function (qEl, idx) {
                var sel = self.selections[idx] || [];
                if (sel.length > 0) {
                    var qd = self.qs[idx];
                    bump(qd, 'attempted');
                    var correct = (qd.correct || []).map(String);
                    var isOk = sel.length === correct.length && sel.every(function (v) { return correct.indexOf(v) !== -1; });
                    if (isOk) bump(qd, 'correct'); else bump(qd, 'wrong');
                }
            });
        }

        /* reveal all questions + passage boxes */
        this.qElems.forEach(function (q) { q.classList.remove('hidden'); });
        this.root.querySelectorAll('.cbt-passage-display').forEach(function (p) { p.style.display = 'block'; });

        /* tally totals */
        var totalCorrect = 0, totalWrong = 0, totalAttempted = 0;
        topicOrder.forEach(function (slug) {
            var s = topicStats[slug];
            totalCorrect += s.correct; totalWrong += s.wrong; totalAttempted += s.attempted;
        });

        if (this.isRevision) {
            var reviewed = Array.prototype.slice.call(this.qElems).filter(function (q) { return q.dataset.checked === 'true'; }).length;
            var msg = reviewed === this.total
                ? 'You have reviewed all <strong>' + this.total + '</strong> questions.'
                : 'You have reviewed only <strong>' + reviewed + '</strong> ' + (reviewed === 1 ? 'question' : 'questions') + '.';
            this.resultsEl.innerHTML = '<h3 class="cbt-results-title">Revision Completed!</h3><p>' + msg + '</p>';
            this.resultsEl.className = 'cbt-results pass';
        } else {
            var maxMarks = Math.round(this.total * marks * 100) / 100;
            var obtained = Math.round((totalCorrect * marks - totalWrong * neg) * 100) / 100;
            var pct = maxMarks > 0 ? Math.round((obtained / maxMarks) * 10000) / 100 : 0;
            var fPct = Number.isInteger(pct) ? pct : pct.toFixed(2);
            var fObt = Number.isInteger(obtained) ? obtained : obtained.toFixed(2);
            var fMax = Number.isInteger(maxMarks) ? maxMarks : maxMarks.toFixed(2);
            var pctColor = pct >= 50 ? 'var(--aq-success)' : 'var(--aq-danger)';

            var breakdown = '';
            if (topicOrder.length >= 2) {
                var rows = topicOrder.map(function (slug) {
                    var s = topicStats[slug];
                    var tp = s.total > 0 ? Math.round(s.correct / s.total * 100) : 0;
                    var bc = tp >= 50 ? 'var(--aq-success)' : 'var(--aq-danger)';
                    return '<div class="cbt-breakdown-row">'
                        + '<div class="cbt-breakdown-name">' + escAttr(s.name) + '</div>'
                        + '<div class="cbt-breakdown-stats">' + s.correct + ' / ' + s.total + '</div>'
                        + '<div class="cbt-breakdown-bar"><span style="width:' + tp + '%;background:' + bc + ';"></span></div>'
                        + '<div class="cbt-breakdown-pct" style="color:' + bc + ';">' + tp + '%</div>'
                        + '</div>';
                }).join('');
                breakdown = '<div class="cbt-breakdown"><h4>Sectional Breakdown</h4>' + rows + '</div>';
            }

            this.resultsEl.innerHTML =
                '<h3 class="cbt-results-title">Exam Finished!</h3>'
                + '<table class="cbt-results-table"><tbody>'
                + '<tr><th>Total Questions</th><td>' + this.total + '</td></tr>'
                + '<tr><th>Attempted</th><td>' + totalAttempted + '</td></tr>'
                + '<tr><th>Correct Answers</th><td style="color:var(--aq-success);">' + totalCorrect + '</td></tr>'
                + '<tr><th>Wrong Answers</th><td style="color:var(--aq-danger);">' + totalWrong + '</td></tr>'
                + '<tr class="cbt-highlight-row"><th>Max Marks</th><td>' + fMax + '</td></tr>'
                + '<tr class="cbt-highlight-row"><th>Obtained Marks</th><td style="color:var(--aq-primary);font-size:1.2rem;">' + fObt + '</td></tr>'
                + '<tr class="cbt-highlight-row" style="font-size:1.3rem;color:' + pctColor + ';"><th>Percentage</th><td>' + fPct + '%</td></tr>'
                + '</tbody></table>' + breakdown;
            this.resultsEl.className = 'cbt-results ' + (pct >= 50 ? 'pass' : 'fail');
        }

        /* ---- Blogger fullscreen fix: exit fullscreen + restore DOM position ---- */
        document.body.classList.remove('aimcq-cbt-fullscreen');
        this.root.classList.remove('exam-active');
        /* Move wrapper back to its original location in the post */
        if (this._examOriginalParent) {
            if (this._examOriginalNextSibling) {
                this._examOriginalParent.insertBefore(this.root, this._examOriginalNextSibling);
            } else {
                this._examOriginalParent.appendChild(this.root);
            }
            this._examOriginalParent      = null;
            this._examOriginalNextSibling = null;
        }

        this.resultsEl.style.display = 'block';
        if (this.mainContent) {
            this.mainContent.scrollTo({ top: this.resultsEl.offsetTop - 20, behavior: 'smooth' });
        }
        this.renderMath(this.form);
        this.renderChem(this.form);
    };

    /* ================================================================
       PUBLIC ENTRY POINT
       ----------------------------------------------------------------
       Called by initAimcqQuiz when S.exam_interface === 'professional'.
         containerId : DOM id of the quiz container
         S           : merged settings object
         qs          : prepared question array (post shuffle/limit)
         pdata       : passage data map
         fp          : quiz fingerprint
         helpers     : { renderMath, renderChem } from the engine
       ================================================================ */
    function mount(containerId, S, qs, pdata, fp, helpers) {
        var container = document.getElementById(containerId);
        if (!container || !qs || qs.length === 0) return null;
        container.innerHTML = buildHTML(containerId, S, qs, pdata);
        var runner = new ProExamRunner(containerId, S, qs, pdata, fp, helpers);
        runner.init();
        return runner;
    }

    return {
        mount: mount,
        ProExamRunner: ProExamRunner,
        hasSavedSession: function (cid, fp) { return !!ProExamRunner.loadSaved(cid, fp); }
    };
})();
