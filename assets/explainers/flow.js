/*
 * flow.js: a step-through architecture explainer for Hugo posts.
 * Rendered by the {{< flow data="explainers/<name>.json" >}} shortcode.
 *
 * JSON shape (assets/explainers/<name>.json):
 * {
 *   "title": "Diagram description, used as its aria-label",
 *   "viewBox": "0 0 1040 520",
 *   "caption": "Optional HTML shown under the explainer",
 *   "stateKeys": ["Leader", "Write quorum"],          // rows of the state panel, in order
 *   "zones": [{ "id": "az1", "label": "AZ 1", "x": 0, "y": 0, "w": 100, "h": 100 }],
 *   "nodes": [{ "id": "r1", "label": "Replica", "sub": "WAL + B-tree",
 *               "x": 0, "y": 0, "w": 150, "h": 86, "valueSlot": true, "hidden": false }],
 *   "scenarios": [{
 *     "id": "put-item",                                 // link: #put-item or #put-item-3
 *     "title": "Successful write",
 *     "initial": { "leader": "r1", "down": [], "show": [], "values": {}, "state": {} },
 *     "steps": [{
 *       "title": "Short title",
 *       "text": "HTML explanation",
 *       "messages": [{ "from": "a", "to": "b", "label": "text",
 *                      "kind": "req | reply | async | fail",
 *                      "with": false,                   // start together with the previous message
 *                      "curve": 0 }],                   // bend the arrow; sign picks the side
 *       "active": ["a"],                                 // optional; defaults to nodes in messages
 *       "set": { "leader": "r2", "down": [], "up": [], "show": [], "hide": [],
 *                "values": { "r1": "v2" }, "state": { "Leader": "AZ 2" } }
 *     }]
 *   }]
 * }
 * State changes ("set") accumulate, so a link straight to step 6 shows the right picture.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var MSG_MS = 650;

  function svg(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
      });
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  function html(tag, cls, parent, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }

  function addUnique(list, items) {
    (items || []).forEach(function (id) { if (list.indexOf(id) === -1) list.push(id); });
  }

  function remove(list, items) {
    (items || []).forEach(function (id) {
      var at = list.indexOf(id);
      if (at !== -1) list.splice(at, 1);
    });
  }

  // State after applying "set" from steps 0..upto (upto = -1 gives the initial state).
  function stateAt(scenario, upto) {
    var init = scenario.initial || {};
    var st = {
      leader: init.leader || null,
      down: (init.down || []).slice(),
      shown: (init.show || []).slice(),
      hidden: [],
      values: Object.assign({}, init.values || {}),
      state: Object.assign({}, init.state || {})
    };
    for (var i = 0; i <= upto; i++) {
      var s = scenario.steps[i].set;
      if (!s) continue;
      if (Object.prototype.hasOwnProperty.call(s, 'leader')) st.leader = s.leader;
      addUnique(st.down, s.down);
      remove(st.down, s.up);
      addUnique(st.shown, s.show);
      remove(st.hidden, s.show);
      addUnique(st.hidden, s.hide);
      remove(st.shown, s.hide);
      Object.assign(st.values, s.values || {});
      Object.assign(st.state, s.state || {});
    }
    return st;
  }

  function centre(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

  // Where a ray from the node's centre in direction (dx, dy) leaves its box.
  function edge(n, dx, dy) {
    var c = centre(n);
    var tx = dx !== 0 ? (n.w / 2) / Math.abs(dx) : Infinity;
    var ty = dy !== 0 ? (n.h / 2) / Math.abs(dy) : Infinity;
    var t = Math.min(tx, ty);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  function unit(dx, dy) {
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  function init(root) {
    var data;
    try {
      data = JSON.parse(root.getAttribute('data-flow'));
    } catch (e) {
      return;
    }
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var nodes = {};
    data.nodes.forEach(function (n) { nodes[n.id] = n; });

    var current = { s: 0, i: 0 };
    var timers = [];
    var playTimer = null;

    // ---- DOM ----
    var ui = html('div', 'flow-ui');
    ui.tabIndex = 0;
    ui.setAttribute('aria-label', (data.title || 'Explainer') + '. Use the arrow keys to step.');
    root.insertBefore(ui, root.firstChild);

    var picker = html('div', 'flow-scenarios', ui);
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Scenario');
    var scenarioButtons = data.scenarios.map(function (sc, idx) {
      var b = html('button', null, picker, sc.title);
      b.type = 'button';
      b.addEventListener('click', function () { stop(); go(idx, 0, true); });
      return b;
    });

    var stage = html('div', 'flow-stage', ui);
    var root$ = svg('svg', { viewBox: data.viewBox, role: 'img', 'aria-label': data.title || '' }, stage);
    var zoneLayer = svg('g', null, root$);
    var nodeLayer = svg('g', null, root$);
    var msgLayer = svg('g', null, root$);

    (data.zones || []).forEach(function (z) {
      var g = svg('g', { 'class': 'fl-zone' }, zoneLayer);
      svg('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 10 }, g);
      svg('text', { x: z.x + 12, y: z.y + 20 }, g).textContent = z.label;
    });

    var nodeEls = {};
    data.nodes.forEach(function (n) {
      var c = centre(n);
      var g = svg('g', { 'class': 'fl-node', 'data-id': n.id }, nodeLayer);
      svg('rect', { 'class': 'fl-box', x: n.x, y: n.y, width: n.w, height: n.h, rx: 8 }, g);
      var labelY = n.valueSlot ? c.y - 12 : (n.sub ? c.y - 4 : c.y + 5);
      svg('text', { 'class': 'fl-label', x: c.x, y: labelY, 'text-anchor': 'middle' }, g).textContent = n.label;
      if (n.sub) {
        svg('text', { 'class': 'fl-sub', x: c.x, y: labelY + 17, 'text-anchor': 'middle' }, g).textContent = n.sub;
      }
      var val = null;
      if (n.valueSlot) {
        val = svg('text', { 'class': 'fl-val', x: c.x, y: labelY + 34, 'text-anchor': 'middle' }, g);
      }
      var lead = svg('g', { 'class': 'fl-badge fl-badge-leader' }, g);
      svg('rect', { x: n.x + n.w - 66, y: n.y - 9, width: 60, height: 18, rx: 9 }, lead);
      svg('text', { x: n.x + n.w - 36, y: n.y + 4, 'text-anchor': 'middle' }, lead).textContent = 'LEADER';
      var down = svg('g', { 'class': 'fl-badge fl-badge-down' }, g);
      svg('rect', { x: n.x + n.w - 52, y: n.y - 9, width: 46, height: 18, rx: 9 }, down);
      svg('text', { x: n.x + n.w - 29, y: n.y + 4, 'text-anchor': 'middle' }, down).textContent = 'DOWN';
      nodeEls[n.id] = { g: g, val: val };
    });

    var panel = html('div', 'flow-panel', ui);
    var step = html('div', 'flow-step', panel);
    var count = html('p', 'flow-step-count', step);
    var title = html('p', 'flow-step-title', step);
    var text = html('p', 'flow-step-text', step);
    step.setAttribute('aria-live', 'polite');
    var stateList = html('dl', 'flow-state', panel);

    var controls = html('div', 'flow-controls', ui);
    function control(label, onClick) {
      var b = html('button', null, controls, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }
    var backBtn = control('← Back', function () { stop(); go(current.s, current.i - 1, true); });
    var playBtn = control('Play', function () { if (playTimer) { stop(); } else { play(); } });
    var nextBtn = control('Next →', function () { stop(); go(current.s, current.i + 1, true); });
    control('Reset', function () { stop(); go(current.s, 0, true); });
    html('span', 'flow-hint', controls, '← → step · Space plays');

    // ---- Drawing ----
    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function later(fn, ms) {
      if (reduceMotion) { fn(); return; }
      timers.push(setTimeout(fn, ms));
    }

    function drawMessage(m, startMs) {
      var a = nodes[m.from];
      var b = nodes[m.to];
      if (!a || !b) return;
      var kind = m.kind || 'req';
      var g = svg('g', { 'class': 'fl-msg kind-' + kind }, msgLayer);
      var ca = centre(a);
      var cb = centre(b);
      var u = unit(cb.x - ca.x, cb.y - ca.y);
      var n = { x: u.y, y: -u.x };
      var p0, p1, tip, labelAt, lineEl;

      if (m.curve) {
        var ctrl = { x: (ca.x + cb.x) / 2 + n.x * m.curve, y: (ca.y + cb.y) / 2 + n.y * m.curve };
        var d0 = unit(ctrl.x - ca.x, ctrl.y - ca.y);
        var d1 = unit(ctrl.x - cb.x, ctrl.y - cb.y);
        p0 = edge(a, d0.x, d0.y);
        p1 = edge(b, d1.x, d1.y);
        p0 = { x: p0.x + d0.x * 3, y: p0.y + d0.y * 3 };
        p1 = { x: p1.x + d1.x * 3, y: p1.y + d1.y * 3 };
        lineEl = svg('path', { d: 'M' + p0.x + ' ' + p0.y + ' Q' + ctrl.x + ' ' + ctrl.y + ' ' + p1.x + ' ' + p1.y }, g);
        tip = unit(p1.x - ctrl.x, p1.y - ctrl.y);
        labelAt = { x: 0.25 * p0.x + 0.5 * ctrl.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * ctrl.y + 0.25 * p1.y };
      } else {
        var off = 5;
        p0 = edge(a, u.x, u.y);
        p1 = edge(b, -u.x, -u.y);
        p0 = { x: p0.x + n.x * off + u.x * 3, y: p0.y + n.y * off + u.y * 3 };
        p1 = { x: p1.x + n.x * off - u.x * 3, y: p1.y + n.y * off - u.y * 3 };
        lineEl = svg('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y }, g);
        tip = u;
        labelAt = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      }

      var perp = { x: -tip.y, y: tip.x };
      var base = { x: p1.x - tip.x * 10, y: p1.y - tip.y * 10 };
      var head = svg('polygon', {
        'class': 'fl-anim',
        points: [p1.x, p1.y, base.x + perp.x * 5, base.y + perp.y * 5, base.x - perp.x * 5, base.y - perp.y * 5].join(' ')
      }, g);

      var label = null;
      if (m.label) {
        var lx = labelAt.x + n.x * 14;
        var ly = labelAt.y + n.y * 14;
        var anchor = Math.abs(n.x) > 0.6 ? (n.x > 0 ? 'start' : 'end') : 'middle';
        label = svg('text', { 'class': 'fl-anim', x: lx, y: ly, 'text-anchor': anchor, 'dominant-baseline': 'middle' }, g);
        label.textContent = m.label;
      }

      if (kind === 'req' && !reduceMotion && lineEl.getTotalLength) {
        var len = lineEl.getTotalLength();
        lineEl.style.strokeDasharray = len;
        lineEl.style.strokeDashoffset = len;
        later(function () {
          lineEl.style.transition = 'stroke-dashoffset ' + (MSG_MS - 150) + 'ms ease';
          lineEl.style.strokeDashoffset = 0;
        }, startMs + 20);
      } else {
        lineEl.setAttribute('class', 'fl-anim');
        later(function () { lineEl.classList.add('is-in'); }, startMs + 20);
      }
      later(function () {
        head.classList.add('is-in');
        if (label) label.classList.add('is-in');
      }, startMs + MSG_MS - 200);
    }

    function render() {
      var sc = data.scenarios[current.s];
      var st = stateAt(sc, current.i);
      var before = stateAt(sc, current.i - 1);
      var s = sc.steps[current.i];
      var messages = s.messages || [];

      var active = s.active ? s.active.slice() : [];
      if (!s.active) messages.forEach(function (m) { addUnique(active, [m.from, m.to]); });

      data.nodes.forEach(function (n) {
        var el = nodeEls[n.id];
        var hidden = (n.hidden && st.shown.indexOf(n.id) === -1) || st.hidden.indexOf(n.id) !== -1;
        el.g.classList.toggle('is-hidden', hidden);
        el.g.classList.toggle('is-down', st.down.indexOf(n.id) !== -1);
        el.g.classList.toggle('is-leader', st.leader === n.id);
        el.g.classList.toggle('is-active', active.indexOf(n.id) !== -1);
        if (el.val) el.val.textContent = st.values[n.id] || '';
      });

      clearTimers();
      while (msgLayer.firstChild) msgLayer.removeChild(msgLayer.firstChild);
      var t = 0;
      messages.forEach(function (m, k) {
        if (k > 0 && !m.with) t += MSG_MS;
        drawMessage(m, t);
      });

      scenarioButtons.forEach(function (b, idx) { b.setAttribute('aria-pressed', idx === current.s ? 'true' : 'false'); });
      count.textContent = sc.title + ' · step ' + (current.i + 1) + ' of ' + sc.steps.length;
      title.textContent = s.title;
      text.innerHTML = s.text;

      while (stateList.firstChild) stateList.removeChild(stateList.firstChild);
      (data.stateKeys || []).forEach(function (key) {
        html('dt', null, stateList, key);
        var dd = html('dd', null, stateList, st.state[key] || '—');
        if ((st.state[key] || '') !== (before.state[key] || '')) dd.className = 'is-changed';
      });

      backBtn.disabled = current.i === 0;
      nextBtn.disabled = current.i === sc.steps.length - 1;
      playBtn.textContent = playTimer ? 'Pause' : 'Play';
      return messages.length;
    }

    function go(s, i, fromUser) {
      var steps = data.scenarios[s].steps.length;
      current.s = s;
      current.i = Math.max(0, Math.min(steps - 1, i));
      var msgCount = render();
      if (fromUser && window.history && window.history.replaceState) {
        var id = data.scenarios[s].id;
        window.history.replaceState(null, '', '#' + id + (current.i > 0 ? '-' + (current.i + 1) : ''));
      }
      return msgCount;
    }

    // ---- Playback ----
    function stop() {
      if (playTimer) clearTimeout(playTimer);
      playTimer = null;
      playBtn.textContent = 'Play';
    }

    function play() {
      var last = data.scenarios[current.s].steps.length - 1;
      if (current.i >= last) go(current.s, 0, true);
      playTimer = true;
      playBtn.textContent = 'Pause';
      var tick = function (msgCount) {
        playTimer = setTimeout(function () {
          if (current.i >= data.scenarios[current.s].steps.length - 1) { stop(); return; }
          var n = go(current.s, current.i + 1, true);
          playBtn.textContent = 'Pause';
          tick(n);
        }, Math.max(2800, msgCount * MSG_MS + 2000));
      };
      tick((data.scenarios[current.s].steps[current.i].messages || []).length);
    }

    // ---- Keyboard ----
    ui.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') { stop(); go(current.s, current.i + 1, true); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stop(); go(current.s, current.i - 1, true); e.preventDefault(); }
      else if (e.key === 'Home') { stop(); go(current.s, 0, true); e.preventDefault(); }
      else if (e.key === 'End') { stop(); go(current.s, data.scenarios[current.s].steps.length - 1, true); e.preventDefault(); }
      else if ((e.key === ' ' || e.key === 'Spacebar') && e.target === ui) {
        if (playTimer) { stop(); } else { play(); }
        e.preventDefault();
      }
    });

    // ---- Links: #scenario or #scenario-N ----
    function fromHash() {
      var h = decodeURIComponent((window.location.hash || '').slice(1));
      if (!h) return null;
      for (var a = 0; a < data.scenarios.length; a++) {
        if (data.scenarios[a].id === h) return { s: a, i: 0 };
      }
      for (var b = 0; b < data.scenarios.length; b++) {
        var prefix = data.scenarios[b].id + '-';
        if (h.indexOf(prefix) === 0 && /^\d+$/.test(h.slice(prefix.length))) {
          return { s: b, i: parseInt(h.slice(prefix.length), 10) - 1 };
        }
      }
      return null;
    }

    window.addEventListener('hashchange', function () {
      var target = fromHash();
      if (target) { stop(); go(target.s, target.i, false); root.scrollIntoView({ block: 'start' }); }
    });

    var start = fromHash();
    if (start) {
      go(start.s, start.i, false);
      root.scrollIntoView({ block: 'start' });
    } else {
      go(0, 0, false);
    }
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('figure.flow[data-flow]'), init);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
