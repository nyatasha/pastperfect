/* Past Perfect — the stats page.
   Everything here is computed from the local record. Nothing is fetched, and
   nothing is sent. */
(function () {
  'use strict';

  var root = document.getElementById('stats-root');
  if (!root || !window.PP) { return; }

  var MUSEUMS = readJson('museum-data') || {};
  var minAnswers = parseInt(root.dataset.minAnswers || '40', 10);
  var reminderAfter = parseInt(root.dataset.reminderAfter || '3', 10);
  var record = PP.load();

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) { return null; }
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function esc(value) {
    return String(value === null || typeof value === 'undefined' ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pct(part, whole) {
    return whole ? Math.round(100 * part / whole) : 0;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function yearLabel(year) {
    if (year === null || typeof year === 'undefined') { return '—'; }
    return year < 0 ? Math.abs(year) + ' BC' : String(year);
  }

  /* ---------- icons ----------
     Twenty-four-pixel line drawings, one per achievement, drawn rather than
     set in an emoji font so they inherit the ink colour and look like part of
     the same object as everything else on the page. */

  /* Each icon is a list of shapes rather than a string of markup, because the
     same drawing has to come out twice: as SVG on this page, and as strokes on
     the share canvas. `p` is a path, `c` is [cx, cy, r]. */
  var ICONS = {
    sunrise: [{ p: 'M12 4v4M5 9l2 2M19 9l-2 2M3 18h18M7.5 18a4.5 4.5 0 0 1 9 0' }],
    ticket: [{ p: 'M3 9V7h18v2a2 2 0 0 0 0 6v2H3v-2a2 2 0 0 0 0-6Z' }, { p: 'M12 8v1M12 12v1M12 16v1' }],
    flame: [{ p: 'M12 3s5 4 5 8a5 5 0 0 1-10 0c0-1.6.7-2.9 1.6-4 .3 1.2 1 2 1.9 2 0-2.4.7-4.6 1.5-6Z' }],
    rosette: [{ c: [12, 9, 5] }, { p: 'm9 13.5-1.5 7L12 18l4.5 2.5L15 13.5' }],
    eye: [{ p: 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }, { c: [12, 12, 2.6] }],
    telescope: [{ p: 'm3 14 12-7 3 5-12 7Z' }, { p: 'M9.5 15.5 8 21M14 13l2 8M5 17.5 3 21' }],
    skull: [
      { p: 'M6 13.5A6 6 0 1 1 18 13.5V16l-1.5 1v2h-9v-2L6 16Z' },
      { c: [9.5, 12, 1.3] }, { c: [14.5, 12, 1.3] }
    ],
    hourglass: [{ p: 'M7 3h10M7 21h10M8 3c0 4 4 5 4 9s-4 5-4 9M16 3c0 4-4 5-4 9s4 5 4 9' }],
    camera: [{ p: 'M3 8h4l1.5-2h7L17 8h4v11H3Z' }, { c: [12, 13, 3.4] }],
    obelisk: [{ p: 'M12 2 9 8v13h6V8Z' }, { p: 'M7 21h10' }],
    globe: [{ c: [12, 12, 9] }, { p: 'M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18' }],
    stack: [{ p: 'm12 3 9 4.5-9 4.5-9-4.5Z' }, { p: 'm3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5' }],
    compass: [{ c: [12, 12, 9] }, { p: 'm15.5 8.5-2 5-5 2 2-5Z' }],
    scales: [{ p: 'M12 4v16M7 20h10M4 8h16M6.5 8 4 14h5ZM17.5 8 15 14h5Z' }],
    key: [{ c: [8, 12, 3.5] }, { p: 'M11.5 12H21M18 12v3M15 12v2.5' }],
    moon: [{ p: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z' }]
  };

  function shapes(name) { return ICONS[name] || ICONS.rosette; }

  function icon(name) {
    var body = shapes(name).map(function (shape) {
      return shape.p
        ? '<path d="' + shape.p + '"/>'
        : '<circle cx="' + shape.c[0] + '" cy="' + shape.c[1] + '" r="' + shape.c[2] + '"/>';
    }).join('');
    return '<svg class="ach-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + '</svg>';
  }

  /* ---------- empty state ---------- */

  if (!record.played && !record.answers) {
    root.innerHTML =
      '<div class="results"><p class="score-caption">Nothing recorded yet.</p>' +
      '<p>Play a round and this page fills in.</p>' +
      '<div class="results-actions"><a class="btn" href="/daily">Play today’s ten</a>' +
      '<a class="btn btn-quiet" href="/endless">Endless mode</a></div></div>';
    return;
  }

  var eye = PP.artEye(record, minAnswers);
  var lastPlayed = PP.relativeTime(record.lastPlayed);
  var slugs = Object.keys(MUSEUMS);
  if (!slugs.length) { slugs = Object.keys(record.museums); }
  var centuriesSeen = Object.keys(record.centuries || {}).length;
  var formsSeen = Object.keys(record.forms || {}).length;
  var photographs = (record.forms && record.forms.Photograph) || 0;
  var museumsVisited = slugs.filter(function (s) { return (record.museums[s] || 0) > 0; }).length;

  /* ---------- the band ---------- */

  /* Three, not six. The band used to repeat most of the page back at itself:
     "dailies played" is the opening line of Your finishing scores, and best
     streak and longest endless run are exactly what four of the achievements
     below already measure. What is left is the streak you are protecting, how
     good your eye is, and how much of the collection you have met. */
  var band = [
    [record.streak, 'Current streak'],
    [pct(record.correct, record.answers) + '%', 'Correct'],
    [record.objectsSeen || record.answers * 2, 'Objects seen']
  ].map(function (row) {
    return '<div class="fact"><b>' + esc(row[0]) + '</b><span>' + esc(row[1]) + '</span></div>';
  }).join('');

  /* ---------- Art Eye ---------- */

  var eyeBlock = eye.ready
    ? '<div class="eye-card">' +
      '<div class="eye-score"><b>' + eye.pct + '%</b><span>' + esc(eye.label) + '</span></div>' +
      '<div class="eye-body"><p>' +
      (eye.weakest
        ? 'Your weakest period so far is the <b>' + esc(eye.weakest.label) + '</b> — ' +
          eye.weakest.pct + '% right across ' + plural(eye.weakest.seen, 'object') + '.'
        : 'Keep going and a weak period will surface here.') +
      '</p><p class="card-meta">Across ' + plural(record.answers, 'answer') +
      ', in every mode.</p></div></div>'
    : '<p class="empty">Your Art Eye rating unlocks after ' + minAnswers +
      ' answers. ' + eye.need + ' to go.</p>';

  /* ---------- Museum passport ----------
     A passport wants stamps, and a stamp wants a rank. Four tiers per museum,
     so the page has something to say on the first visit and something still to
     say on the two-hundredth. */

  var TIERS = [
    { at: 1, name: 'Visitor' },
    { at: 20, name: 'Regular' },
    { at: 75, name: 'Docent' },
    { at: 200, name: 'Trustee' }
  ];

  function tierFor(seen) {
    var current = null;
    var next = null;
    for (var i = 0; i < TIERS.length; i++) {
      if (seen >= TIERS[i].at) { current = TIERS[i]; } else { next = next || TIERS[i]; }
    }
    return { current: current, next: next };
  }

  var passport = slugs.map(function (slug) {
    var seen = record.museums[slug] || 0;
    var name = (MUSEUMS[slug] && MUSEUMS[slug].name) || slug;
    var city = (MUSEUMS[slug] && MUSEUMS[slug].city) || '';
    var rank = tierFor(seen);
    var earned = Boolean(rank.current);
    var floor = rank.current ? rank.current.at : 0;
    var ceiling = rank.next ? rank.next.at : floor;
    var progress = rank.next
      ? Math.min(100, Math.round((100 * (seen - floor)) / Math.max(1, ceiling - floor)))
      : 100;
    return '<article class="stamp' + (earned ? ' is-earned' : '') + '">' +
      '<div class="stamp-mark" aria-hidden="true"><span>' +
      esc(rank.current ? rank.current.name : 'Unstamped') + '</span></div>' +
      '<h3>' + esc(name) + '</h3>' +
      '<p class="stamp-city">' + esc(city) + '</p>' +
      '<p class="stamp-count">' + plural(seen, 'object') + ' seen</p>' +
      '<div class="meter"><span style="width:' + progress + '%"></span></div>' +
      '<p class="stamp-next">' +
      (rank.next
        ? (rank.next.at - seen) + ' more to <b>' + esc(rank.next.name) + '</b>'
        : 'Top rank reached. Nothing left to prove here.') +
      '</p></article>';
  }).join('');

  /* ---------- Achievements ----------
     Each one is a name, a reason, an icon, and — where it makes sense — a bar
     that shows how far off it is. Locked ones stay legible on purpose: a wall
     of grey question marks tells you nothing about what the game rewards. */

  function ach(id, name, blurb, iconName, have, need) {
    var done = have >= need;
    return {
      id: id, name: name, blurb: blurb, icon: iconName,
      have: Math.min(have, need), need: need, done: done,
      progress: Math.min(100, Math.round((100 * have) / need))
    };
  }

  var perfect = record.dist[10] || 0;
  var nearPerfect = (record.dist[9] || 0) + perfect;
  var blanked = record.dist[0] || 0;

  var CATEGORIES = [
    {
      name: 'Turning up',
      blurb: 'The part that is pure stubbornness.',
      items: [
        ach('first', 'First light', 'Finish one Daily Challenge.', 'sunrise', record.played, 1),
        ach('season', 'Season ticket', 'Finish ten Daily Challenges.', 'ticket', record.played, 10),
        ach('week', 'Week’s eye', 'A seven-day streak.', 'flame', record.best, 7),
        ach('month', 'Resident', 'A thirty-day streak. At this point you work here.', 'key', record.best, 30)
      ]
    },
    {
      name: 'Being right',
      blurb: 'The part that is not.',
      items: [
        ach('good', 'Nearly there', 'Score nine or better in a daily.', 'eye', nearPerfect, 1),
        ach('perfect', 'Perfect ten', 'Ten out of ten. No notes.', 'rosette', perfect, 1),
        ach('twice', 'Twice is a pattern', 'Two perfect dailies.', 'scales', perfect, 2),
        ach('long', 'Long sight', 'Fifteen endless answers in a row.', 'telescope', record.endlessBest, 15),
        ach('marathon', 'Iron eye', 'Forty endless answers in a row.', 'compass', record.endlessBest, 40)
      ]
    },
    {
      name: 'Wrong, but interestingly',
      blurb: 'Nobody gets these on purpose.',
      items: [
        ach('blank', 'Bone dry', 'Score zero in a daily. Everyone is allowed one.', 'skull', blanked, 1),
        ach('big', 'Five centuries out', 'Miss a pair five hundred years apart.', 'hourglass', record.bigMisses, 1),
        ach('near', 'Photo finish', 'Miss three pairs less than twenty-five years apart.', 'camera', record.nearMisses, 3),
        ach('surprise', 'Not fooled', 'Get ten backwards-reading pairs right — the old thing that looks new.', 'moon', record.surpriseWins, 10)
      ]
    },
    {
      name: 'The grand tour',
      blurb: 'Where you have been, and how far back.',
      items: [
        ach('tour', 'Grand tour', 'See an object from every collection.', 'globe', museumsVisited, slugs.length || 4),
        ach('bc', 'Before the alphabet', 'Meet something made before year one.', 'obelisk',
          record.oldestYear !== null && record.oldestYear < 0 ? 1 : 0, 1),
        ach('centuries', 'Century club', 'See objects from twelve different centuries.', 'stack', centuriesSeen, 12),
        ach('forms', 'Broad church', 'See ten different kinds of object.', 'key', formsSeen, 10),
        ach('photo', 'Shutterbug', 'See fifty photographs.', 'camera', photographs, 50)
      ]
    }
  ];

  var earnedCount = 0;
  var totalCount = 0;
  var BY_ID = {};
  CATEGORIES.forEach(function (group) {
    group.items.forEach(function (item) {
      totalCount += 1;
      BY_ID[item.id] = item;
      if (item.done) { earnedCount += 1; }
    });
  });

  function achMarkup(item) {
    var bar = item.done || item.need <= 1
      ? ''
      : '<div class="meter"><span style="width:' + item.progress + '%"></span></div>' +
        '<p class="ach-progress">' + item.have + ' of ' + item.need + '</p>';
    var share = item.done
      ? '<button class="btn btn-sm btn-quiet ach-share" type="button" data-share="' +
        esc(item.id) + '">Share this</button>'
      : '';
    return '<article class="ach' + (item.done ? ' is-earned' : '') + '">' +
      '<div class="ach-badge">' + icon(item.icon) + '</div>' +
      '<div class="ach-body"><h3>' + esc(item.name) + '</h3>' +
      '<p>' + esc(item.blurb) + '</p>' + bar + share + '</div>' +
      (item.done ? '<span class="ach-tick" aria-label="Earned">✓</span>' : '') +
      '</article>';
  }

  var achievements = CATEGORIES.map(function (group) {
    var got = group.items.filter(function (i) { return i.done; }).length;
    return '<section class="ach-group">' +
      '<div class="ach-head"><h3>' + esc(group.name) + '</h3>' +
      '<p>' + esc(group.blurb) + '</p>' +
      '<span class="ach-tally">' + got + '/' + group.items.length + '</span></div>' +
      '<div class="ach-grid">' + group.items.map(achMarkup).join('') + '</div>' +
      '</section>';
  }).join('');

  /* ---------- Finishing scores ----------
     This used to be called "score distribution", which is a phrase from a
     statistics lecture. It is one sentence and a row of bars: out of everything
     you have finished, how often did you land on each score. */

  function scoresBlock() {
    if (record.played < 3) {
      return '<p class="empty">After three finished dailies this fills in with ' +
        'how often you land on each score.</p>';
    }
    var maxBucket = Math.max.apply(null, record.dist.concat([1]));
    var usual = 0;
    var totalScore = 0;
    record.dist.forEach(function (count, s) {
      if (count > record.dist[usual]) { usual = s; }
      totalScore += count * s;
    });
    var average = (totalScore / Math.max(1, record.played)).toFixed(1);
    var latestScore = record.lastPlayed && record.daily[record.lastPlayed]
      ? record.daily[record.lastPlayed].score : -1;

    var rows = record.dist.map(function (count, s) {
      var width = count ? Math.max(8, Math.round((100 * count) / maxBucket)) : 0;
      return '<div class="score-row' + (s === latestScore ? ' is-latest' : '') +
        (s === usual ? ' is-usual' : '') + '">' +
        '<span class="score-key">' + s + '<small>/10</small></span>' +
        '<span class="score-track"><span class="score-fill" style="width:' + width + '%"></span></span>' +
        '<span class="score-count">' + (count ? plural(count, 'time') : '—') +
        (s === latestScore ? ' · latest' : '') + '</span>' +
        '</div>';
    }).join('');

    return '<p class="section-lede">Out of ' + plural(record.played, 'finished daily', 'finished dailies') +
      ', this is how often you ended on each score. You usually finish on <b>' + usual +
      ' out of 10</b>; your average is <b>' + average + '</b>.' +
      (latestScore >= 0 ? ' The row marked <b>latest</b> is your most recent finish.' : '') + '</p>' +
      '<div class="score-chart">' + rows + '</div>';
  }

  /* ---------- reminder ---------- */

  var reminder = '';
  var canAsk = 'Notification' in window && Notification.permission === 'default';
  if (record.played >= reminderAfter && !record.reminderAsked && !record.reminderDismissed && canAsk) {
    reminder = '<div class="reminder is-shown" id="reminder">' +
      '<p>Played ' + record.played + ' days. Want one reminder a day, and nothing else?</p>' +
      '<span><button class="btn btn-quiet" id="reminder-yes" type="button">Remind me</button> ' +
      '<button class="btn btn-quiet" id="reminder-no" type="button">No thanks</button></span></div>';
  }

  /* ---------- assemble ---------- */

  root.innerHTML =
    '<div class="facts">' + band + '</div>' +
    (lastPlayed ? '<p class="card-meta">Last daily played ' + esc(lastPlayed) + '.</p>' : '') +

    '<h2 class="stats-h">Art Eye</h2>' + eyeBlock +

    '<h2 class="stats-h">Museum passport</h2>' +
    '<p class="section-lede">One page per collection. Every object you are shown ' +
    'counts, whichever mode you met it in.</p>' +
    '<div class="passport">' + passport + '</div>' +

    '<h2 class="stats-h">Achievements <small>' + earnedCount + ' of ' + totalCount + '</small></h2>' +
    achievements +
    '<p class="share-note" id="ach-note"></p>' +
    '<canvas id="ach-canvas" width="1080" height="1920" hidden></canvas>' +

    '<h2 class="stats-h">Your finishing scores</h2>' + scoresBlock() +

    '<h2 class="stats-h">Deep time</h2>' +
    '<p class="section-lede">The oldest and newest things this browser has been shown: ' +
    '<b>' + esc(yearLabel(record.oldestYear)) + '</b> to <b>' + esc(yearLabel(record.newestYear)) +
    '</b>, across ' + plural(centuriesSeen, 'century', 'centuries') + '.</p>' +

    reminder +
    '<p class="stats-reset"><button class="btn btn-quiet" id="reset" type="button">' +
    'Erase my local record</button></p>';

  wireAchievementShare();

  /* ---------- sharing an achievement ----------
     The same pipeline the results card uses: one 9:16 canvas, drawn with the
     shared primitives, handed to the operating system by PP.share. What goes
     on it is the badge, the name and the sentence that says what it means --
     enough for somebody who has never played to understand it, and nothing
     from the local record, which is nobody else's business. */

  function achShareUrl() { return location.origin + '/daily'; }

  function achShareText(item) {
    return 'Past Perfect — unlocked “' + item.name + '”. ' + item.blurb + '\n' + achShareUrl();
  }

  function achNote(message) {
    var box = document.getElementById('ach-note');
    if (box) { box.textContent = message; }
  }

  /** The 24-unit icon, stroked at badge size. */
  function drawIcon(ctx, name, cx, cy, size) {
    var scale = size / 24;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(scale, scale);
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    shapes(name).forEach(function (shape) {
      if (shape.p) {
        if (!window.Path2D) { return; }
        ctx.stroke(new Path2D(shape.p));
        return;
      }
      ctx.beginPath();
      ctx.arc(shape.c[0], shape.c[1], shape.c[2], 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawAchievementCard(item) {
    var S = PP.share;
    var canvas = document.getElementById('ach-canvas');
    var ctx = S.begin(canvas);
    if (!ctx) { return null; }
    var c = S.palette();
    var pad = S.PAD;
    var wide = canvas.width - pad * 2;
    var mid = canvas.width / 2;

    ctx.fillStyle = c.soft;
    ctx.font = '30px ' + S.SANS;
    ctx.fillText('PAST PERFECT   ·   ACHIEVEMENT', pad, 150);

    ctx.fillStyle = c.panel;
    ctx.beginPath();
    ctx.arc(mid, 720, 300, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.accent;
    drawIcon(ctx, item.icon, mid, 720, 360);

    ctx.textAlign = 'center';
    ctx.fillStyle = c.accent;
    ctx.font = '32px ' + S.SANS;
    ctx.fillText('UNLOCKED', mid, 1170);

    ctx.fillStyle = c.ink;
    ctx.font = '96px ' + S.SERIF;
    S.drawLines(ctx, S.wrap(ctx, item.name, wide, 2), mid, 1300, 112);

    ctx.fillStyle = c.soft;
    ctx.font = '40px ' + S.SANS;
    S.drawLines(ctx, S.wrap(ctx, item.blurb, wide - 80, 3), mid, 1570, 56);
    ctx.textAlign = 'left';

    S.footer(ctx, canvas, achShareUrl(), pad);
    return canvas;
  }

  function wireAchievementShare() {
    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-share]');
      if (!button) { return; }
      var item = BY_ID[button.dataset.share];
      if (!item || !item.done || !PP.share) { return; }
      var canvas = drawAchievementCard(item);
      if (!canvas) { return achNote('This browser cannot draw the card.'); }
      PP.track('share', { mode: 'achievement', achievement: item.id });
      PP.share.send({
        canvas: canvas, text: achShareText(item), url: achShareUrl(),
        filename: 'past-perfect-' + item.id + '.png', note: achNote,
        fallback: 'download'
      });
    });
  }

  var reset = document.getElementById('reset');
  if (reset) {
    reset.addEventListener('click', function () {
      if (!window.confirm('This erases your streak and stats in this browser. Continue?')) { return; }
      PP.save(PP.blankRecord());
      location.reload();
    });
  }

  var yes = document.getElementById('reminder-yes');
  var no = document.getElementById('reminder-no');
  if (yes) {
    yes.addEventListener('click', function () {
      PP.update(function (r) { r.reminderAsked = true; });
      Notification.requestPermission().then(function (result) {
        PP.track('reminder_permission', { result: result, from: 'stats' });
        document.getElementById('reminder').classList.remove('is-shown');
      });
    });
  }
  if (no) {
    no.addEventListener('click', function () {
      PP.update(function (r) { r.reminderDismissed = true; });
      document.getElementById('reminder').classList.remove('is-shown');
    });
  }
})();
