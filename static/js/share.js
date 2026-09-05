/* Past Perfect — the share pipeline.
   One canvas, one palette, one set of drawing primitives, and one way out to
   the operating system. Both cards the game can produce -- a finished result
   and an earned achievement -- are drawn with these and sent with these, so
   there is a single place where "what a shared Past Perfect image looks like"
   is decided.

   The output is 1080x1920 -- 9:16, the full-bleed portrait shape. That is what
   an Instagram or WhatsApp story, a TikTok and a Reel all fill edge to edge
   with no crop and no letterbox, and it is the shape a phone is already
   holding when somebody looks at it. The cards are laid out for that height
   rather than scaled into it. */
(function () {
  'use strict';

  /* The card palette. Deliberately not the page tokens: a shared image is
     looked at outside the site, so it carries its own copy of the two
     palettes and does not depend on a stylesheet having loaded. */
  var PALETTES = {
    light: {
      ground: '#FBF6EC', panel: '#F5EDDF', ink: '#17140F', soft: '#6F675A',
      accent: '#A8432A', hit: '#3E6B4C', miss: '#E3D8C4', scrim: 'rgba(23,20,15,.62)'
    },
    dark: {
      ground: '#100F0D', panel: '#1A1917', ink: '#F3EEE4', soft: '#8B8377',
      accent: '#D98A4E', hit: '#7FB08C', miss: '#2C2A27', scrim: 'rgba(0,0,0,.6)'
    }
  };

  var W = 1080;
  var H = 1920;
  var PAD = 80;
  var SERIF = 'Georgia, "Times New Roman", serif';
  var SANS = 'Helvetica, Arial, sans-serif';

  function palette() {
    var theme = window.PP && PP.theme ? PP.theme() : 'light';
    return PALETTES[theme === 'dark' ? 'dark' : 'light'];
  }

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
  function wrap(ctx, text, maxWidth, maxLines) {
    var words = String(text === null || typeof text === 'undefined' ? '' : text).split(/\s+/);
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

  /** One line, cut with an ellipsis rather than wrapped. */
  function fit(ctx, text, maxWidth) {
    var value = String(text === null || typeof text === 'undefined' ? '' : text);
    if (ctx.measureText(value).width <= maxWidth) { return value; }
    while (value.length > 1 && ctx.measureText(value + '…').width > maxWidth) {
      value = value.slice(0, -1);
    }
    return value.replace(/[\s.,;:]+$/, '') + '…';
  }

  function drawLines(ctx, rows, x, y, lineHeight) {
    rows.forEach(function (row, index) { ctx.fillText(row, x, y + index * lineHeight); });
    return y + rows.length * lineHeight;
  }

  /** An image cropped to fill a rounded box, centred, never squashed. */
  function drawCover(ctx, img, x, y, w, h, r) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    var scale = Math.max(w / img.width, h / img.height);
    var dw = img.width * scale;
    var dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }

  /** Resolves with the image, or with null: a card is drawn either way. */
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src || !window.Image) { return resolve(null); }
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /* The frame every card shares: the ground, the accent rule along the
     bottom, and the wordmark and address that make it legible to somebody who
     has never seen the site. */

  function begin(canvas) {
    if (!canvas || !canvas.getContext) { return null; }
    var ctx = canvas.getContext('2d');
    var c = palette();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = c.ground;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, canvas.height - 18, canvas.width, 18);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return ctx;
  }

  function footer(ctx, canvas, url, pad) {
    var c = palette();
    var y = canvas.height - 66;
    ctx.textAlign = 'left';
    ctx.fillStyle = c.ink;
    ctx.font = '40px ' + SERIF;
    ctx.fillText('Past Perfect', pad, y);
    ctx.fillStyle = c.soft;
    ctx.font = '26px ' + SANS;
    ctx.textAlign = 'right';
    ctx.fillText(String(url).replace(/^https?:\/\//, ''), canvas.width - pad, y);
    ctx.textAlign = 'left';
  }

  /* ---------- getting the thing out ---------- */

  function toBlob(canvas) {
    return new Promise(function (resolve) {
      if (!canvas || !canvas.toBlob) { return resolve(null); }
      try { canvas.toBlob(function (blob) { resolve(blob); }, 'image/png'); }
      catch (e) { resolve(null); }
    });
  }

  function copy(text, note) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { note('Copied. Go and ruin someone’s morning.'); })
        .catch(function () { note(text); });
    }
    note(text);
    return Promise.resolve();
  }

  function download(canvas, filename, note) {
    return toBlob(canvas).then(function (blob) {
      if (!blob) { return note('This browser cannot save the card.'); }
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      note('Saved as a PNG.');
    });
  }

  /**
   * Share, with the two fallbacks the web actually needs.
   *
   * A phone takes the image itself. A desktop browser with the share sheet but
   * no file support takes the sentence and the link. Everything else -- most
   * desktop Firefox, every locked-down browser -- gets the sentence on the
   * clipboard, which is what a person would have done by hand anyway, unless
   * the caller asks for `fallback: 'download'`, which hands over the PNG
   * instead. Anything with its own save button wants the clipboard; anything
   * without one wants the file.
   */
  function send(opts) {
    var note = opts.note || function () {};
    return toBlob(opts.canvas).then(function (blob) {
      var file = blob && window.File
        ? new File([blob], opts.filename, { type: 'image/png' })
        : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        return navigator.share({ title: 'Past Perfect', text: opts.text, files: [file] })
          .catch(function () {});
      }
      if (navigator.share) {
        return navigator.share({ title: 'Past Perfect', text: opts.text, url: opts.url })
          .catch(function () {});
      }
      if (opts.fallback === 'download') {
        return download(opts.canvas, opts.filename, note);
      }
      return copy(opts.text, note);
    });
  }

  window.PP = window.PP || {};
  window.PP.share = {
    W: W, H: H, PAD: PAD, SERIF: SERIF, SANS: SANS,
    palette: palette, roundRect: roundRect, wrap: wrap, fit: fit,
    drawLines: drawLines, drawCover: drawCover, loadImage: loadImage,
    begin: begin, footer: footer,
    toBlob: toBlob, copy: copy, download: download, send: send
  };
})();
