/* Past Perfect — the board.
   Questions arrive without titles, makers, dates or museums. The reveal for a
   question is fetched only after the player has committed to an answer, so
   there is nothing in the page to read ahead. */
(function () {
  'use strict';

  var root = document.getElementById('game');
  if (!root) { return; }

  var mode = root.dataset.mode;
  var edition = root.dataset.edition || '';
  var museum = root.dataset.museum || '';

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
    b: document.getElementById('choice-b')
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
    adShown: false,
    adAfter: 10
  };

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
    fetch(roundUrl(0), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { return fail(res.data && res.data.message); }
        state.questions = res.data.questions || [];
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
      img.classList.remove('is-ready');
      img.alt = 'Museum object ' + entry[0].toUpperCase() + ', unlabelled';
      if (side.w && side.h) { img.width = side.w; img.height = side.h; }
      img.onload = function () { img.classList.add('is-ready'); };
      img.src = side.img;
      if (img.complete) { img.classList.add('is-ready'); }
    });

    if (mode === 'endless') {
      els.sub.textContent = state.run + ' in a row · best ' + state.bestRun;
    }
    paintPips();
    preload(index + 1);
  }

  function preload(index) {
    var question = state.questions[index];
    if (!question) { return; }
    ['a', 'b'].forEach(function (side) { new Image().src = question[side].img; });
  }

  /* ---------- answering ---------- */

  function choose(side) {
    if (state.locked || state.finished) { return; }
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
    state.answers[state.index] = {
      correct: data.correct, a: data.a, b: data.b, chosen: chosen
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
      els.sub.textContent = state.run + ' in a row · best ' + state.bestRun;
      maybeInterstitial();
    }
    paintPips();

    var last = mode === 'daily' && state.index === state.questions.length - 1;
    els.next.hidden = false;
    els.next.textContent = last ? 'See your result' : 'Next';
    els.next.focus({ preventScroll: true });

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
    var credit = '<a href="' + escapeAttr(info.museumPath) + '">' +
      escapeHtml(info.museumName) + '</a>';
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

  function escapeHtml(value) {
    return String(value === null || typeof value === 'undefined' ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }

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
    els.results.innerHTML = resultsMarkup(total, record, null);
    wireResults(total, record);
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
        els.results.innerHTML = resultsMarkup(total, record, data);
        wireResults(total, record);
      })
      .catch(function () {});
  }

  function finishEndless() {
    state.finished = true;
    PP.recordEndless(state.bestRun, state.answers);
    els.board.hidden = true;
    els.question.hidden = true;
    els.next.hidden = true;
    if (els.foot) { els.foot.hidden = true; }
    els.results.hidden = false;
    els.results.innerHTML =
      '<div class="results"><p class="eyebrow">Endless</p>' +
      '<p class="score-line">' + state.bestRun + '</p>' +
      '<p class="score-caption">longest run</p>' +
      '<p>You have seen every question in this pool. That is genuinely all of them.</p>' +
      '<div class="results-actions"><a class="btn" href="/daily">Play the daily</a>' +
      '<a class="btn btn-quiet" href="/stats">Your stats</a></div></div>';
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

  function resultsMarkup(total, record, standing) {
    var percentile = '—';
    var percentileNote = 'Percentile appears once enough people have played today.';
    if (standing && standing.percentile !== null && typeof standing.percentile !== 'undefined') {
      percentile = standing.percentile + '%';
      percentileNote = 'You are ahead of ' + standing.percentile + '% of today’s ' +
        standing.players + ' players.';
    } else if (standing) {
      percentileNote = standing.players + ' played today; percentiles start at ' +
        standing.minSample + '.';
    }
    var name = edition ? 'the ' + escapeHtml(root.dataset.edition) + ' edition' : 'today';
    return '' +
      '<div class="results">' +
      '<p class="eyebrow">Puzzle #' + state.puzzle + '</p>' +
      '<p class="score-line">' + total + '<span>/' + state.questions.length + '</span></p>' +
      '<p class="score-caption">' + caption(total) + '</p>' +
      '<div class="result-grid">' +
        '<div class="result-cell"><b>' + record.streak + '</b><span>Day streak</span></div>' +
        '<div class="result-cell"><b>' + record.best + '</b><span>Best streak</span></div>' +
        '<div class="result-cell"><b>' + percentile + '</b><span>Percentile</span></div>' +
      '</div>' +
      '<p class="emoji-grid">' + emojiGrid() + '</p>' +
      '<div class="results-actions">' +
        '<button class="btn" id="share" type="button">Share result</button>' +
        '<a class="btn btn-quiet" href="/endless">Endless mode</a>' +
        '<a class="btn btn-quiet" href="/stats">Your stats</a>' +
      '</div>' +
      '<p class="share-note" id="share-note">' + percentileNote + '</p>' +
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

  function wireResults(total, record) {
    var share = document.getElementById('share');
    if (share) { share.addEventListener('click', function () { doShare(total); }); }
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

  function shareText(total) {
    var label = edition ? 'Past Perfect · ' + root.dataset.edition : 'Past Perfect';
    return label + ' #' + state.puzzle + ' — ' + total + '/' + state.questions.length +
      '\n' + emojiGrid() + '\n' + location.origin + (edition ? '/daily/' + edition : '/daily');
  }

  function doShare(total) {
    var text = shareText(total);
    var note = document.getElementById('share-note');
    PP.track('share', { score: total, edition: edition });
    if (navigator.share) {
      navigator.share({ title: 'Past Perfect', text: text }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (note) { note.textContent = 'Copied. Go and ruin someone’s morning.'; }
      }).catch(function () { if (note) { note.textContent = text; } });
      return;
    }
    if (note) { note.textContent = text; }
  }

  /* ---------- input ---------- */

  els.a.addEventListener('click', function () { choose('a'); });
  els.b.addEventListener('click', function () { choose('b'); });
  els.next.addEventListener('click', advance);

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) { return; }
    var key = event.key;
    if (key === 'ArrowLeft' || key === '1') { event.preventDefault(); choose('a'); }
    else if (key === 'ArrowRight' || key === '2') { event.preventDefault(); choose('b'); }
    else if ((key === 'Enter' || key === ' ') && !els.next.hidden) {
      event.preventDefault(); advance();
    }
  });

  start();
})();
