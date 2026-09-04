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

  var band = [
    [record.played, 'Dailies played'],
    [pct(record.correct, record.answers) + '%', 'Correct'],
    [record.streak, 'Current streak'],
    [record.best, 'Best streak'],
    [record.endlessBest, 'Longest endless run']
  ].map(function (row) {
    return '<div class="fact"><b>' + esc(row[0]) + '</b><span>' + esc(row[1]) + '</span></div>';
  }).join('');

  var maxBucket = Math.max.apply(null, record.dist.concat([1]));
  var latestScore = record.lastPlayed && record.daily[record.lastPlayed]
    ? record.daily[record.lastPlayed].score : -1;
  var histogram = record.dist.map(function (count, score) {
    var width = Math.max(6, Math.round(100 * count / maxBucket));
    return '<div class="histo-row' + (score === latestScore ? ' is-latest' : '') + '">' +
      '<span>' + score + '</span>' +
      '<span class="histo-bar' + (count ? '' : ' is-empty') + '" style="width:' + width + '%">' +
      count + '</span></div>';
  }).join('');

  var eyeBlock = eye.ready
    ? '<p class="score-line" style="font-size:clamp(2rem,7vw,3.2rem)">' + eye.pct + '%</p>' +
      '<p class="score-caption">' + esc(eye.label) + '</p>' +
      (eye.weakest
        ? '<p>Your weakest period so far is the <b>' + esc(eye.weakest.label) + '</b> — ' +
          eye.weakest.pct + '% right across ' + eye.weakest.seen + ' objects.</p>'
        : '<p>Keep going and a weak period will surface here.</p>')
    : '<p class="empty">Your Art Eye rating unlocks after ' + minAnswers +
      ' answers. ' + eye.need + ' to go.</p>';

  var slugs = Object.keys(MUSEUMS);
  if (!slugs.length) { slugs = Object.keys(record.museums); }
  var passport = slugs.map(function (slug) {
    var seen = record.museums[slug] || 0;
    var earned = seen >= 20;
    var name = (MUSEUMS[slug] && MUSEUMS[slug].name) || slug;
    return '<div class="stamp' + (earned ? ' is-earned' : '') + '">' +
      '<span class="stamp-mark">Stamped</span>' +
      '<b>' + esc(name) + '</b>' +
      '<span>' + seen + ' object' + (seen === 1 ? '' : 's') + ' seen' +
      (earned ? '' : ' · ' + (20 - seen) + ' to go') + '</span></div>';
  }).join('');

  var perfect = record.dist[10] > 0;
  var allMuseums = slugs.length > 0 && slugs.every(function (s) {
    return (record.museums[s] || 0) > 0;
  });
  var achievements = [
    ['First light', 'Finish a Daily Challenge', record.played >= 1],
    ['Regular', 'Ten dailies played', record.played >= 10],
    ['Week’s eye', 'A seven-day streak', record.best >= 7],
    ['Perfect ten', 'Ten out of ten in a daily', perfect],
    ['Grand tour', 'Objects seen from every museum', allMuseums],
    ['Long sight', 'Fifteen endless answers in a row', record.endlessBest >= 15]
  ].map(function (row) {
    return '<div class="stamp' + (row[2] ? ' is-earned' : '') + '">' +
      '<span class="stamp-mark">Earned</span>' +
      '<b>' + esc(row[0]) + '</b><span>' + esc(row[1]) + '</span></div>';
  }).join('');

  var reminder = '';
  var canAsk = 'Notification' in window && Notification.permission === 'default';
  if (record.played >= reminderAfter && !record.reminderAsked && !record.reminderDismissed && canAsk) {
    reminder = '<div class="reminder is-shown" id="reminder">' +
      '<p>Played ' + record.played + ' days. Want one reminder a day, and nothing else?</p>' +
      '<span><button class="btn btn-quiet" id="reminder-yes" type="button">Remind me</button> ' +
      '<button class="btn btn-quiet" id="reminder-no" type="button">No thanks</button></span></div>';
  }

  root.innerHTML =
    '<div class="facts">' + band + '</div>' +
    (lastPlayed ? '<p class="card-meta">Last daily played ' + esc(lastPlayed) + '.</p>' : '') +
    '<h2 style="margin-top:2rem">Score distribution</h2>' +
    '<div class="histogram">' + histogram + '</div>' +
    '<h2>Art Eye</h2>' + eyeBlock +
    '<h2 style="margin-top:2rem">Museum passport</h2>' +
    '<div class="passport">' + passport + '</div>' +
    '<h2 style="margin-top:2rem">Achievements</h2>' +
    '<div class="passport">' + achievements + '</div>' +
    reminder +
    '<p style="margin-top:2rem"><button class="btn btn-quiet" id="reset" type="button">' +
    'Erase my local record</button></p>';

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
