/* Past Perfect — shared client state.
   The local record is the whole account system: a streak, a distribution, a
   passport and an accuracy history, kept in this browser and sent nowhere. */
(function () {
  'use strict';

  var KEY = 'pastperfect.v1';
  var SESSION_KEY = 'pastperfect.session';

  function safeParse(text, fallback) {
    try { return JSON.parse(text) || fallback; } catch (e) { return fallback; }
  }

  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function blankRecord() {
    return {
      v: 1,
      daily: {},          /* date -> { score, edition } */
      streak: 0,
      best: 0,
      lastPlayed: null,
      played: 0,
      answers: 0,
      correct: 0,
      dist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      centuries: {},      /* century bucket -> { seen, right } */
      museums: {},        /* museum slug -> objects seen */
      endlessBest: 0,
      endlessRuns: 0,
      reminderDismissed: false,
      reminderAsked: false
    };
  }

  function load() {
    var record = safeParse(readStorage(KEY), null);
    if (!record || record.v !== 1) { return blankRecord(); }
    var blank = blankRecord();
    Object.keys(blank).forEach(function (key) {
      if (typeof record[key] === 'undefined') { record[key] = blank[key]; }
    });
    return record;
  }

  function save(record) { writeStorage(KEY, JSON.stringify(record)); }

  function update(mutator) {
    var record = load();
    mutator(record);
    save(record);
    return record;
  }

  function randomId() {
    var bytes = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += 'abcdefghijklmnopqrstuvwxyz0123456789'[bytes[i] % 36];
    }
    return out;
  }

  function session() {
    var value = readStorage(SESSION_KEY);
    if (!value || !/^[a-z0-9]{8,64}$/.test(value)) {
      value = randomId();
      writeStorage(SESSION_KEY, value);
    }
    return value;
  }

  /* First-party analytics. Fire-and-forget; never blocks the game. */
  function track(name, props) {
    var payload = JSON.stringify({ name: name, session: session(), props: props || {} });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
        return;
      }
    } catch (e) { /* fall through */ }
    fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: payload, keepalive: true
    }).catch(function () {});
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function dayBefore(iso) {
    var date = new Date(iso + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() - 1);
    return isoDate(date);
  }

  /* Record a finished daily and move the streak. Replaying the same day is a
     no-op, so a refresh cannot inflate anything. */
  function recordDaily(date, edition, score, answers) {
    return update(function (record) {
      var slot = record.daily[date];
      if (slot && slot.edition === edition) { return; }
      record.daily[date] = { score: score, edition: edition };
      record.played += 1;
      record.dist[Math.max(0, Math.min(10, score))] += 1;
      if (edition === '') {
        if (record.lastPlayed === dayBefore(date)) { record.streak += 1; }
        else if (record.lastPlayed !== date) { record.streak = 1; }
        record.lastPlayed = date;
        record.best = Math.max(record.best, record.streak);
      }
      applyAnswers(record, answers);
    });
  }

  function applyAnswers(record, answers) {
    (answers || []).forEach(function (answer) {
      record.answers += 1;
      if (answer.correct) { record.correct += 1; }
      [answer.a, answer.b].forEach(function (side) {
        if (!side) { return; }
        record.museums[side.museum] = (record.museums[side.museum] || 0) + 1;
        var bucket = String(Math.floor(side.year / 100));
        var cell = record.centuries[bucket] || { seen: 0, right: 0 };
        cell.seen += 1;
        if (answer.correct) { cell.right += 1; }
        record.centuries[bucket] = cell;
      });
    });
  }

  function recordEndless(best, answers) {
    return update(function (record) {
      record.endlessRuns += 1;
      record.endlessBest = Math.max(record.endlessBest, best);
      applyAnswers(record, answers);
    });
  }

  function centuryLabel(bucket) {
    var n = parseInt(bucket, 10);
    if (n < 0) { return ordinal(Math.abs(n)) + ' century BC'; }
    return ordinal(n + 1) + ' century';
  }

  function ordinal(n) {
    var suffix = (n % 100 >= 10 && n % 100 <= 20) ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + suffix;
  }

  var EYE = [
    [93, 'Uncanny'], [85, "Curator's eye"], [75, 'Sharp eye'],
    [65, 'Good eye'], [50, 'Fair eye'], [0, 'Getting your eye in']
  ];

  function artEye(record, minAnswers) {
    if (record.answers < minAnswers) {
      return { ready: false, need: minAnswers - record.answers };
    }
    var pct = Math.round(100 * record.correct / record.answers);
    var label = 'Getting your eye in';
    for (var i = 0; i < EYE.length; i++) {
      if (pct >= EYE[i][0]) { label = EYE[i][1]; break; }
    }
    var weakest = null;
    Object.keys(record.centuries).forEach(function (bucket) {
      var cell = record.centuries[bucket];
      if (cell.seen < 6) { return; }
      var rate = cell.right / cell.seen;
      if (!weakest || rate < weakest.rate) {
        weakest = { bucket: bucket, rate: rate, seen: cell.seen };
      }
    });
    return {
      ready: true, pct: pct, label: label,
      weakest: weakest ? {
        label: centuryLabel(weakest.bucket),
        pct: Math.round(weakest.rate * 100),
        seen: weakest.seen
      } : null
    };
  }

  function relativeTime(iso) {
    if (!iso) { return null; }
    var days = Math.round((Date.now() - Date.parse(iso + 'T00:00:00Z')) / 86400000);
    if (days <= 0) { return 'today'; }
    if (days === 1) { return 'yesterday'; }
    return days + ' days ago';
  }

  window.PP = {
    load: load, save: save, update: update, session: session, track: track,
    recordDaily: recordDaily, recordEndless: recordEndless, artEye: artEye,
    theme: currentTheme, setTheme: setTheme,
    centuryLabel: centuryLabel, ordinal: ordinal, isoDate: isoDate,
    relativeTime: relativeTime, blankRecord: blankRecord
  };

  /* ---------- theme ----------
     Three states, one button. With nothing stored the page follows the
     operating system, which CSS handles on its own; clicking pins a choice,
     and clicking back to whatever the system already wants releases the pin so
     the page follows along again. */

  var THEME_KEY = 'pastperfect.theme';
  var THEME_COLOURS = { light: '#FBF6EC', dark: '#100F0D' };

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  function storedTheme() {
    var value = readStorage(THEME_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  }

  function currentTheme() {
    return storedTheme() || systemTheme();
  }

  function applyTheme(theme) {
    var pinned = storedTheme();
    if (pinned) { document.documentElement.setAttribute('data-theme', pinned); }
    else { document.documentElement.removeAttribute('data-theme'); }

    /* Keep the browser chrome in step. The markup ships one theme-color per
       media query; a pinned choice needs a plain one that outranks both. */
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (pinned) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', THEME_COLOURS[theme]);
    } else if (meta) {
      meta.remove();
    }

    var button = document.getElementById('theme-toggle');
    if (button) {
      var next = theme === 'dark' ? 'light' : 'dark';
      var label = 'Switch to ' + next + ' mode';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
  }

  function setTheme(theme) {
    if (theme === systemTheme()) {
      try { window.localStorage.removeItem(THEME_KEY); } catch (e) { /* ignore */ }
    } else {
      writeStorage(THEME_KEY, theme);
    }
    applyTheme(theme);
    track('theme_change', { theme: theme, follows_system: theme === systemTheme() });
  }

  function wireTheme() {
    applyTheme(currentTheme());
    var button = document.getElementById('theme-toggle');
    if (button) {
      button.addEventListener('click', function () {
        setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
    }
    var query = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (query && query.addEventListener) {
      query.addEventListener('change', function () { applyTheme(currentTheme()); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireTheme);
  } else {
    wireTheme();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();
