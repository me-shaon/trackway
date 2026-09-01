#!/usr/bin/env node
/**
 * Draws the pipeline diagram for the README, once per theme.
 *
 * Two files rather than one with a media query, because that is what GitHub
 * actually honours: the README already pairs `docs/explorer-light.png` with
 * `docs/explorer-dark.png` behind a `<picture>`, and a diagram that picked its
 * own colours would be the one thing on the page ignoring the reader's theme.
 *
 * Generated rather than hand-written for the same reason the explorer bundle is
 * checked in CI: two copies of the same drawing drift, and the one that drifts
 * is the one fewer people look at.
 *
 * Colours are the explorer's own tokens from packages/ui/src/styles.css, so the
 * diagram and the product it describes are recognisably the same thing.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const THEMES = {
  light: {
    box: '#f5f5f2',
    edge: '#d6d6d0',
    ink: '#22262c',
    faint: '#6a7179',
    line: '#9aa0a7',
    sure: '#3f9a7c',
    store: '#7a5cb8',
    storeFill: '#f4f1fb',
  },
  dark: {
    box: '#191c21',
    edge: '#343a42',
    ink: '#e6e9ec',
    faint: '#939aa2',
    line: '#6e757e',
    sure: '#63d0ac',
    store: '#ab91e8',
    storeFill: '#1e1b28',
  },
};

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const W = 880;
const H = 494;

/** A rounded panel with a title and a smaller line under it. */
function panel({ x, y, w, h, title, sub, c, accent, fill, mono }) {
  const cx = x + w / 2;
  const bar = accent
    ? `<path d="M${x + 1} ${y + 9} v${h - 18}" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>`
    : '';

  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9"
          fill="${fill ?? c.box}" stroke="${accent ?? c.edge}" stroke-width="1"/>
    ${bar}
    <text x="${cx}" y="${y + (sub ? 26 : h / 2 + 5)}" text-anchor="middle"
          font-family="${mono ? MONO : SANS}" font-size="${mono ? 14 : 14.5}"
          font-weight="600" fill="${c.ink}">${title}</text>
    ${
      sub
        ? `<text x="${cx}" y="${y + 46}" text-anchor="middle" font-family="${SANS}"
                 font-size="11.5" fill="${c.faint}">${sub}</text>`
        : ''
    }
  </g>`;
}

/** A straight run with an arrowhead, drawn downwards. */
function down(x, from, to, c) {
  return `<path d="M${x} ${from} V${to}" stroke="${c.line}" stroke-width="1.4"
                 fill="none" marker-end="url(#tip)"/>`;
}

/** An elbow: down, across, then down into the next thing. */
function elbow(x1, y1, x2, y2, c) {
  const mid = y1 + (y2 - y1) / 2;
  return `<path d="M${x1} ${y1} V${mid} H${x2} V${y2}" stroke="${c.line}" stroke-width="1.4"
                 fill="none" marker-end="url(#tip)" stroke-linejoin="round"/>`;
}

function draw(c) {
  /*
   * The stack is not centred on the canvas: the note on the right is part of
   * the drawing, so centring the boxes alone left the whole thing sitting to
   * one side. This is the centre that makes the composition balance.
   */
  const mid = 390;
  const boxW = 400;
  const boxX = mid - boxW / 2;

  // Two lanes, because the difference between them is the point: one is read
  // out of the session verbatim, the other is a model's reading of it.
  const laneY = 214;
  const laneH = 78;
  const laneW = 318;
  const laneGap = 20;
  const leftX = mid - laneW - laneGap / 2;
  const rightX = mid + laneGap / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
     role="img" aria-label="How Trackway works, as a pipeline">
  <defs>
    <marker id="tip" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6"
            orient="auto-start-reverse">
      <path d="M0 1 L9 5 L0 9 z" fill="${c.line}"/>
    </marker>
  </defs>

  ${panel({ x: boxX, y: 22, w: boxW, h: 62, title: 'Agent session files', sub: 'written to disk by the agent as you work', c })}

  <g>
    <path d="M${boxX + boxW + 14} 53 H${boxX + boxW + 60}" stroke="${c.line}" stroke-width="1"
          stroke-dasharray="3 3" fill="none"/>
    <text x="${boxX + boxW + 70}" y="49" font-family="${SANS}" font-size="11.5" font-weight="600"
          fill="${c.faint}">Nothing is hooked.</text>
    <text x="${boxX + boxW + 70}" y="64" font-family="${SANS}" font-size="11.5"
          fill="${c.faint}">You keep working normally.</text>
  </g>

  ${down(mid, 86, 110, c)}
  ${panel({ x: boxX, y: 112, w: boxW, h: 62, title: 'Parse, strip reasoning, redact', sub: 'model thinking removed, credentials scrubbed', c })}

  ${elbow(mid, 176, leftX + laneW / 2, laneY - 4, c)}
  ${elbow(mid, 176, rightX + laneW / 2, laneY - 4, c)}

  ${panel({ x: leftX, y: laneY, w: laneW, h: laneH, title: 'Harvest recorded forks', sub: 'verbatim from the session, no model call', c, accent: c.sure })}
  ${panel({ x: rightX, y: laneY, w: laneW, h: laneH, title: 'Distil the rest', sub: 'your own agent, headless', c })}

  <text x="${leftX + laneW / 2}" y="${laneY + laneH + 20}" text-anchor="middle"
        font-family="${SANS}" font-size="10.5" font-weight="600" fill="${c.sure}"
        letter-spacing="0.4">DETERMINISTIC</text>
  <text x="${rightX + laneW / 2}" y="${laneY + laneH + 20}" text-anchor="middle"
        font-family="${SANS}" font-size="10.5" font-weight="600" fill="${c.faint}"
        letter-spacing="0.4">MODEL-EXTRACTED</text>

  ${elbow(leftX + laneW / 2, laneY + laneH + 30, mid, 346, c)}
  ${elbow(rightX + laneW / 2, laneY + laneH + 30, mid, 346, c)}

  ${panel({ x: boxX, y: 348, w: boxW, h: 66, title: '.trackway/records/*.md', sub: 'git-tracked — they show up in your diffs', c, accent: c.store, fill: c.storeFill, mono: true })}

  ${down(mid, 416, 440, c)}
  ${panel({ x: boxX, y: 442, w: boxW, h: 44, title: 'search  ·  explorer  ·  MCP retrieval', c })}
</svg>
`;
}

for (const [name, palette] of Object.entries(THEMES)) {
  const file = join(OUT, `pipeline-${name}.svg`);
  writeFileSync(file, draw(palette).trimStart(), 'utf8');
  console.log(`wrote ${file}`);
}
