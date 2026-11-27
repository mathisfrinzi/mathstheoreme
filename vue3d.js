/* Vue 3D du graphe (v0.66.0) — s'appuie sur 3d-force-graph (three.js), chargé à la première ouverture.
   Volume de chaque boule ∝ 1 + nombre de sous-ensembles contenus (même fermeture transitive que la vue 2D).
   Aucun texte sur les boules, sauf : ensemble sélectionné, ou caméra assez proche pour lire tout le nom. */
(function () {
  var LIBS = window.VUE3D_LIBS || [
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js",
    "https://cdn.jsdelivr.net/npm/3d-force-graph@1.73.4/dist/3d-force-graph.min.js"
  ];
  var REL = 3.4;              // rayon d'une feuille ; rayon = REL · (1 + sous-ensembles)^(1/3)  → volume proportionnel
  var MIN_LABEL_PX = 130;     // largeur écran minimale du libellé pour qu'il soit affiché
  var EDGE_COL = { definition: "#d8dde6", theoreme: "#52c98f", equivalence: "#5aa9e6", partie: "#f29a4e",
    anti: "#ee5c85", conjecture: "#f2c14e", disjoint: "#d9487a", isomorphisme: "#b07cf0" };
  var G = null, active = false, loading = false, host, btn, hud, selId = null, keep = null, showNeg = false;
  var nodesById = {}, graphData = null, raf = 0;

  function edgeKeyOf(l) {
    if (l.kind === "inclusion") { return l.depth === "définitoire" ? "definition" : "theoreme"; }
    return l.kind;
  }
  function rgba(c, a) {
    var m = /rgba?\(([^)]+)\)/.exec(c), r, g, b;
    if (m) { var p = m[1].split(","); r = +p[0]; g = +p[1]; b = +p[2]; }
    else { var h = (c || "#cfd9e4").replace("#", ""); if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
      r = parseInt(h.substr(0, 2), 16); g = parseInt(h.substr(2, 2), 16); b = parseInt(h.substr(4, 2), 16); }
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function radius(n) { return REL * Math.cbrt(1 + n.sub); }
  function baseAlpha(n) { return n.sub > 200 ? 0.28 : n.sub > 50 ? 0.55 : 0.95; }

  // ---------- données ----------
  function buildData() {
    nodesById = {};
    var nodes = [];
    cy.nodes().forEach(function (c) {
      if (c.hasClass("ctxobj") || c.data("subCount") === undefined) { return; }
      var n = { id: c.id(), label: c.data("label"), domain: c.data("domain"), sub: c.data("subCount") || 0,
        color: c.style("background-color") };
      nodesById[n.id] = n; nodes.push(n);
    });
    var links = [];
    GRAPH.edges.forEach(function (e) {
      if (nodesById[e.from] && nodesById[e.to]) {
        links.push({ id: e.id, source: e.from, target: e.to, kind: e.kind, depth: e.depth });
      }
    });
    graphData = { nodes: nodes, links: links };
  }

  // ---------- libellés (sprites créés à la demande) ----------
  function makeLabel(n) {
    var T = window.THREE, W = 300, fs = 30, lh = 36, pad = 10;
    var cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    ctx.font = "600 " + fs + "px Inter, system-ui, sans-serif";
    var words = n.label.split(" "), lines = [], cur = "";
    words.forEach(function (w) {
      var t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width > W - 2 * pad && cur) { lines.push(cur); cur = w; } else { cur = t; }
    });
    lines.push(cur);
    cv.width = W; cv.height = lines.length * lh + 2 * pad;
    ctx.font = "600 " + fs + "px Inter, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#1f2530";
    lines.forEach(function (l, i) { ctx.fillText(l, W / 2, pad + lh * (i + 0.5)); });
    var tex = new T.CanvasTexture(cv);
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true }));
    var w = 1.55 * radius(n);
    sp.scale.set(w, w * cv.height / cv.width, 1);
    sp.visible = false;
    sp.__w = w;
    return sp;
  }

  function updateLabels() {
    if (!active || !G) { return; }
    var cam = G.camera(), H = host.clientHeight || 800, tf = Math.tan(cam.fov * Math.PI / 360);
    var cp = cam.position;
    graphData.nodes.forEach(function (n) {
      var grp = n.__lbl; if (!grp || n.x === undefined) { return; }
      var dx = cp.x - n.x, dy = cp.y - n.y, dz = cp.z - n.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      var w = 1.55 * radius(n);
      var near = (w * H) / (2 * d * tf) >= MIN_LABEL_PX && d > radius(n);
      var show = (near || n.id === selId) && !(window.DOM_OFF && DOM_OFF[n.domain]) && (!keep || keep[n.id]);
      if (show && !grp.children.length) { grp.add(makeLabel(n)); }
      var sp = grp.children[0];
      if (sp) {
        sp.visible = show;
        if (show) { var k = radius(n) * 1.06 / d; sp.position.set(dx * k, dy * k, dz * k); }
      }
    });
  }
  function loop() { if (!active) { return; } updateLabels(); raf = requestAnimationFrame(loop); }

  // ---------- sélection ----------
  function focusSet(id) {
    var preds = {};
    GRAPH.edges.forEach(function (e) {
      if (e.kind !== "inclusion" && e.kind !== "equivalence" && e.kind !== "partie") { return; }
      (preds[e.to] = preds[e.to] || []).push(e.from);
      if (e.kind === "equivalence") { (preds[e.from] = preds[e.from] || []).push(e.to); }
    });
    var k = {}, pile = [id]; k[id] = true;
    while (pile.length) { var x = pile.pop(); (preds[x] || []).forEach(function (p) { if (!k[p]) { k[p] = true; pile.push(p); } }); }
    return k;
  }
  function refreshStyle() {
    if (!G) { return; }
    G.nodeColor(function (n) { return rgba(n.color, keep && !keep[n.id] ? 0.06 : baseAlpha(n)); });
    G.linkColor(linkColor).linkWidth(function (l) { return keep && endpointsKept(l) ? 1.6 : 0.5; });
    G.nodeVisibility(nodeVisible).linkVisibility(linkVisible);
  }
  function endpointsKept(l) { return keep && keep[idOf(l.source)] && keep[idOf(l.target)]; }
  function idOf(x) { return typeof x === "object" ? x.id : x; }
  function linkColor(l) {
    var c = EDGE_COL[edgeKeyOf(l)] || "#888";
    if (keep) { return endpointsKept(l) ? rgba(c, 0.95) : rgba(c, 0.03); }
    return rgba(c, 0.55);
  }
  function nodeVisible(n) { return !(window.DOM_OFF && DOM_OFF[n.domain]); }
  function linkVisible(l) {
    var k = edgeKeyOf(l);
    if (window.EDGE_VIS && EDGE_VIS[k] === false) { return false; }
    if (!showNeg && (k === "anti" || k === "conjecture" || k === "disjoint")) { return false; }
    return nodeVisible(nodesById[idOf(l.source)]) && nodeVisible(nodesById[idOf(l.target)]);
  }
  function select(n, fly) {
    selId = n.id; keep = focusSet(n.id);
    refreshStyle();
    showPanel(nodeHtml(cy.getElementById(n.id).data()));
    showFormulas(n.id);
    if (fly && n.x !== undefined) {
      var cp = G.camera().position, r = radius(n);
      var dx = cp.x - n.x, dy = cp.y - n.y, dz = cp.z - n.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      var k = (r * 4.6) / d;
      G.cameraPosition({ x: n.x + dx * k, y: n.y + dy * k, z: n.z + dz * k }, { x: n.x, y: n.y, z: n.z }, 900);
    }
  }
  function clearSel() { selId = null; keep = null; refreshStyle(); showPanel(defaultPanel()); hideFormulas(); }

  // ---------- forces ----------
  function collideForce() {
    var nodes = [];
    function f() {
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i], ra = radius(a);
        for (var j = i + 1; j < nodes.length; j++) {
          var b = nodes[j], dx = b.x - a.x; var m = ra + radius(b) + 1.5;
          if (dx > m || dx < -m) { continue; }
          var dy = b.y - a.y; if (dy > m || dy < -m) { continue; }
          var dz = b.z - a.z; if (dz > m || dz < -m) { continue; }
          var d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= m * m || d2 === 0) { continue; }
          var d = Math.sqrt(d2), s = (m - d) / d * 0.5;
          a.vx -= dx * s; a.vy -= dy * s; a.vz -= dz * s; b.vx += dx * s; b.vy += dy * s; b.vz += dz * s;
        }
      }
    }
    f.initialize = function (n) { nodes = n; };
    return f;
  }

  function gravityForce(k) {
    var nodes = [];
    function f(alpha) { nodes.forEach(function (n) { n.vx -= n.x * k * alpha; n.vy -= n.y * k * alpha; n.vz -= n.z * k * alpha; }); }
    f.initialize = function (n) { nodes = n; };
    return f;
  }
  function arrowPos(l) {
    var s = l.source, t = l.target;
    if (typeof s !== "object" || s.x === undefined) { return 0.9; }
    var len = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z) || 1;
    return Math.max(0.5, 1 - (radius(t) + 2) / len);
  }

  // ---------- montage ----------
  function create() {
    buildData();
    G = ForceGraph3D()(host)
      .backgroundColor("#0f1216")
      .graphData(graphData)
      .nodeRelSize(REL).nodeVal(function (n) { return 1 + n.sub; })
      .nodeResolution(12).nodeLabel(function () { return ""; })
      .nodeOpacity(1).showNavInfo(false)
      .nodeThreeObject(function (n) { var g = new THREE.Group(); n.__lbl = g; return g; })
      .nodeThreeObjectExtend(true)
      .linkDirectionalArrowLength(3.5).linkDirectionalArrowRelPos(arrowPos)
      .linkDirectionalArrowColor(linkColor)
      .linkOpacity(1)
      .onNodeClick(function (n) { select(n, true); })
      .onLinkClick(function (l) { showPanel(edgeHtml(cy.getElementById(l.id).data())); hideFormulas(); })
      .onBackgroundClick(clearSel)
      .cooldownTicks(260).warmupTicks(60)
      .onEngineStop(function () { G.linkDirectionalArrowRelPos(arrowPos); });
    G.d3Force("link").distance(function (l) { return radius(l.source) + radius(l.target) + 8; });
    G.d3Force("charge").strength(function (n) { return -10 - 3 * radius(n); });
    G.d3Force("collide", collideForce());
    G.d3Force("gravity", gravityForce(0.12));
    refreshStyle();
    resize();
    setTimeout(function () { G.zoomToFit(800, 30); }, 2500);
  }
  function resize() { if (G) { G.width(host.clientWidth).height(host.clientHeight); } }

  function loadLibs(cb) {
    if (window.ForceGraph3D) { cb(); return; }
    var i = 0;
    (function next() {
      if (i >= LIBS.length) { cb(); return; }
      var s = document.createElement("script");
      s.src = LIBS[i++]; s.onload = next;
      s.onerror = function () { loading = false; btn.textContent = "3D indisponible"; };
      document.head.appendChild(s);
    })();
  }

  function setMode(on) {
    if (on === active) { return; }
    if (on) {
      if (loading) { return; }
      loading = true; btn.textContent = "Chargement…";
      loadLibs(function () {
        loading = false;
        active = true;
        document.getElementById("cy").style.display = "none";
        host.style.display = "block"; hud.style.display = "flex"; if (window.__zoom3d) { window.__zoom3d.box.style.display = "flex"; }
        btn.textContent = "2D"; btn.classList.add("on");
        if (!G) { create(); } else { rebuildData(); }
        resize(); loop();
      });
    } else {
      active = false; cancelAnimationFrame(raf);
      host.style.display = "none"; hud.style.display = "none"; if (window.__zoom3d) { window.__zoom3d.box.style.display = "none"; }
      document.getElementById("cy").style.display = "";
      btn.textContent = "3D"; btn.classList.remove("on");
      if (cy) { cy.resize(); }
    }
  }
  function rebuildData() {
    buildData(); G.graphData(graphData); refreshStyle();
  }

  function init() {
    var wrap = document.getElementById("cywrap");
    host = document.createElement("div"); host.id = "g3d";
    host.style.cssText = "position:absolute;inset:0;display:none;background:#0f1216;z-index:1";
    wrap.insertBefore(host, wrap.firstChild);
    var hudEl = document.getElementById("hud"); if (hudEl) { hudEl.style.zIndex = 5; }
    hud = document.createElement("div");
    hud.style.cssText = "position:absolute;left:14px;bottom:10px;z-index:4;display:none;flex-direction:column;gap:4px;font:12px Inter,system-ui,sans-serif;color:#9aa4b2;pointer-events:auto";
    hud.innerHTML = "<label style='display:flex;gap:6px;align-items:center;cursor:pointer'><input type='checkbox' id='neg3d' style='accent-color:#ee5c85;margin:0'/> contre-exemples et conjectures</label>" +
      "<span>Volume ∝ nombre de sous-ensembles · clic : fiche et sous-ensembles · approchez-vous pour lire les noms</span>";
    wrap.appendChild(hud);
    hud.querySelector("#neg3d").addEventListener("change", function () { showNeg = this.checked; refreshStyle(); });
    btn = document.createElement("button");
    btn.id = "mode3d"; btn.textContent = "3D"; btn.title = "Basculer entre la vue 2D et la vue 3D";
    var ctrl = document.querySelector("header .controls");
    ctrl.insertBefore(btn, ctrl.firstChild);
    btn.addEventListener("click", function () { setMode(!active); });
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) { new ResizeObserver(resize).observe(host); }
    document.addEventListener("change", function (ev) {
      if (!active || !G) { return; }
      var t = ev.target;
      if (t.id === "colormode") { setTimeout(rebuildData, 0); }
      else if (t.matches && t.matches("#legend input, #filterbody input")) { setTimeout(refreshStyle, 0); }
    });
    document.addEventListener("click", function (ev) {
      if (active && ev.target.closest && ev.target.closest("#fall, #fnone")) { setTimeout(refreshStyle, 50); }
    });
    var sb = document.getElementById("search");
    sb.addEventListener("keydown", function (ev) {
      if (!active || ev.key !== "Enter") { return; }
      var q = sb.value.trim().toLowerCase(); if (!q) { return; }
      var hit = graphData.nodes.filter(function (n) { return n.label.toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return b.sub - a.sub; })[0];
      if (hit) { select(hit, true); }
    });
    // navigation depuis les liens de la fiche
    var g2d = window.goToNode;
    window.goToNode = function (id) {
      if (active && G && nodesById[id]) { select(nodesById[id], true); } else { g2d(id); }
    };
    // barre de zoom sous la légende
    var zb = document.createElement("div");
    zb.id = "zoom3d";
    zb.style.cssText = "display:none;align-items:center;gap:6px;background:rgba(26,30,37,.95);border:1px solid #2a313b;border-radius:12px;padding:6px 10px;color:#e6e9ee;font:12px Inter,system-ui,sans-serif";
    zb.innerHTML = "<button type='button' id='zout' title='Dézoomer' style='width:24px;height:24px;border-radius:6px;cursor:pointer'>−</button>" +
      "<input id='zrange' type='range' min='0' max='100' step='0.5' value='50' style='width:120px;accent-color:#ee5c85'/>" +
      "<button type='button' id='zin' title='Zoomer' style='width:24px;height:24px;border-radius:6px;cursor:pointer'>+</button>";
    if (hudEl) { hudEl.appendChild(zb); } else { wrap.appendChild(zb); }
    var zr = zb.querySelector("#zrange"), ZMIN = 8, ZMAX = 4000;
    function camDist() { var c = G.camera().position, t = G.controls().target; return Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z) || 1; }
    function setDist(d) {
      d = Math.max(ZMIN, Math.min(ZMAX, d));
      var c = G.camera().position, t = G.controls().target, k = d / camDist();
      G.cameraPosition({ x: t.x + (c.x - t.x) * k, y: t.y + (c.y - t.y) * k, z: t.z + (c.z - t.z) * k }, { x: t.x, y: t.y, z: t.z }, 0);
    }
    function syncZoom() { if (!G) { return; } var d = Math.max(ZMIN, Math.min(ZMAX, camDist())); zr.value = 100 * (1 - Math.log(d / ZMIN) / Math.log(ZMAX / ZMIN)); }
    zr.addEventListener("input", function () { setDist(ZMIN * Math.pow(ZMAX / ZMIN, 1 - zr.value / 100)); });
    zb.querySelector("#zin").addEventListener("click", function () { if (G) { setDist(camDist() / 1.4); syncZoom(); } });
    zb.querySelector("#zout").addEventListener("click", function () { if (G) { setDist(camDist() * 1.4); syncZoom(); } });
    window.__zoom3d = { box: zb, sync: syncZoom };
    setInterval(function () { if (active && G && document.activeElement !== zr) { syncZoom(); } }, 300);
    var rb = window.rebuild;
    window.rebuild = function () { rb.apply(this, arguments); if (active && G) { rebuildData(); } };
  }
  init();
})();
