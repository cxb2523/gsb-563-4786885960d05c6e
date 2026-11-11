/**
 * 3D view audit — pure-function mirrors of Renderer3D's draw decisions.
 *
 * Renderer3D decides which moves become vertices, where each move's layer
 * starts, how far the animation has drawn, and at what height the grid sits,
 * all inside the render loop. This module re-derives the same answers as
 * plain data so tests and tooling can check them without a WebGL context,
 * a DOM, or a theme attribute. It reads nothing global and changes nothing;
 * every output is JSON-serializable plain data.
 *
 * Consistency contract with renderer3d.js:
 *  - layer starts equal Renderer3D.findLayerStarts value for value
 *  - grid height equals gridZ(): stock zmin while the stock is shown, else 0
 *  - a move counts toward vertices exactly when updateBuffers' segmentVisible
 *    would keep it (layer filter on start.z, hidden rapids, hidden cut tools)
 *  - maxSegmentIndex clamps to the move count; segmentProgress outside (0,1)
 *    means no move is in progress
 *
 * Loaded as a plain script it sets window.RenderAudit; under Node it is a
 * CommonJS module.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.RenderAudit = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    // Same tolerance Renderer3D.findLayerStarts uses to call a cut "level"
    const EPS = 1e-4;

    /**
     * Layer start index per move — the same algorithm as
     * Renderer3D.findLayerStarts, returning a plain Array instead of a
     * Uint32Array so the result survives JSON.stringify unchanged.
     */
    function findLayerStarts(moves) {
        const starts = new Array(moves.length);
        let start = 0, level = null, lastLevelCut = -1, tool = null;
        for (let i = 0; i < moves.length; i++) {
            const seg = moves[i];
            if (seg.type === 'cut') {
                if (seg.tool !== tool) {
                    tool = seg.tool;
                    start = i;
                    level = null;
                    lastLevelCut = -1;
                }
                if (Math.abs(seg.end.z - seg.start.z) < EPS) {
                    if (level !== null && Math.abs(seg.end.z - level) > EPS) start = lastLevelCut + 1;
                    level = seg.end.z;
                    lastLevelCut = i;
                }
            }
            starts[i] = start;
        }
        return starts;
    }

    /**
     * Whether a move is well-formed enough to draw: a known move type with
     * finite start/end coordinates. (Visibility filtering is auditDraw's job;
     * this is only about the move itself.)
     */
    function isDrawable(move) {
        if (!move || (move.type !== 'rapid' && move.type !== 'cut' && move.type !== 'probe')) return false;
        for (const point of [move.start, move.end]) {
            if (!point) return false;
            for (const axis of ['x', 'y', 'z']) {
                if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis])) return false;
            }
        }
        return true;
    }

    /**
     * Audit the layer structure of a move list.
     * @param {Array} moves segments like Renderer3D.setSegments takes:
     *        { type: 'rapid'|'cut'|'probe', start: {x,y,z}, end: {x,y,z}, tool }
     * @returns {{ layerStarts: number[], layerCount: number, drawable: boolean[] }}
     *   layerStarts[i] is the index where move i's layer starts (equal to
     *   Renderer3D.findLayerStarts(moves)[i]); layerCount is the number of
     *   distinct layers; drawable[i] says the move itself is drawable.
     */
    function auditLayers(moves) {
        moves = moves || [];
        const layerStarts = findLayerStarts(moves);
        let layerCount = 0;
        for (let i = 0; i < layerStarts.length; i++) {
            if (i === 0 || layerStarts[i] !== layerStarts[i - 1]) layerCount++;
        }
        return {
            layerStarts,
            layerCount,
            drawable: moves.map(isDrawable)
        };
    }

    /**
     * Look up a tool's state whether the snapshot passed a Map (like
     * Renderer3D.toolStates) or a plain object keyed by tool number.
     */
    function toolState(toolStates, toolNum) {
        if (!toolStates) return undefined;
        if (toolStates instanceof Map) return toolStates.get(toolNum);
        return toolStates[toolNum];
    }

    /**
     * Why a move is not drawn, mirroring the checks in updateBuffers'
     * segmentVisible, in the same order. null means it is drawn.
     */
    function hiddenReason(seg, view, rapidVisible, toolStates) {
        if (seg.start.z < view.layerFilterMin || seg.start.z > view.layerFilterMax) return 'layer-filter';
        if (seg.type === 'rapid' && !rapidVisible) return 'rapid-hidden';
        if (seg.type === 'cut') {
            const state = toolState(toolStates, seg.tool || 0);
            if (state && state.visible === false) return 'tool-hidden';
        }
        return null;
    }

    /**
     * Audit what one frame of the 3D view would draw.
     * @param {Array} moves same segment shape as auditLayers
     * @param {Object} [view] view state snapshot:
     *   stockVisible   {boolean} stock solid shown (stands in for stockMesh && sim)
     *   stockZmin      {number}  bottom of the stock; the grid height while shown
     *   stockLayerOnly {boolean} draw only the current layer while animating stock
     *   layerFilterMin {number}  lowest start.z drawn (default -Infinity)
     *   layerFilterMax {number}  highest start.z drawn (default Infinity)
     *   rapidVisible   {boolean} rapid (G0) moves drawn (default true)
     *   toolStates     {Object|Map} tool number -> { visible, color }
     *   maxSegmentIndex {number} animation position (default: all moves);
     *                    clamped to [0, moves.length], so Infinity draws all
     *   segmentProgress {number} fraction of the current move done; only a
     *                    value strictly inside (0,1) draws a partial move
     * @returns plain-data audit:
     *   moveCount, index (clamped animation position), from (first move drawn),
     *   layerOnly: { active, reason } — the "current layer only" branch and why,
     *   gridZ — grid plane height, equal to Renderer3D.gridZ() in this state,
     *   visible / hiddenReason — per move, with 'layer-filter' | 'rapid-hidden'
     *     | 'tool-hidden' | null,
     *   rapidVertices / cutVertices — vertices drawToolpaths would draw from
     *     the buffers (moves `from`..`index`-1 that passed visibility),
     *   bufferedRapidVertices / bufferedCutVertices — all visible moves, the
     *     totals updateBuffers would upload,
     *   inProgress — null, or { index, kind, position: {x,y,z}, drawn } for the
     *     partially drawn move; drawn is false when that move is hidden
     */
    function auditDraw(moves, view) {
        moves = moves || [];
        view = view || {};
        const n = moves.length;
        const layerStarts = findLayerStarts(moves);

        const layerView = {
            layerFilterMin: view.layerFilterMin === undefined ? -Infinity : view.layerFilterMin,
            layerFilterMax: view.layerFilterMax === undefined ? Infinity : view.layerFilterMax
        };
        const rapidVisible = view.rapidVisible !== false;
        const toolStates = view.toolStates;

        // Visibility per move, and the vertex prefix counts updateBuffers builds
        const visible = new Array(n);
        const reasons = new Array(n);
        const rapidBefore = new Array(n + 1);
        const cutBefore = new Array(n + 1);
        let r = 0, c = 0;
        for (let i = 0; i < n; i++) {
            const reason = hiddenReason(moves[i], layerView, rapidVisible, toolStates);
            visible[i] = reason === null;
            reasons[i] = reason;
            rapidBefore[i] = r;
            cutBefore[i] = c;
            if (reason === null) {
                // updateBuffers puts probes with the cuts; only rapids are apart
                if (moves[i].type === 'rapid') r += 2; else c += 2;
            }
        }
        rapidBefore[n] = r;
        cutBefore[n] = c;

        // drawToolpaths clamps the animation position to the move count
        let index = view.maxSegmentIndex === undefined ? n : view.maxSegmentIndex;
        if (typeof index !== 'number' || Number.isNaN(index)) index = n;
        index = Math.max(0, Math.min(index, n));

        // The "current layer only" branch of drawToolpaths
        const stockVisible = view.stockVisible === true;
        const stockLayerOnly = view.stockLayerOnly === true;
        let layerOnlyReason;
        if (!stockVisible) layerOnlyReason = 'stock not shown';
        else if (!stockLayerOnly) layerOnlyReason = 'layer-only display off';
        else if (index >= n) layerOnlyReason = 'animation at or past the last move';
        else layerOnlyReason = 'stock shown with layer-only display while animating';
        const layerOnly = stockVisible && stockLayerOnly && index < n;
        const from = layerOnly ? layerStarts[index] : 0;

        // The move in progress, interpolated to where the tool is
        const progress = view.segmentProgress === undefined ? 1 : view.segmentProgress;
        let inProgress = null;
        if (index < n && progress > 0 && progress < 1) {
            const seg = moves[index];
            inProgress = {
                index,
                kind: seg.type === 'rapid' ? 'rapid' : 'cut',
                position: {
                    x: seg.start.x + (seg.end.x - seg.start.x) * progress,
                    y: seg.start.y + (seg.end.y - seg.start.y) * progress,
                    z: seg.start.z + (seg.end.z - seg.start.z) * progress
                },
                drawn: visible[index]
            };
        }

        return {
            moveCount: n,
            index,
            from,
            layerOnly: { active: layerOnly, reason: layerOnlyReason },
            gridZ: stockVisible ? (view.stockZmin == null ? 0 : view.stockZmin) : 0,
            visible,
            hiddenReason: reasons,
            rapidVertices: rapidBefore[index] - rapidBefore[from],
            cutVertices: cutBefore[index] - cutBefore[from],
            bufferedRapidVertices: r,
            bufferedCutVertices: c,
            inProgress
        };
    }

    return { findLayerStarts, isDrawable, auditLayers, auditDraw };
});
