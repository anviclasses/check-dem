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

        // ---- EXAM INTERFACE EXECUTION SETTING --------------------------------
        // Chooses which exam UI is used when the quiz actually runs.
        //   'basic'        → the original lightweight in-page quiz interface
        //                    (start panel + scoped layout, NOT full-screen).
        //   'professional' → the SSC-style full-screen "Computer Based Test"
        //                    interface ported from the AI MCQs Exam Maker
        //                    plugin: fullscreen overlay, question palette,
        //                    section tabs, instructions screen, declaration
        //                    checkbox, top timer bar and bottom action bar.
        // Works identically for all three embedding methods (inline JSON,
        // single remote JSON, merged multi-file).
        exam_interface: 'basic',

        // ---- Professional-interface scoring (only used when
        //      exam_interface === 'professional' and NOT in revision mode) ----
        marks_per_question: 1,     // marks awarded per correct answer
        negative_marks: 0          // marks deducted per wrong answer (0 = none)
    };

    var S = Object.assign({}, defaultSettings, customSettings);
    var OPT_LETTERS = ['A','B','C','D','E','F','G','H'];

    // Normalize exam_interface: tolerate case / stray whitespace so that
    // 'Professional', ' professional ', 'PROFESSIONAL' all work. Anything
    // that is not recognizably 'professional' falls back to 'basic'.
    S.exam_interface = (String(S.exam_interface || 'basic')
        .trim().toLowerCase() === 'professional') ? 'professional' : 'basic';

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

        /* ================================================================
           PROFESSIONAL EXAM INTERFACE BRANCH
           ----------------------------------------------------------------
           When the website passes  exam_interface: 'professional'  in its
           settings, the quiz runs inside the SSC-style full-screen CBT
           interface instead of the basic in-page one. This branch:
             1. Renders a lightweight mode-picker (Quiz Mode / Revision Mode)
                using the SAME start panel markup as the basic interface, so
                websites get a consistent "choose your mode" experience.
             2. On mode selection, prepares the question set for that mode
                and hands it to window.initAimcqProExam(), which paints the
                full professional CBT UI (start screen → exam → results).
           This applies uniformly to all three embedding methods because
           loadAimcqFromDrive() funnels through initAimcqQuiz().
           ================================================================ */
        if (S.exam_interface === 'professional') {

            if (typeof window.initAimcqProExam !== 'function') {
                // The pro module lives at the bottom of THIS same file, so a
                // missing initAimcqProExam almost always means a stale/cached
                // aimcq.js, a truncated upload, or two different versions of
                // the engine loaded on the page. Fail loudly instead of
                // silently dropping the website owner into the basic UI.
                console.error('[aimcq] exam_interface is "professional" but '
                    + 'window.initAimcqProExam is undefined. This usually means '
                    + 'aimcq.js is an outdated or truncated copy. Re-upload the '
                    + 'latest aimcq.js (and bump the CDN version tag).');
                container.innerHTML = '<div id="aimcq-root-scope">'
                    + '<div class="aq-wrapper" style="padding:24px;border:1px solid #e0b4b4;'
                    + 'background:#fff6f6;color:#9f3a38;border-radius:8px;font:14px/1.5 sans-serif;">'
                    + '<strong>Professional exam interface could not load.</strong><br>'
                    + 'The engine file (aimcq.js) appears to be outdated. Please update '
                    + 'aimcq.js to the latest version and refresh the page.'
                    + '</div></div>';
                return;
            }

            var launchPro = function(mode) {
                // Revision mode mirrors the basic engine: instant feedback,
                // single-question display, no timer. initAimcqProExam reads
                // these to decide exam_type === 'revision'.
                var proS = Object.assign({}, S);
                if (mode === 'revision') {
                    proS.feedback_mode = 'instant';
                    proS.display_mode  = 'single';
                    proS.timer         = 0;
                }
                try {
                    var activeQs = prepareQuestions(mode);
                    // initAimcqProExam fully repaints `container` with the pro UI.
                    window.initAimcqProExam(containerId, proS, activeQs, passageData, _quizFingerprint);
                } catch (err) {
                    console.error('[aimcq] Failed to launch professional exam:', err);
                    container.innerHTML = '<div id="aimcq-root-scope">'
                        + '<div class="aq-wrapper" style="padding:24px;border:1px solid #e0b4b4;'
                        + 'background:#fff6f6;color:#9f3a38;border-radius:8px;font:14px/1.5 sans-serif;">'
                        + '<strong>The exam could not start.</strong><br>'
                        + 'Please reload the page and try again.'
                        + '</div></div>';
                }
            };

            var proStartBtns = document.querySelectorAll('#aq-start-' + containerId + ' .aq-start-btn');
            if (proStartBtns.length) {
                proStartBtns.forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        launchPro(this.dataset.mode === 'revision' ? 'revision' : 'exam');
                    });
                });
            } else {
                // Defensive fallback: if the mode-picker start screen was not
                // rendered for any reason, launch the exam directly so the
                // professional interface still appears rather than nothing.
                console.warn('[aimcq] Mode-picker start screen not found; '
                    + 'launching professional exam directly.');
                launchPro('exam');
            }
            // Professional interface manages its own session persistence
            // (localStorage) inside initAimcqProExam — nothing more to wire here.
            return;
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
   PROFESSIONAL CBT EXAM INTERFACE  —  initAimcqProExam(...)
   ==================================================================
   A self-contained, SSC-style "Computer Based Test" exam interface,
   ported 1:1 from the AI MCQs Exam Maker WordPress plugin.

   Features (identical to the plugin):
     - Full-screen exam overlay (fixed, z-index 999999)
     - Professional start screen with bilingual instructions,
       exam summary card, palette legend demo and an
       "I agree" declaration checkbox.
     - Top bar with title + live countdown timer.
     - Left SSC question-palette panel:
         * Not Visited / Not Answered / Answered /
           Marked for Review / Answered & Marked counters
         * section tabs (one per topic) when the quiz has >= 2 topics
         * jump-to-question grid
         * Submit Exam button
     - Right question area with passage display, language switcher,
       lettered options, explanations.
     - Bottom action bar: Mark for Review / Clear Response /
       Check Answer (instant) / Save & Next.
     - Mobile floating nav-toggle + slide-in drawer.
     - localStorage session persistence (resume an unfinished exam).
     - KaTeX maths + SmilesDrawer chemistry rendering.
     - Results screen with score table (or revision summary).

   It is driven by the SAME prepared question objects the basic
   engine builds, so all three embedding methods (inline JSON /
   single remote JSON / merged multi-file) can use it simply by
   passing  exam_interface: 'professional'  in their settings.

   This function is invoked internally by initAimcqQuiz() — websites
   never need to call it directly.

   Arguments:
     containerId  - the id of the host <div>
     S            - merged settings object (from initAimcqQuiz)
     qs           - prepared & ordered question array
     pdata        - passage-data map  { passageId: {en:{title,content}, hi:{...}} }
     fingerprint  - per-quiz content fingerprint (for storage key)
   ================================================================== */
window.initAimcqProExam = function(containerId, S, qs, pdata, fingerprint) {

    var container = document.getElementById(containerId);
    if (!container) return;
    pdata = pdata || {};
    qs = qs || [];

    /* ---- map engine settings -> plugin-style settings -------------- */
    // The plugin's ExamRunner reads: exam_type, feedback_mode, timer,
    // shuffle_options, show_explanation, marks_per_question, negative_marks.
    var isRevision = (S.feedback_mode === 'instant' && (!S.timer || S.timer === 0));
    var examType   = isRevision ? 'revision' : 'standard';
    var examId     = (containerId + '-' + (fingerprint || 'x')).replace(/[^A-Za-z0-9_-]/g, '_');

    var settings = {
        exam_type:          examType,
        feedback_mode:      S.feedback_mode || 'end_of_exam',
        timer:              S.timer || 0,
        shuffle_options:    !!S.shuffle_options,
        show_explanation:   S.show_explanation !== false,
        marks_per_question: (S.marks_per_question != null) ? S.marks_per_question : 1,
        negative_marks:     (S.negative_marks != null) ? S.negative_marks : 0,
        title:              S.title || 'Exam',
        description:        S.description || ''
    };

    /* ---- helpers --------------------------------------------------- */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function slugSafe(s) { return String(s || 'all').replace(/[^A-Za-z0-9_-]/g, '_'); }

    // Smooth-scroll an element to a vertical offset, tolerating environments
    // (older browsers, some embedded webviews) where Element.scrollTo() is
    // missing — falls back to setting scrollTop directly.
    function safeScrollTo(el, top) {
        if (!el) return;
        try {
            if (typeof el.scrollTo === 'function') {
                el.scrollTo({ top: top, behavior: 'smooth' });
            } else {
                el.scrollTop = top;
            }
        } catch (e) {
            try { el.scrollTop = top; } catch (e2) {}
        }
    }

    /* ---- build section list from question topics ------------------- */
    // section_id is derived from each question's topic slug. When the quiz
    // has >= 2 distinct topics we show section tabs (plus an "All" tab).
    var sectionsMap = {}, sectionOrder = [];
    qs.forEach(function(q) {
        var t = q.topic || { slug: 'general', name: 'General' };
        var sid = slugSafe(t.slug || 'general');
        if (!sectionsMap[sid]) {
            sectionsMap[sid] = { id: sid, title: t.name || t.slug || 'General', count: 0 };
            sectionOrder.push(sid);
        }
        sectionsMap[sid].count++;
        q._section_id = sid;
    });
    var showSections = sectionOrder.length > 1;
    var sectionsData = [];
    if (showSections) {
        sectionsData.push({ id: 'all', title: 'All Sections' });
        sectionOrder.forEach(function(sid) {
            sectionsData.push({ id: sid, title: sectionsMap[sid].title });
        });
    }

    /* ---- normalise questions into the shape the runner expects ----- */
    // Engine question objects already carry en/hi/options/correct/etc.
    var questionsForJs = qs.map(function(q, idx) {
        return {
            id:                  q.id != null ? q.id : idx,
            is_passage_question: !!q.is_passage_question,
            passage_id:          q.passage_id || 0,
            correct:             (q.correct || []).map(String),
            image_width:         q.image_width || 0,
            image_height:        q.image_height || 0,
            section_id:          q._section_id,
            en:                  q.en || { content: '', options: [], explanation: '' },
            hi:                  q.hi || { content: '', options: [], explanation: '' }
        };
    });

    /* ---- group questions by passage (passage box rendered once) ---- */
    var questionGroups = [];   // [{passageKey, questions:[...]}]
    var groupIndex = {};
    questionsForJs.forEach(function(qd) {
        var key = (qd.is_passage_question && qd.passage_id) ? ('p' + qd.passage_id) : 'standalone';
        if (key === 'standalone') {
            questionGroups.push({ passageKey: 'standalone', questions: [qd] });
        } else {
            if (groupIndex[key] == null) {
                groupIndex[key] = questionGroups.length;
                questionGroups.push({ passageKey: key, questions: [] });
            }
            questionGroups[groupIndex[key]].questions.push(qd);
        }
    });

    /* ================================================================
       1. BUILD THE HTML  (mirrors the plugin's PHP-rendered markup)
       ================================================================ */
    function buildHTML() {
        var negTxt = parseFloat(settings.negative_marks) > 0
            ? '-' + parseFloat(settings.negative_marks)
            : 'No Negative Marking';

        /* --- start-screen summary --- */
        var summaryHTML;
        if (settings.exam_type === 'revision') {
            summaryHTML =
                '<div class="cbt-summary-item"><strong>Total Questions</strong>' + questionsForJs.length + '</div>'
              + '<div class="cbt-summary-item"><strong>Mode</strong>Practice / Revision</div>'
              + '<div class="cbt-summary-item"><strong>Duration</strong>Untimed</div>'
              + '<div class="cbt-summary-item"><strong>Feedback</strong>Instant Verification</div>';
        } else {
            summaryHTML =
                '<div class="cbt-summary-item"><strong>Total Questions</strong>' + questionsForJs.length + '</div>'
              + '<div class="cbt-summary-item"><strong>Duration</strong>' + (settings.timer > 0 ? settings.timer + ' Minutes' : 'Untimed') + '</div>'
              + '<div class="cbt-summary-item"><strong>Correct Answer</strong>+' + parseFloat(settings.marks_per_question) + '</div>'
              + '<div class="cbt-summary-item"><strong>Negative Marking</strong>' + negTxt + '</div>';
        }

        /* --- instructions (EN + HI) --- */
        var instEN, instHI;
        if (settings.exam_type === 'revision') {
            instEN =
                '<h3>Revision Instructions</h3>'
              + '<p>Please read the following instructions carefully before starting the revision:</p>'
              + '<ol>'
              + '<li>This is a practice mode designed for revision. There is no time limit.</li>'
              + '<li>You can check your answer instantly by clicking the <strong>Check Answer</strong> button below the question.</li>'
              + '<li>Detailed explanations for the questions (if available) will be displayed once you verify your answer.</li>'
              + '<li>There is no negative marking or final score penalty in this mode.</li>'
              + '<li>The Question Palette displayed on the left side of the screen will show the status of each question.</li>'
              + '<li>Click on the <strong>Question Number</strong> in the Question Palette to jump to that question directly.</li>'
              + '</ol><h4>Question Palette Legend:</h4>';
            instHI =
                '<h3>रिवीजन निर्देश</h3>'
              + '<p>कृपया अपना रिवीजन शुरू करने से पहले निम्नलिखित निर्देशों को ध्यान से पढ़ें:</p>'
              + '<ol>'
              + '<li>यह अभ्यास के लिए डिज़ाइन किया गया एक रिवीजन मोड है। इसमें कोई समय सीमा नहीं है।</li>'
              + '<li>आप प्रश्न के नीचे दिए गए <strong>Check Answer</strong> बटन पर क्लिक करके तुरंत अपने उत्तर की जांच कर सकते हैं।</li>'
              + '<li>अपना उत्तर जांचने के बाद प्रश्नों के विस्तृत स्पष्टीकरण (यदि उपलब्ध हों) प्रदर्शित किए जाएंगे।</li>'
              + '<li>इस मोड में कोई नेगेटिव मार्किंग या अंतिम स्कोर पेनाल्टी नहीं है।</li>'
              + '<li>स्क्रीन के बाईं ओर प्रदर्शित प्रश्न पैलेट प्रत्येक प्रश्न की स्थिति दिखाएगा।</li>'
              + '<li>उस प्रश्न पर सीधे जाने के लिए प्रश्न पैलेट में <strong>प्रश्न संख्या</strong> पर क्लिक करें।</li>'
              + '</ol><h4>प्रश्न पैलेट लेजेंड (Legend):</h4>';
        } else {
            var mq = parseFloat(settings.marks_per_question);
            var nm = parseFloat(settings.negative_marks);
            var negClauseEN = nm > 0
                ? ', and each incorrect answer carries a penalty of <strong>-' + nm + '</strong> marks'
                : '. There is <strong>NO negative marking</strong> for incorrect answers';
            var negClauseHI = nm > 0
                ? ', और प्रत्येक गलत उत्तर के लिए <strong>-' + nm + '</strong> अंकों की नेगेटिव मार्किंग है'
                : '। गलत उत्तरों के लिए <strong>कोई नेगेटिव मार्किंग नहीं</strong> है';
            var evalMarksEN = nm > 0 ? ' or -' + nm : ' or 0';
            instEN =
                '<h3>General Instructions</h3>'
              + '<p>Please read the following instructions carefully before starting the examination:</p>'
              + '<ol>'
              + '<li>The countdown timer at the top right corner of the screen will display the remaining time available for you to complete the examination. When the timer reaches zero, the examination will end automatically.</li>'
              + '<li>Each correct answer will be awarded <strong>+' + mq + '</strong> marks' + negClauseEN + '.</li>'
              + '<li>Unanswered questions will receive <strong>0</strong> marks. Questions marked for review <strong>WITHOUT</strong> selecting an option will also not be evaluated and will receive <strong>0</strong> marks.</li>'
              + '<li>Questions that are <strong>ANSWERED</strong> and marked for review will be considered for final evaluation and will receive marks (+' + mq + evalMarksEN + ') accordingly.</li>'
              + '<li>The Question Palette displayed on the left side of the screen will show the status of each question.</li>'
              + '<li>Click on the <strong>Question Number</strong> in the Question Palette to go to that question directly.</li>'
              + '<li>To save your answer, you MUST click on the <strong>Save &amp; Next</strong> button.</li>'
              + '<li>To mark a question for review, click on the <strong>Mark for Review</strong> button.</li>'
              + '<li>To change your answer to a question that has already been answered, first select that question for answering and then click on the <strong>Clear Response</strong> button.</li>'
              + '</ol><h4>Question Palette Legend:</h4>';
            instHI =
                '<h3>सामान्य निर्देश</h3>'
              + '<p>कृपया परीक्षा शुरू करने से पहले निम्नलिखित निर्देशों को ध्यान से पढ़ें:</p>'
              + '<ol>'
              + '<li>स्क्रीन के ऊपरी दाएं कोने में काउंटडाउन टाइमर परीक्षा पूरी करने के लिए आपके पास शेष समय प्रदर्शित करेगा। टाइमर शून्य होने पर, परीक्षा स्वतः समाप्त हो जाएगी।</li>'
              + '<li>प्रत्येक सही उत्तर के लिए <strong>+' + mq + '</strong> अंक दिए जाएंगे' + negClauseHI + '।</li>'
              + '<li>अनुत्तरित (Unanswered) प्रश्नों को <strong>0</strong> अंक मिलेंगे। बिना कोई विकल्प चुने समीक्षा के लिए चिह्नित किए गए प्रश्नों का मूल्यांकन नहीं किया जाएगा।</li>'
              + '<li>जिन प्रश्नों का <strong>उत्तर दिया गया है</strong> और समीक्षा के लिए चिह्नित किया गया है, उनका अंतिम मूल्यांकन किया जाएगा।</li>'
              + '<li>स्क्रीन के बाईं ओर प्रदर्शित प्रश्न पैलेट प्रत्येक प्रश्न की स्थिति दिखाएगा।</li>'
              + '<li>उस प्रश्न पर सीधे जाने के लिए प्रश्न पैलेट में <strong>प्रश्न संख्या</strong> पर क्लिक करें।</li>'
              + '<li>अपना उत्तर सहेजने के लिए, आपको <strong>Save &amp; Next</strong> बटन पर क्लिक करना होगा।</li>'
              + '<li>समीक्षा के लिए किसी प्रश्न को चिह्नित करने के लिए, <strong>Mark for Review</strong> बटन पर क्लिक करें।</li>'
              + '<li>पहले से उत्तर दिए गए प्रश्न का उत्तर बदलने के लिए, पहले उस प्रश्न को चुनें और फिर <strong>Clear Response</strong> बटन पर क्लिक करें।</li>'
              + '</ol><h4>प्रश्न पैलेट लेजेंड (Legend):</h4>';
        }

        /* --- palette legend demo --- */
        var demoHTML =
            '<div class="cbt-palette-demo">'
          + '<div class="cbt-demo-item"><span class="cbt-demo-icon icon-not-visited">1</span>'
          +   '<span class="inst-en-inline">You have not visited the question yet.</span>'
          +   '<span class="inst-hi-inline" style="display:none;">आपने अभी तक प्रश्न पर विजिट नहीं किया है।</span></div>'
          + '<div class="cbt-demo-item"><span class="cbt-demo-icon icon-unanswered">2</span>'
          +   '<span class="inst-en-inline">You have not answered the question.</span>'
          +   '<span class="inst-hi-inline" style="display:none;">आपने प्रश्न का उत्तर नहीं दिया है।</span></div>'
          + '<div class="cbt-demo-item"><span class="cbt-demo-icon icon-answered">3</span>'
          +   '<span class="inst-en-inline">You have answered the question.</span>'
          +   '<span class="inst-hi-inline" style="display:none;">आपने प्रश्न का उत्तर दिया है।</span></div>'
          + (settings.exam_type !== 'revision'
                ? '<div class="cbt-demo-item"><span class="cbt-demo-icon icon-review">4</span>'
                +   '<span class="inst-en-inline">Not answered, but marked for review.</span>'
                +   '<span class="inst-hi-inline" style="display:none;">उत्तर नहीं दिया, लेकिन समीक्षा के लिए चिह्नित।</span></div>'
                + '<div class="cbt-demo-item"><span class="cbt-demo-icon icon-answered-review">5</span>'
                +   '<span class="inst-en-inline">Answered and marked for review. (Will be evaluated).</span>'
                +   '<span class="inst-hi-inline" style="display:none;">उत्तर दिया और समीक्षा के लिए चिह्नित। (मूल्यांकन होगा)।</span></div>'
                : '')
          + '</div>';

        var descHTML = settings.description
            ? '<h4 class="inst-en">Specific Instructions for this Exam:</h4>'
            + '<h4 class="inst-hi" style="display:none;">इस परीक्षा के लिए विशिष्ट निर्देश:</h4>'
            + '<div class="exam-description" style="margin-top:10px;">' + settings.description + '</div>'
            : '';

        /* --- start screen --- */
        var startScreen =
            '<div class="aimcq-start-screen">'
          + '<div class="cbt-start-header"><h2>' + esc(settings.title) + '</h2></div>'
          + '<div class="cbt-content-area">'
          + '<div class="cbt-lang-select-container">'
          +   '<label for="instructions-lang-' + examId + '"><strong>View Instructions In:</strong> </label>'
          +   '<select id="instructions-lang-' + examId + '" class="cbt-lang-select">'
          +     '<option value="en">English</option><option value="hi">हिंदी</option>'
          +   '</select>'
          + '</div>'
          + '<div class="cbt-exam-summary">' + summaryHTML + '</div>'
          + '<div class="cbt-instructions-box">'
          +   '<div class="inst-en">' + instEN + '</div>'
          +   '<div class="inst-hi" style="display:none;">' + instHI + '</div>'
          +   demoHTML + descHTML
          + '</div>'
          + '<div class="cbt-declaration"><label>'
          +   '<input type="checkbox" id="aimcq-agree-checkbox-' + examId + '">'
          +   '<span class="inst-en-inline">I have read and understood all the instructions carefully. I agree that in case I do not adhere to the instructions, I will be held responsible and may face disqualification. I am ready to begin the test.</span>'
          +   '<span class="inst-hi-inline" style="display:none;">मैंने सभी निर्देशों को ध्यान से पढ़ और समझ लिया है। मैं सहमत हूं कि निर्देशों का पालन न करने पर मुझे जिम्मेदार ठहराया जाएगा। मैं परीक्षा शुरू करने के लिए तैयार हूं।</span>'
          + '</label></div>'
          + '<div class="cbt-action-bar">'
          +   '<button type="button" class="aimcq-start-btn" id="aimcq-start-btn-' + examId + '" disabled>I am ready to begin</button>'
          + '</div>'
          + '</div></div>';

        /* --- top bar --- */
        var topBar =
            '<div class="aimcq-top-bar"><h2>' + esc(settings.title) + '</h2>'
          + (settings.timer > 0
                ? '<div class="aimcq-timer-container">Time Left: '
                + '<span class="aimcq-timer" id="aimcq-timer-' + examId + '">--:--</span></div>'
                : '')
          + '</div>';

        /* --- legend (palette panel) --- */
        var legend =
            '<div class="aimcq-legend">'
          + '<div class="aimcq-legend-item"><span class="aimcq-legend-icon icon-not-visited" data-count="not-visited">0</span> Not Visited</div>'
          + '<div class="aimcq-legend-item"><span class="aimcq-legend-icon icon-unanswered" data-count="unanswered">0</span> Not Answered</div>'
          + '<div class="aimcq-legend-item"><span class="aimcq-legend-icon icon-answered" data-count="answered">0</span> Answered</div>'
          + (settings.exam_type !== 'revision'
                ? '<div class="aimcq-legend-item"><span class="aimcq-legend-icon icon-review" data-count="review">0</span> Marked for Review</div>'
                + '<div class="aimcq-legend-item" style="grid-column:span 2;"><span class="aimcq-legend-icon icon-answered-review" data-count="answered-review">0</span> Answered &amp; Marked for Review</div>'
                : '')
          + '</div>';

        /* --- section tabs --- */
        var sectionTabs = '';
        if (showSections) {
            sectionTabs = '<div class="aimcq-section-tabs">'
                + sectionsData.map(function(sec) {
                    return '<button type="button" class="aimcq-section-tab' + (sec.id === 'all' ? ' active' : '')
                        + '" data-section-target="' + esc(sec.id) + '">' + esc(sec.title) + '</button>';
                }).join('')
                + '</div>';
        }

        /* --- nav grid --- */
        var navGrid = '<div class="aimcq-nav-grid">'
            + questionsForJs.map(function(qd, idx) {
                return '<button type="button" class="aimcq-q-btn q-not-visited" data-q-index="' + idx
                    + '" data-section="' + esc(qd.section_id) + '">' + (idx + 1) + '</button>';
            }).join('')
            + '</div>';

        var navPanel =
            '<div class="aimcq-nav-panel">' + legend + sectionTabs
          + '<h4>' + (showSections ? 'Questions' : 'Section') + '</h4>'
          + navGrid
          + '<button type="button" class="aimcq-btn-submit-exam" data-action="submit-nav">Submit Exam</button>'
          + '</div>';

        /* --- questions + passages --- */
        var qaHTML = '';
        questionGroups.forEach(function(group) {
            if (group.passageKey !== 'standalone') {
                var pid = group.passageKey.slice(1);
                var pd = pdata[pid] || pdata[Number(pid)];
                if (pd) {
                    var enT = (pd.en && pd.en.title) || '';
                    var hiT = (pd.hi && pd.hi.title) || enT;
                    var enC = (pd.en && pd.en.content) || '';
                    var hiC = (pd.hi && pd.hi.content) || enC;
                    qaHTML +=
                        '<div class="aimcq-passage-display" id="passage-display-' + slugSafe(group.passageKey)
                        + '" data-passage-id="' + esc(group.passageKey) + '" style="display:none;">'
                      + (enT ? '<h3 class="aimcq-passage-title-en">' + esc(enT) + '</h3>'
                             + '<h3 class="aimcq-passage-title-hi" style="display:none;">' + esc(hiT) + '</h3>' : '')
                      + '<div class="aimcq-passage-content-en">' + enC + '</div>'
                      + '<div class="aimcq-passage-content-hi" style="display:none;">' + hiC + '</div>'
                      + '</div>';
                }
            }
            group.questions.forEach(function(qd) {
                var globalIndex = -1;
                for (var i = 0; i < questionsForJs.length; i++) {
                    if (questionsForJs[i] === qd) { globalIndex = i; break; }
                }
                var hasEN = qd.en && qd.en.content && qd.en.content.trim() !== '';
                var hasHI = qd.hi && qd.hi.content && qd.hi.content.trim() !== '';
                var showLangSwitch = hasEN && hasHI;
                var defLang = hasEN ? 'en' : 'hi';
                var options = (qd[defLang] && qd[defLang].options) || [];
                if (!options.length) return;
                var isMulti = qd.correct.length > 1;
                var imgStyle = '';
                if (qd.image_width > 0)  imgStyle += 'width:' + qd.image_width + 'px;';
                if (qd.image_height > 0) imgStyle += 'height:' + qd.image_height + 'px;object-fit:cover;';

                var optsHTML = options.map(function(opt, oi) {
                    var letter = String.fromCharCode(65 + oi);
                    var o = (typeof opt === 'string') ? { text: opt, image: '' } : opt;
                    return '<li><label>'
                        + '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="question_' + qd.id + '[]" value="' + oi + '">'
                        + '<div class="aimcq-option-inner-wrap">'
                        + '<span class="aimcq-option-label-letter">' + letter + '</span>'
                        + (o.image ? '<img src="' + esc(o.image) + '" alt="Option image" class="aimcq-option-image" style="' + esc(imgStyle) + '">' : '')
                        + '<div class="aimcq-option-text-content">' + (o.text || '') + '</div>'
                        + '</div></label></li>';
                }).join('');

                var passInd = qd.is_passage_question
                    ? '<span class="aimcq-passage-indicator" title="This question is based on the passage shown above.">'
                    + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>'
                    + ' Passage Question</span>'
                    : '';
                var langSwitch = showLangSwitch
                    ? '<div class="aimcq-lang-switcher">'
                    + '<button type="button" class="aimcq-lang-btn' + (defLang === 'en' ? ' active' : '') + '" data-lang="en">English</button>'
                    + '<button type="button" class="aimcq-lang-btn' + (defLang === 'hi' ? ' active' : '') + '" data-lang="hi">हिंदी</button>'
                    + '</div>'
                    : '';

                qaHTML +=
                    '<div class="aimcq-question hidden" id="question-' + qd.id + '" data-question-id="' + qd.id
                    + '" data-question-index="' + globalIndex + '">'
                  + '<div class="aimcq-question-header">'
                  +   '<span class="aimcq-question-number">Question ' + (globalIndex + 1) + '.</span>'
                  +   passInd + langSwitch
                  + '</div>'
                  + '<div class="aimcq-question-content-body">' + (qd[defLang].content || '') + '</div>'
                  + '<div class="aimcq-options"><ul>' + optsHTML + '</ul></div>'
                  + '<div class="aimcq-explanation" style="display:none;"></div>'
                  + '</div>';
            });
        });

        /* --- bottom bar --- */
        var bottomBar =
            '<div class="aimcq-bottom-bar" data-role="bottom-actions">'
          + (settings.exam_type !== 'revision'
                ? '<div class="aimcq-bottom-actions-left">'
                + '<button type="button" class="aimcq-action-btn aimcq-btn-review" data-action="review">Mark for Review</button>'
                + '<button type="button" class="aimcq-action-btn aimcq-btn-clear" data-action="clear">Clear Response</button>'
                + '</div>'
                : '')
          + '<div class="aimcq-bottom-actions-right"' + (settings.exam_type === 'revision' ? ' style="width:100%;justify-content:center;"' : '') + '>'
          + (settings.feedback_mode === 'instant'
                ? '<button type="button" class="aimcq-action-btn aimcq-btn-submit-exam" style="width:auto;flex:1;max-width:250px;justify-content:center;" data-action="check">Check Answer</button>'
                : '')
          + '<button type="button" class="aimcq-action-btn aimcq-btn-save" data-action="save-next"'
          +   (settings.exam_type === 'revision' ? ' style="flex:1;max-width:250px;justify-content:center;"' : '') + '>'
          +   (settings.exam_type === 'revision' ? 'Next Question' : 'Save &amp; Next')
          + '</button>'
          + '</div></div>';

        var examContainer =
            '<div class="aimcq-exam-container">'
          + topBar
          + '<div class="aimcq-exam-layout">'
          +   navPanel
          +   '<div class="aimcq-main-content">'
          +     '<form class="aimcq-exam-form">' + qaHTML + '</form>'
          +     '<div class="aimcq-results" style="display:none;"></div>'
          +   '</div>'
          + '</div>'
          + bottomBar
          + '<button type="button" class="aimcq-nav-toggle-btn" aria-label="Toggle Question Navigation">'
          +   '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>'
          + '</button>'
          + '<div class="aimcq-nav-overlay"></div>'
          + '</div>';

        var modal =
            '<div class="aimcq-modal-overlay" id="aimcq-modal-overlay-' + examId + '">'
          + '<div class="aimcq-modal-dialog">'
          + '<h3 class="aimcq-modal-title"></h3>'
          + '<div class="aimcq-modal-body"></div>'
          + '<div class="aimcq-modal-buttons"></div>'
          + '</div></div>';

        container.innerHTML =
            '<div id="aimcq-pro-scope" data-pro-scope="' + examId + '">'
          + '<div class="aimcq-exam-wrapper" id="aimcq-exam-' + examId + '">'
          + startScreen + examContainer + modal
          + '</div></div>';
    }

    buildHTML();

    /* ================================================================
       2. EXAM RUNNER  (ported 1:1 from the plugin)
       ================================================================ */
    function ExamRunner(examId, settings, questions, passageContentData) {
        this.examId = examId;
        this.settings = settings;
        this.questions = questions;
        this.passageContentData = passageContentData;
        this.totalQuestions = questions.length;
        this.currentIndex = 0;
        this.timerInterval = null;
        this.questionStates = this.questions.map(function() {
            return { visited: false, answered: false, review: false };
        });
        this.userSelections = {};
        this.questionLanguages = this.questions.map(function(q) {
            return (q.en && q.en.content && q.en.content.trim() !== '') ? 'en' : 'hi';
        });
        this.timeRemaining = this.settings.timer > 0 ? this.settings.timer * 60 : 0;
        var currentMode = this.settings.exam_type || 'standard';
        this.storageKey = 'aimcq_pro_state_' + this.examId + '_' + currentMode;
        this.hasSavedState = false;

        this.examWrapper   = document.getElementById('aimcq-exam-' + examId);
        this.startScreen   = this.examWrapper.querySelector('.aimcq-start-screen');
        this.startBtn      = document.getElementById('aimcq-start-btn-' + examId);
        this.agreeCheckbox = document.getElementById('aimcq-agree-checkbox-' + examId);

        this.examContainer   = this.examWrapper.querySelector('.aimcq-exam-container');
        this.form            = this.examWrapper.querySelector('.aimcq-exam-form');
        this.resultsDiv      = this.examWrapper.querySelector('.aimcq-results');
        this.questionElements = this.examWrapper.querySelectorAll('.aimcq-question');

        this.navPanel    = this.examWrapper.querySelector('.aimcq-nav-panel');
        this.navButtons  = this.navPanel ? this.navPanel.querySelectorAll('.aimcq-q-btn') : [];
        this.navToggleBtn = this.examWrapper.querySelector('.aimcq-nav-toggle-btn');
        this.navOverlay   = this.examWrapper.querySelector('.aimcq-nav-overlay');

        this.modalOverlay = document.getElementById('aimcq-modal-overlay-' + examId);
        this.modalTitle   = this.modalOverlay.querySelector('.aimcq-modal-title');
        this.modalBody    = this.modalOverlay.querySelector('.aimcq-modal-body');
        this.modalButtons = this.modalOverlay.querySelector('.aimcq-modal-buttons');
    }

    ExamRunner.prototype.init = function() {
        var self = this;
        var langSelect = document.getElementById('instructions-lang-' + this.examId);
        if (langSelect) {
            langSelect.addEventListener('change', function(e) {
                var lang = e.target.value;
                self.examWrapper.querySelectorAll('.inst-en').forEach(function(el) { el.style.display = lang === 'en' ? 'block' : 'none'; });
                self.examWrapper.querySelectorAll('.inst-hi').forEach(function(el) { el.style.display = lang === 'hi' ? 'block' : 'none'; });
                self.examWrapper.querySelectorAll('.inst-en-inline').forEach(function(el) { el.style.display = lang === 'en' ? 'inline' : 'none'; });
                self.examWrapper.querySelectorAll('.inst-hi-inline').forEach(function(el) { el.style.display = lang === 'hi' ? 'inline' : 'none'; });
                if (self.startBtn) {
                    var isRev = self.settings.exam_type === 'revision';
                    var resumeEn = isRev ? 'Resume Practice' : 'Resume Test';
                    var resumeHi = isRev ? 'अभ्यास फिर से शुरू करें' : 'परीक्षा फिर से शुरू करें';
                    var noticeEn = isRev ? 'You have not completed this revision yet.' : 'You have not completed this test yet.';
                    var noticeHi = isRev ? 'आपने अभी तक इस रिवीजन को पूरा नहीं किया है।' : 'आपने अभी तक इस परीक्षा को पूरा नहीं किया है।';
                    if (self.hasSavedState) {
                        self.startBtn.textContent = lang === 'en' ? resumeEn : resumeHi;
                        var n = document.getElementById('aimcq-resume-notice-' + self.examId);
                        if (n) n.textContent = lang === 'en' ? noticeEn : noticeHi;
                    } else {
                        self.startBtn.textContent = lang === 'en' ? 'I am ready to begin' : 'मैं शुरू करने के लिए तैयार हूँ';
                    }
                }
            });
        }

        if (this.agreeCheckbox && this.startBtn) {
            this.agreeCheckbox.addEventListener('change', function(e) {
                self.startBtn.disabled = !e.target.checked;
            });
        }
        if (this.startBtn) {
            this.startBtn.addEventListener('click', function() { self.startExam(); });
        }
        if (this.navToggleBtn) this.navToggleBtn.addEventListener('click', function() { self.toggleNavPanel(); });
        if (this.navOverlay)   this.navOverlay.addEventListener('click', function() { self.toggleNavPanel(false); });

        this.hasSavedState = this.loadState();

        if (this.hasSavedState) {
            var currentLang = langSelect ? langSelect.value : 'en';
            var isRev = this.settings.exam_type === 'revision';
            var resumeEn = isRev ? 'Resume Practice' : 'Resume Test';
            var resumeHi = isRev ? 'अभ्यास फिर से शुरू करें' : 'परीक्षा फिर से शुरू करें';
            var noticeEn = isRev ? 'You have not completed this revision yet.' : 'You have not completed this test yet.';
            var noticeHi = isRev ? 'आपने अभी तक इस रिवीजन को पूरा नहीं किया है।' : 'आपने अभी तक इस परीक्षा को पूरा नहीं किया है।';
            this.startBtn.textContent = currentLang === 'en' ? resumeEn : resumeHi;
            var noticeEl = document.getElementById('aimcq-resume-notice-' + this.examId);
            if (!noticeEl) {
                noticeEl = document.createElement('p');
                noticeEl.id = 'aimcq-resume-notice-' + this.examId;
                noticeEl.style.cssText = 'color:#d63638;font-weight:bold;margin-bottom:15px;font-size:1.05rem;';
                this.startBtn.parentNode.insertBefore(noticeEl, this.startBtn);
            }
            noticeEl.textContent = currentLang === 'en' ? noticeEn : noticeHi;
            this.startBtn.disabled = false;
            if (this.agreeCheckbox) this.agreeCheckbox.checked = true;
        }
    };

    ExamRunner.prototype.toggleNavPanel = function(forceState) {
        var shouldOpen = forceState === undefined
            ? !this.examWrapper.classList.contains('nav-panel-open') : forceState;
        this.examWrapper.classList.toggle('nav-panel-open', shouldOpen);
    };

    ExamRunner.prototype.saveState = function() {
        var self = this;
        var state = { currentIndex: this.currentIndex, timeRemaining: this.timeRemaining, questions: {} };
        this.questions.forEach(function(q, index) {
            state.questions[q.id] = {
                visited:    self.questionStates[index].visited,
                answered:   self.questionStates[index].answered,
                review:     self.questionStates[index].review,
                selections: self.userSelections[index] || [],
                language:   self.questionLanguages[index]
            };
        });
        try { localStorage.setItem(this.storageKey, JSON.stringify(state)); } catch (e) {}
    };

    ExamRunner.prototype.loadState = function() {
        var savedStr;
        try { savedStr = localStorage.getItem(this.storageKey); } catch (e) { return false; }
        if (!savedStr) return false;
        try {
            var state = JSON.parse(savedStr);
            var self = this;
            this.timeRemaining = state.timeRemaining;
            this.currentIndex = (state.currentIndex >= 0 && state.currentIndex < this.totalQuestions) ? state.currentIndex : 0;
            this.questions.forEach(function(q, index) {
                if (state.questions[q.id]) {
                    var sq = state.questions[q.id];
                    self.questionStates[index].visited  = sq.visited || false;
                    self.questionStates[index].answered = sq.answered || false;
                    self.questionStates[index].review   = sq.review || false;
                    if (sq.selections && sq.selections.length > 0) self.userSelections[index] = sq.selections;
                    var defLang = (q.en && q.en.content && q.en.content.trim() !== '') ? 'en' : 'hi';
                    self.questionLanguages[index] = sq.language || defLang;
                }
            });
            return true;
        } catch (e) { return false; }
    };

    ExamRunner.prototype.clearState = function() {
        try { localStorage.removeItem(this.storageKey); } catch (e) {}
    };

    ExamRunner.prototype.renderMath = function(element) {
        if (window.renderMathInElement) {
            renderMathInElement(element, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$',  right: '$',  display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ]
            });
        }
    };

    ExamRunner.prototype.renderChemistry = function(element) {
        if (typeof SmilesDrawer === 'undefined') return;
        var canvases = element.querySelectorAll('canvas[data-smiles]:not([data-drawn="true"])');
        if (!canvases.length) return;
        canvases.forEach(function(canvas) {
            var smiles = canvas.getAttribute('data-smiles');
            var w = parseInt(canvas.getAttribute('width') || 300);
            var h = parseInt(canvas.getAttribute('height') || 200);
            if (!canvas.hasAttribute('width'))  canvas.width = w;
            if (!canvas.hasAttribute('height')) canvas.height = h;
            var drawer = new SmilesDrawer.Drawer({ width: w, height: h });
            SmilesDrawer.parse(smiles, function(tree) {
                drawer.draw(tree, canvas, 'light', false);
                canvas.setAttribute('data-drawn', 'true');
            }, function(err) { console.log('SmilesDrawer error: ' + err); });
        });
    };

    ExamRunner.prototype.startExam = function() {
        // --- Portal the exam UI to <body> ---------------------------------
        // A CSS `position:fixed` element is positioned relative to the nearest
        // ancestor that has a `transform`, `filter`, `perspective`,
        // `will-change` or `contain` property — NOT the viewport. Many
        // Blogger/WordPress themes apply such properties to wrapper divs
        // (animations, sticky headers, page transitions), which would break
        // the fullscreen overlay (it would be clipped or mis-positioned).
        // Moving the scoped wrapper to be a direct child of <body> guarantees
        // the overlay always covers the true viewport, on every theme.
        var scopeEl = this.examWrapper.parentNode;       // #aimcq-pro-scope
        if (scopeEl && scopeEl.parentNode !== document.body) {
            // Remember where it was so finishExam() can put it back, keeping
            // the host page's DOM structure intact.
            this._scopeHome = scopeEl.parentNode;
            this._scopePlaceholder = document.createComment('aimcq-pro-scope-home');
            this._scopeHome.insertBefore(this._scopePlaceholder, scopeEl);
            document.body.appendChild(scopeEl);
        }
        this._scopeEl = scopeEl;

        document.body.classList.add('aimcq-fullscreen-active');
        this.examWrapper.classList.add('exam-active');
        this.startScreen.style.display = 'none';
        if (this.settings.shuffle_options) this.shuffleOptions();
        if (this.hasSavedState) this.restoreDOMFromState();
        if (this.settings.timer > 0) this.startTimer();
        this.setupEventListeners();
        this.renderMath(this.examContainer);
        this.renderChemistry(this.examContainer);
        this.questionStates[this.currentIndex].visited = true;
        this.jumpToQuestion(this.currentIndex);
    };

    /* Return the portaled exam UI to its original place in the host DOM
       and release the body scroll-lock. Safe to call when no portal was
       performed (e.g. the scope was already a direct child of <body>). */
    ExamRunner.prototype.restoreScopeHome = function() {
        try {
            if (this._scopeEl && this._scopePlaceholder && this._scopePlaceholder.parentNode) {
                this._scopePlaceholder.parentNode.insertBefore(this._scopeEl, this._scopePlaceholder);
                this._scopePlaceholder.parentNode.removeChild(this._scopePlaceholder);
            }
        } catch (e) { /* non-fatal: leave the node where it is */ }
        this._scopePlaceholder = null;
    };

    /* Cleanly leave the fullscreen exam and hand control back to the host
       website: release the body scroll-lock, drop the fullscreen overlay
       class, return the exam UI to its original DOM position, and scroll
       the page back to where the quiz sits. The host theme and its core
       functionality are never touched. */
    ExamRunner.prototype.exitExam = function() {
        if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
        document.body.classList.remove('aimcq-fullscreen-active');
        this.examWrapper.classList.remove('exam-active');
        this.restoreScopeHome();
        // Bring the page viewport back to the quiz container.
        try {
            var anchor = this._scopeEl || this.examWrapper;
            if (anchor && anchor.scrollIntoView) {
                anchor.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
        } catch (e) {}
    };

    ExamRunner.prototype.restoreDOMFromState = function() {
        var self = this;
        this.questions.forEach(function(qData, index) {
            var qElem = self.questionElements[index];
            if (!qElem) return;
            var activeLang = self.questionLanguages[index];
            var defLang = (qData.en && qData.en.content && qData.en.content.trim() !== '') ? 'en' : 'hi';
            if (activeLang !== defLang) {
                self.questionLanguages[index] = defLang;
                self.switchQuestionLanguage(index, activeLang, true);
            }
            var selections = self.userSelections[index];
            if (selections && selections.length > 0) {
                selections.forEach(function(val) {
                    var input = qElem.querySelector('input[value="' + val + '"]');
                    if (input) { input.checked = true; input.parentElement.classList.add('selected'); }
                });
            }
            if (self.settings.feedback_mode === 'instant' && self.questionStates[index].answered) {
                qElem.dataset.checked = 'true';
                self.evaluateQuestion(qElem, qData, true);
                if (self.settings.show_explanation) {
                    var lang = self.questionLanguages[index];
                    var explanation = qData[lang].explanation;
                    var explDiv = qElem.querySelector('.aimcq-explanation');
                    if (explanation && explDiv) {
                        explDiv.innerHTML = '<strong>Explanation:</strong> ' + explanation;
                        explDiv.style.display = 'block';
                        self.renderMath(explDiv);
                        self.renderChemistry(explDiv);
                    }
                }
            }
        });
    };

    ExamRunner.prototype.shuffleOptions = function() {
        this.questionElements.forEach(function(qElem) {
            var optionsList = qElem.querySelector('.aimcq-options ul');
            if (!optionsList) return;
            var options = Array.prototype.slice.call(optionsList.children);
            for (var i = options.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = options[i]; options[i] = options[j]; options[j] = tmp;
            }
            options.forEach(function(o) { optionsList.appendChild(o); });
        });
    };

    ExamRunner.prototype.setupEventListeners = function() {
        var self = this;
        var bottomBar = this.examWrapper.querySelector('[data-role="bottom-actions"]');

        // The results screen (incl. its "Back to Website" exit button) is
        // rendered later by finishExam(), so use delegation here.
        if (this.resultsDiv) {
            this.resultsDiv.addEventListener('click', function(e) {
                var exitBtn = e.target.closest('[data-action="exit-exam"]');
                if (exitBtn) self.exitExam();
            });
        }

        function btn(action) {
            return self.examWrapper.querySelector('[data-action="' + action + '"]');
        }
        var btnSaveNext = btn('save-next');
        var btnReview   = btn('review');
        var btnClear    = btn('clear');
        var btnCheck    = btn('check');
        var btnSubmit   = btn('submit-nav');

        var sectionTabs = this.navPanel ? this.navPanel.querySelectorAll('.aimcq-section-tab') : [];
        if (sectionTabs.length > 0) {
            this.navPanel.addEventListener('click', function(e) {
                if (e.target.matches('.aimcq-section-tab')) {
                    sectionTabs.forEach(function(t) { t.classList.remove('active'); });
                    e.target.classList.add('active');
                    var target = e.target.dataset.sectionTarget;
                    self.navButtons.forEach(function(b) {
                        b.style.display = (target === 'all' || b.dataset.section === target) ? 'flex' : 'none';
                    });
                }
            });
        }

        if (btnSaveNext) btnSaveNext.addEventListener('click', function() {
            self.saveState();
            if (self.currentIndex < self.totalQuestions - 1) {
                self.navigate(1);
            } else {
                self.updateNavPanel();
                if (self.settings.exam_type === 'revision') {
                    self.finishExam();
                } else {
                    self.showModal('Confirm Submission', 'You have reached the end of the exam. Are you sure you want to submit?', [
                        { text: 'Yes, Submit Exam', class: 'aimcq-modal-btn-confirm', action: function() { self.finishExam(); } },
                        { text: 'Cancel', class: 'aimcq-modal-btn-cancel', action: function() { self.hideModal(); } }
                    ]);
                }
            }
        });

        if (btnReview) btnReview.addEventListener('click', function() {
            self.questionStates[self.currentIndex].review = !self.questionStates[self.currentIndex].review;
            self.saveState();
            self.updateNavPanel();
            btnReview.textContent = self.questionStates[self.currentIndex].review ? 'Unmark Review' : 'Mark for Review';
        });

        if (btnClear) btnClear.addEventListener('click', function() {
            self.clearQuestionSelection(self.currentIndex);
        });

        if (btnCheck) btnCheck.addEventListener('click', function() {
            self.checkInstantAnswer();
        });

        if (btnSubmit) btnSubmit.addEventListener('click', function() {
            self.showModal('Confirm Submission', 'Are you sure you want to finish and submit the exam?', [
                { text: 'Yes, Submit Exam', class: 'aimcq-modal-btn-confirm', action: function() { self.finishExam(); } },
                { text: 'Cancel', class: 'aimcq-modal-btn-cancel', action: function() { self.hideModal(); } }
            ]);
        });

        this.form.addEventListener('change', function(e) {
            var qElem = e.target.closest('.aimcq-question');
            if (!qElem) return;
            var qIndex = parseInt(qElem.dataset.questionIndex, 10);
            if (e.target.name && e.target.name.indexOf('question_') === 0) {
                var inputs = qElem.querySelectorAll('input[name="' + e.target.name + '"]');
                qElem.querySelectorAll('.aimcq-options label').forEach(function(l) { l.classList.remove('selected'); });
                inputs.forEach(function(i) { if (i.checked) i.parentElement.classList.add('selected'); });
                var checked = qElem.querySelectorAll('input[name="' + e.target.name + '"]:checked');
                self.questionStates[qIndex].answered = checked.length > 0;
                self.userSelections[qIndex] = Array.prototype.slice.call(checked).map(function(i) { return i.value; });
                self.updateNavPanel();
                self.saveState();
            }
        });

        this.form.addEventListener('click', function(e) {
            if (e.target.classList.contains('aimcq-lang-btn')) {
                var qElem = e.target.closest('.aimcq-question');
                self.switchQuestionLanguage(parseInt(qElem.dataset.questionIndex, 10), e.target.dataset.lang);
            }
        });

        if (this.navPanel) {
            this.navPanel.addEventListener('click', function(e) {
                if (e.target.matches('.aimcq-q-btn')) {
                    var qIndex = parseInt(e.target.getAttribute('data-q-index'), 10);
                    if (isNaN(qIndex)) return;
                    if (self.form.dataset.finished === 'true') {
                        var targetQ = self.questionElements[qIndex];
                        var mainContent = self.examWrapper.querySelector('.aimcq-main-content');
                        if (targetQ && mainContent) {
                            safeScrollTo(mainContent, targetQ.offsetTop - 20);
                            if (window.innerWidth < 992) self.toggleNavPanel(false);
                            var origBg = targetQ.style.backgroundColor;
                            targetQ.style.backgroundColor = 'var(--aimcq-info-light)';
                            targetQ.style.transition = 'background-color 0.8s ease';
                            setTimeout(function() { targetQ.style.backgroundColor = origBg; }, 1200);
                        }
                    } else {
                        self.jumpToQuestion(qIndex);
                    }
                }
            });
        }
    };

    ExamRunner.prototype.switchQuestionLanguage = function(qIndex, lang, skipSave) {
        if (this.questionLanguages[qIndex] === lang) return;
        this.questionLanguages[qIndex] = lang;
        var self = this;
        var qElem = this.questionElements[qIndex];
        var qData = this.questions[qIndex];
        var langData = qData[lang];
        var englishOptionsData = qData.en ? qData.en.options : [];

        qElem.querySelectorAll('.aimcq-lang-btn').forEach(function(b) { b.classList.remove('active'); });
        var targetBtn = qElem.querySelector('.aimcq-lang-btn[data-lang="' + lang + '"]');
        if (targetBtn) targetBtn.classList.add('active');

        qElem.querySelector('.aimcq-question-content-body').innerHTML = langData.content;

        var optionsList = qElem.querySelector('.aimcq-options ul');
        var selectedValues = Array.prototype.slice.call(optionsList.querySelectorAll('input:checked')).map(function(i) { return i.value; });
        optionsList.innerHTML = '';
        var isMulti = qData.correct.length > 1;
        var imageStyle = 'width:' + (qData.image_width > 0 ? qData.image_width + 'px' : 'auto')
            + ';height:' + (qData.image_height > 0 ? qData.image_height + 'px;object-fit:cover;' : 'auto') + ';';

        (langData.options || []).forEach(function(optRaw, optIndex) {
            var optionData = (typeof optRaw === 'string') ? { text: optRaw, image: '' } : optRaw;
            var li = document.createElement('li');
            var label = document.createElement('label');
            var input = document.createElement('input');
            input.type = isMulti ? 'checkbox' : 'radio';
            input.name = 'question_' + qData.id + '[]';
            input.value = optIndex;
            if (selectedValues.indexOf(String(optIndex)) !== -1) { input.checked = true; label.classList.add('selected'); }
            label.appendChild(input);
            var innerWrap = document.createElement('div');
            innerWrap.className = 'aimcq-option-inner-wrap';
            var letterSpan = document.createElement('span');
            letterSpan.className = 'aimcq-option-label-letter';
            letterSpan.textContent = String.fromCharCode(65 + optIndex);
            innerWrap.appendChild(letterSpan);
            var imageToShow = optionData.image || (englishOptionsData && englishOptionsData[optIndex]
                ? (typeof englishOptionsData[optIndex] === 'string' ? '' : englishOptionsData[optIndex].image) : '');
            if (imageToShow) {
                var img = document.createElement('img');
                img.src = imageToShow; img.alt = 'Option image';
                img.className = 'aimcq-option-image'; img.style.cssText = imageStyle;
                innerWrap.appendChild(img);
            }
            var textDiv = document.createElement('div');
            textDiv.className = 'aimcq-option-text-content';
            textDiv.innerHTML = optionData.text || '';
            innerWrap.appendChild(textDiv);
            label.appendChild(innerWrap);
            li.appendChild(label);
            optionsList.appendChild(li);
        });

        if (this.form.dataset.finished === 'true'
            || (this.settings.feedback_mode === 'instant' && qElem.dataset.checked === 'true')) {
            this.evaluateQuestion(qElem, qData, true);
            var explDiv = qElem.querySelector('.aimcq-explanation');
            if (explDiv.style.display !== 'none') {
                explDiv.innerHTML = '<strong>Explanation:</strong> ' + langData.explanation;
            }
        }

        if (qData.is_passage_question) {
            var pc = this.examWrapper.querySelector('#passage-display-' + slugSafe('p' + qData.passage_id));
            if (pc) {
                var enT = pc.querySelector('.aimcq-passage-title-en');
                var hiT = pc.querySelector('.aimcq-passage-title-hi');
                var enC = pc.querySelector('.aimcq-passage-content-en');
                var hiC = pc.querySelector('.aimcq-passage-content-hi');
                if (enT) enT.style.display = lang === 'en' ? 'block' : 'none';
                if (hiT) hiT.style.display = lang === 'hi' ? 'block' : 'none';
                if (enC) enC.style.display = lang === 'en' ? 'block' : 'none';
                if (hiC) hiC.style.display = lang === 'hi' ? 'block' : 'none';
                this.renderMath(pc);
                this.renderChemistry(pc);
            }
        }
        this.renderMath(qElem);
        this.renderChemistry(qElem);
        if (!skipSave) this.saveState();
    };

    ExamRunner.prototype.startTimer = function() {
        var self = this;
        var timerEl = document.getElementById('aimcq-timer-' + this.examId);
        if (!timerEl) return;
        this.timerInterval = setInterval(function() {
            if (self.timeRemaining > 0) self.timeRemaining--;
            var m = Math.floor(self.timeRemaining / 60);
            var s = self.timeRemaining % 60;
            timerEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
            if (self.timeRemaining % 5 === 0) self.saveState();
            if (self.timeRemaining <= 0) {
                clearInterval(self.timerInterval);
                self.showModal("Time's Up!", 'Your time has expired. The exam will now be submitted automatically.', [
                    { text: 'OK', class: 'aimcq-modal-btn-confirm', action: function() { self.finishExam(); } }
                ]);
            }
        }, 1000);
    };

    ExamRunner.prototype.navigate = function(direction) {
        this.jumpToQuestion(this.currentIndex + direction);
    };

    ExamRunner.prototype.jumpToQuestion = function(index) {
        if (index < 0 || index >= this.totalQuestions) return;
        if (this.questionElements[this.currentIndex]) this.questionElements[this.currentIndex].classList.add('hidden');

        this.currentIndex = index;
        this.questionStates[this.currentIndex].visited = true;
        var currentQuestionData = this.questions[this.currentIndex];
        var isLast = (this.currentIndex === this.totalQuestions - 1);
        var isChecked = this.questionElements[this.currentIndex].dataset.checked === 'true';

        this.questionElements[this.currentIndex].classList.remove('hidden');

        var sectionTabs = this.navPanel ? this.navPanel.querySelectorAll('.aimcq-section-tab') : [];
        if (sectionTabs.length > 0) {
            var qSection = currentQuestionData.section_id;
            var activeTab = Array.prototype.slice.call(sectionTabs).find(function(t) { return t.classList.contains('active'); });
            if (activeTab && activeTab.dataset.sectionTarget !== 'all' && activeTab.dataset.sectionTarget !== qSection) {
                var targetTab = Array.prototype.slice.call(sectionTabs).find(function(t) { return t.dataset.sectionTarget === qSection; });
                if (targetTab) targetTab.click();
            }
        }

        var btnCheck = this.examWrapper.querySelector('[data-action="check"]');
        if (btnCheck) btnCheck.style.display = isChecked ? 'none' : '';

        var btnSaveNext = this.examWrapper.querySelector('[data-action="save-next"]');
        var btnReview   = this.examWrapper.querySelector('[data-action="review"]');
        if (btnSaveNext) {
            if (this.settings.exam_type === 'revision') {
                btnSaveNext.textContent = isLast ? 'Finish Revision' : 'Next Question';
                btnSaveNext.style.display = isChecked ? '' : 'none';
            } else {
                btnSaveNext.textContent = isLast ? 'Save & Submit' : 'Save & Next';
                btnSaveNext.style.display = '';
            }
        }
        if (btnReview) {
            btnReview.textContent = this.questionStates[this.currentIndex].review ? 'Unmark Review' : 'Mark for Review';
        }

        this.updateNavPanel();

        this.examWrapper.querySelectorAll('.aimcq-passage-display').forEach(function(p) { p.style.display = 'none'; });
        if (currentQuestionData.is_passage_question) {
            var pc = this.examWrapper.querySelector('#passage-display-' + slugSafe('p' + currentQuestionData.passage_id));
            if (pc) {
                pc.style.display = 'block';
                var lang = this.questionLanguages[this.currentIndex];
                var enT = pc.querySelector('.aimcq-passage-title-en');
                var hiT = pc.querySelector('.aimcq-passage-title-hi');
                var enC = pc.querySelector('.aimcq-passage-content-en');
                var hiC = pc.querySelector('.aimcq-passage-content-hi');
                if (enT) enT.style.display = lang === 'en' ? 'block' : 'none';
                if (hiT) hiT.style.display = lang === 'hi' ? 'block' : 'none';
                if (enC) enC.style.display = lang === 'en' ? 'block' : 'none';
                if (hiC) hiC.style.display = lang === 'hi' ? 'block' : 'none';
            }
        }

        if (window.innerWidth < 992) this.toggleNavPanel(false);
        var mainContent = this.examWrapper.querySelector('.aimcq-main-content');
        if (mainContent) safeScrollTo(mainContent, 0);
        this.saveState();
    };

    ExamRunner.prototype.checkInstantAnswer = function() {
        var qElem = this.questionElements[this.currentIndex];
        var qData = this.questions[this.currentIndex];
        this.evaluateQuestion(qElem, qData, true);
        if (this.settings.show_explanation) {
            var lang = this.questionLanguages[this.currentIndex];
            var explanation = this.questions[this.currentIndex][lang].explanation;
            var explDiv = qElem.querySelector('.aimcq-explanation');
            if (explanation && explDiv) {
                explDiv.innerHTML = '<strong>Explanation:</strong> ' + explanation;
                explDiv.style.display = 'block';
                this.renderMath(explDiv);
                this.renderChemistry(explDiv);
            }
        }
        qElem.dataset.checked = 'true';
        var btnCheck = this.examWrapper.querySelector('[data-action="check"]');
        if (btnCheck) btnCheck.style.display = 'none';
        var btnSaveNext = this.examWrapper.querySelector('[data-action="save-next"]');
        if (btnSaveNext && this.settings.exam_type === 'revision') btnSaveNext.style.display = '';
        this.updateNavPanel();
        this.saveState();
    };

    ExamRunner.prototype.clearQuestionSelection = function(qIndex) {
        var qElem = this.questionElements[qIndex];
        if (!qElem) return;
        qElem.querySelectorAll('input:checked').forEach(function(i) { i.checked = false; });
        qElem.querySelectorAll('.aimcq-options label').forEach(function(l) { l.classList.remove('selected'); });
        this.questionStates[qIndex].answered = false;
        delete this.userSelections[qIndex];
        this.updateNavPanel();
        this.saveState();
    };

    ExamRunner.prototype.updateNavPanel = function() {
        if (!this.navPanel) return;
        var self = this;
        this.navButtons.forEach(function(btn, index) {
            var state = self.questionStates[index];
            var baseDisplay = btn.style.display;
            btn.className = 'aimcq-q-btn';
            if (state.review && state.answered) btn.classList.add('q-answered-review');
            else if (state.review)             btn.classList.add('q-review');
            else if (state.answered)           btn.classList.add('q-answered');
            else if (state.visited)            btn.classList.add('q-unanswered');
            else                               btn.classList.add('q-not-visited');
            if (index === self.currentIndex) btn.classList.add('q-current');
            btn.style.display = baseDisplay;
        });
        var counts = { visited: 0, unanswered: 0, answered: 0, review: 0, answeredReview: 0 };
        this.questionStates.forEach(function(s) {
            if (!s.visited) counts.visited++;
            else if (s.review && s.answered) counts.answeredReview++;
            else if (s.review)               counts.review++;
            else if (s.answered)             counts.answered++;
            else                             counts.unanswered++;
        });
        function setCount(name, val) {
            var el = self.navPanel.querySelector('[data-count="' + name + '"]');
            if (el) el.textContent = val;
        }
        setCount('not-visited', counts.visited);
        setCount('unanswered', counts.unanswered);
        setCount('answered', counts.answered);
        setCount('review', counts.review);
        setCount('answered-review', counts.answeredReview);
    };

    ExamRunner.prototype.evaluateQuestion = function(qElem, qData, disableInputs) {
        var correctAnswers = (qData.correct || []).map(String);
        var qIndex = parseInt(qElem.dataset.questionIndex, 10);
        var selectedAnswers = this.userSelections[qIndex] || [];
        var isCorrect = selectedAnswers.length > 0
            && selectedAnswers.length === correctAnswers.length
            && selectedAnswers.every(function(val) { return correctAnswers.indexOf(val) !== -1; });
        if (this.settings.feedback_mode === 'end_of_exam' || disableInputs) {
            qElem.querySelectorAll('.aimcq-options label').forEach(function(label) {
                var input = label.querySelector('input');
                label.classList.remove('correct', 'incorrect', 'missed', 'selected');
                if (correctAnswers.indexOf(input.value) !== -1) {
                    if (selectedAnswers.indexOf(input.value) !== -1) label.classList.add('correct');
                    else label.classList.add('missed');
                } else if (selectedAnswers.indexOf(input.value) !== -1) {
                    label.classList.add('incorrect');
                }
                if (disableInputs) { input.disabled = true; label.classList.add('disabled'); }
            });
        }
        return isCorrect;
    };

    ExamRunner.prototype.showModal = function(title, body, buttons) {
        this.hideModal();
        this.modalTitle.textContent = title;
        this.modalBody.innerHTML = body;
        var self = this;
        buttons.forEach(function(info) {
            var b = document.createElement('button');
            b.textContent = info.text;
            b.className = info.class;
            b.addEventListener('click', info.action, { once: true });
            self.modalButtons.appendChild(b);
        });
        this.modalOverlay.style.display = 'flex';
    };

    ExamRunner.prototype.hideModal = function() {
        this.modalOverlay.style.display = 'none';
        this.modalButtons.innerHTML = '';
    };

    ExamRunner.prototype.finishExam = function() {
        var self = this;
        this.clearState();
        this.hideModal();
        if (window.innerWidth < 992) this.toggleNavPanel(false);
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.form.dataset.finished = 'true';

        if (this.navToggleBtn) this.navToggleBtn.style.display = 'none';
        var bottomBar = this.examWrapper.querySelector('[data-role="bottom-actions"]');
        if (bottomBar) bottomBar.style.display = 'none';
        var submitBtn = this.examWrapper.querySelector('[data-action="submit-nav"]');
        if (submitBtn) submitBtn.style.display = 'none';

        if (this.settings.feedback_mode !== 'instant') {
            var totalCorrect = 0, totalWrong = 0, totalAttempted = 0;
            this.questionElements.forEach(function(qElem, index) {
                var qData = self.questions[index];
                var qIndex = parseInt(qElem.dataset.questionIndex, 10);
                var selectedAnswers = self.userSelections[qIndex] || [];
                var isAttempted = selectedAnswers.length > 0;
                var isCorrect = self.evaluateQuestion(qElem, qData, true);
                if (isAttempted) {
                    totalAttempted++;
                    if (isCorrect) totalCorrect++; else totalWrong++;
                }
                if (self.settings.show_explanation) {
                    var lang = self.questionLanguages[index];
                    var explanation = self.questions[index][lang].explanation;
                    var explDiv = qElem.querySelector('.aimcq-explanation');
                    if (explanation && explDiv) {
                        explDiv.innerHTML = '<strong>Explanation:</strong> ' + explanation;
                        explDiv.style.display = 'block';
                        self.renderMath(explDiv);
                        self.renderChemistry(explDiv);
                    }
                }
            });
            this.examStats = { totalCorrect: totalCorrect, totalWrong: totalWrong, totalAttempted: totalAttempted };
        }

        this.examWrapper.querySelectorAll('.aimcq-passage-display').forEach(function(p) { p.style.display = 'block'; });
        this.questionElements.forEach(function(q) { q.classList.remove('hidden'); });

        if (this.settings.exam_type === 'revision') {
            var reviewedCount = Array.prototype.slice.call(this.questionElements)
                .filter(function(q) { return q.dataset.checked === 'true'; }).length;
            var message = reviewedCount === this.totalQuestions
                ? 'You have reviewed all <strong>' + this.totalQuestions + '</strong> questions.'
                : 'You have reviewed only <strong>' + reviewedCount + '</strong> '
                  + (reviewedCount === 1 ? 'question' : 'questions') + '.';
            this.resultsDiv.innerHTML = '<h3>Revision Completed!</h3><p>' + message + '</p>'
              + '<div class="aimcq-results-actions">'
              + '<button type="button" class="aimcq-exit-btn" data-action="exit-exam">Back to Website</button>'
              + '</div>';
            this.resultsDiv.className = 'aimcq-results pass';
        } else {
            var stats = this.examStats || { totalCorrect: 0, totalWrong: 0, totalAttempted: 0 };
            var marksPerQ = Number(this.settings.marks_per_question);
            if (isNaN(marksPerQ)) marksPerQ = 1;
            var negMarks = Number(this.settings.negative_marks);
            if (isNaN(negMarks)) negMarks = 0;
            var rawMax = this.totalQuestions * marksPerQ;
            var rawObtained = (stats.totalCorrect * marksPerQ) - (stats.totalWrong * negMarks);
            var totalMaxMarks = Math.round(rawMax * 100) / 100;
            var obtainedMarks = Math.round(rawObtained * 100) / 100;
            var percentage = totalMaxMarks > 0 ? ((obtainedMarks / totalMaxMarks) * 100) : 0;
            percentage = Math.round(percentage * 100) / 100;
            var fPct = Number.isInteger(percentage) ? percentage : percentage.toFixed(2);
            var fObt = Number.isInteger(obtainedMarks) ? obtainedMarks : obtainedMarks.toFixed(2);
            var fMax = Number.isInteger(totalMaxMarks) ? totalMaxMarks : totalMaxMarks.toFixed(2);
            this.resultsDiv.innerHTML =
                '<h3 class="aimcq-results-title">Exam Finished!</h3>'
              + '<table class="aimcq-results-table"><tbody>'
              + '<tr><th>Total Questions</th><td>' + this.totalQuestions + '</td></tr>'
              + '<tr><th>Attempted</th><td>' + stats.totalAttempted + '</td></tr>'
              + '<tr><th>Correct Answers</th><td style="color:var(--aimcq-success);">' + stats.totalCorrect + '</td></tr>'
              + '<tr><th>Wrong Answers</th><td style="color:var(--aimcq-danger);">' + stats.totalWrong + '</td></tr>'
              + '<tr class="highlight-row"><th>Max Marks</th><td>' + fMax + '</td></tr>'
              + '<tr class="highlight-row"><th>Obtained Marks</th><td style="color:var(--aimcq-primary);font-size:1.2rem;">' + fObt + '</td></tr>'
              + '<tr class="highlight-row" style="font-size:1.3rem;color:' + (percentage >= 50 ? 'var(--aimcq-success)' : 'var(--aimcq-danger)') + ';">'
              +   '<th>Percentage</th><td>' + fPct + '%</td></tr>'
              + '</tbody></table>'
              + '<div class="aimcq-results-actions">'
              + '<button type="button" class="aimcq-exit-btn" data-action="exit-exam">Back to Website</button>'
              + '</div>';
            this.resultsDiv.className = 'aimcq-results ' + (percentage >= 50 ? 'pass' : 'fail');
        }

        this.resultsDiv.style.display = 'block';
        var mainContent = this.examWrapper.querySelector('.aimcq-main-content');
        if (mainContent) {
            safeScrollTo(mainContent, this.resultsDiv.offsetTop - 20);
        } else if (this.resultsDiv.scrollIntoView) {
            this.resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        this.renderMath(this.form);
        this.renderChemistry(this.form);
    };

    /* ================================================================
       3. BOOT
       ================================================================ */
    try {
        var examWrapperEl = document.getElementById('aimcq-exam-' + examId);
        if (examWrapperEl) {
            examWrapperEl.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        }
        if (questionsForJs.length > 0) {
            var runner = new ExamRunner(examId, settings, questionsForJs, pdata);
            runner.init();
        } else {
            console.warn('[aimcq] Professional exam has no questions to display.');
            container.innerHTML = '<div id="aimcq-pro-scope">'
                + '<div style="padding:24px;font:14px/1.5 sans-serif;color:#555;">'
                + 'No questions are available for this exam.'
                + '</div></div>';
        }
    } catch (err) {
        console.error('[aimcq] Professional exam interface crashed during boot:', err);
        container.innerHTML = '<div id="aimcq-pro-scope">'
            + '<div style="padding:24px;border:1px solid #e0b4b4;background:#fff6f6;'
            + 'color:#9f3a38;border-radius:8px;font:14px/1.5 sans-serif;">'
            + '<strong>The professional exam interface failed to start.</strong><br>'
            + 'Please reload the page. If the problem persists, check the browser '
            + 'console for details.'
            + '</div></div>';
        try { document.body.classList.remove('aimcq-fullscreen-active'); } catch (e) {}
    }
};
