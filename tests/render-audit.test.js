/**
 * Tests for src/js/render-audit.js — run with: node --test tests/
 * (or directly: node tests/render-audit.test.js). No network, no GPU, no DOM:
 * the real Renderer3D class is loaded from source only to compare its pure
 * static findLayerStarts against the audit's layer starts.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RenderAudit = require('../src/js/render-audit.js');

// Load the real Renderer3D class without a browser: the file is a single
// top-level class declaration; StockMeshRenderer/document are only touched
// inside methods we never call.
const Renderer3D = new Function(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'renderer3d.js'), 'utf8') +
    '\nreturn Renderer3D;'
)();

const pt = (x, y, z) => ({ x, y, z });

// Tool changes, several Z levels, plunges and a ramp, rapids mixed with cuts.
// Layer starts traced by hand from Renderer3D.findLayerStarts:
//   move 1 starts tool 0's first layer (tool seen for the first time),
//   the level cut at move 7 (z=-2 after z=-1) restarts the layer at move 4
//   (last level cut was move 3), so the retract/plunge at 4..6 join it,
//   move 9 starts tool 1's layer fresh and its ramp into z=-2 belongs to it.
const MOVES = [
    { type: 'rapid', tool: 0, start: pt(0, 0, 5),    end: pt(0, 0, 5) },     // 0
    { type: 'cut',   tool: 0, start: pt(0, 0, 5),    end: pt(0, 0, -1) },    // 1 plunge
    { type: 'cut',   tool: 0, start: pt(0, 0, -1),   end: pt(10, 0, -1) },   // 2 level -1
    { type: 'cut',   tool: 0, start: pt(10, 0, -1),  end: pt(10, 10, -1) },  // 3 level -1
    { type: 'rapid', tool: 0, start: pt(10, 10, -1), end: pt(10, 10, 2) },   // 4 retract
    { type: 'rapid', tool: 0, start: pt(10, 10, 2),  end: pt(20, 20, 2) },   // 5
    { type: 'cut',   tool: 0, start: pt(20, 20, 2),  end: pt(20, 20, -2) },  // 6 plunge
    { type: 'cut',   tool: 0, start: pt(20, 20, -2), end: pt(30, 20, -2) },  // 7 level -2
    { type: 'rapid', tool: 1, start: pt(30, 20, -2), end: pt(30, 20, 5) },   // 8
    { type: 'cut',   tool: 1, start: pt(30, 20, 5),  end: pt(30, 30, -2) },  // 9 ramp, tool change
    { type: 'cut',   tool: 1, start: pt(30, 30, -2), end: pt(40, 30, -2) },  // 10 level -2
];
const EXPECTED_STARTS = [0, 1, 1, 1, 1, 1, 1, 4, 4, 9, 9];

test('layer starts match Renderer3D.findLayerStarts value for value', () => {
    const actual = Renderer3D.findLayerStarts(MOVES);
    const audit = RenderAudit.auditLayers(MOVES);
    assert.equal(audit.layerStarts.length, actual.length);
    for (let i = 0; i < actual.length; i++) assert.equal(audit.layerStarts[i], actual[i], `move ${i}`);
    assert.deepEqual(audit.layerStarts, EXPECTED_STARTS); // hand-traced, incl. tool change at 9
    assert.equal(audit.layerCount, 4);
    assert.ok(audit.drawable.every(Boolean));
});

test('layer starts match on a Z-only-move edge case (no level cut ever)', () => {
    const moves = [
        { type: 'cut', tool: 2, start: pt(0, 0, 3), end: pt(0, 0, -1) }, // plunge only
        { type: 'cut', tool: 2, start: pt(0, 0, -1), end: pt(0, 0, -3) }, // straight down again
        { type: 'probe', tool: 2, start: pt(0, 0, -3), end: pt(1, 1, -3) }, // not a cut: ignored
    ];
    const actual = Renderer3D.findLayerStarts(moves);
    assert.deepEqual(RenderAudit.auditLayers(moves).layerStarts, Array.from(actual));
});

test('vertex counts with flats and rapids mixed match hand calculation', () => {
    // Everything visible, animation past the end: 4 rapids * 2 + 7 cuts * 2
    let audit = RenderAudit.auditDraw(MOVES, { maxSegmentIndex: Infinity, segmentProgress: 1 });
    assert.equal(audit.rapidVertices, 8);
    assert.equal(audit.cutVertices, 14);
    assert.equal(audit.index, MOVES.length);
    assert.equal(audit.from, 0);
    assert.equal(audit.layerOnly.active, false);

    // Animation at move 8: rapids 0,4,5 -> 6 vertices; cuts 1,2,3,6,7 -> 10
    audit = RenderAudit.auditDraw(MOVES, { maxSegmentIndex: 8, segmentProgress: 1 });
    assert.equal(audit.rapidVertices, 6);
    assert.equal(audit.cutVertices, 10);

    // Mid-move 2 (a cut from x=0 to x=10 at z=-1), halfway
    audit = RenderAudit.auditDraw(MOVES, { maxSegmentIndex: 2, segmentProgress: 0.5 });
    assert.equal(audit.rapidVertices, 2); // move 0
    assert.equal(audit.cutVertices, 2);   // move 1
    assert.deepEqual(audit.inProgress, {
        index: 2, kind: 'cut', position: { x: 5, y: 0, z: -1 }, drawn: true
    });
});

test('hidden rapids are excluded with a reason', () => {
    const audit = RenderAudit.auditDraw(MOVES, { rapidVisible: false });
    assert.equal(audit.rapidVertices, 0);
    assert.equal(audit.bufferedRapidVertices, 0);
    assert.equal(audit.cutVertices, 14); // cuts unaffected
    for (const i of [0, 4, 5, 8]) {
        assert.equal(audit.visible[i], false);
        assert.equal(audit.hiddenReason[i], 'rapid-hidden');
    }
    assert.equal(audit.hiddenReason[2], null);
});

test('cuts of a hidden tool are excluded with a reason', () => {
    const audit = RenderAudit.auditDraw(MOVES, { toolStates: { 0: { visible: false, color: '#123456' } } });
    assert.equal(audit.cutVertices, 4); // only tool 1's moves 9 and 10 remain
    assert.equal(audit.rapidVertices, 8); // rapids are not tool-filtered
    for (const i of [1, 2, 3, 6, 7]) assert.equal(audit.hiddenReason[i], 'tool-hidden');
    assert.equal(audit.hiddenReason[9], null);
});

test('moves outside the layer filter are excluded with a reason', () => {
    const audit = RenderAudit.auditDraw(MOVES, { layerFilterMin: -1.5, layerFilterMax: 0 });
    // start.z outside [-1.5, 0]: moves 0,1,9 (z=5), 5,6 (z=2), 7,8,10 (z=-2);
    // move 4's retract starts at z=-1, so it passes
    for (const i of [0, 1, 5, 6, 7, 8, 9, 10]) assert.equal(audit.hiddenReason[i], 'layer-filter');
    for (const i of [2, 3, 4]) assert.equal(audit.hiddenReason[i], null);
    assert.equal(audit.rapidVertices, 2); // move 4 only
    assert.equal(audit.cutVertices, 4);   // moves 2 and 3 only
});

test('edge cases: empty moves, Infinity index, progress 0 and 1', () => {
    const emptyLayers = RenderAudit.auditLayers([]);
    assert.deepEqual(emptyLayers, { layerStarts: [], layerCount: 0, drawable: [] });

    const empty = RenderAudit.auditDraw([], {});
    assert.equal(empty.moveCount, 0);
    assert.equal(empty.index, 0);
    assert.equal(empty.rapidVertices, 0);
    assert.equal(empty.cutVertices, 0);
    assert.equal(empty.inProgress, null);
    assert.equal(empty.gridZ, 0);
    assert.equal(empty.layerOnly.active, false);

    // Infinity clamps to the move count instead of throwing
    const inf = RenderAudit.auditDraw(MOVES, { maxSegmentIndex: Infinity });
    assert.equal(inf.index, MOVES.length);
    assert.equal(inf.inProgress, null);

    // progress at the exact ends of (0,1) draws no partial move
    for (const segmentProgress of [0, 1]) {
        const audit = RenderAudit.auditDraw(MOVES, { maxSegmentIndex: 2, segmentProgress });
        assert.equal(audit.inProgress, null);
        assert.equal(audit.cutVertices, 2); // only move 1, the completed cut
    }
});

test('stock shown: grid sits at stock zmin and layer-only branch narrows the draw', () => {
    const audit = RenderAudit.auditDraw(MOVES, {
        stockVisible: true,
        stockZmin: -3,
        stockLayerOnly: true,
        maxSegmentIndex: 7,
        segmentProgress: 1,
    });
    assert.equal(audit.gridZ, -3); // gridZ() === stock zmin while the stock is shown
    assert.equal(audit.layerOnly.active, true);
    assert.equal(audit.from, EXPECTED_STARTS[7]); // current layer starts at move 4
    assert.equal(audit.rapidVertices, 4); // moves 4,5 only
    assert.equal(audit.cutVertices, 2);   // move 6 only

    // Stock hidden again: grid back at Z0, no layer-only branch
    const plain = RenderAudit.auditDraw(MOVES, { stockVisible: false, stockZmin: -3 });
    assert.equal(plain.gridZ, 0);
    assert.equal(plain.layerOnly.active, false);
    assert.equal(plain.layerOnly.reason, 'stock not shown');

    // Stock shown but animation finished: layer-only cannot apply
    const done = RenderAudit.auditDraw(MOVES, { stockVisible: true, stockLayerOnly: true });
    assert.equal(done.layerOnly.active, false);
    assert.equal(done.layerOnly.reason, 'animation at or past the last move');
});

test('audit output is JSON-serializable plain data', () => {
    for (const result of [
        RenderAudit.auditLayers(MOVES),
        RenderAudit.auditDraw(MOVES, { stockVisible: true, stockZmin: -3, stockLayerOnly: true, maxSegmentIndex: 2, segmentProgress: 0.25 }),
        RenderAudit.auditDraw([], {}),
    ]) {
        // deepEqual against the round trip catches anything JSON drops or
        // mutates (functions, undefined, typed arrays, non-plain objects)
        const roundTrip = JSON.parse(JSON.stringify(result));
        assert.deepEqual(roundTrip, result);
    }
});

test('non-drawable moves are flagged in the layer audit', () => {
    const moves = [
        { type: 'cut', tool: 0, start: pt(0, 0, 0), end: pt(1, 0, 0) },
        { type: 'arc', tool: 0, start: pt(0, 0, 0), end: pt(1, 0, 0) },      // unknown type
        { type: 'cut', tool: 0, start: pt(0, 0, 0), end: pt(NaN, 0, 0) },    // bad coordinate
    ];
    assert.deepEqual(RenderAudit.auditLayers(moves).drawable, [true, false, false]);
});
