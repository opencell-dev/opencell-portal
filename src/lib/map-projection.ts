// The coverage map's projection (plan P3, decision 17): equirectangular with
// longitude scaled for 40°N, in tenths of a degree. No imports: the request form's
// preview uses it in the browser. scripts/make-basemap.mjs projects the same way.

export const LON_SCALE = Math.cos((40 * Math.PI) / 180);

/** [x, y] in the basemap's units. */
export function project(lat: number, lon: number): [number, number] {
  return [(lon + 170) * LON_SCALE * 10, (72 - lat) * 10];
}

/** The whole map (lat 14–84, lon -180 – -50: the Arctic islands too), the viewBox of /coverage/basemap.svg. */
export const MAP_VIEWBOX: [number, number, number, number] = (() => {
  const [x0, y0] = project(84, -180);
  const [x1, y1] = project(14, -50);
  return [x0, y0, x1 - x0, y1 - y0];
})();

const PAD_DEG = 2;
const MIN_SPAN_DEG = 6;
/** No nodes yet: the contiguous US and southern Canada. */
const HOME = { south: 24, north: 52, west: -126, east: -64 };

/** A viewBox around these points: 2° of margin, at least 6° each way. */
export function fitView(points: { lat: number; lon: number }[]): [number, number, number, number] {
  let box = HOME;
  if (points.length > 0) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    box = { south: Math.min(...lats) - PAD_DEG, north: Math.max(...lats) + PAD_DEG, west: Math.min(...lons) - PAD_DEG, east: Math.max(...lons) + PAD_DEG };
    if (box.north - box.south < MIN_SPAN_DEG) {
      const mid = (box.north + box.south) / 2;
      box = { ...box, south: mid - MIN_SPAN_DEG / 2, north: mid + MIN_SPAN_DEG / 2 };
    }
    if (box.east - box.west < MIN_SPAN_DEG) {
      const mid = (box.east + box.west) / 2;
      box = { ...box, west: mid - MIN_SPAN_DEG / 2, east: mid + MIN_SPAN_DEG / 2 };
    }
  }
  const [x0, y0] = project(box.north, box.west);
  const [x1, y1] = project(box.south, box.east);
  return [x0, y0, x1 - x0, y1 - y0];
}
