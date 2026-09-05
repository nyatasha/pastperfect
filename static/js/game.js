/* Past Perfect — the board.
   A question says what each object *is* — its form, and the museum that holds
   it — because you cannot compare two pictures without knowing whether you are
   looking at a painting or a photograph of one. What it never says, until the
   player has committed, is when either was made. That line is enforced in
   contract.ts; this file only draws what the payload contains. */
(function () {
  'use strict';

  var root = document.getElementById('game');
  if (!root) { return; }

  var mode = root.dataset.mode;
  var edition = root.dataset.edition || '';
  var museum = root.dataset.museum || '';
  var MUSEUMS = readJson('museum-data') || {};

  var els = {
    board: document.getElementById('board'),
    foot: document.querySelector('.game-foot'),
    question: document.getElementById('question'),
    pips: document.getElementById('pips'),
    sub: document.getElementById('game-sub'),
    reveal: document.getElementById('reveal'),
    verdict: document.getElementById('reveal-verdict'),
    insight: document.getElementById('reveal-insight'),
    gap: document.getElementById('reveal-gap'),
    next: document.getElementById('next'),
    results: document.getElementById('results'),
    loading: document.getElementById('loading'),
    a: document.getElementById('choice-a'),
    b: document.getElementById('choice-b'),
    end: document.getElementById('end-run'),
    lightbox: document.getElementById('lightbox'),
    stage: document.getElementById('lightbox-stage'),
    zoomImg: document.getElementById('lightbox-img'),
    zoomCaption: document.getElementById('lightbox-caption'),
    zoomLevel: document.getElementById('zoom-level')
  };

  var state = {
    questions: [],
    index: 0,
    answers: [],
    locked: false,
    finished: false,
    page: 0,
    exhausted: false,
    run: 0,
    bestRun: 0,
    seed: PP.session(),
    date: root.dataset.date || null,
    puzzle: parseInt(root.dataset.puzzle || '0', 10),
    standing: null,
    answered: 0,
    adShown: false,
    adAfter: 10
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) { return null; }
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function museumName(slug) {
    return (MUSEUMS[slug] && MUSEUMS[slug].name) || slug || '';
  }

  /**
   * A title short enough to say out loud.
   *
   * Museum titles are catalogue entries, not names: Wellcome in particular will
   * hand you a full sentence describing the scene, the technique and the year.
   * The reveal shows those in full; a shared sentence gets the first clause.
   */
  function shortTitle(title) {
    var text = String(title || '').trim();
    var clause = text.split(/[;:]/)[0].trim();
    if (clause.length >= 12) { text = clause; }
    if (text.length <= 56) { return text.replace(/[.,]$/, ''); }
    var cut = text.slice(0, 56);
    var space = cut.lastIndexOf(' ');
    var kept = space > 24 ? cut.slice(0, space) : cut;
    // A sentence that ends on "the" reads worse than one word shorter.
    kept = kept.replace(/\s+(a|an|the|of|in|on|to|and|by|for|with)$/i, '');
    return kept.replace(/[.,]$/, '') + '…';
  }

  function escapeHtml(value) {
    return String(value === null || typeof value === 'undefined' ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }

  /* ---------- loading ---------- */

  function roundUrl(page) {
    if (mode === 'endless') {
      return '/api/round?mode=endless&seed=' + encodeURIComponent(state.seed) +
        '&page=' + page + (museum ? '&museum=' + encodeURIComponent(museum) : '');
    }
    return '/api/round?mode=daily' + (edition ? '&edition=' + encodeURIComponent(edition) : '') +
      (state.date ? '&date=' + encodeURIComponent(state.date) : '');
  }

  function start() {
    /* Endless carries on where this browser left it. Asking for page 0 every
       time replayed the same eight questions, because the pool's order is fixed
       by the seed. */
    if (mode === 'endless') { state.page = PP.endlessResume(museum); }
    fetch(roundUrl(state.page), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { return fail(res.data && res.data.message); }
        state.questions = res.data.questions || [];
        if (mode === 'endless' && !state.questions.length && state.page > 0) {
          /* Resumed past the end of the pool. Wrap round rather than telling a
             player who has just arrived that there is nothing to play. */
          PP.markEndlessPage(museum, 0);
          state.page = 0;
          return start();
        }
        if (res.data.adAfterRounds) { state.adAfter = res.data.adAfterRounds; }
        if (!state.questions.length) { return fail('No questions are available yet.'); }
        if (res.data.puzzle) { state.puzzle = res.data.puzzle; }
        if (res.data.date) { state.date = res.data.date; }
        els.loading.hidden = true;
        buildPips();
        show(0);
        PP.track('round_start', { mode: mode, edition: edition || museum || '' });
      })
      .catch(function () { fail(); });
  }

  function fail(message) {
    els.loading.textContent = message || 'Could not load the round. Try reloading.';
  }

  function buildPips() {
    if (mode === 'endless') { els.pips.hidden = true; return; }
    els.pips.innerHTML = '';
    for (var i = 0; i < state.questions.length; i++) {
      els.pips.appendChild(document.createElement('span')).className = 'pip';
    }
  }

  function paintPips() {
    if (mode === 'endless') { return; }
    var pips = els.pips.children;
    for (var i = 0; i < pips.length; i++) {
      var answer = state.answers[i];
      pips[i].className = 'pip' +
        (answer ? (answer.correct ? ' is-hit' : ' is-miss') : '') +
        (i === state.index && !state.finished ? ' is-current' : '');
    }
  }

  /* ---------- rendering a question ---------- */

  function show(index) {
    var question = state.questions[index];
    if (!question) { return; }
    state.index = index;
    state.locked = false;

    els.question.innerHTML = 'Which came <em>first</em>?';
    els.reveal.hidden = true;
    els.reveal.classList.remove('is-shown');
    els.next.hidden = true;

    [['a', els.a], ['b', els.b]].forEach(function (entry) {
      var side = question[entry[0]];
      var card = entry[1];
      var img = card.querySelector('[data-image]');
      card.className = 'choice';
      card.disabled = false;
      card.querySelector('[data-verdict]').textContent = '';
      card.querySelector('[data-label]').innerHTML = '';
      card.querySelector('[data-kind]').innerHTML = kindMarkup(side);
      img.classList.remove('is-ready');
      img.alt = side.form + ', ' + museumName(side.museum) + ' — undated';
      if (side.w && side.h) { img.width = side.w; img.height = side.h; }
      img.onload = function () { img.classList.add('is-ready'); };
      img.src = side.img;
      if (img.complete) { img.classList.add('is-ready'); }
    });

    if (mode === 'endless') { els.sub.textContent = endlessSubtitle(); }
    paintPips();
    preload(index + 1);
  }

  function endlessSubtitle() {
    return state.answered + ' answered · ' + state.run + ' in a row · best ' + state.bestRun;
  }

  /* What the object is, and whose it is. Never when it is. */
  function kindMarkup(side) {
    return '<b class="kind-form">' + escapeHtml(side.form) + '</b>' +
      '<span class="kind-museum">' + escapeHtml(museumName(side.museum)) + '</span>';
  }

  function preload(index) {
    var question = state.questions[index];
    if (!question) { return; }
    ['a', 'b'].forEach(function (side) { new Image().src = question[side].img; });
  }

  /* ---------- zoom ----------
     The complaint this answers: a click used to be a commitment, so there was
     no way to look closer without answering. Zoom is now its own control, and
     opens a stage you can pan and magnify without touching your answer. */

  var zoom = { scale: 1, x: 0, y: 0, side: null, dragging: false, lastX: 0, lastY: 0, pointers: {} };

  function openZoom(side) {
    var question = state.questions[state.index];
    if (!question || !question[side]) { return; }
    var answer = state.answers[state.index];
    zoom.side = side;
    els.zoomImg.src = question[side].img;
    els.zoomImg.alt = question[side].form + ', ' + museumName(question[side].museum);
    els.zoomCaption.innerHTML = answer
      ? '<b>' + escapeHtml(answer[side].title) + '</b> · ' +
        escapeHtml(answer[side].yearText) + ' · ' + escapeHtml(answer[side].museumName)
      : '<b>' + escapeHtml(question[side].form) + '</b> · ' +
        escapeHtml(museumName(question[side].museum)) +
        ' <span class="lightbox-note">Zooming never counts as an answer.</span>';
    setZoom(1, 0, 0);
    els.lightbox.hidden = false;
    document.body.classList.add('is-zoomed');
    document.getElementById('lightbox-close').focus({ preventScroll: true });
    PP.track('zoom_open', { mode: mode, answered: Boolean(answer) });
  }

  function closeZoom() {
    if (els.lightbox.hidden) { return; }
    els.lightbox.hidden = true;
    document.body.classList.remove('is-zoomed');
    els.zoomImg.removeAttribute('src');
    var card = zoom.side === 'b' ? els.b : els.a;
    if (card) { card.focus({ preventScroll: true }); }
    zoom.side = null;
  }

  function setZoom(scale, x, y) {
    zoom.scale = Math.min(8, Math.max(1, scale));
    if (zoom.scale === 1) { zoom.x = 0; zoom.y = 0; }
    else {
      var rect = els.stage.getBoundingClientRect();
      var limitX = (rect.width * (zoom.scale - 1)) / 2;
      var limitY = (rect.height * (zoom.scale - 1)) / 2;
      zoom.x = Math.min(limitX, Math.max(-limitX, x));
      zoom.y = Math.min(limitY, Math.max(-limitY, y));
    }
    els.zoomImg.style.transform =
      'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.scale + ')';
    els.stage.classList.toggle('is-magnified', zoom.scale > 1);
    els.zoomLevel.textContent = Math.round(zoom.scale * 100) + '%';
  }

  /* Keep whatever is under the cursor under the cursor. */
  function zoomAt(nextScale, clientX, clientY) {
    var rect = els.stage.getBoundingClientRect();
    var px = clientX - (rect.left + rect.width / 2);
    var py = clientY - (rect.top + rect.height / 2);
    var ratio = Math.min(8, Math.max(1, nextScale)) / zoom.scale;
    setZoom(nextScale, px - ratio * (px - zoom.x), py - ratio * (py - zoom.y));
  }

  function wireZoom() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-zoom]'), function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        openZoom(button.dataset.zoom);
      });
    });
    document.getElementById('lightbox-close').addEventListener('click', closeZoom);
    document.getElementById('zoom-in').addEventListener('click', function () {
      setZoom(zoom.scale * 1.6, zoom.x * 1.6, zoom.y * 1.6);
    });
    document.getElementById('zoom-out').addEventListener('click', function () {
      setZoom(zoom.scale / 1.6, zoom.x / 1.6, zoom.y / 1.6);
    });

    els.stage.addEventListener('click', function (event) {
      if (event.target !== els.zoomImg) { closeZoom(); }
    });
    els.zoomImg.addEventListener('dblclick', function (event) {
      event.preventDefault();
      zoomAt(zoom.scale > 1 ? 1 : 2.6, event.clientX, event.clientY);
    });
    els.stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      zoomAt(zoom.scale * (event.deltaY < 0 ? 1.16 : 1 / 1.16), event.clientX, event.clientY);
    }, { passive: false });

    els.stage.addEventListener('pointerdown', function (event) {
      zoom.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      if (Object.keys(zoom.pointers).length > 1) { return; }
      if (zoom.scale <= 1) { return; }
      zoom.dragging = true;
      zoom.lastX = event.clientX;
      zoom.lastY = event.clientY;
      els.stage.setPointerCapture(event.pointerId);
    });
    els.stage.addEventListener('pointermove', function (event) {
      var ids = Object.keys(zoom.pointers);
      if (ids.length === 2) {
        var before = spread(ids);
        zoom.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
        var after = spread(ids);
        if (before > 0) {
          var mid = midpoint(ids);
          zoomAt(zoom.scale * (after / before), mid.x, mid.y);
        }
        event.preventDefault();
        return;
      }
      if (!zoom.dragging) { return; }
      setZoom(zoom.scale, zoom.x + (event.clientX - zoom.lastX), zoom.y + (event.clientY - zoom.lastY));
      zoom.lastX = event.clientX;
      zoom.lastY = event.clientY;
      if (zoom.pointers[event.pointerId]) {
        zoom.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      els.stage.addEventListener(name, function (event) {
        delete zoom.pointers[event.pointerId];
        zoom.dragging = false;
      });
    });
  }

  function spread(ids) {
    var a = zoom.pointers[ids[0]];
    var b = zoom.pointers[ids[1]];
    if (!a || !b) { return 0; }
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function midpoint(ids) {
    var a = zoom.pointers[ids[0]];
    var b = zoom.pointers[ids[1]];
    if (!a || !b) { return { x: 0, y: 0 }; }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /* ---------- answering ---------- */

  function choose(side) {
    if (state.locked || state.finished || !els.lightbox.hidden) { return; }
    var question = state.questions[state.index];
    if (!question) { return; }
    state.locked = true;

    fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: question.id, choice: side, session: PP.session() })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { state.locked = false; return; }
        reveal(side, data);
      })
      .catch(function () { state.locked = false; });
  }

  function reveal(chosen, data) {
    var question = state.questions[state.index];
    /* Everything the results screen and the share card will need, captured
       once: the reveal payload plus the two image URLs, which only the
       question payload carries. */
    state.answers[state.index] = {
      n: state.index + 1,
      correct: data.correct,
      chosen: chosen,
      earlier: data.earlier,
      gap: data.gap,
      gapText: data.gapText,
      insight: data.insight,
      surprise: data.surprise,
      difficulty: data.difficulty,
      successRate: data.successRate,
      a: data.a, b: data.b,
      imgA: question.a.img, imgB: question.b.img,
      formA: question.a.form, formB: question.b.form
    };

    [['a', els.a], ['b', els.b]].forEach(function (entry) {
      var key = entry[0];
      var card = entry[1];
      var info = data[key];
      var isEarlier = data.earlier === key;
      card.classList.add('is-revealed', 'is-locked');
      card.disabled = true;
      if (isEarlier) { card.classList.add('is-earlier'); }
      if (key === chosen && !data.correct) { card.classList.add('is-chosen-wrong'); }
      card.querySelector('[data-verdict]').textContent = isEarlier ? 'Earlier' : 'Later';
      card.querySelector('[data-label]').innerHTML = labelMarkup(info);
    });

    els.question.textContent = data.correct ? 'Correct.' : 'Not this time.';
    els.verdict.textContent = data.correct ? 'You got it' : 'The other one';
    els.verdict.className = 'reveal-verdict ' + (data.correct ? 'is-hit' : 'is-miss');
    els.insight.textContent = data.insight || '';
    var bits = [];
    if ((data.insight || '').indexOf(data.gapText) === -1) { bits.push(data.gapText); }
    if (data.successRate !== null && typeof data.successRate !== 'undefined') {
      bits.push(data.successRate + '% of players got this right');
    }
    els.gap.textContent = bits.join(' · ');
    els.gap.hidden = bits.length === 0;
    els.reveal.hidden = false;
    requestAnimationFrame(function () { els.reveal.classList.add('is-shown'); });

    if (mode === 'endless') {
      state.run = data.correct ? state.run + 1 : 0;
      state.bestRun = Math.max(state.bestRun, state.run);
      state.answered += 1;
      /* Banked immediately. Endless has no natural end, so waiting for one
         meant these answers were never counted at all. */
      PP.recordEndlessAnswer(state.answers[state.index], state.bestRun);
      /* Answered into this page, so a later visit starts after it. */
      PP.markEndlessPage(museum, state.page + 1);
      els.sub.textContent = endlessSubtitle();
      maybeInterstitial();
    }
    paintPips();

    var last = mode === 'daily' && state.index === state.questions.length - 1;
    els.next.hidden = false;
    els.next.textContent = last ? 'See your result' : 'Next';
    els.next.focus({ preventScroll: true });
    if (mode === 'endless' && els.end) { els.end.hidden = false; }

    PP.track('answer', {
      mode: mode, correct: data.correct, difficulty: data.difficulty,
      surprise: data.surprise
    });
  }

  function labelMarkup(info) {
    var lines = [];
    lines.push('<span class="choice-year">' + escapeHtml(info.yearText) + '</span>');
    if (info.date && info.date !== info.yearText) {
      lines.push('<p class="choice-date">' + escapeHtml(info.date) + '</p>');
    }
    lines.push('<p class="choice-title">' + escapeHtml(info.title) + '</p>');
    if (info.artist) {
      lines.push('<p class="choice-artist">' + escapeHtml(info.artist) + '</p>');
    }
    /* The museum is named, not linked. It used to be a link straight to the
       collection page, in the same tab, mid-round -- which threw away the run
       you were in. Everything here that does navigate opens a new tab. */
    var credit = '<span class="choice-museum">' + escapeHtml(info.museumName) + '</span>';
    if (info.objectUrl) {
      credit += ' · <a href="' + escapeAttr(info.objectUrl) +
        '" target="_blank" rel="noopener">See the object</a>';
    }
    if (info.licence) {
      credit += ' · <a href="' + escapeAttr(info.licenceUrl) +
        '" rel="license noopener" target="_blank">' + escapeHtml(info.licence) + '</a>';
    }
    lines.push('<p class="choice-credit">' + credit + '</p>');
    return lines.join('');
  }

  /* ---------- advancing ---------- */

  function advance() {
    if (state.finished) { return; }
    if (mode === 'daily' && state.index >= state.questions.length - 1) {
      return finishDaily();
    }
    if (mode === 'endless' && state.index >= state.questions.length - 1) {
      return loadMore();
    }
    show(state.index + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function loadMore() {
    els.next.disabled = true;
    fetch(roundUrl(state.page + 1))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        els.next.disabled = false;
        var more = data.questions || [];
        if (!more.length) {
          state.exhausted = true;
          PP.markEndlessPage(museum, 0);
          return finishEndless();
        }
        state.page += 1;
        state.questions = state.questions.concat(more);
        show(state.index + 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function () { els.next.disabled = false; });
  }

  /* An interstitial may only appear between rounds, never between a question
     and its answer. In v0 the slot renders nothing at all. */
  function maybeInterstitial() {
    var answered = state.answers.filter(Boolean).length;
    if (state.adShown || answered < state.adAfter) { return; }
    state.adShown = true;
    PP.track('endless_interstitial_point', { answered: answered });
  }

  /* ---------- results ---------- */

  function score() {
    return state.answers.filter(function (a) { return a && a.correct; }).length;
  }

  function emojiGrid() {
    return state.answers.map(function (a) {
      return a && a.correct ? '🟩' : '⬜';
    }).join('');
  }

  function finishDaily() {
    state.finished = true;
    var total = score();
    var record = PP.recordDaily(state.date, edition, total, state.answers);
    els.board.hidden = true;
    els.reveal.hidden = true;
    els.next.hidden = true;
    els.question.hidden = true;
    els.pips.hidden = true;
    if (els.foot) { els.foot.hidden = true; }
    paintPips();

    els.results.hidden = false;
    paintResults(total, record);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    PP.track('daily_complete', { score: total, edition: edition, puzzle: state.puzzle });

    fetch('/api/daily/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: state.date, edition: edition, score: total, session: PP.session()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.standing = data;
        paintResults(total, record);
      })
      .catch(function () {});
  }

  /**
   * Ending an endless run.
   *
   * Two ways in: the player presses "End run", or the pool genuinely runs out
   * (23,002 questions later). Either way the answers are already banked, so
   * this counts the run and shows what it added up to.
   */
  function finishEndless() {
    state.finished = true;
    PP.endEndlessRun(state.bestRun);
    els.board.hidden = true;
    els.question.hidden = true;
    els.reveal.hidden = true;
    els.next.hidden = true;
    if (els.end) { els.end.hidden = true; }
    if (els.foot) { els.foot.hidden = true; }
    els.results.hidden = false;

    var right = score();
    var accuracy = state.answered ? Math.round((100 * right) / state.answered) : 0;
    var learned = surprise();
    var museum = root.dataset.museum || '';
    var name = museum ? escapeHtml(museumName(museum)) + ' endless' : 'Endless';

    els.results.innerHTML =
      '<div class="results">' +
      '<p class="eyebrow">' + name + '</p>' +
      '<p class="score-line">' + state.bestRun + '</p>' +
      '<p class="score-caption">longest run of the session</p>' +
      (state.exhausted
        ? '<p class="score-standing">You have seen every question in this pool. ' +
          'That is genuinely all of them.</p>'
        : '<p class="score-standing">Run ended. Everything you answered is already ' +
          'in <a href="/stats">your stats</a>.</p>') +
      (learned
        ? '<div class="learned">' + learnedMarkup(learned) + '</div>'
        : '') +
      '<div class="result-grid">' +
        '<div class="result-cell"><b>' + state.answered + '</b><span>Answered</span></div>' +
        '<div class="result-cell"><b>' + right + '</b><span>Correct</span></div>' +
        '<div class="result-cell"><b>' + accuracy + '%</b><span>Accuracy</span></div>' +
      '</div>' +
      (state.answered
        ? '<h2 class="review-title">Your last ten, question by question</h2>' +
          '<p class="review-hint">Tap any question to see what the two objects actually were.</p>' +
          '<div class="review-strip" id="review-strip">' + reviewStrip(10) + '</div>' +
          '<div id="review-slot"></div>'
        : '') +
      '<div class="results-actions results-onward">' +
        '<a class="btn" href="/daily">Play the Daily Challenge</a>' +
        '<a class="btn btn-quiet" href="/stats">Your stats</a>' +
        '<a class="btn btn-quiet" href="#play">Another collection</a>' +
      '</div></div>';
    wireReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    PP.track('endless_end', {
      answered: state.answered, best: state.bestRun, exhausted: state.exhausted,
    });
  }

  var CAPTIONS = [
    'A clean sweep.', 'Very nearly perfect.', 'A good eye.', 'Solid instincts.',
    'Respectable.', 'Middling — the trap worked.', 'The centuries blurred.',
    'A rough morning in the archive.'
  ];

  function caption(total) {
    if (total === 10) { return CAPTIONS[0]; }
    if (total === 9) { return CAPTIONS[1]; }
    if (total === 8) { return CAPTIONS[2]; }
    if (total === 7) { return CAPTIONS[3]; }
    if (total >= 5) { return CAPTIONS[4]; }
    if (total >= 3) { return CAPTIONS[5]; }
    if (total >= 1) { return CAPTIONS[6]; }
    return CAPTIONS[7];
  }

  /* ---------- the two headline sentences ---------- */

  /**
   * How you did against everyone else, in a sentence rather than a number.
   *
   * The server sends one figure -- the share of today's players this score
   * beat outright -- and nothing about how many people that is. Before the day
   * has enough players to rank against, we say so without saying how few:
   * a game that tells you five people played today has told you the wrong five
   * things about itself.
   */
  function standingLine(total) {
    var standing = state.standing;
    if (!standing) { return null; }
    if (!standing.ranked || standing.beat === null || typeof standing.beat === 'undefined') {
      return {
        big: '—',
        bigLabel: 'Beaten today',
        text: 'Too early to rank today — your standing appears once enough people have played.'
      };
    }
    var beat = standing.beat;
    if (beat >= 50) {
      return {
        big: beat + '%',
        bigLabel: 'Beaten today',
        text: 'You did better than ' + beat + '% of today’s players.'
      };
    }
    if (beat === 0) {
      return {
        big: '0%',
        bigLabel: 'Beaten today',
        text: 'Everybody is ahead of you today. There is always tomorrow.'
      };
    }
    return {
      big: beat + '%',
      bigLabel: 'Beaten today',
      text: 'You did better than ' + beat + '% of today’s players. There is always tomorrow.'
    };
  }

  /**
   * The one fact worth repeating at a table.
   *
   * Ranked so the winner is the pair that was genuinely counter-intuitive: one
   * the player got wrong, or one the build step flagged as reading backwards,
   * or one most other players missed — and among those, the closest call.
   */
  function surprise() {
    var best = null;
    var bestScore = -1;
    state.answers.forEach(function (answer) {
      if (!answer) { return; }
      var points = 0;
      if (!answer.correct) { points += 50; }
      if (answer.surprise) { points += 40; }
      if (answer.successRate !== null && typeof answer.successRate === 'number') {
        points += Math.max(0, 60 - answer.successRate) / 2;
      }
      if (answer.gap <= 25) { points += 15; }
      points += Math.min(10, (answer.difficulty || 0) * 2);
      if (points > bestScore) { bestScore = points; best = answer; }
    });
    if (!best) { return null; }
    var earlier = best[best.earlier];
    var later = best[best.earlier === 'a' ? 'b' : 'a'];
    var earlierForm = (best.earlier === 'a' ? best.formA : best.formB).toLowerCase();
    var laterForm = (best.earlier === 'a' ? best.formB : best.formA).toLowerCase();
    var subject = earlierForm === laterForm
      ? '“' + shortTitle(earlier.title) + '”'
      : 'the ' + earlierForm + ' “' + shortTitle(earlier.title) + '”';
    var object = laterForm === earlierForm
      ? '“' + shortTitle(later.title) + '”'
      : 'the ' + laterForm + ' “' + shortTitle(later.title) + '”';
    var line = 'Today I learned that ' + subject + ' (' + earlier.yearText + ') is older than ' +
      object + ' (' + later.yearText + ').';
    var note = null;
    if (best.successRate !== null && typeof best.successRate === 'number' && best.successRate < 55) {
      note = 'Only ' + best.successRate + '% of players got that one right.';
    } else if (!best.correct) {
      note = 'It fooled me, at least.';
    } else if (best.surprise) {
      note = 'The older one is the one that looks newer.';
    } else {
      note = best.gapText.charAt(0).toUpperCase() + best.gapText.slice(1) + '.';
    }
    return { line: line, note: note, answer: best };
  }

  /* ---------- results markup ---------- */

  function paintResults(total, record) {
    els.results.innerHTML = resultsMarkup(total, record);
    wireResults(total, record);
    drawShareCard(total);
  }

  /** The answered questions as tiles. `limit` keeps an endless run readable. */
  function reviewStrip(limit) {
    var answered = [];
    state.answers.forEach(function (answer, index) {
      if (answer) { answered.push({ answer: answer, index: index }); }
    });
    if (limit && answered.length > limit) { answered = answered.slice(-limit); }
    return answered.map(function (entry) {
      var hit = entry.answer.correct;
      var n = entry.index + 1;
      return '<button class="review-tile' + (hit ? ' is-hit' : ' is-miss') +
        '" type="button" data-review="' + entry.index + '" ' +
        'aria-label="Question ' + n + ', ' + (hit ? 'correct' : 'wrong') +
        '. Show the two objects."><span class="review-n">' + n + '</span>' +
        '<span class="review-mark" aria-hidden="true">' + (hit ? '✓' : '✕') + '</span>' +
        '</button>';
    }).join('');
  }

  function reviewDetail(index) {
    var answer = state.answers[index];
    if (!answer) { return ''; }
    var pickedLabel = answer.correct
      ? 'You picked the older one.'
      : 'You picked the ' + (answer.chosen === answer.earlier ? 'older' : 'later') + ' one.';
    function side(key) {
      var info = answer[key];
      var isEarlier = answer.earlier === key;
      var picked = answer.chosen === key;
      return '<figure class="review-obj' + (isEarlier ? ' is-earlier' : '') +
        (picked ? ' is-picked' : '') + '">' +
        '<span class="review-flag">' + (isEarlier ? 'Earlier' : 'Later') +
        (picked ? ' · your pick' : '') + '</span>' +
        '<span class="review-frame"><img src="' + escapeAttr(key === 'a' ? answer.imgA : answer.imgB) +
        '" alt="' + escapeAttr(info.title) + '" loading="lazy" decoding="async"></span>' +
        '<figcaption><span class="review-year">' + escapeHtml(info.yearText) + '</span>' +
        '<b>' + escapeHtml(info.title) + '</b>' +
        '<span class="review-meta">' + escapeHtml(info.artist || 'Maker unrecorded') + ' · ' +
        escapeHtml(info.museumName) + '</span>' +
        '<a class="review-link" href="' + escapeAttr(info.objectUrl) +
        '" target="_blank" rel="noopener">See it at the museum &rarr;</a>' +
        '</figcaption></figure>';
    }
    return '<div class="review-detail" id="review-detail">' +
      '<p class="review-head"><b>Question ' + (index + 1) + '</b> · ' + escapeHtml(pickedLabel) + '</p>' +
      '<div class="review-pair">' + side('a') + side('b') + '</div>' +
      '<p class="review-insight">' + escapeHtml(answer.insight || answer.gapText) + '</p>' +
      '</div>';
  }

  /**
   * The takeaway, with the two objects it is about.
   *
   * A sentence naming two artworks is worth much less than a sentence naming
   * two artworks you can see. The earlier one is shown first, always, so the
   * claim reads left to right.
   */
  function learnedMarkup(learned) {
    var answer = learned.answer;
    var earlierKey = answer.earlier;
    var laterKey = earlierKey === 'a' ? 'b' : 'a';
    function thumb(key, flag) {
      var info = answer[key];
      var src = key === 'a' ? answer.imgA : answer.imgB;
      return '<figure class="learned-obj">' +
        '<span class="learned-frame"><img src="' + escapeAttr(src) + '" alt="' +
        escapeAttr(info.title) + '" loading="lazy" decoding="async"></span>' +
        '<figcaption><span class="learned-flag">' + flag + '</span>' +
        '<span class="learned-year">' + escapeHtml(info.yearText) + '</span>' +
        '<b>' + escapeHtml(shortTitle(info.title)) + '</b></figcaption></figure>';
    }
    return '<div class="learned-pair">' +
      thumb(earlierKey, 'Older') +
      '<span class="learned-vs" aria-hidden="true">&rarr;</span>' +
      thumb(laterKey, 'Newer') +
      '</div>' +
      '<p class="learned-line">' + escapeHtml(learned.line) + '</p>' +
      '<p class="learned-note">' + escapeHtml(learned.note) + '</p>';
  }

  function resultsMarkup(total, record) {
    var standing = standingLine(total);
    var learned = surprise();
    var name = edition ? escapeHtml(museumName(edition)) + ' edition' : 'Daily Challenge';

    return '' +
      '<div class="results">' +
      '<p class="eyebrow">' + name + ' · Puzzle #' + state.puzzle + '</p>' +
      '<p class="score-line">' + total + '<span>/' + state.questions.length + '</span></p>' +
      '<p class="score-caption">' + caption(total) + '</p>' +

      (standing ? '<p class="score-standing">' + escapeHtml(standing.text) + '</p>' : '') +

      (learned ? '<div class="learned">' + learnedMarkup(learned) + '</div>' : '') +

      '<div class="result-grid">' +
        '<div class="result-cell"><b>' + record.streak + '</b><span>Day streak</span></div>' +
        '<div class="result-cell"><b>' + record.best + '</b><span>Best streak</span></div>' +
        '<div class="result-cell"><b>' + (standing && standing.big ? escapeHtml(standing.big) : '—') +
          '</b><span>' + escapeHtml(standing ? standing.bigLabel : 'Beaten today') + '</span></div>' +
      '</div>' +

      '<h2 class="review-title">Your ten, question by question</h2>' +
      '<p class="review-hint">Tap any question to see what the two objects actually were.</p>' +
      '<div class="review-strip" id="review-strip">' + reviewStrip() + '</div>' +
      '<div id="review-slot"></div>' +

      '<h2 class="review-title">Share it</h2>' +
      '<div class="share-preview"><canvas id="share-canvas" width="1200" height="630" ' +
      'role="img" aria-label="Your result as a shareable card"></canvas></div>' +
      '<div class="results-actions">' +
        '<button class="btn" id="share" type="button">Share result</button>' +
        '<button class="btn btn-quiet" id="share-copy" type="button">Copy text</button>' +
        '<button class="btn btn-quiet" id="share-save" type="button">Save image</button>' +
      '</div>' +
      '<p class="share-note" id="share-note">A card with your score, the ten, and the ' +
      'thing you learned — plus a link back here.</p>' +

      '<div class="results-actions results-onward">' +
        '<a class="btn btn-quiet" href="/endless">Keep going in Endless</a>' +
        '<a class="btn btn-quiet" href="/stats">Your stats</a>' +
        '<a class="btn btn-quiet" href="#play">Another collection</a>' +
      '</div>' +
      reminderMarkup(record) +
      '</div>';
  }

  /* Never on a first visit: the offer only appears once somebody has come back
     several days running, and only once. */
  function reminderMarkup(record) {
    var after = parseInt(root.dataset.reminderAfter || '3', 10);
    var eligible = record.played >= after && !record.reminderAsked && !record.reminderDismissed;
    var supported = 'Notification' in window && Notification.permission === 'default';
    if (!eligible || !supported) { return ''; }
    return '<div class="reminder is-shown" id="reminder">' +
      '<p>You have played ' + record.played + ' days. Want one reminder a day?</p>' +
      '<span><button class="btn btn-quiet" id="reminder-yes" type="button">Remind me</button> ' +
      '<button class="btn btn-quiet" id="reminder-no" type="button">No thanks</button></span></div>';
  }

  function wireReview() {
    var strip = document.getElementById('review-strip');
    var slot = document.getElementById('review-slot');
    var open = -1;
    if (!strip || !slot) { return; }
    strip.addEventListener('click', function (event) {
      var tile = event.target.closest('[data-review]');
      if (!tile) { return; }
      var index = parseInt(tile.dataset.review, 10);
      Array.prototype.forEach.call(strip.children, function (child) {
        child.classList.toggle('is-open', child === tile && open !== index);
      });
      if (open === index) { slot.innerHTML = ''; open = -1; return; }
      open = index;
      slot.innerHTML = reviewDetail(index);
      PP.track('review_open', { question: index + 1, correct: state.answers[index].correct });
    });
  }

  function wireResults(total, record) {
    wireReview();

    var share = document.getElementById('share');
    if (share) { share.addEventListener('click', function () { doShare(total); }); }
    var copy = document.getElementById('share-copy');
    if (copy) { copy.addEventListener('click', function () { copyText(total); }); }
    var save = document.getElementById('share-save');
    if (save) { save.addEventListener('click', saveCard); }

    var yes = document.getElementById('reminder-yes');
    var no = document.getElementById('reminder-no');
    if (yes) {
      yes.addEventListener('click', function () {
        PP.update(function (r) { r.reminderAsked = true; });
        Notification.requestPermission().then(function (result) {
          PP.track('reminder_permission', { result: result });
          var box = document.getElementById('reminder');
          if (box) { box.classList.remove('is-shown'); }
        });
      });
    }
    if (no) {
      no.addEventListener('click', function () {
        PP.update(function (r) { r.reminderDismissed = true; });
        var box = document.getElementById('reminder');
        if (box) { box.classList.remove('is-shown'); }
      });
    }
  }

  /* ---------- sharing ----------
     Three things go out together: a sentence somebody would actually repeat, a
     link that opens the same puzzle, and a card that looks like the game. */

  function shareUrl() {
    return location.origin + (edition ? '/daily/' + edition : '/daily');
  }

  function shareText(total) {
    var label = edition ? 'Past Perfect · ' + museumName(edition) : 'Past Perfect';
    var learned = surprise();
    var standing = standingLine(total);
    var lines = [label + ' #' + state.puzzle + ' — ' + total + '/' + state.questions.length];
    lines.push(emojiGrid());
    if (learned) { lines.push(learned.line); }
    if (standing && standing.text.indexOf('better than') !== -1) { lines.push(standing.text); }
    lines.push(shareUrl());
    return lines.join('\n');
  }

  var CARD = {
    light: {
      ground: '#FBF6EC', panel: '#F5EDDF', ink: '#17140F', soft: '#6F675A',
      accent: '#A8432A', hit: '#3E6B4C', miss: '#E3D8C4'
    },
    dark: {
      ground: '#100F0D', panel: '#1A1917', ink: '#F3EEE4', soft: '#8B8377',
      accent: '#D98A4E', hit: '#7FB08C', miss: '#2C2A27'
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Greedy wrap that measures before it draws, so the caller can lay out. */
  function lines(ctx, text, maxWidth, maxLines) {
    var words = String(text).split(/\s+/);
    var out = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var attempt = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(attempt).width > maxWidth && line) {
        out.push(line);
        line = words[i];
        if (out.length === maxLines) { break; }
      } else {
        line = attempt;
      }
    }
    if (out.length < maxLines) { out.push(line); }
    else { out[maxLines - 1] = out[maxLines - 1].replace(/[.,;:]?$/, '') + '…'; }
    return out;
  }

  function drawLines(ctx, rows, x, y, lineHeight) {
    rows.forEach(function (row, index) { ctx.fillText(row, x, y + index * lineHeight); });
    return y + rows.length * lineHeight;
  }

  /**
   * The share card.
   *
   * Laid out from fixed anchors rather than from wherever the previous block
   * happened to end: the learned sentence is the only variable-height thing on
   * it, and it is capped, so nothing below it can ever be overdrawn.
   */
  function drawShareCard(total) {
    var canvas = document.getElementById('share-canvas');
    if (!canvas || !canvas.getContext) { return; }
    var ctx = canvas.getContext('2d');
    var c = CARD[PP.theme() === 'dark' ? 'dark' : 'light'];
    var W = canvas.width;
    var H = canvas.height;
    var serif = 'Georgia, "Times New Roman", serif';
    var sans = 'Helvetica, Arial, sans-serif';
    var pad = 76;
    var wide = W - pad * 2;

    ctx.fillStyle = c.ground;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, H - 14, W, 14);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    ctx.fillStyle = c.soft;
    ctx.font = '22px ' + sans;
    ctx.fillText(
      (edition ? museumName(edition).toUpperCase() + ' EDITION' : 'DAILY CHALLENGE') +
        '   ·   PUZZLE #' + state.puzzle,
      pad, 78,
    );

    ctx.fillStyle = c.ink;
    ctx.font = '112px ' + serif;
    var scoreText = total + '/' + state.questions.length;
    ctx.fillText(scoreText, pad, 190);
    var scoreWidth = ctx.measureText(scoreText).width;

    ctx.fillStyle = c.accent;
    ctx.font = 'italic 34px ' + serif;
    ctx.fillText(caption(total), pad + scoreWidth + 26, 184);

    /* The ten, as squares rather than emoji: the same information, and it
       survives being rendered by somebody else's font stack. */
    var box = 40;
    var gap = 11;
    state.answers.forEach(function (answer, index) {
      ctx.fillStyle = answer && answer.correct ? c.hit : c.miss;
      roundRect(ctx, pad + index * (box + gap), 224, box, box, 6);
      ctx.fill();
    });

    var learned = surprise();
    if (learned) {
      ctx.fillStyle = c.ink;
      ctx.font = '34px ' + serif;
      var body = lines(ctx, learned.line, wide, 3);
      var end = drawLines(ctx, body, pad, 336, 44);
      ctx.fillStyle = c.soft;
      ctx.font = '24px ' + sans;
      drawLines(ctx, lines(ctx, learned.note, wide, 1), pad, end + 6, 32);
    }

    var standing = standingLine(total);
    if (standing) {
      ctx.fillStyle = c.accent;
      ctx.font = '26px ' + sans;
      drawLines(ctx, lines(ctx, standing.text, wide, 1), pad, 526, 34);
    }

    ctx.fillStyle = c.ink;
    ctx.font = '28px ' + serif;
    ctx.fillText('Past Perfect', pad, H - 48);
    ctx.fillStyle = c.soft;
    ctx.font = '22px ' + sans;
    ctx.textAlign = 'right';
    ctx.fillText(shareUrl().replace(/^https?:\/\//, ''), W - pad, H - 48);
    ctx.textAlign = 'left';
  }

  function cardBlob() {
    var canvas = document.getElementById('share-canvas');
    return new Promise(function (resolve) {
      if (!canvas || !canvas.toBlob) { return resolve(null); }
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/png');
    });
  }

  function note(message) {
    var box = document.getElementById('share-note');
    if (box) { box.textContent = message; }
  }

  function doShare(total) {
    var text = shareText(total);
    PP.track('share', { score: total, edition: edition, mode: 'share' });
    cardBlob().then(function (blob) {
      var file = blob && window.File
        ? new File([blob], 'past-perfect-' + state.puzzle + '.png', { type: 'image/png' })
        : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        navigator.share({ title: 'Past Perfect', text: text, files: [file] })
          .catch(function () {});
        return;
      }
      if (navigator.share) {
        navigator.share({ title: 'Past Perfect', text: text, url: shareUrl() })
          .catch(function () {});
        return;
      }
      copyText(total);
    });
  }

  function copyText(total) {
    var text = shareText(total);
    PP.track('share', { score: total, edition: edition, mode: 'copy' });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        note('Copied. Go and ruin someone’s morning.');
      }).catch(function () { note(text); });
      return;
    }
    note(text);
  }

  function saveCard() {
    PP.track('share', { edition: edition, mode: 'save' });
    cardBlob().then(function (blob) {
      if (!blob) { return note('This browser cannot save the card.'); }
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'past-perfect-' + state.puzzle + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      note('Saved as a PNG.');
    });
  }

  /* ---------- input ---------- */

  els.a.addEventListener('click', function () { choose('a'); });
  els.b.addEventListener('click', function () { choose('b'); });
  els.next.addEventListener('click', advance);
  if (els.end) { els.end.addEventListener('click', finishEndless); }
  wireZoom();

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) { return; }
    var key = event.key;
    if (!els.lightbox.hidden) {
      if (key === 'Escape') { event.preventDefault(); closeZoom(); }
      else if (key === '+' || key === '=') { event.preventDefault(); setZoom(zoom.scale * 1.6, zoom.x * 1.6, zoom.y * 1.6); }
      else if (key === '-') { event.preventDefault(); setZoom(zoom.scale / 1.6, zoom.x / 1.6, zoom.y / 1.6); }
      return;
    }
    if (key === 'z' || key === 'Z') { event.preventDefault(); openZoom('a'); }
    else if (key === 'x' || key === 'X') { event.preventDefault(); openZoom('b'); }
    else if (key === 'ArrowLeft' || key === '1') { event.preventDefault(); choose('a'); }
    else if (key === 'ArrowRight' || key === '2') { event.preventDefault(); choose('b'); }
    else if ((key === 'Enter' || key === ' ') && !els.next.hidden) {
      event.preventDefault(); advance();
    }
  });

  start();
})();
