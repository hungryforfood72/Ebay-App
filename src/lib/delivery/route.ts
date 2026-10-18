// Stop order for a delivery run. Free and keyless: straight-line distance
// (haversine) instead of drive times, which orders stops well inside the
// handful of neighboring ZIPs Epic Steals delivers to. Google Maps does the
// turn-by-turn between stops.
//
// Nearest-neighbor from the start gives a first route, then 2-opt keeps
// reversing any stretch of it that makes the trip shorter until nothing
// does. With a few dozen stops at most this is instant and lands within a
// few percent of the best possible order.

export type Point = { lat: number; lng: number };

const EARTH_MILES = 3958.8;

export function miles(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(h));
}

// Total trip length for stops in this order, from start (and back to it
// when returnToStart).
export function tripMiles(start: Point, stops: Point[], returnToStart: boolean): number {
  let total = 0;
  let at = start;
  for (const s of stops) {
    total += miles(at, s);
    at = s;
  }
  if (returnToStart && stops.length > 0) total += miles(at, start);
  return total;
}

// Indexes into `stops`, in the order to drive them.
export function planRoute(start: Point, stops: Point[], returnToStart: boolean): number[] {
  const left = stops.map((_, i) => i);
  const order: number[] = [];
  let at = start;
  while (left.length > 0) {
    let best = 0;
    for (let k = 1; k < left.length; k++) {
      if (miles(at, stops[left[k]]) < miles(at, stops[left[best]])) best = k;
    }
    const [next] = left.splice(best, 1);
    order.push(next);
    at = stops[next];
  }

  const length = (o: number[]) => tripMiles(start, o.map((i) => stops[i]), returnToStart);
  let bestLength = length(order);
  for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const candidateLength = length(candidate);
        if (candidateLength < bestLength - 1e-9) {
          order.splice(0, order.length, ...candidate);
          bestLength = candidateLength;
          improved = true;
        }
      }
    }
  }
  return order;
}

// Stop letters: A-Z, then AA, AB, ...
export function stopLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
