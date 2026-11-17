// Picking: which body is under the cursor. Pure (no DOM, no GPU); both functions are safe in the frame path.

/**
 * Unit view ray through the point (mx, my) of a w x h viewport (CSS pixels from the top-left), in world axes.
 * Matches rayDir() in src/common.wgsl.
 */
export function cursorRay(cam, mx, my, w, h, out) {
  const x = (2 * mx / w - 1) * cam.tanX, y = (1 - 2 * my / h) * cam.tanY;
  const dx = cam.fwd[0] + cam.right[0] * x + cam.up[0] * y;
  const dy = cam.fwd[1] + cam.right[1] * x + cam.up[1] * y;
  const dz = cam.fwd[2] + cam.right[2] * x + cam.up[2] * y;
  const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = dx * inv; out[1] = dy * inv; out[2] = dz * inv;
  return out;
}

/**
 * Body under the unit view ray rd, or -1.
 *   - A disc the ray actually enters wins, the nearest first (so a moon in front of its planet is the moon).
 *   - Otherwise the body whose edge passes within tolPx pixels of the ray wins, the closest miss first, so a
 *     body too small to see can still be chosen by clicking its marker.
 * @param {{rel: Float64Array, dist: Float64Array}} scene  camera-relative centres (km) and distances
 * @param {{n: number, radius: Float64Array}} S
 * @param {number} radPerPixel  angle subtended by one pixel at the centre of the view
 */
export function pickBody(scene, S, rd, radPerPixel, tolPx) {
  const rel = scene.rel, dist = scene.dist;
  let hit = -1, hitDist = Infinity, near = -1, nearPx = tolPx;
  for (let i = 0; i < S.n; i++) {
    const p = i * 3, d = dist[i];
    const along = rel[p] * rd[0] + rel[p + 1] * rd[1] + rel[p + 2] * rd[2];
    if (along <= 0) continue;                                   // behind the camera
    const miss = Math.sqrt(Math.max(d * d - along * along, 0)); // closest approach of the ray to the centre
    if (miss <= S.radius[i]) { if (d < hitDist) { hitDist = d; hit = i; } continue; }
    const px = (miss - S.radius[i]) / (along * radPerPixel);
    if (px < nearPx) { nearPx = px; near = i; }
  }
  return hit >= 0 ? hit : near;
}
